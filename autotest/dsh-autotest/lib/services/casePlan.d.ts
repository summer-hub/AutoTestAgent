export type Scenario = 'happy' | 'empty' | 'boundary' | 'bigdata';
export type Priority = 'P0' | 'P1' | 'P2';
export declare const SCENARIO_LABEL: Record<Scenario, string>;
export declare const SCENARIO_ORDER: Scenario[];
/** 计划生成所需的符号事实（与 api_symbols + demo 证据一一对应）。 */
export interface PlanSymbolInput {
    id: number;
    name: string;
    kind: string;
    signature: string;
    detailLevel: string;
    deprecated: boolean;
    params: Array<{
        name: string;
        type: string;
        optional: boolean;
        defaultValue: string;
        doc: string;
    }>;
    returns: {
        type: string;
        doc: string;
    };
    throws: Array<{
        type: string;
        doc: string;
    }>;
    methods: string[];
    /** demo 调用点（真机可达），触发器展开按它算 */
    demoCalls: Array<{
        pagePath: string;
        sourceFile: string;
        sourceLine: number;
        snippet: string;
    }>;
    testCallCount: number;
    /** 真机遍历里该符号所在页面的控件文本 */
    deviceControls: string[];
    /** 页面上可注入的数据点 */
    paramPoints: Array<{
        pagePath: string;
        name: string;
        sourceFile: string;
        sourceLine: number;
    }>;
}
export interface Applicability {
    fit: Record<Scenario, boolean>;
    /** 每个维度为什么适用/不适用（可解释，进数量报告） */
    reasons: Record<Scenario, string>;
}
export interface NegExtra {
    empty: number;
    boundary: number;
    reasons: string[];
}
export interface PlannedCase {
    symbolId: number;
    symbolName: string;
    symbolKind: string;
    scenario: Scenario;
    priority: Priority;
    title: string;
    /** 这条用例要验证什么（喂给 LLM 的意图，也进数量报告的"目的"列） */
    purpose: string;
    /** 为什么会有这条（适用性依据 / 负向条数依据 / 触发器依据） */
    because: string;
    /** 触发入口：demo 页面 + 真机控件 */
    triggerPage: string;
    triggerControl: string;
    /** 输入设计要点（从签名/JSDoc 推） */
    inputPlan: string;
    /** 断言要点（P6 会用 oracle 强化，这里给初判） */
    assertionPlan: string;
    /** 初判：demo 里有没有现成入口（P5 会做 A/B/C/D 的正式判定） */
    needsPatchHint: 'likely-open' | 'likely-needs-demo-change' | 'unknown';
}
/**
 * 适用性判定（设计 §6.4 的确定性规则）。
 * happy 恒适用；其余三个维度必须能说出"凭什么适用"，说不出就判不适用 ——
 * 宁可少造一条，也不造一条跑不了、断言不了的用例。
 */
export declare function computeApplicability(s: PlanSymbolInput): Applicability;
/**
 * 负向用例的**额外条数**（设计 §6.4：negExtra_* 由接口语义决定）。
 * 这里只用能拿出依据的口径，并把依据写出来：异常码几种就多几条，状态机多一条重复/逆序。
 */
export declare function computeNegExtra(s: PlanSymbolInput): NegExtra;
/** 触发器：同一接口在 demo 里可能有多个入口页面，按入口展开（设计 §6.4 的可选项）。 */
export declare function computeTriggers(s: PlanSymbolInput): Array<{
    pagePath: string;
    control: string;
}>;
/**
 * 单个符号的用例计划（设计 §6.4 的数量模型）。
 *
 *   条数 = Σ( happy 1 + empty (1 + negExtra_empty) + boundary (1 + negExtra_boundary) + bigdata 1 )
 *          × 触发器展开（额外入口只展开 happy，避免条数随页面数失控）
 */
export declare function planSymbolCases(s: PlanSymbolInput, opts?: {
    maxTriggersPerSymbol?: number;
    maxCasesPerSymbol?: number;
}): PlannedCase[];
/**
 * 从**实际计划**汇总数量报告（纯函数，便于离线核对）。
 *
 * 这里的唯一纪律：报告里的每个数字都必须是数出来的，不能另算一遍。
 * 一开始分解表是拿 applicability 重新推的，而计划的触发器数被 maxTriggersPerSymbol 截过，
 * 于是报告写着「正向 17 条」而实际只生成 3 条 —— 报告与计划不一致比没有报告更糟，
 * 因为它会让人以为已经覆盖了 17 个入口。所以这里特意做成纯函数并单独自检。
 */
export declare function summarizePlans(perSymbol: Array<{
    symbolId: number;
    name: string;
}>, plans: PlannedCase[]): Pick<LibraryPlan['summary'], 'planned' | 'byScenario' | 'byPriority' | 'byKind' | 'perSymbolBreakdown'>;
export interface LibraryPlan {
    libraryId: number;
    version: string;
    plans: PlannedCase[];
    perSymbol: Array<{
        symbolId: number;
        name: string;
        kind: string;
        applicability: Applicability;
        negExtra: NegExtra;
        triggers: number;
        planned: number;
        scenarios: Scenario[];
    }>;
    /** 数量报告：每个数字都能追到规则 */
    summary: {
        symbols: number;
        planned: number;
        byScenario: Record<Scenario, number>;
        byPriority: Record<Priority, number>;
        byKind: Record<string, number>;
        skippedSymbols: Array<{
            name: string;
            kind: string;
            reason: string;
        }>;
        perSymbolBreakdown: Array<{
            name: string;
            happy: number;
            empty: number;
            boundary: number;
            bigdata: number;
        }>;
    };
}
/** 用 P2/P3 已落库的事实为一个库生成计划（不调 LLM、不写 cases）。 */
export declare function planLibraryCases(libraryId: number, opts?: {
    maxTriggersPerSymbol?: number;
    maxCasesPerSymbol?: number;
}): Promise<LibraryPlan>;
/**
 * 显式抽样：计划条数超过预算时，**报出被裁掉多少、为什么**。
 * 绝不静默截断 —— 修复记录里同类问题（静默少几行/少几条）是明确教训。
 */
export declare function samplePlan(plans: PlannedCase[], budget: number): {
    selected: PlannedCase[];
    skipped: PlannedCase[];
    report: string;
};
