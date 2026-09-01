// API 客户端 — 统一走 /api（Vite 代理到后端 3280）
import type { Analysis, CaseVersion, Device, Execution, ExploreReportMeta, ExploreResult, Library, ModelConfig, ModelTestResult, Page, Plan, Prompt, RepoFile, RepoFileEntry, RepoInfo, Task, TestCase } from 'shared';

// 嵌入 DSH 时由构建注入 VITE_API_BASE=/api/autotest（同源直连插件路由）；
// 独立版默认 /api（Vite 代理到 3280）。
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

export interface AuthUser {
  id: number;
  username: string;
  roles: string[];
  permissions: string[];
}

// 登录态（localStorage）
const TOKEN_KEY = 'autotest_token';
const REFRESH_KEY = 'autotest_refresh';
export const authState = {
  get token(): string { return localStorage.getItem(TOKEN_KEY) ?? ''; },
  set token(v: string) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  get refresh(): string { return localStorage.getItem(REFRESH_KEY) ?? ''; },
  set refresh(v: string) { v ? localStorage.setItem(REFRESH_KEY, v) : localStorage.removeItem(REFRESH_KEY); },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); },
  has(): boolean { return !!this.token; },
};

// 记住账号（自动登录）：localStorage 存 base64(user/password)，仅用户勾选时启用
export const rememberState = {
  get(): { username: string; password: string } | null {
    try {
      const raw = localStorage.getItem('autotest_remember');
      if (!raw) return null;
      const j = JSON.parse(raw) as { u?: string; p?: string };
      if (!j.u || !j.p) return null;
      return { username: decodeURIComponent(escape(atob(j.u))), password: decodeURIComponent(escape(atob(j.p))) };
    } catch { return null; }
  },
  set(username: string, password: string): void {
    try {
      localStorage.setItem('autotest_remember', JSON.stringify({
        u: btoa(unescape(encodeURIComponent(username))),
        p: btoa(unescape(encodeURIComponent(password))),
      }));
    } catch { /* 存储不可用时忽略 */ }
  },
  clear(): void {
    localStorage.removeItem('autotest_remember');
  },
};

// 单飞刷新：并发 401 共享同一次 refresh 调用，防止 refreshToken 旋转导致的误登出风暴
let refreshingPromise: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (!authState.refresh) return Promise.resolve(false);
  refreshingPromise ??= (async () => {
    try {
      const r = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: authState.refresh }),
      });
      if (!r.ok) return false;
      const d = (await r.json()) as { token: string; refreshToken: string };
      authState.token = d.token;
      authState.refresh = d.refreshToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => { refreshingPromise = null; }, 0);
    }
  })();
  return refreshingPromise;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authState.token) headers.Authorization = `Bearer ${authState.token}`;
  const res = await fetch(url, { headers, ...init });
  if (res.status === 401 && authState.refresh && !url.includes('/auth/')) {
    // 自动续期一次（并发请求共享同一次刷新结果）
    const ok = await tryRefresh();
    if (ok) return req<T>(url, init);
    authState.clear();
    try { location.hash = 'login'; } catch { /* noop */ }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean }>(`${API_BASE}/health`),

  // ---- 认证 ----
  login: (username: string, password: string) =>
    req<{ ok: boolean; token: string; refreshToken: string; user: AuthUser }>(`${API_BASE}/auth/login`, {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),
  register: (code: string, username: string, password: string) =>
    req<{ ok: boolean; token: string; refreshToken: string; user: AuthUser }>(`${API_BASE}/auth/register`, {
      method: 'POST', body: JSON.stringify({ code, username, password }),
    }),
  logout: (refreshToken: string) =>
    req<{ ok: boolean }>(`${API_BASE}/auth/logout`, { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  me: () => req<{ ok: boolean; user: AuthUser }>(`${API_BASE}/auth/me`),
  changePassword: (oldPassword: string, newPassword: string) =>
    req<{ ok: boolean }>(`${API_BASE}/auth/password`, { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) }),
  users: () => req<{ ok: boolean; users: Array<Record<string, unknown>> }>(`${API_BASE}/auth/users`),
  createUser: (username: string, password: string, roles: string[]) =>
    req<{ ok: boolean; id: number }>(`${API_BASE}/auth/users`, { method: 'POST', body: JSON.stringify({ username, password, roles }) }),
  setUserRole: (id: number, roles: string[]) =>
    req<{ ok: boolean }>(`${API_BASE}/auth/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ roles }) }),
  setUserStatus: (id: number, status: string) =>
    req<{ ok: boolean }>(`${API_BASE}/auth/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  deleteUser: (id: number) => req<{ ok: boolean }>(`${API_BASE}/auth/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id: number) => req<{ ok: boolean; tempPassword: string }>(`${API_BASE}/auth/users/${id}/reset-password`, { method: 'POST' }),
  invites: () => req<{ ok: boolean; invites: Array<Record<string, unknown>> }>(`${API_BASE}/auth/invites`),
  createInvite: (roleCode: string, expiresDays?: number) =>
    req<{ ok: boolean; code: string }>(`${API_BASE}/auth/invites`, { method: 'POST', body: JSON.stringify({ roleCode, expiresDays }) }),
  revokeInvite: (id: number) => req<{ ok: boolean }>(`${API_BASE}/auth/invites/${id}`, { method: 'DELETE' }),
  keys: () => req<{ ok: boolean; keys: Array<Record<string, unknown>> }>(`${API_BASE}/auth/keys`),
  createKey: (name: string, scopes: string[]) =>
    req<{ ok: boolean; key: string; row: Record<string, unknown> }>(`${API_BASE}/auth/keys`, { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeKey: (id: number) => req<{ ok: boolean }>(`${API_BASE}/auth/keys/${id}`, { method: 'DELETE' }),
  audit: (limit = 50, action = '') => req<{ ok: boolean; rows: Array<Record<string, unknown>> }>(`${API_BASE}/auth/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ''}`),

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
    const headers: Record<string, string> = {};
    if (authState.token) headers.Authorization = `Bearer ${authState.token}`;
    const res = await fetch(`${API_BASE}/analyses/export?${qs}`, { headers });
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
