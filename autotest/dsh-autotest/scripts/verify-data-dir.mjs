// 数据目录自检：业务库默认落点必须在 node_modules 之外 + 旧数据无缝迁移。
// 不连 MySQL、不调 LLM、不需要设备；全程在插件目录下的一次性沙箱里造假安装树，
// **绝不碰真实 data/ 目录，也不碰 ~/.dsh**。
//
// 钉死六件事，每条对应一个真实后果：
//   ① 默认落点不含 node_modules：放在插件包内 = pnpm install / 升级 / 重装就连库一起删；
//   ② 旧数据自动迁移且一条不少：不搬 = 升级即丢库，用户以为"数据全没了"；
//   ③ 显式 AUTOTEST_DATA_DIR 时不迁移：否则自检会把使用者真库拖进临时目录；
//   ④ 新位置已有库时不重复搬、不覆盖：避免把新库冲掉；
//   ⑤ 搬不动就退回旧目录：绝不能因为一次搬家就拿空库启动（比丢库更糟——无声）；
//   ⑥ WAL 里已提交的数据也搬得走：只拷主库会丢掉最近一批写入。
// 用法：npm run build && npm run verify:data-dir
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDbDir = path.join(pluginDir, 'lib', 'db');
const DB_FILE = 'autotest.sqlite3';

// 沙箱必须放在插件目录下（不能放 os.tmpdir）：假安装树里的 lib/db/sqlite.js 要能
// 逐级向上解析到 better-sqlite3。也不能放在插件自己的 node_modules 里——那会让
// 「最外层 node_modules」的判定算回插件目录，把测试的数据落到使用者仓库里。
const sandbox = path.join(pluginDir, `.verify-data-dir-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

let installSeq = 0;
/** 造假安装树：<sandbox>/install-N/node_modules/dsh-autotest/lib/db/sqlite.js（路径唯一 → 模块状态全新）。 */
function makeInstall() {
  const root = path.join(sandbox, `install-${++installSeq}`);
  const pkg = path.join(root, 'node_modules', 'dsh-autotest');
  const dbDir = path.join(pkg, 'lib', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.copyFileSync(path.join(libDbDir, 'sqlite.js'), path.join(dbDir, 'sqlite.js'));
  return { root, pkg, dbDir, module: path.join(dbDir, 'sqlite.js') };
}

/** 连 connection.js 一起拷过去（要验 .mysql-url 引导文件认新位置）。 */
function copyDbModules({ dbDir }) {
  for (const f of fs.readdirSync(libDbDir)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(libDbDir, f), path.join(dbDir, f));
  }
}

const load = async (file) => import(pathToFileURL(file).href);

/** 造一个带标记行的 SQLite 库（WAL 模式，与真实库一致）。 */
function makeLegacyDb(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, DB_FILE));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE verify_marker (v TEXT)');
  db.prepare('INSERT INTO verify_marker (v) VALUES (?)').run(marker);
  db.close();
}

const markerOf = (file) => {
  const db = new Database(file, { readonly: true });
  const row = db.prepare('SELECT v FROM verify_marker').get();
  db.close();
  return row?.v ?? null;
};

const hasMigratedBackup = (pkg) => fs.readdirSync(pkg).some((n) => n.startsWith('data.migrated-'));

try {
  // ---------- ① 默认落点在安装根，不在 node_modules 里 ----------
  console.log('— 默认落点 —');
  {
    delete process.env.AUTOTEST_DATA_DIR;
    const { pkg, root, module } = makeInstall();
    const { dataDir } = await load(module);
    const dir = dataDir();
    check(dir === path.join(root, 'autotest-data'), '默认数据目录 = <安装根>/autotest-data', dir);
    check(!dir.split(path.sep).includes('node_modules'),
      '★ 默认落点不在 node_modules 里（pnpm 重装/升级不会连带删掉业务库）', dir);
    check(fs.existsSync(dir), '目录已创建');
    check(dataDir() === dir, '重复调用返回同一目录（迁移只做一次）');
  }

  // ---------- ② 环境变量覆盖优先，且不触发迁移 ----------
  console.log('\n— AUTOTEST_DATA_DIR 覆盖 —');
  {
    const { pkg, module } = makeInstall();
    makeLegacyDb(path.join(pkg, 'data'), 'legacy-should-stay');
    const explicit = path.join(sandbox, 'explicit');
    process.env.AUTOTEST_DATA_DIR = explicit;
    const { dataDir } = await load(module);
    const dir = dataDir();
    check(dir === explicit, 'AUTOTEST_DATA_DIR 覆盖生效', dir);
    check(!hasMigratedBackup(pkg),
      '★ 显式覆盖时不迁移（自检不会把使用者真实库拖进临时目录）');
    check(fs.existsSync(path.join(pkg, 'data', DB_FILE)), '旧目录原样未动');
  }

  // ---------- ③ 旧数据自动迁移：一条不少 ----------
  console.log('\n— 旧数据自动迁移 —');
  {
    delete process.env.AUTOTEST_DATA_DIR;
    const { pkg, root, dbDir, module } = makeInstall();
    copyDbModules({ dbDir });
    const legacy = path.join(pkg, 'data');
    makeLegacyDb(legacy, 'legacy-row');
    fs.writeFileSync(path.join(legacy, '.mysql-url'), 'mysql://marker', 'utf8');
    fs.writeFileSync(path.join(legacy, '三方库测试表.xlsx'), 'xlsx-bytes', 'utf8');

    const { dataDir } = await load(module);
    const dir = dataDir();
    const target = path.join(dir, DB_FILE);
    check(dir === path.join(root, 'autotest-data'), '迁到 <安装根>/autotest-data', dir);
    check(fs.existsSync(target), '库文件已搬到新目录');
    check(markerOf(target) === 'legacy-row', '★ 旧库数据一条不少（升级不丢库）', markerOf(target));
    check(fs.readFileSync(path.join(dir, '.mysql-url'), 'utf8') === 'mysql://marker',
      '.mysql-url 引导文件跟着搬（否则 MySQL 模式启动会失联）');
    check(fs.existsSync(path.join(dir, '三方库测试表.xlsx')), '三方库测试表.xlsx 跟着搬');
    const backups = fs.readdirSync(pkg).filter((n) => n.startsWith('data.migrated-'));
    check(backups.length === 1, '旧目录改名留底（不直接删）', backups.join(','));
    check(fs.existsSync(path.join(pkg, backups[0], DB_FILE)), '留底目录里库还在');

    const { defaultUrlProvider } = await load(path.join(dbDir, 'connection.js'));
    check(defaultUrlProvider() === 'mysql://marker',
      '★ .mysql-url 引导从新数据目录读到（不再把插件包内路径写死）', defaultUrlProvider());
  }

  // ---------- ④ 已经迁过：不重复搬、不覆盖 ----------
  console.log('\n— 已迁过不重复搬 —');
  {
    delete process.env.AUTOTEST_DATA_DIR;
    const { pkg, root, module } = makeInstall();
    const target = path.join(root, 'autotest-data');
    makeLegacyDb(target, 'new-row');
    makeLegacyDb(path.join(pkg, 'data'), 'old-row');
    const { dataDir } = await load(module);
    check(dataDir() === target, '仍用新数据目录');
    check(markerOf(path.join(target, DB_FILE)) === 'new-row',
      '★ 新位置已有库时不被旧库覆盖', markerOf(path.join(target, DB_FILE)));
    check(!hasMigratedBackup(pkg), '旧目录原样保留（没有重复搬家）');
  }

  // ---------- ⑤ 搬不动就退回旧目录 ----------
  console.log('\n— 迁移失败退回旧目录 —');
  {
    delete process.env.AUTOTEST_DATA_DIR;
    const { pkg, root, module } = makeInstall();
    const legacy = path.join(pkg, 'data');
    makeLegacyDb(legacy, 'legacy-row');
    // 把目标位置占成一个文件 → mkdirSync 必失败
    fs.writeFileSync(path.join(root, 'autotest-data'), 'not-a-dir', 'utf8');
    const { dataDir } = await load(module);
    const dir = dataDir();
    check(dir === legacy, '★ 目标不可写时退回旧目录继续用（不丢数据）', dir);
    check(markerOf(path.join(dir, DB_FILE)) === 'legacy-row', '退回后旧库照旧能读', markerOf(path.join(dir, DB_FILE)));
  }

  // ---------- ⑥ WAL 里已提交的数据也搬得走 ----------
  console.log('\n— WAL 数据不丢 —');
  {
    delete process.env.AUTOTEST_DATA_DIR;
    const { pkg, module } = makeInstall();
    const legacy = path.join(pkg, 'data');
    fs.mkdirSync(legacy, { recursive: true });
    // 造一对「主库 + 未 checkpoint 的 WAL」：连接开着写，趁 WAL 还在直接把文件复制出去
    const staged = path.join(sandbox, `staged-${installSeq}`);
    fs.mkdirSync(staged, { recursive: true });
    const live = new Database(path.join(staged, DB_FILE));
    live.pragma('journal_mode = WAL');
    live.exec('CREATE TABLE verify_marker (v TEXT)');
    live.prepare('INSERT INTO verify_marker (v) VALUES (?)').run('wal-row');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.copyFileSync(path.join(staged, DB_FILE + suffix), path.join(legacy, DB_FILE + suffix));
    }
    live.close();
    check(fs.statSync(path.join(legacy, `${DB_FILE}-wal`)).size > 0, '旧目录里确实留着未 checkpoint 的 WAL');

    const { dataDir } = await load(module);
    check(markerOf(path.join(dataDir(), DB_FILE)) === 'wal-row',
      '★ WAL 里已提交的数据也搬得走（先 checkpoint 再拷）', markerOf(path.join(dataDir(), DB_FILE)));
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '全部自检通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
