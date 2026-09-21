// ============================================================
// AutoTest 平台 — 业务库 Schema（MySQL 8，服务器化）
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
  repo_subpath VARCHAR(512) NOT NULL DEFAULT '',
  description MEDIUMTEXT NOT NULL,
  current_version VARCHAR(64) NOT NULL DEFAULT 'v0.0.0',
  last_commit VARCHAR(64) NOT NULL DEFAULT '',
  package_name VARCHAR(128) NOT NULL DEFAULT '',
  main_ability VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_synced_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_libraries_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_libraries_status ON libraries(status);

-- 导出符号（接口面的最小事实单元）：P2 的产物，P3 覆盖矩阵的分母
-- 唯一键含 library_version：同一符号换版本重新采集是一条新事实，而不是覆盖历史
CREATE TABLE IF NOT EXISTS api_symbols (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  library_version VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  signature MEDIUMTEXT NOT NULL,
  -- 签名可信度：full 定位到定义体且拿到参数或方法 / decl-only 只定位到一行声明 / name-only 没定位到定义体
  detail_level VARCHAR(16) NOT NULL DEFAULT 'name-only',
  params_json MEDIUMTEXT NOT NULL,
  returns_json MEDIUMTEXT NOT NULL,
  throws_json MEDIUMTEXT NOT NULL,
  since_version VARCHAR(32) NOT NULL DEFAULT '',
  deprecated TINYINT NOT NULL DEFAULT 0,
  source_file VARCHAR(512) NOT NULL,
  source_line INT NOT NULL DEFAULT 0,
  -- 类的方法清单：class 类符号真正可测的单元是它的方法（v.validate(...)），P3 需要它
  methods_json MEDIUMTEXT NOT NULL,
  doc_refs MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_api_symbols (library_id, library_version, name, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_api_symbols_lib ON api_symbols(library_id);

-- demo 资产：页面与可注入参数点（接口 ↔ demo 位置的落点，P3/P5 的证据来源）
CREATE TABLE IF NOT EXISTS demo_assets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  library_version VARCHAR(64) NOT NULL DEFAULT '',
  kind VARCHAR(24) NOT NULL,
  name VARCHAR(255) NOT NULL,
  page_path VARCHAR(512) NOT NULL DEFAULT '',
  source_file VARCHAR(512) NOT NULL DEFAULT '',
  source_line INT NOT NULL DEFAULT 0,
  snippet MEDIUMTEXT NOT NULL,
  mutability VARCHAR(16) NOT NULL DEFAULT 'none',
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_demo_assets (library_id, library_version, kind, name, source_file, source_line)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_demo_assets_lib ON demo_assets(library_id);

-- 覆盖矩阵：接口 × demo × 控件 × 场景适用性（P3 的产物）
CREATE TABLE IF NOT EXISTS coverage_matrix (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  symbol_id BIGINT UNSIGNED NOT NULL,
  demo_asset_id BIGINT UNSIGNED NULL,
  control_ref VARCHAR(255) NOT NULL DEFAULT '',
  page_path VARCHAR(512) NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL,
  status_reason VARCHAR(255) NOT NULL DEFAULT '',
  risk_flags MEDIUMTEXT NOT NULL,
  evidence_json MEDIUMTEXT NOT NULL,
  scenario_fit MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_coverage (library_id, symbol_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_coverage_lib ON coverage_matrix(library_id, status);

-- 人工接管队列（P7）
CREATE TABLE IF NOT EXISTS human_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  case_id BIGINT UNSIGNED NULL,
  stage VARCHAR(32) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  question MEDIUMTEXT NOT NULL,
  payload_json MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  resolution MEDIUMTEXT NOT NULL,
  resolved_by VARCHAR(64) NOT NULL DEFAULT '',
  resolved_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_human_queue_lib ON human_queue(library_id, status);

-- 用例 ↔ 脚本映射（P8）
CREATE TABLE IF NOT EXISTS case_script_bindings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  case_id BIGINT UNSIGNED NOT NULL,
  case_version INT NOT NULL,
  script_path VARCHAR(512) NOT NULL,
  script_hash VARCHAR(64) NOT NULL DEFAULT '',
  module_stem VARCHAR(128) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'fresh',
  last_run_status VARCHAR(16) NOT NULL DEFAULT '',
  last_run_at VARCHAR(32) NULL,
  confirmed_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_case_script (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_case_script_status ON case_script_bindings(status);

-- 知识条目索引（P9）：正文在 wiki 的 .md 文件里，这里只是索引
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  wiki_path VARCHAR(512) NOT NULL,
  scope_kind VARCHAR(24) NOT NULL,
  scope_key VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  keywords VARCHAR(512) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ai_draft',
  confidence TINYINT NOT NULL DEFAULT 50,
  evidence_json MEDIUMTEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY idx_knowledge_lookup (scope_kind, scope_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent 绑定（P10）
CREATE TABLE IF NOT EXISTS agent_bindings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stage VARCHAR(48) NOT NULL,
  scope VARCHAR(48) NOT NULL DEFAULT 'global',
  library_id BIGINT UNSIGNED NULL,
  prompt_id BIGINT UNSIGNED NULL,
  skill_path VARCHAR(512) NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT '',
  params_json MEDIUMTEXT NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'builtin',
  external_cmd VARCHAR(512) NOT NULL DEFAULT '',
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_agent_binding (stage, scope, library_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
  api_symbol_id BIGINT UNSIGNED NULL,
  scenario_kind VARCHAR(16) NOT NULL DEFAULT 'happy',
  priority VARCHAR(4) NOT NULL DEFAULT 'P1',
  testability VARCHAR(8) NOT NULL DEFAULT '',
  testability_reason VARCHAR(500) NOT NULL DEFAULT '',
  demo_patch_json MEDIUMTEXT NOT NULL,
  oracle_json MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_cases_lib_no (library_id, case_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_cases_library ON cases(library_id);
CREATE INDEX idx_cases_source ON cases(source);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_name ON cases(name);

-- 用例 ↔ 接口符号的关联（P11）：一条用例可能覆盖多个接口，一个接口也需要多条用例
-- （正向/空值/边界/大数据），单列 cases.api_symbol_id 表达不了这种多对多。
-- 每条关联必须写出**依据**与置信度：没有依据的关联等于编造，宁可不关联。
CREATE TABLE IF NOT EXISTS case_symbol_links (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  case_id BIGINT UNSIGNED NOT NULL,
  symbol_id BIGINT UNSIGNED NOT NULL,
  -- 关联依据：explicit 生成时就指定 / page 用例所属页命中该接口的 demo 调用页 /
  --           name 用例文本命中符号或方法名 / manual 人工确认（重新关联时不会被覆盖）
  basis VARCHAR(16) NOT NULL,
  -- high 直接证据（explicit/page/manual）· medium 名称命中 · low 仅弱证据（列出但不据此判 covered）
  confidence VARCHAR(8) NOT NULL DEFAULT 'medium',
  detail VARCHAR(500) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_case_symbol_links (case_id, symbol_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_case_symbol_links_lib ON case_symbol_links(library_id);
CREATE INDEX idx_case_symbol_links_symbol ON case_symbol_links(symbol_id);

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
  trace_id VARCHAR(64) NOT NULL DEFAULT '',
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
  script_mode VARCHAR(16) NOT NULL DEFAULT '',
  progress INT NOT NULL DEFAULT 0,
  progress_note VARCHAR(300) NOT NULL DEFAULT '',
  error VARCHAR(500) NOT NULL DEFAULT '',
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
  trace_id VARCHAR(64) NOT NULL DEFAULT '',
  thinking MEDIUMTEXT NULL,
  logs MEDIUMTEXT NULL,
  started_at VARCHAR(32) NULL,
  finished_at VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_executions_plan ON executions(plan_id);
CREATE INDEX idx_executions_case ON executions(case_id);
CREATE INDEX idx_executions_status ON executions(status);

-- 执行归档（旧记录按月归档，主表保持小；由 scheduler 每日触发）
-- ⚠️ 列必须与 executions 一一对应：归档用列名显式 INSERT..SELECT，
--    缺列会直接报错（历史上漏过 trace_id，导致归档静默失效）。
CREATE TABLE IF NOT EXISTS executions_archive (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT UNSIGNED NULL,
  case_id BIGINT UNSIGNED NOT NULL,
  library_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  steps MEDIUMTEXT NOT NULL,
  trace_id VARCHAR(64) NOT NULL DEFAULT '',
  thinking MEDIUMTEXT NULL,
  logs MEDIUMTEXT NULL,
  started_at VARCHAR(32) NULL,
  finished_at VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_exa_started ON executions_archive(started_at);

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

-- 链路追踪事件（追加式：LLM 调用 / 遍历 op / dry-run 步骤等，全链 traceId 的地基）
CREATE TABLE IF NOT EXISTS agent_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NULL,
  span_id VARCHAR(64) NOT NULL DEFAULT '',
  parent_id VARCHAR(64) NOT NULL DEFAULT '',
  kind VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',
  provider VARCHAR(64) NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT '',
  tokens_in INT NULL,
  tokens_out INT NULL,
  latency_ms INT NULL,
  prompt_chars INT NULL,
  output_chars INT NULL,
  detail TEXT NULL,
  error TEXT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_agent_events_task ON agent_events(task_id, created_at);
CREATE INDEX idx_agent_events_kind ON agent_events(kind, created_at);

-- 任务轨迹事件流（append-only）：tasks.trace 只是它物化出来的快照
--  - seq 每任务从 1 递增，由 INSERT..SELECT MAX(seq)+1 一条语句原子分配（不读改写整个 JSON 列）
--  - 唯一键 (task_id, seq) 兜底：并发追加撞键时报错，而不是静默丢一条轨迹
--  - 前端可 ?afterSeq= 增量拉取（SSE 的地基）；快照丢了可随时从事件流重建
CREATE TABLE IF NOT EXISTS task_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  seq INT NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'trace',
  title VARCHAR(255) NOT NULL,
  detail MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_task_events (task_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_task_events_task ON task_events(task_id, seq);

-- 场景级覆盖度（Demo 场景 × Demo 代码）：行 = 场景（P01/N07…），由
-- workspace/coverage/<库>/<库>Demo场景.md 与 <库>Demo场景覆盖率报告.md 解析而来。
-- md 是唯一事实来源，本表只是可查询的快照（先删后插，可随时重建）。
CREATE TABLE IF NOT EXISTS demo_scenario_coverage (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  library_version VARCHAR(64) NOT NULL DEFAULT '',
  scenario_no VARCHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  kind VARCHAR(16) NOT NULL DEFAULT 'positive',
  module VARCHAR(128) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL,
  api_covered INT NOT NULL DEFAULT 0,
  api_total INT NOT NULL DEFAULT 0,
  evidence VARCHAR(512) NOT NULL DEFAULT '',
  gap VARCHAR(512) NOT NULL DEFAULT '',
  note VARCHAR(256) NOT NULL DEFAULT '',
  scenario_doc VARCHAR(512) NOT NULL DEFAULT '',
  report_doc VARCHAR(512) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_demo_scenario (library_id, library_version, scenario_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_demo_scenario_lib ON demo_scenario_coverage(library_id, status);
`;
/** 建表语句拆分（MySQL 不允许一条 query 跑多语句）。 */
export function schemaStatements() {
    // 保留注释行（MySQL 会忽略 -- 行注释），只过滤空串
    return SCHEMA.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
