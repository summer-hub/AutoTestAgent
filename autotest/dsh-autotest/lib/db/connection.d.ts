import Database from 'better-sqlite3';
export declare function dbPath(): string;
export declare function getDb(): Database.Database;
export declare function withRead<T>(fn: (db: Database.Database) => T): T;
export declare function now(): string;
/** 幂等建表；libraries 为空时自动灌入种子数据（开箱即用） */
export declare function ensureSchemaAndSeed(): void;
