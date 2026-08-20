import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LlmCall } from '../services/llmHarness.js';
/** 组装 API 分发 handler（挂到 ctx.webServer） */
export declare function makeApiHandler(llm: LlmCall): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
