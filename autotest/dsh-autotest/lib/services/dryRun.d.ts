export interface DryRunStep {
    seq: number;
    desc: string;
    status: 'passed' | 'failed' | 'skipped';
    log: string;
    durationMs: number;
    /** 失败时刻界面的真实可见控件文本 —— 回灌修复的关键证据 */
    visibleControls?: string[];
    /** 失败时刻设备最近日志 —— 日志类断言失败时的关键证据 */
    hilogTail?: string[];
}
export interface DryRunResult {
    passed: boolean;
    steps: DryRunStep[];
    logs: string[];
    /** 结构化失败摘要，可直接作为 LLM 的修复输入；通过时为空串 */
    failureBrief: string;
    firstFailureAt?: number;
}
/**
 * 在设备上 dry-run 单条用例。
 * 失败后默认继续跑完（一次收集全部失败点），但连续失败达 failStreakStop 步后停止——
 * 此时界面已偏离预期，后续步骤的失败原因不可信，继续跑只是浪费设备时间。
 */
export declare function dryRunCase(caseNo: string, caseName: string, steps: string[], serial: string, opts?: {
    launch?: string;
    perStepTimeoutMs?: number;
    failStreakStop?: number;
    trace?: {
        taskId?: number;
        spanId?: string;
    };
}): Promise<DryRunResult>;
/** 汇总多条用例的 dry-run 结果，产出一次性回灌给 LLM 的修复简报。 */
export declare function mergeFailureBriefs(results: Array<{
    caseNo: string;
    name: string;
    brief: string;
}>): string;
