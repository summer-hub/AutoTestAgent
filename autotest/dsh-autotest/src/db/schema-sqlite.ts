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
  -- R5：问题现象（人维护的疑问描述）。与 Agent 字段的边界：这一列是人写的观察，
  -- 同步/导入绝不覆盖它（同 librarySheet 对 package_name 的边界）。
  symptom TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, case_no)
);
CREATE INDEX IF NOT EXISTS idx_cases_library ON cases(library_id);
CREATE INDEX IF NOT EXISTS idx_cases_source ON cases(source);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_name ON cases(name);

-- R5：问题归因工单。一次「人对用例有疑问」= 一张工单。
-- 与 cases.symptom 的分工：symptom 是**当前**疑问（人维护，可改）；
-- 工单是**历史档案**（每次提交一条，含 AI 根因、证据、人工结论），可追溯、可沉淀知识。
CREATE TABLE IF NOT EXISTS issue_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL,
  case_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  -- 人填的问题现象（提交时快照，之后不改 —— 改了就分不清 AI 当初分析的是哪个问题）
  symptom TEXT NOT NULL,
  -- 状态机：pending → analyzing → root_caused → verifying → accepted / rejected / failed
  status TEXT NOT NULL DEFAULT 'pending',
  -- AI 根因结论（结构化 JSON：根因陈述/证据 file:line/置信度/修复建议/是否需改 demo）
  root_cause_json TEXT NOT NULL DEFAULT '{}',
  -- 证据清单（AI 引用的文件、行号、源码片段、遍历控件、执行日志）
  evidence_json TEXT NOT NULL DEFAULT '[]',
  -- 自测试验证结果（补丁是否应用到副本、真机是否跑通、无真机时的明确原因）
  verification_json TEXT NOT NULL DEFAULT '{}',
  -- 人工验收结论（接受/驳回的理由；接受才沉淀知识条目）
  verdict TEXT NOT NULL DEFAULT '',
  verdict_reason TEXT NOT NULL DEFAULT '',
  verdict_by TEXT NOT NULL DEFAULT '',
  verdict_at TEXT NULL,
  -- 沉淀出的知识条目 id（接受时回填，供前端跳转与反查）
  knowledge_id TEXT NOT NULL DEFAULT '',
  task_id INTEGER NULL,
  execution_id INTEGER NULL,
  test_run_id INTEGER NULL,
  run_item_id INTEGER NULL,
  baseline_id INTEGER NULL,
  case_version INTEGER NULL,
  attribution TEXT NOT NULL DEFAULT 'unknown',
  attribution_reason TEXT NOT NULL DEFAULT '',
  input_snapshot_json TEXT NULL,
  report_id INTEGER NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ticket_no)
);
CREATE INDEX IF NOT EXISTS idx_issue_tickets_case ON issue_tickets(case_id, status);
CREATE INDEX IF NOT EXISTS idx_issue_tickets_lib ON issue_tickets(library_id, status);
CREATE INDEX IF NOT EXISTS idx_issue_tickets_exec ON issue_tickets(execution_id);
CREATE INDEX IF NOT EXISTS idx_issue_tickets_attr ON issue_tickets(attribution);

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
  baseline_id INTEGER NULL,
  baseline_mode TEXT NOT NULL DEFAULT 'latest',
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
  test_run_id INTEGER NULL,
  run_item_id INTEGER NULL,
  baseline_id INTEGER NULL,
  case_version INTEGER NULL,
  case_snapshot_json TEXT NULL,
  library_version TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  actual_json TEXT NULL,
  thinking TEXT NULL,
  logs TEXT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_plan ON executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_executions_case ON executions(case_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_baseline ON executions(baseline_id);
CREATE INDEX IF NOT EXISTS idx_executions_run ON executions(test_run_id);

CREATE TABLE IF NOT EXISTS executions_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NULL,
  case_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  device_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  steps TEXT NOT NULL,
  trace_id TEXT NOT NULL DEFAULT '',
  env_run_id INTEGER NULL,
  resource_set_id INTEGER NULL,
  test_run_id INTEGER NULL,
  run_item_id INTEGER NULL,
  baseline_id INTEGER NULL,
  case_version INTEGER NULL,
  case_snapshot_json TEXT NULL,
  library_version TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  actual_json TEXT NULL,
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

-- API Key（认证 + RBAC）：只存 SHA-256 哈希，明文仅在创建响应里展示一次
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- 危险操作审批队列（P0-4）：approve = 一次性放行令牌（consumed），重试同一操作时消费
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, kind, target);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom',
  base_url TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'openai',
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
  pr_id INTEGER NULL,
  baseline_id INTEGER NULL,
  execution_ids_json TEXT NULL,
  report_id INTEGER NULL,
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

-- 目录引导导入记录（R0）：随包「三方库测试表.xlsx」→ 业务库的每次导入留痕。
-- sha256 是幂等键：同一份表重复导入不重复写库；只追加不更新，历史永远看得见。
CREATE TABLE IF NOT EXISTS library_catalog_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'bundled',
  file_path TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  db_only INTEGER NOT NULL DEFAULT 0,
  problems INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_sha ON library_catalog_imports(file_sha256);
CREATE INDEX IF NOT EXISTS idx_catalog_at ON library_catalog_imports(created_at);

-- R1：脚本资产库（deveco-cli 成熟脚本的契约化形态；与 schema.ts 逐表对应）
CREATE TABLE IF NOT EXISTS script_library (
  id TEXT NOT NULL PRIMARY KEY,
  summary TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  contract_json TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  approval TEXT NOT NULL DEFAULT 'operator',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS script_library_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (script_id, version)
);

-- R1：环境画像与步骤序列
CREATE TABLE IF NOT EXISTS env_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  preset_kind TEXT NOT NULL DEFAULT '',
  toolchain_json TEXT NOT NULL,
  components_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai_draft',
  confidence INTEGER NOT NULL DEFAULT 50,
  knowledge_refs TEXT NOT NULL,
  confirmed_by TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id, name)
);
CREATE INDEX IF NOT EXISTS idx_env_profiles_lib ON env_profiles(library_id, status);

CREATE TABLE IF NOT EXISTS env_profile_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  script_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  skip_if TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, seq)
);

-- R1：环境准备运行记录与步骤明细
CREATE TABLE IF NOT EXISTS env_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  fingerprint TEXT NOT NULL DEFAULT '',
  cached_from INTEGER NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_no)
);
CREATE INDEX IF NOT EXISTS idx_env_runs_lib ON env_runs(library_id, status);
CREATE INDEX IF NOT EXISTS idx_env_runs_fp ON env_runs(fingerprint);

CREATE TABLE IF NOT EXISTS env_run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  script_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  exit_code INTEGER NULL,
  failure_kind TEXT NOT NULL DEFAULT '',
  artifacts_json TEXT NOT NULL,
  log_path TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_env_run_steps_run ON env_run_steps(run_id, seq);

-- R2：全量库静态画像（L0 采集的产物，零 LLM 确定性；与 schema.ts 逐表对应）
CREATE TABLE IF NOT EXISTS library_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  last_commit TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown',
  kind_reason TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 0,
  build_target TEXT NOT NULL DEFAULT '',
  has_submodules INTEGER NOT NULL DEFAULT 0,
  has_binary INTEGER NOT NULL DEFAULT 0,
  binary_kinds TEXT NOT NULL DEFAULT '',
  has_demo INTEGER NOT NULL DEFAULT 0,
  entry_file TEXT NOT NULL DEFAULT '',
  readme_chars INTEGER NOT NULL DEFAULT 0,
  facts_json TEXT NOT NULL,
  resource_candidates_json TEXT NOT NULL,
  readme_intel_json TEXT NOT NULL,
  survey_run_id INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id)
);
CREATE INDEX IF NOT EXISTS idx_library_facts_kind ON library_facts(kind, confidence);

-- R2：单库采集记录（断点续跑的单位）
CREATE TABLE IF NOT EXISTS library_survey_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  batch_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_commit TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  failure_kind TEXT NOT NULL DEFAULT '',
  failure_what TEXT NOT NULL DEFAULT '',
  needs_llm INTEGER NOT NULL DEFAULT 0,
  llm_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (library_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_runs_batch ON library_survey_runs(batch_id, status);

-- R2：采集批次（进度与指标的可观测单位）
CREATE TABLE IF NOT EXISTS library_survey_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  library_ids TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  needs_llm INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  concurrency INTEGER NOT NULL DEFAULT 4,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_no)
);
CREATE INDEX IF NOT EXISTS idx_survey_batch_status ON library_survey_batches(status);

-- R2：测试资源登记（与 schema.ts 逐表对应）
CREATE TABLE IF NOT EXISTS test_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'global',
  scope_key TEXT NOT NULL DEFAULT '',
  library_id INTEGER NULL,
  generator TEXT NOT NULL DEFAULT '',
  schema_kind TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  validated INTEGER NOT NULL DEFAULT 0,
  valid_problems TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  reuse_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (resource_id)
);
CREATE INDEX IF NOT EXISTS idx_test_resources_scope ON test_resources(scope_kind, scope_key, kind);
CREATE INDEX IF NOT EXISTS idx_test_resources_lib ON test_resources(library_id, kind);

CREATE TABLE IF NOT EXISTS test_resource_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  version TEXT NOT NULL,
  file_sha256 TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (resource_id, version)
);

-- README 情报（L0 采集的产物）
CREATE TABLE IF NOT EXISTS readme_intel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readme_intel_lib ON readme_intel(library_id, kind, status);

-- ============================================================
-- B1/B2/B3/B4：测试基线与执行追溯（与 schema.ts 逐表对应）
-- ============================================================

-- B4：需求主档
CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_no TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  primary_library_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'active',
  priority TEXT NOT NULL DEFAULT 'P1',
  acceptance_md TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requirement_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_requirements_ext ON requirements(source, external_id);
CREATE INDEX IF NOT EXISTS idx_requirements_lib ON requirements(primary_library_id);
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);

-- B4：需求 ↔ 用例多对多
CREATE TABLE IF NOT EXISTS requirement_cases (
  requirement_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  relation TEXT NOT NULL DEFAULT 'covers',
  created_at TEXT NOT NULL,
  UNIQUE (requirement_id, case_id)
);
CREATE INDEX IF NOT EXISTS idx_requirement_cases_case ON requirement_cases(case_id);

-- B4：PR 实体
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  number INTEGER NOT NULL,
  library_id INTEGER NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'unknown',
  url TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT '',
  head_branch TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  merge_commit_sha TEXT NOT NULL DEFAULT '',
  merged_at TEXT NULL,
  author TEXT NOT NULL DEFAULT '',
  body_excerpt TEXT NOT NULL,
  files_json TEXT NOT NULL,
  synced_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, repo_url, number)
);
CREATE INDEX IF NOT EXISTS idx_pr_library_state ON pull_requests(library_id, state);
CREATE INDEX IF NOT EXISTS idx_pr_merge_sha ON pull_requests(merge_commit_sha);

-- B4：PR ↔ 受影响库 / PR ↔ 需求
CREATE TABLE IF NOT EXISTS pr_libraries (
  pr_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  relation TEXT NOT NULL DEFAULT 'affects',
  created_at TEXT NOT NULL,
  UNIQUE (pr_id, library_id)
);
CREATE TABLE IF NOT EXISTS pr_requirements (
  pr_id INTEGER NOT NULL,
  requirement_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pr_id, requirement_id)
);
CREATE TABLE IF NOT EXISTS pr_cases (
  pr_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  basis TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE (pr_id, case_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_cases_case ON pr_cases(case_id);

-- B1：物理快照（每仓库每 commit 一份只读检出）
CREATE TABLE IF NOT EXISTS repo_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_url TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  rel_dir TEXT NOT NULL,
  version_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  source_pr_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_url, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_repo_snapshots_status ON repo_snapshots(status);
CREATE INDEX IF NOT EXISTS idx_repo_snapshots_pr ON repo_snapshots(source_pr_id);

-- B1：逻辑基线（每库每 commit）
CREATE TABLE IF NOT EXISTS test_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baseline_no TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  repo_subpath TEXT NOT NULL DEFAULT '',
  version_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (baseline_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_test_baselines ON test_baselines(snapshot_id, library_id);
CREATE INDEX IF NOT EXISTS idx_test_baselines_lib ON test_baselines(library_id, status);

-- B1：基线包含的 PR
CREATE TABLE IF NOT EXISTS baseline_prs (
  baseline_id INTEGER NOT NULL,
  pr_id INTEGER NOT NULL,
  relation TEXT NOT NULL DEFAULT 'source',
  created_at TEXT NOT NULL,
  UNIQUE (baseline_id, pr_id)
);

-- B1：一次计划运行的快照
CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL,
  plan_id INTEGER NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  device_id INTEGER NULL,
  env_run_id INTEGER NULL,
  resource_set_id INTEGER NULL,
  manifest_json TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NULL,
  finished_at TEXT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_no)
);
CREATE INDEX IF NOT EXISTS idx_test_runs_plan ON test_runs(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_test_runs_created ON test_runs(created_at);

-- B1：一次运行中每库的目标
CREATE TABLE IF NOT EXISTS test_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  library_id INTEGER NOT NULL,
  baseline_id INTEGER NOT NULL,
  commit_sha TEXT NOT NULL DEFAULT '',
  repo_subpath TEXT NOT NULL DEFAULT '',
  workspace_rel_dir TEXT NOT NULL DEFAULT '',
  case_versions_json TEXT NOT NULL,
  resource_set_id INTEGER NULL,
  env_run_id INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NULL,
  finished_at TEXT NULL,
  UNIQUE (run_id, library_id)
);
CREATE INDEX IF NOT EXISTS idx_test_run_items_lib ON test_run_items(library_id, baseline_id);

-- B2：场景扩展资产
CREATE TABLE IF NOT EXISTS scenario_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  scenario_kind TEXT NOT NULL DEFAULT 'general',
  uri TEXT NOT NULL DEFAULT '',
  rel_dir TEXT NOT NULL DEFAULT '',
  entry_hint TEXT NOT NULL DEFAULT '',
  config_guide_md TEXT NOT NULL,
  compat_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '1',
  sha256 TEXT NOT NULL DEFAULT '',
  validation_json TEXT NOT NULL,
  validated_at TEXT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (asset_no)
);
CREATE INDEX IF NOT EXISTS idx_scenario_assets_lib ON scenario_assets(library_id, kind, scenario_kind);
CREATE INDEX IF NOT EXISTS idx_scenario_assets_status ON scenario_assets(status);

-- B2：场景资产子表
CREATE TABLE IF NOT EXISTS scenario_asset_cases (
  asset_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'precondition',
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, case_id)
);
CREATE TABLE IF NOT EXISTS scenario_asset_requirements (
  asset_id INTEGER NOT NULL,
  requirement_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, requirement_id)
);
CREATE TABLE IF NOT EXISTS scenario_asset_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'page',
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, rel_path)
);
CREATE TABLE IF NOT EXISTS scenario_asset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version)
);

-- B2：资源集合
CREATE TABLE IF NOT EXISTS test_resource_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_no TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (set_no)
);
CREATE TABLE IF NOT EXISTS test_resource_set_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (set_id, kind, ref_id)
);
CREATE TABLE IF NOT EXISTS run_item_assets (
  run_item_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  apply_status TEXT NOT NULL DEFAULT 'pending',
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_item_id, asset_id)
);

-- B3：Markdown 分析报告索引
CREATE TABLE IF NOT EXISTS analysis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_no TEXT NOT NULL,
  kind TEXT NOT NULL,
  issue_id INTEGER NULL,
  execution_id INTEGER NULL,
  test_run_id INTEGER NULL,
  library_id INTEGER NULL,
  case_id INTEGER NULL,
  baseline_id INTEGER NULL,
  title TEXT NOT NULL,
  md_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (report_no)
);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_lib ON analysis_reports(library_id, created_at);
`;

/** 建表语句拆分（better-sqlite3 exec 支持多语句，这里仍按分号拆便于逐条容错）。 */
export function sqliteSchemaStatements(): string[] {
  return SCHEMA_SQLITE.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
