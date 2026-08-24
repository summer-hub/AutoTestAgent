// dsh-autotest — DeepSeek Harness 服务端插件
// 加载进 profile 后：
//  - 自动初始化业务库（建表 + 种子，开箱即用）
//  - 通过 ctx.webServer 暴露 /api/autotest/* 业务 API
//  - AI 任务经 ctx.llm（模型配置全部来自 DSH 设置）
//  - 定时计划经内置 node-cron 调度
import { Context } from '@deepseek-ai/cordis';
import crypto from 'node:crypto';
import fs from 'node:fs';
// 引入类型声明：把 webServer 挂到 Context（dsh-host-webserver 的 declare module）
import type WebServer from '@deepseek-ai/dsh-host-webserver';
import { fileURLToPath } from 'node:url';
import { defaultUrlProvider, ensureReady, getDb, setDbUrlProvider } from './db/connection.js';
import { makeLlm } from './services/llmHarness.js';
import { makeApiHandler } from './api/http.js';
import { startScheduler } from './services/scheduler.js';
import { makeStaticHandler } from './static.js';
import { refreshPackageInfo, repoDirFor } from './services/gitRepo.js';
import { ensureAuthSchema, authPool } from './auth/db.js';
import { createUser } from './auth/service.js';
import { getSetting } from './services/settings.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer;
  }
}

export const name = 'dsh-autotest';
export const inject = ['webServer', 'llm'] as const;

export function apply(ctx: Context): void {
  // 1. 初始化引导（异步）：MySQL 连接串 → 业务表 + settings → 对账 → auth 表 + admin
  void (async () => {
    try {
      setDbUrlProvider(() => String(getSetting('db.mysqlUrl', '') || '').trim() || defaultUrlProvider());
      await ensureReady();
      // 启动对账：本地没有克隆目录的库，同步状态一律清空（迁移/拷贝旧库后不再显示过期记录）
      const db = getDb();
      const libs = await db.prepare('SELECT id, name, package_name FROM libraries').all<{ id: number; name: string; package_name: string }>();
      for (const lib of libs) {
        if (!fs.existsSync(`${repoDirFor(lib.name)}/.git`)) {
          await db.prepare(`UPDATE libraries SET last_commit = '', last_synced_at = NULL WHERE id = ? AND (last_commit != '' OR last_synced_at IS NOT NULL)`).run(lib.id);
        } else if (!lib.package_name) {
          // 本地有 clone 但没解析过包名 → 从 app.json5/module.json5 解析回填
          const info = await refreshPackageInfo(lib);
          if (info.packageName) console.log(`[dsh-autotest] 已解析包名：${lib.name} → ${info.packageName}`);
        }
      }
      console.log('[dsh-autotest] 业务库对账完成');
      // 定时执行计划调度（依赖业务表，须在初始化后注册）
      try {
        await startScheduler();
      } catch (e) {
        console.error('[dsh-autotest] 调度器启动失败：', (e as Error).message);
      }
      // 认证库初始化（MySQL）：建表 + 角色权限种子 + 首启创建 admin
      await ensureAuthSchema();
      const db2 = await authPool();
      const [rows] = await db2.query('SELECT COUNT(*) AS n FROM auth_users') as [Array<{ n: number }>, unknown];
      if (rows[0].n === 0) {
        const pw = String(getSetting('auth.bootstrapPassword', '') || '').trim()
          || crypto.randomBytes(6).toString('base64url');
        await createUser('admin', pw, ['admin']);
        console.log('[dsh-autotest] 已创建初始管理员：admin / ' + pw + '（请尽快登录后修改密码）');
      } else {
        console.log('[dsh-autotest] 认证库就绪（用户已存在）');
      }
    } catch (e) {
      console.error('[dsh-autotest] 初始化失败：', (e as Error).message);
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
    let disposeWeb = () => {};
    // lib/index.js → ./web/ 即 lib/web（嵌入版前端产物）；src 下运行无此目录时仅 404
    const webDir = fileURLToPath(new URL('./web/', import.meta.url));
    try {
      disposeWeb = ctx.webServer.register({
        kind: 'prefix',
        path: '/autotest-web',
        handler: makeStaticHandler(webDir),
      });
    } catch (e) {
      console.warn('[dsh-autotest] 静态资源挂载失败（/autotest-web）：', (e as Error).message);
    }

    console.log('[dsh-autotest] 插件已激活：/api/autotest + /autotest-web（用例库/任务/执行计划/设备）');
    return () => {
      disposeRoute();
      disposeWeb();
      console.log('[dsh-autotest] 插件已卸载');
    };
  });

}
