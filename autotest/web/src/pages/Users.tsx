import { useCallback, useEffect, useState } from 'react';
import { api, authState, type AuthUser } from '../api';

const ROLE_OPTIONS = ['admin', 'manager', 'engineer', 'viewer'];
const ROLE_LABEL: Record<string, string> = {
  admin: '管理员', manager: '组长', engineer: '测试工程师', viewer: '只读访客',
};

interface UserRow { id: number; username: string; roles: string[]; status: string; created_at: string; last_login_at: string | null }

export default function UsersPage({ me }: { me: AuthUser | null }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<Array<Record<string, unknown>>>([]);
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);
  const [auditAction, setAuditAction] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' });
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyResult, setNewKeyResult] = useState('');
  const [pwd, setPwd] = useState({ old: '', next: '' });
  const isAdmin = !!me?.roles.includes('admin');
  const canAudit = !!me?.permissions.includes('audit:read');

  const load = useCallback(async () => {
    try {
      const [u, i, k, a] = await Promise.all([
        api.users(), api.invites(), api.keys(),
        canAudit ? api.audit(50, auditAction) : Promise.resolve({ ok: true, rows: [] as Array<Record<string, unknown>> }),
      ]);
      setUsers(u.users as UserRow[]);
      setInvites(i.invites);
      setKeys(k.keys);
      setAudit(a.rows);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }, [canAudit, auditAction]);

  useEffect(() => { void load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const createUser = async () => {
    try {
      await api.createUser(newUser.username, newUser.password, [newUser.role]);
      setNewUser({ username: '', password: '', role: 'viewer' });
      flash(`已创建用户 ${newUser.username}（${ROLE_LABEL[newUser.role]}）`);
      void load();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const genInvite = async () => {
    try {
      const r = await api.createInvite('viewer');
      await navigator.clipboard?.writeText(r.code).catch(() => {});
      flash(`邀请码已生成并复制：${r.code}`);
      void load();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const resetPwd = async (id: number) => {
    try {
      const r = await api.resetPassword(id);
      flash(`临时密码：${r.tempPassword}（请转告用户尽快修改）`);
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const createKey = async () => {
    try {
      const r = await api.createKey(newKeyName || '默认 Key', []);
      setNewKeyResult(r.key);
      setNewKeyName('');
      void load();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const changePwd = async () => {
    try {
      await api.changePassword(pwd.old, pwd.next);
      setPwd({ old: '', next: '' });
      flash('密码已修改');
    } catch (e) { setErr(String((e as Error).message)); }
  };

  return (
    <>
      <div className="page-title">用户管理</div>
      <div className="page-desc">多用户账号 · 角色权限 · 邀请码 · API Key · 审计（数据存服务器 MySQL）</div>

      {err && <div className="error">⚠️ {err}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {/* 用户列表 */}
      <div className="card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="card-h" style={{ marginBottom: 10 }}>
          <span className="t">用户列表（{users.length}）</span>
          {isAdmin && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <input className="input" style={{ width: 130 }} placeholder="用户名" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
              <input className="input" style={{ width: 130 }} placeholder="初始密码" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              <select className="select" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <button className="btn primary" onClick={() => void createUser()}>新建用户</button>
            </span>
          )}
        </div>
        <table className="tbl" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th>最近登录</th><th style={{ width: 260 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.username}</b>{u.id === me?.id ? '（我）' : ''}</td>
                <td>
                  {isAdmin && u.id !== me?.id ? (
                    <select
                      className="select"
                      value={u.roles[0] ?? 'viewer'}
                      onChange={(e) => { void api.setUserRole(u.id, [e.target.value]).then(() => { flash('角色已更新'); void load(); }); }}
                    >
                      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : u.roles.map((r) => ROLE_LABEL[r] ?? r).join(' / ')}
                </td>
                <td><span className={`tag ${u.status === 'active' ? 'green' : 'gray'}`}>{u.status}</span></td>
                <td className="muted">{String(u.created_at ?? '').slice(0, 10)}</td>
                <td className="muted">{String(u.last_login_at ?? '—').slice(0, 16)}</td>
                <td>
                  {isAdmin && u.id !== me?.id && (
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn sm" onClick={() => void api.setUserStatus(u.id, u.status === 'active' ? 'locked' : 'active').then(() => { flash(u.status === 'active' ? '已锁定' : '已解锁'); void load(); })}>
                        {u.status === 'active' ? '锁定' : '解锁'}
                      </button>
                      <button className="btn sm" onClick={() => void resetPwd(u.id)}>重置密码</button>
                      <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => { if (window.confirm(`禁用用户 ${u.username}？`)) void api.deleteUser(u.id).then(() => { flash('已禁用'); void load(); }); }}>禁用</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginBottom: 14 }}>
        {/* 邀请码 */}
        {isAdmin && (
          <div className="card" style={{ padding: 14 }}>
            <div className="card-h" style={{ marginBottom: 8 }}>
              <span className="t">邀请码</span>
              <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => void genInvite()}>生成（访客角色）</button>
            </div>
            {invites.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>暂无邀请码</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {invites.map((iv) => (
                <div key={Number(iv.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px' }}>
                  <span className="mono" style={{ color: 'var(--accent2)' }}>{String(iv.code)}</span>
                  <span className="tag plain">{ROLE_LABEL[String(iv.role_code)] ?? String(iv.role_code)}</span>
                  <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {iv.used_username ? `已被 ${iv.used_username} 使用` : `有效期至 ${String(iv.expires_at ?? '').slice(0, 10)}`}
                  </span>
                  {!iv.used_by && (
                    <span className="link" style={{ color: 'var(--red)' }} onClick={() => { void api.revokeInvite(Number(iv.id)).then(() => { void load(); }); }}>吊销</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* API Key */}
        <div className="card" style={{ padding: 14 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">我的 API Key（CI / 脚本）</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <input className="input" style={{ width: 140 }} placeholder="用途" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
              <button className="btn primary sm" onClick={() => void createKey()}>生成</button>
            </span>
          </div>
          {newKeyResult && (
            <div className="ok" style={{ marginBottom: 8, wordBreak: 'break-all' }}>
              ✓ 新 Key（只显示一次，请妥善保存）：<span className="mono">{newKeyResult}</span>
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { void navigator.clipboard?.writeText(newKeyResult); flash('已复制'); }}>复制</button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {keys.map((k) => (
              <div key={Number(k.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px' }}>
                <span style={{ flex: 1 }}>{String(k.name)}</span>
                <span className={`tag ${k.status === 'active' ? 'green' : 'gray'}`}>{String(k.status)}</span>
                <span className="muted">{String(k.last_used_at ?? '未使用').slice(0, 16)}</span>
                {k.status === 'active' && (
                  <span className="link" style={{ color: 'var(--red)' }} onClick={() => { if (window.confirm('吊销该 Key？')) void api.revokeKey(Number(k.id)).then(() => { void load(); }); }}>吊销</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 修改密码 */}
        <div className="card" style={{ padding: 14 }}>
          <div className="card-h" style={{ marginBottom: 8 }}><span className="t">修改我的密码</span></div>
          <input className="input" type="password" style={{ width: '100%', marginBottom: 8 }} placeholder="原密码" value={pwd.old} onChange={(e) => setPwd({ ...pwd, old: e.target.value })} />
          <input className="input" type="password" style={{ width: '100%', marginBottom: 8 }} placeholder="新密码（至少 8 位）" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} />
          <button className="btn" onClick={() => void changePwd()}>修改密码</button>
        </div>
      </div>

      {/* 审计 */}
      {canAudit && (
        <div className="card" style={{ padding: 14 }}>
          <div className="card-h" style={{ marginBottom: 8 }}>
            <span className="t">审计日志（最近 {audit.length} 条）</span>
            <select className="select" style={{ marginLeft: 'auto', width: 200 }} value={auditAction} onChange={(e) => setAuditAction(e.target.value)}>
              <option value="">全部操作</option>
              {['login', 'login.failed', 'logout', 'register', 'password.change', 'user.create', 'user.role', 'user.status', 'user.delete', 'user.reset-password', 'invite.create', 'invite.revoke', 'apikey.create', 'apikey.revoke', 'refresh'].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto', fontSize: 12.5 }}>
            {audit.map((a) => (
              <div key={Number(a.id)} style={{ display: 'flex', gap: 10, borderBottom: '1px solid var(--border)', padding: '5px 2px' }}>
                <span className="muted" style={{ width: 130, flexShrink: 0 }}>{String(a.created_at ?? '').slice(0, 16)}</span>
                <span className="mono" style={{ color: 'var(--accent2)', width: 110, flexShrink: 0 }}>{String(a.username ?? '—')}</span>
                <span style={{ width: 150, flexShrink: 0 }}>{String(a.action)}</span>
                <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(a.target)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
