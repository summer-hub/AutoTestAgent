// ============================================================
// AutoTest 平台 — 共享领域类型
// 前后端共用；后端 DB 行 ↔ API DTO 以此为准
// ============================================================

/** 用例来源分类 */
export type CaseSource = '新需求引入' | '老库存量' | '问题单跟踪' | 'AI 生成' | '真机遍历';

/** 用例状态 */
export type CaseStatus = '通过' | '失败' | '待确认' | '未执行';

/** 脚本绑定状态 */
export type ScriptStatus = '已绑定' | '未绑定';

/**
 * 列表信封：items + keyset 游标。
 * nextCursor 必须挂在对象上 —— 挂在数组属性上会被 JSON.stringify 丢弃，
 * 客户端就永远拿不到游标、只能看第一页。
 */
export interface Paged<T> {
  items: T[];
  nextCursor: number | null;
}

/** 三方库 */
export interface Library {
  id: number;
  name: string;              // 库名，如 axios-ohos
  repoUrl: string;           // 仓库根地址（不含 /tree/...）
  /**
   * 库在仓库内的子目录（单体仓专用，如 openharmony_tpc_samples 下的 `json-schema`）。
   * 空串表示库就是整个仓库。三方库表里 171/269 个是单体仓子目录地址，必须靠这两列区分：
   * 克隆按 repoUrl 共享一份，工程解析只看 仓库根 + 本子目录。
   */
  repoSubpath: string;
  description: string;
  /**
   * bundleName（真机启动/遍历/执行的前提）。
   * 两种填充路径：① 拉取仓库后从 app.json5 / module.json5 自动解析；
   *                   ② 库管理页手工填写或点「识别包名」从设备已安装应用模糊匹配。
   * 为空时真机遍历会 aa start 失败（会 dump 到桌面），因此遍历前必须补齐。
   */
  packageName: string;
  mainAbility: string;       // 主 Ability
  currentVersion: string;    // 三方库当前版本，如 v1.13.0
  status: 'active' | 'archived';
  lastSyncedAt: string | null;
  caseCount?: number;        // 聚合：用例数
  createdAt: string;
  updatedAt: string;
}

/** 删除库前的影响面统计（用于「确认删除」提示） */
export interface LibraryImpact {
  cases: number;
  versions: number;
  tasks: number;
  executions: number;
  analyses: number;
  plans: number;
}

/** 「识别包名」的结果：命中唯一时已落库，命中多个/零个时返回候选交由人选择 */
export interface DetectBundleResult {
  saved: boolean;
  bundleName: string;
  mainAbility: string;
  candidates: Array<{ bundleName: string; mainAbility: string }>;
}

/**
 * 三方库测试表（xlsx）同步的结果。
 *
 * 分工：xlsx 是人维护的（有哪些库、对应哪个仓库/子目录），db 是 Agent 维护的（包名、同步状态…）。
 * 所以同步是单向的，只写人维护的那两列；`dbOnly` 是"库里有、表里没有"的库，
 * 只报告不删除（删库会级联删用例/任务/执行历史），由人决定。
 */
export interface LibrarySheetSyncResult {
  file: string;
  total: number;             // 表里解析出的库数
  applied: boolean;          // false = 仅预览（dry-run）
  header: { row: number; nameCol: number; urlCol: number } | null;
  counts: { added: number; updated: number; unchanged: number; dbOnly: number; problems: number };
  plan: {
    added: Array<{ name: string; repoUrl: string; repoSubpath: string; row: number }>;
    updated: Array<{ id: number; name: string; from: { repoUrl: string; repoSubpath: string }; to: { repoUrl: string; repoSubpath: string }; row: number }>;
    unchanged: Array<{ id: number; name: string; row: number }>;
    dbOnly: Array<{ id: number; name: string; repoUrl: string; repoSubpath: string; packageName: string; caseCount: number }>;
    problems: Array<{ row: number; name: string; reason: string }>;
  };
}

/**
 * R0：目录引导状态（GET /libraries/catalog）—— 让三个端都能自证
 * 「随包的三方库测试表导进业务库了没有、少了哪几行」。
 */
export interface LibraryCatalogStatus {
  /** 随包资产里的那份表（构建后位于 lib/assets/） */
  bundled: { exists: boolean; path: string; sha256: string };
  /** 数据目录里实际在用的那份表 */
  active: { file: string; exists: boolean; configured: string };
  /** 最近一次真实导入的留痕（无变化时不新增记录） */
  latest: {
    at: string; source: string; sha256: string; total: number;
    added: number; updated: number; unchanged: number; dbOnly: number; problems: number;
  } | null;
  /** 最近一次导入的问题行（带 xlsx 行号，可直接回表修正） */
  problems: Array<{ row: number; name: string; reason: string }>;
  /** profiled = 已有环境画像的库数（R1 之前恒 0） */
  db: { libraries: number; profiled: number; unprofiled: number };
}

/** 测试用例（主表行） */
export interface TestCase {
  id: number;
  libraryId: number;
  libraryName?: string;
  caseNo: string;            // 业务编号 C-AX-004
  name: string;
  source: CaseSource;
  precondition: string;
  steps: string[];           // JSON 数组
  expected: string;
  status: CaseStatus;
  scriptStatus: ScriptStatus;
  /** P5 可测性判定：A 开箱 / B 改参数 / C 需改代码 / D 无法测（空串=尚未判定） */
  testability?: '' | 'A' | 'B' | 'C' | 'D';
  testabilityReason?: string;
  /** 该用例是否带补丁草案（B/C 类才有） */
  hasPatch?: boolean;
  /** P6：机器可校验判据（断言覆盖率硬门槛；空数组=断言为空，属于假通过风险） */
  oracles?: Array<{ type: string; control?: string; value?: string; keyword?: string; expr?: string; note?: string }>;
  /** P4：场景维度与优先级 */
  scenarioKind?: string;
  priority?: string;
  dtsUrl: string;              // 问题单（DTS）链接，空 = 无关联问题单
  /** R5：问题现象（人维护的"当前疑问"，如"点击播放后进度条不动"）。
   *  与 Agent 字段的边界：这一列是人写的观察，同步/导入绝不覆盖它。 */
  symptom?: string;
  /** 当前版本号：每次更新自动 +1，无上限（单条用例粒度） */
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** 用例版本历史（快照式，单条用例粒度） */
export interface CaseVersion {
  id: number;
  caseId: number;
  version: number;           // 1, 2, 3 …
  snapshot: TestCase;        // 该版本完整内容快照
  changeNote: string;        // 更新点说明
  author: string;
  authorType: 'ai' | 'human';
  createdAt: string;
}

/** AI 任务类型（预置卡片） */
export type TaskType =
  | 'pull_repo'      // 拉取仓库代码
  | 'update_repo'    // 更新仓库代码
  | 'write_cases'    // 编写测试用例
  | 'explore_cases'  // 真机遍历生成用例（遍历数据 → 用例生成 Agent 优化）
  | 'matrix_cases'   // 覆盖矩阵驱动生成用例（四类场景，LLM 只负责把计划写成用例）
  | 'integrate_cases' // 整合：初版用例关联接口 → 结合真机控件与接口契约升级为正式用例（P11）
  | 'update_cases'   // 更新测试用例
  | 'to_script';     // 用例转自动化脚本

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'stopped';

/** AI 任务 */
export interface Task {
  id: number;
  taskNo: string;            // T-2408
  type: TaskType;
  title: string;
  libraryId: number | null;
  input: string;             // 用户对话/任务描述
  trace: Array<{ seq: number; at: string; title: string; detail: string }>; // AI 执行轨迹
  status: TaskStatus;
  progress: number;          // 0-100
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 执行计划类型 */
export type PlanType = 'immediate' | 'scheduled' | 'single' | 'batch' | 'full';
export type PlanStatus = 'draft' | 'running' | 'done' | 'failed' | 'stopped';

/** 执行计划 */
export interface Plan {
  id: number;
  planNo: string;
  name: string;
  type: PlanType;
  cron: string | null;       // 定时表达式
  scope: { libraryIds: number[]; caseIds: number[] }; // 空数组 = 全量
  deviceIds: number[];
  status: PlanStatus;
  failPolicy: 'continue' | 'abort_library' | 'retry_twice';
  scriptMode?: string;        // 兼容保留（现版本计划固定直接执行绑定脚本）
  /** B1：基线模式 —— latest=最新可用（默认，运行时懒创建）；fixed=固定基线；pr=PR 合入基线（B4） */
  baselineMode?: 'latest' | 'fixed' | 'pr';
  /** B1：fixed 模式绑定的基线 id（其它模式为 null） */
  baselineId?: number | null;
  error?: string;             // 最近一次执行失败原因（设备未连接等）
  progress?: number;          // 执行进度 0-100
  progressNote?: string;      // 实时进度说明（如 12/30 · C-AI-005 通过）
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** B1：测试基线（逻辑基线 = 物理快照 + 库子目录视角） */
export interface Baseline {
  id: number;
  baselineNo: string;         // BL-YYYYMMDD-001
  libraryId: number;
  snapshotId: number;
  repoSubpath: string;
  versionLabel: string;
  source: 'latest' | 'pr' | 'tag' | 'manual';
  status: 'ready' | 'archived' | 'creating' | 'failed';
  note: string;
  createdBy: string;
  commitSha: string;
  repoUrl: string;
  relDir: string;
  snapshotStatus: string;
  sizeBytes: number;
  sourcePrId: number | null;
  execCount: number;
  referencedByPlan: boolean;
  createdAt: string;
  updatedAt: string;
}

/** B1：一次计划运行的快照（test_runs 行） */
export interface TestRun {
  id: number;
  runNo: string;              // TR-YYYYMMDD-001
  planId: number | null;
  planNo: string;
  planName: string;
  triggerKind: 'manual' | 'schedule' | 'api';
  status: 'pending' | 'running' | 'done' | 'failed';
  deviceId: number | null;
  manifest: Record<string, unknown> | null;
  error: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** B1：一次运行中每库的目标（test_run_items 行） */
export interface TestRunItem {
  id: number;
  runId: number;
  libraryId: number;
  libraryName: string;
  baselineId: number | null;
  baselineNo: string;
  baselineLabel: string;
  commitSha: string;
  repoSubpath: string;
  workspaceRelDir: string;
  caseVersions: Record<string, number> | null;
  status: string;
  error: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** B1：运行详情（头部 + 每库 items） */
export interface TestRunDetail extends TestRun {
  items: TestRunItem[];
}

/** B2：场景资产类型（设计 §8.2 五类来源） */
export type ScenarioAssetKind = 'onebox_link' | 'demo_page' | 'fixture' | 'config' | 'mixed';

/** B2：资产适用场景 */
export type ScenarioKind = 'happy' | 'empty' | 'boundary' | 'bigdata' | 'general';

/** B2：场景资产（scenario_assets 行，列表视角含统计） */
export interface ScenarioAsset {
  id: number;
  assetNo: string;             // SA-YYYYMMDD-001
  libraryId: number;
  libraryName: string;
  title: string;
  kind: ScenarioAssetKind;
  scenarioKind: ScenarioKind;
  uri: string;
  entryHint: string;
  configGuideMd: string;
  compat: { minVersion?: string; maxVersion?: string; commit?: string } | null;
  status: 'draft' | 'validated' | 'deprecated';
  version: string;
  sha256: string;
  validation: { level?: string; checkedAt?: string; problems?: string[] } | null;
  validatedAt: string | null;
  fileCount: number;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
}

/** B2：场景资产文件（scenario_asset_files 行） */
export interface ScenarioAssetFile {
  id: number;
  path: string;                // 资产内相对路径
  sha256: string;
  size: number;
  role: string;                // page / fixture / config…
  createdAt: string;
}

/** B2：资产版本史（scenario_asset_versions 行） */
export interface ScenarioAssetVersion {
  id: number;
  version: string;
  sha256: string;
  note: string;
  createdAt: string;
}

/** B2：资产关联的用例 */
export interface ScenarioAssetCaseLink {
  case_id: number;
  case_no: string;
  name: string;
  role: string;
}

/** B2：资产关联的需求 */
export interface ScenarioAssetRequirementLink {
  requirement_id: number;
  requirement_no: string;
  title: string;
}

/** B2：资产的应用记录（run_item_assets 视角） */
export interface ScenarioAssetRunRef {
  run_item_id: number;
  run_no: string;
  asset_id: number;
  version: string;
  apply_status: string;        // recorded（登记制）/ applied / failed
  created_at: string;
}

/** B2：场景资产详情 */
export interface ScenarioAssetDetail extends ScenarioAsset {
  files: ScenarioAssetFile[];
  versions: ScenarioAssetVersion[];
  cases: ScenarioAssetCaseLink[];
  requirements: ScenarioAssetRequirementLink[];
  runRefs: ScenarioAssetRunRef[];
}

/** B2：静态校验结果 */
export interface ScenarioAssetValidation {
  ok: boolean;
  level: string;
  problems: string[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** B2：资源集回查（test_resource_sets + items） */
export interface ResourceSetDetail {
  id: number;
  setNo: string;               // RS-YYYYMMDD-001
  libraryId: number;
  name: string;
  manifest: Record<string, unknown> | null;
  createdAt: string;
  items: Array<{
    id: number;
    kind: string;              // scenario_asset / test_resource
    refId: number;
    version: string;
    role: string;
    sha256: string;
    createdAt: string;
  }>;
}

/** B3：归因枚举（设计 §9.3，attribution 是主结论） */
export type IssueAttribution = 'case_precondition' | 'demo' | 'library' | 'environment' | 'flaky' | 'unknown';

/** B3：分析过程条目（设计 §9.4 —— 假设 → 检查 → 结论，报告第 4 节） */
export interface IssueAnalysisStep {
  hypothesis: string;
  checked: string;
  result: 'confirmed' | 'excluded' | 'uncertain';
}

/** B3：Markdown 分析报告（analysis_reports 行；正文不入 DTO，下载走 .md 接口） */
export interface AnalysisReport {
  id: number;
  reportNo: string;            // RP-YYYYMMDD-001
  kind: string;                // issue_root_cause（留扩展）
  issueId: number | null;
  executionId: number | null;
  testRunId: number | null;
  libraryId: number | null;
  caseId: number | null;
  baselineId: number | null;
  title: string;
  mdPath: string;              // 相对 workspace（reports/<lib>/<reportNo>.md）
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

/** B4：需求来源（设计 §7.1） */
export type RequirementSource = 'manual' | 'onebox' | 'import';

/** B4：需求行（requirements 表；只存 external_id + url + 验收点，不复制外部系统全文） */
export interface Requirement {
  id: number;
  requirementNo: string;        // RQ-YYYYMMDD-NNN
  externalId: string;
  source: string;
  title: string;
  url: string;
  primaryLibraryId: number | null;
  status: string;               // active | done | closed | dropped
  priority: string;
  acceptanceMd: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

/** B4：需求列表项（统计现算：用例数/PR 数/最近失败/基线数） */
export interface RequirementListItem extends Requirement {
  caseCount: number;
  prCount: number;
  recentFailed: number;
  baselineCount: number;
}

/** B4：需求详情（关联用例/PR/场景资产） */
export interface RequirementDetail extends RequirementListItem {
  cases: Array<{ id: number; caseNo: string; name: string; status: string; relation: string }>;
  prs: Array<{ id: number; number: number; title: string; state: string }>;
  scenarioAssets: Array<{ id: number; assetNo: string; title: string; kind: string }>;
}

/** B4：PR 派生测试状态（设计 §7.3：untested/testing/passed/failed/partial，不由 PR 表自维护） */
export type PrDerivedStatus = 'untested' | 'testing' | 'passed' | 'failed' | 'partial';

export interface PrTestStatus {
  status: PrDerivedStatus;
  baselineCount: number;
  runItemCount: number;
  executionCount: number;
  passedCount: number;
  failedCount: number;
  lastRunAt: string;
}

/** B4：PR 行（pull_requests 表；merge_commit_sha 拿不到留空不编造） */
export interface PrRecord {
  id: number;
  provider: string;
  repoUrl: string;
  number: number;
  libraryId: number | null;
  title: string;
  state: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string | null;
  author: string;
  bodyExcerpt: string;
  filesJson: string;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** B4：PR 列表项（关联计数 + 派生测试状态） */
export interface PrListItem extends PrRecord {
  requirementCount: number;
  caseCount: number;
  baselineCount: number;
  testStatus: PrTestStatus;
}

/** B4：PR 详情（关联需求/用例/基线） */
export interface PrDetail extends PrListItem {
  libraryName: string;
  requirements: Array<{ id: number; requirementNo: string; title: string; status: string }>;
  cases: Array<{ id: number; caseNo: string; name: string; basis: string }>;
  baselines: Array<{ id: number; baselineNo: string; versionLabel: string; status: string; commitSha: string }>;
}


/** 执行步骤（调试会话轨迹） */
export interface ExecutionStep {
  seq: number;
  desc: string;              // 如 打开时钟应用
  status: 'passed' | 'failed' | 'skipped' | 'running';
  durationMs: number | null;
}

/** 执行记录 */
export interface Execution {
  id: number;
  planId: number | null;
  caseId: number;
  libraryId: number;
  deviceId: number | null;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  steps: ExecutionStep[];    // 执行轨迹
  thinking: string | null;   // AI 思考过程
  logs: string | null;
  /** B1 追溯列（旧数据为 null —— 显示「未知（历史数据）」，不伪造） */
  testRunId: number | null;  // 所属运行 TR-...
  runItemId: number | null;
  baselineId: number | null; // 基线 BL-...
  caseVersion: number | null; // 用例版本快照
  libraryVersion: string;
  commitSha: string;
  actualJson: string | null;  // 执行实际结果快照（设计 §6.6）
  startedAt: string | null;
  finishedAt: string | null;
}

/** 设备 */
export interface Device {
  id: number;
  serial: string;            // HDC-7F3A
  model: string;
  osVersion: string;
  status: 'online' | 'offline' | 'history';
  battery: number | null;
  memoryUsage: number | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** Prompt 模板 */
export interface Prompt {
  id: number;
  name: string;
  role: string;              // 用例生成 Agent / 归因分析 Agent …
  content: string;           // 模板内容，支持 {var} 注入
  skill: string;             // 绑定的技能说明（用户可自定义，任务执行时注入 Agent）
  variables: string[];
  builtin: boolean;
  version: number;
  updatedAt: string;
}

/** 系统配置键值 */
export interface Setting {
  key: string;
  value: unknown;
  updatedAt: string;
}

/** 大模型配置（设置中可自定义添加） */
export interface ModelConfig {
  id: number;
  name: string;                // 显示名，如 deepseek-v4
  provider: 'deepseek' | 'openai' | 'ollama' | 'custom' | string;
  baseUrl: string;             // https://api.deepseek.com/v1
  modelId: string;             // deepseek-chat
  apiKey: string;              // 只回传掩码（••••1234）；真实密钥永不下发，掩码原样回传视为"不改动"
  hasApiKey: boolean;          // 是否已配置凭据 —— 状态点用它判断，不要用 apiKey 的真假
  protocol: 'openai' | 'anthropic';  // 调用协议：chat/completions 或 /v1/messages
  source: 'env' | 'db';        // 配置来源：env = AUTOTEST_LLM_* 覆盖，db = models 表
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 当前生效的模型配置（含来源，用于「为什么用了这个模型」的排查） */
export interface EffectiveModelConfig {
  source: 'env' | 'db' | 'none';
  name: string;
  provider: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  modelId: string;
  hasApiKey: boolean;
  id?: number;
  candidates?: number;         // db 来源时的候选总数
}

/** 模型连通性测试结果 */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number | null;
  message: string;             // 成功回显 / 失败原因（401/超时等）
  responsePreview?: string;
}

/** 数据分析 / 归因分析结果（analyses 表，content 为结构化 JSON） */
export interface Analysis {
  id: number;
  kind: 'pr_analysis' | 'case_update_analysis' | 'attribution' | string;
  granularity: 'single' | 'lib' | 'multi' | string;
  libraryId: number | null;
  caseId: number | null;
  title: string;
  content: Record<string, any>;
  round: string;              // 扫描轮次标识（每次「拉取并分析 PR / 用例更新分析」一轮）
  createdAt: string;
}

/** 列表响应 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  /** 本页游标（keyset 分页用，取上一页最后一条的 id） */
  nextCursor?: number | null;
  /** 有用例的库数（/libraries 专用，供覆盖率 KPI 用全量聚合值而非当页 items） */
  withCases?: number;
}

/** 仓库本地目录信息（repos API） */
export interface RepoInfo {
  id: number;
  name: string;
  repoUrl: string;
  repoSubpath?: string;        // 单体仓内本库的子目录（空=整个仓库）
  dir: string;                 // 服务器本地目录
  exists: boolean;             // 是否已拉取到本地
  version: string;
  lastCommit: string;
  lastSyncedAt: string | null;
}

export interface RepoFileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: string;
}

export interface RepoFile {
  name: string;
  content: string;
  truncated: boolean;
  binary?: boolean;
}

// ---- 真机 UI 遍历 ----

/** 遍历参数（未传字段时后端读系统配置 explore.*） */
export interface ExploreParams {
  deviceId?: number;
  launchAbility?: string;
  maxDepth?: number;          // BFS 最大深度
  maxPages?: number;          // 最多收录页面数
  controlsPerPage?: number;   // 每页最多收集控件数
  maxSwipePerPage?: number;   // 单页滑动次数上限
}

/** 遍历到的控件 */
export interface ExploredControl {
  text: string;
  desc: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 遍历到的页面 */
export interface ExploredPage {
  path: string[];              // 从首页到达该页的点击文本序列，首元素固定「首页」
  controls: ExploredControl[];
  screen: { w: number; h: number };
  swipes: number;              // 为看全内容滑动的次数（越界动画适配）
  scrolls?: number;            // 上下滚动探索的屏数（发现首屏外可交互控件）
  animation?: { x: number; y: number; w: number; h: number };
  note: string;
}

/** 真机操作轨迹条目 */
export interface ExploredOp {
  at: string;
  action: string;
  detail?: string;
}

/** 遍历结果报告（explore_<ts>.json 内容） */
export interface ExploreResult {
  packageName: string;
  serial: string;
  pages: ExploredPage[];
  visitedCount: number;
  durationMs: number;
  /** 真机操作轨迹（新版报告才有，旧报告为空数组） */
  ops?: ExploredOp[];
}

/** 遍历报告文件元信息（列表用） */
export interface ExploreReportMeta {
  file: string;                // explore_<ts>.json
  mtime: string;
  size: number;
  pages: number;
  visitedCount: number;
  durationMs: number;
  serial: string;
  packageName: string;
}
