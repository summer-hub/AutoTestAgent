// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, CaseVersion, DetectBundleResult, Device, Execution, ExploreReportMeta, ExploreResult, Library, LibraryImpact, LibrarySheetSyncResult, ModelConfig, ModelTestResult, Paged, Page, Plan, Prompt, RepoFile, RepoFileEntry, RepoInfo, Task, TestCase } from 'shared';

// 嵌入 DSH 时由构建注入 VITE_API_BASE=/api/autotest（同源直连插件路由）；
// 独立版默认 /api（Vite 代理到 3280）。
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';


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
