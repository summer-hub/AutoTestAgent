// 真机 UI 遍历引擎：启动 demo → BFS 遍历页面 Layout → 收集控件/动画 → 生成用例数据
//  - 动画适配：检测 bounds 超出屏幕的大控件/动画区域，自动滑动直到完整可见
//  - 状态栏过滤：系统窗口（时钟/网速/电量）按 bundleName 子树整体丢弃 + 动态高度阈值兜底
//  - 参数配置：深度/页数/每页控件数等默认走系统配置（explore.*），调用方可覆盖
//  - 输出：页面清单（路径/控件/动画/滑动次数），供自动生成用例与 Hypium 脚本
import fs from 'node:fs';
import path from 'node:path';
import { dumpMeta, execShell, findKeyword, inputText, isSystemBundle, keyBack, launchArgs, listTargets, parseDump, parseNodes, resolveMainAbility, screenSize, tap, uiDump } from './hdc.js';
import { budgetCheck, classifyControl, CoverageTracker, coverageHealth, dedupKey, isClickCandidate, isInteractive, nodeIdentity, nodeLabel, pageSignature, } from './uiModel.js';
import { workspaceDir } from './gitRepo.js';
import { getSetting } from './settings.js';
/**
 * 采集本页控件清单：**可交互控件优先**，纯展示文本作为语义补充。
 * 旧实现只收"有文本"的节点，恰好把无文本的图标按钮整类丢掉（真机实测：219 个节点里
 * 可交互 69 个，其中 68 个无文本，全被丢弃）。
 */
function collectControls(nodes, screen, statusBarY, cap, tracker) {
    const interactive = [];
    const labels = [];
    const taken = new Set();
    for (const n of nodes) {
        if (!n.bounds)
            continue;
        const key = nodeIdentity(n);
        if (n.y <= statusBarY) { // 状态栏/导航区
            if (isInteractive(n))
                tracker.skip(key, 'offScreenContent');
            continue;
        }
        if (isClickCandidate(n, screen)) {
            if (taken.has(key)) {
                tracker.skip(key, 'duplicate');
                continue;
            }
            taken.add(key);
            interactive.push(n);
            tracker.markCollected(n);
            continue;
        }
        if (n.clickable || n.longClickable) {
            tracker.skip(key, 'fullScreenContainer');
            continue;
        }
        if (isInteractive(n)) {
            tracker.skip(key, 'notClickable');
            continue;
        }
        if ((n.text || n.desc).trim())
            labels.push(n); // 纯展示文本：入清单供语义参考，但不点击
    }
    return [...interactive, ...labels].slice(0, cap).map(toControl);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** 状态栏/系统窗口默认 bundle 清单（场景板时钟、系统 UI 网速/电量等）。 */
const DEFAULT_SYSTEM_BUNDLES = [
    'com.ohos.sceneboard',
    'com.huawei.systemui',
    'com.ohos.systemui',
    'com.android.systemui',
];
/** 系统包名过滤集合 = 默认清单 + 系统配置 explore.systemBundles（逗号分隔追加）。 */
function systemSkipBundles() {
    const s = new Set(DEFAULT_SYSTEM_BUNDLES);
    try {
        const extra = String(getSetting('explore.systemBundles', '') ?? '');
        for (const item of extra.split(/[,;，；]/).map((x) => x.trim()).filter(Boolean))
            s.add(item);
    }
    catch { /* 配置异常时只用默认清单 */ }
    return s;
}
/** 数值参数：调用方覆盖 > 系统配置 > 内置默认，并夹紧到合法区间。 */
function numOpt(value, key, def, min, max) {
    const n = Number(value ?? getSetting(key, def));
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** 控件真实尺寸（bounds 可用时），可视化按真实布局绘制。 */
function toControl(n) {
    return {
        text: n.text,
        desc: n.desc,
        x: n.x,
        y: n.y,
        w: n.bounds ? Math.max(1, n.bounds.x2 - n.bounds.x1) : 40,
        h: n.bounds ? Math.max(1, n.bounds.y2 - n.bounds.y1) : 40,
        id: n.id || n.key || n.hierarchy || '',
        kind: classifyControl(n),
        clickable: n.clickable,
        longClickable: n.longClickable,
        scrollable: n.scrollable,
        checkable: n.checkable,
        checked: n.checked,
        enabled: n.enabled,
    };
}
// 页面签名与控件指纹统一由规则层（services/uiModel.ts）提供，避免两处实现漂移。
// 旧版这里有一份本地实现：指纹 = type + 坐标分桶(100px) + 文本，坐标参与签名导致
// 连续动画页每帧都被判成新页面。规则层默认不带坐标，只保留状态（checked/selected/文本）。
/** 检测「超出屏幕」的大控件/动画区域（bounds 任一边越出屏幕即视为未完整可见）。 */
function detectOutOfScreen(nodes, sw, sh) {
    const tol = 2; // 贴边渲染的 1~2px 误差不算越界
    return nodes.find((n) => {
        if (!n.bounds)
            return n.x > sw || n.y > sh;
        return n.bounds.x1 < -tol || n.bounds.y1 < -tol || n.bounds.x2 > sw + tol || n.bounds.y2 > sh + tol;
    });
}
async function swipePage(serial, dir) {
    const xml = await uiDump(serial);
    const { w, h } = screenSize(xml);
    const cx = Math.round(w / 2);
    const cy = Math.round(h * 0.72);
    const dy = Math.round(h * 0.55);
    const fromY = dir === 'up' ? cy : Math.round(h * 0.28);
    const toY = dir === 'up' ? Math.max(0, cy - dy) : Math.min(h, fromY + dy);
    if (dir === 'up') {
        await execShell(serial, ['uinput', '-T', '-m', String(cx), String(fromY), String(cx), String(toY), '400']);
    }
    else {
        await execShell(serial, ['uinput', '-T', '-m', String(cx), String(fromY), String(cx), String(toY), '400']);
    }
    await sleep(800);
}
/**
 * BFS 遍历：从首页出发，逐个点击可交互控件进入子页面，keyBack 返回；去重页面签名。
 * 每页若存在越界控件/动画区域，自动向上滑动直到完整可见（maxSwipePerPage 次）。
 */
export async function exploreApp(serial, packageName, opts = {}) {
    const t0 = Date.now();
    // 参数优先级：调用方覆盖 > 系统配置（explore.*）> 内置默认
    const maxPages = numOpt(opts.maxPages, 'explore.maxPages', 40, 1, 200);
    // maxDepth 不再是"叶子页只采集不点击"的硬闸（那让三级页面结构性不可达），
    // 只作为安全上限；真正的限流交给预算（页数 / 时长 / 单页点击）。
    const maxDepth = numOpt(opts.maxDepth, 'explore.maxDepth', 8, 1, 20);
    // 每页控件清单上限：对所有页面统一生效（旧版只作用于首页，子页用硬编码 60，设置改了没效果）
    const controlsPerPage = numOpt(opts.controlsPerPage, 'explore.controlsPerPage', 60, 1, 300);
    const maxSwipePerPage = numOpt(opts.maxSwipePerPage, 'explore.maxSwipePerPage', 5, 0, 20);
    const maxMinutes = numOpt(opts.maxMinutes, 'explore.maxMinutes', 20, 1, 180);
    const maxClicksPerPage = numOpt(opts.maxClicksPerPage, 'explore.maxClicksPerPage', 100, 1, 500);
    // 页面签名是否含布局坐标（默认否：连续动画页每帧坐标都在变，带坐标会疯狂误判新页面）
    const signatureIncludesLayout = Boolean(getSetting('explore.signatureIncludesLayout', false));
    const budget = { maxPages, maxMinutes, maxClicksPerPage, maxSwipePerPage };
    const tracker = new CoverageTracker(budget);
    // 状态栏彻底过滤：bundleName 子树丢弃 + 屏幕高度比例阈值兜底
    const statusBarFilter = opts.statusBarFilter ?? Boolean(getSetting('explore.statusBarFilter', true));
    const skipBundles = statusBarFilter ? systemSkipBundles() : undefined;
    const parseOpts = skipBundles ? { skipBundles } : undefined;
    const visited = new Set();
    const visitedPaths = new Set();
    const pages = [];
    // ---- 操作轨迹记录器：每个真机动作/判定都留痕，随报告落盘供 UI 查询 ----
    const ops = [];
    // 过滤目标 bundle：调用方传的可能是库名而非真实 bundle（如 json-schema vs com.openharmony.jsonschemavalidator），
    // 首次 dump 识别到真实 bundleName 后升级，否则 BFS 会把目标应用页误判为「非目标」而全部跳过
    let effectiveBundle = packageName;
    const op = (action, detail) => {
        ops.push({ at: new Date().toISOString().slice(11, 23), action, detail });
        if (ops.length > 1500)
            ops.splice(0, ops.length - 1500);
        // 追加式事件埋点（全链 traceId：遍历 op 属于任务/span）
        if (opts.trace) {
            void import('./events.js').then(({ appendEvent }) => appendEvent({
                taskId: opts.trace?.taskId ?? null,
                spanId: opts.trace?.spanId ?? '',
                kind: 'explore_op',
                detail: `${action}${detail ? ` · ${detail}` : ''}`.slice(0, 500),
            }));
        }
    };
    // 遍历过程中的硬性异常（供 ExploreResult.warnings 回传给调用方）
    const warnings = [];
    let warnedSystemBundle = false;
    let warnedLaunchFail = false;
    let warnedNotForeground = false;
    /**
     * 启动参数：**优先显式 `-a <ability>`**。
     * 真机实测：`aa start -b <bundle>`（隐式启动）对不少 demo 直接失败：
     *   Error Code:10103101 Failed to find a matching application for implicit launch
     * 此时应用根本没起来，但后续 dump 可能是残留前台界面，遍历照样跑完并给出一份
     * 「看着正常」的报告 —— 这是最危险的一类假通过。所以这里解析入口 Ability 并显式启动，
     * 启动失败也直接记成 warning 上报。
     */
    let cachedStartBundle = '';
    let cachedStartArgs = null;
    const startArgsFor = async (bundle) => {
        if (cachedStartArgs && cachedStartBundle === bundle)
            return cachedStartArgs;
        const given = (opts.launchAbility || '').includes('/') ? opts.launchAbility : '';
        let args;
        if (given) {
            args = launchArgs(given);
        }
        else if (bundle.includes('.')) {
            const ab = await resolveMainAbility(serial, bundle);
            if (ab)
                op('解析入口 Ability', `${bundle} → ${ab}`);
            args = ab ? ['aa', 'start', '-b', bundle, '-a', ab] : launchArgs(bundle);
        }
        else {
            args = launchArgs(bundle);
        }
        cachedStartBundle = bundle;
        cachedStartArgs = args;
        return args;
    };
    /** 启动应用并检查 aa 的真实回显（失败时必须上报，不能静默继续）。 */
    const launchApp = async () => {
        if (effectiveBundle === packageName && isSystemBundle(packageName)) {
            // 调用方把系统包当成了目标应用（库的包名填错成桌面）→ 直接拒绝，避免跑出一份假报告
            if (!warnedSystemBundle) {
                warnedSystemBundle = true;
                warnings.push(`目标包名 ${packageName} 是系统界面（桌面/系统 UI），不是被测应用。请到「库管理」把该库的包名改成 demo 的真实 bundleName。`);
                op('拒绝启动系统界面', packageName);
            }
            return false;
        }
        const args = await startArgsFor(effectiveBundle);
        const out = await execShell(serial, args);
        const failed = /error|fail/i.test(out);
        if (failed) {
            if (!warnedLaunchFail) {
                warnedLaunchFail = true;
                const msg = `启动应用失败：${args.join(' ')} → ${out.split(/\r?\n/).slice(0, 2).join(' ').trim()}。遍历结果不可信（界面可能仍是上一次的前台残留）。`;
                warnings.push(msg);
                console.warn(`[explore] ${msg}`);
            }
            op('启动应用失败', out.split(/\r?\n/)[0]?.trim() || args.join(' '));
        }
        else {
            op('启动应用', `${args.join(' ')}（等待 3s）`);
        }
        return !failed;
    };
    const restartApp = async () => {
        op('强杀应用', effectiveBundle);
        try {
            await execShell(serial, ['aa', 'force-stop', effectiveBundle]);
        }
        catch { /* 忽略 */ }
        await launchApp();
        await sleep(3000);
    };
    // 确保从首页开始：先杀应用再启动（aa start 只切前台，不重置页面）
    await restartApp();
    const dumpCurrent = async () => {
        let xml = await uiDump(serial);
        const screen = screenSize(xml);
        let sw = 0;
        // 首次识别真实 bundleName 并升级过滤目标（调用方传的可能是库名）
        const initMeta = dumpMeta(xml);
        if (initMeta.bundleName && effectiveBundle === packageName && initMeta.bundleName !== packageName) {
            if (isSystemBundle(initMeta.bundleName)) {
                // 应用没起来（未安装 / 包名填错 / 启动失败）时，设备停桌面或系统界面。
                // 这里若把系统包名当成目标应用，后续所有节点都会被「非目标应用」过滤掉，
                // 最终返回 0 页 0 控件却看不出原因 —— 真机上踩过这个坑（识别成了 com.ohos.sceneboard）。
                if (!warnedSystemBundle) {
                    warnedSystemBundle = true;
                    const msg = `应用未成功启动：当前前台是系统界面 ${initMeta.bundleName}，已忽略它（否则整个遍历会被判为「非目标应用」而全空）。请确认库管理中该库的「包名」是否正确、对应 demo 是否已安装到设备。`;
                    warnings.push(msg);
                    console.warn(`[explore] ${msg}`);
                    op('忽略系统界面 bundleName', initMeta.bundleName);
                }
            }
            else {
                effectiveBundle = initMeta.bundleName;
                op('识别真实 bundleName', effectiveBundle);
            }
        }
        // 若不在目标应用（回到桌面/系统页），重新启动应用
        for (let i = 0; i < 2; i++) {
            const meta = dumpMeta(xml);
            if (!meta.bundleName || meta.bundleName === effectiveBundle)
                break;
            op('应用不在前台，重新拉起', meta.bundleName || 'unknown');
            await launchApp();
            await sleep(2200);
            xml = await uiDump(serial);
        }
        // 动画/内容越界 → 滑动直到完整可见
        for (let i = 0; i < maxSwipePerPage; i++) {
            const nodes = parseNodes(xml, parseOpts);
            const out = detectOutOfScreen(nodes, screen.w, screen.h);
            if (!out)
                break;
            op('上滑适配越界内容', `第 ${sw + 1} 次`);
            await swipePage(serial, 'up');
            xml = await uiDump(serial);
            sw++;
            tracker.step();
        }
        const parsedFinal = parseDump(xml, parseOpts);
        return {
            nodes: parsedFinal.nodes,
            screen,
            sw,
            meta: dumpMeta(xml),
            parsed: parsedFinal.parsed,
            parseReason: parsedFinal.reason,
        };
    };
    /**
     * 路径重放时查找控件：当前屏找不到则向下翻屏重试（目标可能在首屏之下）。
     * 找到 → 页面停留在命中位置（坐标可直接点击）；未找到 → 滑回原位再返回 undefined。
     */
    const findNodeScrollable = async (step, maxSwipes = 2) => {
        let xml = await uiDump(serial);
        let node = findKeyword(parseNodes(xml, parseOpts), step);
        let sw = 0;
        while (!node && sw < maxSwipes) {
            await swipePage(serial, 'up');
            sw++;
            xml = await uiDump(serial);
            node = findKeyword(parseNodes(xml, parseOpts), step);
        }
        if (!node && sw > 0) {
            for (let i = 0; i < sw; i++)
                await swipePage(serial, 'down');
        }
        return node;
    };
    // 状态栏动态阈值：按屏幕高度取比例（高分屏状态栏更高），兜底过滤时钟等系统文本
    const home = await dumpCurrent();
    const statusBarY = Math.max(60, Math.round(home.screen.h * 0.045));
    tracker.seeNodes(home.nodes);
    visited.add(pageSignature(home.nodes, signatureIncludesLayout));
    if (home.meta.pagePath)
        visitedPaths.add(home.meta.pagePath);
    pages.push({
        path: ['首页'],
        // 首页同样走统一策略：可交互控件 + 有文本的展示控件都入清单（不再只收文本）
        controls: collectControls(home.nodes, home.screen, statusBarY, controlsPerPage, tracker),
        screen: home.screen,
        swipes: home.sw,
        note: '首页',
    });
    // BFS 队列：{ path, depth }；只记录从首页可达的页面
    const queue = [{ path: ['首页'], depth: 0 }];
    let guard = 0;
    let stopReason = '';
    while (queue.length > 0) {
        const b = budgetCheck({ pages: pages.length, clicksOnPage: 0, steps: tracker.steps, elapsedMs: Date.now() - t0 }, budget);
        if (b.exhausted) {
            stopReason = b.reason;
            op('预算耗尽停止', b.reason);
            break;
        }
        if (guard++ > Math.max(200, maxPages * 8)) {
            stopReason = 'guard';
            op('遍历步数保护触发', `${guard}`);
            break;
        }
        const cur = queue.shift();
        if (cur.depth > maxDepth) {
            op('超过深度安全上限，跳过展开', `${cur.path.join('→')}（深度 ${cur.depth}）`);
            continue;
        }
        op('重启回目标页', `${cur.path.join('→')}（深度 ${cur.depth}）`);
        try {
            await execShell(serial, ['aa', 'force-stop', effectiveBundle]);
        }
        catch { /* 忽略 */ }
        await launchApp();
        await sleep(3000);
        // 重放点击序列（目标控件可能在首屏之下，支持翻屏查找）
        for (const step of cur.path.filter((s) => s !== '首页')) {
            const node = await findNodeScrollable(step);
            if (!node)
                break;
            op('点击（路径重放）', `「${step.slice(0, 24)}」 @(${node.x},${node.y})`);
            await tap(serial, node.x, node.y);
            await sleep(1200);
        }
        // 非目标应用页面（桌面/系统）→ 跳过本轮。
        // 旧实现这里直接 continue，一个字都不记：应用没起来时整轮遍历静默空转，
        // 报告里只剩首页那几条残留控件 —— 看起来"跑通了"，其实一个页面都没进。
        const xml = await uiDump(serial);
        const meta = dumpMeta(xml);
        if (meta.bundleName && meta.bundleName !== effectiveBundle) {
            const reason = isSystemBundle(meta.bundleName)
                ? `前台是系统界面 ${meta.bundleName}，应用未起来`
                : `前台是其它应用 ${meta.bundleName}，不是目标 ${effectiveBundle}`;
            op('跳过（非目标界面）', `${cur.path.join('→')} · ${reason}`);
            if (!warnedNotForeground) {
                warnedNotForeground = true;
                warnings.push(`遍历过程中目标应用未在前台（${reason}），该页整轮被跳过，结果不可信。`);
            }
            continue;
        }
        const curPagePath = meta.pagePath;
        /**
         * 视口步进遍历：逐屏「采集控件清单 + 点击新候选」。
         * 坐标只在当前视口有效，因此点击与采集同步推进：处理完一屏再上滑到下一屏，
         * 全部结束后滑回顶部。首屏下的回调日志区/按钮因此都能被看到、被点到。
         */
        // 本页处理记录：
        //  - seenCandidates：候选去重键（身份 + 坐标桶 + 视口）→ 同屏同名控件各算一个
        //  - inventoryKeys：已入清单的节点身份（跨视口汇总，供 Agent 看到整页全部控件）
        const seenCandidates = new Set();
        const inventoryKeys = new Set();
        const inventory = [];
        let clicked = 0; // 本页点击次数（预算维度）
        let vp = 0; // 已完成的下翻次数
        const replayToCur = async () => {
            op('重启并重放路径', `回到 ${cur.path.join('→')} 视口${vp}`);
            try {
                await execShell(serial, ['aa', 'force-stop', effectiveBundle]);
            }
            catch { /* 忽略 */ }
            await launchApp();
            await sleep(2500);
            for (const step of cur.path.filter((s) => s !== '首页')) {
                const node = await findNodeScrollable(step);
                if (!node)
                    break;
                op('点击（重放）', `「${step.slice(0, 24)}」 @(${node.x},${node.y})`);
                await tap(serial, node.x, node.y);
                await sleep(1000);
            }
            for (let i = 0; i < vp; i++) {
                await swipePage(serial, 'up');
                await sleep(300);
            } // 回到当前视口
        };
        viewportLoop: while (vp <= maxSwipePerPage) {
            const xmlVp = await uiDump(serial);
            const parsedVp = parseDump(xmlVp, parseOpts);
            const scrVp = screenSize(xmlVp);
            if (!parsedVp.parsed) {
                // 解析失败必须显式记录：旧实现返回空数组，会被当成"这页没控件"静默跳过
                tracker.noteUnparsed(parsedVp.reason ?? '未知原因');
                op('布局解析失败', `${parsedVp.format} · ${parsedVp.reason ?? ''}`);
                break;
            }
            const nodesVp = parsedVp.nodes;
            tracker.seeNodes(nodesVp);
            const yMinVp = Math.max(60, Math.round(scrVp.h * 0.045));
            const candidates = [];
            let fresh = 0;
            for (const n of nodesVp) {
                if (!n.bounds)
                    continue;
                const key = nodeIdentity(n);
                // 1) 清单收集：内容区内、且身份未收录过的节点。
                //    条件从「有文本」放宽为「有文本 **或** 是可点候选」：
                //    真机上无文本的图标/列表项控件很多（实测 219 节点里 68 个可点控件无文本），
                //    只按文本收清单会把这些控件整类从页面记录里丢掉，用例永远覆盖不到。
                if (n.y > yMinVp && !inventoryKeys.has(key) && ((n.text || n.desc).trim() || isClickCandidate(n, scrVp))) {
                    inventoryKeys.add(key);
                    inventory.push(n);
                    fresh++;
                }
                // 2) 候选判定：可交互即可，不再要求有文本
                if (n.y <= yMinVp) {
                    if (isInteractive(n))
                        tracker.skip(key, 'offScreenContent');
                    continue;
                }
                if (!isClickCandidate(n, scrVp)) {
                    if (n.clickable || n.longClickable)
                        tracker.skip(key, 'fullScreenContainer');
                    else if (isInteractive(n))
                        tracker.skip(key, 'notClickable');
                    else if (!(n.text || n.desc).trim())
                        tracker.skip(key, 'notInteractive');
                    continue;
                }
                // 导航类控件不扩展（点了会离开当前页，由返回手势统一管理）
                if (/^(返回|back|上一页|关闭|取消|X$)/i.test((n.text || n.desc).trim())) {
                    tracker.skip(key, 'navigation');
                    continue;
                }
                // 纯滚动容器不按点击处理（由视口翻屏循环覆盖）
                if (classifyControl(n) === 'scroll') {
                    tracker.skip(key, 'notClickable');
                    continue;
                }
                const dk = dedupKey(n, vp);
                if (seenCandidates.has(dk)) {
                    tracker.skip(key, 'duplicate');
                    continue;
                }
                seenCandidates.add(dk);
                candidates.push(n);
            }
            for (const c of candidates) {
                const bc = budgetCheck({ pages: pages.length, clicksOnPage: clicked, steps: tracker.steps, elapsedMs: Date.now() - t0 }, budget);
                if (bc.exhausted) {
                    stopReason = bc.reason;
                    tracker.skip(nodeIdentity(c), bc.reason === 'pages' ? 'budgetPages' : bc.reason === 'time' ? 'budgetTime' : 'budgetClicksPerPage');
                    op('预算耗尽停止', `${bc.reason}（本页剩余候选未点击）`);
                    break viewportLoop;
                }
                const label = nodeLabel(c, nodesVp);
                const kind = classifyControl(c);
                clicked++;
                tracker.step();
                tracker.markClicked(c);
                const nextPath = [...cur.path, label];
                await tap(serial, c.x, c.y);
                await sleep(1400);
                // ---- 按控件类别分派：不同类别用不同的"确认方式" ----
                if (kind === 'dropdown') {
                    // 下拉/选择器：点开 → 把展开后**新出现的可点节点回填清单**（旧实现此处只判 entered，
                    // 下拉项不是独立页面 → 判为"未进入" → 选项永远不入清单，这是选项枚举不到的直接原因）
                    const opened = parseDump(await uiDump(serial), parseOpts);
                    if (opened.parsed) {
                        let added = 0;
                        for (const n of opened.nodes) {
                            if (!n.bounds || n.y <= yMinVp)
                                continue;
                            if (!isClickCandidate(n, opened.nodes.length ? scrVp : scrVp))
                                continue;
                            const k = nodeIdentity(n);
                            if (inventoryKeys.has(k))
                                continue;
                            inventoryKeys.add(k);
                            inventory.push(n);
                            seenCandidates.add(dedupKey(n, vp)); // 展开态里的选项也不重复点击
                            added++;
                        }
                        op('下拉展开采集', `「${label}」展开后新增 ${added} 个选项/控件`);
                        tracker.step();
                    }
                    else {
                        tracker.noteUnparsed(opened.reason ?? '下拉展开 dump 解析失败');
                    }
                    await keyBack(serial);
                    await sleep(700);
                    continue;
                }
                if (kind === 'checkbox' || kind === 'switch') {
                    // 复选/开关：记录切换后的状态，再点回原状态（双向都要覆盖，且不改变页面初始态）
                    const after = parseDump(await uiDump(serial), parseOpts);
                    if (after.parsed) {
                        const same = after.nodes.find((n) => nodeIdentity(n) === nodeIdentity(c));
                        op('开关状态切换', `「${label}」checked ${c.checked ? 'true' : 'false'} → ${same ? (same.checked ? 'true' : 'false') : '未知'}`);
                        for (const n of after.nodes) {
                            if (!n.bounds || n.y <= yMinVp)
                                continue;
                            if (!(n.text || n.desc).trim() && !isInteractive(n))
                                continue;
                            const k = nodeIdentity(n);
                            if (inventoryKeys.has(k))
                                continue;
                            inventoryKeys.add(k);
                            inventory.push(n);
                        }
                    }
                    tracker.step();
                    await tap(serial, c.x, c.y); // 复位
                    await sleep(700);
                    continue;
                }
                if (kind === 'input') {
                    // 输入框：聚焦后输入探针文本，采集"输入后出现的内容"（校验提示/计数/回显），再清空。
                    // 真实的空值/边界/超长输入由用例阶段驱动；这里只做一次存在性与回显确认。
                    try {
                        await inputText(serial, 'AutoTest');
                        await sleep(800);
                        const after = parseDump(await uiDump(serial), parseOpts);
                        if (after.parsed) {
                            let added = 0;
                            for (const n of after.nodes) {
                                if (!n.bounds || n.y <= yMinVp)
                                    continue;
                                if (!(n.text || n.desc).trim())
                                    continue;
                                const k = nodeIdentity(n);
                                if (inventoryKeys.has(k))
                                    continue;
                                inventoryKeys.add(k);
                                inventory.push(n);
                                added++;
                            }
                            op('输入探针采集', `「${label}」输入后新增 ${added} 条文本（回显/提示）`);
                        }
                        tracker.step();
                    }
                    catch (e) {
                        op('输入探针失败', `${e.message.slice(0, 120)}`);
                    }
                    continue; // 输入不改页面结构，不需要 entered 判定
                }
                // ---- 普通可点击控件：进入判定（原有逻辑）----
                const sub = await dumpCurrent();
                tracker.step();
                if (!sub.parsed) {
                    tracker.noteUnparsed(sub.parseReason ?? '子页面 dump 解析失败');
                    op('子页面解析失败', `${sub.parseReason ?? ''}`);
                    continue;
                }
                tracker.seeNodes(sub.nodes);
                const sig = pageSignature(sub.nodes, signatureIncludesLayout);
                const pathKey = sub.meta.pagePath || sig;
                const bundleOk = !sub.meta.bundleName || sub.meta.bundleName === effectiveBundle;
                const entered = !visited.has(sig) && !visitedPaths.has(pathKey) && sub.nodes.length > 0 && bundleOk;
                op('进入判定', `点击「${label}」(${kind}) → ${entered ? '进入新页面' : bundleOk ? '未进入（无导航/已访问）' : '离开目标应用'} · pagePath=${sub.meta.pagePath || '—'}`);
                console.log(`[explore] ${cur.path.join('→')} 点击「${label}」(${kind},视口${vp}) → entered=${entered} nodes=${sub.nodes.length}`);
                if (entered) {
                    visited.add(sig);
                    visitedPaths.add(pathKey);
                    const anim = detectOutOfScreen(sub.nodes, sub.screen.w, sub.screen.h);
                    pages.push({
                        path: nextPath,
                        controls: collectControls(sub.nodes, sub.screen, Math.max(60, Math.round(sub.screen.h * 0.045)), controlsPerPage, tracker),
                        screen: sub.screen,
                        swipes: sub.sw,
                        animation: anim ? { x: anim.x, y: anim.y, w: anim.bounds ? Math.max(1, anim.bounds.x2 - anim.bounds.x1) : 40, h: anim.bounds ? Math.max(1, anim.bounds.y2 - anim.bounds.y1) : 40 } : undefined,
                        note: anim ? '检测到越界动画/内容，已自动滑动适配' : '页面正常',
                    });
                    queue.push({ path: nextPath, depth: cur.depth + 1 });
                    op('收录页面', `${nextPath.join(' → ')} · 控件 ${pages[pages.length - 1]?.controls.length ?? 0} 个${sub.sw ? ` · 适配滑动 ${sub.sw}` : ''}`);
                    // 返回列表页（边缘返回手势），滚动位置保持 → 本视口剩余候选坐标仍有效
                    op('边缘返回手势');
                    await keyBack(serial);
                    await sleep(1000);
                }
                else if (sub.meta.pagePath !== curPagePath) {
                    // 页面变了但已访问 → 重启并重放路径回当前页 + 当前视口
                    await replayToCur();
                }
            }
            if (fresh === 0)
                break; // 本屏无新内容 → 已到底/不可滚动
            op('上滑翻屏', `视口${vp} → ${vp + 1}（本屏新增 ${fresh} 个控件）`);
            await swipePage(serial, 'up');
            tracker.step();
            vp++;
        }
        // 滑回顶部，下一轮从已知位置开始
        if (vp > 0)
            op('下滑回顶', `${vp} 屏 · 本页累计控件清单 ${Math.min(inventory.length, controlsPerPage)} 条`);
        for (let i = 0; i < vp; i++) {
            await swipePage(serial, 'down');
            tracker.step();
        }
        // 完整控件清单回填本页记录（含首屏下内容），Agent / 用例预期据此覆盖全部按钮与回调输出。
        // 注意是**合并**而不是覆盖：旧实现直接用 inventory 替换 selfPage.controls，而 inventory
        // 只收有文本的节点，结果把本页无文本的可点控件（列表项/图标按钮）又从页面记录里抹掉了
        // —— 实测首页 8 个可点列表项被抹成「8 个纯文本、0 个可交互」。
        const selfPage = pages.find((p) => p.path.length === cur.path.length && p.path.every((s, i) => s === cur.path[i]));
        if (selfPage && inventory.length > 0) {
            const ctlKey = (c) => c.id || `${c.text}|${c.desc}|${c.x},${c.y}`;
            const byKey = new Map();
            for (const c of selfPage.controls)
                byKey.set(ctlKey(c), c);
            const ordered = [
                ...inventory.filter((n) => isClickCandidate(n, selfPage.screen)),
                ...inventory.filter((n) => !isClickCandidate(n, selfPage.screen)),
            ].map(toControl);
            for (const c of ordered)
                if (!byKey.has(ctlKey(c)))
                    byKey.set(ctlKey(c), c);
            // 可交互优先，保持 Agent 看到"能点的在前"
            const all = [...byKey.values()];
            const finalList = [
                ...all.filter((c) => c.clickable || c.longClickable || c.checkable),
                ...all.filter((c) => !(c.clickable || c.longClickable || c.checkable)),
            ].slice(0, controlsPerPage);
            selfPage.controls = finalList;
            for (const n of inventory)
                tracker.markCollected(n);
            if (vp > 0) {
                selfPage.scrolls = vp;
                selfPage.note += `${selfPage.note ? '；' : ''}滚动探索 ${vp} 屏 · 控件清单含首屏下内容`;
            }
        }
    }
    const result = {
        packageName,
        serial,
        pages,
        visitedCount: visited.size,
        durationMs: Date.now() - t0,
        ops,
        coverage: tracker.report({ pages: pages.length, durationMs: Date.now() - t0, stopReason: stopReason || 'queueDrained' }),
        warnings,
    };
    const health = coverageHealth(result.coverage);
    if (pages.length === 0) {
        warnings.push(`遍历未收录任何页面（目标 bundle=${effectiveBundle}）。常见原因：应用未安装 / 库的包名不对 / 启动后停在系统界面。`);
    }
    result.warnings = warnings;
    if (!health.ok) {
        for (const w of health.warnings)
            console.warn(`[explore] 覆盖率告警：${w}`);
        op('覆盖率告警', health.warnings.join('；'));
    }
    else {
        op('覆盖率报告', `页面 ${result.coverage.pages} · 交互控件 ${result.coverage.interactive.discovered}（点击 ${result.coverage.interactive.clicked} / 收录 ${result.coverage.interactive.collected}）`);
    }
    return result;
}
/** 保存遍历报告（JSON）到 workspace/explore/<lib>/。 */
export function saveExploreReport(libName, result) {
    const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `explore_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    return file;
}
/** 校验设备在线。 */
export async function ensureDeviceOnline(serial) {
    try {
        const targets = await listTargets();
        return targets.includes(serial);
    }
    catch {
        return false;
    }
}
