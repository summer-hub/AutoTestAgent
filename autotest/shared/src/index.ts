// ============================================================
// AutoTest 平台 — 共享领域类型
// 前后端共用；后端 DB 行 ↔ API DTO 以此为准
// ============================================================

/** 用例来源分类 */
export type CaseSource = '新需求引入' | '老库存量' | '问题单跟踪' | 'AI 生成';

/** 用例状态 */
export type CaseStatus = '通过' | '失败' | '待确认' | '未执行';

/** 脚本绑定状态 */
export type ScriptStatus = '已绑定' | '未绑定';

/** 三方库 */
export interface Library {
  id: number;
  name: string;              // 库名，如 axios-ohos
  repoUrl: string;
  description: string;
  currentVersion: string;    // 三方库当前版本，如 v1.13.0
  status: 'active' | 'archived';
  lastSyncedAt: string | null;
  caseCount?: number;        // 聚合：用例数
  createdAt: string;
  updatedAt: string;
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
  dtsUrl: string;              // 问题单（DTS）链接，空 = 无关联问题单
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
  | 'update_cases'   // 更新测试用例
  | 'to_script';     // 用例转自动化脚本

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

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
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  provider: 'deepseek' | 'openai' | 'ollama' | 'custom';
  baseUrl: string;             // https://api.deepseek.com/v1
  modelId: string;             // deepseek-chat
  apiKey: string;              // 空 = 未配置（状态点红色）
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
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
}

/** 仓库本地目录信息（repos API） */
export interface RepoInfo {
  id: number;
  name: string;
  repoUrl: string;
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
