import mysql from 'mysql2/promise';
/** 连接串引导：环境变量 → data/.mysql-url（迁移脚本写入）→ '' */
export declare function defaultUrlProvider(): string;
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
/** 事务：从池取连接，BEGIN/COMMIT/ROLLBACK。 */
export declare function transaction<T>(fn: () => Promise<T>): Promise<T>;
/** 读路径（MySQL 连接池天然并发，直接走 facade）。 */
export declare function withRead<T>(fn: (db: DbFacade) => Promise<T>): Promise<T>;
/** 建表 + settings 加载 + 种子（幂等，首次请求前完成）。 */
export declare function ensureReady(): Promise<void>;
