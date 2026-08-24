import mysql from 'mysql2/promise';
export declare function authPool(): mysql.Pool;
export declare const PERMISSION_CODES: readonly ["library:read", "library:write", "library:manage", "case:read", "case:write", "case:delete", "task:read", "task:create", "task:manage", "plan:read", "plan:create", "plan:manage", "exec:read", "exec:run", "exec:cancel", "device:read", "device:manage", "analysis:read", "analysis:run", "analysis:delete", "settings:read", "settings:write", "user:manage", "audit:read"];
/** 内置角色 → 权限点（admin 为全部）。 */
export declare const ROLE_PERMISSIONS: Record<string, string[]>;
/** 建表 + 种子角色/权限（幂等）。 */
export declare function ensureAuthSchema(): Promise<void>;
