import type { UiNode } from './hdc.js';
/** 控件分类：不同类别走不同的交互序列（见 uiExplorer）。 */
export type ControlKind = 'button' | 'input' | 'dropdown' | 'checkbox' | 'switch' | 'tab' | 'scroll' | 'text' | 'other';
/**
 * 是否可交互。
 * 判据只用 dump 自带的标志，**不看有没有文本** —— 图标按钮、图片按钮都无文本但 clickable=true，
 * 旧实现要求「有文本」，恰好把真实控件全丢掉、留下不可点的 Text。
 */
export declare function isInteractive(n: UiNode): boolean;
/** 是否可点击（scroll 单独处理，不按点击算）。 */
export declare function isClickable(n: UiNode): boolean;
/**
 * 是否值得作为点击候选。
 * 排除整屏容器：dump 里 WindowScene / Dialog 之类的根容器也标了 clickable=true，
 * 点它们等于点空白（还会被当成"未进入新页面"白白消耗预算）。
 */
export declare function isClickCandidate(n: UiNode, screen?: {
    w: number;
    h: number;
}): boolean;
/** 稳定身份：id > key > hierarchy > (type + 文本)。无文本控件靠 hierarchy/key 区分。 */
export declare function nodeIdentity(n: UiNode): string;
/** 坐标分桶（100px 网格）。 */
export declare function coordBucket(x: number, y: number): string;
/**
 * 去重键：身份 + 坐标桶 + 视口序号。
 * 旧实现只按 `label.slice(0,24)` 去重，导致同屏两个「确定」只点一个；
 * 加入坐标桶后同名控件各算一个（修复"同名控件只采到第一个"）。
 */
export declare function dedupKey(n: UiNode, viewport?: number): string;
/** 控件分类（静态启发式；运行时还会按展开行为二次修正为 dropdown）。 */
export declare function classifyControl(n: UiNode): ControlKind;
/**
 * 供人阅读的控件标签（无文本时用**几何包含的子节点文本**兜底，再退到类型/ID）。
 * `all` 传本页全部节点时，无文本容器（ListItem/Row/图标按钮）会用子节点文本命名。
 * 真机上列表项自身没文本、文本都在子节点上，只用类型兜底会让每个页面标签都叫「[ListItem]」
 * —— 实测 9 个不同页面标签完全相同：用例里区分不出点的是哪个入口，
 * 而且路径重放靠标签找控件，标签重名会导致重放点到错误的项。
 */
export declare function nodeLabel(n: UiNode, all?: UiNode[]): string;
/**
 * 节点指纹：类型 + 身份 + 文本 + 交互状态。
 * 默认**不含坐标**：连续动画页每帧坐标都在变，带坐标会把每一帧判成新页面（既漏又慢）；
 * 而状态区分（勾选/选中/Tab）由 checked/selected/text 承担。
 * 需要旧行为（对布局敏感）时把 includeLayout 打开。
 */
export declare function nodeFingerprint(n: UiNode, includeLayout?: boolean): string;
/** 页面签名：全部节点指纹去重排序拼接。纯展示节点也参与（它们构成页面结构）。 */
export declare function pageSignature(nodes: UiNode[], includeLayout?: boolean): string;
export interface ExploreBudget {
    /** 最多收录页面数 */
    maxPages: number;
    /** 单次遍历总时长上限（分钟） */
    maxMinutes: number;
    /** 单页最多点击次数（防某页失控） */
    maxClicksPerPage: number;
    /** 单页为看全内容最多滑动次数 */
    maxSwipePerPage: number;
}
export interface BudgetState {
    pages: number;
    clicksOnPage: number;
    steps: number;
    elapsedMs: number;
}
export type BudgetStopReason = 'pages' | 'time' | 'clicksPerPage' | '';
/**
 * 预算检查：**任一维度耗尽即停**，并给出可展示的原因。
 * 取代旧的 `maxDepth` 硬闸（深度只作排序偏好）：旧的深度限制让"子页面的子页面"结构性不可达。
 */
export declare function budgetCheck(state: BudgetState, budget: ExploreBudget): {
    exhausted: boolean;
    reason: BudgetStopReason;
};
export type SkipReason = 'notInteractive' | 'notClickable' | 'duplicate' | 'visited' | 'offScreenContent' | 'fullScreenContainer' | 'navigation' | 'budgetPages' | 'budgetTime' | 'budgetClicksPerPage' | 'leafPage';
export interface CoverageReport {
    pages: number;
    steps: number;
    durationMs: number;
    /** 本次遍历见过的节点总数（按 dump 累加，含重复） */
    nodesSeen: number;
    interactive: {
        /** 去重后发现的交互控件数（分母） */
        discovered: number;
        /** 实际点击的 */
        clicked: number;
        /** 进入页面控件清单的 */
        collected: number;
    };
    skipped: Record<string, number>;
    /** dump 解析失败次数（>0 必须告警：旧实现会把解析失败当成空页面静默跳过） */
    unparsedDumps: number;
    unparsedReasons: string[];
    budget: ExploreBudget;
    stopReason: string;
}
/** 覆盖率累加器：遍历过程中持续记录，结束时产出可解释的报告。 */
export declare class CoverageTracker {
    private readonly budget;
    private nodesSeen;
    private stepCount;
    private readonly discovered;
    private readonly clicked;
    private readonly collected;
    private readonly skipped;
    private unparsedDumps;
    private readonly unparsedReasons;
    constructor(budget: ExploreBudget);
    /** 已执行的动作步数（遍历用它做预算判断）。 */
    get steps(): number;
    /** 已收录页面数（由调用方在 report 时传入，这里只提供步数）。 */
    get discoveredCount(): number;
    /** 记录一次 dump 的全部节点。 */
    seeNodes(nodes: UiNode[], interactiveOf?: (n: UiNode) => boolean): void;
    step(): void;
    markClicked(n: UiNode): void;
    markCollected(n: UiNode): void;
    skip(key: string, reason: SkipReason): void;
    noteUnparsed(reason: string): void;
    report(opts: {
        pages: number;
        durationMs: number;
        stopReason: string;
    }): CoverageReport;
}
/** 覆盖率是否可信：解析失败过多或几乎没发现交互控件时，报告应被标为不可信。 */
export declare function coverageHealth(r: CoverageReport): {
    ok: boolean;
    warnings: string[];
};
