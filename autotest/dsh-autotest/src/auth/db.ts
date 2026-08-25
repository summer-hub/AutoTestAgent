// 认证数据源：跟随业务库双引擎
//  - MySQL 模式：auth_* 表建在 MySQL（多用户服务器化）
//  - SQLite 本地降级模式：auth_* 表建在本地 autotest.sqlite3，登录/注册/用户管理全部可用
//  - service.ts 通过 authDb() 适配器访问（mysql2 query 形态），底层走统一 facade
import { dbMode, getDb } from '../db/connection.js';

export const PERMISSION_CODES = [
  'library:read', 'library:write', 'library:manage',
  'case:read', 'case:write', 'case:delete',
  'task:read', 'task:create', 'task:manage',
  'plan:read', 'plan:create', 'plan:manage',
  'exec:read', 'exec:run', 'exec:cancel',
  'device:read', 'device:manage',
  'analysis:read', 'analysis:run', 'analysis:delete',
  'settings:read', 'settings:write',
  'user:manage', 'audit:read',
] as const;

/** 内置角色 → 权限点（admin 为全部）。 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...PERMISSION_CODES],
  manager: [
    'library:write', 'case:write', 'case:delete',
    'task:read', 'task:create', 'task:manage',
    'plan:read', 'plan:create', 'plan:manage',
    'exec:read', 'exec:run', 'exec:cancel',
    'device:read', 'device:manage',
    'analysis:read', 'analysis:run', 'analysis:delete',
    'settings:read', 'audit:read',
  ],
  engineer: [
    'library:read', 'case:read', 'case:write',
    'task:read', 'task:create',
    'plan:read', 'plan:create',
    'exec:read', 'exec:run',
    'device:read',
    'analysis:read', 'analysis:run',
    'settings:read',
  ],
  viewer: [
    'library:read', 'case:read', 'task:read', 'plan:read',
    'exec:read', 'device:read', 'analysis:read', 'settings:read',
  ],
};

const AUTH_DDL_MYSQL = `
CREATE TABLE IF NOT EXISTS auth_users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(128) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  last_login_at DATETIME NULL,
  UNIQUE KEY uk_auth_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_refresh_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  ip VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_ars_token (token_hash),
  KEY idx_ars_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  scopes TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  last_used_at DATETIME NULL,
  UNIQUE KEY uk_aak_hash (key_hash),
  KEY idx_aak_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  builtin TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uk_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  UNIQUE KEY uk_perms_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_invite_codes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  role_code VARCHAR(32) NOT NULL DEFAULT 'viewer',
  used_by BIGINT UNSIGNED NULL,
  expires_at DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_invite_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  target VARCHAR(255) NOT NULL DEFAULT '',
  detail TEXT NOT NULL,
  ip VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  KEY idx_aal_user (user_id, created_at),
  KEY idx_aal_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  attempted_at DATETIME NOT NULL,
  KEY idx_ala_user (username, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

/** SQLite 版 auth DDL（与 MySQL 版逐表对应）。 */
const AUTH_DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS auth_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT NULL,
  UNIQUE (username)
);
CREATE TABLE IF NOT EXISTS auth_refresh_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_ars_user ON auth_refresh_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_used_at TEXT NULL,
  UNIQUE (key_hash)
);
CREATE INDEX IF NOT EXISTS idx_aak_user ON auth_api_keys(user_id);
CREATE TABLE IF NOT EXISTS auth_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 1,
  UNIQUE (code)
);
CREATE TABLE IF NOT EXISTS auth_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  UNIQUE (code)
);
CREATE TABLE IF NOT EXISTS auth_user_roles (
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS auth_role_permissions (
  role_id INTEGER NOT NULL,
  permission_id INTEGER NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS auth_invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  role_code TEXT NOT NULL DEFAULT 'viewer',
  used_by INTEGER NULL,
  expires_at TEXT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (code)
);
CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aal_user ON auth_audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aal_action ON auth_audit_logs(action, created_at);
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ala_user ON auth_login_attempts(username, attempted_at);
`;

/**
 * 认证数据访问适配器：保持 mysql2 的 `const [rows] = await db.query(sql, args)` 调用形态，
 * 底层走统一 facade（MySQL/SQLite 双引擎自动切换）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function authDb(): Promise<{ query(sql: string, args?: unknown[]): Promise<[any, unknown]> }> {
  const d = getDb();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: string, args: unknown[] = []): Promise<[any, unknown]> {
      const head = sql.trimStart().slice(0, 6).toUpperCase();
      if (head.startsWith('SELECT')) {
        const rows = await d.prepare(sql).all(...args);
        return [rows, null];
      }
      const r = await d.prepare(sql).run(...args);
      return [{ insertId: Number(r.lastInsertRowid), affectedRows: r.changes }, null];
    },
  };
}

let initPromise: Promise<void> | null = null;

/** 建表 + 种子角色/权限（幂等）。 */
export async function ensureAuthSchema(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const ddl = dbMode() === 'sqlite' ? AUTH_DDL_SQLITE : AUTH_DDL_MYSQL;
      await getDb().exec(ddl);
      const db = await authDb();
      // 权限点
      for (const code of PERMISSION_CODES) {
        await db.query(`INSERT IGNORE INTO auth_permissions (code) VALUES (?)`, [code]);
      }
      // 角色
      const roleNames: Record<string, string> = {
        admin: '管理员', manager: '组长', engineer: '测试工程师', viewer: '只读访客',
      };
      for (const [code, name] of Object.entries(roleNames)) {
        await db.query(`INSERT IGNORE INTO auth_roles (code, name, builtin) VALUES (?, ?, 1)`, [code, name]);
      }
      // 角色 → 权限映射（先清空再重建，保持与代码一致）
      await db.query(`DELETE FROM auth_role_permissions`);
      for (const [roleCode, perms] of Object.entries(ROLE_PERMISSIONS)) {
        for (const perm of perms) {
          await db.query(
            `INSERT IGNORE INTO auth_role_permissions (role_id, permission_id)
             SELECT r.id, p.id FROM auth_roles r JOIN auth_permissions p ON p.code = ? WHERE r.code = ?`,
            [perm, roleCode],
          );
        }
      }
      console.log(`[dsh-autotest] 认证库就绪（${dbMode() === 'sqlite' ? 'SQLite 本地' : 'MySQL'}，角色/权限已种子化）`);
    })().catch((e) => {
      initPromise = null; // 失败允许下次重试
      throw e;
    });
  }
  return initPromise;
}
