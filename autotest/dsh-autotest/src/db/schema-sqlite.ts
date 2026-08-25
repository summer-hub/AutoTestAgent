// SQLite 版业务 Schema（与 schema.ts MySQL 版逐表对应）
//  - 类型映射：BIGINT UNSIGNED AUTO_INCREMENT PK → INTEGER PRIMARY KEY AUTOINCREMENT；MEDIUMTEXT/TEXT → TEXT
//  - UNIQUE KEY → 表级 UNIQUE 约束；KEY idx → 单独 CREATE INDEX
//  - 时间戳仍由应用层写入字符串

export const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  current_version TEXT NOT NULL DEFAULT 'v0.0.0',
  last_commit TEXT NOT NULL DEFAULT '',
  package_name TEXT NOT NULL DEFAULT '',
  main_ability TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_synced_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_libraries_status ON libraries(status);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  case_no TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '新需求引入',
  precondition TEXT NOT NULL,
  steps TEXT NOT NULL,
  expected TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '未执行',
  script_status TEXT NOT NULL DEFAULT '未绑定',
  dts_url TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, case_no)
);
CREATE INDEX IF NOT EXISTS idx_cases_library ON cases(library_id);
CREATE INDEX IF NOT EXISTS idx_cases_source ON cases(source);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_name ON cases(name);

CREATE TABLE IF NOT EXISTS case_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'AI 用例更新 Agent',
  author_type TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version)
);
CREATE INDEX IF NOT EXISTS idx_case_versions_case ON case_versions(case_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  library_id INTEGER NULL,
  input TEXT NOT NULL,
  trace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_no)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_library ON tasks(library_id);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_no TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  cron TEXT NULL,
  scope TEXT NOT NULL,
  device_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  fail_policy TEXT NOT NULL DEFAULT 'continue',
  script_mode TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_no)
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NULL,
  case_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  device_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  steps TEXT NOT NULL,
  thinking TEXT NULL,
  logs TEXT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_plan ON executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_executions_case ON executions(case_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

CREATE TABLE IF NOT EXISTS executions_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NULL,
  case_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  device_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  steps TEXT NOT NULL,
  thinking TEXT NULL,
  logs TEXT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_exa_started ON executions_archive(started_at);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  battery INTEGER NULL,
  memory_usage INTEGER NULL,
  last_seen_at TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (serial)
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  skill TEXT NOT NULL DEFAULT '',
  variables TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  "key" TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'null',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom',
  base_url TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_models_default ON models(is_default);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  granularity TEXT NOT NULL DEFAULT 'single',
  library_id INTEGER NULL,
  case_id INTEGER NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  round TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_kind ON analyses(kind, granularity);
`;

/** 建表语句拆分（better-sqlite3 exec 支持多语句，这里仍按分号拆便于逐条容错）。 */
export function sqliteSchemaStatements(): string[] {
  return SCHEMA_SQLITE.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
