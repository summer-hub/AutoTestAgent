import { useEffect, useRef, useState } from 'react';
import {
  ACCENT_PRESETS, MODE_LABEL, applyTheme, loadTheme, nextAccent, toggleMode,
  type ThemeAccent, type ThemeMode,
} from '../theme';

/**
 * 主题切换控件（顶栏）：图标按钮 + 浮层。
 *
 * 交互取舍（参考 ruoyi-vue-pro 的主题设置，但更轻）：
 *   · 单击图标 = 浅色/深色互切（最高频操作，一次点击到位）；
 *   · 浮层里可选「跟随宿主 / 浅色 / 深色」+ 6 个主题色（低频但需要可发现）。
 * 为什么不只用浮层：切深浅是高频，每次开浮层多点两下不值得。
 *
 * 点击外部关闭：浮层没有 mask 层（会挡住整个顶栏），所以用 document 监听捕获。
 */
export default function ThemeSwitch() {
  const [theme, setTheme] = useState(() => loadTheme());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 挂载时应用一次（App 里也会应用，这里保证控件自身的初值一致）
  useEffect(() => { applyTheme(theme); }, [theme]);

  // 点击浮层外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const update = (patch: Partial<{ mode: ThemeMode; accent: ThemeAccent }>) => {
    setTheme((prev) => {
      const next = { ...prev, ...patch };
      applyTheme(next);
      return next;
    });
  };

  const icon = theme.mode === 'light' ? '☀️' : theme.mode === 'dark' ? '🌙' : '🌓';

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        type="button"
        className="theme-btn"
        title={`主题：${MODE_LABEL[theme.mode]}（单击切换深浅，长按/右键打开面板）`}
        onClick={() => update({ mode: toggleMode(theme.mode) })}
        onContextMenu={(e) => { e.preventDefault(); setOpen((v) => !v); }}
      >{icon}</button>
      <button
        type="button"
        className="theme-btn"
        style={{ marginLeft: 6, fontSize: 12 }}
        title="主题设置（模式 / 主题色）"
        onClick={() => setOpen((v) => !v)}
      >🎨</button>

      {open && (
        <div className="theme-pop" role="dialog" aria-label="主题设置">
          <div className="theme-pop-title">外观模式</div>
          <div className="theme-seg">
            {(['auto', 'light', 'dark'] as ThemeMode[]).map((m) => (
              <button key={m} type="button" className={theme.mode === m ? 'on' : ''} onClick={() => update({ mode: m })}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>

          <div className="theme-pop-title">主题色（单击图标也可快速切换）</div>
          <div className="theme-swatches">
            {ACCENT_PRESETS.map((a) => (
              <button
                key={a.key}
                type="button"
                className={`theme-swatch ${theme.accent === a.key ? 'on' : ''}`}
                style={{ background: a.color }}
                title={a.label}
                onClick={() => update({ accent: a.key })}
              />
            ))}
          </div>
          <div className="theme-pop-title" style={{ marginTop: 10, marginBottom: 0 }}>
            当前：{MODE_LABEL[theme.mode]} · {ACCENT_PRESETS.find((a) => a.key === theme.accent)?.label ?? theme.accent}
          </div>
        </div>
      )}
    </div>
  );
}

export { nextAccent };
