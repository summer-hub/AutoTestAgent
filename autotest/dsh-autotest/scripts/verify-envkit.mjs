// R1：envkit（环境纵轴）自检 —— 契约校验 / 失败分类 / 退出码归一 / 脚本注册表 / 环境准备编排。
//
// 为什么值得单独一套：这一层的失败模式全是**静默的**——
//   · 契约漏声明 timeout 失败分类 → 超时被归成 unknown，人不知道该修什么；
//   · 退出码没归一 → 工具缺失被当成编译失败，人白查半天；
//   · 指纹算法不稳定 → 缓存永不命中（或错误命中），"二次执行 < 20%"的指标失效；
//   · 产物不校验 → "命令成功但没产物"这种最骗人的失败被当成成功。
// 四类问题都不报错，只会让平台慢慢变得不可信，只能靠用例守着。
//
// 用法：npm run build && npm run verify:envkit
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自检在临时数据目录里跑，绝不碰使用者真实数据（与 verify-library-catalog 同一套约定）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-envkit-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb } = await import('../lib/db/connection.js');
const K = await import('../lib/services/envkit/index.js');

// ---------- 1. 契约校验 ----------
console.log('— 契约校验（写坏必须在加载时就被抓住）—');
{
  const good = {
    id: 'demo_script', summary: '示例脚本', entry: 'demo', version: '1.0.0',
    inputs: [{ name: 'projectDir', type: 'path', required: true }],
    outputs: [{ name: 'outPath', type: 'path' }],
    applies_when: { os: ['windows'], library_kind: ['animation'] },
    failure_taxonomy: ['compile_error', 'timeout'], idempotent: true, timeout_sec: 60, approval: 'operator',
  };
  check(K.validateContract(good).length === 0, '合法契约无问题');

  const badId = K.validateContract({ ...good, id: 'Demo-Script' });
  check(badId.some((p) => p.path === 'id'), 'id 非法被指出', badId[0]?.reason);

  const noTax = K.validateContract({ ...good, failure_taxonomy: [] });
  check(noTax.some((p) => p.path === 'failure_taxonomy'), '失败分类为空被指出');

  const timeoutNoKind = K.validateContract({ ...good, failure_taxonomy: ['compile_error'] });
  check(timeoutNoKind.some((p) => p.path === 'failure_taxonomy'), '设了 timeout_sec 却没把 timeout 纳入分类 → 被指出（否则超时会归成 unknown）');

  const badKind = K.validateContract({ ...good, failure_taxonomy: ['compile_error', 'not_a_kind'] });
  check(badKind.some((p) => p.reason.includes('not_a_kind')), '未知失败分类被指出');

  const dupIn = K.validateContract({ ...good, inputs: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] });
  check(dupIn.some((p) => p.reason.includes('重复')), '重复参数名被指出');

  const enumNoValues = K.validateContract({ ...good, inputs: [{ name: 'm', type: 'enum' }] });
  check(enumNoValues.some((p) => p.reason.includes('values')), 'enum 参数缺 values 被指出');

  const badDefault = K.validateContract({ ...good, inputs: [{ name: 'n', type: 'number', default: 'abc' }] });
  check(badDefault.some((p) => p.reason.includes('默认值')), '默认值类型不符被指出');

  const escape = K.validateContract({ ...good, entry: '../../etc/passwd' });
  check(escape.some((p) => p.path === 'entry'), 'entry 含 .. 被拒（防目录穿越）');

  const huge = K.validateContract({ ...good, timeout_sec: 99999 });
  check(huge.some((p) => p.path === 'timeout_sec'), '超 2 小时的 timeout 被指出（该拆步骤）');
}

// ---------- 2. 参数解析 ----------
console.log('\n— 参数解析（默认值 / 必填 / 未知参数 / 枚举 / 类型）—');
{
  const c = {
    id: 'p', summary: 's', entry: 'e', version: '1.0.0',
    inputs: [
      { name: 'projectDir', type: 'path', required: true },
      { name: 'mode', type: 'enum', values: ['debug', 'release'], default: 'debug' },
      { name: 'count', type: 'number', default: 3 },
      { name: 'verbose', type: 'boolean', default: false },
    ],
    outputs: [], applies_when: {}, failure_taxonomy: ['unknown'], idempotent: true, timeout_sec: 60, approval: 'none',
  };
  const ok = K.resolveParams(c, { projectDir: '/x' });
  check(ok.ok && ok.params.mode === 'debug' && ok.params.count === 3 && ok.params.verbose === false,
    '默认值正确填充', JSON.stringify(ok.params));

  const missing = K.resolveParams(c, {});
  check(!missing.ok && missing.problems.some((p) => p.includes('projectDir')), '缺必填参数被指出');

  const unknown = K.resolveParams(c, { projectDir: '/x', bogus: 1 });
  check(!unknown.ok && unknown.problems.some((p) => p.includes('bogus')), '未知参数被拒（不静默丢弃）');

  const badEnum = K.resolveParams(c, { projectDir: '/x', mode: 'fast' });
  check(!badEnum.ok && badEnum.problems.some((p) => p.includes('不在允许范围')), '枚举越界被指出');

  const coerced = K.resolveParams(c, { projectDir: '/x', count: '7' });
  check(coerced.ok && coerced.params.count === 7, '字符串数字被转型', JSON.stringify(coerced.params.count));

  const boolish = K.resolveParams(c, { projectDir: '/x', verbose: 'true' });
  check(boolish.ok && boolish.params.verbose === true, '"true" 字符串转布尔');
}

// ---------- 3. argv 组装 ----------
console.log('\n— argv 组装（kebab-case + boolean 开关 + 不传空值）—');
{
  const c = {
    id: 'a', summary: 's', entry: 'e', version: '1.0.0',
    inputs: [
      { name: 'projectDir', type: 'path', required: true },
      { name: 'buildMode', type: 'string' },
      { name: 'replace', type: 'boolean' },
      { name: 'maybe', type: 'string' },
    ],
    outputs: [], applies_when: {}, failure_taxonomy: ['unknown'], idempotent: true, timeout_sec: 60, approval: 'none',
  };
  const argv = K.buildArgv(c, { projectDir: '/p', buildMode: 'debug', replace: true, maybe: '' });
  check(JSON.stringify(argv) === JSON.stringify(['--project-dir', '/p', '--build-mode', 'debug', '--replace']),
    '驼峰转 kebab、boolean 出开关、空值不传', JSON.stringify(argv));
}

// ---------- 4. 失败分类与退出码归一 ----------
console.log('\n— 失败分类（优先级：取消 > 超时 > 退出码 > 信号）—');
{
  const T = ['compile_error', 'timeout', 'toolchain_missing', 'unknown'];
  const cancelled = K.classifyFailure({ exitCode: 1, output: 'compile error', cancelled: true, taxonomy: T });
  check(cancelled.kind === 'cancelled', '取消优先于一切（不让人去查不存在的编译问题）');

  const timedOut = K.classifyFailure({ exitCode: 1, output: 'command not found', timedOut: true, taxonomy: T });
  check(timedOut.kind === 'timeout', '超时优先于信号文本');

  const envMissing = K.classifyFailure({ exitCode: 2, output: '', taxonomy: T });
  check(envMissing.kind === 'toolchain_missing', '退出码 2 → 工具链缺失（不等 stderr 说话）');

  const notFound = K.classifyFailure({ exitCode: 1, output: "sh: 1: hvigorw: command not found", taxonomy: T });
  check(notFound.kind === 'toolchain_missing', 'command not found → 工具链缺失（优先于编译错误规则）');

  const winNotFound = K.classifyFailure({ exitCode: 1, output: "'ohpm' 不是内部或外部命令", taxonomy: T });
  check(winNotFound.kind === 'toolchain_missing', 'Windows 中文"不是内部或外部命令"也能识别');

  const net = K.classifyFailure({ exitCode: 1, output: 'npm ERR! ETIMEDOUT connect', taxonomy: T });
  check(net.kind === 'network', '网络错误归类');

  const perm = K.classifyFailure({ exitCode: 1, output: 'EACCES: permission denied', taxonomy: T });
  check(perm.kind === 'permission', '权限错误归类');

  const dev = K.classifyFailure({ exitCode: 1, output: 'device offline', taxonomy: T });
  check(dev.kind === 'device_offline', '设备离线归类');

  const sub = K.classifyFailure({ exitCode: 1, output: 'fatal: no submodule mapping found', taxonomy: T });
  check(sub.kind === 'missing_dep', '子模块缺失归类');

  const art = K.classifyFailure({ exitCode: 1, output: 'no hap file found', taxonomy: T });
  check(art.kind === 'artifact_not_found', '产物缺失归类（最骗人的一类）');

  const unknown = K.classifyFailure({ exitCode: 1, output: 'something weird happened', taxonomy: T });
  check(unknown.kind === 'unknown', '归不进去 → unknown（提示该扩码表）');

  const outOfTax = K.classifyFailure({ exitCode: 1, output: 'EACCES denied', taxonomy: ['compile_error'] });
  check(outOfTax.kind === 'permission' && outOfTax.inTaxonomy === false,
    '归类结果不在契约声明内 → inTaxonomy=false（说明契约该扩）');

  const norm = [K.normalizeExitCode(0, false, false), K.normalizeExitCode(1, false, false),
    K.normalizeExitCode(null, false, false), K.normalizeExitCode(5, true, false), K.normalizeExitCode(5, false, true)];
  check(JSON.stringify(norm) === JSON.stringify([0, 1, 2, 3, 4]),
    '退出码归一：null→2(没起来) / 超时→3 / 取消→4', JSON.stringify(norm));
}

// ---------- 5. 契约指纹 ----------
console.log('\n— 契约指纹（稳定性与漂移检测）—');
{
  const c = {
    id: 'f', summary: 's', entry: 'e', version: '1.0.0',
    inputs: [{ name: 'b', type: 'string' }, { name: 'a', type: 'string' }],
    outputs: [], applies_when: {}, failure_taxonomy: ['unknown'], idempotent: true, timeout_sec: 60, approval: 'none',
  };
  const f1 = K.contractFingerprint(c);
  // 键序不同但内容相同 → 指纹必须相同（否则 JSON.stringify 键序差异会造成假漂移）
  const reordered = { ...c, inputs: [...c.inputs].reverse() };
  check(K.contractFingerprint(reordered) === f1, '键序不影响指纹');
  const changed = K.contractFingerprint({ ...c, timeout_sec: 120 });
  check(changed !== f1, '内容变化 → 指纹变化');
  check(/^[0-9a-f]{32}$/.test(f1), '指纹是 32 位十六进制');
}

// ---------- 6. 内置脚本资产 ----------
console.log('— 内置脚本资产（R1 首批 5 个，全部契约合法）—');
{
  check(K.BUILTIN_SCRIPT_IDS.length === 5, '内置 5 个脚本', K.BUILTIN_SCRIPT_IDS.join(','));
  for (const s of K.BUILTIN_SCRIPTS) {
    const p = K.validateContract(s);
    check(p.length === 0, `契约合法：${s.id}`, p.map((x) => x.reason).join('；'));
    check(s.timeout_sec > 0 && s.failure_taxonomy.length > 0, `七项齐全：${s.id}`);
  }
  // 每个契约都要能真的在磁盘上找到入口（.ps1 或 .sh 至少一个）
  for (const s of K.BUILTIN_SCRIPTS) {
    const entry = K.resolveEntry(s);
    check(entry.exists, `入口文件存在：${s.id}`, entry.file);
  }
  // 产物声明：构建类脚本必须声明产物路径，否则 runner 无法判断"到底该有什么"
  for (const id of ['build_har', 'build_hap']) {
    const s = K.builtinScript(id);
    check(!!s?.outputs.some((o) => o.name.endsWith('Path')), `${id} 声明了产物路径输出`);
  }
}

await ensureReady();

// ---------- 7. 脚本注册表（内置 + DB 覆盖）----------
console.log('\n— 脚本注册表（播种幂等 / DB 覆盖优先）—');
{
  // 注意：ensureReady() 的启动 bootstrap 已经播种过，所以这里必然是 inserted=0。
  // 要验证的性质是「启动即播种」+「重复播种幂等」，而不是"我第一次调就插入 5 条"。
  const seeded = await getDb().prepare('SELECT COUNT(*) AS n FROM script_library').get();
  check(Number(seeded.n) === 5, '启动 bootstrap 已播种 5 条内置脚本', `rows=${seeded.n}`);
  const r2 = await K.seedBuiltinScripts();
  check(r2.inserted === 0, '重复播种不新增（幂等）', `inserted=${r2.inserted}`);
  const all = await K.listScripts();
  check(all.length === 5, '注册表 5 条', `total=${all.length}`);
  check(all.every((s) => s.enabled), '默认全部启用');

  const report = await K.validateAllScripts();
  check(report.valid === report.total, '全部契约合法', JSON.stringify(report.problems));

  const drift = await K.detectContractDrift();
  check(drift.length === 0, '无契约漂移', JSON.stringify(drift));
}

// ---------- 8. 环境准备编排（真实 spawn 一个会失败的步骤）----------
console.log('\n— 环境准备编排（建 run → 逐 step → 失败归类 → 缓存复用）—');
{
  const t = now();
  const lib = await getDb().prepare(
    `INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
     VALUES ('envkit-probe', 'https://example.invalid/envkit-probe', '自检用', 'v0.0.0', 'active', ?, ?)`,
  ).run(t, t);
  const libraryId = Number(lib.lastInsertRowid);

  const prof = await getDb().prepare(`INSERT INTO env_profiles
    (library_id, name, status, preset_kind, toolchain_json, components_json, source, confidence, knowledge_refs, created_at, updated_at)
    VALUES (?, 'probe', 'draft', 'unknown', '{}', '{}', 'manual', 50, '[]', ?, ?)`)
    .run(libraryId, t, t);
  const profileId = Number(prof.lastInsertRowid);

  // 两步：build_manifest 指向不存在的目录 → 退出码 2 → toolchain_missing
  await getDb().prepare(`INSERT INTO env_profile_steps (profile_id, seq, script_id, params_json, required, skip_if, created_at)
    VALUES (?, 1, 'build_manifest', ?, 1, '', ?)`)
    .run(profileId, JSON.stringify({ projectDir: path.join(tmpDir, 'no-such-dir') }), t);

  const steps = await K.loadProfileSteps(profileId);
  check(steps.length === 1 && steps[0].scriptId === 'build_manifest' && steps[0].params.projectDir,
    '步骤序列可读回', JSON.stringify(steps[0]?.params));

  const r = await K.runEnvProfile({ profileId, trigger: 'selfcheck', allowCache: false });
  check(r.status === 'failed', '环境准备判定失败（工程目录不存在）', `status=${r.status}`);
  const s1 = r.steps[0];
  check(s1?.failureKind === 'toolchain_missing' || s1?.failureKind === 'missing_dep',
    '失败被归类（不是 unknown）', `kind=${s1?.failureKind}`);
  check(s1?.status === 'failed', '步骤记为失败');

  const rows = await getDb().prepare('SELECT * FROM env_run_steps WHERE run_id = ?').all(r.runId);
  check(rows.length === 1 && rows[0].status === 'failed', '步骤明细已落库');

  // 缓存复用：同样的指纹再跑一次 → cached
  const r2 = await K.runEnvProfile({ profileId, trigger: 'selfcheck', allowCache: true });
  check(r2.status === 'cached', '指纹相同 → 缓存复用（不重跑）', `status=${r2.status}`);
  check(r2.cachedFrom === r.runId, 'cached_from 指向首次成功/失败的 run', `cachedFrom=${r2.cachedFrom}`);

  // 参数不合法 → 不进 spawn 直接失败
  await getDb().prepare(`INSERT INTO env_profile_steps (profile_id, seq, script_id, params_json, required, skip_if, created_at)
    VALUES (?, 2, 'build_manifest', ?, 0, '', ?)`)
    .run(profileId, JSON.stringify({}), t);
  const r3 = await K.runEnvProfile({ profileId, trigger: 'selfcheck', allowCache: false });
  check(r3.steps.some((s) => s.seq === 2 && s.failureWhat.includes('参数不合法')),
    '缺必填参数的步骤在 spawn 前就被拦下', JSON.stringify(r3.steps[1]?.failureWhat));

  // 指纹确定性：同输入两次算出同一指纹
  const p = { id: profileId, libraryId, name: 'probe', status: 'draft', presetKind: 'unknown', toolchain: {}, components: {}, source: 'manual', confidence: 50 };
  const st = await K.loadProfileSteps(profileId);
  check(K.fingerprintOf(p, st, 'abc') === K.fingerprintOf(p, st, 'abc'), '指纹确定（同输入同结果）');
  check(K.fingerprintOf(p, st, 'abc') !== K.fingerprintOf(p, st, 'def'), 'commit 变 → 指纹变（代码更新应重跑）');
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
