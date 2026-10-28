import type { LlmCall } from './llmCore.js';
import type { Oracle } from './oracle.js';
/** 单条证据：AI 引用的一切都必须能被人回查。 */
export interface RootCauseEvidence {
    kind: 'source' | 'symbol' | 'explore' | 'execution' | 'readme' | 'asset' | 'pr';
    /** 引用位置（source: 文件路径；explore: 页面路径；execution: 执行 id） */
    ref: string;
    /** 行号（source 且有行号时；没有就留 0，不要编） */
    line: number;
    /** 源码片段或说明（截断后的原文） */
    excerpt: string;
    /** 这条证据支持什么 */
    supports: string;
}
/**
 * B3 归因枚举（设计 §9.3）：attribution 是主结论，needsDemoPatch 保留兼容但不再是唯一 demo 标志。
 * unknown = 没有足够证据归类 —— 无证据时必须落这里，不得默认塞 demo。
 */
export type AttributionKind = 'case_precondition' | 'demo' | 'library' | 'environment' | 'flaky' | 'unknown';
export declare const ATTRIBUTIONS: AttributionKind[];
export declare const ATTRIBUTION_LABELS: Record<AttributionKind, string>;
/**
 * B3 分析过程（设计 §9.4）：报告必须能写出"怎么排除的"。
 * 每条 = 一个假设 → 检查了什么 → 结论（成立/排除/不确定）。
 */
export interface AnalysisStep {
    hypothesis: string;
    checked: string;
    result: 'confirmed' | 'excluded' | 'uncertain';
}
/** AI 根因结论的结构化形态。 */
export interface RootCauseVerdict {
    /** 根因陈述（一句话，必须具体到机制而不是"可能是兼容性问题"） */
    rootCause: string;
    /** B3 归因主结论（设计 §9.3）；LLM 给不出合法枚举时归 unknown */
    attribution: AttributionKind;
    /** 置信度 0-100 */
    confidence: number;
    /** 分析过程：假设 → 检查 → 结论（§9.4，渲染进报告第 4 节） */
    process: AnalysisStep[];
    /** 证据清单（空 = 没有证据，此时 confidence 必须低） */
    evidence: RootCauseEvidence[];
    /** 建议的修复方向（具体到动作） */
    fixSuggestions: string[];
    /** 是否需要改 demo 才能验证/修复（决定要不要走 testability 的副本补丁链路） */
    needsDemoPatch: boolean;
    /** 需要人确认什么（空 = 不需要；非空则应入人工队列） */
    uncertainties: string[];
    /** 分析依据来源：llm（唯一来源——LLM 不可用时直接抛错，不产出规则结论） */
    analysisBy: 'llm';
}
/** 组装后的上下文（有界、可日志化）。 */
export interface IssueContext {
    caseId: number;
    caseNo: string;
    caseName: string;
    libraryId: number;
    libraryName: string;
    symptom: string;
    steps: string[];
    expected: string;
    oracles: Oracle[];
    repoDir: string;
    /**
     * 仓库状态备注：clone 失败 / 本地有代码但非 git 仓库 / 未配置地址时的如实说明。
     * **必须暴露给人**——否则"基于本地旧代码得出的根因"看起来和基于最新代码一样新鲜，
     * 人会照着一个过期结论去改代码。空串 = 正常 clone/update 过。
     */
    repoNote: string;
    bundleName: string;
    /** 目标页源码（按症状关键词命中；命中不了给页面清单） */
    targetCode: string;
    targetScope: string;
    /** 真机遍历 dump（最近一次；没有就空串） */
    exploreCtx: string;
    /** 导出符号中与症状相关的（没有就空数组） */
    relatedSymbols: Array<{
        name: string;
        kind: string;
        signature: string;
        sourceFile: string;
        sourceLine: number;
    }>;
    /** 最近一次执行日志尾部（没有就空串） */
    lastExecutionLog: string;
    /** README 前若干字符（环境与已知问题的线索） */
    readmeExcerpt: string;
}
/**
 * 组装分析上下文。
 *
 * 为什么单独一个函数：上下文是"AI 看到的世界"，它决定了根因结论的上限。
 * 单独拆出来才能被自检覆盖（给定假仓库 → 断言组装结果有界、命中逻辑正确、
 * 缺数据时如实留空而不是填假数据）。
 */
export declare function buildIssueContext(ticketId: number): Promise<IssueContext>;
/** 归因字符串 → 枚举（LLM 输出不可信，必须白名单过滤；缺省 unknown）。 */
export declare function normalizeAttribution(v: unknown): AttributionKind;
/**
 * 用 LLM 做根因分析。
 *
 * LLM 不可用（未配模型 / 连续失败 / 输出不是合法 JSON）时**直接抛错**，
 * 由上层转成红色告警——不再降级为规则分析。原因见文件头纪律 2：
 * 规则兜底罗列线索看着像结论，却和真正的根因混在同一张工单列表里。
 */
export declare function analyzeWithLlm(ctx: IssueContext, llm: LlmCall): Promise<RootCauseVerdict>;
/** 工单状态流转（集中一处，避免散落的状态字符串写错）。 */
export declare const TICKET_STATUS: {
    readonly pending: "pending";
    readonly analyzing: "analyzing";
    readonly rootCaused: "root_caused";
    readonly verifying: "verifying";
    readonly accepted: "accepted";
    readonly rejected: "rejected";
    readonly failed: "failed";
};
export declare function ticketNo(): string;
/** 工单完整行。 */
export interface IssueTicketRow {
    id: number;
    ticketNo: string;
    caseId: number;
    libraryId: number;
    symptom: string;
    status: string;
    rootCause: RootCauseVerdict | null;
    evidence: RootCauseEvidence[];
    verification: Record<string, unknown>;
    verdict: string;
    verdictReason: string;
    verdictBy: string;
    verdictAt: string | null;
    knowledgeId: string;
    taskId: number | null;
    /** B3：从哪次执行发起（从用例发起时为 null，报告标注"未绑定具体执行"） */
    executionId: number | null;
    testRunId: number | null;
    runItemId: number | null;
    baselineId: number | null;
    caseVersion: number | null;
    /** B3：归因主结论（人工修正后覆盖 LLM 结论） */
    attribution: AttributionKind;
    attributionReason: string;
    reportId: number | null;
    error: string;
    createdAt: string;
    updatedAt: string;
}
export declare function loadTicket(ticketId: number): Promise<IssueTicketRow | null>;
export declare function listTickets(opts?: {
    libraryId?: number;
    caseId?: number;
    status?: string;
    limit?: number;
}): Promise<IssueTicketRow[]>;
/**
 * 创建工单（symptom 必填——没有问题现象就没有分析对象）。
 *
 * B3（设计 §9.1）：推荐从执行发起 —— executionId 存在时把 run/baseline/用例版本链路一并快照进工单；
 * 从用例发起（executionId 为空）时用**最近一次执行**回填链路但 execution_id 留空，
 * 报告据此标注「未绑定具体执行」，不伪造精确绑定。
 */
export declare function createTicket(input: {
    caseId: number;
    symptom: string;
    executionId?: number;
}): Promise<IssueTicketRow>;
/** 更新工单状态（可同时带 error）。 */
export declare function setTicketStatus(ticketId: number, status: string, error?: string): Promise<void>;
/** 写入根因结论（root_caused；B3 同时落归因列——attribution 是主结论）。 */
export declare function saveTicketRootCause(ticketId: number, verdict: RootCauseVerdict): Promise<void>;
/**
 * B3 人工修正归因（设计 §10.7 PUT /issues/:id/attribution）。
 * 必须留理由——修正历史供报告/审计回查「为什么改了结论」。
 */
export declare function updateTicketAttribution(input: {
    ticketId: number;
    attribution: AttributionKind;
    reason: string;
    by?: string;
}): Promise<IssueTicketRow>;
/** 写入自测试验证结果（verifying / failed）。 */
export declare function saveTicketVerification(ticketId: number, verification: Record<string, unknown>, status: string, error?: string): Promise<void>;
/** 人工验收（接受才沉淀知识；拒绝也记录理由供反查）。 */
export declare function decideTicket(input: {
    ticketId: number;
    accept: boolean;
    reason: string;
    by?: string;
    knowledgeId?: string;
}): Promise<IssueTicketRow>;
