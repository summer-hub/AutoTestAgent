// dsh-autotest — DeepSeek Harness 服务端插件
// 加载进 profile 后：
//  - 自动初始化业务库（建表 + 种子，开箱即用）
//  - 通过 ctx.webServer 暴露 /api/autotest/* 业务 API
//  - AI 任务经 ctx.llm（模型配置全部来自 DSH 设置）
//  - 定时计划经内置 node-cron 调度
import { Context } from '@deepseek-ai/cordis';
import fs from 'node:fs';
// 引入类型声明：把 webServer 挂到 Context（dsh-host-webserver 的 declare module）
import type WebServer from '@deepseek-ai/dsh-host-webserver';
import { fileURLToPath } from 'node:url';
import { defaultUrlProvider, ensureReady, getDb, setDbUrlProvider } from './db/connection.js';
import { makeLlm } from './services/llmHarness.js';
import { makeApiHandler } from './api/http.js';
import { startScheduler, stopAllSchedulers } from './services/scheduler.js';
import { makeStaticHandler } from './static.js';
import { refreshPackageInfo, reconcileRepos, repoDirFor, workspaceNotice } from './services/gitRepo.js';
import { installLlmTracing } from './services/events.js';
import { reapOnStartup } from './services/reaper.js';
import { getSetting } from './services/settings.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer;
  }
}

export const name = 'dsh-autotest';
export const inject = ['webServer', 'llm'] as const;

export function apply(ctx: Context): void {
  // 1. 初始化引导（异步）：MySQL 连接串 → 业务表 + settings → 对账
  void (async () => {
    try {
      setDbUrlProvider(() => String(getSetting('db.mysqlUrl', '') || '').trim() || defaultUrlProvider());
      await ensureReady();
      installLlmTracing();
      // 启动对账：本地没有克隆目录的库，同步状态一律清空（迁移/拷贝旧库后不再显示过期记录）
      const changed = await reconcileRepos();
      if (changed > 0) console.log(`[dsh-autotest] 启动对账：${changed} 个库的同步状态已清空`);
      console.log('[dsh-autotest] 业务库对账完成');
      // 工作区体检：未配置 / 沿用旧种子默认值时在日志里说清楚（不替使用者改数据）
      const wsNotice = workspaceNotice();
      if (wsNotice) console.warn(`[dsh-autotest] ${wsNotice}`);
      // 启动清理：上一次进程遗留的 running 任务/计划标记为中断，避免前端永久转圈
      try {
        await reapOnStartup();
      } catch (e) {
        console.warn('[dsh-autotest] 启动清理失败：', (e as Error).message);
      }
      // 定时执行计划调度（依赖业务表，须在初始化后注册）
      try {
        await startScheduler();
      } catch (e) {
        console.error('[dsh-autotest] 调度器启动失败：', (e as Error).message);
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
      // 定时计划 / 每日归档 / 每分钟预热 / 设备轮询都必须停掉：
      // 不清理的话插件每次重载都会叠加一份后台任务（cron 与 interval 都是进程级句柄）
      stopAllSchedulers();
      console.log('[dsh-autotest] 插件已卸载');
    };
  });

}
