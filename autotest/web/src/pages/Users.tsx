// 用户中心（CRM/OA 企业级）：分页签组织 · 全弹窗操作
//  - 用户列表：搜索 / 角色调整 / 锁定 / 重置密码 / 禁用；新建用户走弹窗（含确认密码与随机初始密码）
//  - 邀请码：生成弹窗（角色 + 有效期）→ 结果大字展示 + 复制；列表含状态与吊销
//  - API Key：面向 CI/脚本的机器身份令牌，附用途说明与调用示例；只显示一次
//  - 修改密码：弹窗（原密码 / 新密码 / 确认新密码）
import { useCallback, useEffect, useState } from 'react';
import { api, type AuthUser } from '../api';

const ROLE_OPTIONS = ['admin', 'manager', 'engineer', 'viewer'];
const ROLE_LABEL: Record<string, string> = {
  admin: '管理员', manager: '组长', engineer: '测试工程师', viewer: '只读访客',
};

interface UserRow { id: number; username: string; roles: string[]; status: string; created_at: string; last_login_at: string | null }
type Tab = 'users' | 'invites' | 'keys' | 'audit';
type Modal =
  | null
  | { type: 'createUser' }
  | { type: 'invite' }
  | { type: 'pwd' }
  | { type: 'key' }
  | { type: 'keyResult'; key: string };

function randomPassword(): string {
  return 'At' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 4).toUpperCase() + '#';
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard?.writeText(text); return true; } catch { return false; }
}

export default function UsersPage({ me }: { me: AuthUser | null }) {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userQ, setUserQ] = useState('');
  const [invites, setInvites] = useState<Array<Record<string, unknown>>>([]);
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);
  const [auditAction, setAuditAction] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const canManage = !!(me?.permissions ?? []).includes('user:manage');
  const canAudit = !!(me?.permissions ?? []).includes('audit:read');

  // ---- 弹窗表单状态 ----
  const [cuForm, setCuForm] = useState({ username: '', password: randomPassword(), confirm: '', role: 'viewer' });
  const [inviteForm, setInviteForm] = useState<{ role: string; days: number }>({ role: 'viewer', days: 7 });
  const [pwdForm, setPwdForm] = useState({ old: '', next: '', confirm: '' });
  const [keyName, setKeyName] = useState('');
  const [modalErr, setModalErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, i, k, a] = await Promise.all([
        api.users(), api.invites(), api.keys(),
        canAudit ? api.audit(50, auditAction) : Promise.resolve({ ok: true, rows: [] as Array<Record<string, unknown>> }),
      ]);
      setUsers(u.users as unknown as UserRow[]);
      setInvites(i.invites);
      setKeys(k.keys);
      setAudit(a.rows);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }, [canAudit, auditAction]);

  useEffect(() => { void load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  // ---- 弹窗动作 ----
  const submitCreateUser = async (): Promise<void> => {
    const name = cuForm.username.trim();
    if (!/^[a-z0-9_]{3,32}$/.test(name)) { setModalErr('用户名需 3~32 位小写字母/数字/下划线'); return; }
    if (cuForm.password.length < 8) { setModalErr('初始密码至少 8 位'); return; }
    if (cuForm.password !== cuForm.confirm) { setModalErr('两次输入的密码不一致'); return; }
    setBusy(true); setModalErr('');
    try {
      await api.createUser(name, cuForm.password, [cuForm.role]);
      setModal(null);
      flash(`已创建用户 ${name}（${ROLE_LABEL[cuForm.role]}）`);
      void load();
    } catch (e) { setModalErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const submitInvite = async (): Promise<void> => {
    setBusy(true); setModalErr('');
    try {
      const r = await api.createInvite(inviteForm.role, inviteForm.days);
      await navigator.clipboard?.writeText(r.code).catch(() => {});
      flash(`邀请码 ${r.code} 已生成并复制`);
      setModal(null);
      setTab('invites');
      void load();
    } catch (e) { setModalErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const submitPwd = async (): Promise<void> => {
    if (!pwdForm.old) { setModalErr('请输入原密码'); return; }
    if (pwdForm.next.length < 8) { setModalErr('新密码至少 8 位'); return; }
    if (pwdForm.next !== pwdForm.confirm) { setModalErr('两次输入的新密码不一致'); return; }
    setBusy(true); setModalErr('');
    try {
      await api.changePassword(pwdForm.old, pwdForm.next);
      setModal(null);
      flash('密码已修改');
    } catch (e) { setModalErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const submitKey = async (): Promise<void> => {
    setBusy(true); setModalErr('');
    try {
      const r = await api.createKey(keyName || '默认 Key', []);
      setModal(null);
      void load();
      // 展示一次性 Key
      setTab('keys');
      setTimeout(() => setModal({ type: 'keyResult', key: r.key }), 50);
    } catch (e) { setModalErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const filteredUsers = users.filter((u) => u.username.toLowerCase().includes(userQ.toLowerCase()));
  const inviteState = (iv: Record<string, unknown>): { label: string; cls: string } => {
    if (iv.used_by) return { label: '已使用', cls: 'gray' };
    if (iv.expires_at && new Date(String(iv.expires_at)) < new Date()) return { label: '已过期', cls: 'red' };
    return { label: '未使用', cls: 'green' };
  };

  // ---- 弹窗渲染 ----
  const renderModal = () => {
    if (!modal) return null;
    const close = () => { setModal(null); setModalErr(''); };
    let title = '';
    let body: React.ReactNode = null;
    if (modal.type === 'createUser') {
      title = '新建用户';
      body = (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>用户名（3~32 位小写字母/数字/下划线）</span>
            <input className="input" value={cuForm.username} autoFocus onChange={(e) => setCuForm({ ...cuForm, username: e.target.value })} placeholder="如 zhangsan" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>角色</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {ROLE_OPTIONS.map((r) => (
                <button key={r} type="button"
                  onClick={() => setCuForm({ ...cuForm, role: r })}
                  style={{
                    padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                    border: cuForm.role === r ? '1px solid var(--accent)' : '1px solid var(--border2)',
                    background: cuForm.role === r ? 'var(--accent-dim)' : 'transparent',
                    color: cuForm.role === r ? 'var(--accent2)' : 'var(--text3)', fontWeight: cuForm.role === r ? 600 : 400,
                  }}
                >{ROLE_LABEL[r]}</button>
              ))}
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>初始密码（至少 8 位）</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input mono" style={{ flex: 1 }} value={cuForm.password} onChange={(e) => setCuForm({ ...cuForm, password: e.target.value })} />
              <button className="btn sm" type="button" title="生成随机密码" onClick={() => setCuForm({ ...cuForm, password: randomPassword() })}>🎲</button>
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>确认初始密码</span>
            <input className="input mono" type="password" value={cuForm.confirm} onChange={(e) => setCuForm({ ...cuForm, confirm: e.target.value })} />
          </label>
        </>
      );
    } else if (modal.type === 'invite') {
      title = '生成邀请码';
      body = (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>注册后的初始角色</span>
            <select className="select" value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}>
              {ROLE_OPTIONS.filter((r) => r !== 'admin').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>有效期（天）</span>
            <input className="input" type="number" min={1} max={90} value={inviteForm.days} onChange={(e) => setInviteForm({ ...inviteForm, days: Number(e.target.value) })} />
          </label>
          <div className="muted" style={{ fontSize: 11.5 }}>邀请码生成后自动复制到剪贴板，也可在「邀请码」页签中再次查看。</div>
        </>
      );
    } else if (modal.type === 'pwd') {
      title = '修改我的密码';
      body = (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>原密码</span>
            <input className="input" type="password" autoFocus value={pwdForm.old} onChange={(e) => setPwdForm({ ...pwdForm, old: e.target.value })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>新密码（至少 8 位）</span>
            <input className="input" type="password" value={pwdForm.next} onChange={(e) => setPwdForm({ ...pwdForm, next: e.target.value })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>再次输入新密码</span>
            <input className="input" type="password" value={pwdForm.confirm} onChange={(e) => setPwdForm({ ...pwdForm, confirm: e.target.value })} />
          </label>
        </>
      );
    } else if (modal.type === 'key') {
      title = '生成 API Key';
      body = (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="muted" style={{ fontSize: 12 }}>用途名称（便于识别，如 jenkins-回归任务）</span>
            <input className="input" autoFocus value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="默认 Key" />
          </label>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            Key 仅在生成时完整显示一次，请立即保存。吊销后使用该 Key 的脚本将立即失效。
          </div>
        </>
      );
    } else if (modal.type === 'keyResult') {
      title = '✓ API Key 已生成';
      body = (
        <>
          <div className="ok" style={{ wordBreak: 'break-all', lineHeight: 1.7 }}>
            <div style={{ marginBottom: 6 }}><b>只显示这一次</b>，请立即复制保存：</div>
            <span className="mono" style={{ fontSize: 13 }}>{modal.key}</span>
            <div style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => { void copyText(modal.key); flash('已复制'); }}>📋 复制 Key</button>
            </div>
          </div>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>CI/脚本中的用法示例：</div>
            <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text2)' }}>{`curl -H "Authorization: Bearer ${modal.key}" \\
  https://<服务地址>/api/autotest/libraries`}</pre>
          </div>
        </>
      );
    }
    const isWide = modal.type === 'keyResult';
    return (
      <div className="s-overlay show">
        <div className="s-mask" onClick={close} />
        <div style={{ position: 'relative', zIndex: 1, width: isWide ? 620 : 480, maxWidth: 'calc(100vw - 40px)', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.55)', padding: '22px 22px 18px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>{title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {body}
            {modalErr && <div className="error" style={{ marginBottom: 0 }}>⚠️ {modalErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button className="btn" onClick={close}>{modal.type === 'keyResult' ? '我已保存' : '取消'}</button>
              {(modal.type === 'createUser' || modal.type === 'invite' || modal.type === 'pwd' || modal.type === 'key') && (
                <button className="btn primary" disabled={busy}
                  onClick={() => {
                    if (modal.type === 'createUser') void submitCreateUser();
                    else if (modal.type === 'invite') void submitInvite();
                    else if (modal.type === 'pwd') void submitPwd();
                    else void submitKey();
                  }}
                >{busy ? '提交中…' : modal.type === 'createUser' ? '创建用户' : modal.type === 'invite' ? '生成邀请码' : modal.type === 'pwd' ? '确认修改' : '生成 Key'}</button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const TABS: Array<{ k: Tab; label: string }> = [
    { k: 'users', label: `用户列表${canManage ? `（${users.length}）` : ''}` },
    ...(canManage ? [{ k: 'invites' as Tab, label: '邀请码' }] : []),
    { k: 'keys', label: 'API Key' },
    ...(canAudit ? [{ k: 'audit' as Tab, label: '审计日志' }] : []),
  ];

  return (
    <>
      <div className="page-title">用户中心</div>
      <div className="page-desc">账号与权限管理 · 邀请码注册 · CI/脚本机器身份 · 操作审计</div>

      {/* 页头动作区 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {canManage && <button className="btn primary" onClick={() => { setCuForm({ username: '', password: randomPassword(), confirm: '', role: 'viewer' }); setModal({ type: 'createUser' }); }}>＋ 新建用户</button>}
        {canManage && <button className="btn" onClick={() => { setInviteForm({ role: 'viewer', days: 7 }); setModal({ type: 'invite' }); }}>✉️ 生成邀请码</button>}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => { setPwdForm({ old: '', next: '', confirm: '' }); setModal({ type: 'pwd' }); }}>🔑 修改我的密码</button>
      </div>

      {err && <div className="error">⚠️ {err}</div>}
      {msg && <div className="ok">✓ {msg}</div>}

      {/* 页签 */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 14, width: 'fit-content' }}>
        {TABS.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{
              padding: '7px 16px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', border: 'none',
              background: tab === t.k ? 'var(--panel)' : 'transparent',
              color: tab === t.k ? 'var(--text)' : 'var(--text3)',
              fontWeight: tab === t.k ? 600 : 400,
              boxShadow: tab === t.k ? '0 1px 4px rgba(0,0,0,.18)' : 'none',
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* ===== 用户列表 ===== */}
      {tab === 'users' && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <div className="search-wrap" style={{ maxWidth: 260 }}>
              <span className="ic">🔍</span>
              <input className="input" placeholder="搜索用户名…" value={userQ} onChange={(e) => setUserQ(e.target.value)} />
            </div>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>共 {filteredUsers.length} 个账号</span>
          </div>
          <table>
            <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th>最近登录</th>{canManage && <th style={{ width: 250 }}>操作</th>}</tr></thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.username}</b>{u.id === me?.id && <span className="tag blue" style={{ marginLeft: 6 }}>我</span>}</td>
                  <td>
                    {canManage && u.id !== me?.id ? (
                      <select className="select" style={{ width: 110 }} value={u.roles[0] ?? 'viewer'}
                        onChange={(e) => { void api.setUserRole(u.id, [e.target.value]).then(() => { flash('角色已更新'); void load(); }); }}
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : u.roles.map((r) => ROLE_LABEL[r] ?? r).join(' / ')}
                  </td>
                  <td><span className={`tag ${u.status === 'active' ? 'green' : 'red'}`}>{u.status === 'active' ? '正常' : u.status === 'locked' ? '已锁定' : '已禁用'}</span></td>
                  <td className="muted">{String(u.created_at ?? '').slice(0, 10)}</td>
                  <td className="muted">{String(u.last_login_at ?? '从未登录').slice(0, 16)}</td>
                  {canManage && (
                    <td>
                      {u.id !== me?.id && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="btn sm" onClick={() => void api.setUserStatus(u.id, u.status === 'active' ? 'locked' : 'active').then(() => { flash(u.status === 'active' ? '已锁定' : '已解锁'); void load(); })}>
                            {u.status === 'active' ? '锁定' : '解锁'}
                          </button>
                          <button className="btn sm" onClick={() => void api.resetPassword(u.id).then((r) => { flash(`临时密码：${r.tempPassword}（请转告用户尽快修改）`); })}>重置密码</button>
                          <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => { if (window.confirm(`禁用用户 ${u.username}？该用户将无法登录。`)) void api.deleteUser(u.id).then(() => { flash('已禁用'); void load(); }); }}>禁用</button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {filteredUsers.length === 0 && <tr><td colSpan={6}><div className="loading">无匹配用户</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== 邀请码 ===== */}
      {tab === 'invites' && canManage && (
        <div className="card" style={{ padding: 14 }}>
          <div className="card-h" style={{ marginBottom: 10 }}>
            <span className="t">邀请码列表</span>
            <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => { setInviteForm({ role: 'viewer', days: 7 }); setModal({ type: 'invite' }); }}>✉️ 生成邀请码</button>
          </div>
          {invites.length === 0 ? (
            <div className="loading">暂无邀请码。点击右上角「生成邀请码」，新成员凭邀请码在登录页完成自助注册。</div>
          ) : (
            <table>
              <thead><tr><th>邀请码</th><th>注册角色</th><th>状态</th><th>有效期至</th><th>使用者</th><th>操作</th></tr></thead>
              <tbody>
                {invites.map((iv) => {
                  const st = inviteState(iv);
                  return (
                    <tr key={Number(iv.id)}>
                      <td><span className="mono" style={{ color: 'var(--accent2)', fontSize: 13 }}>{String(iv.code)}</span></td>
                      <td>{ROLE_LABEL[String(iv.role_code)] ?? String(iv.role_code)}</td>
                      <td><span className={`tag ${st.cls}`}>{st.label}</span></td>
                      <td className="muted">{String(iv.expires_at ?? '').slice(0, 10)}</td>
                      <td className="muted">{iv.used_username ? String(iv.used_username) : '—'}</td>
                      <td>
                        {!iv.used_by ? (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn sm" onClick={() => { void copyText(String(iv.code)).then((okc) => flash(okc ? '已复制' : '复制失败')); }}>复制</button>
                            <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => { if (window.confirm('吊销该邀请码？')) void api.revokeInvite(Number(iv.id)).then(() => { flash('已吊销'); void load(); }); }}>吊销</button>
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ===== API Key ===== */}
      {tab === 'keys' && (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
            <div style={{ fontSize: 12.8, lineHeight: 1.9, color: 'var(--text2)' }}>
              <b>这是什么？</b>&nbsp;&nbsp;API Key 用于让 <b>CI 流水线 / 自动化脚本</b> 以你的身份调用平台接口，避免把个人密码写进脚本。
              请求时携带请求头 <code className="mono">Authorization: Bearer sk_xxx</code> 即可，例如：
              <pre className="mono" style={{ fontSize: 11, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginTop: 8, whiteSpace: 'pre-wrap' }}>{`curl -H "Authorization: Bearer sk_xxx" https://<服务地址>/api/autotest/libraries`}</pre>
              权限与你本人一致，可随时吊销；<b>Key 明文只在生成那一刻显示一次</b>。
            </div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="card-h" style={{ marginBottom: 10 }}>
              <span className="t">我的 Key（{keys.length}）</span>
              <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={() => { setKeyName(''); setModal({ type: 'key' }); }}>🔑 生成新 Key</button>
            </div>
            {keys.length === 0 ? (
              <div className="loading">还没有 API Key。如果只是人工在页面上操作，无需生成。</div>
            ) : (
              <table>
                <thead><tr><th>用途</th><th>状态</th><th>最后使用</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={Number(k.id)}>
                      <td><b>{String(k.name)}</b></td>
                      <td><span className={`tag ${k.status === 'active' ? 'green' : 'gray'}`}>{k.status === 'active' ? '启用中' : '已吊销'}</span></td>
                      <td className="muted">{String(k.last_used_at ?? '未使用').slice(0, 16)}</td>
                      <td className="muted">{String(k.created_at ?? '').slice(0, 16)}</td>
                      <td>
                        {k.status === 'active' && (
                          <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => { if (window.confirm('吊销该 Key？使用它的脚本将立即失效。')) void api.revokeKey(Number(k.id)).then(() => { flash('已吊销'); void load(); }); }}>吊销</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ===== 审计日志 ===== */}
      {tab === 'audit' && canAudit && (
        <div className="card" style={{ padding: 14 }}>
          <div className="card-h" style={{ marginBottom: 10 }}>
            <span className="t">审计日志（最近 {audit.length} 条）</span>
            <select className="select" style={{ marginLeft: 'auto', width: 200 }} value={auditAction} onChange={(e) => setAuditAction(e.target.value)}>
              <option value="">全部操作</option>
              {['login', 'login.failed', 'logout', 'register', 'password.change', 'user.create', 'user.role', 'user.status', 'user.delete', 'user.reset-password', 'invite.create', 'invite.revoke', 'apikey.create', 'apikey.revoke', 'refresh'].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          {audit.length === 0 ? (
            <div className="loading">暂无审计记录</div>
          ) : (
            <table>
              <thead><tr><th style={{ width: 140 }}>时间</th><th style={{ width: 120 }}>用户</th><th style={{ width: 160 }}>操作</th><th>对象</th></tr></thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={Number(a.id)}>
                    <td className="mono muted">{String(a.created_at ?? '').slice(0, 16)}</td>
                    <td>{String(a.username ?? '—')}</td>
                    <td><span className="tag plain">{String(a.action)}</span></td>
                    <td className="muted">{String(a.target)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {renderModal()}
    </>
  );
}
