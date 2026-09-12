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
export interface NodeBounds {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}
/**
 * UI 节点。
 * HarmonyOS 的 `uitest dumpLayout` 原生就带全套交互标志（clickable / longClickable /
 * scrollable / checkable / checked / enabled / selected / visible）与稳定标识（id / key /
 * accessibilityId / hierarchy）。旧版只读 text/description/bounds/type，把这些全丢了，
 * 直接导致「图标按钮整类丢失」与「靠文本猜可点击性」。这里全部保留。
 */
export interface UiNode {
    /** 稳定标识：HarmonyOS 取 id > key > accessibilityId（常为空，用 fallbackKey 兜底） */
    id: string;
    /** 运行时 key（同一 id 的多个实例靠它区分） */
    key: string;
    text: string;
    desc: string;
    hint: string;
    x: number;
    y: number;
    /** 控件类型（HarmonyOS: Text/Button/Scroll/Row…；Android: class 名） */
    type?: string;
    /** 节点归属窗口的 bundleName（用于过滤系统状态栏/桌面） */
    bundle?: string;
    /** 完整 bounds（左上/右下），用于越界检测与可视化 */
    bounds?: NodeBounds;
    /** 节点所属页面路由（dumpLayout 的 pagePath） */
    pagePath: string;
    /** 窗口 ID（多窗口/弹窗场景用于区分） */
    windowId: string;
    /** 层级路径（dumpLayout 的 hierarchy），用于结构指纹 */
    hierarchy: string;
    clickable: boolean;
    longClickable: boolean;
    scrollable: boolean;
    checkable: boolean;
    checked: boolean;
    selected: boolean;
    enabled: boolean;
    visible: boolean;
}
/** 解析 bounds："[0,124][1260,2720]" → {x1,y1,x2,y2}；非法返回 null。 */
export declare function parseBounds(raw: unknown): NodeBounds | null;
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
export interface ParsedDump {
    nodes: UiNode[];
    /** 是否成功解析（false = 格式不认识/解析失败，调用方必须与"空页面"区分开） */
    parsed: boolean;
    /** 解析失败原因（供告警与覆盖率报告） */
    reason?: string;
    /** 识别到的格式 */
    format: 'harmony-json' | 'android-xml' | 'unknown';
}
/**
 * 解析 UI dump（HarmonyOS dumpLayout JSON 或 Android uiautomator XML）。
 * 与旧版的区别：
 *  - 不再要求「有文本」——无文本但可交互的节点（图标按钮）同样返回；
 *  - 保留全部交互标志与稳定标识；
 *  - 解析失败**显式回报**，不再静默返回空数组（旧版无法区分"空页面"与"解析失败"）。
 */
export declare function parseDump(dump: string, opts?: ParseNodesOpts): ParsedDump;
/**
 * 兼容旧签名：只取节点数组。
 * ⚠️ 需要区分"解析失败"与"空页面"时请直接用 `parseDump()`。
 */
export declare function parseNodes(dump: string, opts?: ParseNodesOpts): UiNode[];
export declare function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined;
export declare function screenSize(xml: string): {
    w: number;
    h: number;
};
export declare function tap(serial: string, x: number, y: number): Promise<string>;
export declare function inputText(serial: string, text: string): Promise<string>;
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
/**
 * 从 `bm dump -n <bundle>` 输出里解析入口 Ability。
 * 真机实测（ALN-AL00）：该输出**没有** mainElementName 字段，只有 abilities 数组，
 * 里面第一个 "name" 就是入口 Ability（如 EntryAbility）。优先 mainElementName 以兼容有该字段的版本。
 */
export declare function parseMainAbility(dump: string): string;
/**
 * 查入口 Ability。**必须显式带 -a 启动**：真机上 `aa start -b <bundle>`（隐式启动）
 * 对很多 demo 直接返回 10103101「Failed to find a matching application for implicit launch」，
 * 应用根本没起来 —— 遍历却会照常跑完并给出一份看着正常的报告（真机上正是这么骗过验收的）。
 */
export declare function resolveMainAbility(serial: string, bundle: string): Promise<string>;
/** 是否是系统/桌面类包（这类 bundle 出现了就说明被测应用没在前台）。 */
export declare function isSystemBundle(bundle: string): boolean;
/**
 * 按库名在设备已安装应用里模糊匹配候选 bundleName，并回填入口 Ability。
 * 用途：库没拉过仓库时 package_name 为空，真机遍历 `aa start` 会失败 → 这里帮人自动认出来。
 * 两条命令都走 argv 数组，无注入面。
 */
export declare function guessBundleFor(serial: string, libName: string): Promise<Array<{
    bundleName: string;
    mainAbility: string;
}>>;
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
