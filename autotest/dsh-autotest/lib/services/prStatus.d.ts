export type PrDerivedStatus = 'untested' | 'testing' | 'passed' | 'failed' | 'partial';
export interface PrTestStatus {
    status: PrDerivedStatus;
    baselineCount: number;
    runItemCount: number;
    executionCount: number;
    passedCount: number;
    failedCount: number;
    lastRunAt: string;
}
/** 从关联基线派生 PR 测试状态（§7.3）。无基线/无执行如实 untested，不伪造。 */
export declare function derivePrTestStatus(prId: number): Promise<PrTestStatus>;
