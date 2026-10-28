import { type IssueTicketRow, type RootCauseVerdict } from './issueRoot.js';
/** 报告类型（analysis_reports.kind；当前只用工单根因一种，枚举留扩展）。 */
export type ReportKind = 'issue_root_cause' | 'attribution' | 'baseline_diff';
export interface ReportRow {
    id: number;
    reportNo: string;
    kind: string;
    issueId: number | null;
    executionId: number | null;
    testRunId: number | null;
    libraryId: number | null;
    caseId: number | null;
    baselineId: number | null;
    title: string;
    mdPath: string;
    contentHash: string;
    /** 正文可能很大；列表场景用 omitContent 的行类型（ReportMeta） */
    content: string;
    createdBy: string;
    createdAt: string;
}
export type ReportMeta = Omit<ReportRow, 'content'>;
export declare function getReport(id: number, opts?: {
    withContent?: boolean;
}): Promise<ReportRow | null>;
export declare function getReportByIssue(ticketId: number, opts?: {
    withContent?: boolean;
}): Promise<ReportRow | null>;
export declare function listReports(opts?: {
    libraryId?: number;
    kind?: string;
    limit?: number;
}): Promise<ReportMeta[]>;
/**
 * 报告正文（下载用）：优先读文件并校验 hash；文件丢失/损坏时回退 DB 正文。
 * 返回 content + source，让下载方知道拿到的是原件还是库内副本。
 */
export declare function getReportMarkdown(id: number): Promise<{
    report: ReportRow;
    content: string;
    source: 'file' | 'db';
}>;
/** 用例关联的场景资产（报告 §2.4 场景资源与配置指导）。 */
export interface ReportScenarioAsset {
    asset_no: string;
    title: string;
    kind: string;
    scenario_kind: string;
    status: string;
    version: string;
    config_guide_md: string;
    role: string;
}
/** 该次运行实际登记的资产版本（run_item_assets，报告 §1 资源行）。 */
export interface ReportRunAssetRef {
    asset_no: string;
    version: string;
    apply_status: string;
}
/** 报告渲染所需的全部上下文（有界、可日志化）。 */
export interface IssueReportContext {
    ticket: IssueTicketRow;
    libraryName: string;
    caseNo: string;
    caseName: string;
    caseVersion: number | null;
    precondition: string;
    steps: string[];
    expected: string;
    oracles: Array<Record<string, unknown>>;
    /** 绑定的执行（从执行发起）；为 null 表示未绑定具体执行 */
    execution: {
        id: number;
        status: string;
        startedAt: string | null;
        finishedAt: string | null;
        deviceModel: string;
        libraryVersion: string;
        commitSha: string;
        actualJson: string | null;
        logsTail: string;
    } | null;
    testRunNo: string;
    baseline: {
        baselineNo: string;
        versionLabel: string;
        commitSha: string;
        versionLabel2: string;
    } | null;
    /** B4：用例关联的需求（requirement_cases） */
    requirements: Array<{
        requirementNo: string;
        title: string;
        url: string;
    }>;
    /** B4：基线来源 PR（baseline_prs，含 merge commit） */
    prs: Array<{
        number: number;
        title: string;
        mergeCommitSha: string;
        url: string;
    }>;
    scenarioAssets: ReportScenarioAsset[];
    runAssetRefs: ReportRunAssetRef[];
    resourceSetNo: string;
    rootCause: RootCauseVerdict | null;
    verification: Record<string, unknown>;
}
/**
 * 组装报告上下文（设计 §9.2）：在 R5 既有输入上补 基线/执行链/预置条件/场景资产/资源集。
 * 全部只读取证 —— 报告是快照，组装过程绝不写库。
 */
export declare function buildIssueReportContext(ticketId: number): Promise<IssueReportContext>;
/**
 * 按 §9.5 模板渲染 Markdown。
 * 独立纯函数（无 IO）：给定上下文出确定文本，便于自检逐段断言。
 */
export declare function renderIssueReport(ctx: IssueReportContext): string;
/**
 * 为工单生成 Markdown 报告（设计 §9.6）。
 *
 * - 每次生成 = 新 report_no + 新文件 + 新 analysis_reports 行（不可变纪律）；
 * - 工单 report_id 指向最新，旧报告保留可查；
 * - 正文双写：文件 + DB；
 * - feature.mdReport=false 时直接 403（与路由层同一开关，服务层再挡一道
 *   防止任务链路在开关关闭时静默写文件）。
 */
export declare function generateIssueReport(ticketId: number, opts?: {
    createdBy?: string;
}): Promise<ReportRow>;
