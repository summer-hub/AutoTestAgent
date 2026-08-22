// 插件数据目录：autotest/dsh-autotest/data/autotest.db（与独立版 server 数据分离）
// 可用环境变量 AUTOTEST_DB 覆盖
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function dbPath() {
    if (process.env.AUTOTEST_DB)
        return process.env.AUTOTEST_DB;
    const dataDir = path.resolve(__dirname, '..', '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'autotest.db');
}
let db = null;
// M7 连接池：主连接负责写（better-sqlite3 单写者），读池 N 个只读连接轮询，
// 热点读路径通过 withRead 分发，配合 WAL 支持并发读。
const READ_POOL_SIZE = 4;
let readPool = null;
let readCursor = 0;
export function getDb() {
    if (!db) {
        db = new Database(dbPath());
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
    }
    return db;
}
export function withRead(fn) {
    if (!readPool) {
        readPool = Array.from({ length: READ_POOL_SIZE }, () => new Database(dbPath(), { readonly: true }));
    }
    const conn = readPool[readCursor % readPool.length];
    readCursor++;
    return fn(conn);
}
export function now() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
/** 幂等建表；libraries 为空时自动灌入种子数据（开箱即用） */
export function ensureSchemaAndSeed() {
    const db = getDb();
    db.exec(SCHEMA);
    // 轻量迁移：旧库补充 last_commit 列（已存在时忽略）
    try {
        db.exec(`ALTER TABLE libraries ADD COLUMN last_commit TEXT NOT NULL DEFAULT ''`);
    }
    catch {
        /* 列已存在 */
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n;
    if (n === 0) {
        seed(db);
    }
}
import { SCHEMA } from './schema.js';
import { seed } from './seed.js';
