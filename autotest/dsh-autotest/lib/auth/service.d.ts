export declare class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode?: number);
}
export interface AuthUser {
    id: number;
    username: string;
    roles: string[];
    permissions: string[];
}
export declare function hashPassword(pw: string): string;
export declare function verifyPassword(pw: string, stored: string): boolean;
export declare function signToken(payload: Record<string, unknown>, ttlSec: number): string;
export declare function verifyToken(token: string): Record<string, unknown> | null;
export declare function generateApiKey(): {
    key: string;
    hash: string;
};
export declare function loadAuthUser(userId: number): Promise<AuthUser>;
/** 根据 Bearer token（JWT 或 API Key）解析当前用户。 */
export declare function authForToken(token: string): Promise<AuthUser>;
export declare function hasPermission(user: AuthUser, perm: string): boolean;
export declare function writeAudit(userId: number | null, action: string, target?: string, detail?: string, ip?: string): Promise<void>;
export declare function login(username: string, password: string, ip: string): Promise<{
    token: string;
    refreshToken: string;
    user: AuthUser;
}>;
export declare function register(inviteCode: string, username: string, password: string, ip: string): Promise<{
    token: string;
    refreshToken: string;
    user: AuthUser;
}>;
export declare function refresh(refreshToken: string, ip: string): Promise<{
    token: string;
    refreshToken: string;
}>;
export declare function logout(refreshToken: string, userId: number | null): Promise<void>;
export declare function listUsers(): Promise<Array<Record<string, unknown>>>;
export declare function createUser(username: string, password: string, roleCodes: string[]): Promise<number>;
export declare function setUserRoles(userId: number, roleCodes: string[]): Promise<void>;
export declare function setUserStatus(userId: number, status: string): Promise<void>;
export declare function resetPassword(userId: number, newPassword?: string): Promise<string>;
export declare function listInvites(): Promise<Array<Record<string, unknown>>>;
export declare function createInvite(createdBy: number, roleCode: string, expiresDays?: number): Promise<string>;
export declare function revokeInvite(id: number): Promise<void>;
export declare function listApiKeys(userId: number): Promise<Array<Record<string, unknown>>>;
export declare function createApiKey(userId: number, name: string, scopes: string[]): Promise<{
    key: string;
    row: Record<string, unknown>;
}>;
export declare function revokeApiKey(id: number, userId: number): Promise<void>;
export declare function listAudit(limit: number, offset: number, action?: string): Promise<Array<Record<string, unknown>>>;
