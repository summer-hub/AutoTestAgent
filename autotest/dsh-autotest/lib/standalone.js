// AutoTest 独立服务器（不依赖 DSH / DeepSeek Harness）：
//
//   node lib/standalone.js            # 或：npx tsx src/standalone.ts（免构建开发模式）
//
// 与 DSH 插件（index.ts）共用同一套业务代码（API / DB / 服务 / 调度），差别只在宿主：
//   - DSH 插件   ：挂 ctx.webServer，LLM 走 ctx.llm；
//   - 独立服务器 ：自带 node:http，LLM 直连系统配置里的 models 表（llmDirect）。
//
// 路由：
//   /api/autotest/*   业务 API（makeApiHandler，与插件完全一致）
//   /healthz          探活（不碰 DB，供 LB / 桌面端用）
//   /*                独立版前端 SPA（dist/web；AUTOTEST_WEB_DIR 可覆盖）
//
// 高并发相关：
//   - AUTOTEST_WORKERS=1|auto|N：多进程集群（默认 MySQL→auto、SQLite→1）；
//     调度器 / 归档 / 设备扫描 / 启动清理只在 worker 1 执行（与 exec.schedulerEnabled 语义一致）；
//     worker 异常退出会自动重启（1 分钟 10 次上限，超过则主进程退出交给进程管理器）。
//   - keep-alive / 超时调优；requestTimeout=0（AI 分析等接口合法运行数分钟）。
//   - 静态资源服务构建期 .gz 预压缩 + hashed 资产 immutable 缓存（见 build:standalone）。
//   - 数据库：MySQL 连接池 / SQLite 本地双引擎；多机部署接 Redis（限流与缓存跨节点共享）。
import http from 'node:http';
import cluster from 'node:cluster';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureReady, setDbUrlProvider, defaultUrlProvider, dbMode, mysqlPool } from './db/connection.js';
import { dataDir } from './db/sqlite.js';
import { makeApiHandler } from './api/http.js';
import { makeDirectLlm } from './services/llmDirect.js';
import { startScheduler, stopAllSchedulers } from './services/scheduler.js';
import { stopAllTaskLanes } from './services/taskLane.js';
import { makeStaticHandler } from './static.js';
import { migrateRepoSubpaths, reconcileRepos, workspaceNotice } from './services/gitRepo.js';
import { installLlmTracing } from './services/events.js';
import { reapOnStartup } from './services/reaper.js';
import { getSetting } from './services/settings.js';
// ---------- 环境变量 ----------
function envStr(key, def) {
    const v = String(process.env[key] ?? '').trim();
    return v || def;
}
function envInt(key, def) {
    const raw = String(process.env[key] ?? '').trim();
    if (!raw)
        return def;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : def;
}
/** 集群进程数决策（主进程 fork 前调用，此时 settings 尚未加载，用默认值 + SQLite 直读兜底）。 */
function resolveWorkerCount() {
    const cpus = Math.max(1, os.availableParallelism());
    const raw = envStr('AUTOTEST_WORKERS', '').toLowerCase();
    let n;
    if (raw === '' || raw === 'auto') {
        // 默认：MySQL 模式吃满多核；SQLite 单文件库多进程写会退化，保持单进程
        n = raw === 'auto' ? cpus : (detectDbMode() === 'mysql' ? cpus : 1);
    }
    else {
        const parsed = Number(raw);
        n = Number.isFinite(parsed) && parsed >= 1 ? Math.min(64, Math.trunc(parsed)) : cpus;
    }
    if (n > 1 && detectDbMode() === 'sqlite' && envStr('AUTOTEST_ALLOW_SQLITE_CLUSTER', '') !== '1') {
        console.warn('[autotest] SQLite 本地模式不默认开启多进程集群（WAL 下多进程写会串行退化），已按单进程启动；确有需要可设 AUTOTEST_ALLOW_SQLITE_CLUSTER=1');
        n = 1;
    }
    return n;
}
/**
 * 启动早期探测数据库引擎。
 * settings 表（db.mysqlUrl）要等 ensureReady 才加载，而主进程 fork 前就要决定进程数；
 * 环境变量 / .mysql-url 之外，再直读一次 SQLite 里的 db.mysqlUrl 设置，避免
 * 「用户在界面里配了 MySQL 却被判成 SQLite 而只起单进程」。
 */
function detectDbMode() {
    if (envStr('AUTOTEST_DB_MODE', '').toLowerCase() === 'sqlite')
        return 'sqlite';
    if (envStr('AUTOTEST_DB_MODE', '').toLowerCase() === 'mysql')
        return 'mysql';
    if (defaultUrlProvider().trim())
        return 'mysql';
    try {
        const file = path.join(dataDir(), 'autotest.sqlite3');
        if (!fs.existsSync(file))
            return 'sqlite';
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(`SELECT value FROM settings WHERE "key" = 'db.mysqlUrl'`).get();
            const url = row?.value ? String(JSON.parse(row.value) ?? '').trim() : '';
            return url ? 'mysql' : 'sqlite';
        }
        finally {
            db.close();
        }
    }
    catch {
        return 'sqlite';
    }
}
/** 独立版前端产物目录：AUTOTEST_WEB_DIR > 包根 dist/web（build:standalone 输出）。 */
function resolveWebDir() {
    const override = envStr('AUTOTEST_WEB_DIR', '');
    if (override)
        return path.resolve(override);
    return fileURLToPath(new URL('../dist/web/', import.meta.url));
}
// ---------- 优雅退出 ----------
let server = null;
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`[autotest] 收到 ${signal}，开始优雅退出…`);
    // 先停后台任务（abort 在跑的任务 lane、注销 cron / 轮询），再断 HTTP
    try {
        stopAllTaskLanes();
    }
    catch { /* ignore */ }
    try {
        stopAllSchedulers();
    }
    catch { /* ignore */ }
    const srv = server;
    if (srv) {
        srv.close(); // 不再接受新连接
        srv.closeIdleConnections(); // 立即释放空闲 keep-alive 连接
        // 在途请求（如 AI 分析）最多再等 30s，之后强制断开
        const forced = setTimeout(() => { try {
            srv.closeAllConnections();
        }
        catch { /* ignore */ } }, 30_000);
        forced.unref();
        await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (!done) {
                done = true;
                resolve();
            } };
            srv.close(() => finish());
            setTimeout(finish, 30_000).unref();
        });
        clearTimeout(forced);
    }
    if (dbMode() === 'mysql') {
        try {
            await mysqlPool().end();
        }
        catch { /* ignore */ }
    }
    console.log('[autotest] 已退出');
    process.exit(0);
}
// ---------- 工作进程 / 单进程：启动 + 监听 ----------
async function boot() {
    // 1. 数据源引导：MySQL 连接串（系统配置 db.mysqlUrl > 环境变量 > .mysql-url）→ 建表 / 种子 / 配置加载
    setDbUrlProvider(() => String(getSetting('db.mysqlUrl', '') || '').trim() || defaultUrlProvider());
    await ensureReady();
    // 2. 集群提示：多进程未接 Redis 时限流/缓存按进程生效（集群内上限 ≈ 配置值 × worker 数）
    const workers = resolveWorkerCount();
    if (workers > 1 && !(getSetting('data.redisCache', false) && String(getSetting('data.redisUrl', '')).trim())) {
        console.warn('[autotest] 多进程集群未配置 Redis（data.redisUrl + data.redisCache）：LLM 限流与缓存退化为进程内生效。建议接入 Redis 以跨节点共享。');
    }
    // 3. LLM 埋点（agent_events）
    installLlmTracing();
    // 4. 启动维护：仅 worker 1（单进程时就是本进程）执行，避免多进程重复迁移 / 重复清理
    const isPrimaryWorker = (cluster.worker?.id ?? 1) === 1;
    if (isPrimaryWorker) {
        try {
            const migrated = await migrateRepoSubpaths();
            if (migrated > 0)
                console.log(`[autotest] 启动迁移：${migrated} 个库的仓库地址已拆出子目录`);
        }
        catch (e) {
            console.warn('[autotest] 仓库地址拆分迁移失败：', e.message);
        }
        try {
            const changed = await reconcileRepos();
            if (changed > 0)
                console.log(`[autotest] 启动对账：${changed} 个库的同步状态已清空`);
        }
        catch (e) {
            console.warn('[autotest] 启动对账失败：', e.message);
        }
        const notice = workspaceNotice();
        if (notice)
            console.warn(`[autotest] ${notice}`);
        try {
            await reapOnStartup();
        }
        catch (e) {
            console.warn('[autotest] 启动清理失败：', e.message);
        }
    }
    // 5. HTTP 服务：API + 前端 SPA
    const llm = makeDirectLlm();
    const apiHandler = makeApiHandler(llm);
    const webDir = resolveWebDir();
    const webReady = fs.existsSync(path.join(webDir, 'index.html'));
    if (!webReady) {
        console.warn(`[autotest] 未找到独立版前端产物（${webDir}）：API 可正常使用，浏览器端请先执行 npm run build:standalone，或用 AUTOTEST_WEB_DIR 指定已有产物目录`);
    }
    const staticHandler = makeStaticHandler(webDir, { prefix: '', spa: true, gzip: true, immutable: true });
    server = http.createServer((req, res) => {
        try {
            const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
            // 探活：不碰 DB（LB / 桌面端等待就绪用）
            if (pathname === '/healthz' || pathname === '/healthz/') {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, service: 'autotest-standalone', pid: process.pid, time: new Date().toISOString() }));
                return;
            }
            if (pathname === '/api/autotest' || pathname.startsWith('/api/autotest/')) {
                void apiHandler(req, res).catch((e) => {
                    console.error('[autotest] API handler 未捕获异常：', e);
                    if (!res.headersSent)
                        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Internal Server Error', message: e.message }));
                });
                return;
            }
            staticHandler(req, res);
        }
        catch (e) {
            console.error('[autotest] 请求处理异常：', e);
            if (!res.headersSent)
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
        }
    });
    // 6. 连接与超时调优（高并发）
    server.keepAliveTimeout = 65_000; // 略大于常见反向代理的空闲超时，避免频繁重连
    server.headersTimeout = 70_000;
    server.requestTimeout = 0; // AI 分析等接口合法运行数分钟，不能按 Node 默认 300s 掐断
    server.maxRequestsPerSocket = 0; // 不限制单连接请求数（keep-alive 长连接）
    // 7. 监听（AUTOTEST_PORT=0 → 随机端口，并向 stdout 打印 AUTOTEST_LISTENING=<port>，桌面端据此导航）
    const host = envStr('AUTOTEST_HOST', '0.0.0.0');
    const port = envInt('AUTOTEST_PORT', 3280);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
    });
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[autotest] 独立服务器就绪：db=${dbMode()} pid=${process.pid} worker=${cluster.worker?.id ?? 1}/${workers} 数据目录=${dataDir()} 前端=${webReady ? webDir : '（缺失，仅 API）'}`);
    console.log(`[autotest] 监听 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}  API: /api/autotest  前端: /`);
    if (port === 0) {
        // 桌面端（desktop/src-tauri/src/main.rs）读取这一行拿到真实端口
        process.stdout.write(`AUTOTEST_LISTENING=${actualPort}\n`);
    }
    // 8. 调度器（定时计划 / 归档 / 统计预热 / 设备扫描 / 僵死清理）：仅 worker 1
    if (isPrimaryWorker) {
        try {
            await startScheduler();
        }
        catch (e) {
            console.error('[autotest] 调度器启动失败：', e.message);
        }
    }
    // 9. 信号与兜底
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => void shutdown(sig));
    }
    process.on('unhandledRejection', (reason) => {
        console.error('[autotest] 未处理的 Promise 拒绝：', reason);
    });
    process.on('uncaughtException', (err) => {
        // 不静默：记录后退出，集群主进程会重启 worker（带熔断），进程管理器亦可接管
        console.error('[autotest] 未捕获异常，进程退出：', err);
        process.exit(1);
    });
}
// ---------- 主进程：fork workers ----------
function runPrimary(workers) {
    console.log(`[autotest] 集群模式启动：${workers} 个 worker（CPU ${os.availableParallelism()} 核，db=${detectDbMode()}）；调度类任务仅在 worker 1 运行`);
    const budget = { count: 0, windowStart: Date.now() };
    const MAX_RESPAWN_PER_MIN = 10;
    for (let i = 0; i < workers; i++)
        cluster.fork();
    cluster.on('exit', (worker, code, signal) => {
        console.error(`[autotest] worker ${worker.process.pid} 退出（code=${code}, signal=${signal}）`);
        if (shuttingDown)
            return;
        const now = Date.now();
        if (now - budget.windowStart > 60_000) {
            budget.windowStart = now;
            budget.count = 0;
        }
        if (budget.count >= MAX_RESPAWN_PER_MIN) {
            console.error(`[autotest] worker 1 分钟内重启已达上限（${MAX_RESPAWN_PER_MIN}），主进程退出，交由进程管理器（pm2 / systemd / docker restart）处理`);
            process.exit(1);
        }
        budget.count += 1;
        console.log(`[autotest] 重启 worker（${budget.count}/${MAX_RESPAWN_PER_MIN} 次/分钟）`);
        cluster.fork();
    });
    const stopCluster = (signal) => {
        shuttingDown = true;
        const list = Object.values(cluster.workers ?? {}).filter((w) => !!w);
        console.log(`[autotest] 收到 ${signal}，通知 ${list.length} 个 worker 优雅退出…`);
        for (const w of list)
            w.kill('SIGTERM');
        const started = Date.now();
        const poll = setInterval(() => {
            const alive = Object.values(cluster.workers ?? {}).filter((w) => !!w);
            if (alive.length === 0 || Date.now() - started > 40_000) {
                clearInterval(poll);
                for (const w of alive)
                    w.process.kill('SIGKILL');
                console.log('[autotest] 集群已全部退出');
                process.exit(0);
            }
        }, 200);
        poll.unref();
    };
    process.on('SIGINT', () => stopCluster('SIGINT'));
    process.on('SIGTERM', () => stopCluster('SIGTERM'));
}
// ---------- 入口 ----------
const workers = resolveWorkerCount();
if (workers > 1 && cluster.isPrimary) {
    runPrimary(workers);
}
else {
    boot().catch((e) => {
        console.error('[autotest] 独立服务器启动失败：', e.message);
        process.exit(1);
    });
}
