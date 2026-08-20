import { useEffect, useState } from 'react';
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
import PlaceholderPage from './pages/Placeholder';
import SettingsModal from './components/SettingsModal';

export type PageKey = 'home' | 'tasks' | 'cases' | 'plans' | 'analysis' | 'attribution' | 'debug' | 'devices' | 'prompts' | 'settings';

const NAV: Array<{ group: string; items: Array<{ key: PageKey; icon: string; label: string; badge?: string }> }> = [
  {
    group: '工作台',
    items: [
      { key: 'home', icon: '🏠', label: '首页' },
      { key: 'tasks', icon: '📋', label: '任务管理', badge: '5' },
    ],
  },
  {
    group: '测试资产',
    items: [{ key: 'cases', icon: '🧪', label: '测试用例', badge: '400' }],
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
  home: '首页', tasks: '任务管理', cases: '测试用例', plans: '执行计划', analysis: '数据分析',
  attribution: '归因分析', debug: '调试会话', devices: '设备管理', prompts: 'Prompt 管理', settings: '系统配置',
};

// 嵌入 DSH GUI 时由构建注入 VITE_EMBED=1：隐藏独立侧边栏/顶栏，改用紧凑导航；
// 模型管理不再提供自建入口（直接复用 DSH 设置 → 模型）。
const EMBED = import.meta.env.VITE_EMBED === '1';

export default function App() {
  const [page, setPage] = useState<PageKey>(() => {
    const h = location.hash.replace('#', '') as PageKey;
    return h in TITLES ? h : 'home';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const goto = (p: PageKey) => {
    setPage(p);
    try { location.hash = p; } catch { /* noop */ }
  };

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '') as PageKey | 'settings';
      if (h === 'settings') { setSettingsOpen(true); return; }
      if (h in TITLES) setPage(h);
    };
    if (location.hash === '#settings') setSettingsOpen(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const renderPage = () => (
    <>
      {page === 'home' && <HomePage />}
      {page === 'tasks' && <TasksPage />}
      {page === 'cases' && <CasesPage />}
      {page === 'plans' && <PlansPage />}
      {page === 'analysis' && <AnalysisPage />}
      {page === 'attribution' && <AttributionPage />}
      {page === 'debug' && <DebugPage />}
      {page === 'devices' && <DevicesPage />}
      {page === 'prompts' && <PromptsPage />}
      {page === 'settings' && <SettingsPage />}
      {page !== 'home' && page !== 'tasks' && page !== 'cases' && page !== 'plans' && page !== 'debug' && page !== 'devices' && page !== 'prompts' && page !== 'settings' && <PlaceholderPage page={page} title={TITLES[page]} />}
    </>
  );

  if (EMBED) {
    return (
      <div className="app embed">
        <header className="embed-top">
          <div className="embed-brand">
            <span className="embed-logo">A</span>
            <span>AutoTest 平台</span>
            <span className="embed-brand-sub">鸿蒙三方库自动化测试</span>
          </div>
          <nav className="embed-nav">
            {NAV.map((g) =>
              g.items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className={`embed-nav-item ${page === it.key ? 'active' : ''}`}
                  onClick={() => goto(it.key)}
                >
                  <span className="ico">{it.icon}</span>
                  {it.label}
                </button>
              )),
            )}
          </nav>
          <div className="tb-spacer" />
          <div className="tb-pill">
            <span className="dot green" /> 后端在线
          </div>
        </header>
        <div className="embed-content">{renderPage()}</div>
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
        <div className="side-foot">
          <div className="avatar">👤</div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>测试工程师</div>
            <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>admin · 本地</div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            工作台 / <b>{TITLES[page]}</b>
          </div>
          <div className="tb-spacer" />
          <div className="tb-pill">
            <span className="dot green" /> 模型已连接 · deepseek-v4
          </div>
          <div className="tb-pill">
            <span className="dot green" /> 后端在线
          </div>
        </header>
        <div className="content">{renderPage()}</div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
