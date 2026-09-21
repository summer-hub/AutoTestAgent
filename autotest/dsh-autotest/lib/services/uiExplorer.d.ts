import { type ControlKind, type CoverageReport } from './uiModel.js';
export interface ExploredControl {
    text: string;
    desc: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** 节点稳定标识（dumpLayout 的 id / key / hierarchy），用于后续按 ID 定位而非坐标 */
    id: string;
    /** 控件类别（决定可执行的交互方式：点击 / 输入 / 展开 / 勾选…） */
    kind: ControlKind;
    clickable: boolean;
    longClickable: boolean;
    scrollable: boolean;
    checkable: boolean;
    checked: boolean;
    /** 是否可用（enabled=false 的控件不参与用例） */
    enabled: boolean;
}
export interface ExploredPage {
    path: string[];
    controls: ExploredControl[];
    screen: {
        w: number;
        h: number;
    };
    swipes: number;
    scrolls?: number;
    animation?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    note: string;
}
export interface ExploredOp {
    at: string;
    action: string;
    detail?: string;
}
export interface ExploreResult {
    packageName: string;
    serial: string;
    pages: ExploredPage[];
    visitedCount: number;
    durationMs: number;
    /** 真机操作轨迹（每次设备/判定动作一条，供 UI 回溯查询） */
    ops: ExploredOp[];
    /**
     * 覆盖率报告：发现/点击/收录 + 每条未处理的原因 + 解析失败次数。
     * 没有它，"覆盖够不够"是不可证伪的（这正是旧版最大的问题）。
     */
    coverage: CoverageReport;
    /**
     * 遍历过程中的硬性异常（应用没起来、前台停在系统界面等）。
     * 这些情况下 pages 可能为空或严重偏少，必须显式告诉调用方，不能静默返回一份"看起来正常"的报告。
     */
    warnings: string[];
}
export interface ExploreOpts {
    maxPages?: number;
    maxDepth?: number;
    controlsPerPage?: number;
    maxSwipePerPage?: number;
    /** 单次遍历时长上限（分钟） */
    maxMinutes?: number;
    /** 单页点击上限 */
    maxClicksPerPage?: number;
    launchAbility?: string;
    statusBarFilter?: boolean;
    /** 链路追踪上下文：把遍历 op 写入 agent_events（kind=explore_op） */
    trace?: {
        taskId?: number;
        spanId?: string;
    };
    /** 任务级取消信号：中断在途 hdc 子进程，BFS 循环间隙及时收手 */
    signal?: AbortSignal;
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
