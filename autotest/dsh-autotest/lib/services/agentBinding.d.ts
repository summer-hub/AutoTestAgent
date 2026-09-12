export type AgentKind = 'builtin' | 'prompt' | 'skill' | 'external';
export declare const AGENT_KIND_LABEL: Record<AgentKind, string>;
export interface StageDef {
    stage: string;
    /** 面向人的名字 */
    label: string;
    /** 内置 prompt 的 role（与 prompts 表对应） */
    builtinRole: string;
    /** 输入约定（人读 + 外部 agent 契约共用） */
    input: string;
    /** 输出约定（Schema 名） */
    output: string;
    /** 该阶段可用的知识种类（P9 注入用，见设计 §7.5） */
    knowledgeKinds: string[];
    knowledgeBudget: number;
}
/**
 * 阶段清单（设计 §8.1）。外部 agent 也按这份约定接，避免为每个工具写适配。
 */
export declare const STAGES: StageDef[];
export declare function stageDef(stage: string): StageDef | undefined;
export interface ResolvedBinding {
    stage: string;
    kind: AgentKind;
    /** 生效来源说明（人读；可追溯） */
    source: string;
    scope: 'global' | 'library' | 'default';
    libraryId: number | null;
    promptId: number | null;
    skillPath: string;
    model: string;
    params: Record<string, unknown>;
    externalCmd: string;
}
/**
 * 解析某个阶段在某库下**实际生效**的绑定。
 *
 * 优先级：按库绑定 > 全局绑定 > 内置默认。
 * 这样"默认全用内置、个别库换自写 agent"是最省事的用法，也支持全局替换。
 */
export declare function resolveBinding(stage: string, libraryId?: number | null): Promise<ResolvedBinding>;
/** 全部阶段的生效绑定（Agent 绑定页用）。 */
export declare function listResolvedBindings(libraryId?: number | null): Promise<Array<ResolvedBinding & {
    def: StageDef;
    raw: Record<string, unknown> | null;
}>>;
/** 写入/更新绑定（切换即生效：下一次任务就按新绑定跑）。 */
export declare function upsertBinding(b: {
    stage: string;
    scope: 'global' | 'library';
    libraryId?: number | null;
    kind: AgentKind;
    promptId?: number | null;
    skillPath?: string;
    model?: string;
    params?: Record<string, unknown>;
    externalCmd?: string;
    enabled?: boolean;
}): Promise<ResolvedBinding>;
/** 删除绑定（回到上一级默认）。 */
export declare function deleteBinding(id: number): Promise<{
    ok: boolean;
}>;
/** 把生效绑定写进任务轨迹（可追溯：这条用例是哪个 agent 生成的）。 */
export declare function bindingTraceLine(b: ResolvedBinding): string;
/** 外部 agent 的可用性探测（不实际调用，只看命令是否存在）。 */
export declare function externalCmdAvailable(cmd: string): {
    available: boolean;
    reason: string;
};
/** MCP 工具清单：把平台能力暴露给外部 agent（设计 §8.4）。 */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export declare function mcpTools(): McpTool[];
/** JSON-RPC 2.0 错误码（MCP 基于 JSON-RPC）。 */
export declare const JSONRPC: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
export interface JsonRpcRequest {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
/** 构造 JSON-RPC 响应（纯函数，便于自检）。 */
export declare function rpcResult(id: unknown, result: unknown): JsonRpcResponse;
export declare function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse;
/** MCP initialize 的结果（最小实现：协议版本 + 能力 + 服务信息）。 */
export declare function mcpInitializeResult(): Record<string, unknown>;
