// 认证服务：scrypt 密码 / HS256 JWT / 邀请注册 / refresh 会话 / API Key / RBAC 装载
import crypto from 'node:crypto';
import { authDb } from './db.js';
import { getSetting, setSetting } from '../services/settings.js';
export class AuthError extends Error {
    statusCode;
    constructor(message, statusCode = 401) {
        super(message);
        this.statusCode = statusCode;
    }
}
function nowStr() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function sha256(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}
// ---------- 密码（scrypt，Node 内置，零原生依赖） ----------
export function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const h = crypto.scryptSync(pw, salt, 32).toString('hex');
    return `${salt}$${h}`;
}
export function verifyPassword(pw, stored) {
    const [salt, hash] = stored.split('$');
    if (!salt || !hash)
        return false;
    try {
        const h = crypto.scryptSync(pw, salt, 32);
        return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
    }
    catch {
        return false;
    }
}
// ---------- JWT（HS256，手写零依赖） ----------
function b64url(b) {
    return b.toString('base64url');
}
function jwtSecret() {
    let s = String(getSetting('auth.jwtSecret', '') || '').trim();
    if (!s) {
        s = crypto.randomBytes(32).toString('hex');
        setSetting('auth.jwtSecret', s);
        console.log('[dsh-autotest] 已生成并持久化 auth.jwtSecret');
    }
    return s;
}
export function signToken(payload, ttlSec) {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const body = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec })));
    const sig = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}
export function verifyToken(token) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    try {
        const sig = crypto.createHmac('sha256', jwtSecret()).update(`${parts[0]}.${parts[1]}`).digest('base64url');
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2])))
            return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000))
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
// ---------- API Key ----------
export function generateApiKey() {
    const key = `sk_${crypto.randomBytes(24).toString('base64url')}`;
    return { key, hash: sha256(key) };
}
// ---------- 权限装载 ----------
export async function loadAuthUser(userId) {
    const db = await authDb();
    const [users] = await db.query('SELECT id, username, status FROM auth_users WHERE id = ?', [userId]);
    if (users.length === 0)
        throw new AuthError('用户不存在', 401);
    if (users[0].status !== 'active')
        throw new AuthError('账号已锁定或禁用', 403);
    const [rows] = await db.query(`SELECT r.code AS role_code, p.code AS perm_code
     FROM auth_user_roles ur
     JOIN auth_roles r ON r.id = ur.role_id
     LEFT JOIN auth_role_permissions rp ON rp.role_id = ur.role_id
     LEFT JOIN auth_permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = ?`, [userId]);
    const roles = [...new Set(rows.map((r) => r.role_code))];
    const permissions = [...new Set(rows.map((r) => r.perm_code).filter((x) => !!x))];
    return { id: users[0].id, username: users[0].username, roles, permissions };
}
/** 根据 Bearer token（JWT 或 API Key）解析当前用户。 */
export async function authForToken(token) {
    if (token.startsWith('sk_')) {
        const db = await authDb();
        const hash = sha256(token);
        const [keys] = await db.query('SELECT id, user_id, status FROM auth_api_keys WHERE key_hash = ?', [hash]);
        if (keys.length === 0 || keys[0].status !== 'active')
            throw new AuthError('API Key 无效或已吊销', 401);
        await db.query('UPDATE auth_api_keys SET last_used_at = ? WHERE id = ?', [nowStr(), keys[0].id]);
        return loadAuthUser(keys[0].user_id);
    }
    const payload = verifyToken(token);
    if (!payload || typeof payload.userId !== 'number')
        throw new AuthError('登录已过期，请重新登录', 401);
    return loadAuthUser(payload.userId);
}
export function hasPermission(user, perm) {
    return user.permissions.includes(perm);
}
// ---------- 审计 ----------
export async function writeAudit(userId, action, target = '', detail = '', ip = '') {
    try {
        const db = await authDb();
        await db.query('INSERT INTO auth_audit_logs (user_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, action, target, detail, ip, nowStr()]);
    }
    catch (e) {
        console.warn('[dsh-autotest] 审计写入失败：', e.message);
    }
}
// ---------- 登录 / 注册 / 会话 ----------
export async function login(username, password, ip) {
    const db = await authDb();
    const name = String(username || '').trim().toLowerCase();
    if (!name || !password)
        throw new AuthError('用户名和密码必填', 400);
    // 失败锁定：15 分钟内 >= 5 次失败
    const [attempts] = await db.query('SELECT COUNT(*) AS n FROM auth_login_attempts WHERE username = ? AND attempted_at > ?', [name, new Date(Date.now() - 15 * 60_000).toISOString().slice(0, 19).replace('T', ' ')]);
    if (attempts[0].n >= 5)
        throw new AuthError('失败次数过多，请 15 分钟后再试', 429);
    const [users] = await db.query('SELECT id, username, password_hash, status FROM auth_users WHERE username = ?', [name]);
    if (users.length === 0 || !verifyPassword(password, users[0].password_hash)) {
        await db.query('INSERT INTO auth_login_attempts (username, attempted_at) VALUES (?, ?)', [name, nowStr()]);
        await writeAudit(null, 'login.failed', name, '密码错误或用户不存在', ip);
        throw new AuthError('用户名或密码错误', 401);
    }
    if (users[0].status !== 'active')
        throw new AuthError('账号已锁定或禁用', 403);
    await db.query('DELETE FROM auth_login_attempts WHERE username = ?', [name]);
    await db.query('UPDATE auth_users SET last_login_at = ? WHERE id = ?', [nowStr(), users[0].id]);
    const user = await loadAuthUser(users[0].id);
    const ttlSec = Number(getSetting('auth.accessTtlSec', 3600));
    const token = signToken({ userId: user.id, username: user.username }, ttlSec);
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const days = Number(getSetting('auth.refreshTtlDays', 7));
    await db.query('INSERT INTO auth_refresh_sessions (user_id, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)', [user.id, sha256(refreshToken), new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), ip, nowStr()]);
    await writeAudit(user.id, 'login', user.username, '', ip);
    return { token, refreshToken, user };
}
export async function register(inviteCode, username, password, ip) {
    const db = await authDb();
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(name))
        throw new AuthError('用户名需 3~32 位小写字母/数字/下划线', 400);
    if (!password || password.length < 8)
        throw new AuthError('密码至少 8 位', 400);
    const code = String(inviteCode || '').trim();
    if (getSetting('auth.inviteOnly', true)) {
        if (!code)
            throw new AuthError('注册需要邀请码', 400);
        const [invites] = await db.query('SELECT id, role_code, used_by, expires_at FROM auth_invite_codes WHERE code = ?', [code]);
        if (invites.length === 0 || invites[0].used_by !== null)
            throw new AuthError('邀请码无效或已被使用', 400);
        if (invites[0].expires_at && new Date(invites[0].expires_at) < new Date())
            throw new AuthError('邀请码已过期', 400);
        const roleCode = invites[0].role_code;
        const [existing] = await db.query('SELECT id FROM auth_users WHERE username = ?', [name]);
        if (existing.length > 0)
            throw new AuthError('用户名已存在', 409);
        const [r] = await db.query('INSERT INTO auth_users (username, password_hash, status, created_at) VALUES (?, ?, \'active\', ?)', [name, hashPassword(password), nowStr()]);
        const userId = r.insertId;
        await db.query(`INSERT IGNORE INTO auth_user_roles (user_id, role_id) SELECT ?, id FROM auth_roles WHERE code = ?`, [userId, roleCode]);
        await db.query('UPDATE auth_invite_codes SET used_by = ? WHERE id = ?', [userId, invites[0].id]);
        await writeAudit(userId, 'register', name, `邀请码注册，初始角色 ${roleCode}`, ip);
        // 直接登录
        const res = await login(name, password, ip);
        return res;
    }
    throw new AuthError('当前禁止开放注册', 403);
}
export async function refresh(refreshToken, ip) {
    const db = await authDb();
    const [rows] = await db.query('SELECT id, user_id, expires_at FROM auth_refresh_sessions WHERE token_hash = ? AND revoked = 0', [sha256(refreshToken)]);
    if (rows.length === 0)
        throw new AuthError('会话不存在或已吊销', 401);
    if (new Date(rows[0].expires_at) < new Date())
        throw new AuthError('会话已过期', 401);
    // 旋转：吊销旧 refresh，发新
    await db.query('UPDATE auth_refresh_sessions SET revoked = 1 WHERE id = ?', [rows[0].id]);
    const user = await loadAuthUser(rows[0].user_id);
    const ttlSec = Number(getSetting('auth.accessTtlSec', 3600));
    const token = signToken({ userId: user.id, username: user.username }, ttlSec);
    const newRefresh = crypto.randomBytes(32).toString('hex');
    const days = Number(getSetting('auth.refreshTtlDays', 7));
    await db.query('INSERT INTO auth_refresh_sessions (user_id, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)', [user.id, sha256(newRefresh), new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), ip, nowStr()]);
    await writeAudit(user.id, 'refresh', user.username, '', ip);
    return { token, refreshToken: newRefresh };
}
export async function logout(refreshToken, userId) {
    const db = await authDb();
    await db.query('UPDATE auth_refresh_sessions SET revoked = 1 WHERE token_hash = ?', [sha256(refreshToken)]);
    await writeAudit(userId, 'logout', '', '', '');
}
// ---------- 用户管理（user:manage） ----------
export async function listUsers() {
    const db = await authDb();
    const [users] = await db.query('SELECT id, username, email, status, created_at, last_login_at FROM auth_users ORDER BY id');
    const [roles] = await db.query(`SELECT ur.user_id, GROUP_CONCAT(r.code) AS role_codes
     FROM auth_user_roles ur JOIN auth_roles r ON r.id = ur.role_id
     GROUP BY ur.user_id`);
    const roleMap = new Map(roles.map((r) => [r.user_id, r.role_codes.split(',')]));
    return users.map((u) => ({ ...u, roles: roleMap.get(Number(u.id)) ?? [] }));
}
export async function createUser(username, password, roleCodes) {
    const db = await authDb();
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(name))
        throw new AuthError('用户名需 3~32 位小写字母/数字/下划线', 400);
    if (!password || password.length < 8)
        throw new AuthError('密码至少 8 位', 400);
    const [existing] = await db.query('SELECT id FROM auth_users WHERE username = ?', [name]);
    if (existing.length > 0)
        throw new AuthError('用户名已存在', 409);
    const [r] = await db.query('INSERT INTO auth_users (username, password_hash, status, created_at) VALUES (?, ?, \'active\', ?)', [name, hashPassword(password), nowStr()]);
    const userId = r.insertId;
    for (const role of [...new Set(roleCodes)]) {
        await db.query(`INSERT IGNORE INTO auth_user_roles (user_id, role_id) SELECT ?, id FROM auth_roles WHERE code = ?`, [userId, role]);
    }
    return userId;
}
export async function setUserRoles(userId, roleCodes) {
    const db = await authDb();
    await db.query('DELETE FROM auth_user_roles WHERE user_id = ?', [userId]);
    for (const role of [...new Set(roleCodes)]) {
        await db.query(`INSERT IGNORE INTO auth_user_roles (user_id, role_id) SELECT ?, id FROM auth_roles WHERE code = ?`, [userId, role]);
    }
}
export async function setUserStatus(userId, status) {
    const db = await authDb();
    if (!['active', 'locked', 'disabled'].includes(status))
        throw new AuthError('非法状态', 400);
    await db.query('UPDATE auth_users SET status = ? WHERE id = ?', [status, userId]);
}
export async function resetPassword(userId, newPassword) {
    const db = await authDb();
    const pw = newPassword && newPassword.length >= 8 ? newPassword : crypto.randomBytes(6).toString('base64url');
    await db.query('UPDATE auth_users SET password_hash = ? WHERE id = ?', [hashPassword(pw), userId]);
    await db.query('UPDATE auth_refresh_sessions SET revoked = 1 WHERE user_id = ?', [userId]);
    return pw;
}
// ---------- 邀请码 ----------
export async function listInvites() {
    const db = await authDb();
    const [rows] = await db.query(`SELECT c.id, c.code, c.role_code, c.used_by, u.username AS used_username, c.expires_at, c.created_at
     FROM auth_invite_codes c LEFT JOIN auth_users u ON u.id = c.used_by
     ORDER BY c.id DESC LIMIT 100`);
    return rows;
}
export async function createInvite(createdBy, roleCode, expiresDays = 7) {
    const db = await authDb();
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const exp = new Date(Date.now() + expiresDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query('INSERT INTO auth_invite_codes (code, role_code, used_by, expires_at, created_by, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [code, roleCode || 'viewer', exp, createdBy, nowStr()]);
    return code;
}
export async function revokeInvite(id) {
    const db = await authDb();
    await db.query('DELETE FROM auth_invite_codes WHERE id = ?', [id]);
}
// ---------- API Key 管理 ----------
export async function listApiKeys(userId) {
    const db = await authDb();
    const [rows] = await db.query('SELECT id, name, scopes, status, created_at, last_used_at FROM auth_api_keys WHERE user_id = ? ORDER BY id DESC', [userId]);
    return rows;
}
export async function createApiKey(userId, name, scopes) {
    const db = await authDb();
    const { key, hash } = generateApiKey();
    const [r] = await db.query('INSERT INTO auth_api_keys (user_id, name, key_hash, scopes, status, created_at) VALUES (?, ?, ?, ?, \'active\', ?)', [userId, String(name || '默认 Key').slice(0, 128), hash, JSON.stringify(scopes), nowStr()]);
    return { key, row: { id: r.insertId, name: String(name || '默认 Key'), scopes, status: 'active', created_at: nowStr() } };
}
export async function revokeApiKey(id, userId) {
    const db = await authDb();
    const [rows] = await db.query('SELECT id FROM auth_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
    if (rows.length === 0)
        throw new AuthError('Key 不存在', 404);
    await db.query('UPDATE auth_api_keys SET status = \'revoked\' WHERE id = ?', [id]);
}
// ---------- 审计查询 ----------
export async function listAudit(limit, offset, action = '') {
    const db = await authDb();
    const where = action ? 'WHERE a.action = ?' : '';
    const args = action ? [action, limit, offset] : [limit, offset];
    const [rows] = await db.query(`SELECT a.id, a.user_id, u.username, a.action, a.target, a.detail, a.ip, a.created_at
     FROM auth_audit_logs a LEFT JOIN auth_users u ON u.id = a.user_id
     ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, args);
    return rows;
}
