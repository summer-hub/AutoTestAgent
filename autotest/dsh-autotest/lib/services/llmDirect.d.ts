import { type LlmCall } from './llmCore.js';
/** 模型调用协议：openai 兼容 chat/completions，或 anthropic 兼容 messages。 */
export type LlmProtocol = 'openai' | 'anthropic';
/** 候选来源：env = 环境变量覆盖，db = models 表（系统配置页维护）。 */
export type ModelSource = 'env' | 'db';
export interface ModelRow {
    id: number;
    name: string;
    provider: string;
    base_url: string;
    model_id: string;
    api_key: string;
    protocol: LlmProtocol;
    is_default: number;
    /** 配置来源（db 行为表内行；env 行为环境变量注入的候选） */
    source: ModelSource;
}
export interface DirectModelInfo {
    id: number;
    name: string;
    provider: string;
    baseUrl: string;
    modelId: string;
    protocol: LlmProtocol;
    hasApiKey: boolean;
    isDefault: boolean;
    source: ModelSource;
}
/** 读取 models 表候选（默认模型优先，其余按 id）。无表/无数据时返回空数组。 */
export declare function listDirectModels(): Promise<ModelRow[]>;
/** 协议归一化：非法值回落 openai（与 publishhar 对 protocol 的兜底一致）。 */
export declare function normalizeProtocol(raw: unknown): LlmProtocol;
/**
 * 环境变量覆盖（AUTOTEST_LLM_*，对应 publishhar 的 OHLIB_LLM_*）：
 * 只认「至少配了 baseUrl + model」这一组，其它情况视为未配置（返回 null），
 * 避免半个配置把候选列表搅乱。API Key 允许只走环境变量——页面不展示、不落库。
 */
export declare function readLlmEnvOverride(): Omit<ModelRow, 'id' | 'is_default'> | null;
/** 直连 models 表构造非流式 LLM 调用（OpenAI / Anthropic 双协议）。 */
export declare function makeDirectLlm(): LlmCall;
