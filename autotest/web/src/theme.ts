// 宿主主题同步：把 DSH 宿主（父页面）的 --dsw-* 主题变量复制到本 iframe 文档。
// CSS 变量不会穿透 iframe，平台嵌在 DSH center column 里时，
// 若无同步，var(--dsw-alias-*, fallback) 永远落到 fallback 深色。
// 同源（DSH 3080）下读取 parent.getComputedStyle 并 setProperty 到自身 :root，
// 并监听宿主主题/样式变化（皮肤切换）实时跟随。
// 独立运行（窗口即顶层）时 window.parent === window，直接跳过。

const THEME_VAR_FALLBACK: string[] = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay', '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop', '--dsw-alias-bg-skeleton', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-multi-select',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-border-inverted', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption', '--dsw-alias-label-dimmed', '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-primary-dimmed', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover-accent', '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-brand-primary',
  '--dsw-alias-brand-text', '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary',
  '--dsw-alias-state-warn-label', '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-inline-code',
  '--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-sidebar-nav-item-active', '--dsw-mask-blur',
  '--dsw-shadow-lv3',
]

/** 从宿主文档的样式表枚举所有 --dsw-* 变量名（跨域样式表跳过），合并 fallback 清单。 */
function collectThemeVars(parentDoc: Document): string[] {
  const names = new Set<string>(THEME_VAR_FALLBACK)
  try {
    for (const sheet of Array.from(parentDoc.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule) {
            for (const prop of Array.from(rule.style)) {
              if (prop.startsWith('--dsw-')) names.add(prop)
            }
          }
        }
      } catch {
        /* 跨域样式表，跳过 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return Array.from(names)
}

export function applyHostTheme(): void {
  if (typeof window === 'undefined') return
  if (window.parent === window) return
  let parentDoc: Document | undefined
  try {
    parentDoc = window.parent.document
    void parentDoc.documentElement.offsetHeight // 跨源会抛异常
  } catch {
    return
  }
  // DSH 的 --dsw-* 变量定义在 body 上（皮肤中心切换 class/style 也在 body）；
  // html 作为祖先读不到 body 的变量，必须优先从 body 读取。
  const hostRoot = parentDoc.body ?? parentDoc.documentElement
  const myRoot = document.documentElement
  const vars = collectThemeVars(parentDoc)

  const sync = (): void => {
    try {
      const hostStyle = window.parent.getComputedStyle(hostRoot)
      for (const v of vars) {
        const val = hostStyle.getPropertyValue(v).trim()
        if (val) myRoot.style.setProperty(v, val)
      }
    } catch {
      /* 忽略 */
    }
  }

  sync()
  // 监听宿主主题切换：body/html 的 class / style / data-dsh-skin 属性变化 + head 样式表增删
  const mo = new MutationObserver(sync)
  mo.observe(parentDoc.body ?? parentDoc.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-dsh-skin'], subtree: true })
  if (parentDoc.documentElement !== hostRoot) {
    mo.observe(parentDoc.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-dsh-skin'] })
  }
  const headMo = new MutationObserver(sync)
  headMo.observe(parentDoc.head, { childList: true, subtree: true })
}

// ============================================================
// 主题切换（亮/暗 + 主题色）—— R7
// ------------------------------------------------------------
// 与上面 applyHostTheme 的分工：
//   applyHostTheme  把宿主 --dsw-* 变量搬进本文档（auto 模式的地基）；
//   applyTheme      决定 data-theme / data-accent，让显式主题覆盖宿主同步。
// 三者关系（styles.css 里用属性选择器落实）：
//   data-theme 缺省        → var(--dsw-*, 深色回退)   = 跟随宿主
//   data-theme=light|dark  → 字面量配色              = 平台自己的主题
//   data-accent=auto       → var(--dsw-*, 蓝色回退)   = 主色也跟随宿主
//   data-accent=<预设>     → 字面量主色               = 手动选的主色
//
// 为什么不复用宿主的浅色令牌：DSH 只下发"当前皮肤"的 --dsw-*，没有"另一套皮肤"可拿；
// 平台要支持浅色就必须自带一套字面量，否则嵌入态点浅色会拿到宿主的深色值。
// ============================================================

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ThemeAccent = 'auto' | 'blue' | 'green' | 'purple' | 'orange' | 'red';

export interface ThemeState {
  mode: ThemeMode;
  accent: ThemeAccent;
}

const THEME_STORAGE_KEY = 'autotest.theme';
const DEFAULT_THEME: ThemeState = { mode: 'auto', accent: 'auto' };

/** 主题色预设的中文名与色板（供 UI 展示；色值与 styles.css 的 data-accent 一致）。 */
export const ACCENT_PRESETS: Array<{ key: ThemeAccent; label: string; color: string }> = [
  { key: 'auto', label: '跟随宿主', color: 'var(--dsw-alias-button-primary-fill, #5686fe)' },
  { key: 'blue', label: '经典蓝', color: '#5686fe' },
  { key: 'green', label: '清新绿', color: '#22c55e' },
  { key: 'purple', label: '优雅紫', color: '#8b5cf6' },
  { key: 'orange', label: '活力橙', color: '#f59e0b' },
  { key: 'red', label: '中国红', color: '#ef4444' },
];

export const MODE_LABEL: Record<ThemeMode, string> = {
  auto: '跟随宿主', light: '浅色', dark: '深色',
};

/** 读取本地主题（坏数据/越界值一律回退默认，与 TabBar 的 loadTabs 同策略）。 */
export function loadTheme(): ThemeState {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemeState>;
      const mode: ThemeMode = ['auto', 'light', 'dark'].includes(String(parsed.mode))
        ? (parsed.mode as ThemeMode) : 'auto';
      const accent: ThemeAccent = ['auto', 'blue', 'green', 'purple', 'orange', 'red'].includes(String(parsed.accent))
        ? (parsed.accent as ThemeAccent) : 'auto';
      return { mode, accent };
    }
  } catch { /* 隐私模式 / 坏 JSON：忽略 */ }
  return DEFAULT_THEME;
}

/** 应用主题：写 data-* 属性（CSS 负责真正变色）+ 持久化。 */
export function applyTheme(state: ThemeState): void {
  const root = document.documentElement;
  // auto 模式不写 data-theme：让 :root 的 var(--dsw-*, 回退) 继续生效（跟随宿主）
  if (state.mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.mode);
  root.setAttribute('data-accent', state.accent);
  try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state)); } catch { /* 隐私模式：忽略 */ }
}

/** 切到下一个主题色（顶栏按钮单击用；避免每次都要开浮层选色）。 */
export function nextAccent(current: ThemeAccent): ThemeAccent {
  const order: ThemeAccent[] = ['auto', 'blue', 'green', 'purple', 'orange', 'red'];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

/** 浅色/深色互切（auto 视为深色——独立运行的默认观感就是深色）。 */
export function toggleMode(current: ThemeMode): ThemeMode {
  if (current === 'light') return 'dark';
  return 'light';   // auto / dark → light
}
