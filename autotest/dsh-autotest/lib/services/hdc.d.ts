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
export declare function uiDump(serial: string): Promise<string>;
interface UiNode {
    text: string;
    desc: string;
    x: number;
    y: number;
}
export interface DumpMeta {
    bundleName: string;
    pagePath: string;
}
/** 从 dump XML/JSON 解析当前页面归属（bundleName / pagePath），用于过滤非目标应用页面。 */
export declare function dumpMeta(xml: string): DumpMeta;
export declare function parseNodes(dump: string): UiNode[];
export declare function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined;
export declare function screenSize(xml: string): {
    w: number;
    h: number;
};
export declare function tap(serial: string, x: number, y: number): Promise<string>;
export declare function keyBack(serial: string): Promise<string>;
export declare function execShell(serial: string, shellArgs: string[]): Promise<string>;
/** aa start 参数：支持 bundle/ability、bundle、ability 三种写法。 */
export declare function launchArgs(launch: string): string[];
/** 在真实设备上按顺序执行用例步骤（hdc / uiautomator / input）。 */
export declare function executeCaseSteps(steps: string[], serial: string, opts?: {
    perStepTimeoutMs?: number;
    launch?: string;
    screenshotDir?: string;
}): Promise<CaseRun>;
export {};
