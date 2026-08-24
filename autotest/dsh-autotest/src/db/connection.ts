// 业务数据源：MySQL（服务器化，多用户共享）
//  - 连接池 mysql2/promise；保持 getDb().prepare().get/all/run 调用形态，方法全部异步
//  - 参数支持位置 ? 与命名 @name（内部转换为 ?）
//  - settings 走内存缓存（见 services/settings.ts），保证同步读取
import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from './schema.js';

let pool: mysql.Pool | null = null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 连接串引导：环境变量 → data/.mysql-url（迁移脚本写入）→ '' */
export function defaultUrlProvider(): string {
  if (process.env.AUTOTEST_MYSQL_URL) return process.env.AUTOTEST_MYSQL_URL.trim();
  try {
    const f = path.resolve(__dirname, '../../data/.mysql-url');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  } catch { /* 忽略 */ }
  return '';
}

let urlProvider: () => string = defaultUrlProvider;
let readyPromise: Promise<void> | null = null;
const txStore = new AsyncLocalStorage<mysql.PoolConnection>();

/** 注入 MySQL 连接串提供者（index.ts 从 settings 缓存注入）。 */
export function setDbUrlProvider(fn: () => string): void {
  urlProvider = fn;
}

export function mysqlPool(): mysql.Pool {
  if (!pool) {
    const url = urlProvider().trim();
    if (!url) throw new Error('未配置 MySQL 连接（系统配置 db.mysqlUrl 或环境变量 AUTOTEST_MYSQL_URL）');
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

/** 统一查询入口：事务上下文内走事务连接，否则走连接池。 */
async function query(sql: string, args: unknown[]): Promise<unknown> {
  const tx = txStore.getStore();
  if (tx) {
    const [rows] = await tx.query(sql, args);
    return rows;
  }
  const [rows] = await mysqlPool().query(sql, args);
  return rows;
}

export function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------- 参数转换（mysql2 不支持 @name 命名参数） ----------
function normalize(sql: string, params: unknown[]): { sql: string; args: unknown[] } {
  // 单个对象参数 → 命名参数 @name 转换；其余按位置参数
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const named = params[0] as Record<string, unknown>;
    const args: unknown[] = [];
    const out = sql.replace(/@([A-Za-z0-9_]+)/g, (_, k) => {
      args.push(named[k]);
      return '?';
    });
    return { sql: out, args };
  }
  return { sql, args: params };
}

// ---------- 语句 facade ----------
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export function prepare(sql: string): Statement {
  return {
    async get<T>(...params: unknown[]): Promise<T | undefined> {
      const { sql: s, args } = normalize(sql, params);
      const rows = await query(s, args) as unknown[];
      return rows[0] as T | undefined;
    },
    async all<T>(...params: unknown[]): Promise<T[]> {
      const { sql: s, args } = normalize(sql, params);
      return await query(s, args) as T[];
    },
    async run(...params: unknown[]): Promise<RunResult> {
      const { sql: s, args } = normalize(sql, params);
      const r = await query(s, args) as mysql.ResultSetHeader;
      return { changes: r.affectedRows, lastInsertRowid: Number(r.insertId) };
    },
  };
}

export interface DbFacade {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export function getDb(): DbFacade {
  return { prepare, exec, transaction };
}

/** 执行多语句（按分号拆分，供 DDL / 迁移用）。 */
export async function exec(sql: string): Promise<void> {
  const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
  for (const s of stmts) {
    await query(s, []);
  }
}

/** 事务：从池取连接，BEGIN/COMMIT/ROLLBACK。 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const conn = await mysqlPool().getConnection();
  try {
    await conn.beginTransaction();
    const r = await txStore.run(conn, () => fn());
    await conn.commit();
    return r;
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** 读路径（MySQL 连接池天然并发，直接走 facade）。 */
export async function withRead<T>(fn: (db: DbFacade) => Promise<T>): Promise<T> {
  return fn(getDb());
}

/** 建表 + settings 加载 + 种子（幂等，首次请求前完成）。 */
export async function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      for (const stmt of schemaStatements()) {
        try {
          await mysqlPool().query(stmt);
        } catch (e) {
          const msg = (e as Error).message;
          if (/Duplicate key name|already exists/i.test(msg)) continue;
          throw e;
        }
      }
      // 轻量迁移：旧库补充包名/主 Ability 列
      for (const [table, col, ddl] of [
        ['libraries', 'package_name', "ALTER TABLE libraries ADD COLUMN package_name VARCHAR(128) NOT NULL DEFAULT ''"],
        ['libraries', 'main_ability', "ALTER TABLE libraries ADD COLUMN main_ability VARCHAR(255) NOT NULL DEFAULT ''"],
      ] as Array<[string, string, string]>) {
        try {
          await mysqlPool().query(ddl);
        } catch (e) {
          if (!/Duplicate column/i.test((e as Error).message)) throw e;
        }
      }
      // settings 内存缓存加载（来自 MySQL settings 表）
      const { loadSettings } = await import('../services/settings.js');
      await loadSettings();
      // 内置 Prompt 升级：用例生成 Agent v1 → v2（仅当未被人工改过，version < 2；改过则 version 已 ≥2 自动跳过）
      try {
        await mysqlPool().query(
          `UPDATE prompts SET content = ?, skill = ?, variables = '[]', version = 2, updated_at = NOW()
           WHERE role = '用例生成' AND builtin = 1 AND version < 2`,
          [
            '你是鸿蒙三方库 UI 测试用例设计 Agent（HarmonyOS/OpenHarmony）。\n【设计原则】以「真实可操作、用例逻辑合理、预期结果明确清晰」为准绳：\n1. 真实可操作——所有步骤必须基于给定上下文中真实存在的页面与控件（仓库工程解析或真机遍历 dump），严禁臆造按钮/菜单/跳转；\n2. 逻辑合理——步骤顺序符合真实用户操作路径，前置条件完整，正向/边界/异常场景覆盖且有区分度，不堆砌重复用例；\n3. 预期结果明确清晰——具体到控件文本、动画名（如 Lottie json）、hilog 日志内容等可观察证据，禁止「显示正常」「工作正常」式空泛描述。\n【库类别适配】先判断库的类别（动画渲染/网络请求/UI 组件/数据存储等），按类别选择验证手段：动画类验证播放/暂停/进度/循环；网络类验证请求成功/失败/超时回调与 hilog 输出；UI 组件类验证属性设置、事件回调、状态切换；其他类别按库简介自行推导并在用例中说明依据。\n【输出】JSON 数组：{ name, precondition, steps[], expected }，来源固定为 AI 生成。只输出 JSON。',
            'autotest-case-author v2：真实工程/真机遍历双驱动——控件必须来自真实数据；按库类别（动画/网络/组件/存储）适配验证手段；预期落具体动画、文本与 hilog 日志；生成后自审修订（真实可操作/逻辑合理/预期清晰）。',
          ],
        );
      } catch (e) {
        console.warn('[dsh-autotest] 内置 Prompt 升级跳过：', (e as Error).message);
      }
      // 种子：libraries 为空时灌入
      const row = await getDb().prepare('SELECT COUNT(*) AS n FROM libraries').get<{ n: number }>();
      if (!row || row.n === 0) {
        const { seed } = await import('./seed.js');
        await seed();
      }
      console.log('[dsh-autotest] 业务库就绪（MySQL）');
    })().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}
