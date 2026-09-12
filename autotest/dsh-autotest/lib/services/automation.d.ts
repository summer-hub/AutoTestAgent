export type BlockerStage = 'demo_patch' | 'oracle_missing' | 'external_dep' | 'animation' | 'video' | 'flaky' | 'device_blocked' | 'long_running' | 'untestable';
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
