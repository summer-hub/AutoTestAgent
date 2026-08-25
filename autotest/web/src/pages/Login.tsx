// 登录 / 邀请码注册 —— 企业级分屏布局：
//  - 左侧品牌区：产品定位 + 能力亮点（CRM 常见的 split-panel 结构）
//  - 右侧表单区：居中排版，登录 / 注册切换
import { useState } from 'react';
import { api, authState, rememberState, type AuthUser } from '../api';

const FEATURES: Array<{ icon: string; title: string; desc: string }> = [
  { icon: '🤖', title: 'AI 用例生成', desc: 'PR 变更分析 · 自动编写与更新测试用例' },
  { icon: '📡', title: '真机 UI 遍历', desc: '启动 demo 自动遍历页面，生成用例与 Hypium 脚本' },
  { icon: '📅', title: '执行与调度', desc: '单例 / 批量 / 全量计划，跨库多选用例编排' },
  { icon: '🔍', title: '失败归因分析', desc: '执行轨迹 + 日志智能定位三方库回归缺陷' },
];

export default function LoginPage({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState(() => rememberState.get()?.username ?? '');
  const [password, setPassword] = useState(() => rememberState.get()?.password ?? '');
  const [remember, setRemember] = useState(() => !!rememberState.get());
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
      if (tab === 'login') {
        if (remember) rememberState.set(username.trim(), password);
        else rememberState.clear();
      }
      setMsg(tab === 'login' ? '登录成功' : '注册成功，已自动登录');
      onLogin(r.user);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(1200px 600px at 20% -10%, rgba(86,134,254,.14), transparent 60%), var(--bg)',
      padding: 20,
    }}>
      <div style={{
        width: 920, maxWidth: '100%', minHeight: 540, display: 'grid', gridTemplateColumns: '1.1fr 1fr',
        borderRadius: 18, overflow: 'hidden', border: '1px solid var(--border2)',
        boxShadow: '0 30px 90px rgba(0,0,0,.45)', background: 'var(--panel)',
      }}>
        {/* 左侧品牌区 */}
        <div style={{
          padding: '44px 40px', display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(160deg, #2b3f78 0%, #1d2a52 55%, #17203f 100%)',
          color: '#eef2ff',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="brand-logo" style={{ width: 42, height: 42, fontSize: 20 }}>A</div>
            <div>
              <div style={{ fontSize: 16.5, fontWeight: 700 }}>AutoTest 平台</div>
              <div style={{ fontSize: 11.5, color: 'rgba(238,242,255,.65)', marginTop: 1 }}>鸿蒙三方库自动化测试</div>
            </div>
          </div>

          <div style={{ textAlign: 'center', margin: 'auto 0', padding: '26px 0' }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '.01em', lineHeight: 1.4 }}>
              让三方库质量<br />可度量、可回归、可追溯
            </div>
            <div style={{ fontSize: 12.5, color: 'rgba(238,242,255,.72)', marginTop: 12, lineHeight: 1.8 }}>
              用例资产统一入库 · 真机自动遍历验证<br />AI 驱动分析与归因，覆盖完整测试闭环
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {FEATURES.map((f) => (
              <div key={f.title} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <span style={{
                  width: 32, height: 32, flexShrink: 0, borderRadius: 9, fontSize: 15,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,.10)', border: '1px solid rgba(255,255,255,.14)',
                }}>{f.icon}</span>
                <span>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{f.title}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'rgba(238,242,255,.62)', marginTop: 2 }}>{f.desc}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧表单区 */}
        <div style={{
          padding: '40px 38px', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', textAlign: 'center',
        }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '.02em' }}>
              {tab === 'login' ? '欢迎回来' : '创建账号'}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {tab === 'login' ? '登录以继续使用平台能力' : '使用管理员生成的邀请码完成注册'}
            </div>
          </div>

          {/* 分段切换 */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4,
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 18,
          }}>
            {(['login', 'register'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setTab(t); setErr(''); }}
                style={{
                  padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
                  border: tab === t ? '1px solid var(--accent)' : '1px solid transparent',
                  background: tab === t ? 'var(--accent-dim)' : 'transparent',
                  color: tab === t ? 'var(--accent2)' : 'var(--text3)', fontWeight: tab === t ? 600 : 400,
                }}
              >
                {t === 'login' ? '账号登录' : '邀请码注册'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left' }}>
            {tab === 'register' && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>邀请码</span>
                <input
                  className="input"
                  placeholder="管理员在「用户管理」页生成"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                />
              </label>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>用户名</span>
              <input
                className="input"
                placeholder="小写字母 / 数字 / 下划线"
                value={username}
                autoFocus
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>密码</span>
              <input
                className="input"
                type="password"
                placeholder={tab === 'register' ? '至少 8 位' : '请输入密码'}
                value={password}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
            记住账号并自动登录（7 天内免登录，过期后自动用保存的账号重新登录）
          </label>

          {err && <div className="error" style={{ margin: '12px 0 0' }}>⚠️ {err}</div>}
          {msg && <div className="ok" style={{ margin: '12px 0 0' }}>✓ {msg}</div>}

          <button
            className="btn primary"
            style={{ width: '100%', padding: '10px 0', fontSize: 13.5, marginTop: 18, justifyContent: 'center' }}
            disabled={busy || !username.trim() || !password}
            onClick={() => void submit()}
          >
            {busy ? '请稍候…' : tab === 'login' ? '登 录' : '注 册'}
          </button>

          <div className="muted" style={{ fontSize: 11, marginTop: 18, lineHeight: 1.7 }}>
            登录后按角色访问：管理员 / 组长 / 测试工程师 / 只读访客
          </div>
        </div>
      </div>
    </div>
  );
}
