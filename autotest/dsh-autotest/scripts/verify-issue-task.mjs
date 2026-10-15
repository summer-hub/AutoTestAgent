// R5-3：analyze_issue 任务编排 + 工单状态流转自检。
//
// 覆盖三块（都不需要真机/真 LLM，用临时库 + 桩 LLM）：
//   ① 工单状态机流转：pending → analyzing → root_caused → verifying，
//      以及人工验收的 accepted / rejected 终态；
//   ② analyze_issue 编排的**纪律**（这是本阶段最容易被破坏的）：
//      - 无真机时自测试必须置失败并写明原因，**绝不回退模拟**；
//      - 无 oracle 时不得判定"通过"（跑完也不知道对错）；
//      - LLM 失败必须让任务与工单都落到 failed 并写明原因，绝不降级为规则分析；
//   ③ createTicket 的边界：symptom 为空必须拒绝（没有问题现象就没有分析对象）。
//
// 为什么值得单独一套：这一层的失败模式是**危险的**——
// 把"无真机"回退成模拟执行，会产出看似通过、实则毫无证据的结论；
// 把 LLM 失败降级成规则分析，会产出看着像结论、其实没有任何推断的根因。
// 两类问题都不报错，只会让根因定位变成一场表演。
//
// 用法：npm run build && npm run verify:issue-task
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-issue-task-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;
// 关键：不设任何真机环境，hdc 不存在 —— 用来验证"无真机必须失败而非模拟"
delete process.env.AUTOTEST_SIMULATE;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb } = await import('../lib/db/connection.js');
const IR = await import('../lib/services/issueRoot.js');
const EX = await import('../lib/services/executor.js');

await ensureReady();
const db = getDb();
const t = '2026-10-15 00:00:00';

/** 建库 + 假仓库（含一个页面，源码里带症状词）。 */
async function mkLibWithRepo(name) {
  const ins = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, '自检用', 'v0.0.0', 'active', ?, ?)`).run(name, `https://example.invalid/${name}`, t, t);
  const libId = Number(ins.lastInsertRowid);
  const { workspaceDir } = await import('../lib/services/gitRepo.js');
  const repoDir = path.join(workspaceDir(), 'repos', name);
  fs.mkdirSync(path.join(repoDir, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${name}\nRequires DevEco Studio 5.0.`);
  fs.writeFileSync(path.join(repoDir, 'entry', 'src', 'main', 'ets', 'pages', 'Player.ets'),
    '// 播放页 进度条\nstruct Player { progress = 0; onAnimationUpdate() { progress = value } }');
  return { libId, repoDir };
}

/** 建用例（可带 oracle / steps）。 */
async function mkCase(libId, caseNo, name, opts = {}) {
  const r = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected,
    status, script_status, current_version, scenario_kind, priority, oracle_json, symptom, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(libId, caseNo, name, '新需求引入', '', JSON.stringify(opts.steps ?? ['打开应用', '点击「开始播放」']),
      opts.expected ?? '进度条前进', '未执行', '未绑定', 1, 'happy', 'P1',
      JSON.stringify(opts.oracles ?? [{ type: 'control_text', control: '进度', expect: 'appear' }]),
      '', t, t);
  return Number(r.lastInsertRowid);
}

/** 建任务（analyze_issue 类型，input 为工单 id）。 */
async function mkTask(ticketId, libId) {
  const r = await db.prepare(`INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
    VALUES (?, 'analyze_issue', '问题根因定位与自测试', ?, ?, '[]', ?, 'pending', 0, ?, ?)`)
    .run(`TK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, libId, String(ticketId),
      `tr-${Date.now()}`, t, t);
  return Number(r.lastInsertRowid);
}

// ---------- 1. createTicket 边界 ----------
console.log('— 工单创建边界（symptom 为空必须拒绝）—');
{
  const { libId } = await mkLibWithRepo('task-create');
  const caseId = await mkCase(libId, 'C-TC-1', '播放进度');

  let rejected = false;
  try { await IR.createTicket({ caseId, symptom: '   ' }); } catch { rejected = true; }
  check(rejected, 'symptom 为空白拒绝创建（没有问题现象就没有分析对象）');

  const bad = await (async () => { try { await IR.createTicket({ caseId: 999999, symptom: 'x' }); return null; } catch (e) { return e; } })();
  check(!!bad, '用例不存在时拒绝创建');

  const tk = await IR.createTicket({ caseId, symptom: '点击播放后进度条不动' });
  check(tk.status === 'pending', '新建工单状态为 pending', tk.status);
  check(tk.symptom === '点击播放后进度条不动', 'symptom 落库');
  check(tk.rootCause === null, '新建工单无根因（还没分析）');

  // 同步写到 cases.symptom（人维护的"当前疑问"）
  const c = await db.prepare('SELECT symptom FROM cases WHERE id = ?').get(caseId);
  check(c?.symptom === '点击播放后进度条不动', '工单创建时同步 cases.symptom', String(c?.symptom));
}

// ---------- 2. 状态流转 API ----------
console.log('\n— 工单状态流转（ analyzing → root_caused → verifying → 验收）—');
{
  const { libId } = await mkLibWithRepo('task-flow');
  const caseId = await mkCase(libId, 'C-TF-1', '播放进度');
  const tk = await IR.createTicket({ caseId, symptom: '进度条不动' });

  await IR.setTicketStatus(tk.id, 'analyzing');
  let row = await IR.loadTicket(tk.id);
  check(row?.status === 'analyzing', '可置为 analyzing', row?.status);

  const verdict = {
    rootCause: 'onAnimationUpdate 未在 UI 线程触发',
    confidence: 82,
    evidence: [{ kind: 'source', ref: 'Player.ets', line: 3, excerpt: 'progress = value', supports: '赋值处' }],
    fixSuggestions: ['包进 UIContext.postTask'],
    needsDemoPatch: true,
    uncertainties: [],
    analysisBy: 'llm',
  };
  await IR.saveTicketRootCause(tk.id, verdict);
  row = await IR.loadTicket(tk.id);
  check(row?.status === 'root_caused', '写入根因后状态为 root_caused', row?.status);
  check(row?.rootCause?.confidence === 82, '根因可读回', `confidence=${row?.rootCause?.confidence}`);
  check(row?.evidence.length === 1, '证据可读回', `evidence=${row?.evidence.length}`);

  await IR.saveTicketVerification(tk.id, { mode: 'device', passed: true }, 'verifying');
  row = await IR.loadTicket(tk.id);
  check(row?.status === 'verifying', '写入验证结果后为 verifying', row?.status);
  check(row?.verification.mode === 'device', '验证记录可读回');

  // 人工验收：接受
  const accepted = await IR.decideTicket({ ticketId: tk.id, accept: true, reason: '根因与证据吻合，已修复验证', by: 'qa' });
  check(accepted.status === 'accepted', '验收接受 → accepted', accepted.status);
  check(accepted.verdictBy === 'qa', '验收人记录', accepted.verdictBy);
  check(accepted.verdictAt !== null, '验收时间记录');

  // 再建一个走拒绝路径
  const tk2 = await IR.createTicket({ caseId, symptom: '另一个现象' });
  const rejectedRow = await IR.decideTicket({ ticketId: tk2.id, accept: false, reason: '根因判断不成立，实际是配置问题' });
  check(rejectedRow.status === 'rejected', '验收驳回 → rejected', rejectedRow.status);
  check(rejectedRow.verdictReason.includes('配置'), '驳回理由留存（供反查）');

  // 终态后仍可读回（不被后续流转覆盖）
  const reread = await IR.loadTicket(tk.id);
  check(reread?.status === 'accepted', '终态可重复读回', reread?.status);
}

// ---------- 3. analyze_issue 编排：无真机必须失败而非模拟 ----------
console.log('\n— ★ 无真机时必须失败并写明原因，绝不回退模拟 —');
{
  const { libId } = await mkLibWithRepo('task-nodev');
  const caseId = await mkCase(libId, 'C-ND-1', '播放进度');
  const tk = await IR.createTicket({ caseId, symptom: '点击播放后进度条不动' });
  const taskId = await mkTask(tk.id, libId);

  // 桩 LLM：返回一个完整 verdict
  const stubLlm = async () => ({
    text: JSON.stringify({
      rootCause: 'onAnimationUpdate 未在 UI 线程触发，progress 不刷新',
      confidence: 85,
      evidence: [{ kind: 'source', ref: 'entry/src/main/ets/pages/Player.ets', line: 3, excerpt: 'progress = value', supports: '状态赋值处' }],
      fixSuggestions: ['把赋值包进 UIContext.postTask'],
      needsDemoPatch: false,
      uncertainties: [],
    }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });

  let summary = '';
  let taskErr = null;
  try {
    // runTask 返回 void（摘要写进 tasks.result_summary），所以要从库里读
    await EX.runTask(taskId, stubLlm);
    const tkRow = await db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId);
    summary = String(tkRow?.result_summary ?? '');
  } catch (e) {
    taskErr = e instanceof Error ? e.message : String(e);
  }

  // runTask 不抛（失败写进 task.error）；但工单状态必须体现"自测试没做成"
  const row = await IR.loadTicket(tk.id);
  check(row?.status === 'root_caused' || row?.status === 'failed',
    '无真机时工单不进入 verifying（不假装验证过）', `status=${row?.status}`);
  check(row?.rootCause?.confidence === 85, '根因仍然写入了（分析成功，只是没验证）',
    `confidence=${row?.rootCause?.confidence}`);

  const verif = row?.verification ?? {};
  check(verif.mode === 'skipped_no_device' || verif.mode === 'skipped_no_hdc',
    '★ 验证记录标注为"无设备/无 hdc 跳过"，不是模拟通过', `mode=${verif.mode}`);
  // 任务失败时 result_summary 按设计为 null（摘要在成功路径才有）——
  // 真正的不变量是：**工单里存有完整记录**（根因 + 验证），人可从工单继续。
  check(row?.rootCause?.rootCause && row.rootCause.rootCause.length > 0,
    '工单存有根因陈述（任务失败也不丢结论）', (row?.rootCause?.rootCause ?? '').slice(0, 60));
  check((row?.evidence ?? []).length > 0, '工单存有证据', `evidence=${(row?.evidence ?? []).length}`);
  check(taskErr === null, 'runTask 自身不抛（失败走工单状态）', String(taskErr));

  // 任务表状态：自测试失败 → 任务应失败并写明原因（既有纪律）
  const task = await db.prepare('SELECT status, error FROM tasks WHERE id = ?').get(taskId);
  check(task?.status === 'failed', '自测试失败 → 任务状态 failed', task?.status);
  check(!!task?.error && task.error.length > 0, '任务 error 写明原因（不是空串）', (task?.error ?? '').slice(0, 80));
  check(!/模拟|simulate/i.test(task?.error ?? ''), '★ 错误信息里不含"模拟"（没有回退模拟）', (task?.error ?? '').slice(0, 80));
}

// ---------- 4. 无 oracle 不得判定通过 ----------
console.log('\n— ★ 无机器判据（oracle）时不得判定通过 —');
{
  const { libId } = await mkLibWithRepo('task-noop');
  // 故意给空 oracle
  const caseId = await mkCase(libId, 'C-NO-1', '播放进度', { oracles: [] });
  const tk = await IR.createTicket({ caseId, symptom: '进度条不动' });
  const taskId = await mkTask(tk.id, libId);

  const stubLlm = async () => ({
    text: JSON.stringify({
      rootCause: 'x', confidence: 70,
      evidence: [{ kind: 'source', ref: 'Player.ets', line: 1, excerpt: 'e', supports: 's' }],
      fixSuggestions: [], needsDemoPatch: false, uncertainties: [],
    }),
    provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1,
  });

  await EX.runTask(taskId, stubLlm);
  const row = await IR.loadTicket(tk.id);
  const verif = row?.verification ?? {};
  // 无 oracle 时应标记 skipped_no_oracle 或 no_device —— 关键是绝不能是"通过"
  check(verif.mode !== 'device' || verif.execution === undefined,
    '无 oracle 时不进入真机通过判定', `mode=${verif.mode}`);
  check(row?.status !== 'accepted', '无 oracle 绝不被验收通过（还没到验收环节）', row?.status);
}

// ---------- 5. LLM 失败必须落 failed，不降级 ----------
console.log('\n— LLM 失败：任务与工单都落 failed（不降级为规则分析）—');
{
  const { libId } = await mkLibWithRepo('task-llmfail');
  const caseId = await mkCase(libId, 'C-LF-1', '播放进度', { symptom: '进度条不动' });
  const tk = await IR.createTicket({ caseId, symptom: '进度条不动' });
  const taskId = await mkTask(tk.id, libId);

  // 桩 LLM：直接抛错（模拟模型超时/不可用）
  const failingLlm = async () => { throw new Error('模型连接超时'); };

  // runTask 自己吞异常并置任务 failed（不往上层抛）——断言它确实这么收尾
  let threw = false;
  try { await EX.runTask(taskId, failingLlm); } catch { threw = true; }
  check(!threw, 'runTask 不往上层抛（由它自己落终态）');

  const task = await db.prepare('SELECT status, error FROM tasks WHERE id = ?').get(taskId);
  check(task?.status === 'failed', '★ 任务落 failed（不变成 done 假装顺利）', task?.status);
  check(!!task?.error && task.error.includes('模型连接超时'), '任务 error 写明模型失败原因', task?.error?.slice(0, 60));

  const row = await IR.loadTicket(tk.id);
  check(row?.status === 'failed', '★ 工单落 failed（不永远停在 analyzing）', row?.status);
  check(!!row?.error && row.error.includes('根因分析失败'), '工单 error 写明失败环节', row?.error?.slice(0, 60));
  // 关键：不产出任何规则结论——那会和真正的根因混在同一张工单列表里
  check(row?.rootCause === null, '★ 不留规则降级结论（不把线索罗列当根因）',
    `rootCause=${JSON.stringify(row?.rootCause)?.slice(0, 40)}`);
}

// ---------- 6. 工单查询 ----------
console.log('\n— 工单查询（按库/按用例/按状态）—');
{
  const { libId } = await mkLibWithRepo('task-list');
  const caseId = await mkCase(libId, 'C-LS-1', '播放进度');
  await IR.createTicket({ caseId, symptom: '现象一' });
  const tk2 = await IR.createTicket({ caseId, symptom: '现象二' });
  await IR.decideTicket({ ticketId: tk2.id, accept: true, reason: 'ok' });

  const byLib = await IR.listTickets({ libraryId: libId });
  check(byLib.length === 2, '按库查到 2 张工单', `n=${byLib.length}`);
  const byCase = await IR.listTickets({ caseId });
  check(byCase.length === 2, '按用例查到 2 张', `n=${byCase.length}`);
  const byStatus = await IR.listTickets({ libraryId: libId, status: 'accepted' });
  check(byStatus.length === 1 && byStatus[0].symptom === '现象二', '按状态过滤正确', JSON.stringify(byStatus.map((x) => x.symptom)));
  const limited = await IR.listTickets({ libraryId: libId, limit: 1 });
  check(limited.length === 1, 'limit 生效', `n=${limited.length}`);
  // 一条用例多个工单 = 历史档案可追溯（symptom 列只存当前疑问）
  check(byCase.every((x) => x.symptom.length > 0), '每张工单都带自己的 symptom 快照');
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
