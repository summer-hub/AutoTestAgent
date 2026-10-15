export type BlockerStage = 'demo_patch' | 'oracle_missing' | 'external_dep' | 'animation' | 'video' | 'flaky' | 'device_blocked' | 'long_running' | 'untestable' | 'env_blocked' | 'resource_missing' | 'toolchain_missing';
export declare const BLOCKER_LABEL: Record<BlockerStage, string>;
export interface TriageInput {
    caseId: number;
    caseNo: string;
    name: string;
    testability: string;
    /** 补丁是否已批准并应用（B/C 类必须） */
    patchApproved: boolean;
    hasPatchDraft: boolean;
    oracles: unknown;
    steps: string[];
    expected: string;
    /** 历史执行结果（最近若干次），用于 flaky 判定 */
    recentResults: Array<'通过' | '失败'>;
    /** 是否有在线设备 */
    deviceOnline: boolean;
}
export interface TriageVerdict {
    decision: 'auto' | 'human';
    blockers: BlockerStage[];
    /** 面向人的阻塞原因（一句话） */
    reason: string;
    /** 需要人做什么（具体到动作） */
    question: string;
    /** 预计单次执行时长（秒，基于步骤里的等待时长 + 每步固定开销） */
    estimatedSeconds: number;
}
/** 从步骤里估算单次执行时长（秒）。 */
export declare function estimateDuration(steps: string[]): number;
export declare function classifyAutomation(input: TriageInput, opts?: {
    maxDurationSec?: number;
    flakyWindow?: number;
}): TriageVerdict;
/** 生成"需要人做什么"——必须具体到动作，否则队列就只是把问题换个地方堆着。 */
export declare function buildQuestion(blockers: BlockerStage[], input: TriageInput): string;
export interface TriageSummary {
    libraryId: number;
    libraryName: string;
    total: number;
    auto: number;
    human: number;
    byBlocker: Record<string, number>;
    queued: number;
    /** 每条用例都有明确归属：auto 或 人工队列（设计验收项） */
    unassigned: number;
}
/**
 * 跑一遍分流：为每条用例算出归属，并把"进人工队列"的落成队列条目。
 *
 * 幂等：同一用例的同一阻塞类别只保留一条 open 条目（重复分流不会把队列刷爆）；
 * **已解决的条目不会被重新打开**，除非阻塞原因发生了变化（避免人刚填完结论又被重置）。
 */
export declare function runTriage(libraryId: number, opts?: {
    maxDurationSec?: number;
}): Promise<TriageSummary>;
export interface QueueItem {
    id: number;
    libraryId: number;
    caseId: number | null;
    caseNo: string;
    caseName: string;
    stage: BlockerStage;
    reason: string;
    question: string;
    payload: Record<string, unknown>;
    status: string;
    resolution: string;
    resolvedBy: string;
    resolvedAt: string | null;
    createdAt: string;
}
export declare function loadHumanQueue(libraryId: number, status?: string): Promise<QueueItem[]>;
/**
 * 回填结论并触发下游重跑（设计 §6.7 的闭环）。
 *
 *   demo_patch   → 结论为"已批准/已完成"时提示去应用补丁（补丁应用仍需人在用例页点批准，
 *                  不在队列里静默改文件），随后重跑分流；
 *   oracle_missing → 结论里给出判据（JSON）时写入该用例的 oracle，随后重跑分流；
 *   其余         → 记录结论即可（结论将作为 P9 知识条目的来源），重跑分流。
 */
export declare function resolveQueueItem(itemId: number, resolution: string, resolvedBy?: string): Promise<{
    ok: boolean;
    item: QueueItem | null;
    requeued: boolean;
    appliedOracle: boolean;
    knowledgeId: string;
    message: string;
}>;
export interface QueueGroupLibrary {
    id: number;
    name: string;
}
/**
 * 一个「库类别 × 阻塞原因」聚合组。
 *
 * 为什么需要它：人工队列此前只能**按库逐条**看，而全量规模化的前提是
 * 「一次解决一类」——348 个库里同一类库的阻塞原因高度同构（动画库都要决策
 * .so 预编译还是现编、网络库都要配 CA），逐个库处理等于把同样的判断做 N 遍。
 * 按 (kind, stage) 聚和后，人看一组就能解决一批。
 */
export interface QueueGroup {
    /** 库类别（unknown = 该库没有 L0 画像，需先跑全量采集） */
    kind: string;
    stage: BlockerStage;
    stageLabel: string;
    /** 该组 open 条目数 */
    count: number;
    /** 涉及多少个库 */
    libraryCount: number;
    /** 涉及的库（最多列前 8 个，避免一组几百个库刷屏） */
    libraries: QueueGroupLibrary[];
    /** 代表性的「需要人做什么」（该组最近一条）——具体到动作，人看一眼就知道要干什么 */
    sampleQuestion: string;
    /** 该组最近一条的创建时间 */
    latestAt: string;
}
export interface QueueSummary {
    groups: QueueGroup[];
    totals: {
        open: number;
        groups: number;
        libraries: number;
    };
    byStage: Record<string, number>;
    byKind: Record<string, number>;
}
/**
 * 跨库聚合人工队列。
 *
 * 聚合键 = (kind, stage)：kind 来自 library_facts（L0 画像的类别判定），
 * stage 是阻塞原因。LEFT JOIN 取不到 kind 时归为 'unknown' 并如实标注——
 * 静默丢掉会让"为什么少了几条"查不出来。
 *
 * 排序：count 降序 → libraryCount 降序 → latestAt 降序。
 * 即"影响面最大的组排最前"，人最先处理收益最高。
 */
export declare function queueSummary(opts?: {
    status?: string;
    limit?: number;
}): Promise<QueueSummary>;
