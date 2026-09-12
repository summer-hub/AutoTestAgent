// ---------- 可交互判定 ----------
/**
 * 是否可交互。
 * 判据只用 dump 自带的标志，**不看有没有文本** —— 图标按钮、图片按钮都无文本但 clickable=true，
 * 旧实现要求「有文本」，恰好把真实控件全丢掉、留下不可点的 Text。
 */
export function isInteractive(n) {
    if (!n.enabled || !n.visible)
        return false;
    return n.clickable || n.longClickable || n.checkable || n.scrollable;
}
/** 是否可点击（scroll 单独处理，不按点击算）。 */
export function isClickable(n) {
    return n.enabled && n.visible && (n.clickable || n.longClickable || n.checkable);
}
/**
 * 是否值得作为点击候选。
 * 排除整屏容器：dump 里 WindowScene / Dialog 之类的根容器也标了 clickable=true，
 * 点它们等于点空白（还会被当成"未进入新页面"白白消耗预算）。
 */
export function isClickCandidate(n, screen) {
    if (!isClickable(n))
        return false;
    if (!n.bounds)
        return false;
    if (n.bounds.x2 - n.bounds.x1 <= 1 || n.bounds.y2 - n.bounds.y1 <= 1)
        return false; // 零尺寸
    if (screen && screen.w > 0 && screen.h > 0) {
        const area = (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1);
        const screenArea = screen.w * screen.h;
        if (area / screenArea >= 0.9)
            return false; // 整屏容器（对话框背景等）
    }
    return true;
}
// ---------- 标识与去重 ----------
/** 稳定身份：id > key > hierarchy > (type + 文本)。无文本控件靠 hierarchy/key 区分。 */
export function nodeIdentity(n) {
    if (n.id)
        return `id:${n.id}`;
    if (n.key)
        return `key:${n.key}`;
    if (n.hierarchy)
        return `h:${n.hierarchy}`;
    const label = (n.text || n.desc).trim().slice(0, 24);
    return `t:${n.type ?? '?'}:${label}`;
}
/** 坐标分桶（100px 网格）。 */
export function coordBucket(x, y) {
    return `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
}
/**
 * 去重键：身份 + 坐标桶 + 视口序号。
 * 旧实现只按 `label.slice(0,24)` 去重，导致同屏两个「确定」只点一个；
 * 加入坐标桶后同名控件各算一个（修复"同名控件只采到第一个"）。
 */
export function dedupKey(n, viewport = 0) {
    return `${nodeIdentity(n)}@vp${viewport}:${coordBucket(n.x, n.y)}`;
}
// ---------- 控件分类 ----------
const KIND_BY_TYPE = [
    [/TextInput|TextArea|TextField|SearchField|Search$/i, 'input'],
    [/Select|Dropdown|ComboBox|Picker|Spinner/i, 'dropdown'],
    [/Checkbox|CheckBox/i, 'checkbox'],
    [/Toggle|Switch/i, 'switch'],
    [/TabBar|TabContent|Tabs?\b/i, 'tab'],
    [/Scroll|List|Grid|Swiper|WaterFlow/i, 'scroll'],
    [/Button|IconButton/i, 'button'],
    [/Text|SymbolGlyph|Label/i, 'text'],
];
/** 控件分类（静态启发式；运行时还会按展开行为二次修正为 dropdown）。 */
export function classifyControl(n) {
    const type = n.type ?? '';
    if (n.checkable) {
        if (/Toggle|Switch/i.test(type))
            return 'switch';
        return 'checkbox';
    }
    for (const [re, kind] of KIND_BY_TYPE) {
        if (re.test(type)) {
            // Text/Image 若本身可点击，按按钮处理（可点击文本就是最典型的按钮）
            if (kind === 'text' && (n.clickable || n.longClickable))
                return 'button';
            if (kind === 'scroll')
                return n.scrollable ? 'scroll' : 'other';
            return kind;
        }
    }
    if (n.scrollable)
        return 'scroll';
    if (n.clickable || n.longClickable)
        return 'button';
    return (n.text || n.desc).trim() ? 'text' : 'other';
}
/** 节点面积（用于"取最小的包含子节点"），无 bounds 返回 Infinity。 */
function nodeArea(n) {
    if (!n.bounds)
        return Number.POSITIVE_INFINITY;
    return (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1);
}
/**
 * 供人阅读的控件标签（无文本时用**几何包含的子节点文本**兜底，再退到类型/ID）。
 * `all` 传本页全部节点时，无文本容器（ListItem/Row/图标按钮）会用子节点文本命名。
 * 真机上列表项自身没文本、文本都在子节点上，只用类型兜底会让每个页面标签都叫「[ListItem]」
 * —— 实测 9 个不同页面标签完全相同：用例里区分不出点的是哪个入口，
 * 而且路径重放靠标签找控件，标签重名会导致重放点到错误的项。
 */
export function nodeLabel(n, all = []) {
    const t = (n.text || n.desc).trim();
    if (t)
        return t.slice(0, 24);
    if (all.length && n.bounds) {
        const nb = n.bounds;
        const inside = all
            .filter((c) => c !== n && c.bounds && (c.text || c.desc).trim()
            && c.bounds.x1 >= nb.x1 && c.bounds.y1 >= nb.y1 && c.bounds.x2 <= nb.x2 && c.bounds.y2 <= nb.y2)
            .sort((a, b) => nodeArea(a) - nodeArea(b));
        const texts = [];
        for (const c of inside) {
            const ct = (c.text || c.desc).trim();
            if (ct && !texts.includes(ct))
                texts.push(ct);
            if (texts.length >= 2)
                break;
        }
        if (texts.length)
            return texts.join(' ').slice(0, 24);
    }
    if (n.id)
        return `[${n.type ?? '控件'}#${n.id}]`;
    return `[${n.type ?? '未知控件'}]`;
}
// ---------- 页面指纹 ----------
/**
 * 节点指纹：类型 + 身份 + 文本 + 交互状态。
 * 默认**不含坐标**：连续动画页每帧坐标都在变，带坐标会把每一帧判成新页面（既漏又慢）；
 * 而状态区分（勾选/选中/Tab）由 checked/selected/text 承担。
 * 需要旧行为（对布局敏感）时把 includeLayout 打开。
 */
export function nodeFingerprint(n, includeLayout = false) {
    const state = `${n.checked ? 'c' : '-'}${n.selected ? 's' : '-'}`;
    const base = `${n.type ?? '?'}|${nodeIdentity(n)}|${(n.text || n.desc).trim().slice(0, 24)}|${state}`;
    return includeLayout && n.bounds ? `${base}|${coordBucket(n.x, n.y)}` : base;
}
/** 页面签名：全部节点指纹去重排序拼接。纯展示节点也参与（它们构成页面结构）。 */
export function pageSignature(nodes, includeLayout = false) {
    return [...new Set(nodes.map((n) => nodeFingerprint(n, includeLayout)).filter(Boolean))].sort().join('\n');
}
/**
 * 预算检查：**任一维度耗尽即停**，并给出可展示的原因。
 * 取代旧的 `maxDepth` 硬闸（深度只作排序偏好）：旧的深度限制让"子页面的子页面"结构性不可达。
 */
export function budgetCheck(state, budget) {
    if (state.pages >= budget.maxPages)
        return { exhausted: true, reason: 'pages' };
    if (state.elapsedMs >= budget.maxMinutes * 60_000)
        return { exhausted: true, reason: 'time' };
    if (state.clicksOnPage >= budget.maxClicksPerPage)
        return { exhausted: true, reason: 'clicksPerPage' };
    return { exhausted: false, reason: '' };
}
/** 覆盖率累加器：遍历过程中持续记录，结束时产出可解释的报告。 */
export class CoverageTracker {
    budget;
    nodesSeen = 0;
    stepCount = 0;
    discovered = new Set();
    clicked = new Set();
    collected = new Set();
    skipped = {};
    unparsedDumps = 0;
    unparsedReasons = [];
    constructor(budget) {
        this.budget = budget;
    }
    /** 已执行的动作步数（遍历用它做预算判断）。 */
    get steps() { return this.stepCount; }
    /** 已收录页面数（由调用方在 report 时传入，这里只提供步数）。 */
    get discoveredCount() { return this.discovered.size; }
    /** 记录一次 dump 的全部节点。 */
    seeNodes(nodes, interactiveOf = isInteractive) {
        this.nodesSeen += nodes.length;
        for (const n of nodes) {
            if (interactiveOf(n))
                this.discovered.add(nodeIdentity(n));
        }
    }
    step() { this.stepCount++; }
    markClicked(n) {
        const k = nodeIdentity(n);
        this.clicked.add(k);
        this.discovered.add(k);
    }
    markCollected(n) {
        this.collected.add(nodeIdentity(n));
    }
    skip(key, reason) {
        this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
        void key;
    }
    noteUnparsed(reason) {
        this.unparsedDumps++;
        if (this.unparsedReasons.length < 10)
            this.unparsedReasons.push(reason);
    }
    report(opts) {
        return {
            pages: opts.pages,
            steps: this.stepCount,
            durationMs: opts.durationMs,
            nodesSeen: this.nodesSeen,
            interactive: {
                discovered: this.discovered.size,
                clicked: this.clicked.size,
                collected: this.collected.size,
            },
            skipped: { ...this.skipped },
            unparsedDumps: this.unparsedDumps,
            unparsedReasons: [...this.unparsedReasons],
            budget: this.budget,
            stopReason: opts.stopReason,
        };
    }
}
/** 覆盖率是否可信：解析失败过多或几乎没发现交互控件时，报告应被标为不可信。 */
export function coverageHealth(r) {
    const warnings = [];
    if (r.unparsedDumps > 0)
        warnings.push(`${r.unparsedDumps} 次 dump 解析失败（覆盖结果不完整）`);
    if (r.pages > 0 && r.interactive.discovered === 0)
        warnings.push('没有发现任何可交互控件（疑似解析格式或设备界面异常）');
    if (r.interactive.discovered > 0 && r.interactive.clicked / r.interactive.discovered < 0.5 && r.stopReason) {
        warnings.push(`仅点击了 ${r.interactive.clicked}/${r.interactive.discovered} 个交互控件（提前停止：${r.stopReason}）`);
    }
    return { ok: warnings.length === 0, warnings };
}
