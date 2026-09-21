// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, CaseVersion, DetectBundleResult, Device, Execution, ExploreReportMeta, ExploreResult, Library, LibraryImpact, LibrarySheetSyncResult, ModelConfig, ModelTestResult, Paged, Page, Plan, Prompt, RepoFile, RepoFileEntry, RepoInfo, Task, TestCase } from 'shared';

// 嵌入 DSH 时由构建注入 VITE_API_BASE=/api/autotest（同源直连插件路由）；
// 独立版默认 /api（Vite 代理到 3280）。
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(url, { headers, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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

  // 三方库
  libraries: (params: { page?: number; pageSize?: number; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.q) qs.set('q', params.q);
    return req<Page<Library>>(`${API_BASE}/libraries?${qs}`);
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
  dshDefaultModel: () => req<{ configured: string; dshDefault: { provider: string; model: string } | null }>(`${API_BASE}/models/dsh-default`),
  addModel: (b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models`, { method: 'POST', body: JSON.stringify(b) }),
  updateModel: (id: number, b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteModel: (id: number) => req<{ ok: boolean }>(`${API_BASE}/models/${id}`, { method: 'DELETE' }),
  testModel: (id: number) => req<ModelTestResult>(`${API_BASE}/models/${id}/test`, { method: 'POST' }),

  // 任务
  tasks: (status?: string) => paged<Task>(req<Paged<Task> | Task[]>(`${API_BASE}/tasks${status ? `?status=${status}` : ''}`)),
  createTask: (b: { type: string; libraryId?: number; input?: string; title?: string }) =>
    req<Task>(`${API_BASE}/tasks`, { method: 'POST', body: JSON.stringify(b) }),
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

  // 执行记录（调试会话）
  executions: (params: { planId?: number; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.planId) qs.set('planId', String(params.planId));
    if (params.status) qs.set('status', params.status);
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
