export declare function hdcAvailable(): Promise<boolean>;
export declare function listTargets(): Promise<string[]>;
export declare function deviceInfo(serial: string): Promise<{
    model: string;
    osVersion: string;
}>;
export interface RealStep {
    seq: number;
    desc: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    log: string;
}
export interface CaseRun {
    steps: RealStep[];
    logs: string[];
    passed: boolean;
}
/** 在真实设备上按顺序执行用例步骤（hdc / uiautomator / input）。 */
export declare function executeCaseSteps(steps: string[], serial: string, opts?: {
    perStepTimeoutMs?: number;
}): Promise<CaseRun>;
