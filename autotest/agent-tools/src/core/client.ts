// REST 客户端：Bearer 鉴权 + 超时 + 错误归一。
// 所有服务端错误信封（{ error, message, statusCode }）统一归类为 ApiError，
// 携带确定性分类码——上层（CLI/MCP）只认分类码，不猜 HTTP 语义。
import { ApiError, type ErrorCode } from './envelope.js';

export interface ClientOptions {
  /** API 基地址，如 http://127.0.0.1:3280/api/autotest */
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** 测试注入用；默认全局 fetch（Node ≥20 内置） */
  fetchImpl?: typeof fetch;
}

export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface RequestResult<T> {
  data: T;
  url: string;
  durationMs: number;
  statusCode: number;
  /** 二进制响应（xlsx 等）：data 为 Buffer，filename 取自 Content-Disposition */
  binary?: boolean;
  filename?: string;
}

/** 服务端 4xx/5xx → 确定性错误码。409 特判：审批待批是本平台的一等公民状态。 */
function classify(status: number, body: { error?: string; message?: string } | null): { code: ErrorCode; message: string } {
  const msg = body?.message || body?.error || `HTTP ${status}`;
  if (status === 401) return { code: 'UNAUTHORIZED', message: msg };
  if (status === 403) return { code: 'FORBIDDEN', message: msg };
  if (status === 404) return { code: 'NOT_FOUND', message: msg };
  if (status === 409) return { code: 'APPROVAL_REQUIRED', message: msg };
  if (status >= 500) return { code: 'SERVER_ERROR', message: msg };
  return { code: 'BUSINESS_ERROR', message: msg };
}

/** 发一次 API 请求并归一化结果/错误。传输层失败抛 ApiError（statusCode=0）。 */
export async function apiRequest<T = unknown>(
  client: ClientOptions,
  req: RequestSpec,
): Promise<RequestResult<T>> {
  const f = client.fetchImpl ?? fetch;
  const url = new URL(client.baseUrl.replace(/\/+$/, '') + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  if (client.token) headers.Authorization = `Bearer ${client.token}`;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await f(url.toString(), {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(client.timeoutMs ?? 30_000),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', `请求超时（${client.timeoutMs ?? 30_000}ms）：${url}`);
    }
    throw new ApiError(0, 'NETWORK_ERROR', `网络错误：${err.message}（${url}）`);
  }
  const durationMs = Date.now() - t0;

  // 二进制响应（xlsx 导出等）：成功 + 非 JSON content-type → 原样回 Buffer + 文件名
  const contentType = res.headers.get('content-type') ?? '';
  if (res.ok && /octet-stream|openxmlformats|spreadsheet/i.test(contentType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    const fn = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    return { data: buf as unknown as T, url: url.toString(), durationMs, statusCode: res.status, binary: true, filename: fn };
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `响应不是合法 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const { code, message } = classify(res.status, json as { error?: string; message?: string } | null);
    throw new ApiError(res.status, code, message);
  }
  return { data: json as T, url: url.toString(), durationMs, statusCode: res.status };
}

/** 基地址与令牌的解析（CLI 参数 > 环境变量 > 默认），单一出处。 */
export function resolveClient(opts: { base?: string; token?: string }): ClientOptions {
  return {
    baseUrl: opts.base || process.env.AUTOTEST_BASE_URL || 'http://127.0.0.1:3280/api/autotest',
    token: opts.token || process.env.AUTOTEST_TOKEN || undefined,
  };
}
