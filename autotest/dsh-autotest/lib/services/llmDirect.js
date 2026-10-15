// LLM 集成（独立版）：不依赖 DSH，直连系统配置里维护的 models 表（OpenAI 兼容 /chat/completions）。
//
// 模型配置语义参考 publishhar-tool（https://gitcode.com/summor/publishhar-tool）的 [llm] 段，
// 对齐三件事：
//  ① 双协议：openai（POST {base_url}/chat/completions，Bearer）与
//     anthropic（POST {base_url}/v1/messages，x-api-key + anthropic-version），
//     覆盖 DeepSeek / 通义 / 智谱 / 本地 Ollama 与 Kimi Code / Anthropic 两类端点；
//  ② 环境变量优先：AUTOTEST_LLM_BASE_URL / MODEL / API_KEY / PROTOCOL 命中即置顶为一个
//     「env」来源候选，优先级高于 DB（等价 publishhar 的「环境变量 > toml」），
//     好处是 DB 一条模型都没配时也能立刻跑起来，且不用把密钥写进页面/数据库；
//  ③ 来源标注：每个候选都带 source（env / db），排查「为什么用了这个模型」时能一眼看出
//     配置来自哪里（对应 publishhar Env.sources 的 env/toml/auto/missing 思路）。
//
// 与 DSH 版（llmHarness.makeLlm）保持同一套语义，方便两条链路行为一致、可对照：
//  - 模型候选：env 覆盖 → 系统配置「默认模型」(agent.defaultModel) 命中 → is_default → 表中第一个；
//  - 重试跨模型：首选失败顺次切换候选（最多 3 次），不足 3 个绕回首选；
//  - 成本闸门：调用前 ensureTaskTokenBudget，超预算任务直接失败；
//  - 统一埋点：emitLlmTrace → events.ts 写 agent_events；
//  - 任务取消信号触发立即放弃，不重试。
import { getDb } from '../db/connection.js';
import { getSetting } from './settings.js';
import { ensureTaskTokenBudget } from './tokenBudget.js';
import { decryptSecret } from './crypto.js';
import { combineSignals, emitLlmTrace, } from './llmCore.js';
/** 读取 models 表候选（默认模型优先，其余按 id）。无表/无数据时返回空数组。 */
export async function listDirectModels() {
    try {
        const rows = await getDb().prepare('SELECT id, name, provider, base_url, model_id, api_key, protocol, is_default FROM models ORDER BY is_default DESC, id').all();
        return rows.map((r) => ({
            id: Number(r.id),
            name: String(r.name ?? ''),
            provider: String(r.provider ?? 'custom'),
            base_url: String(r.base_url ?? ''),
            model_id: String(r.model_id ?? ''),
            // api_key 落库是密文（crypto.ts 信封加密），取出即解密；旧明文原样透传
            api_key: decryptSecret(r.api_key),
            protocol: normalizeProtocol(r.protocol),
            is_default: Number(r.is_default ?? 0),
            source: 'db',
        }));
    }
    catch {
        return [];
    }
}
/** 协议归一化：非法值回落 openai（与 publishhar 对 protocol 的兜底一致）。 */
export function normalizeProtocol(raw) {
    return String(raw ?? '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}
/**
 * 环境变量覆盖（AUTOTEST_LLM_*，对应 publishhar 的 OHLIB_LLM_*）：
 * 只认「至少配了 baseUrl + model」这一组，其它情况视为未配置（返回 null），
 * 避免半个配置把候选列表搅乱。API Key 允许只走环境变量——页面不展示、不落库。
 */
export function readLlmEnvOverride() {
    const baseUrl = String(process.env.AUTOTEST_LLM_BASE_URL ?? '').trim();
    const modelId = String(process.env.AUTOTEST_LLM_MODEL ?? '').trim();
    if (!baseUrl || !modelId)
        return null;
    return {
        name: `env:${modelId}`,
        provider: String(process.env.AUTOTEST_LLM_PROVIDER ?? 'env').trim() || 'env',
        base_url: baseUrl,
        model_id: modelId,
        api_key: String(process.env.AUTOTEST_LLM_API_KEY ?? ''),
        protocol: normalizeProtocol(process.env.AUTOTEST_LLM_PROTOCOL),
        source: 'env',
    };
}
/** 候选顺序：env 覆盖打头 → agent.defaultModel 命中 → is_default → 第一个。 */
function orderCandidates(models) {
    if (models.length === 0)
        return [];
    const preferredName = String(getSetting('agent.defaultModel', '') || '').trim();
    const preferred = preferredName
        ? models.find((m) => m.model_id === preferredName || m.name === preferredName)
        : undefined;
    const head = preferred ?? models.find((m) => m.is_default === 1) ?? models[0];
    return [head, ...models.filter((m) => m.id !== head.id)];
}
/** openai 兼容协议：POST {base_url}/chat/completions */
async function callOpenAi(m, input, signal) {
    const url = m.base_url.replace(/\/+$/, '') + '/chat/completions';
    const messages = [];
    if (input.system)
        messages.push({ role: 'system', content: input.system });
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
    const data = (await res.json());
    return data.choices?.[0]?.message?.content ?? '';
}
/** anthropic 兼容协议：POST {base_url}/v1/messages（x-api-key + anthropic-version）。 */
async function callAnthropic(m, input, signal) {
    const base = m.base_url.replace(/\/+$/, '');
    const url = base.endsWith('/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': m.api_key,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: m.model_id,
            system: input.system ?? '',
            messages: [{ role: 'user', content: input.user }],
            max_tokens: input.maxTokens ?? 2048,
            temperature: input.temperature ?? 0.4,
        }),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json());
    return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}
/** 直连 models 表构造非流式 LLM 调用（OpenAI / Anthropic 双协议）。 */
export function makeDirectLlm() {
    return async (input) => {
        // 成本闸门：与 DSH 版一致——已用光预算的任务直接失败，不重试换模型烧额度
        await ensureTaskTokenBudget(input.meta?.taskId);
        const envOverride = readLlmEnvOverride();
        const dbModels = await listDirectModels();
        // env 覆盖没有自增 id，用 0 占位；orderCandidates 靠 id 去重，不能与任何表行撞号
        const order = envOverride
            ? [{ ...envOverride, id: 0, is_default: 1 }, ...dbModels]
            : orderCandidates(dbModels);
        if (order.length === 0) {
            throw new Error('未配置可用模型：请在「系统配置 → 模型」中添加模型（baseUrl / modelId / API Key）后重试，或设置 AUTOTEST_LLM_BASE_URL / AUTOTEST_LLM_MODEL 环境变量');
        }
        const MAX_ATTEMPTS = 3;
        const t0 = Date.now();
        const used = [];
        let lastErr = new Error('LLM 返回为空');
        let tokensIn = 0;
        let tokensOut = 0;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const m = order[attempt % order.length];
            used.push(`${m.name}(${m.model_id})`);
            try {
                const timeout = AbortSignal.timeout(input.timeoutMs ?? 120_000);
                const signal = input.signal ? combineSignals(input.signal, timeout) : timeout;
                const text = m.protocol === 'anthropic'
                    ? await callAnthropic(m, input, signal)
                    : await callOpenAi(m, input, signal);
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
            }
            catch (e) {
                // 任务取消（lane AbortController）：不重试，直接向上抛，让执行器走取消收尾
                if (input.signal?.aborted)
                    throw e;
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
