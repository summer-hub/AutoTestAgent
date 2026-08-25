import { useEffect, useState } from 'react';
import { api, authState, rememberState, type AuthUser } from './api';
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
import LoginPage from './pages/Login';
import UsersPage from './pages/Users';
import SettingsModal from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';

export type PageKey = 'home' | 'tasks' | 'cases' | 'scripts' | 'plans' | 'analysis' | 'attribution' | 'debug' | 'devices' | 'prompts' | 'settings' | 'users' | 'login';

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
    items: [
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
  home: '首页', tasks: '任务管理', cases: '测试用例', scripts: '自动化脚本', plans: '执行计划', analysis: '数据分析',
  attribution: '归因分析', debug: '调试会话', devices: '设备管理', prompts: 'Prompt 管理', settings: '系统配置', users: '用户管理', login: '登录',
};

// 嵌入 DSH GUI 时由构建注入 VITE_EMBED=1：隐藏独立侧边栏/顶栏，改用紧凑导航；
// 模型管理不再提供自建入口（直接复用 DSH 设置 → 模型）。
const EMBED = import.meta.env.VITE_EMBED === '1';

// 兼容 '#cases' 与 '#/cases' 两种 hash 写法（深链接 / DSH iframe 内嵌）
const parseHash = (): PageKey => {
  const h = location.hash.replace(/^#\/?/, '') as PageKey;
  return h in TITLES ? h : 'home';
};

export default function App() {
  const [page, setPage] = useState<PageKey>(() => {
    return authState.has() ? parseHash() : 'home';
  });
  const [me, setMe] = useState<AuthUser | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 启动流程：有 token 直接校验；无 token 但记住了账号 → 静默自动登录
  const [booting, setBooting] = useState(true);

  const goto = (p: PageKey) => {
    setPage(p);
    try { location.hash = p; } catch { /* noop */ }
  };

  const canManageUsers = !!(me?.permissions ?? []).includes('user:manage');

  // hash 路由监听（必须位于任何条件 return 之前 —— Hooks 规则）
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace(/^#\/?/, '') as PageKey | 'settings';
      if (h === 'settings') { setSettingsOpen(true); return; }
      if (h in TITLES) setPage(h);
    };
    if (location.hash.replace(/^#\/?/, '') === 'settings') setSettingsOpen(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 挂载后：token 校验 / 记住账号静默登录
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (authState.has()) {
          const r = await api.me();
          if (!cancelled) { setMe(r.user); }
          return;
        }
        const remembered = rememberState.get();
        if (remembered) {
          try {
            const r = await api.login(remembered.username, remembered.password);
            authState.token = r.token;
            authState.refresh = r.refreshToken;
            if (!cancelled) { setMe(r.user); setPage(parseHash()); }
            return;
          } catch {
            rememberState.clear(); // 凭据失效，清除并回到登录页
          }
        }
        if (!cancelled) setPage('login');
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const doLogout = async () => {
    try { await api.logout(authState.refresh); } catch { /* ignore */ }
    authState.clear();
    setMe(null);
    goto('login');
  };

  const roleLabel = (r: string) => ({ admin: '管理员', manager: '组长', engineer: '测试工程师', viewer: '只读访客' }[r] ?? r);

  if (booting) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
        <div className="brand-logo" style={{ width: 46, height: 46, fontSize: 22 }}>A</div>
        <div className="muted" style={{ fontSize: 12.5 }}>正在进入 AutoTest 平台…</div>
        <div className="ana-spinner" />
      </div>
    );
  }

  if (!authState.has()) {
    return (
      <ErrorBoundary resetKey="login">
        <LoginPage onLogin={(u) => { setMe(u); goto('home'); }} />
      </ErrorBoundary>
    );
  }

  const renderPage = () => (
    <ErrorBoundary resetKey={page}>
      {page === 'home' && <HomePage />}
      {page === 'tasks' && <TasksPage />}
      {page === 'cases' && <CasesPage me={me} />}
      {page === 'scripts' && <ScriptsPage />}
      {page === 'plans' && <PlansPage />}
      {page === 'analysis' && <AnalysisPage />}
      {page === 'attribution' && <AttributionPage />}
      {page === 'debug' && <DebugPage />}
      {page === 'devices' && <DevicesPage />}
      {page === 'prompts' && <PromptsPage />}
      {page === 'settings' && <SettingsPage />}
      {page === 'users' && <UsersPage me={me} />}
    </ErrorBoundary>
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
              g.items.filter((it) => it.key !== 'users' || canManageUsers).map((it) => (
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
          {canManageUsers && (
            <span className="tb-pill" style={{ cursor: 'pointer' }} title="用户管理 / 邀请码" onClick={() => goto('users')}>
              👤 {me?.username ?? '...'} · {me?.roles.map(roleLabel).join('/')}
            </span>
          )}
          <span className="tb-pill" style={{ cursor: 'pointer' }} onClick={doLogout} title="退出登录">退出</span>
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
          {canManageUsers && (
            <div className={`nav-item ${page === 'users' ? 'active' : ''}`} onClick={() => goto('users')}>
              <span className="ico">👥</span>用户管理
            </div>
          )}
        </nav>
        <div className="set-trigger" onClick={() => setSettingsOpen(true)}>
          <span style={{ fontSize: 15 }}>⚙️</span>设置
          <span className="badge" style={{ marginLeft: 'auto', fontSize: 10.5, background: 'var(--panel3)', color: 'var(--text3)', padding: '1px 7px', borderRadius: 10 }}>自定义模型</span>
        </div>
        <div className="side-foot">
          <div className="avatar">👤</div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{me?.username ?? '...'} · {me?.roles.map(roleLabel).join('/')}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text3)', cursor: 'pointer' }} onClick={doLogout}>退出登录</div>
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
