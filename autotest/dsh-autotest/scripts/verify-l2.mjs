// R3：知识库扩展 + L2 LLM 增量采集自检。
//
// 覆盖三块：
//   ① knowledge.ts R3 扩展：5 种新 kind / 2 种新 scope / 3 个新检索维度 /
//      2 个新阶段预算 / kindForStage 新映射 —— 重点是"新条目存得进也检索得到"
//      （曾因 parseEntry 硬编码白名单被静默降级成 global/human_verdict）；
//   ② automation.ts 新阻塞类别：env_blocked / resource_missing / toolchain_missing
//      必须给出"具体到动作"的问题，而不是把问题换个地方堆着；
//   ③ L2 增量采集（用桩 LLM，不花真 token）：校验闸门（scriptId 必须真实存在、
//      参数必须过契约）、画像落库、不确定项入队、状态流转、幂等。
//
// 为什么值得单独一套：L2 是唯一花 token 的环节，它的失败模式最贵——
// 校验不严会让 LLM 编出一个"看起来能跑"的画像（引用了不存在的脚本），
// 比没有画像更糟；而不确定项不入队，人就没机会纠正，平台会一直错下去。
//
// 用法：npm run build && npm run verify:l2
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-l2-'));
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
const K = await import('../lib/services/knowledge.js');
const A = await import('../lib/services/automation.js');
const L = await import('../lib/services/survey/llm.js');
const S = await import('../lib/services/survey/index.js');

// ---------- 1. 知识库类型扩展 ----------
console.log('— 知识库 R3 扩展（新 kind / 新 scope 必须存得进也检索得到）—');
{
  const entry = (over = {}) => ({
    id: over.id ?? 'kn-r3', scopeKind: over.scopeKind ?? 'library', scopeKey: over.scopeKey ?? 'demo-lib',
    kind: over.kind ?? 'env_recipe', title: over.title ?? '标题', keywords: over.keywords ?? [],
    status: over.status ?? 'ai_draft', confidence: over.confidence ?? 50,
    evidence: over.evidence ?? [{ envRunId: 1 }], body: over.body ?? '## 现象\nx\n## 处置\ny\n## 结论\nz',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', wikiPath: `${over.id ?? 'kn-r3'}.md`,
    ...over,
  });

  // 5 种新 kind 都必须能 round-trip（曾因 parseEntry 硬编码被降级）
  for (const kind of ['env_recipe', 'resource_recipe', 'dep_fix', 'cert_recipe', 'build_fix']) {
    const md = K.renderEntry(entry({ id: `kn-${kind}`, kind }));
    const back = K.parseEntry(md);
    check(back?.kind === kind, `新 kind 可 round-trip：${kind}`, `got=${back?.kind}`);
  }

  // 2 种新 scope 同理
  for (const [scopeKind, scopeKey] of [['toolchain', 'deveco-cli>=5.0'], ['resource_kind', 'animation_json']]) {
    const md = K.renderEntry(entry({ id: `kn-${scopeKind}`, scopeKind, scopeKey }));
    const back = K.parseEntry(md);
    check(back?.scopeKind === scopeKind && back?.scopeKey === scopeKey,
      `新 scope 可 round-trip：${scopeKind}`, `got=${back?.scopeKind}`);
  }

  // 新 scope 的落盘目录不能掉进 global（条目存得进、目录错、分层检索就乱）
  const dirs = [['toolchain', 'x'], ['resource_kind', 'y']].map(([k, v]) => K.entryDir({ scopeKind: k, scopeKey: v }));
  check(dirs[0].includes('toolchains') && !dirs[0].endsWith('global'), 'toolchain 条目落到 toolchains/', dirs[0]);
  check(dirs[1].includes('resources') && !dirs[1].endsWith('global'), 'resource_kind 条目落到 resources/', dirs[1]);

  // 标签齐全（前端筛选与注入格式都要用）
  for (const kind of ['env_recipe', 'resource_recipe', 'dep_fix', 'cert_recipe', 'build_fix']) {
    check(!!K.KIND_LABEL[kind], `KIND_LABEL 存在：${kind}`, K.KIND_LABEL[kind]);
  }
  for (const scope of ['toolchain', 'resource_kind']) {
    check(!!K.SCOPE_LABEL[scope], `SCOPE_LABEL 存在：${scope}`, K.SCOPE_LABEL[scope]);
  }
}

// ---------- 2. 检索新维度 ----------
console.log('\n— 检索新维度（跨库召回同类经验的关键）—');
{
  const entries = [
    // 动画类的环境经验：scope=library, scopeKey=animation（类别名而非库名）
    { id: 'e1', scopeKind: 'library', scopeKey: 'animation', kind: 'env_recipe', title: '动画库需预编译 so', keywords: ['lottie', 'so'], status: 'human_confirmed', confidence: 80, evidence: [{ x: 1 }], body: 'b', createdAt: '', updatedAt: '', wikiPath: 'e1.md' },
    // 工具链级经验
    { id: 'e2', scopeKind: 'toolchain', scopeKey: 'deveco-cli>=5.0', kind: 'build_fix', title: 'cli 5.0 起参数变更', keywords: ['cli'], status: 'human_confirmed', confidence: 80, evidence: [{ x: 1 }], body: 'b', createdAt: '', updatedAt: '', wikiPath: 'e2.md' },
    // 资源类型级经验
    { id: 'e3', scopeKind: 'resource_kind', scopeKey: 'animation_json', kind: 'resource_recipe', title: '畸形 json 测错误分支', keywords: ['json'], status: 'human_confirmed', confidence: 80, evidence: [{ x: 1 }], body: 'b', createdAt: '', updatedAt: '', wikiPath: 'e3.md' },
  ];

  // libraryKind 维度：查 animation 应命中 scopeKey=animation 的库级条目
  const byKind = K.retrieve({ libraryKind: 'animation' }, entries, 1500);
  check(byKind.selected.some((e) => e.id === 'e1'), 'libraryKind 命中库类别经验（跨库复用）',
    byKind.selected.map((e) => e.id).join(','));

  // toolchain 维度
  const byTool = K.retrieve({ toolchain: 'deveco-cli>=5.0' }, entries, 1500);
  check(byTool.selected.some((e) => e.id === 'e2'), 'toolchain 命中工具链经验', byTool.selected.map((e) => e.id).join(','));

  // resourceKind 维度
  const byRes = K.retrieve({ resourceKind: 'animation_json' }, entries, 1500);
  check(byRes.selected.some((e) => e.id === 'e3'), 'resourceKind 命中资源经验', byRes.selected.map((e) => e.id).join(','));

  // 不相关的查询不应命中（否则注入会被无关经验占满预算）
  const none = K.retrieve({ libraryKind: 'network' }, entries, 1500);
  check(none.selected.length === 0, '不相关类别不召回', none.selected.map((e) => e.id).join(','));

  // 新阶段预算存在且比遍历类高（环境方案要带命令与版本约束，截太省不可执行）
  const inj = K.injectForStage('env_prep', { libraryKind: 'animation' });
  check(typeof inj.text === 'string', 'env_prep 阶段可注入');
  const injRes = K.injectForStage('resource_build', { resourceKind: 'animation_json' });
  check(typeof injRes.text === 'string', 'resource_build 阶段可注入');

  // kindForStage 新映射：环境/资源阻塞归到对应知识类别
  check(K.kindForStage('env_blocked') === 'env_recipe', 'env_blocked → env_recipe');
  check(K.kindForStage('resource_missing') === 'resource_recipe', 'resource_missing → resource_recipe');
  check(K.kindForStage('toolchain_missing') === 'build_fix', 'toolchain_missing → build_fix');
}

// ---------- 3. 人工队列新阻塞类别 ----------
console.log('\n— 人工队列新阻塞类别（问题必须具体到动作）—');
{
  check(!!A.BLOCKER_LABEL.env_blocked, 'env_blocked 有标签', A.BLOCKER_LABEL.env_blocked);
  check(!!A.BLOCKER_LABEL.resource_missing, 'resource_missing 有标签', A.BLOCKER_LABEL.resource_missing);
  check(!!A.BLOCKER_LABEL.toolchain_missing, 'toolchain_missing 有标签', A.BLOCKER_LABEL.toolchain_missing);

  const base = {
    caseId: 1, caseNo: 'C-1', name: 'x', testability: 'A', patchApproved: true,
    hasPatchDraft: false, oracles: [{ type: 'control_text' }], steps: ['点击'], expected: 'e',
    recentResults: [], deviceOnline: true,
  };
  for (const stage of ['env_blocked', 'resource_missing', 'toolchain_missing']) {
    const q = A.buildQuestion([stage], base);
    check(q.length > 20, `${stage} 给出具体动作的问题`, q.slice(0, 60));
  }
  // 三个一起问时应三段都在
  const all = A.buildQuestion(['env_blocked', 'resource_missing', 'toolchain_missing'], base);
  check(all.includes('；') && all.length > 60, '多阻塞合并提问不互相覆盖', `${all.length} 字符`);

  // 工具链缺失应被 SIGNALS 识别（步骤里提到 hvigorw/ohpm）
  const v = A.classifyAutomation({ ...base, name: '构建', expected: '', steps: ['执行 hvigorw assembleHap'] });
  check(v.blockers.includes('toolchain_missing'), '步骤提到构建命令 → 归 toolchain_missing',
    v.blockers.join(','));
}

// ---------- 4. L2 增量采集（桩 LLM，不花真 token）----------
console.log('\n— L2 增量采集（桩 LLM：校验闸门 / 画像落库 / 入队 / 幂等）—');
await ensureReady();
{
  const db = getDb();
  const t = now();

  // 造 4 个库，覆盖 4 条路径：
  //  A 正常解决 · B 只给不确定项 · C scriptId 不存在（校验必须拦） · D 参数不合法（校验必须拦）
  const names = ['l2-ok', 'l2-uncertain', 'l2-bad-script', 'l2-bad-param'];
  const ids = {};
  for (const n of names) {
    const r = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
      VALUES (?, ?, '自检用', 'v0.0.0', 'active', ?, ?)`).run(n, `https://example.invalid/${n}`, t, t);
    ids[n] = Number(r.lastInsertRowid);
  }

  // 给每个库造 L0 事实 + needs_llm 标记（真实流程由 R2 批次产生）
  const facts = {
    'l2-ok': { kind: 'unknown', kindReason: '无信号', confidence: 0, needs: '类别未识别' },
    'l2-uncertain': { kind: 'animation', kindReason: 'lottie', confidence: 85, needs: '二进制依赖需决策' },
    'l2-bad-script': { kind: 'network', kindReason: 'http', confidence: 85, needs: '需要人确认' },
    'l2-bad-param': { kind: 'storage', kindReason: 'sqlite', confidence: 85, needs: '需要人确认' },
  };
  for (const [n, f] of Object.entries(facts)) {
    await S.saveFactsForTest(ids[n], 'c1', {
      kind: f.kind, kindReason: f.kindReason, confidence: f.confidence,
      buildTarget: 'hap', hasSubmodules: false, hasBinary: n === 'l2-uncertain',
      binaryKinds: n === 'l2-uncertain' ? ['so:arm64-v8a'] : [], hasDemo: true,
      entryFile: 'entry/src/main/ets/Index.ets', readmeChars: 100,
      facts: { ohpmDeps: [], moduleNames: ['entry'], apiLevel: '12', fileCount: 10, hasHvigorw: false, hasEtsPages: 2 },
      resourceCandidates: [], readmeIntel: [], needsLlm: [f.needs],
    });
    await db.prepare(`INSERT INTO library_survey_runs (library_id, status, last_commit, needs_llm, llm_reason, created_at, updated_at)
      VALUES (?, 'needs_llm', 'c1', 1, ?, ?, ?)`).run(ids[n], f.needs, t, t);
  }

  // 桩 LLM：按库名返回不同 verdict，覆盖四条路径
  const seenTaskIds = [];
  const stubLlm = async (input) => {
    // G1：taskId 必须透传到 meta，否则 token 记账不归属任务、
    // agent.maxTokensPerTask 预算闸门对 L2 失效（L2 是唯一花 token 的环节）
    seenTaskIds.push(input.meta?.taskId ?? null);
    const name = /## 库\s*\n\s*(\S+)/.exec(input.user)?.[1] ?? '';
    let verdict;
    if (name === 'l2-ok') {
      verdict = {
        kind: 'animation', kindReason: 'README 提到 After Effects 动画',
        toolchain: { devecoCli: '>=5.0' },
        steps: [
          { scriptId: 'ohpm_install', params: { projectDir: '{{repoDir}}' }, required: true },
          { scriptId: 'build_hap', params: { projectDir: '{{repoDir}}', module: 'entry' }, required: true },
        ],
        uncertainties: [],
      };
    } else if (name === 'l2-uncertain') {
      verdict = {
        kind: 'animation', kindReason: 'lottie',
        toolchain: {},
        steps: [{ scriptId: 'ohpm_install', params: { projectDir: '{{repoDir}}' }, required: true }],
        uncertainties: [
          { stage: 'env_blocked', question: '检测到 arm64-v8a 的 .so：用预编译产物还是按 ABI 现编？' },
          { stage: 'resource_missing', question: '缺少 lottie 测试 json，是否合成六种变体？' },
        ],
      };
    } else if (name === 'l2-bad-script') {
      // 引用了不存在的脚本 —— 校验必须拦下，不能落出"看起来能跑"的画像
      verdict = {
        kind: 'network', kindReason: 'http',
        toolchain: {},
        steps: [{ scriptId: 'not_a_real_script', params: {}, required: true }],
        uncertainties: [],
      };
    } else {
      // projectDir 填空串：应被归一化成 {{repoDir}} 后通过（而不是整份被拒）
      verdict = {
        kind: 'storage', kindReason: 'sqlite',
        toolchain: {},
        steps: [{ scriptId: 'ohpm_install', params: { projectDir: '' }, required: true }],
        uncertainties: [],
      };
    }
    return { text: JSON.stringify(verdict), provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1 };
  };

  const r = await L.runL2Increment(stubLlm, { ids: Object.values(ids), limit: 10, taskId: 4242 });
  check(r.processed === 4, '四个库都走了 L2', `processed=${r.processed}`);
  check(r.resolved === 2, '两个正常解决（含空 projectDir 被归一化的）', `resolved=${r.resolved}`);
  check(r.queued === 1, '一个转去问人', `queued=${r.queued}`);
  check(r.failed === 1, '一个被校验拦下（scriptId 不存在）', `failed=${r.failed}`);
  // G1：taskId 必须透传到每次 LLM 调用的 meta，否则 token 记账不归属任务、
  // agent.maxTokensPerTask 预算闸门对 L2 失效（L2 是唯一花 token 的环节）
  check(seenTaskIds.length === 4 && seenTaskIds.every((t) => t === 4242),
    'taskId 透传到每次 LLM 调用的 meta（预算闸门因此生效）',
    JSON.stringify(seenTaskIds));

  // A：画像落库且步骤可用
  const profA = await db.prepare("SELECT id, source, status, preset_kind FROM env_profiles WHERE library_id = ?").get(ids['l2-ok']);
  check(!!profA && profA.source === 'ai_draft' && profA.status === 'draft', 'L2 画像落库（source=ai_draft, status=draft）',
    JSON.stringify(profA));
  if (profA) {
    const steps = await db.prepare('SELECT script_id FROM env_profile_steps WHERE profile_id = ? ORDER BY seq').all(profA.id);
    check(steps.length === 2 && steps.every((s) => ['ohpm_install', 'build_hap'].includes(s.script_id)),
      '画像步骤只含真实脚本', steps.map((s) => s.script_id).join(','));
  }
  // A 的类别被补全（unknown → animation）
  const factsA = await db.prepare('SELECT kind, confidence FROM library_facts WHERE library_id = ?').get(ids['l2-ok']);
  check(factsA?.kind === 'animation', 'L2 补全了类别（unknown → animation）', String(factsA?.kind));

  // B：不确定项入队，且状态仍是 needs_llm（人没确认前不能算完成）
  const q = await db.prepare(
    "SELECT stage, question, status FROM human_queue WHERE library_id = ? AND case_id IS NULL ORDER BY id",
  ).all(ids['l2-uncertain']);
  check(q.length === 2, '两个不确定项各自入队（一类一条）', q.map((x) => x.stage).join(','));
  check(q.every((x) => x.question.length > 10), '队列问题具体到动作', q[0]?.question?.slice(0, 40));
  const runB = await db.prepare('SELECT status, needs_llm FROM library_survey_runs WHERE library_id = ?').get(ids['l2-uncertain']);
  check(runB?.status === 'needs_llm' && runB?.needs_llm === 1, '有人不确认 → 仍是 needs_llm', JSON.stringify(runB));

  // C/D：scriptId 不存在 → 不建画像（绝不能落出引用不存在脚本的"看起来能跑"的画像）；
  //      projectDir 空串 → 归一化成 {{repoDir}} 后正常建画像
  const profC = await db.prepare('SELECT id FROM env_profiles WHERE library_id = ?').get(ids['l2-bad-script']);
  const profD = await db.prepare('SELECT id FROM env_profiles WHERE library_id = ?').get(ids['l2-bad-param']);
  check(!profC, 'scriptId 不存在 → 不建画像', String(profC?.id));
  check(!!profD, 'projectDir 空串被归一化 → 正常建画像（不整份拒绝）', String(profD?.id));
  if (profD) {
    const st = await db.prepare('SELECT params_json FROM env_profile_steps WHERE profile_id = ? ORDER BY seq').all(profD.id);
    const p0 = JSON.parse(st[0].params_json);
    check(p0.projectDir === '{{repoDir}}', '归一化后的 projectDir 是占位符', String(p0.projectDir));
  }
  const runC = await db.prepare('SELECT status, llm_reason FROM library_survey_runs WHERE library_id = ?').get(ids['l2-bad-script']);
  check(runC?.status === 'needs_llm' && String(runC?.llm_reason).includes('scriptId'),
    '失败原因写回 llm_reason（人看得见该修什么）', String(runC?.llm_reason).slice(0, 60));

  // 幂等：已有 ai_draft 画像的库不再重复问
  const r2 = await L.runL2Increment(stubLlm, { ids: [ids['l2-ok']], limit: 10 });
  check(r2.processed === 1 && r2.skipped === 1, '已有 AI 画像 → 跳过（不重复花 token）',
    JSON.stringify({ p: r2.processed, s: r2.skipped }));

  // 没有 L0 事实的库：跳过而不是硬跑
  const r3 = await L.runL2Increment(stubLlm, { ids: [999999], limit: 10 });
  check(r3.details.length === 1 && r3.details[0].status === 'skipped', '库不存在 → 跳过', JSON.stringify(r3.details[0]));

  // 缺省选库：只取 needs_llm=1 的。注意此时 l2-ok 与 l2-bad-param 已被解决（needs_llm=0），
  // 只剩 l2-uncertain（有人不确认）与 l2-bad-script（校验失败）仍在队列里 —— 所以是 2 不是 4。
  const r4 = await L.runL2Increment(stubLlm, { limit: 10 });
  check(r4.processed === 2, '缺省只跑 needs_llm 的库（已解决的不再花 token）', `processed=${r4.processed}`);
  const pendingNames = r4.details.map((d) => d.libraryName).sort();
  check(JSON.stringify(pendingNames) === JSON.stringify(['l2-bad-script', 'l2-uncertain']),
    '待处理的正是该待处理的两个', pendingNames.join(','));
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
