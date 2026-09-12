/** 注销单个计划的定时任务（删除计划 / 计划改为非定时时调用）。 */
export declare function unregisterScheduledPlan(planId: number): void;
/** 停止全部定时任务与常驻轮询（插件卸载时调用，避免重载后任务叠加）。 */
export declare function stopAllSchedulers(): void;
export declare function startScheduler(): Promise<void>;
export declare function registerScheduledPlan(planId: number, cronExpr: string): void;
