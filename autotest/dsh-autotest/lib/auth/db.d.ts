export declare const PERMISSION_CODES: readonly ["library:read", "library:write", "library:manage", "case:read", "case:write", "case:delete", "task:read", "task:create", "task:manage", "plan:read", "plan:create", "plan:manage", "exec:read", "exec:run", "exec:cancel", "device:read", "device:manage", "analysis:read", "analysis:run", "analysis:delete", "settings:read", "settings:write", "user:manage", "audit:read"];
/** 内置角色 → 权限点（admin 为全部）。 */
export declare const ROLE_PERMISSIONS: Record<string, string[]>;
/**
 * 认证数据访问适配器：保持 mysql2 的 `const [rows] = await db.query(sql, args)` 调用形态，
 * 底层走统一 facade（MySQL/SQLite 双引擎自动切换）。
 */
export declare function authDb(): Promise<{
    query(sql: string, args?: unknown[]): Promise<[any, unknown]>;
}>;
/** 建表 + 种子角色/权限（幂等）。 */
export declare function ensureAuthSchema(): Promise<void>;
