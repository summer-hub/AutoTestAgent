// 认证接入：中间件 + /auth/* 路由
import { IncomingMessage } from 'node:http';
import { authDb } from './db.js';
import {
  authForToken, AuthError, AuthUser, createApiKey, createInvite, createUser, hashPassword, listApiKeys, listAudit,
  listInvites, listUsers, login, logout, refresh, register, resetPassword, revokeApiKey, revokeInvite, setUserRoles,
  setUserStatus, verifyPassword, writeAudit,
} from './service.js';

export interface HandlerArgs {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  auth?: AuthUser;
  req: IncomingMessage;
}

export type RouteFn = (
  method: string,
  pattern: string,
  handler: (args: HandlerArgs) => Promise<unknown>,
  opts?: { permission?: string },
) => void;

/** 从请求头解析 Bearer token。 */
export function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function clientIp(req: IncomingMessage): string {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').slice(0, 64);
}

/** 认证中间件：返回当前用户，无 token / 无效抛 401。 */
export async function requireAuth(req: IncomingMessage): Promise<AuthUser> {
  const token = bearerToken(req);
  if (!token) throw new AuthError('未登录', 401);
  return authForToken(token);
}

/** 注册 /auth/* 路由（http.ts 的 route 函数传入）。 */
export function registerAuthRoutes(route: RouteFn): void {
  // 登录 / 注册 / 刷新 / 登出（公开）
  route('POST', '/auth/login', async ({ body, req }) => {
    const b = body as { username?: string; password?: string };
    const r = await login(String(b.username ?? ''), String(b.password ?? ''), clientIp(req));
    return { ok: true, ...r };
  }, { permission: '@public' });

  route('POST', '/auth/register', async ({ body, req }) => {
    const b = body as { code?: string; username?: string; password?: string };
    const r = await register(String(b.code ?? ''), String(b.username ?? ''), String(b.password ?? ''), clientIp(req));
    return { ok: true, ...r };
  }, { permission: '@public' });

  route('POST', '/auth/refresh', async ({ body }) => {
    const b = body as { refreshToken?: string };
    if (!b.refreshToken) throw new AuthError('refreshToken 必填', 400);
    return { ok: true, ...(await refresh(b.refreshToken, '')) };
  }, { permission: '@public' });

  route('POST', '/auth/logout', async ({ body, auth }) => {
    const b = body as { refreshToken?: string };
    if (b.refreshToken) await logout(b.refreshToken, auth?.id ?? null);
    return { ok: true };
  }, { permission: '@login' });

  // 当前用户
  route('GET', '/auth/me', async ({ auth }) => {
    if (!auth) throw new AuthError('未登录', 401);
    return { ok: true, user: auth };
  }, { permission: '@login' });

  // 修改本人密码
  route('PUT', '/auth/password', async ({ auth, body, req }) => {
    if (!auth) throw new AuthError('未登录', 401);
    const b = body as { oldPassword?: string; newPassword?: string };
    if (!b.newPassword || b.newPassword.length < 8) throw new AuthError('新密码至少 8 位', 400);
    const db = await authDb();
    const [rows] = await db.query('SELECT password_hash FROM auth_users WHERE id = ?', [auth.id]) as [Array<{ password_hash: string }>, unknown];
    if (!rows[0] || !verifyPassword(String(b.oldPassword ?? ''), rows[0].password_hash)) throw new AuthError('原密码错误', 400);
    await db.query('UPDATE auth_users SET password_hash = ? WHERE id = ?', [hashPassword(b.newPassword), auth.id]);
    await writeAudit(auth.id, 'password.change', auth.username, '', clientIp(req));
    return { ok: true };
  }, { permission: '@login' });

  // 用户管理（user:manage）
  route('GET', '/auth/users', async () => ({ ok: true, users: await listUsers() }), { permission: 'user:manage' });

  route('POST', '/auth/users', async ({ body, auth, req }) => {
    const b = body as { username?: string; password?: string; roles?: string[] };
    const id = await createUser(String(b.username ?? ''), String(b.password ?? ''), Array.isArray(b.roles) ? b.roles : ['viewer']);
    await writeAudit(auth?.id ?? null, 'user.create', String(b.username ?? ''), JSON.stringify({ roles: b.roles }), clientIp(req));
    return { ok: true, id };
  }, { permission: 'user:manage' });

  route('PUT', '/auth/users/:id/role', async ({ params, body, auth, req }) => {
    const b = body as { roles?: string[] };
    await setUserRoles(Number(params.id), Array.isArray(b.roles) ? b.roles : []);
    await writeAudit(auth?.id ?? null, 'user.role', `#${params.id}`, JSON.stringify({ roles: b.roles }), clientIp(req));
    return { ok: true };
  }, { permission: 'user:manage' });

  route('PUT', '/auth/users/:id/status', async ({ params, body, auth, req }) => {
    const b = body as { status?: string };
    await setUserStatus(Number(params.id), String(b.status ?? ''));
    await writeAudit(auth?.id ?? null, 'user.status', `#${params.id}`, String(b.status), clientIp(req));
    return { ok: true };
  }, { permission: 'user:manage' });

  route('DELETE', '/auth/users/:id', async ({ params, auth, req }) => {
    await setUserStatus(Number(params.id), 'disabled');
    await writeAudit(auth?.id ?? null, 'user.delete', `#${params.id}`, '软删除（禁用）', clientIp(req));
    return { ok: true };
  }, { permission: 'user:manage' });

  route('POST', '/auth/users/:id/reset-password', async ({ params, auth, req }) => {
    const pw = await resetPassword(Number(params.id));
    await writeAudit(auth?.id ?? null, 'user.reset-password', `#${params.id}`, '管理员重置密码', clientIp(req));
    return { ok: true, tempPassword: pw };
  }, { permission: 'user:manage' });

  // 邀请码
  route('GET', '/auth/invites', async () => ({ ok: true, invites: await listInvites() }), { permission: 'user:manage' });

  route('POST', '/auth/invites', async ({ body, auth, req }) => {
    const b = body as { roleCode?: string; expiresDays?: number };
    const code = await createInvite(auth?.id ?? 0, String(b.roleCode ?? 'viewer'), Number(b.expiresDays) || 7);
    await writeAudit(auth?.id ?? null, 'invite.create', code, String(b.roleCode), clientIp(req));
    return { ok: true, code };
  }, { permission: 'user:manage' });

  route('DELETE', '/auth/invites/:id', async ({ params, auth, req }) => {
    await revokeInvite(Number(params.id));
    await writeAudit(auth?.id ?? null, 'invite.revoke', `#${params.id}`, '', clientIp(req));
    return { ok: true };
  }, { permission: 'user:manage' });

  // API Key（本人）
  route('GET', '/auth/keys', async ({ auth }) => {
    if (!auth) throw new AuthError('未登录', 401);
    return { ok: true, keys: await listApiKeys(auth.id) };
  }, { permission: '@login' });

  route('POST', '/auth/keys', async ({ auth, body, req }) => {
    if (!auth) throw new AuthError('未登录', 401);
    const b = body as { name?: string; scopes?: string[] };
    const r = await createApiKey(auth.id, String(b.name ?? ''), Array.isArray(b.scopes) ? b.scopes : []);
    await writeAudit(auth.id, 'apikey.create', r.row.name as string, '', clientIp(req));
    return { ok: true, key: r.key, row: r.row };
  }, { permission: '@login' });

  route('DELETE', '/auth/keys/:id', async ({ params, auth, req }) => {
    if (!auth) throw new AuthError('未登录', 401);
    await revokeApiKey(Number(params.id), auth.id);
    await writeAudit(auth.id, 'apikey.revoke', `#${params.id}`, '', clientIp(req));
    return { ok: true };
  }, { permission: '@login' });

  // 审计（audit:read）
  route('GET', '/auth/audit', async ({ query }) => {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    const action = String(query.get('action') ?? '').slice(0, 64);
    return { ok: true, rows: await listAudit(limit, offset, action) };
  }, { permission: 'audit:read' });
}
