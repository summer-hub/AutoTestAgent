// 一次性迁移脚本：SQLite（data/autotest.db）→ MySQL（db.mysqlUrl / AUTOTEST_MYSQL_URL）
// 用法：npx tsx scripts/migrate-sqlite-to-mysql.ts
// 步骤：建业务表（幂等）→ 按依赖序批量迁移 → 行数校验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { schemaStatements } from '../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AUTOTEST_SQLITE_DB || path.resolve(__dirname, '../data/autotest.db');
const MYSQL_URL = process.env.AUTOTEST_MYSQL_URL || 'mysql://root:123456@127.0.0.1:3306/autotest';

const TABLES = [
  'libraries', 'cases', 'case_versions', 'tasks', 'plans',
  'executions', 'devices', 'prompts', 'models', 'analyses', 'settings',
];

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) throw new Error(`SQLite 数据库不存在：${DB_PATH}`);
  const src = new Database(DB_PATH, { readonly: true });
  const pool = mysql.createPool({
    uri: MYSQL_URL, waitForConnections: true, connectionLimit: 8,
    charset: 'utf8mb4', timezone: 'Z', dateStrings: true, supportBigNumbers: true,
  });

  console.log(`[migrate] SQLite: ${DB_PATH}`);
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
  const guidePath = path.resolve(__dirname, '../data/.mysql-url');
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.writeFileSync(guidePath, MYSQL_URL, 'utf8');
  console.log(`[migrate] 已写入连接引导：${guidePath}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[migrate] 失败：', e); process.exit(1); });
