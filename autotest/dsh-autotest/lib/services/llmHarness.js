import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { getSetting } from './settings.js';
import { ensureTaskTokenBudget } from './tokenBudget.js';
import { combineSignals, emitLlmTrace, readDshDefaultModel, } from './llmCore.js';
export * from './llmCore.js';
/**
 * 从 ctx.llm 构造一个非流式文本调用：
 *  - 优先使用「系统配置 → 默认模型」（若存在于 DSH 模型列表）
 *  - 未配置时跟随 DSH 实际默认模型（agent-default-model）
 *  - 都没有则用第一个可用模型
 * 重试会跨模型：首选失败后顺次切换到其他候选（最多 3 次），不再 3 次全打在同一个模型上；
 * 候选不足 3 个时绕回首选（退化为同模型重试）。任务取消信号触发时立即放弃，不重试。
 */
export function makeLlm(ctx) {
    return async (input) => {
        // 成本闸门：本次调用之前就先用光预算的任务直接失败，不再重试换模型烧额度
        await ensureTaskTokenBudget(input.meta?.taskId);
        const providers = ctx.llm.listProviders();
        if (!providers || providers.length === 0) {
            throw new Error('DSH 未注册任何模型提供方（如 dsh-llm-deepseek），请检查 profile 配置');
        }
        // 遍历所有 provider 的所有模型（包含 DSH 设置 → 模型 里添加的自定义模型 / 自定义 provider）
        const pairs = [];
        for (const p of providers) {
            try {
                const list = await ctx.llm.listModels(p.id);
                for (const m of list ?? [])
                    pairs.push({ provider: p.id, model: String(m.id) });
            }
            catch {
                /* 单个 provider 不可用（如未配置 Key）不阻塞其他 provider */
            }
        }
        const seen = new Set();
        const unique = pairs.filter((x) => {
            const k = `${x.provider}:${x.model}`;
            if (seen.has(k))
                return false;
            seen.add(k);
            return true;
        });
        if (unique.length === 0) {
            throw new Error('未配置可用模型：请在 DSH 设置（设置 → 模型）中配置模型后重试');
        }
        const defaultModel = String(getSetting('agent.defaultModel', '') || '').trim();
        const dshDefault = readDshDefaultModel();
        const preferred = defaultModel && unique.some((x) => x.model === defaultModel)
            ? unique.find((x) => x.model === defaultModel)
            : dshDefault && unique.some((x) => x.provider === dshDefault.provider && x.model === dshDefault.model)
                ? { provider: dshDefault.provider, model: dshDefault.model }
                : unique[0];
        const key = (x) => `${x.provider}:${x.model}`;
        // 重试顺序：首选打头，其余候选顺次跟上；不足 3 个时绕回首选（等价于同模型重试）
        const order = [preferred, ...unique.filter((x) => key(x) !== key(preferred))];
        const MAX_ATTEMPTS = 3;
        let lastErr = new Error('LLM 返回为空');
        const t0 = Date.now();
        let tokensIn = 0;
        let tokensOut = 0;
        const used = [];
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const target = order[attempt % order.length];
            used.push(target);
            try {
                const timeout = AbortSignal.timeout(input.timeoutMs ?? 60_000);
                const signal = input.signal ? combineSignals(input.signal, timeout) : timeout;
                console.log(`[dsh-autotest] llm call: provider=${target.provider} model=${target.model} attempt=${attempt + 1}/${MAX_ATTEMPTS}`);
                let text = '';
                for await (const chunk of ctx.llm.stream({
                    provider: target.provider,
                    model: target.model,
                    system: input.system,
                    messages: [createUserMessage({ content: [{ type: 'text', text: input.user }], source: { kind: 'user' } })],
                    temperature: input.temperature ?? 0.4,
                    maxTokens: input.maxTokens ?? 2048,
                    signal,
                })) {
                    if (chunk.type === 'text-delta')
                        text += chunk.text;
                    if (chunk.type === 'usage') {
                        tokensIn += chunk.usage.inputTokens ?? 0;
                        tokensOut += chunk.usage.outputTokens ?? 0;
                    }
                    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                        throw new Error(chunk.reason.failure?.message ?? 'LLM 调用失败');
                    }
                }
                if (text.trim()) {
                    const latencyMs = Date.now() - t0;
                    const toksIn = tokensIn || undefined;
                    const toksOut = tokensOut || undefined;
                    emitLlmTrace({
                        taskId: input.meta?.taskId,
                        spanId: input.meta?.spanId,
                        kind: input.meta?.kind ?? 'llm_call',
                        provider: target.provider,
                        model: target.model,
                        latencyMs,
                        attempts: attempt + 1,
                        tokensIn: toksIn,
                        tokensOut: toksOut,
                        promptChars: (input.system?.length ?? 0) + input.user.length,
                        outputChars: text.length,
                        status: 'ok',
                    });
                    return { text, provider: target.provider, model: target.model, latencyMs, attempts: attempt + 1, tokensIn: toksIn, tokensOut: toksOut, taskId: input.meta?.taskId, spanId: input.meta?.spanId, kind: input.meta?.kind };
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
        const last = used[used.length - 1];
        emitLlmTrace({
            taskId: input.meta?.taskId,
            spanId: input.meta?.spanId,
            kind: input.meta?.kind ?? 'llm_call',
            provider: last.provider,
            model: last.model,
            latencyMs: Date.now() - t0,
            attempts: used.length,
            tokensIn: tokensIn || undefined,
            tokensOut: tokensOut || undefined,
            promptChars: (input.system?.length ?? 0) + input.user.length,
            outputChars: 0,
            status: 'error',
            error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
        throw new Error(`模型 ${used.map(key).join(' / ')} 连续失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    };
}
