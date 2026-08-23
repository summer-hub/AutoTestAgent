import type { Context } from '@deepseek-ai/cordis';
export interface LlmTextInput {
    system?: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}
export type LlmCall = (input: LlmTextInput) => Promise<string>;
/** 从 ctx.llm 构造一个非流式文本调用（优先默认 provider；若配置了 agent.defaultModel 且存在于模型列表，则优先使用该模型） */
export declare function makeLlm(ctx: Context): LlmCall;
/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后杂文） */
export declare function extractJson<T>(text: string): T;
