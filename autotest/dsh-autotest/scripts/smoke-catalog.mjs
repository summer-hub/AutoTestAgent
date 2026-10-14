// R0 冒烟：验证「随包 xlsx → 业务库」的启动 bootstrap 真的生效。
// 用法：AUTOTEST_DATA_DIR=<空目录> npx tsx scripts/smoke-catalog.mjs
import { ensureReady, getDb } from '../src/db/connection.js';
import { catalogStatus } from '../src/services/catalog.js';

await ensureReady();
const s = await catalogStatus();
const rows = await getDb().prepare('SELECT COUNT(*) n FROM libraries').get();
const imp = await getDb().prepare('SELECT * FROM library_catalog_imports ORDER BY id DESC LIMIT 1').get();
const sample = await getDb().prepare('SELECT name, repo_url, repo_subpath, package_name FROM libraries ORDER BY id LIMIT 3').all();
console.log('libraries =', rows.n);
console.log('bundled   =', s.bundled.exists, s.bundled.path);
console.log('latest    =', JSON.stringify(imp));
console.log('problems  =', s.problems.length, JSON.stringify(s.problems.slice(0, 2)));
console.log('db        =', JSON.stringify(s.db));
console.log('sample    =', JSON.stringify(sample));
const nImp = await getDb().prepare('SELECT COUNT(*) n FROM library_catalog_imports').get();
console.log('import_records =', nImp.n, '（第二次启动仍为 1 即证明幂等、未重复写库）');
process.exit(0);
