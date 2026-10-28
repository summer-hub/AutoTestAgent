// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, AnalysisReport, Baseline, CaseVersion, DetectBundleResult, Device, EffectiveModelConfig, Execution, ExploreReportMeta, ExploreResult, IssueAnalysisStep, IssueAttribution, Library, LibraryCatalogStatus, LibraryImpact, LibrarySheetSyncResult, ModelConfig, ModelTestResult, Paged, Page, Plan, Prompt, PrDetail, PrListItem, PrRecord, PrTestStatus, RepoFile, RepoFileEntry, RepoInfo, Requirement, RequirementDetail, RequirementListItem, RequirementSource, ResourceSetDetail, ScenarioAsset, ScenarioAssetDetail, ScenarioAssetKind, ScenarioAssetValidation, ScenarioKind, Task, TestCase, TestRun, TestRunDetail } from 'shared';

// A3（设计 §13.2）：runtime config。独立版构建在 index.html 里前置注入 dist/web/config.js
// （window.__AUTOTEST_CONFIG__），部署期可直接编辑它改 apiBase/wsBase，无需重新构建前端。
// 解析顺序：window.__AUTOTEST_CONFIG__.apiBase → 构建期 VITE_API_BASE → '/api'。
export interface AutotestRuntimeConfig {
  edition?: string;
  apiBase?: string;
  wsBase?: string;
  features?: Record<string, boolean>;
}
const runtimeConfig: AutotestRuntimeConfig =
  ((window as unknown as { __AUTOTEST_CONFIG__?: AutotestRuntimeConfig }).__AUTOTEST_CONFIG__) ?? {};
export function getRuntimeConfig(): AutotestRuntimeConfig {
  return runtimeConfig;
}

// 嵌入 DSH 时由构建注入 VITE_API_BASE=/api/autotest（同源直连插件路由）；
// 独立版默认 /api（Vite 代理到 3280）；跨域分离部署由 config.js 的 apiBase 覆盖。
const API_BASE: string =
  String(runtimeConfig.apiBase ?? '').trim() ||
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  '/api';
export function getApiBase(): string {
  return API_BASE;
}

/** R5：问题归因工单（现象 → AI 根因 → 自测试 → 人工验收）。 */
export interface IssueTicket {
  id: number;
  ticketNo: string;
  caseId: number;
  libraryId: number;
  /** 人填的问题现象（提交时快照，之后不改） */
  symptom: string;
  /** pending → analyzing → root_caused → verifying → accepted / rejected / failed */
  status: string;
  rootCause: {
    rootCause: string;
    /** B3：归因主结论（设计 §9.3）；旧工单（改造前）无此字段 */
    attribution?: IssueAttribution;
    confidence: number;
    /** B3：分析过程（假设 → 检查 → 结论，报告第 4 节） */
    process?: IssueAnalysisStep[];
    evidence: Array<{ kind: string; ref: string; line: number; excerpt: string; supports: string }>;
    fixSuggestions: string[];
    needsDemoPatch: boolean;
    uncertainties: string[];
    /** llm = 真实模型结论；rule = 改造前的遗留降级产物（只罗列线索、无推断，不可信，见 Issues.tsx 的 isLegacyRuleCause） */
    analysisBy: 'llm' | 'rule';
  } | null;
  evidence: Array<{ kind: string; ref: string; line: number; excerpt: string; supports: string }>;
  verification: Record<string, unknown>;
  verdict: string;
  verdictReason: string;
  verdictBy: string;
  verdictAt: string | null;
  knowledgeId: string;
  taskId: number | null;
  /** B3 追溯链路：从执行发起时回填（executionId 为空 = 从用例发起，报告标注"未绑定具体执行"） */
  executionId: number | null;
  testRunId: number | null;
  runItemId: number | null;
  baselineId: number | null;
  caseVersion: number | null;
  /** B3：归因主结论（人工修正后覆盖 LLM 结论；attributionReason 是修正留痕） */
  attribution: IssueAttribution;
  attributionReason: string;
  /** B3：最新分析报告（analysis_reports.id；重新生成会产生新报告并指向它） */
  reportId: number | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}

/** P3 覆盖矩阵的返回结构（构建与查询共用）。 */
export interface CoveragePayload {
  libraryId: number;
  libraryName?: string;
  version: string;
  rows: number;
  summary: {
    total: number; covered: number; partial: number; notCovered: number; blocked: number;
    apiCoverage: number; scenarioCoverage: number; byRisk: Record<string, number>;
  };
  matrix: Array<{
    symbolId: number; symbolName: string; kind: string;
    status: 'covered' | 'partial' | 'not_covered' | 'blocked';
    statusReason: string; riskFlags: string[];
    scenarioFit: { happy: boolean; empty: boolean; boundary: boolean; bigdata: boolean };
    deviceReachable: boolean;
    evidence: {
      demoCall?: { pagePath: string; sourceFile: string; sourceLine: number; snippet: string };
      testCallCount: number; traversalReport: string; deviceControls: string[]; devicePagePath: string;
      caseNos: string[]; negativeCaseNos: string[];
      paramPoints: Array<{ pagePath: string; name: string; sourceFile: string; sourceLine: number }>;
    };
  }>;
}


/** 场景级覆盖度（Demo 场景 × Demo 代码）：行 = 场景 P01/N07…，与接口级矩阵并列的第二个维度。 */
export interface DemoScenarioPayload {
  libraryId: number;
  libraryName: string;
  sources: { scenarioDoc: string; reportDoc: string };
  missing: string[];
  rows: number;
  summary: {
    total: number; covered: number; partial: number; uncovered: number;
    positive: number; negative: number;
    overall: number; positiveRate: number; negativeRate: number;
    apiExecuted: number; apiConditional: number; apiMissing: number; apiRate: number;
    byModule: Array<{ module: string; total: number; covered: number; partial: number; uncovered: number; rate: number }>;
    byStatusEvidence: Record<string, number>;
  };
  warnings: string[];
  scenarios: Array<{
    no: string; name: string; kind: 'positive' | 'negative'; module: string; interfaces: string[];
    status: 'covered' | 'partial' | 'uncovered';
    apiCovered: number; apiTotal: number;
    evidence: string; gap: string; note: string;
  }>;
}

/** P4 用例计划的返回结构。 */
export interface CasePlanPayload {
  libraryId: number; name: string; version: string;
  summary: {
    symbols: number; planned: number;
    byScenario: Record<string, number>;
    byPriority: Record<string, number>;
    byKind: Record<string, number>;
    skippedSymbols: Array<{ name: string; kind: string; reason: string }>;
    perSymbolBreakdown: Array<{ name: string; happy: number; empty: number; boundary: number; bigdata: number }>;
  };
  perSymbol: Array<{
    symbolId: number; name: string; kind: string; triggers: number; planned: number;
    fit: Record<string, boolean>; reasons: Record<string, string>;
    negExtra: { empty: number; boundary: number; reasons: string[] };
  }>;
  sampling: { budget: number; selected: number; skipped: number; report: string };
  plans: Array<{
    symbolId: number; symbolName: string; symbolKind: string;
    scenario: string; priority: string; title: string; purpose: string; because: string;
    triggerPage: string; triggerControl: string; inputPlan: string; assertionPlan: string;
    needsPatchHint: string;
  }>;
}

// API Key（P0-1 认证）：存 sessionStorage（关标签页即失效，避免长久驻留明文密钥）；
// 401 时清空并广播 'autotest:unauthorized'，由 App 的登录门接住。
const TOKEN_KEY = 'autotest.apiKey';
export function getApiKey(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setApiKey(key: string): void {
  try { key ? sessionStorage.setItem(TOKEN_KEY, key) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* 隐私模式等 */ }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const key = getApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
  const res = await fetch(url, { headers, ...init });
  if (res.status === 401) {
    // 认证开启且 key 缺失/失效：清掉并通知登录门（避免后续请求连锁 401）
    setApiKey('');
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('autotest:unauthorized'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** 二进制/markdown 下载：带认证头拉取并触发浏览器另存为。 */
async function downloadBlob(url: string, init?: RequestInit): Promise<Blob> {
  const key = getApiKey();
  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : undefined, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.blob();
}

/**
 * 列表信封归一化：兼容"裸数组"（0.1.56 及更早的后端）与 `{ items, nextCursor }`（新后端）。
 * 前端产物与后端代码分别部署/热更时，很容易出现一边新一边旧的窗口
 * （例如只替换了 lib/web 还没重启宿主进程），这里统一兜住，避免整页因取不到 items 而空白。
 */
function paged<T>(p: Promise<Paged<T> | T[]>): Promise<Paged<T>> {
  return p.then((r) => (Array.isArray(r) ? { items: r, nextCursor: null } : r));
}

export const api = {
  health: () => req<{ ok: boolean }>(`${API_BASE}/health`),

  // 认证与 RBAC（P0-1）
  authStatus: () => req<{ enabled: boolean; allowLocalBypass: boolean; role: string | null; via: string | null }>(`${API_BASE}/auth/status`),
  authKeys: () => req<{ items: Array<{ id: number; name: string; role: string; enabled: boolean; expiresAt: string; lastUsedAt: string; createdAt: string }> }>(`${API_BASE}/auth/keys`),
  createAuthKey: (b: { name: string; role: string; expiresInDays?: number }) =>
    req<{ id: number; name: string; role: string; key: string; expiresAt: string }>(`${API_BASE}/auth/keys`, { method: 'POST', body: JSON.stringify(b) }),
  revokeAuthKey: (id: number) => req<{ ok: boolean }>(`${API_BASE}/auth/keys/${id}`, { method: 'DELETE' }),
  updateAuthSettings: (b: { enabled?: boolean; allowLocalBypass?: boolean }) =>
    req<{ ok: boolean; enabled: boolean; allowLocalBypass: boolean }>(`${API_BASE}/auth/settings`, { method: 'PUT', body: JSON.stringify(b) }),

  // 危险操作审批（P0-4）
  approvals: (status?: string) => req<{
    items: Array<{
      id: number; kind: string; kindLabel: string; target: string;
      payload: Record<string, unknown>;
      status: 'pending' | 'approved' | 'rejected';
      requestedBy: string; decidedBy: string; reason: string; consumed: boolean;
      createdAt: string; decidedAt: string;
    }>;
    pending: number;
  }>(`${API_BASE}/approvals${status ? `?status=${status}` : ''}`),
  approvalPendingCount: () => req<{ pending: number }>(`${API_BASE}/approvals/pending-count`),
  decideApproval: (id: number, decision: 'approve' | 'reject', reason?: string) =>
    req<{ ok: boolean; status: string }>(`${API_BASE}/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason, decidedBy: 'web' }) }),

  // 三方库
  libraries: (params: { page?: number; pageSize?: number; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.q) qs.set('q', params.q);
    return req<Page<Library>>(`${API_BASE}/libraries?${qs}`);
  },
  /** 拉全量库列表（服务端 pageSize 上限 100，这里自动翻页聚合，避免大列表被静默截断）。 */
  librariesAll: async (q?: string): Promise<Page<Library>> => {
    const pageSize = 100;
    let page = 1;
    let items: Library[] = [];
    let total = 0;
    let withCases = 0;
    for (;;) {
      const r = await api.libraries({ page, pageSize, q });
      if (page === 1) { total = r.total; withCases = r.withCases ?? 0; }
      items = items.concat(r.items);
      if (items.length >= total || r.items.length === 0 || page >= 200) {
        return { items, total, withCases, page: 1, pageSize: items.length, nextCursor: null };
      }
      page += 1;
    }
  },
  library: (id: number) => req<Library>(`${API_BASE}/libraries/${id}`),
  sourceStats: () => req<{ items: Array<{ source: string; n: number }>; total: number }>(`${API_BASE}/libraries/stats/sources`),
  // 库管理
  createLibrary: (b: { name: string; repoUrl?: string; repoSubpath?: string; description?: string; packageName?: string; mainAbility?: string }) =>
    req<Library>(`${API_BASE}/libraries`, { method: 'POST', body: JSON.stringify(b) }),
  updateLibrary: (id: number, b: Partial<Pick<Library, 'name' | 'repoUrl' | 'repoSubpath' | 'description' | 'packageName' | 'mainAbility' | 'status'>>) =>
    req<Library>(`${API_BASE}/libraries/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  libraryImpact: (id: number) => req<LibraryImpact & { name: string; repoDir: string }>(`${API_BASE}/libraries/${id}/impact`),
  /** force=false 时若库有关联数据，服务端返回 409 并带影响面说明；调用方据此二次确认 */
  deleteLibrary: (id: number, force = false) =>
    req<{ ok: boolean; deleted: string; impact: LibraryImpact; repoDirKept: string }>(
      `${API_BASE}/libraries/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' },
    ),
  detectBundle: (id: number) => req<DetectBundleResult>(`${API_BASE}/libraries/${id}/detect-bundle`, { method: 'POST' }),
  /** 三方库测试表（人维护的 xlsx）→ 库表同步；apply=false 只预览差异，不写库 */
  sheetInfo: () => req<{ file: string; exists: boolean; configuredPath: string }>(`${API_BASE}/libraries/sheet`),
  syncSheet: (b: { file?: string; apply?: boolean } = {}) =>
    req<LibrarySheetSyncResult>(`${API_BASE}/libraries/sync-sheet`, { method: 'POST', body: JSON.stringify(b) }),
  exportSheet: (b: { file?: string } = {}) =>
    req<{ file: string; rows: number }>(`${API_BASE}/libraries/export-sheet`, { method: 'POST', body: JSON.stringify(b) }),
  /** R0：目录引导状态（随包表是否已导入、问题行、环境画像覆盖率） */
  catalog: () => req<LibraryCatalogStatus>(`${API_BASE}/libraries/catalog`),

  // ---- R1：环境纵轴（脚本资产 + 环境画像 + 环境准备）----
  envScripts: () => req<{
    items: Array<{
      id: string; summary: string; version: string; approval: string; enabled: boolean;
      builtin: boolean; sha256: string;
      inputs: Array<{ name: string; type: string; required?: boolean; default?: unknown; description?: string }>;
      outputs: Array<{ name: string; type: string; description?: string }>;
      appliesWhen: { os?: string[]; sdk_min?: string; library_kind?: string[] };
      failureTaxonomy: string[]; idempotent: boolean; timeoutSec: number;
    }>;
    drift: Array<{ id: string; stored: string; current: string }>;
    failureLabels: Record<string, string>;
    exitCodes: Record<string, number>;
  }>(`${API_BASE}/env/scripts`),
  envProfiles: (libraryId = 0) => req<{
    items: Array<{
      id: number; libraryId: number; libraryName: string; name: string; status: string;
      presetKind: string; source: string; confidence: number; stepCount: number;
      runCount: number; lastRunStatus: string; confirmedAt: string | null; updatedAt: string;
    }>;
  }>(`${API_BASE}/env/profiles${libraryId ? `?libraryId=${libraryId}` : ''}`),
  envProfile: (id: number) => req<{
    id: number; libraryId: number; name: string; status: string; presetKind: string; source: string;
    confidence: number;
    steps: Array<{ seq: number; scriptId: string; params: Record<string, unknown>; required: boolean; skipIf: string }>;
  }>(`${API_BASE}/env/profiles/${id}`),
  envProfileCreate: (b: {
    libraryId: number; name: string; presetKind?: string;
    toolchain?: Record<string, unknown>; components?: Record<string, unknown>;
    steps?: Array<{ scriptId: string; params?: Record<string, unknown>; required?: boolean }>;
  }) => req<{ id: number; problems: string[]; stepCount: number }>(`${API_BASE}/env/profiles`, {
    method: 'POST', body: JSON.stringify(b),
  }),
  envProfileRun: (id: number, b: { allowCache?: boolean; commit?: string } = {}) =>
    req<{ runId: number; status: string; cachedFrom: number | null; durationMs: number; error: string }>(
      `${API_BASE}/env/profiles/${id}/run`, { method: 'POST', body: JSON.stringify(b) }),
  envRuns: (libraryId = 0, limit = 30) => req<{
    items: Array<{
      id: number; runNo: string; profileId: number; libraryId: number; libraryName: string;
      status: string; trigger: string; cachedFrom: number | null; durationMs: number;
      error: string; createdAt: string;
    }>;
  }>(`${API_BASE}/env/runs?limit=${limit}${libraryId ? `&libraryId=${libraryId}` : ''}`),
  envRun: (id: number) => req<{
    id: number; runNo: string; profileId: number; libraryId: number; status: string;
    cachedFrom: number | null; durationMs: number; error: string;
    steps: Array<{
      seq: number; scriptId: string; status: string; exitCode: number | null; failureKind: string;
      artifacts: Array<{ name: string; path: string; exists: boolean; size: number; sha256: string }>;
      logPath: string; durationMs: number;
    }>;
  }>(`${API_BASE}/env/runs/${id}`),
  // P2 接口面提取
  extractApi: (id: number) => req<{
    ok: boolean; entryFile: string; packageName: string; symbols: number; demoAssets: number;
    callSites: number; testCallSites: number; problems: string[]; docFile: string; version: string;
  }>(`${API_BASE}/libraries/${id}/extract-api`, { method: 'POST' }),
  apiSymbols: (id: number, version?: string) => req<{
    libraryId: number; name: string; version: string;
    counts: { total: number; demoUsed: number; testOnly: number; unused: number };
    symbols: Array<{
      id: number; name: string; kind: string; signature: string;
      params: Array<{ name: string; type: string; optional: boolean; defaultValue: string; doc: string }>;
      returns: { type: string; doc: string };
      throws: Array<{ type: string; doc: string }>;
      deprecated: boolean; sourceFile: string; sourceLine: number; methods: string[]; detailLevel: string;
      demoCallCount: number; testCallCount: number; pages: string[];
    }>;
    demoAssets: Array<{ kind: string; name: string; pagePath: string; sourceFile: string; sourceLine: number; snippet: string; mutability: string }>;
  }>(`${API_BASE}/libraries/${id}/api-symbols${version ? `?version=${encodeURIComponent(version)}` : ''}`),
  // P11 用例 ↔ 接口关联（矩阵的「用例」列以此为准：初版遍历用例也在此列）
  rebuildCaseLinks: (id: number) => req<{
    libraryId: number; libraryName: string; links: number; linkedCases: number;
    totalCases: number; unlinkedCases: number; byBasis: Record<string, number>; preservedManual: number;
  }>(`${API_BASE}/libraries/${id}/case-links`, { method: 'POST' }),
  caseLinks: (id: number) => req<{
    libraryId: number;
    links: Array<{ caseId: number; caseNo: string; caseName: string; scenarioKind: string; symbolId: number; symbolName: string; basis: string; confidence: string; detail: string }>;
  }>(`${API_BASE}/libraries/${id}/case-links`),
  linkCase: (caseId: number, symbolId: number, linked = true) =>
    req<{ ok: boolean; message: string }>(`${API_BASE}/cases/${caseId}/links`, { method: 'POST', body: JSON.stringify({ symbolId, linked }) }),
  // P3 覆盖矩阵
  buildCoverageMatrix: (id: number) => req<CoveragePayload>(`${API_BASE}/libraries/${id}/coverage-matrix`, { method: 'POST' }),
  coverageMatrix: (id: number, f: { status?: string; risk?: string } = {}) => {
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.risk) qs.set('risk', f.risk);
    const q = qs.toString();
    return req<CoveragePayload>(`${API_BASE}/libraries/${id}/coverage-matrix${q ? `?${q}` : ''}`);
  },
  exportCoverageMatrix: (id: number, format: 'md' | 'csv') =>
    req<{ file: string; format: string; rows: number; summary: CoveragePayload['summary']; preview: string }>(
      `${API_BASE}/libraries/${id}/coverage-matrix/export`, { method: 'POST', body: JSON.stringify({ format }) }),
  // 场景级覆盖度（Demo 场景 × Demo 代码）：md 是唯一事实来源，这里按需解析
  demoScenarios: (id: number) => req<DemoScenarioPayload>(`${API_BASE}/libraries/${id}/demo-scenarios`),
  syncDemoScenarios: (id: number) =>
    req<DemoScenarioPayload>(`${API_BASE}/libraries/${id}/demo-scenarios/sync`, { method: 'POST' }),
  exportDemoScenarios: (id: number, format: 'md' | 'csv') =>
    req<{ file: string; format: string; rows: number; summary: DemoScenarioPayload['summary']; warnings: string[]; preview: string }>(
      `${API_BASE}/libraries/${id}/demo-scenarios/export`, { method: 'POST', body: JSON.stringify({ format }) }),
  // P4 用例计划（dry-run：不调 LLM、不写用例，先看数量报告）
  casePlan: (id: number, b: { budget?: number } = {}) => req<CasePlanPayload>(`${API_BASE}/libraries/${id}/case-plan`, {
    method: 'POST', body: JSON.stringify(b),
  }),
  // P5 可测性判定与补丁评审（补丁只在独立副本上应用，原仓库只读）
  runTestability: (libId: number) => req<{
    libraryId: number; libraryName: string; total: number;
    byClass: Record<string, number>;
    humanQueue: Array<{ caseNo: string; name: string; class: string; reason: string }>;
    withPatch: number;
    details: Array<{ caseId: number; caseNo: string; class: string; reason: string; hasPatch: boolean }>;
  }>(`${API_BASE}/libraries/${libId}/testability`, { method: 'POST' }),
  casePatch: (caseId: number) => req<{
    caseId: number; caseNo: string; name: string; testability: string; testabilityReason: string;
    patch: null | {
      class: string; target: string; reason: string; risk: string; revert: string;
      edits: Array<{ file: string; line: number; before: string; after: string; note: string }>;
      impact?: string[]; verify?: string[];
    };
  }>(`${API_BASE}/cases/${caseId}/patch`),
  applyCasePatch: (caseId: number) => req<{
    ok: boolean; copyDir: string; files: number;
    applied: Array<{ file: string; line: number }>;
    failed: Array<{ edit: { file: string; line: number }; reason: string }>;
  }>(`${API_BASE}/cases/${caseId}/patch/apply`, { method: 'POST', body: JSON.stringify({ approved: true }) }),
  revertCasePatch: (caseId: number, removeCopy: boolean) => req<{ ok: boolean; removed: string[]; copyDir: string }>(
    `${API_BASE}/cases/${caseId}/patch/revert`, { method: 'POST', body: JSON.stringify({ removeCopy }) }),
  // P6 质量度量（两条硬门槛：断言覆盖率 100%、假通过 0）
  quality: (libId: number) => req<{
    name: string; libraryId: number; total: number; withOracle: number; oracleCoverage: number; falsePass: number;
    falsePassCases: Array<{ caseNo: string; name: string; reason: string }>;
    missingOracleCases: Array<{ caseNo: string; name: string; reason: string }>;
    gates: { oracleCoverage: boolean; falsePass: boolean; allPassed: boolean };
  }>(`${API_BASE}/libraries/${libId}/quality`),
  // P7 自动化可行性分流 + 人工接管队列
  triage: (libId: number, maxDurationSec?: number) =>
    req<{ libraryId: number; libraryName: string; total: number; auto: number; human: number; byBlocker: Record<string, number>; queued: number }>(
      `${API_BASE}/libraries/${libId}/triage`, { method: 'POST', body: JSON.stringify({ maxDurationSec }) }),
  humanQueue: (libId: number, status?: string) =>
    req<{ libraryId: number; total: number; open: number; byStage: Record<string, number>; items: Array<{
      id: number; caseId: number | null; caseNo: string; caseName: string; stage: string;
      reason: string; question: string;
      payload: {
        caseNo?: string; caseName?: string; testability?: string; estimatedSeconds?: number;
        oracleCount?: number; steps?: string[];
        patchDraft?: null | { class: string; target: string; reason: string; edits: Array<{ file: string; line: number; before: string; after: string; note: string }> } | null;
      };
      status: string; resolution: string; resolvedBy: string; resolvedAt: string | null; createdAt: string;
    }> }>(`${API_BASE}/libraries/${libId}/human-queue${status ? `?status=${status}` : ''}`),
  resolveQueueItem: (itemId: number, resolution: string) =>
    req<{ ok: boolean; requeued: boolean; appliedOracle: boolean; message: string }>(
      `${API_BASE}/human-queue/${itemId}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) }),
  // G4：人工队列跨库聚合（按「库类别 × 阻塞原因」）——"一次解决一类"的可观测面
  queueSummary: (status?: string) =>
    req<{
      groups: Array<{
        kind: string; stage: string; stageLabel: string; count: number; libraryCount: number;
        libraries: Array<{ id: number; name: string }>; sampleQuestion: string; latestAt: string;
      }>;
      totals: { open: number; groups: number; libraries: number };
      byStage: Record<string, number>;
      byKind: Record<string, number>;
      kindLabels: Record<string, string>;
    }>(`${API_BASE}/automation/queue-summary${status ? `?status=${status}` : ''}`),

  // ---- R5：问题归因工单（现象 → AI 根因 → 自测试 → 人工验收）----
  issues: (opts: { libraryId?: number; caseId?: number; status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.libraryId) q.set('libraryId', String(opts.libraryId));
    if (opts.caseId) q.set('caseId', String(opts.caseId));
    if (opts.status) q.set('status', opts.status);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<{ items: IssueTicket[]; total: number }>(`${API_BASE}/issues${qs ? `?${qs}` : ''}`);
  },
  issue: (id: number) => req<IssueTicket>(`${API_BASE}/issues/${id}`),
  issueCreate: (b: { caseId: number; symptom: string; executionId?: number }) =>
    req<IssueTicket>(`${API_BASE}/issues`, { method: 'POST', body: JSON.stringify(b) }),
  issueAnalyze: (id: number) =>
    req<{ ok: boolean; taskId: number }>(`${API_BASE}/issues/${id}/analyze`, { method: 'POST', body: JSON.stringify({}) }),
  issueAccept: (id: number, reason: string, by = 'human') =>
    req<IssueTicket & { knowledgeId: string }>(`${API_BASE}/issues/${id}/accept`, {
      method: 'POST', body: JSON.stringify({ reason, by }),
    }),
  issueReject: (id: number, reason: string, by = 'human') =>
    req<IssueTicket>(`${API_BASE}/issues/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason, by }) }),
  // ---- B3：归因修正 + Markdown 分析报告（设计 §10.7）----
  issueUpdateAttribution: (id: number, attribution: string, reason: string) =>
    req<IssueTicket>(`${API_BASE}/issues/${id}/attribution`, { method: 'PUT', body: JSON.stringify({ attribution, reason }) }),
  issueReport: (id: number) => req<AnalysisReport>(`${API_BASE}/issues/${id}/report`),
  issueReportGenerate: (id: number) =>
    req<AnalysisReport>(`${API_BASE}/issues/${id}/report`, { method: 'POST', body: JSON.stringify({}) }),
  issueReportDownload: (id: number) => downloadBlob(`${API_BASE}/issues/${id}/report.md`),
  reports: (opts: { libraryId?: number; kind?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.libraryId) q.set('libraryId', String(opts.libraryId));
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<{ items: AnalysisReport[]; total: number }>(`${API_BASE}/reports${qs ? `?${qs}` : ''}`);
  },
  reportDownload: (id: number) => downloadBlob(`${API_BASE}/reports/${id}.md`),
  // ---- B4：需求追踪（设计 §10.2）----
  requirements: (opts: { libraryId?: number; status?: string; q?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.libraryId) q.set('libraryId', String(opts.libraryId));
    if (opts.status) q.set('status', opts.status);
    if (opts.q) q.set('q', opts.q);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<{ items: RequirementListItem[]; total: number }>(`${API_BASE}/requirements${qs ? `?${qs}` : ''}`);
  },
  requirementDetail: (id: number) => req<RequirementDetail>(`${API_BASE}/requirements/${id}`),
  requirementCreate: (b: {
    title: string; source?: RequirementSource; externalId?: string; url?: string;
    primaryLibraryId?: number | null; priority?: string; acceptanceMd?: string; owner?: string; status?: string;
  }) => req<Requirement>(`${API_BASE}/requirements`, { method: 'POST', body: JSON.stringify(b) }),
  requirementUpdate: (id: number, b: {
    title?: string; status?: string; priority?: string; url?: string;
    externalId?: string; acceptanceMd?: string; owner?: string;
  }) => req<Requirement>(`${API_BASE}/requirements/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  requirementLinkCases: (id: number, caseIds: number[], relation = 'covers') =>
    req<{ linked: number }>(`${API_BASE}/requirements/${id}/cases`, { method: 'POST', body: JSON.stringify({ caseIds, relation }) }),
  requirementUnlinkCase: (id: number, caseId: number) =>
    req<{ unlinked: number }>(`${API_BASE}/requirements/${id}/cases/${caseId}`, { method: 'DELETE' }),
  requirementLinkPrs: (id: number, prIds: number[]) =>
    req<{ linked: number }>(`${API_BASE}/requirements/${id}/prs`, { method: 'POST', body: JSON.stringify({ prIds }) }),
  // ---- B4：PR 追踪（设计 §10.3）----
  prsForLibrary: (libraryId: number, opts: { state?: string; q?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.state) q.set('state', opts.state);
    if (opts.q) q.set('q', opts.q);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<{ source: 'db' | 'git' | 'gitcode'; items: Array<Partial<PrListItem> & { id?: number; number: number; title: string; state: string; createdAt?: string }>; error?: string }>(
      `${API_BASE}/libraries/${libraryId}/prs${qs ? `?${qs}` : ''}`);
  },
  syncLibraryPrs: (libraryId: number, opts: { limit?: number; state?: string } = {}) =>
    req<{ libraryId: number; provider: string; synced: number; note?: string }>(
      `${API_BASE}/libraries/${libraryId}/prs/sync`, { method: 'POST', body: JSON.stringify(opts) }),
  prDetail: (prId: number) => req<PrDetail>(`${API_BASE}/prs/${prId}`),
  prLinkRequirements: (prId: number, requirementIds: number[]) =>
    req<{ linked: number }>(`${API_BASE}/prs/${prId}/requirements`, { method: 'POST', body: JSON.stringify({ requirementIds }) }),
  prLinkCases: (prId: number, caseIds: number[], basis = 'manual') =>
    req<{ linked: number }>(`${API_BASE}/prs/${prId}/cases`, { method: 'POST', body: JSON.stringify({ caseIds, basis }) }),
  prCreateBaseline: (prId: number, ref: 'merge' | 'head', versionLabel?: string) =>
    req<{ baseline: { id: number; baseline_no: string; version_label: string; status: string }; reused: boolean }>(
      `${API_BASE}/prs/${prId}/baseline`, { method: 'POST', body: JSON.stringify({ ref, versionLabel }) }),
  prTestStatus: (prId: number) => req<PrTestStatus>(`${API_BASE}/prs/${prId}/test-status`),
  // P8 用例 ↔ 脚本映射与版本联动
  scriptBindings: (libId: number) => req<{
    libraryId: number; total: number; byStatus: Record<string, number>;
    bindings: Array<{
      caseId: number; caseNo: string; caseName: string; caseVersion: number;
      scriptPath: string; moduleStem: string; status: string; statusReason: string;
      lastRunStatus: string; lastRunAt: string | null; fileExists: boolean;
    }>;
  }>(`${API_BASE}/libraries/${libId}/script-bindings`),
  regenerateScript: (caseId: number, force = false) =>
    req<{ ok: boolean; binding?: { status: string; statusReason: string; scriptPath: string } }>(
      `${API_BASE}/cases/${caseId}/script/regenerate`, { method: 'POST', body: JSON.stringify({ force }) }),
  confirmScript: (caseId: number) => req<{ ok: boolean }>(`${API_BASE}/cases/${caseId}/script/confirm`, { method: 'POST' }),
  unbindScript: (caseId: number) => req<{ ok: boolean; removedFile: string }>(
    `${API_BASE}/cases/${caseId}/script/unbind`, { method: 'POST', body: JSON.stringify({ removeFile: true }) }),
  // P9 知识库（LLM wiki，无向量）
  knowledge: (f: { scopeKind?: string; kind?: string; status?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, String(v));
    const q = qs.toString();
    return req<{
      total: number; broken: string[]; byStatus: Record<string, number>; byKind: Record<string, number>; wikiRoot: string;
      entries: Array<{
        id: string; scopeKind: string; scopeKey: string; kind: string; title: string; keywords: string[];
        status: string; confidence: number; evidence: Array<Record<string, unknown>>; body: string;
        createdAt: string; updatedAt: string; wikiPath: string;
      }>;
    }>(`${API_BASE}/knowledge${q ? `?${q}` : ''}`);
  },
  knowledgeConfirm: (id: string) => req<{ id: string }>(`${API_BASE}/knowledge/confirm`, { method: 'POST', body: JSON.stringify({ id }) }),
  knowledgeStatus: (id: string, status: string) => req<{ id: string }>(`${API_BASE}/knowledge/status`, { method: 'POST', body: JSON.stringify({ id, status }) }),
  knowledgeRebuild: () => req<{ total: number; broken: string[] }>(`${API_BASE}/knowledge/rebuild`, { method: 'POST' }),
  knowledgeRetrieve: (b: { library?: string; apiName?: string; scenarioKind?: string; stage?: string; budgetChars?: number }) =>
    req<{
      selected: Array<{ id: string; title: string; scopeKind: string; kind: string; status: string; confidence: number }>;
      why: Array<{ id: string; title: string; score: number; why: string }>;
      truncated: number; text: string;
    }>(`${API_BASE}/knowledge/retrieve`, { method: 'POST', body: JSON.stringify(b) }),
  // P10 Agent 绑定
  agentStages: () => req<{ stages: Array<{ stage: string; label: string; builtinRole: string; input: string; output: string; knowledgeKinds: string[]; knowledgeBudget: number }> }>(`${API_BASE}/agent/stages`),
  agentBindings: (libraryId?: number) => req<{
    libraryId: number | null;
    bindings: Array<{
      stage: string; kind: string; source: string; scope: string; libraryId: number | null;
      promptId: number | null; skillPath: string; model: string; params: Record<string, unknown>; externalCmd: string;
      def: { stage: string; label: string; builtinRole: string; input: string; output: string; knowledgeKinds: string[]; knowledgeBudget: number };
      raw: Record<string, unknown> | null;
    }>;
  }>(`${API_BASE}/agent/bindings${libraryId ? `?libraryId=${libraryId}` : ''}`),
  upsertAgentBinding: (b: {
    stage: string; scope: 'global' | 'library'; libraryId?: number; kind: 'builtin' | 'prompt' | 'skill' | 'external';
    promptId?: number; skillPath?: string; model?: string; params?: Record<string, unknown>; externalCmd?: string;
  }) => req<{ stage: string; kind: string; source: string }>(`${API_BASE}/agent/bindings`, { method: 'POST', body: JSON.stringify(b) }),
  deleteAgentBinding: (id: number) => req<{ ok: boolean }>(`${API_BASE}/agent/bindings/${id}`, { method: 'DELETE' }),
  externalCmdCheck: (cmd: string) => req<{ available: boolean; reason: string }>(`${API_BASE}/agent/external-check?cmd=${encodeURIComponent(cmd)}`),

  // 用例
  cases: (libraryId: number, params: { page?: number; pageSize?: number; q?: string; source?: string; status?: string; ver?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.q) qs.set('q', params.q);
    if (params.source) qs.set('source', params.source);
    if (params.status) qs.set('status', params.status);
    if (params.ver) qs.set('ver', params.ver);
    return req<Page<TestCase>>(`${API_BASE}/libraries/${libraryId}/cases?${qs}`);
  },
  caseDetail: (id: number) => req<TestCase>(`${API_BASE}/cases/${id}`),
  caseVersions: (id: number) => req<CaseVersion[]>(`${API_BASE}/cases/${id}/versions`),
  updateCase: (id: number, body: Partial<TestCase> & { changeNote?: string; author?: string; authorType?: string }) =>
    req<TestCase>(`${API_BASE}/cases/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  createCase: (b: { libraryId: number; caseNo: string; name: string; source?: string; precondition?: string; steps?: string[]; expected?: string; dtsUrl?: string; status?: string }) =>
    req<TestCase>(`${API_BASE}/cases`, { method: 'POST', body: JSON.stringify(b) }),
  deleteCase: (id: number) => req<{ ok: boolean; deletedCaseNo: string }>(`${API_BASE}/cases/${id}`, { method: 'DELETE' }),
  caseToScript: (id: number) =>
    req<{ ok: boolean; file: string; dir: string }>(`${API_BASE}/cases/${id}/script`, { method: 'POST' }),
  optimizeCase: (id: number) =>
    req<{ ok: boolean; caseNo: string; name: string; version: number }>(`${API_BASE}/cases/${id}/optimize`, { method: 'POST' }),
  batchDeleteCases: (ids: number[]) =>
    req<{ ok: boolean; deleted: number }>(`${API_BASE}/cases/batch-delete`, { method: 'POST', body: JSON.stringify({ ids }) }),
  batchUpdateCaseStatus: (ids: number[], status: string) =>
    req<{ ok: boolean; updated: number; status: string }>(`${API_BASE}/cases/batch-status`, { method: 'PUT', body: JSON.stringify({ ids, status }) }),
  rollbackCase: (id: number, version: number, author?: string) =>
    req<{ id: number; currentVersion: number; rolledBackTo: number }>(`${API_BASE}/cases/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version, author }),
    }),
  exportCases: (libraryId: number) => {
    const url = `${API_BASE}/cases/export?libraryId=${libraryId}`;
    return fetch(url).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
      }
      return res.blob();
    });
  },
  importCases: (libraryId: number, fileName: string, base64: string) =>
    req<{ imported: number; skipped: number; errors: string[]; libraryId: number; libraryName: string }>(
      `${API_BASE}/cases/import`,
      { method: 'POST', body: JSON.stringify({ libraryId, fileName, base64 }) },
    ),
  caseOverview: () => req<{ total: number; byStatus: Array<{ status: string; n: number }>; versioned: number }>(`${API_BASE}/cases/stats/overview`),

  // 大模型配置（设置中自定义添加）
  models: () => req<ModelConfig[]>(`${API_BASE}/models`),
  effectiveModel: () => req<EffectiveModelConfig>(`${API_BASE}/models/effective`),
  dshDefaultModel: () => req<{ configured: string; dshDefault: { provider: string; model: string } | null }>(`${API_BASE}/models/dsh-default`),
  addModel: (b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models`, { method: 'POST', body: JSON.stringify(b) }),
  updateModel: (id: number, b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteModel: (id: number) => req<{ ok: boolean }>(`${API_BASE}/models/${id}`, { method: 'DELETE' }),
  testModel: (id: number) => req<ModelTestResult>(`${API_BASE}/models/${id}/test`, { method: 'POST' }),

  // 任务
  tasks: (status?: string) => paged<Task>(req<Paged<Task> | Task[]>(`${API_BASE}/tasks${status ? `?status=${status}` : ''}`)),
  createTask: (b: { type: string; libraryId?: number; input?: string; title?: string }) =>
    req<Task>(`${API_BASE}/tasks`, { method: 'POST', body: JSON.stringify(b) }),
  // 单任务查询：库工作区拉取仓库后要轮询到终态才知道成败（列表接口不带 error/resultSummary 全量）
  getTask: (id: number) => req<Task>(`${API_BASE}/tasks/${id}`),
  retryTask: (id: number) => req<{ ok: boolean }>(`${API_BASE}/tasks/${id}/retry`, { method: 'POST' }),
  cancelTask: (id: number) => req<{ ok: boolean; result: string }>(`${API_BASE}/tasks/${id}/cancel`, { method: 'POST' }),
  deleteTask: (id: number) => req<{ ok: boolean; deletedTaskNo: string }>(`${API_BASE}/tasks/${id}`, { method: 'DELETE' }),

  // 仓库本地目录
  repos: () => req<RepoInfo[]>(`${API_BASE}/repos`),
  scripts: () => req<Array<{ id: number; name: string; dir: string; exists: boolean; fileCount: number }>>(`${API_BASE}/scripts`),
  repoFiles: (id: number, rel = '', root: 'repos' | 'scripts' = 'repos') =>
    req<{ path: string; entries: RepoFileEntry[] }>(`${API_BASE}/repos/${id}/files?path=${encodeURIComponent(rel)}&root=${root}`),
  repoFile: (id: number, rel: string, root: 'repos' | 'scripts' = 'repos') =>
    req<RepoFile>(`${API_BASE}/repos/${id}/file?path=${encodeURIComponent(rel)}&root=${root}`),
  deleteScriptFile: (id: number, name: string) =>
    req<{ ok: boolean }>(`${API_BASE}/repos/${id}/file?path=${encodeURIComponent(name)}&root=scripts`, { method: 'DELETE' }),
  saveScriptFile: (id: number, name: string, content: string) =>
    req<{ ok: boolean; saved: string; size: number }>(`${API_BASE}/repos/${id}/file`, { method: 'PUT', body: JSON.stringify({ name, content }) }),
  runScript: (id: number, name: string) =>
    req<{ ok: boolean; status: 'passed' | 'failed'; durationMs: number; log: string; reportDir?: string }>(
      `${API_BASE}/scripts/run`, { method: 'POST', body: JSON.stringify({ libraryId: id, name }) },
    ),

  // 真机遍历报告（含操作轨迹 ops）
  exploreReports: (libraryId: number) =>
    req<{ items: ExploreReportMeta[]; dir: string }>(`${API_BASE}/explore/reports/${libraryId}`),
  exploreReportContent: (libraryId: number, name: string) =>
    req<ExploreResult>(`${API_BASE}/explore/reports/${libraryId}/content?name=${encodeURIComponent(name)}`),
  exploreSummary: (libraryId: number) =>
    req<{
      ok: boolean;
      report: string | null;
      pages: Array<{
        path: string[];
        pathStr: string;
        controlCount: number;
        rich: boolean;
        animation: boolean;
        swipes: number;
        note: string;
        cases: Array<{ caseId: number; caseNo: string; name: string; scriptStatus: string; status: string }>;
        caseCount: number;
        scriptBound: number;
      }>;
      stats: {
        report: string;
        generatedAt: string;
        totalPages: number;
        richPages: number;
        animationPages: number;
        swipeAdjustedPages: number;
        totalCases: number;
        scriptBound: number;
        coverage: number;
        scriptCoverage: number;
      } | null;
    }>(`${API_BASE}/explore/reports/${libraryId}/summary`),
  events: (taskId?: number, kind?: string, limit = 200) => {
    const qs = new URLSearchParams();
    if (taskId) qs.set('taskId', String(taskId));
    if (kind) qs.set('kind', kind);
    qs.set('limit', String(limit));
    return req<{ ok: boolean; rows: Array<Record<string, unknown>> }>(`${API_BASE}/events?${qs}`);
  },

  // Prompt 模板
  prompts: () => req<Prompt[]>(`${API_BASE}/prompts`),
  addPrompt: (b: Partial<Prompt>) => req<Prompt>(`${API_BASE}/prompts`, { method: 'POST', body: JSON.stringify(b) }),
  updatePrompt: (id: number, b: Partial<Prompt>) => req<Prompt>(`${API_BASE}/prompts/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deletePrompt: (id: number) => req<{ ok: boolean }>(`${API_BASE}/prompts/${id}`, { method: 'DELETE' }),

  // 执行计划
  plans: () => req<Array<Plan & { typeLabel?: string; execStats?: { passed: number; failed: number; total: number } | null }>>(`${API_BASE}/plans`),
  createPlan: (b: Partial<Plan> & { name: string; type: string }) => req<Plan>(`${API_BASE}/plans`, { method: 'POST', body: JSON.stringify(b) }),
  runPlan: (id: number) => req<{ ok: boolean }>(`${API_BASE}/plans/${id}/run`, { method: 'POST' }),
  deletePlan: (id: number) => req<{ ok: boolean }>(`${API_BASE}/plans/${id}`, { method: 'DELETE' }),

  // B1：测试基线（库维度）
  baselines: (libraryId: number) => req<Baseline[]>(`${API_BASE}/libraries/${libraryId}/baselines`),
  createBaseline: (libraryId: number, b: { source: 'latest' | 'tag' | 'manual'; ref?: string; commitSha?: string; versionLabel?: string; note?: string }) =>
    req<Baseline & { reused: boolean }>(`${API_BASE}/libraries/${libraryId}/baselines`, { method: 'POST', body: JSON.stringify(b) }),
  baseline: (id: number) => req<Baseline>(`${API_BASE}/baselines/${id}`),
  verifyBaseline: (id: number) => req<{ ok: boolean; problems: string[]; sizeBytes: number }>(`${API_BASE}/baselines/${id}/verify`, { method: 'POST' }),
  archiveBaseline: (id: number) => req<{ ok: boolean }>(`${API_BASE}/baselines/${id}/archive`, { method: 'POST' }),
  deleteBaseline: (id: number) => req<{ ok: boolean }>(`${API_BASE}/baselines/${id}`, { method: 'DELETE' }),

  // B1：运行快照
  testRuns: (params: { planId?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.planId) qs.set('planId', String(params.planId));
    if (params.limit) qs.set('limit', String(params.limit));
    return req<TestRun[]>(`${API_BASE}/test-runs?${qs}`);
  },
  testRun: (id: number) => req<TestRunDetail>(`${API_BASE}/test-runs/${id}`),

  // B2：场景资产（设计 §10.6）
  scenarioAssets: (params: { libraryId?: number; kind?: string; status?: string; scenarioKind?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.libraryId) qs.set('libraryId', String(params.libraryId));
    if (params.kind) qs.set('kind', params.kind);
    if (params.status) qs.set('status', params.status);
    if (params.scenarioKind) qs.set('scenarioKind', params.scenarioKind);
    if (params.q) qs.set('q', params.q);
    return req<{ items: ScenarioAsset[]; kinds: ScenarioAssetKind[]; scenarioKinds: ScenarioKind[] }>(`${API_BASE}/scenario-assets?${qs}`);
  },
  createScenarioAsset: (b: { libraryId: number; title: string; kind: ScenarioAssetKind; scenarioKind?: ScenarioKind; uri?: string; entryHint?: string; configGuideMd?: string; compat?: { minVersion?: string; maxVersion?: string; commit?: string } }) =>
    req<ScenarioAsset>(`${API_BASE}/scenario-assets`, { method: 'POST', body: JSON.stringify(b) }),
  scenarioAsset: (id: number) => req<ScenarioAssetDetail>(`${API_BASE}/scenario-assets/${id}`),
  updateScenarioAsset: (id: number, b: Partial<{ title: string; scenarioKind: ScenarioKind; uri: string; entryHint: string; configGuideMd: string; compat: { minVersion?: string; maxVersion?: string; commit?: string } }>) =>
    req<ScenarioAsset>(`${API_BASE}/scenario-assets/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  uploadScenarioAssetFiles: (id: number, files: Array<{ path: string; contentBase64: string; role?: string }>, note?: string) =>
    req<{ written: Array<{ path: string; sha256: string; size: number; role: string }>; version: string; totalBytes: number; asset: ScenarioAsset }>(
      `${API_BASE}/scenario-assets/${id}/files`, { method: 'POST', body: JSON.stringify({ files, note }) }),
  validateScenarioAsset: (id: number) => req<ScenarioAssetValidation>(`${API_BASE}/scenario-assets/${id}/validate`, { method: 'POST', body: JSON.stringify({ level: 'static' }) }),
  linkScenarioAssetCases: (id: number, caseIds: number[], role?: string) =>
    req<{ linked: number }>(`${API_BASE}/scenario-assets/${id}/link-cases`, { method: 'POST', body: JSON.stringify({ caseIds, role }) }),
  linkScenarioAssetRequirements: (id: number, requirementIds: number[]) =>
    req<{ linked: number }>(`${API_BASE}/scenario-assets/${id}/link-requirements`, { method: 'POST', body: JSON.stringify({ requirementIds }) }),
  applyScenarioAsset: (id: number, runItemId: number) =>
    req<{ assetNo: string; version: string; applyStatus: string }>(`${API_BASE}/scenario-assets/${id}/apply`, { method: 'POST', body: JSON.stringify({ runItemId }) }),
  deprecateScenarioAsset: (id: number) => req<{ ok: boolean; asset: ScenarioAsset }>(`${API_BASE}/scenario-assets/${id}/deprecate`, { method: 'POST' }),
  deleteScenarioAsset: (id: number) => req<{ removed: boolean; dirRemoved: boolean }>(`${API_BASE}/scenario-assets/${id}`, { method: 'DELETE' }),
  downloadScenarioAssetZip: async (id: number, filename: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/scenario-assets/${id}/download`);
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  // B2：资源集回查
  resourceSet: (id: number) => req<ResourceSetDetail>(`${API_BASE}/resource-sets/${id}`),

  // 执行记录（调试会话）
  executions: (params: { planId?: number; status?: string; baselineId?: number; testRunId?: number; runItemId?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.planId) qs.set('planId', String(params.planId));
    if (params.status) qs.set('status', params.status);
    if (params.baselineId) qs.set('baselineId', String(params.baselineId));
    if (params.testRunId) qs.set('testRunId', String(params.testRunId));
    if (params.runItemId) qs.set('runItemId', String(params.runItemId));
    if (params.limit) qs.set('limit', String(params.limit));
    return paged<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }>(
      req<Paged<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }> | Array<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }>>(`${API_BASE}/executions?${qs}`),
    );
  },
  execution: (id: number) => req<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }>(`${API_BASE}/executions/${id}`),
  askExecution: (id: number, question: string) =>
    req<{ answer: string }>(`${API_BASE}/executions/${id}/ask`, { method: 'POST', body: JSON.stringify({ question }) }),

  // 设备
  devices: () => req<Device[]>(`${API_BASE}/devices`),
  scanDevices: () => req<{ discovered: boolean; device: Device; total: number; source?: 'hdc' | 'simulate'; note?: string }>(`${API_BASE}/devices/scan`, { method: 'POST' }),
  updateDevice: (id: number, b: Partial<Device>) => req<Device>(`${API_BASE}/devices/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  connectDevice: (id: number) => req<Device>(`${API_BASE}/devices/${id}/connect`, { method: 'POST' }),
  deleteDevice: (id: number) => req<{ ok: boolean }>(`${API_BASE}/devices/${id}`, { method: 'DELETE' }),

  // 数据分析 / 归因分析
  analyses: (params: { kind?: string; libraryId?: number; granularity?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.libraryId) qs.set('libraryId', String(params.libraryId));
    if (params.granularity) qs.set('granularity', params.granularity);
    return paged<Analysis>(req<Paged<Analysis> | Analysis[]>(`${API_BASE}/analyses?${qs}`));
  },
  libraryPrs: (libraryId: number) =>
    req<{ items: Array<{ number: number; title: string; state: string; createdAt: string }>; error?: string }>(
      `${API_BASE}/libraries/${libraryId}/prs`,
    ),
  runPrAnalysis: (libraryId: number, prNumbers?: number[]) =>
    req<{ runId: string }>(`${API_BASE}/analyses/pr/${libraryId}`, { method: 'POST', body: JSON.stringify({ prNumbers }) }),
  runCaseUpdateAnalysis: (libraryId: number, prNumbers?: number[]) =>
    req<{ runId: string }>(`${API_BASE}/analyses/case-updates/${libraryId}`, { method: 'POST', body: JSON.stringify({ prNumbers }) }),
  analysisProgress: (runId: string) =>
    req<{ stage: string; done: boolean; error?: string }>(`${API_BASE}/analyses/progress/${runId}`),
  exportAnalyses: async (params: { kind?: string; granularity?: string; libraryId?: number; round?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.granularity) qs.set('granularity', params.granularity);
    if (params.libraryId) qs.set('libraryId', String(params.libraryId));
    if (params.round) qs.set('round', params.round);
    const res = await fetch(`${API_BASE}/analyses/export?${qs}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  deleteAnalysis: (id: number) => req<{ ok: boolean }>(`${API_BASE}/analyses/${id}`, { method: 'DELETE' }),
  deleteAnalysisRound: (round: string) => req<{ ok: boolean; deleted: number }>(`${API_BASE}/analyses/round/${encodeURIComponent(round)}`, { method: 'DELETE' }),
  deleteLibraryAnalyses: (libraryId: number) => req<{ ok: boolean; deleted: number }>(`${API_BASE}/analyses/library/${libraryId}`, { method: 'DELETE' }),
  runAttribution: (b: { caseIds?: number[]; libraryIds?: number[]; allLibraries?: boolean }) =>
    req<{ analyzed: number; prs: number; source: 'llm' | 'fallback'; message: string }>(
      `${API_BASE}/analyses/attribution`, { method: 'POST', body: JSON.stringify(b) },
    ),

  // ---- R2：全量库采集（L0 画像 + 预设匹配 + 资源）----
  surveyStats: () => req<{
    batches: Array<Record<string, unknown>>;
    byKind: Array<{ kind: string; count: number; needsLlm: number }>;
    totals: { libraries: number; surveyed: number; needsLlm: number; failed: number; presetsMatched: number };
  }>(`${API_BASE}/survey/stats`),
  surveyBatchRun: (b: { scope?: string; kinds?: string[]; ids?: number[]; concurrency?: number } = {}) =>
    req<{ batchId: number; total: number; done: number; failed: number; skipped: number; needsLlm: number; byKind: Record<string, number>; durationMs: number }>(
      `${API_BASE}/survey/batches`, { method: 'POST', body: JSON.stringify(b) }),
  surveyBatch: (id: number) => req<{
    id: number; batchNo: string; scope: string; total: number; done: number; failed: number;
    skipped: number; needsLlm: number; status: string; concurrency: number;
    startedAt: string | null; finishedAt: string | null;
    runs: Array<{ libraryId: number; libraryName: string; status: string; failureKind: string; failureWhat: string; needsLlm: boolean; llmReason: string; durationMs: number }>;
  }>(`${API_BASE}/survey/batches/${id}`),
  surveyLibrary: (id: number) => req<{ ok: boolean; skipped: boolean; needsLlm: boolean; failureKind: string; failureWhat: string; kind?: string }>(
    `${API_BASE}/survey/libraries/${id}`, { method: 'POST', body: JSON.stringify({}) }),
  surveyPresets: () => req<{ kinds: string[]; root: string }>(`${API_BASE}/survey/presets`),
  // R3：L2 LLM 增量采集（只跑 L0/L1 搞不定的差异库，花 token，受预算闸门保护）
  surveyL2: (b: { ids?: number[]; limit?: number; taskId?: number } = {}) =>
    req<{
      processed: number; resolved: number; queued: number; failed: number; skipped: number;
      details: Array<{ libraryId: number; libraryName: string; status: string; kind?: string; profileId?: number; queued: number; reason: string }>;
    }>(`${API_BASE}/survey/l2`, { method: 'POST', body: JSON.stringify(b) }),
  surveyL2Pending: (limit = 50) => req<{
    items: Array<{ libraryId: number; libraryName: string; llmReason: string; kind: string; kindReason: string; confidence: number }>;
  }>(`${API_BASE}/survey/l2/pending?limit=${limit}`),
  resources: (kind?: string, scopeKey?: string) => req<{
    items: Array<{
      resourceId: string; kind: string; origin: string; scopeKind: string; scopeKey: string;
      libraryId: number | null; generator: string; filePath: string; sha256: string; size: number;
      validated: boolean; problems: string[]; intent: string; reuseCount: number; expiresAt: string | null;
    }>;
  }>(`${API_BASE}/resources${kind ? `?kind=${encodeURIComponent(kind)}` : ''}${scopeKey ? `${kind ? '&' : '?'}scopeKey=${encodeURIComponent(scopeKey)}` : ''}`),
  resourcesSynthesize: (kind: string) => req<{ registered: number; problems: number; ids: string[] }>(
    `${API_BASE}/resources/synthesize`, { method: 'POST', body: JSON.stringify({ kind }) }),

  // 系统配置（M7）
  settings: () => req<Array<{ key: string; value: string | number | boolean | null; updatedAt: string | null }>>(`${API_BASE}/settings`),
  workspaceInfo: () =>
    req<{ configured: boolean; setting: string; effective: string; notice: string | null }>(`${API_BASE}/workspace/info`),
  openWorkspace: (path?: string) =>
    req<{ ok: boolean; opened: string }>(`${API_BASE}/workspace/open`, { method: 'POST', body: JSON.stringify({ path }) }),
  updateSetting: (key: string, value: string | number | boolean) =>
    req<{ ok: boolean }>(`${API_BASE}/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  sharding: () => req<Array<{ shard: number; libraries: number; cases: number }>>(`${API_BASE}/stats/sharding`),
};
