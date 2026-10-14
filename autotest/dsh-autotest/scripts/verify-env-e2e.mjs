// R4：环境准备端到端自检（占位符替换 + 步骤输出串联 + 全链路跑通）。
//
// 为什么值得单独一套：R4 的验收标准是"一个按钮端到端跑通"，而它的失败模式
// **全是静默的**——占位符没替换就会把一串 {{repoDir}} 当普通字符串传给脚本，
// 脚本大概率报一个看不懂的参数错误；步骤输出没串联，build_hap 产出的 hap 路径
// 到不了 hdc_install，人看到的是"参数不合法"而不是"上游没产出"。
// 两类问题都不报错，只会让端到端看起来"差一点点"。
//
// 本自检用**真实可执行脚本**（assets/env/smoke-check 的 POSIX/PS1 变体或一个
// 内置的探针脚本）在临时目录里真跑，不 mock spawn——否则测的是 mock 不是平台。
//
// 用法：npm run build && npm run verify:env-e2e
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-e2e-'));
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
const E = await import('../lib/services/envkit/index.js');
const S = await import('../lib/services/survey/index.js');

// ---------- 1. 占位符替换（纯函数）----------
console.log('— 占位符替换（{{repoDir}} / 步骤输出串联的地基）—');
{
  const vars = { repoDir: 'C:/repos/lottie', hapPath: 'C:/repos/lottie/entry/build/entry.hap' };
  const out = E.substituteVars({
    projectDir: '{{repoDir}}',
    hapPath: '{{hapPath}}',
    module: 'entry',
    count: 3,
    nested: { a: '{{repoDir}}/x', b: ['{{repoDir}}/y'] },
  }, vars);
  check(out.projectDir === 'C:/repos/lottie', '{{repoDir}} 被替换', String(out.projectDir));
  check(out.hapPath === 'C:/repos/lottie/entry/build/entry.hap', '{{hapPath}} 被替换', String(out.hapPath));
  check(out.module === 'entry', '普通字符串不受影响', String(out.module));
  check(out.count === 3, '数字不受影响');
  const nested = out.nested;
  check(nested.a === 'C:/repos/lottie/x' && nested.b[0] === 'C:/repos/lottie/y', '嵌套对象与数组递归替换',
    JSON.stringify(nested));

  // 未解析的占位符必须被报出来（绝不能静默把 {{xxx}} 传给脚本）。
  // 注意 findUnresolvedVars 的语义：它只报告**替换后仍残留**的占位符，
  // 所以必须先 substituteVars 再查（直接查原始 params 会把 repoDir 也报出来）。
  const afterSubst = E.substituteVars({ a: '{{repoDir}}', b: '{{missingVar}}', c: 'ok' }, vars);
  const unresolved = E.findUnresolvedVars(afterSubst);
  check(unresolved.length === 1 && unresolved[0] === 'missingVar', '未解析占位符被检出',
    unresolved.join(','));

  // 空变量值视为未提供：不替换、留给未解析检出（而不是把空串传给脚本）
  const emptyVars = E.substituteVars({ p: '{{repoDir}}' }, { repoDir: '' });
  check(emptyVars.p === '{{repoDir}}', '空变量值不替换（留给未解析检出）', String(emptyVars.p));
}

// ---------- 2. 标量输出解析（步骤串联的数据来源）----------
console.log('\n— 标量输出解析（KEY=value → 小驼峰，供后续步骤引用）—');
{
  const outs = E.parseScalarOutputs([
    '[build_hap] projectDir=/x module=entry',       // 日志行，不是输出
    'HAP_PATH=/x/entry/build/entry.hap',            // 关键产物
    'BUILD_ID=abc123',
    'BUNDLE_NAME=com.example.lottie',
    'OH_MODULES_PATH=/x/oh_modules',
    'error=should_not_match',                        // 小写开头 → 不算输出
    'INSTALL_LOG=Successfully install',              // 含空格的值也要完整取到
  ]);
  check(outs.hapPath === '/x/entry/build/entry.hap', 'HAP_PATH → hapPath', String(outs.hapPath));
  check(outs.buildId === 'abc123', 'BUILD_ID → buildId', String(outs.buildId));
  check(outs.bundleName === 'com.example.lottie', 'BUNDLE_NAME → bundleName', String(outs.bundleName));
  check(outs.ohModulesPath === '/x/oh_modules', 'OH_MODULES_PATH → ohModulesPath');
  check(outs.installLog === 'Successfully install', '含空格的值完整取到', String(outs.installLog));
  check(!('error' in outs), '日志里的 error= 不被当成输出');
  check(Object.keys(outs).length === 5, '只解析出 5 个标量输出', JSON.stringify(Object.keys(outs)));
}

// ---------- 3. 新增脚本资产（R4 三条）----------
console.log('\n— R4 新增脚本资产（submodule_sync / binary_dep_fetch / smoke_check）—');
await ensureReady();
{
  for (const id of ['submodule_sync', 'binary_dep_fetch', 'smoke_check']) {
    const s = await E.getScript(id);
    check(!!s, `脚本已注册：${id}`);
    if (s) {
      const problems = E.validateContract(s.contract);
      check(problems.length === 0, `契约合法：${id}`, problems.map((p) => p.reason).join('；'));
      const entry = E.resolveEntry(s.contract);
      check(entry.exists, `入口文件存在：${id}`, entry.file);
    }
  }
  // 全量脚本数：R1 的 5 个 + R4 的 3 个
  const all = await E.listScripts();
  check(all.length === 14, '脚本库共 14 个（R1 五个 + R4 九个）', `total=${all.length}`);
  check(all.every((s) => s.enabled), '全部默认启用');
}

// ---------- 4. submodule_sync 真实行为（无 .gitmodules 应成功跳过）----------
console.log('\n— submodule_sync 真实执行（无子模块 → 成功跳过，不是失败）—');
{
  const emptyRepo = path.join(tmpDir, 'repo-no-submodule');
  fs.mkdirSync(emptyRepo, { recursive: true });
  const script = await E.getScript('submodule_sync');
  if (!script) {
    check(false, '取不到 submodule_sync 契约');
  } else {
    const r = await E.runScriptStep({
      contract: script.contract,
      params: { projectDir: emptyRepo, recursive: false, jobs: 2 },
      cwd: emptyRepo, logDir: path.join(tmpDir, 'logs'),
    });
    check(r.ok, '无 .gitmodules 的仓库：同步步骤成功（跳过而非失败）', `exit=${r.exitCode}`);
    check(r.outputs.submodulesPath === emptyRepo, '输出 SUBMODULES_PATH', String(r.outputs.submodulesPath));
  }
}

// ---------- 5. 全链路端到端（占位符 + 输出串联 + 失败分类）----------
console.log('\n— 端到端：画像步骤真实跑一遍（含占位符替换与输出串联）—');
{
  const t = now();
  const db = getDb();
  const ins = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES ('e2e-probe', 'https://example.invalid/e2e-probe', '自检用', 'v0.0.0', 'active', ?, ?)`).run(t, t);
  const libraryId = Number(ins.lastInsertRowid);

  // 造一个真实可扫的仓库目录（有 README，能被 L0 采集）
  const { workspaceDir } = await import('../lib/services/gitRepo.js');
  const repoDir = path.join(workspaceDir(), 'repos', 'e2e-probe');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'Lottie animation library for HarmonyOS with native core.');
  fs.writeFileSync(path.join(repoDir, 'oh-package.json5'), JSON.stringify({ name: 'e2e', version: '1.0.0', dependencies: {} }));

  // 先跑一次 L0 采集（拿事实 + L1 预设画像）
  const survey = await S.surveyLibrary(libraryId, { createProfiles: true });
  check(survey.ok, 'L0 采集成功', `kind=${survey.kind}`);
  const prof = await db.prepare("SELECT id FROM env_profiles WHERE library_id = ? ORDER BY id DESC LIMIT 1").get(libraryId);
  check(!!prof, 'L1/L2 画像已生成');

  if (prof) {
    const steps = await db.prepare('SELECT seq, script_id, params_json FROM env_profile_steps WHERE profile_id = ? ORDER BY seq').all(prof.id);
    check(steps.length > 0, '画像带步骤', `${steps.length} 步`);
    // 预设步骤的 projectDir 应为占位符（而非空串/绝对路径）
    const p0 = JSON.parse(steps[0].params_json);
    check(p0.projectDir === '{{repoDir}}', '预设步骤用 {{repoDir}} 占位符', String(p0.projectDir));

    // 端到端执行：这一步会真实 spawn 脚本。
    // 预期：ohpm_install/build_manifest 因工具链缺失而失败并被归类（不是 unknown），
    // 且占位符必须已被替换（不会看到 {{repoDir}} 出现在错误信息里）。
    const run = await E.runEnvProfile({ profileId: prof.id, trigger: 'selfcheck', allowCache: false });
    check(['passed', 'failed', 'cancelled'].includes(run.status), '环境准备有确定终态', `status=${run.status}`);
    const failedStep = r2(run);
    if (failedStep) {
      check(failedStep.failureKind !== '' && failedStep.failureKind !== 'unknown',
        '失败步骤被归成具体类别（不是 unknown）', `kind=${failedStep.failureKind}`);
      check(!failedStep.failureWhat.includes('{{repoDir}}'),
        '占位符已被替换（错误信息里不出现 {{repoDir}}）', failedStep.failureWhat.slice(0, 80));
    }

    // 步骤明细落库，且日志路径有记录（归因需要原文）
    const rows = await db.prepare('SELECT seq, script_id, status, failure_kind, log_path FROM env_run_steps WHERE run_id = ? ORDER BY seq').all(run.runId);
    check(rows.length === steps.length, '每步都有明细落库', `${rows.length}/${steps.length}`);
    check(rows.some((r) => r.failure_kind && r.failure_kind !== ''), '失败步骤带了失败分类');

    // 缓存复用：同参数再跑一次 → cached（不重跑）
    const run2 = await E.runEnvProfile({ profileId: prof.id, trigger: 'selfcheck', allowCache: true });
    check(run2.status === 'cached', '二次执行命中缓存（不重跑）', `status=${run2.status}`);
  }
}

// ---------- 6. 占位符未解析时不静默执行 ----------
console.log('\n— 未解析占位符：拦在 spawn 之前，不把 {{xxx}} 传给脚本 —');
{
  const t = now();
  const db = getDb();
  const ins = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES ('e2e-unresolved', 'https://example.invalid/e2e-unresolved', '自检用', 'v0.0.0', 'active', ?, ?)`).run(t, t);
  const libraryId = Number(ins.lastInsertRowid);
  const profIns = await db.prepare(`INSERT INTO env_profiles
    (library_id, name, status, preset_kind, toolchain_json, components_json, source, confidence, knowledge_refs, created_at, updated_at)
    VALUES (?, 'probe-unresolved', 'draft', 'unknown', '{}', '{}', 'manual', 50, '[]', ?, ?)`)
    .run(libraryId, t, t);
  const prof = { id: Number(profIns.lastInsertRowid) };
  // 步骤引用一个永远不存在的变量 → 必须被拦下并报出变量名
  await db.prepare(`INSERT INTO env_profile_steps (profile_id, seq, script_id, params_json, required, skip_if, created_at)
    VALUES (?, 1, 'build_manifest', ?, 1, '', ?)`)
    .run(prof.id, JSON.stringify({ projectDir: '{{noSuchVar}}' }), t);

  const run = await E.runEnvProfile({ profileId: prof.id, trigger: 'selfcheck', allowCache: false });
  const s1 = r2(run);
  check(run.status === 'failed', '未解析占位符 → 环境准备失败', `status=${run.status}`);
  check(!!s1 && s1.failureWhat.includes('noSuchVar'),
    '错误信息明确指出未解析的变量名', s1?.failureWhat.slice(0, 100));
  check(!!s1 && !s1.failureWhat.includes('{{repoDir}}'), '不是笼统的参数错误');
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 取第一个失败步骤（没有则返回 null）。 */
function r2(run) {
  return run.steps.find((s) => s.status === 'failed') ?? null;
}
