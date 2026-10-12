import type { Context } from '@deepseek-ai/cordis';
import { type LlmCall } from './llmCore.js';
export * from './llmCore.js';
/**
 * 从 ctx.llm 构造一个非流式文本调用：
 *  - 优先使用「系统配置 → 默认模型」（若存在于 DSH 模型列表）
 *  - 未配置时跟随 DSH 实际默认模型（agent-default-model）
 *  - 都没有则用第一个可用模型
 * 重试会跨模型：首选失败后顺次切换到其他候选（最多 3 次），不再 3 次全打在同一个模型上；
 * 候选不足 3 个时绕回首选（退化为同模型重试）。任务取消信号触发时立即放弃，不重试。
 */
export declare function makeLlm(ctx: Context): LlmCall;
