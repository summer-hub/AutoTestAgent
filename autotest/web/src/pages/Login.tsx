import { useState } from 'react';
import { api, authState, type AuthUser } from '../api';

export default function LoginPage({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = tab === 'login'
        ? await api.login(username, password)
        : await api.register(invite, username, password);
      authState.token = r.token;
      authState.refresh = r.refreshToken;
      setMsg(tab === 'login' ? '登录成功' : '注册成功，已自动登录');
      onLogin(r.user);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 20 }}>
      <div className="card" style={{ width: 380, padding: '30px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div className="brand-logo" style={{ width: 42, height: 42, fontSize: 20 }}>A</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>AutoTest 平台</div>
            <div className="muted" style={{ fontSize: 12 }}>鸿蒙三方库自动化测试 · 多用户</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, margin: '18px 0 14px' }}>
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn ${tab === t ? 'primary' : ''}`}
              style={{ flex: 1, padding: '7px 0' }}
              onClick={() => { setTab(t); setErr(''); }}
            >
              {t === 'login' ? '登录' : '注册（邀请码）'}
            </button>
          ))}
        </div>

        {tab === 'register' && (
          <input
            className="input"
            style={{ width: '100%', marginBottom: 10 }}
            placeholder="邀请码（管理员在用户管理页生成）"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        )}
        <input
          className="input"
          style={{ width: '100%', marginBottom: 10 }}
          placeholder="用户名（小写字母/数字/下划线）"
          value={username}
          autoFocus
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="input"
          type="password"
          style={{ width: '100%', marginBottom: 14 }}
          placeholder="密码（至少 8 位）"
          value={password}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          onChange={(e) => setPassword(e.target.value)}
        />

        {err && <div className="error" style={{ marginBottom: 10 }}>⚠️ {err}</div>}
        {msg && <div className="ok" style={{ marginBottom: 10 }}>✓ {msg}</div>}

        <button className="btn primary" style={{ width: '100%', padding: '9px 0' }} disabled={busy} onClick={() => void submit()}>
          {busy ? '请稍候…' : tab === 'login' ? '登 录' : '注 册'}
        </button>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 16, lineHeight: 1.6, textAlign: 'center' }}>
          登录后按角色访问：管理员 / 组长 / 测试工程师 / 只读访客
        </div>
      </div>
    </div>
  );
}
