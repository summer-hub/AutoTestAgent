import mysql from 'mysql2/promise';
/** 连接串引导：环境变量 → 数据目录/.mysql-url（迁移脚本写入）→ '' */
export declare function defaultUrlProvider(): string;
/** 当前数据库引擎：mysql（默认）| sqlite（未配置连接时本地降级）。ensureReady 后锁定。 */
export declare function dbMode(): 'mysql' | 'sqlite';
/** 注入 MySQL 连接串提供者（index.ts 从 settings 缓存注入）。 */
export declare function setDbUrlProvider(fn: () => string): void;
export declare function mysqlPool(): mysql.Pool;
export declare function now(): string;
export interface RunResult {
    changes: number;
    lastInsertRowid: number;
}
export interface Statement {
    get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
    all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
    run(...params: unknown[]): Promise<RunResult>;
}
export declare function prepare(sql: string): Statement;
export interface DbFacade {
    prepare(sql: string): Statement;
    exec(sql: string): Promise<void>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
}
export declare function getDb(): DbFacade;
/** 执行多语句（按分号拆分，供 DDL / 迁移用）。 */
export declare function exec(sql: string): Promise<void>;
/**
 * 事务：MySQL 从池取连接；SQLite 走「互斥锁 + BEGIN/COMMIT」（见文件顶部 sqliteTxStore 说明）。
 * 嵌套调用语义：并入外层事务（内层不单独提交/回滚），避免 SQLite 自我死锁与 MySQL 连接池耗尽。
 */
export declare function transaction<T>(fn: () => Promise<T>): Promise<T>;
/** 读路径（连接池/单文件库天然并发，直接走 facade）。 */
export declare function withRead<T>(fn: (db: DbFacade) => Promise<T>): Promise<T>;
/**
 * demo 侧的三个技能绑定（内置 Prompt，供「提示词管理」查看/调整，也可被 agent_bindings 覆盖）。
 *
 * 它们组成一条链，把"规划场景 → 量化 demo 覆盖 → 补 demo 代码"接起来：
 *   demo 解析   ← ohos-demo-scenario-generator（接口规格 → 正/反向场景清单）
 *   覆盖矩阵    ← ohos-demo-coverage-analyzer（场景文档 × entry 代码 → 覆盖率与盲区）
 *   demo 补丁   ← ohos-demo-code-generator（场景描述 → 可编译运行的 ArkTS demo 代码）
 *
 * 说明：平台自己的 demo 资产扫描/矩阵装配是**确定性代码**（不调模型），
 * 这三个绑定主要作用于 agent 驱动的路径（人/AI 按技能做 demo 规划与补齐），
 * 以及被 agent_bindings 覆盖时作为基准 —— 不要把它们当成"平台会自动执行"。
 */
export declare const DEMO_STAGE_PROMPTS: Array<{
    name: string;
    role: string;
    content: string;
    skill: string;
}>;
/** 建表 + settings 加载 + 种子（幂等，首次请求前完成）。 */
export declare function ensureReady(): Promise<void>;
