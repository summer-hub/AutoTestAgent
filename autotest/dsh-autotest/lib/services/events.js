// 链路追踪事件：追加式 agent_events 表（LLM 调用 / 遍历 op / dry-run 步骤）
//  - 全链 traceId/spanId 的地基：task_id 关联任务，span_id/parent_id 串父子
//  - 写失败不阻塞业务（fire-and-forget）
import { getDb, now } from '../db/connection.js';
import { setLlmTraceHook } from './llmHarness.js';
/** 写入一条事件（失败仅告警，不抛错）。 */
export async function appendEvent(e) {
    try {
        await getDb().prepare(`INSERT INTO agent_events (task_id, span_id, parent_id, kind, status, provider, model, tokens_in, tokens_out, latency_ms, prompt_chars, output_chars, detail, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.taskId ?? null, e.spanId ?? '', e.parentId ?? '', e.kind, e.status ?? 'ok', e.provider ?? '', e.model ?? '', e.tokensIn ?? null, e.tokensOut ?? null, e.latencyMs ?? null, e.promptChars ?? null, e.outputChars ?? null, e.detail ?? null, e.error ?? null, now());
    }
    catch (err) {
        console.warn('[dsh-autotest] agent_events 写入失败：', err.message);
    }
}
/** 安装 LLM 统一埋点（启动时调用一次；LLM 调用层自动写 agent_events）。 */
export function installLlmTracing() {
    setLlmTraceHook((e) => {
        void appendEvent({
            taskId: e.taskId ?? null,
            spanId: e.spanId ?? '',
            kind: e.kind,
            status: e.status,
            provider: e.provider,
            model: e.model,
            latencyMs: e.latencyMs,
            promptChars: e.promptChars,
            outputChars: e.outputChars,
            error: e.error,
        });
    });
    console.log('[dsh-autotest] LLM 埋点已启用（agent_events）');
}
/** 查询事件（观测用）。 */
export async function listEvents(opts = {}) {
    const conds = [];
    const p = { limit: Math.min(200, opts.limit ?? 50) };
    if (opts.taskId) {
        conds.push('task_id = @taskId');
        p.taskId = opts.taskId;
    }
    if (opts.kind) {
        conds.push('kind = @kind');
        p.kind = opts.kind;
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return getDb().prepare(`SELECT * FROM agent_events ${where} ORDER BY id DESC LIMIT @limit`).all(p);
}
