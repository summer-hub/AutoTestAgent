// 真机遍历证据的装载（P1 的报告 → 路由/控件/面包屑索引）。
//
// 单独成文件的原因：覆盖矩阵（P3）与用例关联（P11）都要用它，而关联层又被矩阵调用 ——
// 留在 coverageMatrix.ts 里会形成模块循环依赖。这个文件只依赖 gitRepo（工作区路径），
// 谁都能安全引用。
//
// 关键背景：同一页在两处的写法不同 ——
//   · 符号的 demo 调用点记的是**路由名**（`pages/Y`，来自源码扫描）；
//   · 遍历产出的用例记的是**点击路径面包屑**（`首页 → Y`，来自真机操作轨迹）。
// 不把这两种写法对上，就永远无法知道"这条初版用例落在哪个接口的页面上"。
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './gitRepo.js';
/**
 * 从 P1 的遍历报告里取出「路由 → 该页控件文本」。
 *
 * 报告里页面记录用的是点击路径（人看得懂），而路由名在操作轨迹的
 * `进入判定 · 点击「X」→ 进入新页面 · pagePath=pages/Y` 这条 op 里。
 * 两者拼起来才能把 demo 源码里的 `pages/SimpleValidatePage` 对上真机页面。
 */
export function loadTraversalEvidence(libName) {
    const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
    if (!fs.existsSync(dir))
        return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0)
        return null;
    const file = path.join(dir, files[files.length - 1]);
    let report;
    try {
        report = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
    // 从操作轨迹取出「点击的控件标签 → 路由名」。
    const labelToRoute = new Map();
    for (const op of report.ops ?? []) {
        const m = /点击「(.+?)」[^]*?→ 进入新页面 · pagePath=(\S+)/.exec(String(op.detail ?? ''));
        if (m)
            labelToRoute.set(m[1], m[2]);
    }
    const routes = new Map();
    const allControls = new Set();
    const breadcrumbToRoute = new Map();
    for (const p of report.pages ?? []) {
        const pageControls = (p.controls ?? [])
            .map((c) => String(c.text || c.desc || '').trim())
            .filter((s) => s.length > 1 && s.length < 40);
        for (const c of pageControls)
            allControls.add(c);
        const labels = p.path ?? [];
        const last = labels.length > 1 ? labels[labels.length - 1] : '';
        const route = labelToRoute.get(last);
        if (!route)
            continue; // 首页等没有路由名的页面不进 routes，但控件已进 allControls
        const prev = routes.get(route);
        const merged = [...new Set([...(prev?.controls ?? []), ...pageControls])].slice(0, 40);
        routes.set(route, { controls: merged, path: labels });
        if (labels.length > 0)
            breadcrumbToRoute.set(labels.join(' → '), route);
    }
    return { reportFile: file, routes, allControls: [...allControls], breadcrumbToRoute };
}
/** 从遍历证据里取某页的控件清单（找不到就返回空数组，绝不编造）。 */
export function controlsOfPage(ev, route) {
    if (!ev || !route)
        return [];
    return ev.routes.get(route)?.controls ?? [];
}
