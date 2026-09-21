export interface TaskTokenUsage {
    tokensIn: number;
    tokensOut: number;
    total: number;
}
/** 汇总某任务已消耗的 token（无埋点行时返回 0）。 */
export declare function taskTokenUsage(taskId: number): Promise<TaskTokenUsage>;
/** 预算上限（0 = 不限制）。 */
export declare function taskTokenBudget(): number;
/**
 * 调用前检查：超出预算直接抛错，让任务失败留痕，而不是继续烧额度。
 * 未带 taskId 的调用（分析 / 追问等非任务入口）不设闸门。
 */
export declare function ensureTaskTokenBudget(taskId?: number): Promise<void>;
