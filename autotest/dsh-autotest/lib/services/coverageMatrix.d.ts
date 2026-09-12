export type CoverageStatus = 'covered' | 'partial' | 'not_covered' | 'blocked';
export type RiskFlag = 'deprecated' | 'name_only_signature' | 'type_symbol' | 'test_only' | 'no_negative_case' | 'no_case' | 'no_traversal_evidence' | 'no_device_control' | 'no_endpoint_for_param'
/**
 * 只能 API 调用、UI 上触发不到。目前**不由规则自动产生**：静态分析无法证明"UI 触发不到"
 * 这件事（只能证明"没找到调用"），硬标会变成猜测。留给人工/P5 判定写入。
 */
 | 'api_only';
export interface ScenarioFit {
    happy: boolean;
    empty: boolean;
    boundary: boolean;
    bigdata: boolean;
}
/** 一个符号参与判定的全部事实（由装配层从 DB/遍历报告/用例里收集）。 */
export interface MatrixInput {
    symbol: {
        id: number;
        name: string;
        kind: string;
        params: Array<{
            name: string;
            type: string;
            optional: boolean;
            defaultValue: string;
            doc: string;
        }>;
        methods: string[];
        deprecated: boolean;
        detailLevel: string;
        sourceFile: string;
        sourceLine: number;
        signature: string;
    };
    /** demo（src/main）里的真实调用点 */
    demoCalls: Array<{
        pagePath: string;
        sourceFile: string;
        sourceLine: number;
        snippet: string;
    }>;
    /** 单元测试（src/ohosTest）里的调用点 */
    testCalls: Array<{
        sourceFile: string;
        sourceLine: number;
    }>;
    /** demo 页面上可用于注入参数的数据点（@State 等） */
    paramPoints: Array<{
        pagePath: string;
        name: string;
        sourceFile: string;
        sourceLine: number;
    }>;
    /** 真机遍历证据：路由 → 该页在真机上被收录时的控件文本 */
    traversal: {
        reportFile: string;
        routes: Map<string, {
            controls: string[];
            path: string[];
        }>;
    } | null;
    /** 用例：按 api_symbol_id 关联到本符号 */
    cases: Array<{
        id: number;
        caseNo: string;
        name: string;
        scenarioKind: string;
    }>;
}
export interface MatrixRow {
    symbolId: number;
    symbolName: string;
    kind: string;
    status: CoverageStatus;
    statusReason: string;
    riskFlags: RiskFlag[];
    scenarioFit: ScenarioFit;
    /** 最佳证据：优先 demo 调用点，其次单元测试，再次"无" */
    evidence: {
        demoCall?: {
            pagePath: string;
            sourceFile: string;
            sourceLine: number;
            snippet: string;
        };
        testCallCount: number;
        traversalReport: string;
        deviceControls: string[];
        devicePagePath: string;
        caseNos: string[];
        negativeCaseNos: string[];
        paramPoints: Array<{
            pagePath: string;
            name: string;
            sourceFile: string;
            sourceLine: number;
        }>;
    };
    /** 真机可达的页面（demo 调用点所在页面 ∩ 遍历报告里出现过的路由） */
    deviceReachable: boolean;
}
/** 类型/接口类符号：没有运行时行为，真机 UI 上既触发不了也断言不了。 */
export declare function isTypeSymbol(kind: string): boolean;
/** 负向场景：空值与边界异常（大数据算压力，不算负向）。 */
export declare function isNegativeScenario(kind: string): boolean;
/**
 * 场景适用性（静态初判）。
 *
 * 只依据**已有事实**判断，不猜：happy 任何接口都适用；empty/boundary/bigdata 需要
 * 至少有一个参数可被构造出对应取值。签名不可信（name-only）时**不给 false 以外的结论**
 * —— 拿不准就判不适用，让 P4 用 oracle 补齐，而不是先假定适用再生成一堆跑不了的用例。
 */
export declare function computeScenarioFit(input: MatrixInput): ScenarioFit;
/**
 * 状态判定（确定性规则表，逐条可测）。
 *
 * 规则顺序是刻意的：先排除"真机上根本测不了"的（blocked），再排"完全没碰过"的
 * （not_covered），最后才在"碰过"的里面区分 covered / partial。
 * 任何一条路径都不会把"没测"判成 covered —— covered 必须同时有**正向调用**和**负向用例**。
 */
export declare function computeStatus(input: MatrixInput): {
    status: CoverageStatus;
    reason: string;
};
/**
 * 该符号在 demo 调用页面 → 真机遍历报告里的页面 → 控件文本。
 * 这是"真机上有没有对应控件"这一列的来源（遍历报告由 P1 产出）。
 */
export declare function collectDeviceControls(input: MatrixInput): {
    routes: string[];
    controls: string[];
    pagePath: string;
};
/** 风险标记：只标能拿出依据的，不制造噪音。 */
export declare function computeRisks(input: MatrixInput, status: CoverageStatus): RiskFlag[];
/** 组装一行矩阵：状态 + 理由 + 风险 + 场景适用性 + 证据。 */
export declare function buildMatrixRow(input: MatrixInput): MatrixRow;
/** 覆盖率统计（首页 KPI 与矩阵页头部用）。 */
export declare function summarizeMatrix(rows: MatrixRow[]): {
    total: number;
    covered: number;
    partial: number;
    notCovered: number;
    blocked: number;
    /** 接口覆盖率 = 有用例的导出符号 / 全部导出符号（分母排除 blocked：真机测不了的别拉低指标） */
    apiCoverage: number;
    scenarioCoverage: number;
    byRisk: Record<string, number>;
};
export interface TraversalEvidence {
    reportFile: string;
    routes: Map<string, {
        controls: string[];
        path: string[];
    }>;
    /**
     * 本次遍历**所有页面**收集到的控件文本（含首页入口项）。
     * 判定"用例步骤里引用的控件在真机上是否存在"必须用它：用例通常先点首页入口再点目标页按钮，
     * 而首页在 routes 里没有路由名（它不是"被进入"的页面），只用 routes 会把首页入口判成不存在。
     */
    allControls: string[];
}
/**
 * 从 P1 的遍历报告里取出「路由 → 该页控件文本」。
 *
 * 报告里页面记录用的是点击路径（人看得懂），而路由名在操作轨迹的
 * `进入判定 · 点击「X」→ 进入新页面 · pagePath=pages/Y` 这条 op 里。
 * 两者拼起来才能把 demo 源码里的 `pages/SimpleValidatePage` 对上真机页面。
 */
export declare function loadTraversalEvidence(libName: string): TraversalEvidence | null;
export interface MatrixBuildResult {
    libraryId: number;
    libraryName: string;
    version: string;
    rows: number;
    summary: ReturnType<typeof summarizeMatrix>;
    matrix: MatrixRow[];
}
/**
 * 装配并落库覆盖矩阵。同一库重复构建时**先删后插**（矩阵是快照，不是累积流水）。
 */
export declare function buildCoverageMatrix(libraryId: number): Promise<MatrixBuildResult>;
/** 读取已落库的矩阵（带筛选），供前端列表与导出用。 */
export declare function loadCoverageMatrix(libraryId: number, opts?: {
    status?: string;
    risk?: string;
}): Promise<{
    version: string;
    summary: ReturnType<typeof summarizeMatrix>;
    rows: Array<MatrixRow & {
        statusReason: string;
    }>;
}>;
/** 导出 Markdown（评审用）。 */
export declare function renderMatrixMarkdown(libName: string, version: string, rows: MatrixRow[], summary: ReturnType<typeof summarizeMatrix>): string;
/** 导出 CSV（便于丢进表格筛选）。 */
export declare function renderMatrixCsv(rows: MatrixRow[]): string;
