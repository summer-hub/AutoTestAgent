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
  const hostRoot = parentDoc.documentElement
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
  // 监听宿主主题切换：class / style / data-dsh-skin 属性变化 + head 样式表增删
  const mo = new MutationObserver(sync)
  mo.observe(hostRoot, { attributes: true, attributeFilter: ['class', 'style', 'data-dsh-skin'], subtree: true })
  const headMo = new MutationObserver(sync)
  headMo.observe(parentDoc.head, { childList: true, subtree: true })
}
