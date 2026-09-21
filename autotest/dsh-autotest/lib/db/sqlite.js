// SQLite 轻量引擎（better-sqlite3）：无 MySQL 环境的本地降级数据源。
//  - 单文件库 <数据目录>/autotest.sqlite3（AUTOTEST_DATA_DIR 可覆盖）
//  - 数据目录默认落在**安装根/autotest-data**：node_modules 会被 pnpm install / 升级 / 重装
//    整体删掉，业务库放在插件包内等于把生产数据放在临时目录里（曾真实丢过库）。
//    首次启动会自动把旧版 <插件包>/data 整体搬过去，升级用户的数据无声续用。
//  - 同步 API，facade 层保持 async 形态；WAL 模式提升并发读写
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 插件包根目录（本文件位于 <包根>/lib/db 下）。 */
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
/** 旧版默认数据目录：就在插件包内，pnpm 重装/升级会连库一起删掉。 */
const LEGACY_DATA_DIR = path.join(PLUGIN_ROOT, 'data');
const DB_FILE = 'autotest.sqlite3';
/** DSH 宿主目录（与 llmHarness 读 ~/.dsh/settings.yaml 同一套 DSH_HOME 约定）。 */
function dshHome() {
    return String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
}
/**
 * 默认数据目录 = <安装根>/autotest-data。
 *
 * 安装根取「最外层 node_modules 的父目录」：pnpm 的 .pnpm 虚拟store 会把真实包埋成
 * `.../node_modules/.pnpm/<pkg>@ver/node_modules/<pkg>`，只往上找一层会算回到 node_modules
 * 里面去（版本一升级数据就孤立），所以必须扫到最外层那一级 node_modules。
 * 扫不到 node_modules 祖先时（本地 checkout / 解压即用）退回 $DSH_HOME/autotest/data。
 */
function defaultDataDir() {
    let dir = __dirname;
    let installRoot = '';
    for (let i = 0; i < 32; i++) {
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        if (path.basename(parent) === 'node_modules')
            installRoot = path.dirname(parent);
        dir = parent;
    }
    return installRoot ? path.join(installRoot, 'autotest-data') : path.join(dshHome(), 'autotest', 'data');
}
let resolvedDir = null;
/**
 * 把旧版落在插件包内的数据目录整体搬到新位置（进程内只做一次），返回真正该用的目录。
 *
 * 升级用户的数据必须无声续用——不搬就等于升级即丢库。三种不安全场景都**退回旧目录**：
 *  - 旧库被别的进程占着（checkpoint 失败）：硬搬会拿到撕裂的副本，这次不搬，下次干净启动再搬；
 *  - 新位置不可写 / 拷贝失败；
 *  - 拷贝完发现新位置没有库文件。
 * 核心原则：**绝不能因为一次搬家就拿空库启动**。
 */
function adoptLegacyData(target) {
    if (!fs.existsSync(path.join(LEGACY_DATA_DIR, DB_FILE)))
        return target;
    if (fs.existsSync(path.join(target, DB_FILE)))
        return target; // 已经搬过
    try {
        // 先把 WAL 里已提交的帧并回主库，否则只拷主库会丢掉最近一批写入
        const legacy = new Database(path.join(LEGACY_DATA_DIR, DB_FILE));
        legacy.pragma('wal_checkpoint(TRUNCATE)');
        legacy.close();
    }
    catch (err) {
        console.error(`[dsh-autotest] 旧数据目录 ${LEGACY_DATA_DIR} 当前无法安全读取，本次不迁移：`, err);
        return LEGACY_DATA_DIR;
    }
    try {
        fs.mkdirSync(target, { recursive: true });
        // 整个目录的文件都搬：库里不止 sqlite3，还有 .mysql-url 引导文件和三方库测试表.xlsx
        for (const name of fs.readdirSync(LEGACY_DATA_DIR)) {
            const from = path.join(LEGACY_DATA_DIR, name);
            if (fs.statSync(from).isFile())
                fs.copyFileSync(from, path.join(target, name));
        }
        if (!fs.existsSync(path.join(target, DB_FILE)))
            throw new Error('副本里没有库文件');
        try {
            fs.renameSync(LEGACY_DATA_DIR, `${LEGACY_DATA_DIR}.migrated-${Date.now()}`);
        }
        catch { /* 并发启动时另一个进程已经搬走，忽略 */ }
        console.warn(`[dsh-autotest] 数据目录已迁出插件包：${LEGACY_DATA_DIR} → ${target}（旧目录已改名留底）`);
        return target;
    }
    catch (err) {
        if (fs.existsSync(path.join(target, DB_FILE)))
            return target;
        console.error(`[dsh-autotest] 数据目录迁移失败（${LEGACY_DATA_DIR} → ${target}），继续使用旧目录：`, err);
        return LEGACY_DATA_DIR;
    }
}
/**
 * 数据目录：决定 autotest.sqlite3 / .mysql-url / 三方库测试表.xlsx 的落点。
 * 优先级：`AUTOTEST_DATA_DIR` 环境变量 > 安装根/autotest-data（含旧数据自动迁移）。
 *
 * 环境变量优先是给**自检与 CI** 用的：自检必须能在临时目录里跑，绝不能碰使用者真实数据，
 * 所以显式覆盖时**不触发迁移**（否则会把使用者真库拖进临时目录）。
 */
export function dataDir() {
    if (resolvedDir)
        return resolvedDir;
    const override = String(process.env.AUTOTEST_DATA_DIR || '').trim();
    const dir = override ? override : adoptLegacyData(defaultDataDir());
    fs.mkdirSync(dir, { recursive: true });
    resolvedDir = dir;
    return dir;
}
let db = null;
export function sqlite() {
    if (!db) {
        const file = path.join(dataDir(), DB_FILE);
        db = new Database(file);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = OFF');
        db.pragma('busy_timeout = 5000');
    }
    return db;
}
