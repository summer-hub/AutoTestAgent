// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, CaseVersion, Device, Execution, Library, ModelConfig, ModelTestResult, Page, Plan, Prompt, Task, TestCase } from 'shared';

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

  // 设备
  devices: () => req<Device[]>(`${API_BASE}/devices`),
  scanDevices: () => req<{ discovered: boolean; device: Device; total: number }>(`${API_BASE}/devices/scan`, { method: 'POST' }),
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
  runPrAnalysis: (libraryId: number) =>
    req<{ analyzed: number; prs: number; source: 'llm' | 'fallback'; message: string }>(
      `${API_BASE}/analyses/pr/${libraryId}`, { method: 'POST' },
    ),
  runCaseUpdateAnalysis: (libraryId: number) =>
    req<{ analyzed: number; prs: number; source: 'llm' | 'fallback'; message: string }>(
      `${API_BASE}/analyses/case-updates/${libraryId}`, { method: 'POST' },
    ),
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
