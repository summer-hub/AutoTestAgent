// ============================================================
// AutoTest 平台 — 业务库 Schema（MySQL 8，服务器化）
//  - 认证表（auth_*）在 src/auth/db.ts
//  - 时间戳由应用层写入 ISO-8601 字符串（VARCHAR(32)）
//  - MySQL 8 TEXT 列不允许 DEFAULT，带默认值的用 VARCHAR
//  - 用例主表预留 cases_0..15 分片（repository 层路由），当前单表
// ============================================================
export const SCHEMA = `
-- 三方库（400 个）
CREATE TABLE IF NOT EXISTS libraries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  repo_url VARCHAR(512) NOT NULL DEFAULT '',
  description MEDIUMTEXT NOT NULL,
  current_version VARCHAR(64) NOT NULL DEFAULT 'v0.0.0',
  last_commit VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_synced_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_libraries_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_libraries_status ON libraries(status);

-- 用例主表（生产可拆 cases_0..cases_15，library_id % 16 路由）
CREATE TABLE IF NOT EXISTS cases (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  case_no VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT '新需求引入',
  precondition MEDIUMTEXT NOT NULL,
  steps MEDIUMTEXT NOT NULL,
  expected MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT '未执行',
  script_status VARCHAR(16) NOT NULL DEFAULT '未绑定',
  dts_url VARCHAR(512) NOT NULL DEFAULT '',
  current_version INT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_cases_lib_no (library_id, case_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_cases_library ON cases(library_id);
CREATE INDEX idx_cases_source ON cases(source);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_name ON cases(name);

-- 用例版本历史（快照式；每次更新插入新版本 + 主表 current_version+1）
CREATE TABLE IF NOT EXISTS case_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  case_id BIGINT UNSIGNED NOT NULL,
  version INT NOT NULL,
  snapshot MEDIUMTEXT NOT NULL,
  change_note VARCHAR(255) NOT NULL DEFAULT '',
  author VARCHAR(64) NOT NULL DEFAULT 'AI 用例更新 Agent',
  author_type VARCHAR(16) NOT NULL DEFAULT 'ai',
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_case_versions (case_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_case_versions_case ON case_versions(case_id);

-- AI 任务（对话输入 / 预置卡片）
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_no VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  library_id BIGINT UNSIGNED NULL,
  input MEDIUMTEXT NOT NULL,
  trace MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  progress INT NOT NULL DEFAULT 0,
  result_summary TEXT NULL,
  error TEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_tasks_no (task_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_library ON tasks(library_id);

-- 执行计划（立即/定时/单独/批量/全量）
CREATE TABLE IF NOT EXISTS plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plan_no VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(16) NOT NULL,
  cron VARCHAR(64) NULL,
  scope MEDIUMTEXT NOT NULL,
  device_ids VARCHAR(2000) NOT NULL DEFAULT '[]',
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  fail_policy VARCHAR(16) NOT NULL DEFAULT 'continue',
  last_run_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_plans_no (plan_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_plans_status ON plans(status);

-- 执行记录（含调试轨迹 / AI 思考）
CREATE TABLE IF NOT EXISTS executions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT UNSIGNED NULL,
  case_id BIGINT UNSIGNED NOT NULL,
  library_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  steps MEDIUMTEXT NOT NULL,
  thinking MEDIUMTEXT NULL,
  logs MEDIUMTEXT NULL,
  started_at VARCHAR(32) NULL,
  finished_at VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_executions_plan ON executions(plan_id);
CREATE INDEX idx_executions_case ON executions(case_id);
CREATE INDEX idx_executions_status ON executions(status);

-- 设备（单/多设备、识别、历史设备）
CREATE TABLE IF NOT EXISTS devices (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  serial VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL DEFAULT '',
  os_version VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'offline',
  battery INT NULL,
  memory_usage INT NULL,
  last_seen_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_devices_serial (serial)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_devices_status ON devices(status);

-- Prompt 模板（预设 Agent 提示词）
CREATE TABLE IF NOT EXISTS prompts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  skill VARCHAR(255) NOT NULL DEFAULT '',
  variables VARCHAR(2000) NOT NULL DEFAULT '[]',
  builtin TINYINT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 系统配置（键值，value 为 JSON）
CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(64) PRIMARY KEY,
  value VARCHAR(4000) NOT NULL DEFAULT 'null',
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 大模型配置（可在设置中自定义添加）
CREATE TABLE IF NOT EXISTS models (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'custom',
  base_url VARCHAR(512) NOT NULL DEFAULT '',
  model_id VARCHAR(128) NOT NULL DEFAULT '',
  api_key VARCHAR(512) NOT NULL DEFAULT '',
  is_default TINYINT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_models_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_models_default ON models(is_default);

-- 分析/归因结果
CREATE TABLE IF NOT EXISTS analyses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  granularity VARCHAR(16) NOT NULL DEFAULT 'single',
  library_id BIGINT UNSIGNED NULL,
  case_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  round VARCHAR(48) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_analyses_kind ON analyses(kind, granularity);
`;
/** 建表语句拆分（MySQL 不允许一条 query 跑多语句）。 */
export function schemaStatements() {
    // 保留注释行（MySQL 会忽略 -- 行注释），只过滤空串
    return SCHEMA.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
