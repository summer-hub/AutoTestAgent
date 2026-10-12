// LLM 集成（独立版）：不依赖 DSH，直连系统配置里维护的 models 表（OpenAI 兼容 /chat/completions）。
//
// 与 DSH 版（llmHarness.makeLlm）保持同一套语义，方便两条链路行为一致、可对照：
//  - 模型候选：系统配置「默认模型」(agent.defaultModel) 命中 → is_default → 表中第一个；
//  - 重试跨模型：首选失败顺次切换候选（最多 3 次），不足 3 个绕回首选；
//  - 成本闸门：调用前 ensureTaskTokenBudget，超预算任务直接失败；
//  - 统一埋点：emitLlmTrace → events.ts 写 agent_events；
//  - 任务取消信号触发立即放弃，不重试。
import { getDb } from '../db/connection.js';
import { getSetting } from './settings.js';
import { ensureTaskTokenBudget } from './tokenBudget.js';
import {
  combineSignals, emitLlmTrace,
  type LlmCall, type LlmResult, type LlmTextInput,
} from './llmCore.js';

interface ModelRow {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  model_id: string;
  api_key: string;
  is_default: number;
}

export interface DirectModelInfo {
  id: number;
  name: string;
  provider: string;
  baseUrl: string;
  modelId: string;
  hasApiKey: boolean;
  isDefault: boolean;
}

/** 读取 models 表候选（默认模型优先，其余按 id）。无表/无数据时返回空数组。 */
export async function listDirectModels(): Promise<ModelRow[]> {
  try {
    const rows = await getDb().prepare('SELECT id, name, provider, base_url, model_id, api_key, is_default FROM models ORDER BY is_default DESC, id').all<Record<string, unknown>>();
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      provider: String(r.provider ?? 'custom'),
      base_url: String(r.base_url ?? ''),
      model_id: String(r.model_id ?? ''),
      api_key: String(r.api_key ?? ''),
      is_default: Number(r.is_default ?? 0),
    }));
  } catch {
    return [];
  }
}

/** 候选顺序：agent.defaultModel 命中 → is_default → 第一个。 */
function orderCandidates(models: ModelRow[]): ModelRow[] {
  if (models.length === 0) return [];
  const preferredName = String(getSetting('agent.defaultModel', '') || '').trim();
  const preferred = preferredName
    ? models.find((m) => m.model_id === preferredName || m.name === preferredName)
    : undefined;
  const head = preferred ?? models.find((m) => m.is_default === 1) ?? models[0];
  return [head, ...models.filter((m) => m.id !== head.id)];
}

/** 直连 models 表构造非流式 LLM 调用（OpenAI 兼容协议）。 */
export function makeDirectLlm(): LlmCall {
  return async (input: LlmTextInput): Promise<LlmResult> => {
    // 成本闸门：与 DSH 版一致——已用光预算的任务直接失败，不重试换模型烧额度
    await ensureTaskTokenBudget(input.meta?.taskId);
    const models = await listDirectModels();
    if (models.length === 0) {
      throw new Error('未配置可用模型：请在「系统配置 → 自定义模型」中添加模型（baseUrl / modelId / API Key）后重试');
    }
    const order = orderCandidates(models);
    const MAX_ATTEMPTS = 3;
    const t0 = Date.now();
    const used: string[] = [];
    let lastErr: unknown = new Error('LLM 返回为空');
    let tokensIn = 0;
    let tokensOut = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const m = order[attempt % order.length];
      used.push(`${m.name}(${m.model_id})`);
      try {
        const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000);
        const signal = input.signal ? combineSignals(input.signal, timeout) : timeout;
        const url = m.base_url.replace(/\/+$/, '') + '/chat/completions';
        const messages: Array<{ role: string; content: string }> = [];
        if (input.system) messages.push({ role: 'system', content: input.system });
        messages.push({ role: 'user', content: input.user });
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(m.api_key ? { Authorization: `Bearer ${m.api_key}` } : {}),
          },
          body: JSON.stringify({
            model: m.model_id,
            messages,
            temperature: input.temperature ?? 0.4,
            max_tokens: input.maxTokens ?? 2048,
          }),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`LLM ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content ?? '';
        tokensIn += data.usage?.prompt_tokens ?? 0;
        tokensOut += data.usage?.completion_tokens ?? 0;
        if (text.trim()) {
          const latencyMs = Date.now() - t0;
          const toksIn = tokensIn || undefined;
          const toksOut = tokensOut || undefined;
          emitLlmTrace({
            taskId: input.meta?.taskId,
            spanId: input.meta?.spanId,
            kind: input.meta?.kind ?? 'llm_call',
            provider: m.provider,
            model: m.model_id,
            latencyMs,
            attempts: attempt + 1,
            tokensIn: toksIn,
            tokensOut: toksOut,
            promptChars: (input.system?.length ?? 0) + input.user.length,
            outputChars: text.length,
            status: 'ok',
          });
          return { text, provider: m.provider, model: m.model_id, latencyMs, attempts: attempt + 1, tokensIn: toksIn, tokensOut: toksOut, taskId: input.meta?.taskId, spanId: input.meta?.spanId, kind: input.meta?.kind };
        }
        lastErr = new Error('LLM 返回为空');
      } catch (e) {
        // 任务取消（lane AbortController）：不重试，直接向上抛，让执行器走取消收尾
        if (input.signal?.aborted) throw e;
        lastErr = e;
      }
    }
    emitLlmTrace({
      taskId: input.meta?.taskId,
      spanId: input.meta?.spanId,
      kind: input.meta?.kind ?? 'llm_call',
      provider: 'direct',
      model: used[used.length - 1] ?? 'none',
      latencyMs: Date.now() - t0,
      attempts: used.length,
      tokensIn: tokensIn || undefined,
      tokensOut: tokensOut || undefined,
      promptChars: (input.system?.length ?? 0) + input.user.length,
      outputChars: 0,
      status: 'error',
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    throw new Error(`模型 ${used.join(' / ')} 连续失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };
}
