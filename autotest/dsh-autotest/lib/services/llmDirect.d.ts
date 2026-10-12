import { type LlmCall } from './llmCore.js';
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
export declare function listDirectModels(): Promise<ModelRow[]>;
/** 直连 models 表构造非流式 LLM 调用（OpenAI 兼容协议）。 */
export declare function makeDirectLlm(): LlmCall;
export {};
