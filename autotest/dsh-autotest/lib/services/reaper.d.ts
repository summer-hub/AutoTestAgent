export interface ReapResult {
    tasks: number;
    plans: number;
}
/** 把残留的运行中任务/计划标记为中断，返回清理行数。 */
export declare function reapStaleRuns(opts?: {
    maxIdleMinutes?: number;
    reason?: string;
}): Promise<ReapResult>;
/** 启动清理：清理上一次进程遗留的 running（本进程内不可能有正在跑的任务）。 */
export declare function reapOnStartup(): Promise<ReapResult>;
