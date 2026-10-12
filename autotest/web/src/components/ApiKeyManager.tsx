// API Key 与访问控制管理区（P0-1，admin 专属；认证关闭时也展示——那时人人可建首个 Key，
// 属于"开启认证前的引导态"）。挂载于系统配置页顶部。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface KeyInfo {
  id: number;
  name: string;
  role: string;
  enabled: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
}

const ROLE_LABEL: Record<string, string> = { admin: '管理员', operator: '操作员', viewer: '只读' };

export default function ApiKeyManager() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [bypass, setBypass] = useState(true);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // 创建表单
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const [days, setDays] = useState('');
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.authStatus().then((s) => { setEnabled(s.enabled); setBypass(s.allowLocalBypass); }).catch(() => {});
    api.authKeys().then((r) => setKeys(r.items)).catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (patch: { enabled?: boolean; allowLocalBypass?: boolean }) => {
    setError(''); setMsg('');
    try {
      const r = await api.updateAuthSettings(patch);
      setEnabled(r.enabled);
      setBypass(r.allowLocalBypass);
      setMsg(r.enabled ? '认证已开启：此后业务 API 要求 Authorization: Bearer <key>' : '认证已关闭：所有请求直接放行');
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const create = async () => {
    const n = name.trim();
    if (!n) { setError('请填写 Key 名称'); return; }
    setBusy(true); setError(''); setMsg(''); setCreated(null);
    try {
      const r = await api.createAuthKey({ name: n, role, expiresInDays: days ? Number(days) : undefined });
      setCreated({ key: r.key, name: r.name });
      setName(''); setDays('');
      setMsg(`Key「${r.name}」已创建（${ROLE_LABEL[r.role] ?? r.role}）—— 明文仅此一次展示，请立即复制保存`);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number, keyName: string) => {
    if (!window.confirm(`确认吊销 Key「${keyName}」？使用该 Key 的客户端将立即失效。`)) return;
    setError(''); setMsg('');
    try {
      await api.revokeAuthKey(id);
      setMsg(`已吊销「${keyName}」`);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg('已复制到剪贴板');
    } catch {
      setMsg('复制失败，请手动选择复制');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <span className="t">API Key 与访问控制</span>
        <span className="sub">认证 + RBAC（admin/operator/viewer）· 仅管理员可管理 · Key 只存哈希，明文仅创建时展示一次</span>
      </div>

      {error && <div className="error" style={{ marginBottom: 8 }}>⚠️ {error}</div>}
      {msg && <div className="ok" style={{ marginBottom: 8 }}>✓ {msg}</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          访问认证：<b style={{ color: enabled ? 'var(--ok, #34d399)' : 'var(--text3)' }}>{enabled === null ? '检测中…' : enabled ? '已开启' : '未开启'}</b>
        </span>
        <button className="btn" disabled={busy} onClick={() => void toggle({ enabled: !enabled })}>
          {enabled ? '关闭认证' : '开启认证'}
        </button>
        <span className="muted" style={{ fontSize: 12.5, marginLeft: 12 }}>
          本机回环免 Key：<b>{bypass ? '允许' : '禁止'}</b>
        </span>
        <button className="btn" disabled={busy} onClick={() => void toggle({ allowLocalBypass: !bypass })}>
          {bypass ? '禁止回环豁免' : '允许回环豁免'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 14, lineHeight: 1.6 }}>
        开启认证后：GET=viewer、写操作=operator、系统配置/模型/Key 管理=admin；桌面端与本机开发走 127.0.0.1，
        「回环免 Key」开启时视为 admin。关闭回环豁免后本机也必须带 Key——改前请确认自己手里有 admin Key。
      </div>

      {/* 创建 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>名称</span>
          <input className="input" style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：CI-Runner" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>角色</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">只读</option>
            <option value="operator">操作员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>有效期（天，空=永久）</span>
          <input className="input" style={{ width: 130 }} value={days} onChange={(e) => setDays(e.target.value)} placeholder="如 90" inputMode="numeric" />
        </label>
        <button className="btn primary" disabled={busy} onClick={() => void create()}>{busy ? '创建中…' : '创建 Key'}</button>
      </div>

      {created && (
        <div className="card" style={{ background: 'var(--panel3, #1e293b)', marginBottom: 12, border: '1px solid var(--warn, #f59e0b)' }}>
          <div style={{ fontSize: 12.5, marginBottom: 6 }}>🔑 Key「{created.name}」明文（**仅此一次**，刷新后无法再查看）：</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code className="mono" style={{ fontSize: 12, wordBreak: 'break-all', flex: 1 }}>{created.key}</code>
            <button className="btn" onClick={() => void copy(created.key)}>复制</button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <table className="table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>名称</th>
            <th style={{ textAlign: 'left' }}>角色</th>
            <th style={{ textAlign: 'left' }}>状态</th>
            <th style={{ textAlign: 'left' }}>过期时间</th>
            <th style={{ textAlign: 'left' }}>最近使用</th>
            <th style={{ textAlign: 'left' }}>创建时间</th>
            <th style={{ textAlign: 'left' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {keys.length === 0 && (
            <tr><td colSpan={7} className="muted" style={{ padding: 14 }}>尚无 API Key</td></tr>
          )}
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><span className="tag">{ROLE_LABEL[k.role] ?? k.role}</span></td>
              <td>{k.enabled ? '✅ 启用' : '⛔ 已吊销'}</td>
              <td className="muted">{k.expiresAt || '永久'}</td>
              <td className="muted">{k.lastUsedAt || '从未使用'}</td>
              <td className="muted">{k.createdAt}</td>
              <td>
                <button className="btn" style={{ fontSize: 12 }} onClick={() => void revoke(k.id, k.name)}>吊销</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
