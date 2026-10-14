// R0：目录引导（随包三方库测试表 → 业务库）的自检。
//
// 为什么值得单独一套：这是"新机器装上就能看到 348 个库"的唯一路径，而它的失败模式全是
// **静默的**——表没导进来不会报错，只是库管理页空着；导入把 Agent 补的包名冲掉也不会报错，
// 只是下次真机遍历启动失败、dump 到桌面。两类失败都没有异常，只能靠用例守着。
//
// 覆盖（对应重构方案 §4.6）：
//   ① 随包资产可解析出真实规模的库；
//   ② 幂等——同一份表导入两次，第二次 added=0 且不新增导入记录；
//   ③ 只增不删——库里有、表里没有的库绝不被删；
//   ④ 绝不覆盖 Agent 字段（包名/入口 Ability/同步状态）——整个功能的关键边界；
//   ⑤ sha256 相同即跳过写库；
//   ⑥ 表解析出 0 条只告警、不抛异常阻断启动；
//   ⑦ 数据目录已有表时，不拿随包资产去覆盖它。
//
// 用法：npm run build && npm run verify:library-catalog
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 自检必须在临时数据目录里跑：绝不能碰使用者真实的库（与 verify-api-guard 同一套约定）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-catalog-'));
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
const C = await import('../lib/services/catalog.js');
const XLSX = (await import('xlsx')).default;

const MONO = 'https://gitcode.com/CPF-ApplicationTPC/openharmony_tpc_samples';
const SHEET_NAME = '三方库测试表.xlsx';

/** 造一份测试用表（与 verify-library-sheet 同一套脏数据构造）。 */
function writeSheet(file, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(wb, file);
  return file;
}

const db = () => getDb();
const libs = async () => await db().prepare('SELECT * FROM libraries ORDER BY id').all();
const imports = async () => await db().prepare('SELECT * FROM library_catalog_imports ORDER BY id').all();

// ---------- 0. 随包资产 ----------
console.log('— 随包资产（lib/assets/ 下的初始种子）—');
{
  const bundled = C.bundledSheet();
  check(!!bundled, '定位到随包三方库测试表', bundled?.path ?? '(未找到)');
  if (bundled) {
    check(fs.statSync(bundled.path).size > 1024, '随包表非空', `${fs.statSync(bundled.path).size} bytes`);
    check(/^[0-9a-f]{64}$/.test(bundled.sha256), 'sha256 可计算（幂等键）', bundled.sha256.slice(0, 12));
  }
}

await ensureReady();

// ---------- 1. 首次导入：真实规模 ----------
console.log('\n— 首次导入（启动 bootstrap）—');
{
  const rows = await libs();
  check(rows.length > 300, '随包表的库已全部进业务库', `libraries=${rows.length}`);
  const lottie = rows.find((r) => r.name === 'lottie_turbo');
  check(!!lottie, '种子库 lottie_turbo 仍在（导入不删既有库）');
  const adler = rows.find((r) => r.name === 'adler-32');
  check(!!adler && adler.repo_subpath === 'Adler32Demo',
    '/tree/<分支>/<子目录> 拆出的子目录正确落地', JSON.stringify({ url: adler?.repo_url, sub: adler?.repo_subpath }));

  const imp = await imports();
  check(imp.length === 1, '写入一条导入留痕', `records=${imp.length}`);
  check(imp[0]?.source === 'bundled', '来源标记为 bundled', imp[0]?.source);
  check(imp[0]?.added > 300, '留痕记录新增行数', `added=${imp[0]?.added}`);
  check(imp[0]?.applied === 1, '留痕标记已应用');
}

// ---------- 2. 幂等 ----------
console.log('\n— 幂等（同一份表第二次导入）—');
{
  const before = (await libs()).length;
  const impBefore = (await imports()).length;
  const r = await C.ensureLibraryCatalog();
  check(r.status === 'unchanged', '第二次导入判定为无变化', `status=${r.status}`);
  check(r.added === 0 && r.updated === 0, '无新增无更新', `added=${r.added} updated=${r.updated}`);
  check((await libs()).length === before, '库数量不变（未重复写入）', `${before} → ${(await libs()).length}`);
  check((await imports()).length === impBefore, '不新增导入留痕（不刷历史）', `${impBefore} → ${(await imports()).length}`);
}

// ---------- 3. 只增不删 ----------
console.log('\n— 只增不删（库里有、表里没有的库）—');
{
  // 造一份只有 2 个库的表，指向与随包表不同的库名
  const t = now();
  await db().prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES ('only-in-db', 'https://gitcode.com/CPF-ApplicationTPC/only-in-db', '只有库里有', 'v1.0.0', 'active', ?, ?)`)
    .run(t, t);
  const custom = writeSheet(path.join(tmpDir, 'custom.xlsx'), [
    ['三方库名称', 'URL'],
    ['adler-32', `${MONO}/tree/master/Adler32Demo`],   // 与随包表一致 → 无变化
    ['only-in-db', 'https://gitcode.com/CPF-ApplicationTPC/only-in-db'],
  ]);
  const r = await C.ensureLibraryCatalog();
  check(r.status === 'unchanged', '数据目录已有表时，不会拿随包资产去覆盖它', `status=${r.status}`);
  const still = await db().prepare("SELECT name FROM libraries WHERE name = 'only-in-db'").get();
  check(!!still, '仅库中存在的库未被删除');
  const adler2 = await db().prepare("SELECT repo_subpath FROM libraries WHERE name = 'adler-32'").get();
  check(adler2?.repo_subpath === 'Adler32Demo', '已有库的子目录未被改坏');
}

// ---------- 4. 绝不覆盖 Agent 字段（关键边界）----------
console.log('\n— 绝不覆盖 Agent 维护的字段（整个功能的关键边界）—');
{
  // 给一个表里有的库补上 Agent 字段，再导入一次（同 sha256 → 应跳过，字段原样）
  const t = now();
  await db().prepare(`UPDATE libraries SET package_name = 'com.agent.filled', main_ability = 'EntryAbility',
    last_commit = 'deadbeef', last_synced_at = ?, current_version = 'v9.9.9' WHERE name = 'adler-32'`)
    .run(t);
  const before = await db().prepare("SELECT package_name, main_ability, last_commit, current_version FROM libraries WHERE name = 'adler-32'").get();

  await C.ensureLibraryCatalog();   // sha256 与上次相同 → 不写库

  const after = await db().prepare("SELECT package_name, main_ability, last_commit, current_version FROM libraries WHERE name = 'adler-32'").get();
  check(after.package_name === before.package_name && before.package_name === 'com.agent.filled',
    'package_name 未被覆盖', `${before.package_name} → ${after.package_name}`);
  check(after.main_ability === 'EntryAbility', 'main_ability 未被覆盖');
  check(after.last_commit === 'deadbeef', 'last_commit 未被覆盖');
  check(after.current_version === 'v9.9.9', 'current_version 未被覆盖');

  // 再走一次手动 sync（apply=true）——它同样只写"人维护的两列"
  const S = await import('../lib/services/librarySheet.js');
  await S.syncLibrariesFromSheet({ file: path.join(tmpDir, SHEET_NAME), apply: true });
  const after2 = await db().prepare("SELECT package_name, main_ability, last_commit FROM libraries WHERE name = 'adler-32'").get();
  check(after2.package_name === 'com.agent.filled' && after2.last_commit === 'deadbeef',
    '手动同步同样不覆盖 Agent 字段', JSON.stringify(after2));
}

// ---------- 5. 表读不出来不阻断启动 ----------
console.log('\n— 表缺失/解析不出库时不阻断启动—');
{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-catalog-empty-'));
  // 造一份只有表头、解析不出任何库的表（readSheet 会抛"没有解析出任何库"）
  writeSheet(path.join(emptyDir, SHEET_NAME), [['三方库名称', 'URL'], ['没有地址的行', '']]);

  const r = await runInIsolatedDir(emptyDir);
  check(r.ok, '表里解析不出库时返回 ok（不抛异常、不阻断启动）', JSON.stringify(r.result?.status));
  check(/目录引导/.test(r.log), '启动日志有目录引导说明（人看得见发生了什么）');
}

// ---------- 6. catalogStatus 形状 ----------
console.log('\n— catalogStatus（前端/agent 消费的形状）—');
{
  const s = await C.catalogStatus();
  check(s.bundled.exists === true, 'bundled.exists');
  check(s.active.exists === true, 'active.exists');
  check(Array.isArray(s.problems), 'problems 是数组');
  check(s.db.libraries > 300, 'db.libraries 与库表一致', `libraries=${s.db.libraries}`);
  check(s.db.profiled === 0 && s.db.unprofiled === s.db.libraries,
    'profiled 恒 0（env_profiles 表 R1 才建），unprofiled 自洽');
  check(!!s.latest && s.latest.source === 'bundled', 'latest 指向 bundled 导入');
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

// ---------- 工具 ----------
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 在隔离子进程里跑一次「启动 → 目录引导」（指定数据目录）。
 *
 * 为什么用子进程而不是直接改 process.env.AUTOTEST_DATA_DIR：db/sqlite.ts 的
 * resolvedDir 是进程内缓存，第一次解析后就不再变——同进程内换目录只会拿到旧库。
 * 而"表读不出来不阻断启动"这条必须在**全新的空数据目录**里验证。
 *
 * 为什么用 `node -e --input-type=module` 而不是写个临时 .mjs：ESM 的裸导入
 * （xlsx 等）按**导入文件所在目录**向上找 node_modules；临时目录在 os.tmpdir() 下，
 * 永远找不到包的依赖。`-e` 的模块路径取 cwd，所以传绝对路径最稳。
 *
 * 复刻真实启动顺序：ensureReady()（建表 + 种子）→ ensureLibraryCatalog()。
 * 少了 ensureReady() 会拿到"no such table: libraries"，测的就不是想要的那件事了。
 */
async function runInIsolatedDir(dir) {
  const { spawnSync } = await import('node:child_process');
  // 包根从**脚本自身位置**推（scripts/ 的上一级），不依赖 cwd——npm run 与手跑都可能换 cwd。
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Windows 坑（rules/windows-nodejs-pitfalls）：ESM 的 import() 对绝对路径按 URL scheme 解析，
  // 直接传 'D:\...\x.js' 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'd:'）。
  // 必须过 pathToFileURL 转成 file:// URL，跨平台才都能跑。
  const asUrl = (p) => pathToFileURL(p).href;
  const code = [
    `const { ensureReady } = await import(${JSON.stringify(asUrl(path.join(pkgRoot, 'lib', 'db', 'connection.js')))});`,
    `const C = await import(${JSON.stringify(asUrl(path.join(pkgRoot, 'lib', 'services', 'catalog.js')))});`,
    `await ensureReady();`,
    `const r = await C.ensureLibraryCatalog();`,
    `console.log('RESULT=' + JSON.stringify(r));`,
  ].join('\n');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: pkgRoot, env: { ...process.env, AUTOTEST_DATA_DIR: dir }, encoding: 'utf8',
  });
  const log = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const m = /RESULT=(\{.*\})/.exec(log);
  return { ok: res.status === 0 && !!m, result: m ? JSON.parse(m[1]) : null, log };
}
