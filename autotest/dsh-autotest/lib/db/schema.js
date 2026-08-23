// ============================================================
// AutoTest 平台 — 数据库 Schema
// 开发期：SQLite（better-sqlite3，单文件 data/autotest.db）
// 生产目标：MySQL 8（按 library_id 哈希分 16 表 + Redis 缓存）
//
// MySQL 兼容约定：
//  - 主键 INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT UNSIGNED AUTO_INCREMENT
//  - 时间戳一律由应用层写入 ISO-8601 字符串（TEXT/VARCHAR(32)），
//    避免 TEXT 默认值在 MySQL 的方言差异
//  - 用例主表在 MySQL 部署时拆为 cases_0..cases_15（按 library_id % 16），
//    repository 层（CaseRepository）封装路由，业务层无感
// ============================================================
export const SCHEMA = `
-- 三方库（400 个）
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  current_version TEXT NOT NULL DEFAULT 'v0.0.0',
  last_commit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_libraries_status ON libraries(status);

-- 用例主表（生产 MySQL：cases_0..cases_15 分表，library_id % 16 路由）
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id),
  case_no TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '新需求引入',
  precondition TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  expected TEXT NOT NULL DEFAULT '',
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

-- 用例版本历史（单条用例粒度，快照式；每次更新插入新版本 + 主表 current_version+1）
CREATE TABLE IF NOT EXISTS case_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'AI 用例更新 Agent',
  author_type TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version)
);
CREATE INDEX IF NOT EXISTS idx_case_versions_case ON case_versions(case_id);

-- AI 任务（对话输入 / 预置卡片）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  library_id INTEGER REFERENCES libraries(id),
  input TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_library ON tasks(library_id);

-- 执行计划（立即/定时/单独/批量/全量）
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  cron TEXT,
  scope TEXT NOT NULL DEFAULT '{"libraryIds":[],"caseIds":[]}',
  device_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  fail_policy TEXT NOT NULL DEFAULT 'continue',
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

-- 执行记录（含调试轨迹 / AI 思考）
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER REFERENCES plans(id),
  case_id INTEGER NOT NULL REFERENCES cases(id),
  library_id INTEGER NOT NULL REFERENCES libraries(id),
  device_id INTEGER REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'pending',
  steps TEXT NOT NULL DEFAULT '[]',
  thinking TEXT,
  logs TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_plan ON executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_executions_case ON executions(case_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

-- 设备（单/多设备、识别、历史设备）
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  battery INTEGER,
  memory_usage INTEGER,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

-- Prompt 模板（预设 Agent 提示词）
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

-- 系统配置（键值，value 为 JSON）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT 'null',
  updated_at TEXT NOT NULL
);

-- 大模型配置（可在设置中自定义添加：服务商/Base URL/模型 ID/API Key）
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'custom',   -- deepseek | openai | ollama | custom
  base_url TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',          -- 留空 = 未配置（连通性状态点红色）
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_default ON models(is_default);

-- 分析/归因结果（数据分析、归因分析产出，粒度：single/lib/multi）
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  granularity TEXT NOT NULL DEFAULT 'single',
  library_id INTEGER REFERENCES libraries(id),
  case_id INTEGER REFERENCES cases(id),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_kind ON analyses(kind, granularity);
`;
