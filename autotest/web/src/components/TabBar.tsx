import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageKey } from '../App';

/**
 * 多标签导航（tags-view）—— 参考 ruoyi-vue-pro 的页签模式。
 *
 * 为什么需要它：平台有 20 个页面，原来的单页切换意味着每次点侧边栏都会丢掉当前页面的
 * 滚动位置与上下文（在「用例库」筛到一半，去「设备管理」看一眼再回来就重置了）。
 * 页签把"打开过的页面"变成可见状态，人可以并行对照多个页面（如库管理 + 用例库 + 执行计划）。
 *
 * 三条设计约束：
 *   1. **hash 是唯一事实源**：激活页由 App 从 hash 派生后传进来，本组件不另建一套路由状态
 *      ——两套状态必然漂移（这是 ruoyi-vue-pro 用 vue-router 的原因，我们用 hash 达到同样效果）；
 *   2. **持久化但可失效**：刷新后恢复标签顺序；坏数据/越界值一律忽略，退回"只用当前页"；
 *   3. **不允许关到空**：关掉最后一个标签会让内容区没有对应标签，属于把平台变成不可用状态的操作。
 *      （首页同样不可关：它是唯一"永远有内容"的落点。）
 */

const STORAGE_KEY = 'autotest.openTabs';

export interface TabBarProps {
  /** 当前激活页（来自 hash，由 App 统一写入） */
  active: PageKey;
  /** 页标题表 */
  titles: Record<PageKey, string>;
  /** 切换到某页 */
  onNavigate: (key: PageKey) => void;
  /** 请求刷新当前页内容（App 通过 remount 实现，本组件不碰页面 DOM） */
  onRefresh: () => void;
  /** 嵌入模式（DSH iframe，窄空间）：标签栏更紧凑 */
  compact?: boolean;
}

/** 从 localStorage 恢复标签顺序。坏数据/越界值一律忽略，退回只用当前页。 */
function loadTabs(active: PageKey, titles: Record<PageKey, string>): PageKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const keys = parsed.filter((k): k is PageKey => typeof k === 'string' && Object.hasOwn(titles, k));
        // 激活页必须在内：否则恢复出矛盾态（激活页不在标签里），内容区看着像坏了
        const withActive = keys.includes(active) ? keys : [active, ...keys];
        return withActive.length > 0 ? withActive : [active];
      }
    }
  } catch { /* 隐私模式 / 坏 JSON：忽略 */
  }
  return [active];
}

export default function TabBar({ active, titles, onNavigate, onRefresh, compact = false }: TabBarProps) {
  const [tabs, setTabs] = useState<PageKey[]>(() => loadTabs(active, titles));
  const trackRef = useRef<HTMLDivElement | null>(null);

  // 激活页变化 → 确保该页在标签里（"打开过的页面"才成为标签）
  useEffect(() => {
    setTabs((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);

  // 标签变化 → 持久化
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs)); } catch { /* 隐私模式：忽略 */ }
  }, [tabs]);

  // 激活页变化 → 把对应标签滚进可见区（标签溢出时不滚动的话，点了侧边栏看不到激活态）
  useEffect(() => {
    const el = trackRef.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const close = useCallback((key: PageKey) => {
    // 最后一个标签不许关（关了就只剩内容区、没有标签栏，平台进入不可用状态）
    if (tabs.length <= 1) return;
    setTabs((prev) => {
      const idx = prev.indexOf(key);
      if (idx < 0) return prev;
      // 关的是激活页 → 激活权交给右侧标签（没有右侧则左侧），保证内容区不空白
      if (key === active) {
        const next = prev[idx + 1] ?? prev[idx - 1];
        if (next && next !== key) onNavigate(next);
      }
      return prev.filter((k) => k !== key);
    });
  }, [active, onNavigate, tabs.length]);

  const closeOthers = useCallback((key: PageKey) => {
    setTabs([key]);
    if (key !== active) onNavigate(key);
  }, [active, onNavigate]);

  const closeAll = useCallback(() => {
    // 全部关闭 = 只留首页（不能一个不留）
    setTabs(['home']);
    if (active !== 'home') onNavigate('home');
  }, [active, onNavigate]);

  if (tabs.length === 0) return null;
  const onlyHome = tabs.length === 1 && tabs[0] === 'home';

  return (
    <div className={`tabbar ${compact ? 'tabbar-compact' : ''}`} role="tablist" aria-label="打开的页面">
      <div className="tabbar-track" ref={trackRef}>
        {tabs.map((k) => (
          <span
            key={k}
            data-tab={k}
            role="tab"
            aria-selected={k === active}
            className={`tab ${k === active ? 'active' : ''}`}
            onClick={() => { if (k !== active) onNavigate(k); }}
            title={titles[k] ?? k}
          >
            <span className="tab-title">{titles[k] ?? k}</span>
            {k !== 'home' && tabs.length > 1 && (
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${titles[k] ?? k}`}
                title="关闭"
                onClick={(e) => { e.stopPropagation(); close(k); }}
              >×</button>
            )}
          </span>
        ))}
      </div>
      <div className="tabbar-actions">
        <button type="button" className="tab-act" title="刷新当前页" onClick={onRefresh}>⟳</button>
        <button
          type="button"
          className="tab-act"
          title="关闭其他标签"
          onClick={() => closeOthers(active)}
          disabled={tabs.length <= 1}
        >⧉</button>
        <button
          type="button"
          className="tab-act"
          title="关闭全部标签（保留首页）"
          onClick={closeAll}
          disabled={onlyHome}
        >✕</button>
      </div>
    </div>
  );
}
