// 一次性迁移脚本：SQLite（数据目录/autotest.sqlite3）→ MySQL（db.mysqlUrl / AUTOTEST_MYSQL_URL）
// 用法：npx tsx scripts/migrate-sqlite-to-mysql.ts
// 步骤：建业务表（幂等）→ 按依赖序批量迁移 → 行数校验
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { schemaStatements } from '../src/db/schema.js';
import { dataDir } from '../src/db/sqlite.js';

// 库文件名必须是 autotest.sqlite3（与 db/sqlite.ts 一致）。
// 历史坑：这里曾写成 autotest.db，better-sqlite3 会"热心地"新建一个空库，
// 于是脚本报"每张表 0 行（跳过）"并正常退出 —— 看起来迁移成功，实际什么都没搬。
// 路径走 dataDir()：库可能在安装根/autotest-data，也可能被 AUTOTEST_DATA_DIR 指到别处。
const DB_PATH = process.env.AUTOTEST_SQLITE_DB || path.join(dataDir(), 'autotest.sqlite3');
const MYSQL_URL = process.env.AUTOTEST_MYSQL_URL || 'mysql://root:123456@127.0.0.1:3306/autotest';

const TABLES = [
  'libraries', 'cases', 'case_versions', 'tasks', 'plans',
  'executions', 'executions_archive', 'devices', 'prompts', 'models', 'analyses',
  'agent_events', 'settings',
];

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) throw new Error(`SQLite 数据库不存在：${DB_PATH}`);
  const src = new Database(DB_PATH, { readonly: true });
  // 源库体检：空库/错库时必须直接失败。否则每张表都是"0 行（跳过）"，
  // 脚本会以退出码 0 结束，看起来迁移成功、实际一行没搬。
  const srcTables = (src.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name);
  const missing = TABLES.filter((t) => !srcTables.includes(t));
  const srcLibs = srcTables.includes('libraries')
    ? (src.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number }).n
    : 0;
  if (missing.length === TABLES.length || srcLibs === 0) {
    throw new Error(
      `源库看起来不是有效的 AutoTest 业务库：${DB_PATH}\n` +
      `  表数 ${srcTables.length}、libraries ${srcLibs} 行、缺失表 ${missing.join(', ') || '无'}\n` +
      `  请确认路径（默认取数据目录，可用 AUTOTEST_SQLITE_DB 指定）。`,
    );
  }
  const pool = mysql.createPool({
    uri: MYSQL_URL, waitForConnections: true, connectionLimit: 8,
    charset: 'utf8mb4', timezone: 'Z', dateStrings: true, supportBigNumbers: true,
  });

  console.log(`[migrate] SQLite: ${DB_PATH}（${srcTables.length} 张表 / libraries ${srcLibs} 行）`);
  console.log(`[migrate] MySQL: ${MYSQL_URL}`);

  // 1. 建业务表（幂等）
  for (const stmt of schemaStatements()) {
    try {
      await pool.query(stmt);
    } catch (e) {
      const msg = (e as Error).message;
      if (/Duplicate key name|already exists/i.test(msg)) continue;
      throw e;
    }
  }
  console.log('[migrate] 业务表已就绪');

  // 2. 逐表迁移（保留原 id，重复键跳过）
  for (const table of TABLES) {
    const rows = src.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) { console.log(`[migrate] ${table}: 0 行（跳过）`); continue; }
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const placeholders = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
      const sql = `INSERT IGNORE INTO \`${table}\` (${colList}) VALUES ${placeholders}`;
      const args = chunk.flatMap((r) => cols.map((c) => {
        const v = r[c];
        return v === null || v === undefined ? null : v;
      }));
      const [res] = await pool.query(sql, args) as [mysql.ResultSetHeader, unknown];
      inserted += res.affectedRows;
    }
    console.log(`[migrate] ${table}: ${rows.length} 行 → 写入 ${inserted}`);
  }

  // 3. 行数校验
  console.log('\n[verify] 行数对比（SQLite vs MySQL）：');
  let ok = true;
  for (const table of TABLES) {
    const n1 = (src.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``) as [Array<{ n: number }>, unknown];
    const n2 = Number(r[0].n);
    const match = n1 === n2;
    if (!match) ok = false;
    console.log(`  ${table}: ${n1} vs ${n2} ${match ? '✓' : '✗ 不一致！'}`);
  }

  await pool.end();
  src.close();
  console.log(ok ? '\n✅ 迁移完成，行数全部一致' : '\n⚠️ 存在不一致，请检查！');
  // 4. 写入连接串引导文件（供插件启动读取）
  const guidePath = path.join(dataDir(), '.mysql-url');
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.writeFileSync(guidePath, MYSQL_URL, 'utf8');
  console.log(`[migrate] 已写入连接引导：${guidePath}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[migrate] 失败：', e); process.exit(1); });
