// 业务数据源：双引擎（自动降级）
//  - MySQL（默认，服务器化多用户）：配置了 db.mysqlUrl / AUTOTEST_MYSQL_URL / data/.mysql-url 时使用
//  - SQLite 本地降级：未配置任何 MySQL 连接时自动落到 <data>/autotest.sqlite3（轻量单文件库，
//    登录/业务/设置全部可用；AUTOTEST_DB_MODE=sqlite 可强制）
//  - 统一 facade：prepare().get/all/run + transaction（AsyncLocalStorage 事务上下文）
//  - 参数支持位置 ? 与命名 @name（内部转换为 ?）；SQLite 模式下自动翻译少量 MySQL 方言
import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from './schema.js';
import { sqliteSchemaStatements } from './schema-sqlite.js';
import { sqlite, dataDir } from './sqlite.js';
let pool = null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 连接串引导：环境变量 → data/.mysql-url（迁移脚本写入）→ '' */
export function defaultUrlProvider() {
    if (process.env.AUTOTEST_MYSQL_URL)
        return process.env.AUTOTEST_MYSQL_URL.trim();
    try {
        const f = path.resolve(__dirname, '../../data/.mysql-url');
        if (fs.existsSync(f))
            return fs.readFileSync(f, 'utf8').trim();
    }
    catch { /* 忽略 */ }
    return '';
}
let urlProvider = defaultUrlProvider;
let readyPromise = null;
const txStore = new AsyncLocalStorage();
let lockedMode = null;
/** 当前数据库引擎：mysql（默认）| sqlite（未配置连接时本地降级）。ensureReady 后锁定。 */
export function dbMode() {
    if (lockedMode)
        return lockedMode;
    const forced = String(process.env.AUTOTEST_DB_MODE || '').trim().toLowerCase();
    let mode;
    if (forced === 'sqlite')
        mode = 'sqlite';
    else if (forced === 'mysql')
        mode = 'mysql';
    else {
        let url = '';
        try {
            url = urlProvider().trim();
        }
        catch { /* provider 异常按未配置处理 */ }
        mode = url ? 'mysql' : 'sqlite';
    }
    return mode;
}
/** 注入 MySQL 连接串提供者（index.ts 从 settings 缓存注入）。 */
export function setDbUrlProvider(fn) {
    urlProvider = fn;
}
export function mysqlPool() {
    if (!pool) {
        const url = urlProvider().trim();
        if (!url)
            throw new Error('未配置 MySQL 连接（系统配置 db.mysqlUrl 或环境变量 AUTOTEST_MYSQL_URL）');
        pool = mysql.createPool({
            uri: url,
            waitForConnections: true,
            connectionLimit: 12,
            charset: 'utf8mb4',
            timezone: 'Z',
            dateStrings: true,
            supportBigNumbers: true,
            bigNumberStrings: false,
        });
    }
    return pool;
}
/** MySQL 方言 → SQLite 方言的少量安全翻译。 */
function translateSqlite(s) {
    return s
        .replace(/INSERT\s+IGNORE/gi, 'INSERT OR IGNORE')
        .replace(/\sAS\s+UNSIGNED/gi, ' AS INTEGER');
}
/** 统一查询入口：事务上下文内走事务连接，否则走引擎。 */
async function query(sql, args) {
    if (dbMode() === 'sqlite') {
        const s = translateSqlite(sql);
        const head = s.trimStart().slice(0, 6).toUpperCase();
        const stmt = sqlite().prepare(s);
        if (head.startsWith('SELECT') || head.startsWith('PRAGMA')) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return stmt.all(...args);
        }
        const info = stmt.run(...args);
        // 归一化为 mysql2 OkPacket 形态，供 facade.run 统一读取
        return { affectedRows: info.changes, insertId: Number(info.lastInsertRowid) };
    }
    const tx = txStore.getStore();
    if (tx) {
        const [rows] = await tx.query(sql, args);
        return rows;
    }
    const [rows] = await mysqlPool().query(sql, args);
    return rows;
}
export function now() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
// ---------- 参数转换（mysql2 不支持 @name 命名参数） ----------
function normalize(sql, params) {
    // 单个对象参数 → 命名参数 @name 转换；其余按位置参数
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
        const named = params[0];
        const args = [];
        const out = sql.replace(/@([A-Za-z0-9_]+)/g, (_, k) => {
            args.push(named[k]);
            return '?';
        });
        return { sql: out, args };
    }
    return { sql, args: params };
}
export function prepare(sql) {
    return {
        async get(...params) {
            const { sql: s, args } = normalize(sql, params);
            const rows = await query(s, args);
            return rows[0];
        },
        async all(...params) {
            const { sql: s, args } = normalize(sql, params);
            return await query(s, args);
        },
        async run(...params) {
            const { sql: s, args } = normalize(sql, params);
            const r = await query(s, args);
            return { changes: r.affectedRows, lastInsertRowid: Number(r.insertId) };
        },
    };
}
export function getDb() {
    return { prepare, exec, transaction };
}
/** 执行多语句（按分号拆分，供 DDL / 迁移用）。 */
export async function exec(sql) {
    const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
    for (const s of stmts) {
        await query(s, []);
    }
}
/** 事务：MySQL 从池取连接；SQLite 走 BEGIN/COMMIT（单连接同步执行，天然串行）。 */
export async function transaction(fn) {
    if (dbMode() === 'sqlite') {
        sqlite().exec('BEGIN IMMEDIATE');
        try {
            const r = await fn();
            sqlite().exec('COMMIT');
            return r;
        }
        catch (e) {
            try {
                sqlite().exec('ROLLBACK');
            }
            catch { /* ignore */ }
            throw e;
        }
    }
    const conn = await mysqlPool().getConnection();
    try {
        await conn.beginTransaction();
        const r = await txStore.run(conn, () => fn());
        await conn.commit();
        return r;
    }
    catch (e) {
        try {
            await conn.rollback();
        }
        catch { /* ignore */ }
        throw e;
    }
    finally {
        conn.release();
    }
}
/** 读路径（连接池/单文件库天然并发，直接走 facade）。 */
export async function withRead(fn) {
    return fn(getDb());
}
/** 内置 Prompt v2 内容（ensureReady 升级用，MySQL/SQLite 共用）。 */
const CASE_GEN_V2_CONTENT = '你是鸿蒙三方库 UI 测试用例设计 Agent（HarmonyOS/OpenHarmony）。\n【设计原则】以「真实可操作、用例逻辑合理、预期结果明确清晰」为准绳：\n1. 真实可操作——所有步骤必须基于给定上下文中真实存在的页面与控件（仓库工程解析或真机遍历 dump），严禁臆造按钮/菜单/跳转；\n2. 逻辑合理——步骤顺序符合真实用户操作路径，前置条件完整，正向/边界/异常场景覆盖且有区分度，不堆砌重复用例；\n3. 预期结果明确清晰——具体到控件文本、动画名（如 Lottie json）、hilog 日志内容等可观察证据，禁止「显示正常」「工作正常」式空泛描述。\n【库类别适配】先判断库的类别（动画渲染/网络请求/UI 组件/数据存储等），按类别选择验证手段：动画类验证播放/暂停/进度/循环；网络类验证请求成功/失败/超时回调与 hilog 输出；UI 组件类验证属性设置、事件回调、状态切换；其他类别按库简介自行推导并在用例中说明依据。\n【输出】JSON 数组：{ name, precondition, steps[], expected }，来源固定为 AI 生成。只输出 JSON。';
const CASE_GEN_V2_SKILL = 'autotest-case-author v2：真实工程/真机遍历双驱动——控件必须来自真实数据；按库类别（动画/网络/组件/存储）适配验证手段；预期落具体动画、文本与 hilog 日志；生成后自审修订（真实可操作/逻辑合理/预期清晰）。';
/** 内置 Prompt 升级（facade 执行，双引擎通用）。 */
async function upgradeBuiltinPrompts() {
    try {
        await getDb().prepare(`UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 2, updated_at = ?
       WHERE role = '用例生成' AND builtin = 1 AND version < 2`).run(CASE_GEN_V2_CONTENT, CASE_GEN_V2_SKILL, now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 内置 Prompt 升级跳过：', e.message);
    }
    // 老库补插「用例优化 Agent」（不存在时插入；用户改过/已建则跳过）
    try {
        const insertSql = dbMode() === 'sqlite'
            ? `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '用例优化 Agent', '用例优化', ?, ?, '[]', 1, 1, ?
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '用例优化')`
            : `INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at)
         SELECT '用例优化 Agent', '用例优化', ?, ?, '[]', 1, 1, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE role = '用例优化')`;
        await getDb().prepare(insertSql).run('你是鸿蒙三方库测试用例优化 Agent。在保持原用例测试意图与覆盖目标不变的前提下提升质量：\n1. 真实可操作——步骤引用的控件必须来自给定上下文（页面源码/真机遍历控件清单），删除或修正臆造的按钮与跳转；\n2. 逻辑合理——补全前置条件，理顺操作顺序，拆分过长的组合步骤，去除重复；\n3. 预期结果明确清晰——具体到控件文本/动画名/回调 JSON 字段/hilog 日志，禁止空泛描述；内容超一屏时补「向上滑动查看输出区域」步骤；\n4. 输出 JSON：{ name, precondition, steps[], expected }。只输出 JSON，不要解释。', 'autotest-case-optimizer：保持测试意图不变，步骤真实、逻辑顺畅、预期可验证；结合控件清单修正臆造引用。', now());
    }
    catch (e) {
        console.warn('[dsh-autotest] 用例优化 Agent 补插跳过：', e.message);
    }
}
/** 建表 + settings 加载 + 种子（幂等，首次请求前完成）。 */
export async function ensureReady() {
    if (!readyPromise) {
        readyPromise = (async () => {
            if (dbMode() === 'sqlite') {
                // ---- SQLite 本地降级 ----
                for (const stmt of sqliteSchemaStatements()) {
                    try {
                        await query(stmt, []);
                    }
                    catch (e) {
                        console.warn(`[sqlite] ${String(stmt).slice(0, 40)}…: ${e.message}`);
                    }
                }
                // 列迁移（新版本补列）：PRAGMA table_info 检查后 ALTER
                for (const [table, col] of [
                    ['libraries', 'package_name'], ['libraries', 'main_ability'],
                    ['plans', 'script_mode'], ['plans', 'error'], ['plans', 'progress'], ['plans', 'progress_note'],
                ]) {
                    try {
                        const cols = await query(`PRAGMA table_info(${table})`, []);
                        if (Array.isArray(cols) && !cols.some((c) => c.name === col)) {
                            const ddl = {
                                package_name: "ALTER TABLE libraries ADD COLUMN package_name TEXT NOT NULL DEFAULT ''",
                                main_ability: "ALTER TABLE libraries ADD COLUMN main_ability TEXT NOT NULL DEFAULT ''",
                                script_mode: "ALTER TABLE plans ADD COLUMN script_mode TEXT NOT NULL DEFAULT ''",
                                error: "ALTER TABLE plans ADD COLUMN error TEXT NOT NULL DEFAULT ''",
                                progress: 'ALTER TABLE plans ADD COLUMN progress INTEGER NOT NULL DEFAULT 0',
                                progress_note: "ALTER TABLE plans ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''",
                            };
                            await query(ddl[col], []);
                        }
                    }
                    catch { /* 已存在则跳过 */ }
                }
                const { loadSettings } = await import('../services/settings.js');
                await loadSettings();
                const row = await getDb().prepare('SELECT COUNT(*) AS n FROM libraries').get();
                if (!row || row.n === 0) {
                    const { seed } = await import('./seed.js');
                    await seed();
                }
                await upgradeBuiltinPrompts();
                lockedMode = 'sqlite';
                console.log(`[dsh-autotest] 业务库就绪（SQLite 本地模式 · ${path.join(dataDir(), 'autotest.sqlite3')}）`);
                return;
            }
            // ---- MySQL 模式 ----
            for (const stmt of schemaStatements()) {
                try {
                    await mysqlPool().query(stmt);
                }
                catch (e) {
                    const msg = e.message;
                    if (/Duplicate key name|already exists/i.test(msg))
                        continue;
                    throw e;
                }
            }
            // 轻量迁移：旧库补充包名/主 Ability 列 + 计划脚本模式/错误信息列
            for (const [, , ddl] of [
                ['libraries', 'package_name', "ALTER TABLE libraries ADD COLUMN package_name VARCHAR(128) NOT NULL DEFAULT ''"],
                ['libraries', 'main_ability', "ALTER TABLE libraries ADD COLUMN main_ability VARCHAR(255) NOT NULL DEFAULT ''"],
                ['plans', 'script_mode', "ALTER TABLE plans ADD COLUMN script_mode VARCHAR(16) NOT NULL DEFAULT ''"],
                ['plans', 'error', "ALTER TABLE plans ADD COLUMN error VARCHAR(500) NOT NULL DEFAULT ''"],
                ['plans', 'progress', 'ALTER TABLE plans ADD COLUMN progress INT NOT NULL DEFAULT 0'],
                ['plans', 'progress_note', "ALTER TABLE plans ADD COLUMN progress_note VARCHAR(300) NOT NULL DEFAULT ''"],
            ]) {
                try {
                    await mysqlPool().query(ddl);
                }
                catch (e) {
                    if (!/Duplicate column/i.test(e.message))
                        throw e;
                }
            }
            // settings 内存缓存加载（来自 MySQL settings 表）
            const { loadSettings } = await import('../services/settings.js');
            await loadSettings();
            // 内置 Prompt 升级：用例生成 Agent v1 → v2（仅当未被人工改过，version < 2；改过则 version 已 ≥2 自动跳过）
            try {
                await mysqlPool().query(`UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 2, updated_at = NOW()
           WHERE role = '用例生成' AND builtin = 1 AND version < 2`, [CASE_GEN_V2_CONTENT, CASE_GEN_V2_SKILL]);
            }
            catch (e) {
                console.warn('[dsh-autotest] 内置 Prompt 升级跳过：', e.message);
            }
            // 种子：libraries 为空时灌入
            const row = await getDb().prepare('SELECT COUNT(*) AS n FROM libraries').get();
            if (!row || row.n === 0) {
                const { seed } = await import('./seed.js');
                await seed();
            }
            lockedMode = 'mysql';
            console.log('[dsh-autotest] 业务库就绪（MySQL）');
        })().catch((e) => {
            readyPromise = null;
            throw e;
        });
    }
    return readyPromise;
}
