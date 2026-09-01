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
    /** 控件类型（HarmonyOS: Text/Button/__Common__/XComponent…；Android: class 名） */
    type?: string;
    /** 节点归属窗口的 bundleName（HarmonyOS dumpLayout JSON 才有，用于过滤系统状态栏） */
    bundle?: string;
    /** 完整 bounds（左上/右下），用于越界检测与可视化 */
    bounds?: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
}
export interface DumpMeta {
    bundleName: string;
    pagePath: string;
}
/** 从 dump XML/JSON 解析当前页面归属（bundleName / pagePath），用于过滤非目标应用页面。 */
export declare function dumpMeta(xml: string): DumpMeta;
export interface ParseNodesOpts {
    /** 命中这些 bundleName 的窗口子树整体跳过（状态栏时钟/网速/电量等系统控件） */
    skipBundles?: ReadonlySet<string>;
}
export declare function parseNodes(dump: string, opts?: ParseNodesOpts): UiNode[];
export declare function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined;
export declare function screenSize(xml: string): {
    w: number;
    h: number;
};
export declare function tap(serial: string, x: number, y: number): Promise<string>;
export declare function keyBack(serial: string): Promise<string>;
/**
 * 抓取设备最近 N 行 hilog（失败诊断用）。
 * dry-run 的日志类断言失败时，模型需要看到「设备日志里实际有什么」才能判断是断言写错
 * 还是功能真没生效——只给一句「未匹配到」等于没给证据。
 */
export declare function tailHilog(serial: string, lines?: number): Promise<string[]>;
export declare function execShell(serial: string, shellArgs: string[]): Promise<string>;
/** aa start 参数：支持 bundle/ability、bundle、ability 三种写法。 */
export declare function launchArgs(launch: string): string[];
/** 单步执行（带超时）。导出供 dryRun 逐步执行 —— 需在失败点抓取界面证据时不能用整批 executeCaseSteps。 */
export declare function runStepWithTimeout(serial: string, desc: string, timeoutMs: number): Promise<{
    ok: boolean;
    log: string;
    durationMs: number;
}>;
/** 在真实设备上按顺序执行用例步骤（hdc / uiautomator / input）。 */
export declare function executeCaseSteps(steps: string[], serial: string, opts?: {
    perStepTimeoutMs?: number;
    launch?: string;
    screenshotDir?: string;
}): Promise<CaseRun>;
export {};
