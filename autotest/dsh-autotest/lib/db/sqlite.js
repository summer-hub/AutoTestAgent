// SQLite 轻量引擎（better-sqlite3）：无 MySQL 环境的本地降级数据源。
//  - 单文件库 <插件根>/data/autotest.sqlite3（AUTOTEST_DATA_DIR 可覆盖）
//  - 同步 API，facade 层保持 async 形态；WAL 模式提升并发读写
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 数据目录：环境变量 AUTOTEST_DATA_DIR > 插件根/data */
export function dataDir() {
    const base = String(process.env.AUTOTEST_DATA_DIR || '').trim();
    const dir = base || path.resolve(__dirname, '../../data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
let db = null;
export function sqlite() {
    if (!db) {
        const file = path.join(dataDir(), 'autotest.sqlite3');
        db = new Database(file);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = OFF');
        db.pragma('busy_timeout = 5000');
    }
    return db;
}
