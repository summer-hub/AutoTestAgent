// 输出纪律（对齐 octo-cli 的 agent 友好契约）——这是整个 agent 接口层的地基：
//   1. 成功 → 单个 JSON 对象写 stdout（--pretty 时缩进）；
//   2. 失败 → 错误 JSON 写 stderr，进程以**确定性退出码**结束；
//   3. 零交互：不读 stdin、不弹提示、不依赖 TTY。
// 调用方（agent runtime）据此可机械判定成败并分支，不需要解析人类文本。

/** 确定性退出码（agent 可分支的依据；文档与 --help 共用）。 */
export const EXIT = {
  OK: 0,
  /** 本地校验失败：请求未发出（命令不存在 / 参数缺失 / 组合非法） */
  LOCAL_VALIDATION: 2,
  /** 服务端拒绝：业务错误（403 权限不足 / 404 / 409 审批中 / 5xx） */
  REJECTED: 3,
  /** 认证失败：401 / 令牌缺失或无效 */
  UNAUTHORIZED: 4,
  /** 传输失败：网络不可达 / 超时 / 响应非 JSON */
  TRANSPORT: 5,
} as const;

/** 机器可读错误分类码（与退出码对应的标签）。 */
export type ErrorCode =
  | 'UNKNOWN_COMMAND' | 'LOCAL_VALIDATION'
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'APPROVAL_REQUIRED'
  | 'BUSINESS_ERROR' | 'SERVER_ERROR'
  | 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE';

export interface OkEnvelope<T = unknown> {
  ok: true;
  command: string;
  data: T;
  meta: {
    url: string;
    durationMs: number;
  };
}

export interface ErrEnvelope {
  ok: false;
  command: string;
  error: {
    code: ErrorCode;
    message: string;
    statusCode?: number;
    hint?: string;
  };
}

/** 本地校验错误（参数缺/组合非法）：未发出请求，退出码 2。 */
export class LocalValidationError extends Error {
  readonly code = 'LOCAL_VALIDATION' as const;
  readonly statusCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'LocalValidationError';
  }
}

/** 服务端/传输错误：携带 HTTP 状态与分类码（0 = 传输层，无 HTTP 状态）。 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface OutputOpts {
  pretty?: boolean;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export function emitOk<T>(command: string, data: T, meta: OkEnvelope<T>['meta'], opts: OutputOpts = {}): void {
  const env: OkEnvelope<T> = { ok: true, command, data, meta };
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  out(`${JSON.stringify(env, null, opts.pretty ? 2 : undefined)}\n`);
}

export function emitErr(command: string, error: ErrEnvelope['error'], opts: OutputOpts = {}): void {
  const env: ErrEnvelope = { ok: false, command, error };
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  err(`${JSON.stringify(env, null, opts.pretty ? 2 : undefined)}\n`);
}

/** 退出码表（--help 与文档共用，单一出处）。 */
export const EXIT_TABLE: Array<{ code: number; name: string; when: string }> = [
  { code: EXIT.OK, name: 'OK', when: '成功' },
  { code: EXIT.LOCAL_VALIDATION, name: 'LOCAL_VALIDATION', when: '本地校验失败（命令不存在/参数缺失/组合非法），请求未发出' },
  { code: EXIT.REJECTED, name: 'REJECTED', when: '服务端业务拒绝（403 权限不足 / 404 不存在 / 409 审批中 / 5xx 服务端错误）' },
  { code: EXIT.UNAUTHORIZED, name: 'UNAUTHORIZED', when: '认证失败（401 或令牌缺失/无效）' },
  { code: EXIT.TRANSPORT, name: 'TRANSPORT', when: '传输失败（网络不可达 / 超时 / 响应非 JSON）' },
];

/** ApiError → 进程退出码（CLI 与 MCP 共用的映射）。 */
export function exitCodeFor(err: ApiError): number {
  switch (err.code) {
    case 'UNAUTHORIZED': return EXIT.UNAUTHORIZED;
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'BAD_RESPONSE': return EXIT.TRANSPORT;
    default: return EXIT.REJECTED;
  }
}
