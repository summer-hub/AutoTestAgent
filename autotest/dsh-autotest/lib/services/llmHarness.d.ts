import type { Context } from '@deepseek-ai/cordis';
export interface LlmTextInput {
    system?: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}
export type LlmCall = (input: LlmTextInput) => Promise<string>;
/** 最近一次实际使用的 provider/model（供执行器写入任务轨迹展示） */
export declare const lastLlmCall: {
    provider: string;
    model: string;
};
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
/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后杂文） */
export declare function extractJson<T>(text: string): T;
