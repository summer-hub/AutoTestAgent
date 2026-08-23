// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, CaseVersion, Device, Execution, Library, ModelConfig, ModelTestResult, Page, Plan, Prompt, RepoFile, RepoFileEntry, RepoInfo, Task, TestCase } from 'shared';

// 嵌入 DSH 时由构建注入 VITE_API_BASE=/api/autotest（同源直连插件路由）；
// 独立版默认 /api（Vite 代理到 3280）。
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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
  updateCase: (id: number, body: Partial<TestCase> & { changeNote?: string }) =>
    req<TestCase>(`${API_BASE}/cases/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  createCase: (b: { libraryId: number; caseNo: string; name: string; source?: string; precondition?: string; steps?: string[]; expected?: string; dtsUrl?: string; status?: string }) =>
    req<TestCase>(`${API_BASE}/cases`, { method: 'POST', body: JSON.stringify(b) }),
  deleteCase: (id: number) => req<{ ok: boolean; deletedCaseNo: string }>(`${API_BASE}/cases/${id}`, { method: 'DELETE' }),
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
  addModel: (b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models`, { method: 'POST', body: JSON.stringify(b) }),
  updateModel: (id: number, b: Partial<ModelConfig>) => req<ModelConfig>(`${API_BASE}/models/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteModel: (id: number) => req<{ ok: boolean }>(`${API_BASE}/models/${id}`, { method: 'DELETE' }),
  testModel: (id: number) => req<ModelTestResult>(`${API_BASE}/models/${id}/test`, { method: 'POST' }),

  // 任务
  tasks: (status?: string) => req<Task[]>(`${API_BASE}/tasks${status ? `?status=${status}` : ''}`),
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
    return req<Array<Execution & { caseNo: string; caseName: string; libraryName: string; deviceSerial: string | null }>>(`${API_BASE}/executions?${qs}`);
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
    return req<Analysis[]>(`${API_BASE}/analyses?${qs}`);
  },
  libraryPrs: (libraryId: number) =>
    req<{ items: Array<{ number: number; title: string; state: string; createdAt: string }>; error?: string }>(
      `${API_BASE}/libraries/${libraryId}/prs`,
    ),
  runPrAnalysis: (libraryId: number, prNumber?: number) =>
    req<{ runId: string }>(`${API_BASE}/analyses/pr/${libraryId}`, { method: 'POST', body: JSON.stringify({ prNumber }) }),
  runCaseUpdateAnalysis: (libraryId: number, prNumber?: number) =>
    req<{ runId: string }>(`${API_BASE}/analyses/case-updates/${libraryId}`, { method: 'POST', body: JSON.stringify({ prNumber }) }),
  analysisProgress: (runId: string) =>
    req<{ stage: string; done: boolean; error?: string }>(`${API_BASE}/analyses/progress/${runId}`),
  runAttribution: (b: { granularity: string; libraryId?: number; caseId?: number }) =>
    req<{ analyzed: number; prs: number; source: 'llm' | 'fallback'; message: string }>(
      `${API_BASE}/analyses/attribution`, { method: 'POST', body: JSON.stringify(b) },
    ),

  // 系统配置（M7）
  settings: () => req<Array<{ key: string; value: string | number | boolean | null; updatedAt: string | null }>>(`${API_BASE}/settings`),
  updateSetting: (key: string, value: string | number | boolean) =>
    req<{ ok: boolean }>(`${API_BASE}/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  sharding: () => req<Array<{ shard: number; libraries: number; cases: number }>>(`${API_BASE}/stats/sharding`),
};
