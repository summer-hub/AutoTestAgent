import type { IncomingMessage } from 'node:http';
export type Role = 'admin' | 'operator' | 'viewer';
export interface AuthContext {
    role: Role;
    keyId: number | null;
    via: 'key' | 'bypass';
}
export declare function authEnabled(): boolean;
export declare function localBypassEnabled(): boolean;
export interface CreatedApiKey {
    id: number;
    name: string;
    role: Role;
    /** 明文密钥：**仅此一次返回**，库内不存，丢失只能重新创建 */
    key: string;
    expiresAt: string;
}
export declare function createApiKey(input: {
    name: string;
    role: Role;
    expiresInDays?: number;
}): Promise<CreatedApiKey>;
export interface ApiKeyInfo {
    id: number;
    name: string;
    role: Role;
    enabled: boolean;
    expiresAt: string;
    lastUsedAt: string;
    createdAt: string;
}
export declare function listApiKeys(): Promise<ApiKeyInfo[]>;
/** 校验 key：存在 + 启用 + 未过期。命中后刷新 last_used_at（fire-and-forget）。 */
export declare function verifyApiKey(key: string): Promise<{
    id: number;
    name: string;
    role: Role;
} | null>;
export declare function revokeApiKey(id: number): Promise<boolean>;
/**
 * 请求鉴权（http.ts 在路由匹配后调用）。
 *  - 认证关闭 / 该路由声明 authOpen → 返回 null（放行，行为与旧版一致）；
 *  - Bearer key 有效但角色不足 → 403；
 *  - key 缺失/无效且不回环豁免 → 401。
 */
export declare function enforceAuth(req: IncomingMessage, required: Role, opts?: {
    authOpen?: boolean;
}): Promise<AuthContext | null>;
/** /auth/status 用：免鉴权返回当前认证态势（登录门据此决定是否拦登录）。 */
export declare function currentAuthContext(req: IncomingMessage): Promise<{
    enabled: boolean;
    allowLocalBypass: boolean;
    role: Role | null;
    via: string | null;
}>;
