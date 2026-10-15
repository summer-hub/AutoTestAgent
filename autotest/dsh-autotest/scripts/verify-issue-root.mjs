// R5-2：问题根因定位服务自检（无 LLM、无真机；用临时工作区与假仓库）。
//
// 覆盖三块：
//   ① buildIssueContext：上下文组装（目标页命中、遍历 dump、相关符号、执行日志、
//      缺数据时如实留空而非填假数据、有界截断）；
//   ② LLM 不可用时 analyzeWithLlm 直接抛错（不降级为规则分析——罗列线索看着像结论，
//      却和真正的根因混在同一张工单列表里，人分不出哪条是猜的）；
//   ③ analyzeWithLlm 的规格收紧：证据为空时置信度不得高、非法字段被归一、
//      长度截断（用桩 LLM，不花真 token）。
//
// 为什么值得单独一套：这一层的失败模式是**静默且危险**的——
//   · 编造 file:line 会让人照着去改一个不存在问题的位置；
//   · "证据为空但置信度 90" 会让人以为结论很可信；
//   · 缺遍历数据时填个假 dump，等于给 AI 喂幻觉。
// 三类问题都不报错，只会让根因定位慢慢变得不可信。
//
// 用法：npm run build && npm run verify:issue-root
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-issue-root-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb } = await import('../lib/db/connection.js');
const IR = await import('../lib/services/issueRoot.js');

await ensureReady();
const db = getDb();
const t = '2026-10-15 00:00:00';

/** 建库 + 假仓库（含 README 与两个页面）。 */
async function mkLibWithRepo(name, opts = {}) {
  const ins = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, '自检用', 'v0.0.0', 'active', ?, ?)`).run(name, `https://example.invalid/${name}`, t, t);
  const libId = Number(ins.lastInsertRowid);
  const { workspaceDir } = await import('../lib/services/gitRepo.js');
  const repoDir = path.join(workspaceDir(), 'repos', name);
  fs.mkdirSync(path.join(repoDir, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\nRequires DevEco Studio 5.0.\nKnown issue: does not support API 9.`);
  fs.writeFileSync(path.join(repoDir, 'entry', 'src', 'main', 'ets', 'pages', 'Player.ets'),
    '// 播放页\n@Component\nstruct Player { onAnimationUpdate() { progress = value } }');
  fs.writeFileSync(path.join(repoDir, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), '// 首页\n');
  return { libId, repoDir };
}

/** 建用例（可带 symptom）。 */
async function mkCase(libId, caseNo, name, opts = {}) {
  const r = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected,
    status, script_status, current_version, scenario_kind, priority, oracle_json, symptom, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(libId, caseNo, name, '新需求引入', '', JSON.stringify(opts.steps ?? ['打开应用', '点击「开始播放」']),
      opts.expected ?? '进度条前进', '未执行', '未绑定', 1, 'happy', 'P1',
      JSON.stringify(opts.oracles ?? [{ type: 'control_text', control: '进度', expect: 'appear' }]),
      opts.symptom ?? '', t, t);
  return Number(r.lastInsertRowid);
}

/** 建工单。 */
async function mkTicket(caseId, libId, symptom) {
  const r = await db.prepare(`INSERT INTO issue_tickets (ticket_no, case_id, library_id, symptom, status,
    root_cause_json, evidence_json, verification_json, verdict, verdict_reason, verdict_by, verdict_at,
    knowledge_id, task_id, error, created_at, updated_at)
    VALUES (?,?,?,?,'pending','{}','[]','{}','','','',NULL,'',NULL,'',?,?)`)
    .run(IR.ticketNo(), caseId, libId, symptom, t, t);
  return Number(r.lastInsertRowid);
}

// ---------- 1. 上下文组装 ----------
console.log('— 上下文组装（目标页命中 / 缺数据留空 / 有界）—');
{
  const { libId } = await mkLibWithRepo('issue-ctx');
  const caseId = await mkCase(libId, 'C-IC-1', '播放进度', {
    symptom: '点击播放后进度条不动',
    steps: ['打开应用', '点击「开始播放」', '等待 3 秒'],
    expected: '进度条前进',
  });
  const ticketId = await mkTicket(caseId, libId, '点击播放后进度条不动');

  const ctx = await IR.buildIssueContext(ticketId);
  check(ctx.symptom === '点击播放后进度条不动', 'symptom 透传正确', ctx.symptom);
  check(ctx.steps.length === 3, '步骤解析正确', JSON.stringify(ctx.steps));
  check(ctx.oracles.length === 1, 'oracle 解析正确');
  check(ctx.caseNo === 'C-IC-1', '用例编号正确', ctx.caseNo);
  check(ctx.libraryName === 'issue-ctx', '库名正确');
  check(ctx.targetScope.includes('命中'), '按症状关键词命中目标页', ctx.targetScope);
  check(ctx.targetCode.includes('onAnimationUpdate'), '命中页源码被读入上下文', ctx.targetCode.slice(0, 80));
  check(ctx.targetCode.length <= 40000, '源码有界（不超上限）', `${ctx.targetCode.length} chars`);

  // 缺遍历数据 / 缺执行日志 → 必须留空，不能造假
  check(ctx.exploreCtx === '', '无遍历数据时 exploreCtx 留空（不造假 dump）', JSON.stringify(ctx.exploreCtx));
  check(ctx.lastExecutionLog === '', '无执行记录时日志留空');
  check(ctx.readmeExcerpt.includes('DevEco'), 'README 被读入（环境线索）');

  // 有执行日志时应带最近一次
  await db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, status, steps, trace_id, logs, started_at, finished_at)
    VALUES (NULL, ?, ?, '失败', '[]', '', 'E 30101 animation callback timeout', ?, ?)`).run(caseId, libId, t, t);
  const ctx2 = await IR.buildIssueContext(ticketId);
  check(ctx2.lastExecutionLog.includes('30101'), '有执行记录时日志进入上下文', ctx2.lastExecutionLog.slice(0, 60));
  check(ctx2.lastExecutionLog.includes('最近一次执行'), '日志标注了执行 id 与状态');
}

// ---------- 2. 遍历 dump 注入（有数据时应进入上下文）----------
console.log('\n— 真机遍历 dump 注入（有数据时用，无数据时不造假）—');
{
  const { libId } = await mkLibWithRepo('issue-explore');
  const caseId = await mkCase(libId, 'C-IE-1', '播放');
  const ticketId = await mkTicket(caseId, libId, '点击播放无反应');

  const { workspaceDir } = await import('../lib/services/gitRepo.js');
  const exploreDir = path.join(workspaceDir(), 'explore', 'issue-explore');
  fs.mkdirSync(exploreDir, { recursive: true });
  fs.writeFileSync(path.join(exploreDir, 'r1.json'), JSON.stringify({
    packageName: 'com.x', serial: 's', visitedCount: 1, durationMs: 100, ops: [], coverage: {},
    pages: [{ path: ['首页', '播放'], controls: [{ text: '开始播放' }, { text: '进度' }], screen: { w: 100, h: 100 }, swipes: 0, note: '' }],
  }));

  const ctx = await IR.buildIssueContext(ticketId);
  check(ctx.exploreCtx.length > 0, '有遍历数据时注入 dump', `${ctx.exploreCtx.length} chars`);
  check(ctx.exploreCtx.includes('开始播放'), 'dump 含真实控件文本');
  check(ctx.exploreCtx.includes('控件文本必须逐字来自这里'), 'dump 带纪律提示（防臆造控件）');
}

// ---------- 3. LLM 不可用：直接抛错，不降级 ----------
console.log('\n— LLM 不可用直接抛错（不再降级为规则分析）—');
{
  const { libId, repoDir } = await mkLibWithRepo('issue-nollm');
  const caseId = await mkCase(libId, 'C-IR-1', '播放进度', { symptom: '进度条不动' });
  const ticketId = await mkTicket(caseId, libId, '进度条不动');
  const ctx = await IR.buildIssueContext(ticketId);
  void repoDir;

  // ① 模型调用本身失败（超时 / 未配置 / fetch failed）→ 必须抛出，不能吞掉
  const failingLlm = async () => { throw new Error('模型 deepseek-chat(deepseek-chat) 连续失败：fetch failed'); };
  let err1 = null;
  await IR.analyzeWithLlm(ctx, failingLlm).catch((e) => { err1 = e; });
  check(!!err1, '★ LLM 调用失败时 analyzeWithLlm 抛错（不再降级）', err1?.message?.slice(0, 60));
  check(err1 && err1.message.includes('连续失败'), '错误透出真实原因（人知道该修什么）', err1?.message?.slice(0, 60));

  // ② 模型返回的不是合法 JSON → llmJson 回灌修复后仍失败，同样抛错（不拿废话当结论）
  const junkLlm = async () => ({
    text: '这不是 JSON，只是一段客套话',
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });
  let err2 = null;
  await IR.analyzeWithLlm(ctx, junkLlm).catch((e) => { err2 = e; });
  check(!!err2 && /JSON/.test(err2.message), '输出不合法时也抛错（不把废话当根因）', err2?.message?.slice(0, 60));

  // ③ 模块上不应再暴露规则降级入口（防回归：有人又把降级加回来）
  check(typeof IR.analyzeByRule !== 'function', '★ analyzeByRule 已移除（不存在降级入口）', typeof IR.analyzeByRule);
}

// ---------- 4. LLM 路径的规格收紧（桩 LLM）----------
console.log('\n— LLM 路径规格收紧（证据空→低置信度 / 字段归一 / 截断）—');
{
  const { libId } = await mkLibWithRepo('issue-llm');
  const caseId = await mkCase(libId, 'C-IL-1', '播放进度', { symptom: '进度条不动' });
  const ticketId = await mkTicket(caseId, libId, '进度条不动');
  const ctx = await IR.buildIssueContext(ticketId);

  // ① 正常输出
  const goodLlm = async () => ({
    text: JSON.stringify({
      rootCause: 'onAnimationUpdate 回调未在 UI 线程触发，导致 progress 状态不刷新',
      confidence: 88,
      evidence: [{ kind: 'source', ref: 'entry/src/main/ets/pages/Player.ets', line: 42, excerpt: 'progress = value', supports: '状态赋值处' }],
      fixSuggestions: ['把赋值包进 UIContext.postTask'],
      needsDemoPatch: true,
      uncertainties: [],
    }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });
  const v1 = await IR.analyzeWithLlm(ctx, goodLlm);
  check(v1.analysisBy === 'llm', '标注为 LLM 分析');
  check(v1.confidence === 88, '有证据时置信度如实保留', `confidence=${v1.confidence}`);
  check(v1.evidence.length === 1 && v1.evidence[0].line === 42, '证据与行号保留（可回查）');
  check(v1.needsDemoPatch === true, 'needsDemoPatch 透传');

  // ② 证据为空但自称高置信度 → 必须被压到 40 以下
  const overclaimLlm = async () => ({
    text: JSON.stringify({ rootCause: '肯定是兼容性问题', confidence: 95, evidence: [], fixSuggestions: ['检查代码'], needsDemoPatch: false, uncertainties: [] }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });
  const v2 = await IR.analyzeWithLlm(ctx, overclaimLlm);
  check(v2.confidence <= 40, '★ 证据为空时置信度被压到 ≤40（防"听起来很自信"）', `confidence=${v2.confidence}`);

  // ③ 非法字段被归一（kind 不在枚举内 → source；缺 ref 的证据被丢弃）
  const junkLlm = async () => ({
    text: JSON.stringify({
      rootCause: 'x', confidence: 70,
      evidence: [
        { kind: 'not_a_kind', ref: 'a.ets', line: 1, excerpt: 'e', supports: 's' },
        { kind: 'source', ref: '', excerpt: '没有 ref 的证据', supports: 's' },
      ],
      fixSuggestions: ['a'], needsDemoPatch: false, uncertainties: ['u'],
    }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });
  const v3 = await IR.analyzeWithLlm(ctx, junkLlm);
  check(v3.evidence.length === 1, '缺 ref 的证据被丢弃', `evidence=${v3.evidence.length}`);
  check(v3.evidence[0]?.kind === 'source', '非法 kind 归一为 source', v3.evidence[0]?.kind);

  // ④ 超长字段被截断（防一条结论撑爆存储与前端）
  const hugeLlm = async () => ({
    text: JSON.stringify({
      rootCause: 'R'.repeat(5000), confidence: 80,
      evidence: [{ kind: 'source', ref: 'F'.repeat(2000), line: 1, excerpt: 'E'.repeat(5000), supports: 'S'.repeat(2000) }],
      fixSuggestions: Array.from({ length: 50 }, () => 'FIX'), needsDemoPatch: false, uncertainties: [],
    }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });
  const v4 = await IR.analyzeWithLlm(ctx, hugeLlm);
  check(v4.rootCause.length <= 1200, 'rootCause 截断到 1200', `${v4.rootCause.length} chars`);
  check(v4.evidence[0].excerpt.length <= 400, '证据摘录截断到 400', `${v4.evidence[0].excerpt.length} chars`);
  check(v4.evidence.length <= 12, '证据条数上限 12', `${v4.evidence.length}`);
  check(v4.fixSuggestions.length <= 8, '修复建议上限 8', `${v4.fixSuggestions.length}`);

  // ⑤ LLM 抛错 → 向上抛（由调用方降级），不静默返回空结论
  let threw = false;
  try { await IR.analyzeWithLlm(ctx, async () => { throw new Error('模型超时'); }); }
  catch { threw = true; }
  check(threw, 'LLM 失败向上抛（调用方才能降级）');
}

// ---------- 5. 工单号与状态机 ----------
console.log('\n— 工单号唯一性 / 状态机取值 —');
{
  const nos = new Set(Array.from({ length: 50 }, () => IR.ticketNo()));
  check(nos.size === 50, '工单号 50 次生成无重复', `unique=${nos.size}`);
  check([...nos].every((n) => /^IT-\d{14}-\d{5}[a-z0-9]{6}$/.test(n)),
    '工单号格式可读（时间戳-计数器+随机后缀）', [...nos][0]);
  check(IR.TICKET_STATUS.accepted === 'accepted' && IR.TICKET_STATUS.rejected === 'rejected',
    '状态机含接受/驳回终态');
  for (const s of ['pending', 'analyzing', 'root_caused', 'verifying', 'accepted', 'rejected', 'failed']) {
    check(Object.values(IR.TICKET_STATUS).includes(s), `状态机含 ${s}`);
  }
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
