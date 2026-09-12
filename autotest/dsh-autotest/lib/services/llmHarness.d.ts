import type { Context } from '@deepseek-ai/cordis';
export interface LlmTextInput {
    system?: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    meta?: {
        taskId?: number;
        spanId?: string;
        kind?: string;
    };
}
export interface LlmResult {
    text: string;
    provider: string;
    model: string;
    latencyMs: number;
    attempts: number;
    tokensIn?: number;
    tokensOut?: number;
    taskId?: number;
    spanId?: string;
    kind?: string;
}
export type LlmCall = (input: LlmTextInput) => Promise<LlmResult>;
export interface LlmJsonResult<T> {
    data: T;
    text: string;
    provider: string;
    model: string;
}
/** 统一埋点钩子（agent_events 表写入由 events.ts 注入，避免循环依赖）。 */
export interface LlmTraceEvent {
    taskId?: number;
    spanId?: string;
    kind: string;
    provider: string;
    model: string;
    latencyMs: number;
    attempts: number;
    tokensIn?: number;
    tokensOut?: number;
    promptChars: number;
    outputChars: number;
    status: 'ok' | 'error';
    error?: string;
}
export declare function setLlmTraceHook(fn: ((e: LlmTraceEvent) => void) | null): void;
/** 读取 DSH 设置（~/.dsh/settings.yaml）里的 agent-default-model，即 DSH 当前实际默认模型。 */
export declare function readDshDefaultModel(): {
    provider: string;
    model: string;
} | null;
/**
 * 从 ctx.llm 构造一个非流式文本调用：
 *  - 优先使用「系统配置 → 默认模型」（若存在于 DSH 模型列表）
 *  - 未配置时跟随 DSH 实际默认模型（agent-default-model）
 *  - 都没有则用第一个可用模型
 * 确定性执行：只调用选定模型（最多 3 次重试），不跨模型切换。
 */
export declare function makeLlm(ctx: Context): LlmCall;
/**
 * 原始 LLM 输出落盘（extractJson 彻底失败时），路径跟随 workspace，不写死绝对路径。
 * tag 用于区分调用来源：并发分片同时解析失败时，若都写同一个文件只会留下最后一次，
 * 前面几次的原始输出（排查解析问题唯一的一手证据）就被覆盖掉了。
 */
export declare function writeRawPayload(text: string, tag?: string): void;
/**
 * 结构化输出三保险：严格 JSON 指令 → extractJson 容错 → 解析失败把错误回灌 LLM 修复一次。
 * 相比裸 extractJson，二次回灌让模型看到"哪里解析失败"，显著提升结构可靠性。
 *
 * 注意：解析错误必须保存在**本次调用的局部变量**里。
 * 这里曾是模块级 `let firstErr`，而分片生成是并发的（agent.genShardConcurrency 默认 3），
 * 于是各分片会互相把对方的错误塞进自己的修复提示；且上一次调用的错误会残留到下一次。
 * 这与已经修掉的全局 lastLlmCall 是同一类问题，别再改回全局。
 */
export declare function llmJson<T>(llm: LlmCall, input: LlmTextInput, opts?: {
    retries?: number;
}): Promise<LlmJsonResult<T>>;
/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后杂文） */
export declare function extractJson<T>(text: string): T;
