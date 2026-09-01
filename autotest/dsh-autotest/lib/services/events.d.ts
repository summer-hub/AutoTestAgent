export interface AgentEvent {
    taskId?: number | null;
    spanId?: string;
    parentId?: string;
    kind: string;
    status?: 'ok' | 'error' | 'warn';
    provider?: string;
    model?: string;
    tokensIn?: number | null;
    tokensOut?: number | null;
    latencyMs?: number | null;
    promptChars?: number | null;
    outputChars?: number | null;
    detail?: string;
    error?: string;
}
/** 写入一条事件（失败仅告警，不抛错）。 */
export declare function appendEvent(e: AgentEvent): Promise<void>;
/** 安装 LLM 统一埋点（启动时调用一次；LLM 调用层自动写 agent_events）。 */
export declare function installLlmTracing(): void;
/** 查询事件（观测用）。 */
export declare function listEvents(opts?: {
    taskId?: number;
    kind?: string;
    limit?: number;
}): Promise<Array<Record<string, unknown>>>;
