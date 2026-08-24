// 认证数据源：MySQL（多用户服务器化）
//  - auth_* 表建在 MySQL（用户/角色/权限/会话/密钥/审计/邀请码）
//  - 业务表仍在 SQLite（阶段 0 不动存量数据），后续业务迁移 MySQL 后合流
import mysql from 'mysql2/promise';
import { getSetting } from '../services/settings.js';

let pool: mysql.Pool | null = null;

export function authPool(): mysql.Pool {
  if (!pool) {
    const uri = String(getSetting('db.mysqlUrl', '') || process.env.AUTOTEST_MYSQL_URL || '').trim();
    if (!uri) throw new Error('未配置 MySQL 连接（系统配置 db.mysqlUrl 或环境变量 AUTOTEST_MYSQL_URL）');
    pool = mysql.createPool({
      uri,
      waitForConnections: true,
      connectionLimit: 8,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
    });
  }
  return pool;
}

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

const AUTH_DDL = `
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

let initPromise: Promise<void> | null = null;

/** 建表 + 种子角色/权限（幂等）。 */
export async function ensureAuthSchema(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const db = await authPool();
      for (const stmt of AUTH_DDL.split('\n\n').map((s) => s.trim()).filter(Boolean)) {
        await db.query(stmt);
      }
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
      console.log('[dsh-autotest] 认证库就绪（MySQL，角色/权限已种子化）');
    })().catch((e) => {
      initPromise = null; // 失败允许下次重试
      throw e;
    });
  }
  return initPromise;
}
