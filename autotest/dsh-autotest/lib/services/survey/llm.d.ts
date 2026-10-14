import type { LlmCall } from '../llmCore.js';
export interface L2Options {
    /** 指定库 id；缺省取所有 needs_llm=1 的库 */
    ids?: number[];
    /** 单次最多处理几个（默认 20：L2 单库成本高，一次跑太久会占满限流配额） */
    limit?: number;
    signal?: AbortSignal;
    requestedBy?: string;
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
