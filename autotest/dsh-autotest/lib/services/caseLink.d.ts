import { type TraversalEvidence } from './traversalEvidence.js';
import type { RepoLib } from './gitRepo.js';
/** 关联依据：explicit 生成时指定 / page 用例所属页命中该接口的 demo 调用页 / name 名称命中 / manual 人工确认 */
export type LinkBasis = 'explicit' | 'page' | 'name' | 'manual';
export type LinkConfidence = 'high' | 'medium' | 'low';
export declare const BASIS_LABEL: Record<LinkBasis, string>;
/** 生成 evidence 时纳入统计的置信度（low 只展示，不据此判覆盖）。 */
export declare function isTrustedLink(l: {
    confidence: LinkConfidence;
}): boolean;
export interface CaseForLink {
    id: number;
    caseNo: string;
    name: string;
    steps: string[];
    expected: string;
    pagePath: string;
    apiSymbolId: number | null;
}
export interface SymbolForLink {
    id: number;
    name: string;
    kind: string;
    methods: string[];
    /** 该接口在 demo 源码里被调用的页面（路由名，如 pages/Y） */
    demoCallPages: string[];
    /** 该接口在真机上可达的控件文本（遍历证据） */
    deviceControls: string[];
}
export interface LinkCandidate {
    caseId: number;
    symbolId: number;
    basis: LinkBasis;
    confidence: LinkConfidence;
    detail: string;
}
/** 用例可能写的是面包屑（首页 → Y），也可能直接写路由名（pages/Y）：两种都要能认。 */
export declare function resolveCaseRoute(pagePath: string, traversal: TraversalEvidence | null): {
    route: string;
    how: string;
};
/** 名称命中：符号名或其方法名出现在用例文本里（要求 ≥3 字符，避免 validate 这类通用词误伤短名）。 */
export declare function nameHits(text: string, symbolName: string, methods: string[]): string[];
/**
 * 推断一条用例覆盖了哪些接口（纯函数，可离线逐条核对）。
 *
 * 优先级：explicit > page > name。同一个符号只保留最强的一条依据。
 */
export declare function inferLinks(c: CaseForLink, symbols: SymbolForLink[], traversal: TraversalEvidence | null): LinkCandidate[];
export interface LinkRunResult {
    libraryId: number;
    /** 本次写入的关联条数（不含被保护的人工关联） */
    links: number;
    /** 关联到至少一个接口的用例数 */
    linkedCases: number;
    /** 该库用例总数 */
    totalCases: number;
    /** 一条接口都没关联上的用例数 —— 这才是能推动人去清理的数字 */
    unlinkedCases: number;
    byBasis: Record<string, number>;
    preservedManual: number;
}
/**
 * 为一个库重建用例↔接口关联（幂等）：
 * `manual` 关联原样保留，其余先删后插 —— 关联是"当前事实的快照"，不是累积流水。
 */
export declare function linkCasesForLibrary(libraryId: number): Promise<LinkRunResult>;
export interface CaseLinkRow {
    caseId: number;
    caseNo: string;
    caseName: string;
    scenarioKind: string;
    symbolId: number;
    symbolName: string;
    basis: string;
    confidence: string;
    detail: string;
}
/** 读取一个库的关联（默认排除 low，除非显式要看）。 */
export declare function listLinks(libraryId: number, opts?: {
    includeWeak?: boolean;
}): Promise<CaseLinkRow[]>;
/** 关联快照：symbolId → 该接口下的用例（供覆盖矩阵装配使用，避免矩阵自己再算一遍）。 */
export declare function loadLinksBySymbol(libraryId: number): Promise<Map<number, Array<{
    caseId: number;
    caseNo: string;
    basis: string;
    confidence: string;
}>>>;
/** 人工确认/取消一条关联（basis=manual，重新关联时受保护）。 */
export declare function setManualLink(caseId: number, symbolId: number, linked: boolean): Promise<{
    ok: boolean;
    message: string;
}>;
/** 供执行器使用：给一批用例写"整合时确认"的关联（basis=explicit，带来源说明）。 */
export declare function linkCaseToSymbols(caseId: number, symbolIds: number[], detail: string): Promise<number>;
/**
 * 这条用例是不是"初版草稿"（P11 整合任务的目标筛选依据）。
 *
 * 判据就是本项目对"草稿 / 正式用例"的定义性差别：**有没有可机器校验的判据**。
 * 有判据 = 已能判定通过与否 = 正式；没有（或判据不可核对、恒真）= 草稿。
 * 用别的特征（来源、版本号、名字）都不成立：人手工录的用例也可能没判据。
 */
export declare function isDraftCase(oracleJson: string | null | undefined, validate: (v: unknown) => Array<{
    reason: string;
}>): boolean;
/** 关联情况的人类可读报告（任务轨迹与接口返回共用）。 */ export declare function renderLinkReport(lib: RepoLib | {
    name: string;
}, r: LinkRunResult): string;
