// UI 遍历的判定规则层（纯函数，无 I/O、无设备、无 DB）
//
// 抽出来的原因：覆盖不全的问题大多出在"什么算候选、怎么去重、什么时候停"这三类判定上，
// 而它们散在遍历循环里无法单独验证。这里集中成纯函数，用 scripts/verify-explorer-rules.mjs
// 离线跑契约自检（同 scripts/verify-step-contract.mjs 的做法）。
import type { UiNode } from './hdc.js';

/** 控件分类：不同类别走不同的交互序列（见 uiExplorer）。 */
export type ControlKind =
  | 'button'    // 普通可点击控件
  | 'input'     // 文本输入
  | 'dropdown'  // 下拉/选择器（需要在展开态回填选项）
  | 'checkbox'  // 复选框
  | 'switch'    // 开关
  | 'tab'       // 页签
  | 'scroll'    // 可滚动容器
  | 'text'      // 纯展示（只采集，不点击）
  | 'other';

// ---------- 可交互判定 ----------

/**
 * 是否可交互。
 * 判据只用 dump 自带的标志，**不看有没有文本** —— 图标按钮、图片按钮都无文本但 clickable=true，
 * 旧实现要求「有文本」，恰好把真实控件全丢掉、留下不可点的 Text。
 */
export function isInteractive(n: UiNode): boolean {
  if (!n.enabled || !n.visible) return false;
  return n.clickable || n.longClickable || n.checkable || n.scrollable;
}

/** 是否可点击（scroll 单独处理，不按点击算）。 */
export function isClickable(n: UiNode): boolean {
  return n.enabled && n.visible && (n.clickable || n.longClickable || n.checkable);
}

/**
 * 是否值得作为点击候选。
 * 排除整屏容器：dump 里 WindowScene / Dialog 之类的根容器也标了 clickable=true，
 * 点它们等于点空白（还会被当成"未进入新页面"白白消耗预算）。
 */
export function isClickCandidate(n: UiNode, screen?: { w: number; h: number }): boolean {
  if (!isClickable(n)) return false;
  if (!n.bounds) return false;
  if (n.bounds.x2 - n.bounds.x1 <= 1 || n.bounds.y2 - n.bounds.y1 <= 1) return false; // 零尺寸
  if (screen && screen.w > 0 && screen.h > 0) {
    const area = (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1);
    const screenArea = screen.w * screen.h;
    if (area / screenArea >= 0.9) return false;  // 整屏容器（对话框背景等）
  }
  return true;
}

// ---------- 标识与去重 ----------

/** 稳定身份：id > key > hierarchy > (type + 文本)。无文本控件靠 hierarchy/key 区分。 */
export function nodeIdentity(n: UiNode): string {
  if (n.id) return `id:${n.id}`;
  if (n.key) return `key:${n.key}`;
  if (n.hierarchy) return `h:${n.hierarchy}`;
  const label = (n.text || n.desc).trim().slice(0, 24);
  return `t:${n.type ?? '?'}:${label}`;
}

/** 坐标分桶（100px 网格）。 */
export function coordBucket(x: number, y: number): string {
  return `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
}

/**
 * 去重键：身份 + 坐标桶 + 视口序号。
 * 旧实现只按 `label.slice(0,24)` 去重，导致同屏两个「确定」只点一个；
 * 加入坐标桶后同名控件各算一个（修复"同名控件只采到第一个"）。
 */
export function dedupKey(n: UiNode, viewport = 0): string {
  return `${nodeIdentity(n)}@vp${viewport}:${coordBucket(n.x, n.y)}`;
}

// ---------- 控件分类 ----------

const KIND_BY_TYPE: Array<[RegExp, ControlKind]> = [
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
export function classifyControl(n: UiNode): ControlKind {
  const type = n.type ?? '';
  if (n.checkable) {
    if (/Toggle|Switch/i.test(type)) return 'switch';
    return 'checkbox';
  }
  for (const [re, kind] of KIND_BY_TYPE) {
    if (re.test(type)) {
      // Text/Image 若本身可点击，按按钮处理（可点击文本就是最典型的按钮）
      if (kind === 'text' && (n.clickable || n.longClickable)) return 'button';
      if (kind === 'scroll') return n.scrollable ? 'scroll' : 'other';
      return kind;
    }
  }
  if (n.scrollable) return 'scroll';
  if (n.clickable || n.longClickable) return 'button';
  return (n.text || n.desc).trim() ? 'text' : 'other';
}

/** 节点面积（用于"取最小的包含子节点"），无 bounds 返回 Infinity。 */
function nodeArea(n: UiNode): number {
  if (!n.bounds) return Number.POSITIVE_INFINITY;
  return (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1);
}

/**
 * 供人阅读的控件标签（无文本时用**几何包含的子节点文本**兜底，再退到类型/ID）。
 * `all` 传本页全部节点时，无文本容器（ListItem/Row/图标按钮）会用子节点文本命名。
 * 真机上列表项自身没文本、文本都在子节点上，只用类型兜底会让每个页面标签都叫「[ListItem]」
 * —— 实测 9 个不同页面标签完全相同：用例里区分不出点的是哪个入口，
 * 而且路径重放靠标签找控件，标签重名会导致重放点到错误的项。
 */
export function nodeLabel(n: UiNode, all: UiNode[] = []): string {
  const t = (n.text || n.desc).trim();
  if (t) return t.slice(0, 24);
  if (all.length && n.bounds) {
    const nb = n.bounds;
    const inside = all
      .filter((c) => c !== n && c.bounds && (c.text || c.desc).trim()
        && c.bounds.x1 >= nb.x1 && c.bounds.y1 >= nb.y1 && c.bounds.x2 <= nb.x2 && c.bounds.y2 <= nb.y2)
      .sort((a, b) => nodeArea(a) - nodeArea(b));
    const texts: string[] = [];
    for (const c of inside) {
      const ct = (c.text || c.desc).trim();
      if (ct && !texts.includes(ct)) texts.push(ct);
      if (texts.length >= 2) break;
    }
    if (texts.length) return texts.join(' ').slice(0, 24);
  }
  if (n.id) return `[${n.type ?? '控件'}#${n.id}]`;
  return `[${n.type ?? '未知控件'}]`;
}

// ---------- 页面指纹 ----------

/**
 * 节点指纹：类型 + 身份 + 文本 + 交互状态。
 * 默认**不含坐标**：连续动画页每帧坐标都在变，带坐标会把每一帧判成新页面（既漏又慢）；
 * 而状态区分（勾选/选中/Tab）由 checked/selected/text 承担。
 * 需要旧行为（对布局敏感）时把 includeLayout 打开。
 */
export function nodeFingerprint(n: UiNode, includeLayout = false): string {
  const state = `${n.checked ? 'c' : '-'}${n.selected ? 's' : '-'}`;
  const base = `${n.type ?? '?'}|${nodeIdentity(n)}|${(n.text || n.desc).trim().slice(0, 24)}|${state}`;
  return includeLayout && n.bounds ? `${base}|${coordBucket(n.x, n.y)}` : base;
}

/** 页面签名：全部节点指纹去重排序拼接。纯展示节点也参与（它们构成页面结构）。 */
export function pageSignature(nodes: UiNode[], includeLayout = false): string {
  return [...new Set(nodes.map((n) => nodeFingerprint(n, includeLayout)).filter(Boolean))].sort().join('\n');
}

// ---------- 预算 ----------

export interface ExploreBudget {
  /** 最多收录页面数 */
  maxPages: number;
  /** 单次遍历总时长上限（分钟） */
  maxMinutes: number;
  /** 单页最多点击次数（防某页失控） */
  maxClicksPerPage: number;
  /** 单页为看全内容最多滑动次数 */
  maxSwipePerPage: number;
}

export interface BudgetState {
  pages: number;
  clicksOnPage: number;
  steps: number;
  elapsedMs: number;
}

export type BudgetStopReason = 'pages' | 'time' | 'clicksPerPage' | '';

/**
 * 预算检查：**任一维度耗尽即停**，并给出可展示的原因。
 * 取代旧的 `maxDepth` 硬闸（深度只作排序偏好）：旧的深度限制让"子页面的子页面"结构性不可达。
 */
export function budgetCheck(state: BudgetState, budget: ExploreBudget): { exhausted: boolean; reason: BudgetStopReason } {
  if (state.pages >= budget.maxPages) return { exhausted: true, reason: 'pages' };
  if (state.elapsedMs >= budget.maxMinutes * 60_000) return { exhausted: true, reason: 'time' };
  if (state.clicksOnPage >= budget.maxClicksPerPage) return { exhausted: true, reason: 'clicksPerPage' };
  return { exhausted: false, reason: '' };
}

// ---------- 覆盖率报告 ----------

export type SkipReason =
  | 'notInteractive'    // 纯展示（无交互能力）
  | 'notClickable'      // 可交互但不可点击（纯滚动容器等）
  | 'duplicate'         // 本页/本视口已处理过同一控件
  | 'visited'           // 该控件此前已点击过（跨页去重）
  | 'offScreenContent'  // 在状态栏/导航区，不属于内容区
  | 'fullScreenContainer' // 整屏容器，点了等于点空白
  | 'navigation'        // 返回/关闭/取消类控件（点了会离开当前页）
  | 'budgetPages'
  | 'budgetTime'
  | 'budgetClicksPerPage'
  | 'leafPage';         // 叶子页只采集不点击

export interface CoverageReport {
  pages: number;
  steps: number;
  durationMs: number;
  /** 本次遍历见过的节点总数（按 dump 累加，含重复） */
  nodesSeen: number;
  interactive: {
    /** 去重后发现的交互控件数（分母） */
    discovered: number;
    /** 实际点击的 */
    clicked: number;
    /** 进入页面控件清单的 */
    collected: number;
  };
  skipped: Record<string, number>;
  /** dump 解析失败次数（>0 必须告警：旧实现会把解析失败当成空页面静默跳过） */
  unparsedDumps: number;
  unparsedReasons: string[];
  budget: ExploreBudget;
  stopReason: string;
}

/** 覆盖率累加器：遍历过程中持续记录，结束时产出可解释的报告。 */
export class CoverageTracker {
  private nodesSeen = 0;
  private stepCount = 0;
  private readonly discovered = new Set<string>();
  private readonly clicked = new Set<string>();
  private readonly collected = new Set<string>();
  private readonly skipped: Record<string, number> = {};
  private unparsedDumps = 0;
  private readonly unparsedReasons: string[] = [];

  constructor(private readonly budget: ExploreBudget) {}

  /** 已执行的动作步数（遍历用它做预算判断）。 */
  get steps(): number { return this.stepCount; }
  /** 已收录页面数（由调用方在 report 时传入，这里只提供步数）。 */
  get discoveredCount(): number { return this.discovered.size; }

  /** 记录一次 dump 的全部节点。 */
  seeNodes(nodes: UiNode[], interactiveOf: (n: UiNode) => boolean = isInteractive): void {
    this.nodesSeen += nodes.length;
    for (const n of nodes) {
      if (interactiveOf(n)) this.discovered.add(nodeIdentity(n));
    }
  }

  step(): void { this.stepCount++; }

  markClicked(n: UiNode): void {
    const k = nodeIdentity(n);
    this.clicked.add(k);
    this.discovered.add(k);
  }

  markCollected(n: UiNode): void {
    this.collected.add(nodeIdentity(n));
  }

  skip(key: string, reason: SkipReason): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
    void key;
  }

  noteUnparsed(reason: string): void {
    this.unparsedDumps++;
    if (this.unparsedReasons.length < 10) this.unparsedReasons.push(reason);
  }

  report(opts: { pages: number; durationMs: number; stopReason: string }): CoverageReport {
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
export function coverageHealth(r: CoverageReport): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (r.unparsedDumps > 0) warnings.push(`${r.unparsedDumps} 次 dump 解析失败（覆盖结果不完整）`);
  if (r.pages > 0 && r.interactive.discovered === 0) warnings.push('没有发现任何可交互控件（疑似解析格式或设备界面异常）');
  if (r.interactive.discovered > 0 && r.interactive.clicked / r.interactive.discovered < 0.5 && r.stopReason) {
    warnings.push(`仅点击了 ${r.interactive.clicked}/${r.interactive.discovered} 个交互控件（提前停止：${r.stopReason}）`);
  }
  return { ok: warnings.length === 0, warnings };
}
