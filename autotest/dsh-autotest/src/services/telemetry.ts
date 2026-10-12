// 统一埋点安装（P0-3）：LLM 调用 → 指标计数器。
// 与 events.ts 的 agent_events 链路追踪**并存**（llmCore 支持多消费者，互不覆盖）。
// index.ts（DSH 插件）与 standalone.ts（独立服务器）启动时与 installLlmTracing() 并列调用。
import { addLlmTraceHook, type LlmTraceEvent } from './llmCore.js';
import { llmCalls, llmTokens } from './metrics.js';

export function installTelemetry(): void {
  addLlmTraceHook((e: LlmTraceEvent) => {
    llmCalls.inc({ provider: e.provider || 'unknown', model: e.model || 'unknown', status: e.status });
    if (e.tokensIn) llmTokens.inc({ kind: 'in' }, e.tokensIn);
    if (e.tokensOut) llmTokens.inc({ kind: 'out' }, e.tokensOut);
  });
  console.log('[dsh-autotest] 指标埋点已启用（GET /api/autotest/metrics 查看）');
}
