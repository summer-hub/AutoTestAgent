// 登录门（P0-1 认证）：服务端开启认证且当前无有效身份时，替代主界面渲染。
// key 存 sessionStorage（关标签页即失效）；提交后带 key 复访 /auth/status 验证——
// 拿到 role 即放行，无效则清空重试。样式沿用全局（内联兜底，避免新增 CSS 依赖）。
import { useState } from 'react';
import { api, setApiKey } from '../api';
import { setRole } from '../authState';

export default function LoginScreen({ onLogin }: { onLogin: (role: string) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const k = key.trim();
    if (!k) {
      setError('请输入 API Key');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setApiKey(k);
      const status = await api.authStatus();
      if (status.role) {
        setRole(status.role);
        onLogin(status.role);
      } else {
        setApiKey('');
        setError('服务端未接受该 Key（无效、已禁用或已过期）');
      }
    } catch (e) {
      setApiKey('');
      setError((e as Error).message || '校验失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #0b1120)', padding: 24,
    }}>
      <div className="card" style={{ width: 400, maxWidth: '100%', padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div className="brand-logo" style={{ width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center, flex-shrink: 0', fontSize: 18, fontWeight: 700 }}>A</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>AutoTest 平台</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>鸿蒙三方库自动化测试</div>
          </div>
        </div>
        <div style={{ fontSize: 13, marginBottom: 8 }}>此服务已开启访问认证，请输入 API Key</div>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder="at_..."
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 13,
            borderRadius: 8, border: '1px solid var(--border, #334155)',
            background: 'var(--panel2, #1e293b)', color: 'inherit', marginBottom: 12,
          }}
        />
        {error && <div style={{ fontSize: 12, color: '#f87171', marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" type="button" disabled={busy} onClick={() => void submit()} style={{ width: '100%' }}>
          {busy ? '校验中…' : '登 录'}
        </button>
        <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 16, lineHeight: 1.6 }}>
          Key 由管理员在「系统配置 → API Key 与访问控制」创建，明文仅创建时展示一次。
          本机回环访问可在服务端配置 allowLocalBypass 免 Key 放行。
        </div>
      </div>
    </div>
  );
}
