// 命令/tool 注册表：CLI 与 MCP Server 的**单一事实源**。
//
// 每条 CommandSpec 描述一条平台 API 的 agent 视图；CLI 的 help 树、参数解析、
// MCP 的 tools/list inputSchema 全部由规格生成——加命令 = 加一条数据，不改代码。
//
// 防腐烂：verify:agent-tools 会把每条规格的 method+path 与 dsh-autotest 真实路由表
// 逐一比对（API 演进后规格失效会被当场抓住），详见 scripts/verify-agent-tools.mjs。
import { LocalValidationError } from './envelope.js';
import { COMMANDS } from '../commands/index.js';

export type Role = 'viewer' | 'operator' | 'admin';
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

/** 角色满足判定（admin ≥ operator ≥ viewer，与服务端 auth.ts 同序）。 */
export function roleSatisfies(actual: Role | undefined | null, required: Role): boolean {
  return RANK[actual ?? 'viewer'] >= RANK[required];
}

export type ParamType = 'string' | 'number' | 'boolean' | 'string-array';

export interface ParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  description: string;
  /** CLI flag（不含 --）；缺省用 name 本身（camelCase → --kebab-case 由 CLI 层处理） */
  flag?: string;
  /** CLI 位置参数（按声明顺序取用）；MCP 忽略此字段 */
  positional?: boolean;
  default?: string | number | boolean;
  /** 枚举约束（help 与 inputSchema 展示用） */
  enum?: string[];
}

export interface CommandSpec {
  /** 全名 <group>.<action>，如 libraries.list */
  name: string;
  group: string;
  action: string;
  /** 一行摘要（CLI help 与 MCP tool description 共用） */
  summary: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 平台路由路径（:param 占位，与 api/http.ts 的 route pattern 一致） */
  path: string;
  /** 所需角色（服务端强制；本地预检只为减少无效往返） */
  role: Role;
  /** 危险操作（删除/执行类）：CLI 需 --confirm；MCP 侧由调用方显式确认 */
  dangerous?: boolean;
  /** 查询参数（GET）或 body 字段（写操作） */
  params: ParamSpec[];
  /** 响应是二进制文件（xlsx 等）：CLI 落盘到 --out，MCP 回 base64 */
  binary?: boolean;
  /** 参数名 → body 内点号路径（如 libraryIds → scope.libraryIds）；缺省平铺。
   *  用于服务端读嵌套结构的写操作（plans.create 的 scope）——平铺会静默丢参。 */
  bodyPaths?: Record<string, string>;
}

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

export function allCommands(): CommandSpec[] {
  return [...COMMANDS];
}

export function getCommand(name: string): CommandSpec | undefined {
  return byName.get(name);
}

export function groups(): Array<{ group: string; commands: CommandSpec[] }> {
  const m = new Map<string, CommandSpec[]>();
  for (const c of COMMANDS) {
    if (!m.has(c.group)) m.set(c.group, []);
    m.get(c.group)!.push(c);
  }
  return [...m.entries()].map(([group, commands]) => ({ group, commands }));
}

/** 路径参数名（按出现顺序）。 */
export function pathParams(spec: CommandSpec): string[] {
  return [...spec.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

export interface BuiltRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

/** 按规格类型归一化实参：CLI 传来的一切都是字符串，MCP 可能已是对的类型。
 *  幂等：对已是目标类型的值原样返回（MCP 传 number/boolean/array 不受伤）。 */
function coerce(p: ParamSpec, v: unknown): unknown {
  if (typeof v !== 'string') return v;
  switch (p.type) {
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : v; }
    case 'boolean': return v === 'true' || v === '1';
    case 'string-array': return v.split(',').map((s) => s.trim()).filter(Boolean);
    default: return v;
  }
}

/** 按点号路径写嵌套对象（scope.libraryIds → { scope: { libraryIds } }）。 */
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * 由规格 + 实参构造请求：替换 :param、拼 query（GET）或 body（写）。
 * 必填缺失抛 LocalValidationError（CLI 退出码 2 的来源）。
 */
export function buildRequest(spec: CommandSpec, args: Record<string, unknown>): BuiltRequest {
  const missing: string[] = [];
  for (const p of pathParams(spec)) {
    const v = args[p];
    if (v === undefined || v === '') missing.push(p);
  }
  for (const p of spec.params) {
    const v = args[p.name];
    if (p.required && (v === undefined || v === '')) missing.push(p.name);
  }
  if (missing.length > 0) {
    throw new LocalValidationError(`缺少必填参数：${missing.join(', ')}（参数结构见 tools/list 或 --help ${spec.name}）`);
  }
  let path = spec.path;
  for (const p of pathParams(spec)) {
    path = path.replace(`:${p}`, encodeURIComponent(String(args[p])));
  }
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const p of spec.params) {
    const raw = args[p.name];
    if (raw === undefined || raw === '') continue;
    const v = coerce(p, raw);
    if (spec.method === 'GET') {
      query[p.name] = Array.isArray(v) ? v.join(',') : String(v);
      continue;
    }
    const target = spec.bodyPaths?.[p.name];
    if (target) setPath(body, target, v);
    else body[p.name] = v;
  }
  return { method: spec.method, path, query, body: spec.method === 'GET' ? undefined : body };
}

/** MCP inputSchema（JSON Schema draft-07）：路径参数 + 规格参数自动生成。 */
export function toInputSchema(spec: CommandSpec): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of pathParams(spec)) {
    const intLike = p === 'id' || p.endsWith('Id');
    properties[p] = { type: intLike ? 'integer' : 'string', description: `路径参数 ${p}` };
    required.push(p);
  }
  for (const p of spec.params) {
    properties[p.name] = {
      type: p.type === 'string-array' ? 'array' : p.type === 'number' ? 'integer' : p.type === 'boolean' ? 'boolean' : 'string',
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required };
}

/** MCP tool 描述：摘要 + 角色/危险标记，让调用方 agent 自知边界。 */
export function toToolDescription(spec: CommandSpec): string {
  const tags = [`role:${spec.role}`];
  if (spec.dangerous) tags.push('dangerous（需调用方确认）');
  return `${spec.summary}（${spec.method} ${spec.path}；${tags.join(' · ')}）`;
}
