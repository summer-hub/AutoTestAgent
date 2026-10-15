import type { LlmCall } from '../llmCore.js';
export interface L2Options {
    /** 指定库 id；缺省取所有 needs_llm=1 的库 */
    ids?: number[];
    /** 单次最多处理几个（默认 20：L2 单库成本高，一次跑太久会占满限流配额） */
    limit?: number;
    signal?: AbortSignal;
    requestedBy?: string;
    /**
     * 归属的任务 id（可选）。
     * **必须透传**：token 记账与 agent.maxTokensPerTask 预算闸门都按 taskId 归集
     * （闸门在 llmDirect/llmHarness 里按 input.meta.taskId 执行）。
     * 不传则 L2 花的 token 不归属任何任务，预算闸门对它完全无效——
     * 而 L2 恰是整个平台唯一花 token 的环节，一个库失控就能烧穿配额。
     */
    taskId?: number;
}
export interface L2Detail {
    libraryId: number;
    libraryName: string;
    status: 'resolved' | 'queued' | 'failed' | 'skipped';
    kind?: string;
    profileId?: number;
    queued: number;
    reason: string;
}
export interface L2Result {
    processed: number;
    resolved: number;
    queued: number;
    failed: number;
    skipped: number;
    details: L2Detail[];
}
/**
 * 跑一轮 L2 增量采集。
 *
 * 永不抛异常：单个库 LLM 失败/限流/超时都只记该库 skipped/failed，
 * 不影响同轮其他库（与 L0 批次的隔离要求一致）。
 */
export declare function runL2Increment(llm: LlmCall, opts?: L2Options): Promise<L2Result>;
