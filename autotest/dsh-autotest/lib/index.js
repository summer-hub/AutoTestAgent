import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultUrlProvider, ensureReady, setDbUrlProvider } from './db/connection.js';
import { makeLlm } from './services/llmHarness.js';
import { makeApiHandler } from './api/http.js';
import { startScheduler } from './services/scheduler.js';
import { makeStaticHandler } from './static.js';
import { reconcileRepos } from './services/gitRepo.js';
import { installLlmTracing } from './services/events.js';
import { ensureAuthSchema, authDb } from './auth/db.js';
import { createUser } from './auth/service.js';
import { getSetting } from './services/settings.js';
export const name = 'dsh-autotest';
export const inject = ['webServer', 'llm'];
export function apply(ctx) {
    // 1. 初始化引导（异步）：MySQL 连接串 → 业务表 + settings → 对账 → auth 表 + admin
    void (async () => {
        try {
            setDbUrlProvider(() => String(getSetting('db.mysqlUrl', '') || '').trim() || defaultUrlProvider());
            await ensureReady();
            installLlmTracing();
            // 启动对账：本地没有克隆目录的库，同步状态一律清空（迁移/拷贝旧库后不再显示过期记录）
            const changed = await reconcileRepos();
            if (changed > 0)
                console.log(`[dsh-autotest] 启动对账：${changed} 个库的同步状态已清空`);
            console.log('[dsh-autotest] 业务库对账完成');
            // 定时执行计划调度（依赖业务表，须在初始化后注册）
            try {
                await startScheduler();
            }
            catch (e) {
                console.error('[dsh-autotest] 调度器启动失败：', e.message);
            }
            // 认证库初始化（跟随业务库引擎：MySQL 或 SQLite 本地降级）：建表 + 角色权限种子 + 首启创建 admin
            await ensureAuthSchema();
            const adb = await authDb();
            const [uRows] = await adb.query('SELECT COUNT(*) AS n FROM auth_users');
            if (uRows[0].n === 0) {
                const pw = String(getSetting('auth.bootstrapPassword', '') || '').trim()
                    || crypto.randomBytes(6).toString('base64url');
                await createUser('admin', pw, ['admin']);
                console.log('[dsh-autotest] 已创建初始管理员：admin / ' + pw + '（请尽快登录后修改密码）');
            }
            else {
                console.log('[dsh-autotest] 认证库就绪（用户已存在）');
            }
        }
        catch (e) {
            console.error('[dsh-autotest] 初始化失败：', e.message);
        }
    })();
    // 2. LLM 调用（复用 DSH 模型配置）
    const llm = makeLlm(ctx);
    // 3. 业务 API（挂在 DSH Web 服务器的 /api/autotest 前缀下；插件卸载时自动注销）
    ctx.effect(() => {
        const apiHandler = makeApiHandler(llm);
        const disposeRoute = ctx.webServer.register({
            kind: 'prefix',
            path: '/api/autotest',
            handler: apiHandler,
        });
        // 3b. 嵌入版前端静态资源（/autotest-web/*，指向 lib/web；目录缺失时仅告警）
        let disposeWeb = () => { };
        // lib/index.js → ./web/ 即 lib/web（嵌入版前端产物）；src 下运行无此目录时仅 404
        const webDir = fileURLToPath(new URL('./web/', import.meta.url));
        try {
            disposeWeb = ctx.webServer.register({
                kind: 'prefix',
                path: '/autotest-web',
                handler: makeStaticHandler(webDir),
            });
        }
        catch (e) {
            console.warn('[dsh-autotest] 静态资源挂载失败（/autotest-web）：', e.message);
        }
        console.log('[dsh-autotest] 插件已激活：/api/autotest + /autotest-web（用例库/任务/执行计划/设备）');
        return () => {
            disposeRoute();
            disposeWeb();
            console.log('[dsh-autotest] 插件已卸载');
        };
    });
}
