// 认证 + RBAC（企业级 P0-1）：API Key 体系。
//
// 设计约束（与既有体系的关系）：
//  - **默认关闭**（auth.enabled=false）：DSH 插件形态、既有独立版部署、全部自检零感知；
//    企业部署在「系统配置」一键开启。开启 = 显式选择，不是默默改变行为。
//  - **回环豁免**（auth.allowLocalBypass，默认 true）：桌面端 WebView 与本机开发走 127.0.0.1，
//    免 Key 直接放行（视为 admin）——否则桌面端第一次启动就会把自己锁在门外。
//  - **只存哈希**：key 明文（at_<43 位 base58>）仅在创建响应返回一次，库内只有 SHA-256；
//    拖库也拿不到可用凭据（与 crypto.ts 的静态加密是两层不同防护：一个防拖库、一个防运行时泄漏）。
//  - **角色** admin(3) > operator(2) > viewer(1)；默认定权：GET=viewer、写=operator、
//    settings/models/auth 敏感组=admin（http.ts 路由可逐条覆盖）。
//  - /health 与 /auth/status 永久免鉴权：LB 探活与登录门需要。
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';

export type Role = 'admin' | 'operator' | 'viewer';
const RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export interface AuthContext {
  role: Role;
  keyId: number | null;
  via: 'key' | 'bypass';
}

export function authEnabled(): boolean {
  return getSetting<boolean>('auth.enabled', false) === true;
}

export function localBypassEnabled(): boolean {
  return getSetting<boolean>('auth.allowLocalBypass', true) === true;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** base58（去易混淆字符）43 字符 ≈ 256 位熵，前缀 at_ 便于人工识别与日志打码。 */
function newKeyPlain(): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = randomBytes(43);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `at_${out}`;
}

function isLoopback(addr: string | undefined): boolean {
  const a = String(addr ?? '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export interface CreatedApiKey {
  id: number;
  name: string;
  role: Role;
  /** 明文密钥：**仅此一次返回**，库内不存，丢失只能重新创建 */
  key: string;
  expiresAt: string;
}

export async function createApiKey(input: { name: string; role: Role; expiresInDays?: number }): Promise<CreatedApiKey> {
  const name = String(input.name ?? '').trim();
  if (!name) throw Object.assign(new Error('name 必填'), { statusCode: 400 });
  if (!RANK[input.role]) throw Object.assign(new Error(`role 必须是 ${Object.keys(RANK).join('/')}`), { statusCode: 400 });
  const key = newKeyPlain();
  const t = now();
  const days = input.expiresInDays && Number.isFinite(input.expiresInDays) && input.expiresInDays > 0
    ? Math.min(3650, Math.trunc(input.expiresInDays))
    : 0;
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
    : '';
  const res = await getDb().prepare(
    'INSERT INTO api_keys (name, key_hash, role, enabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
  ).run(name, hashKey(key), input.role, expiresAt, '', t);
  return { id: Number(res.lastInsertRowid), name, role: input.role, key, expiresAt };
}

export interface ApiKeyInfo {
  id: number;
  name: string;
  role: Role;
  enabled: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const rows = await getDb().prepare(
    'SELECT id, name, role, enabled, expires_at, last_used_at, created_at FROM api_keys ORDER BY id',
  ).all<Record<string, unknown>>();
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ''),
    role: String(r.role ?? 'viewer') as Role,
    enabled: Number(r.enabled) === 1,
    expiresAt: String(r.expires_at ?? ''),
    lastUsedAt: String(r.last_used_at ?? ''),
    createdAt: String(r.created_at ?? ''),
  }));
}

/** 校验 key：存在 + 启用 + 未过期。命中后刷新 last_used_at（fire-and-forget）。 */
export async function verifyApiKey(key: string): Promise<{ id: number; name: string; role: Role } | null> {
  const k = String(key ?? '').trim();
  if (!k) return null;
  let row: Record<string, unknown> | undefined;
  try {
    row = await getDb().prepare('SELECT id, name, role, enabled, expires_at FROM api_keys WHERE key_hash = ?').get<Record<string, unknown>>(hashKey(k));
  } catch {
    return null; // 表尚未建好（极端启动时序）按无效处理，由上层 401
  }
  if (!row) return null;
  if (Number(row.enabled) !== 1) return null;
  const exp = String(row.expires_at ?? '');
  if (exp && exp <= now()) return null;
  void getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), Number(row.id)).catch(() => { /* 不影响鉴权 */ });
  return { id: Number(row.id), name: String(row.name ?? ''), role: String(row.role ?? 'viewer') as Role };
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const res = await getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return res.changes > 0;
}

/**
 * 请求鉴权（http.ts 在路由匹配后调用）。
 *  - 认证关闭 / 该路由声明 authOpen → 返回 null（放行，行为与旧版一致）；
 *  - Bearer key 有效但角色不足 → 403；
 *  - key 缺失/无效且不回环豁免 → 401。
 */
export async function enforceAuth(req: IncomingMessage, required: Role, opts: { authOpen?: boolean } = {}): Promise<AuthContext | null> {
  if (!authEnabled() || opts.authOpen) return null;
  const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  if (m) {
    const key = await verifyApiKey(m[1].trim());
    if (!key) throw Object.assign(new Error('API Key 无效、已禁用或已过期'), { statusCode: 401 });
    if (RANK[key.role] < RANK[required]) {
      throw Object.assign(new Error(`权限不足：该操作需要 ${required} 角色，当前 Key 为 ${key.role}`), { statusCode: 403 });
    }
    return { role: key.role, keyId: key.id, via: 'key' };
  }
  if (localBypassEnabled() && isLoopback(req.socket.remoteAddress)) {
    return { role: 'admin', keyId: null, via: 'bypass' };
  }
  throw Object.assign(new Error('需要 API Key：请在请求头携带 Authorization: Bearer <apiKey>（本机回环请求可在系统配置关闭 allowLocalBypass 收紧）'), { statusCode: 401 });
}

/** /auth/status 用：免鉴权返回当前认证态势（登录门据此决定是否拦登录）。 */
export async function currentAuthContext(req: IncomingMessage): Promise<{ enabled: boolean; allowLocalBypass: boolean; role: Role | null; via: string | null }> {
  const base = { enabled: authEnabled(), allowLocalBypass: localBypassEnabled(), role: null as Role | null, via: null as string | null };
  if (!base.enabled) return base;
  const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  if (m) {
    const key = await verifyApiKey(m[1].trim());
    if (key) return { ...base, role: key.role, via: 'key' };
  }
  if (localBypassEnabled() && isLoopback(req.socket.remoteAddress)) {
    return { ...base, role: 'admin', via: 'bypass' };
  }
  return base;
}
