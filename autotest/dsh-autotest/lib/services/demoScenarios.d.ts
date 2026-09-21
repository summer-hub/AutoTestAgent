export type ScenarioKind = 'positive' | 'negative';
export type ScenarioStatus = 'covered' | 'partial' | 'uncovered';
export declare const STATUS_LABEL: Record<ScenarioStatus, string>;
export interface ScenarioDef {
    /** 场景编号：P01 / N07 */
    no: string;
    name: string;
    kind: ScenarioKind;
    /** 归属功能模块（来自「功能模块映射」表；取不到就是空） */
    module: string;
    /** 「场景涉及的功能点」里 `对应接口：...` 提到的接口名（已规整） */
    interfaces: string[];
}
export interface ScenarioJudgement {
    no: string;
    name: string;
    status: ScenarioStatus;
    /** 接口覆盖率分子/分母（来自「接口覆盖率」列） */
    apiCovered: number;
    apiTotal: number;
    /** 匹配文件（含行号） */
    evidence: string;
    gap: string;
}
export interface InterfaceCheckRow {
    api: string;
    /** executed=有真实调用点；conditional=有条件/未生效；missing=零调用 */
    verdict: 'executed' | 'conditional' | 'missing';
    evidence: string;
}
export interface ScenarioCoverageRow extends ScenarioDef {
    status: ScenarioStatus;
    apiCovered: number;
    apiTotal: number;
    evidence: string;
    gap: string;
    /** 场景 ↔ 结论不一致时在这里说明（人工可读） */
    note: string;
}
export interface ScenarioCoverageSummary {
    total: number;
    covered: number;
    partial: number;
    uncovered: number;
    positive: number;
    negative: number;
    /** =(covered + partial*0.5)/total —— 与技能文档同一口径 */
    overall: number;
    positiveRate: number;
    negativeRate: number;
    /** 接口维度：真实执行 / 有条件 / 零调用 */
    apiExecuted: number;
    apiConditional: number;
    apiMissing: number;
    apiRate: number;
    byModule: Array<{
        module: string;
        total: number;
        covered: number;
        partial: number;
        uncovered: number;
        rate: number;
    }>;
    byStatusEvidence: Record<string, number>;
}
/** 状态列 → 枚举。认不出返回 null（调用方必须报 warning，不许默认）。 */
export declare function parseStatus(mark: string): ScenarioStatus | null;
/** `2/2 (100%)` / `0/4 (0%)` → {covered:2,total:2}；解析失败返回 null。 */
export declare function parseRatio(cell: string): {
    covered: number;
    total: number;
} | null;
/** 把 markdown 表格行拆成单元格（去掉首尾空管道，保留单元格内的 `|` 转义场景由调用方处理）。 */
export declare function splitRow(line: string): string[];
/** 从 `#### P01 名字` 这类标题里取编号与名字。 */
export declare function parseScenarioHeading(text: string): {
    no: string;
    name: string;
} | null;
/** 从一句功能点里取 `对应接口：`xxx()`、`yyy`` 中的所有反引号片段，规整成接口名。 */
export declare function extractInterfaces(line: string): string[];
/** 只有一个反引号片段的「接口名归一」：`new Validator()` → Validator；`Validator.validate()` → Validator.validate。 */
export declare function normalizeApi(raw: string): string;
export declare function parseScenarioList(md: string): {
    scenarios: ScenarioDef[];
    moduleMap: Array<{
        module: string;
        apis: string[];
        positive: string[];
        negative: string[];
    }>;
    warnings: string[];
};
export declare function parseCoverageReport(md: string): {
    judgements: ScenarioJudgement[];
    interfaces: InterfaceCheckRow[];
    warnings: string[];
    baselineNote: string | null;
};
/**
 * 合并场景清单与覆盖率报告。
 * 交叉核对（任何一条都进 warnings，不静默）：
 *   - 场景清单有、报告没有结论 → 缺结论
 *   - 报告有结论、清单里没有该场景 → 结论悬空
 *   - 名称不一致 → 报出来（两边可能有一处过期）
 *   - ✅ 但接口覆盖率 < 100% / ❌ 但接口覆盖率 > 0 → 状态与证据不一致，需要 gap 解释
 */
export declare function mergeScenarioCoverage(scenarioMd: string, reportMd: string): {
    rows: ScenarioCoverageRow[];
    summary: ScenarioCoverageSummary;
    warnings: string[];
    modules: Array<{
        module: string;
        apis: string[];
        positive: string[];
        negative: string[];
    }>;
};
export declare function summarizeScenarioCoverage(rows: ScenarioCoverageRow[], interfaces: InterfaceCheckRow[], modules?: Array<{
    module: string;
}>): ScenarioCoverageSummary;
/** 场景覆盖度 markdown（导出给人工评审 / 归档，与矩阵导出同风格）。 */
export declare function renderScenarioCoverageMarkdown(libName: string, rows: ScenarioCoverageRow[], summary: ScenarioCoverageSummary, warnings: string[], sources: {
    scenarioDoc: string;
    reportDoc: string;
}): string;
export declare function scenarioDocPaths(libName: string): {
    dir: string;
    scenarioDoc: string;
    reportDoc: string;
};
export declare function readScenarioDocs(libName: string): {
    scenarioMd: string;
    reportMd: string;
    missing: string[];
};
export interface ScenarioCoverageResult {
    libraryId: number;
    libraryName: string;
    sources: {
        scenarioDoc: string;
        reportDoc: string;
    };
    missing: string[];
    rows: number;
    summary: ScenarioCoverageSummary;
    warnings: string[];
    scenarios: ScenarioCoverageRow[];
}
/** 只读计算（不落库）：解析两份 md → 合并 → 统计。 */
export declare function loadScenarioCoverage(libraryId: number): Promise<ScenarioCoverageResult>;
/** 解析 + 落库（快照；md 仍是唯一事实来源，随时可重建）。 */
export declare function syncScenarioCoverage(libraryId: number): Promise<ScenarioCoverageResult>;
/** 读快照（列表页/首页 KPI 用；没有快照时返回空而不是报错）。 */
export declare function readScenarioCoverageSnapshot(libraryId: number): Promise<{
    version: string;
    summary: ScenarioCoverageSummary;
    rows: number;
    updatedAt: string;
}>;
