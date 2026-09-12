import { useEffect, useState } from 'react';
import { api } from './api';
import HomePage from './pages/Home';
import CasesPage from './pages/Cases';
import TasksPage from './pages/Tasks';
import PlansPage from './pages/Plans';
import AnalysisPage from './pages/Analysis';
import AttributionPage from './pages/Attribution';
import DebugPage from './pages/Debug';
import DevicesPage from './pages/Devices';
import PromptsPage from './pages/Prompts';
import SettingsPage from './pages/Settings';
import ScriptsPage from './pages/Scripts';
import LibrariesPage from './pages/Libraries';
import SettingsModal from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';

export type PageKey = 'home' | 'tasks' | 'libraries' | 'cases' | 'scripts' | 'plans' | 'analysis' | 'attribution' | 'debug' | 'devices' | 'prompts' | 'settings';

const NAV: Array<{ group: string; items: Array<{ key: PageKey; icon: string; label: string; badge?: string }> }> = [
  {
    group: '工作台',
    items: [
      { key: 'home', icon: '🏠', label: '首页' },
      { key: 'tasks', icon: '📋', label: '任务管理' },
    ],
  },
  {
    group: '测试资产',
    items: [
      { key: 'libraries', icon: '📚', label: '库管理' },
      { key: 'cases', icon: '🧪', label: '测试用例' },
      { key: 'scripts', icon: '🤖', label: '自动化脚本' },
    ],
  },
  {
    group: '智能分析',
    items: [
      { key: 'plans', icon: '📅', label: '执行计划' },
      { key: 'analysis', icon: '📊', label: '数据分析' },
      { key: 'attribution', icon: '🔍', label: '归因分析' },
      { key: 'debug', icon: '🐞', label: '调试会话' },
    ],
  },
  {
    group: '资源与配置',
    items: [
      { key: 'devices', icon: '📱', label: '设备管理' },
      { key: 'prompts', icon: '🧠', label: 'Prompt 管理' },
      { key: 'settings', icon: '⚙️', label: '系统配置' },
    ],
  },
];

const TITLES: Record<PageKey, string> = {
  home: '首页', tasks: '任务管理', libraries: '库管理', cases: '测试用例', scripts: '自动化脚本', plans: '执行计划', analysis: '数据分析',
  attribution: '归因分析', debug: '调试会话', devices: '设备管理', prompts: 'Prompt 管理', settings: '系统配置',
};

/** 页面 → 所属分组（面包屑第一段，如「智能分析 / 执行计划」）。 */
const GROUP_OF: Record<PageKey, string> = (() => {
  const m = {} as Record<PageKey, string>;
  for (const g of NAV) for (const it of g.items) m[it.key] = g.group;
  return m;
})();

// 嵌入 DSH GUI 时由构建注入 VITE_EMBED=1：隐藏独立侧边栏/顶栏，改用紧凑导航；
// 模型管理不再提供自建入口（直接复用 DSH 设置 → 模型）。
const EMBED = import.meta.env.VITE_EMBED === '1';

// 兼容 '#cases' 与 '#/cases' 两种 hash 写法（深链接 / DSH iframe 内嵌）
// 必须用 Object.hasOwn：`h in TITLES` 会命中 Object.prototype 的继承键，
// '#constructor' / '#toString' 之类会被当成合法页面 → page 变成非法值 → 内容区全白。
const parseHash = (): PageKey => {
  const h = location.hash.replace(/^#\/?/, '');
  return Object.hasOwn(TITLES, h) ? (h as PageKey) : 'home';
};

export default function App() {
  const [page, setPage] = useState<PageKey>(() => parseHash());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backend, setBackend] = useState<{ version: string; db: string } | null>(null);
  const [booting, setBooting] = useState(true);
  // 嵌入模式的手动收起状态（只影响导航轨宽度）；用 localStorage 记住，刷新后保持
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('autotest.navCollapsed') === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('autotest.navCollapsed', navCollapsed ? '1' : '0'); } catch { /* 忽略（隐私模式等） */ }
  }, [navCollapsed]);

  const goto = (p: PageKey) => {
    setPage(p);
    try { location.hash = p; } catch { /* noop */ }
  };

  // hash 路由监听（必须位于任何条件 return 之前 —— Hooks 规则）
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace(/^#\/?/, '');
      // `#settings` 就是「系统配置」页面本身。原先这里额外把设置弹窗也打开，
      // 导致点侧栏「系统配置」时 SettingsPage 与 SettingsModal 叠加成两套界面；
      // 弹窗现在只由侧栏底部「设置」按钮显式打开（不写 hash）。
      if (Object.hasOwn(TITLES, h)) setPage(h as PageKey);
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 挂载后：拉取后端版本信息
  useEffect(() => {
    let cancelled = false;
    api.health().then((h) => {
      if (!cancelled) setBackend({ version: String((h as { version?: string }).version ?? '?'), db: String((h as { db?: string }).db ?? '?') });
    }).catch(() => {}).finally(() => { if (!cancelled) setBooting(false); });
    return () => { cancelled = true; };
  }, []);

  const renderPage = () => (
    <ErrorBoundary resetKey={page}>
      {page === 'home' && <HomePage />}
      {page === 'tasks' && <TasksPage />}
      {page === 'libraries' && <LibrariesPage />}
      {page === 'cases' && <CasesPage />}
      {page === 'scripts' && <ScriptsPage />}
      {page === 'plans' && <PlansPage />}
      {page === 'analysis' && <AnalysisPage />}
      {page === 'attribution' && <AttributionPage />}
      {page === 'debug' && <DebugPage />}
      {page === 'devices' && <DevicesPage />}
      {page === 'prompts' && <PromptsPage />}
      {page === 'settings' && <SettingsPage />}
    </ErrorBoundary>
  );

  if (EMBED) {
    // 嵌入 DSH 主区的布局：左侧导航栏 + 右侧页面详情（面包屑 + 内容）。
    // 导航支持手动收起为图标轨道（窄宽度下由 CSS 媒体查询自动收起）。
    return (
      <div className={`app embed ${navCollapsed ? 'nav-collapsed' : ''}`}>
        <aside className="embed-side">
          <div className="embed-brand">
            <span className="embed-logo">A</span>
            <span className="embed-brand-text">
              <span className="embed-brand-name">AutoTest 平台</span>
              <span className="embed-brand-sub">鸿蒙三方库自动化测试</span>
            </span>
          </div>
          <nav className="embed-nav">
            {NAV.map((g) => (
              <div key={g.group} className="embed-nav-group">
                <div className="embed-nav-group-title">{g.group}</div>
                {g.items.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    title={it.label}
                    className={`embed-nav-item ${page === it.key ? 'active' : ''}`}
                    onClick={() => goto(it.key)}
                  >
                    <span className="ico">{it.icon}</span>
                    <span className="lbl">{it.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="embed-side-foot">
            <span className="tb-pill" title={backend ? `后端版本 ${backend.version} · ${backend.db}` : '加载中'}>
              <span className="dot green" /> {backend ? `v${backend.version} · ${backend.db}` : '连接中'}
            </span>
            <button
              type="button"
              className="embed-collapse"
              aria-label={navCollapsed ? '展开导航' : '收起导航'}
              title={navCollapsed ? '展开导航' : '收起导航'}
              onClick={() => setNavCollapsed((v) => !v)}
            >
              {navCollapsed ? '»' : '«'}
            </button>
          </div>
        </aside>
        <main className="embed-main">
          <nav className="embed-crumb" aria-label="当前位置">
            <span className="crumb-group">{GROUP_OF[page]}</span>
            <span className="crumb-sep">/</span>
            <b>{TITLES[page]}</b>
          </nav>
          <div className="embed-content">{renderPage()}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">A</div>
          <div>
            <div className="brand-name">AutoTest 平台</div>
            <div className="brand-sub">鸿蒙三方库自动化测试</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((it) => (
                <div key={it.key} className={`nav-item ${page === it.key ? 'active' : ''}`} onClick={() => goto(it.key)}>
                  <span className="ico">{it.icon}</span>
                  {it.label}
                  {it.badge && <span className="badge">{it.badge}</span>}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="set-trigger" onClick={() => setSettingsOpen(true)}>
          <span style={{ fontSize: 15 }}>⚙️</span>设置
          <span className="badge" style={{ marginLeft: 'auto', fontSize: 10.5, background: 'var(--panel3)', color: 'var(--text3)', padding: '1px 7px', borderRadius: 10 }}>自定义模型</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            工作台 / <b>{TITLES[page]}</b>
          </div>
          <div className="tb-spacer" />
          <div className="tb-pill" title={backend ? `后端版本 ${backend.version} · ${backend.db}` : '加载中'}>
            <span className="dot green" /> {backend ? `v${backend.version} · ${backend.db}` : '连接中'}
          </div>
        </header>
        <div className="content">{renderPage()}</div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
