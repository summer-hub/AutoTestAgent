// SQLite 版业务 Schema（与 schema.ts MySQL 版逐表对应）
//  - 类型映射：BIGINT UNSIGNED AUTO_INCREMENT PK → INTEGER PRIMARY KEY AUTOINCREMENT；MEDIUMTEXT/TEXT → TEXT
//  - UNIQUE KEY → 表级 UNIQUE 约束；KEY idx → 单独 CREATE INDEX
//  - 时间戳仍由应用层写入字符串

export const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL DEFAULT '',
  repo_subpath TEXT NOT NULL DEFAULT '',
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

-- 导出符号（接口面的最小事实单元）：P2 的产物，P3 覆盖矩阵的分母
CREATE TABLE IF NOT EXISTS api_symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  library_version TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  detail_level TEXT NOT NULL DEFAULT 'name-only',
  params_json TEXT NOT NULL,
  returns_json TEXT NOT NULL,
  throws_json TEXT NOT NULL,
  since_version TEXT NOT NULL DEFAULT '',
  deprecated INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL DEFAULT 0,
  methods_json TEXT NOT NULL,
  doc_refs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, library_version, name, kind)
);
CREATE INDEX IF NOT EXISTS idx_api_symbols_lib ON api_symbols(library_id);

-- demo 资产：页面与可注入参数点（接口 ↔ demo 位置的落点，P3/P5 的证据来源）
CREATE TABLE IF NOT EXISTS demo_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  library_version TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  source_line INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL,
  mutability TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  UNIQUE (library_id, library_version, kind, name, source_file, source_line)
);
CREATE INDEX IF NOT EXISTS idx_demo_assets_lib ON demo_assets(library_id);

-- 覆盖矩阵：接口 × demo × 控件 × 场景适用性（P3 的产物，也是"覆盖够不够"的唯一可证伪答案）
CREATE TABLE IF NOT EXISTS coverage_matrix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  symbol_id INTEGER NOT NULL,
  demo_asset_id INTEGER NULL,
  control_ref TEXT NOT NULL DEFAULT '',
  page_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  status_reason TEXT NOT NULL DEFAULT '',
  risk_flags TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  scenario_fit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (library_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_lib ON coverage_matrix(library_id, status);

-- 人工接管队列（P7）：每条含「原因 / 需要你做什么 / 上下文证据 / 回填结论」四段
CREATE TABLE IF NOT EXISTS human_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  case_id INTEGER NULL,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_human_queue_lib ON human_queue(library_id, status);

-- 用例 ↔ 脚本映射（P8）：版本联动的基础 —— 用例升版后脚本要能被判为「可能过期」
CREATE TABLE IF NOT EXISTS case_script_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  case_version INTEGER NOT NULL,
  script_path TEXT NOT NULL,
  script_hash TEXT NOT NULL DEFAULT '',
  module_stem TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'fresh',
  last_run_status TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NULL,
  confirmed_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id)
);
CREATE INDEX IF NOT EXISTS idx_case_script_status ON case_script_bindings(status);

-- 知识条目索引（P9）：**正文在 wiki 的 .md 文件里**（md 是唯一事实来源），这里只是可查询的索引
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wiki_path TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  keywords TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ai_draft',
  confidence INTEGER NOT NULL DEFAULT 50,
  evidence_json TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_lookup ON knowledge_entries(scope_kind, scope_key, status);

-- Agent 绑定（P10）：stage → 内置 / 自写 / 外部 agent，支持 global 与按库覆盖
CREATE TABLE IF NOT EXISTS agent_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  library_id INTEGER NULL,
  prompt_id INTEGER NULL,
  skill_path TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL DEFAULT 'builtin',
  external_cmd TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (stage, scope, library_id)
);

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
  -- 用例 ↔ 接口符号的溯源（P3 覆盖矩阵要回答"这个接口有没有用例"）
  api_symbol_id INTEGER NULL,
  -- 场景维度：happy 正向 / empty 空值 / boundary 边界异常 / bigdata 大数据
  scenario_kind TEXT NOT NULL DEFAULT 'happy',
  -- 优先级：P0 正向必跑 / P1 关键负向 / P2 长尾（执行计划按它抽样，抽样必须显式报告）
  priority TEXT NOT NULL DEFAULT 'P1',
  -- P5 可测性判定：A 开箱 / B 改参数 / C 需改代码 / D 无法测（每条用例都必须有）
  testability TEXT NOT NULL DEFAULT '',
  testability_reason TEXT NOT NULL DEFAULT '',
  -- P5 补丁草案（B/C 类才有；只在独立副本上应用，绝不改用户仓库）
  demo_patch_json TEXT NOT NULL DEFAULT '',
  -- P6 oracle：机器可校验判据（断言覆盖率硬门槛 100% —— 没有它就不允许入库）
  oracle_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, case_no)
);
CREATE INDEX IF NOT EXISTS idx_cases_library ON cases(library_id);
CREATE INDEX IF NOT EXISTS idx_cases_source ON cases(source);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_name ON cases(name);

-- 用例 ↔ 接口符号的关联（P11）：一条用例可能覆盖多个接口，一个接口也需要多条用例
-- （正向/空值/边界/大数据），单列 cases.api_symbol_id 表达不了这种多对多。
-- 每条关联必须写出**依据**与置信度：没有依据的关联等于编造，宁可不关联。
CREATE TABLE IF NOT EXISTS case_symbol_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  symbol_id INTEGER NOT NULL,
  -- 关联依据：explicit 生成时就指定 / page 用例所属页命中该接口的 demo 调用页 /
  --           name 用例文本命中符号或方法名 / manual 人工确认（重新关联时不会被覆盖）
  basis TEXT NOT NULL,
  -- high 直接证据（explicit/page/manual）· medium 名称命中 · low 仅弱证据（列出但不据此判 covered）
  confidence TEXT NOT NULL DEFAULT 'medium',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_case_symbol_links_lib ON case_symbol_links(library_id);
CREATE INDEX IF NOT EXISTS idx_case_symbol_links_symbol ON case_symbol_links(symbol_id);

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
  trace_id TEXT NOT NULL DEFAULT '',
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
  trace_id TEXT NOT NULL DEFAULT '',
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
  trace_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NULL,
  span_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NULL,
  tokens_out INTEGER NULL,
  latency_ms INTEGER NULL,
  prompt_chars INTEGER NULL,
  output_chars INTEGER NULL,
  detail TEXT NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_kind ON agent_events(kind, created_at);

-- 任务轨迹事件流（append-only）：tasks.trace 只是它物化出来的快照（MySQL 版见 schema.ts）
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'trace',
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, seq);

-- 场景级覆盖度（Demo 场景 × Demo 代码）：行 = 场景（P01/N07…），由
-- workspace/coverage/<库>/<库>Demo场景.md 与 <库>Demo场景覆盖率报告.md 解析而来。
-- md 是唯一事实来源，本表只是可查询的快照（先删后插，可随时重建）。
CREATE TABLE IF NOT EXISTS demo_scenario_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  library_version TEXT NOT NULL DEFAULT '',
  scenario_no TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'positive',
  module TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  api_covered INTEGER NOT NULL DEFAULT 0,
  api_total INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '',
  gap TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  scenario_doc TEXT NOT NULL DEFAULT '',
  report_doc TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, library_version, scenario_no)
);
CREATE INDEX IF NOT EXISTS idx_demo_scenario_lib ON demo_scenario_coverage(library_id, status);
`;

/** 建表语句拆分（better-sqlite3 exec 支持多语句，这里仍按分号拆便于逐条容错）。 */
export function sqliteSchemaStatements(): string[] {
  return SCHEMA_SQLITE.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
