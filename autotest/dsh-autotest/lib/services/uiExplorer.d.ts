export interface ExploredControl {
    text: string;
    desc: string;
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface ExploredPage {
    path: string[];
    controls: ExploredControl[];
    screen: {
        w: number;
        h: number;
    };
    swipes: number;
    animation?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    note: string;
}
export interface ExploreResult {
    packageName: string;
    serial: string;
    pages: ExploredPage[];
    visitedCount: number;
    durationMs: number;
}
export interface ExploreOpts {
    maxPages?: number;
    maxDepth?: number;
    controlsPerPage?: number;
    maxSwipePerPage?: number;
    launchAbility?: string;
}
/**
 * BFS 遍历：从首页出发，逐个点击可交互控件进入子页面，keyBack 返回；去重页面签名。
 * 每页若存在越界控件/动画区域，自动向上滑动直到完整可见（maxSwipePerPage 次）。
 */
export declare function exploreApp(serial: string, packageName: string, opts?: ExploreOpts): Promise<ExploreResult>;
/** 保存遍历报告（JSON）到 workspace/explore/<lib>/。 */
export declare function saveExploreReport(libName: string, result: ExploreResult): string;
/** 校验设备在线。 */
export declare function ensureDeviceOnline(serial: string): Promise<boolean>;
