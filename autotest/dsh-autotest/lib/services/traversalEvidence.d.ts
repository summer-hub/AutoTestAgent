export interface TraversalEvidence {
    reportFile: string;
    routes: Map<string, {
        controls: string[];
        path: string[];
    }>;
    /**
     * 本次遍历**所有页面**收集到的控件文本（含首页入口项）。
     * 判定"用例步骤里引用的控件在真机上是否存在"必须用它：用例通常先点首页入口再点目标页按钮，
     * 而首页在 routes 里没有路由名（它不是"被进入"的页面），只用 routes 会把首页入口判成不存在。
     */
    allControls: string[];
    /** P11：页面**面包屑 → 路由名**（用遍历报告自身的 path 字段建立映射）。 */
    breadcrumbToRoute: Map<string, string>;
}
/**
 * 从 P1 的遍历报告里取出「路由 → 该页控件文本」。
 *
 * 报告里页面记录用的是点击路径（人看得懂），而路由名在操作轨迹的
 * `进入判定 · 点击「X」→ 进入新页面 · pagePath=pages/Y` 这条 op 里。
 * 两者拼起来才能把 demo 源码里的 `pages/SimpleValidatePage` 对上真机页面。
 */
export declare function loadTraversalEvidence(libName: string): TraversalEvidence | null;
/** 从遍历证据里取某页的控件清单（找不到就返回空数组，绝不编造）。 */
export declare function controlsOfPage(ev: TraversalEvidence | null, route: string): string[];
