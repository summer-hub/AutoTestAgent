import Database from 'better-sqlite3';
/** 数据目录：环境变量 AUTOTEST_DATA_DIR > 插件根/data */
export declare function dataDir(): string;
export declare function sqlite(): Database.Database;
