import Database from 'better-sqlite3';
/**
 * 数据目录：决定 autotest.sqlite3 / .mysql-url / 三方库测试表.xlsx 的落点。
 * 优先级：`AUTOTEST_DATA_DIR` 环境变量 > 安装根/autotest-data（含旧数据自动迁移）。
 *
 * 环境变量优先是给**自检与 CI** 用的：自检必须能在临时目录里跑，绝不能碰使用者真实数据，
 * 所以显式覆盖时**不触发迁移**（否则会把使用者真库拖进临时目录）。
 */
export declare function dataDir(): string;
export declare function sqlite(): Database.Database;
