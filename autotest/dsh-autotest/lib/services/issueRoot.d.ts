import type { LlmCall } from './llmCore.js';
import type { Oracle } from './oracle.js';
/** 单条证据：AI 引用的一切都必须能被人回查。 */
export interface RootCauseEvidence {
    kind: 'source' | 'symbol' | 'explore' | 'execution' | 'readme';
    /** 引用位置（source: 文件路径；explore: 页面路径；execution: 执行 id） */
    ref: string;
    /** 行号（source 且有行号时；没有就留 0，不要编） */
    line: number;
    /** 源码片段或说明（截断后的原文） */
    excerpt: string;
    /** 这条证据支持什么 */
    supports: string;
}
/** AI 根因结论的结构化形态。 */
export interface RootCauseVerdict {
    /** 根因陈述（一句话，必须具体到机制而不是"可能是兼容性问题"） */
    rootCause: string;
    /** 置信度 0-100 */
    confidence: number;
    /** 证据清单（空 = 没有证据，此时 confidence 必须低） */
    evidence: RootCauseEvidence[];
    /** 建议的修复方向（具体到动作） */
    fixSuggestions: string[];
    /** 是否需要改 demo 才能验证/修复（决定要不要走 testability 的副本补丁链路） */
    needsDemoPatch: boolean;
    /** 需要人确认什么（空 = 不需要；非空则应入人工队列） */
    uncertainties: string[];
    /** 分析依据来源：llm / rule（降级） */
    analysisBy: 'llm' | 'rule';
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
/**
 * 用 LLM 做根因分析。失败不抛（由调用方降级）——但在返回里如实标注 analysisBy。
 */
export declare function analyzeWithLlm(ctx: IssueContext, llm: LlmCall): Promise<RootCauseVerdict>;
/**
 * 规则降级分析（LLM 不可用时）。
 *
 * 不给根因（没有模型就不该猜根因），但给"该看什么"——把上下文里**真实存在**的
 * 线索列出来，让人能自己接着查。这比返回一个空结论有用得多。
 */
export declare function analyzeByRule(ctx: IssueContext): RootCauseVerdict;
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
