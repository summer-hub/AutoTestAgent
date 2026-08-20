// dsh-autotest — DeepSeek Harness 服务端插件
// 加载进 profile 后：
//  - 自动初始化业务库（建表 + 种子，开箱即用）
//  - 通过 ctx.webServer 暴露 /api/autotest/* 业务 API
//  - AI 任务经 ctx.llm（模型配置全部来自 DSH 设置）
//  - 定时计划经内置 node-cron 调度
import { Context } from '@deepseek-ai/cordis';
// 引入类型声明：把 webServer 挂到 Context（dsh-host-webserver 的 declare module）
import type WebServer from '@deepseek-ai/dsh-host-webserver';
import { fileURLToPath } from 'node:url';
import { ensureSchemaAndSeed } from './db/connection.js';
import { makeLlm } from './services/llmHarness.js';
import { makeApiHandler } from './api/http.js';
import { startScheduler } from './services/scheduler.js';
import { makeStaticHandler } from './static.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer;
  }
}

export const name = 'dsh-autotest';
export const inject = ['webServer', 'llm'] as const;

export function apply(ctx: Context): void {
  // 1. 业务库初始化（幂等 + 首次自动种子）
  try {
    ensureSchemaAndSeed();
    console.log('[dsh-autotest] 业务库就绪');
  } catch (e) {
    console.error('[dsh-autotest] 业务库初始化失败：', (e as Error).message);
  }

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

  // 4. 定时执行计划调度
  try {
    startScheduler();
  } catch (e) {
    console.error('[dsh-autotest] 调度器启动失败：', (e as Error).message);
  }
}
