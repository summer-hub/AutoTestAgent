// P10：Agent 绑定与替换 —— 让"用哪个 agent 实现某个阶段"变成可切换、可追溯的配置。
//
// 动机来自你的要求：**全部以内置 agent 完成，或让用户自写 agent，所以要有 agent 绑定/换 agent 功能。**
//
// 关键设计（设计 §8.1）：**阶段即接口**。每个 stage 的输入输出是结构化约定，
// 与"用哪个 agent 实现"解耦：
//   - 内置 agent = 随插件发布的 prompt（role 与 stage 一一对应）
//   - 自写 agent = 「Prompt 管理」里自建模板，或 skills/ 下的 SKILL.md
//   - 外部 agent = 命令行/HTTP（如 devecocli、deveco-code），走同一份输入输出约定
//
// 一条纪律：**绑定必须可追溯**。历史任务要能回答"这条用例是哪个 agent 生成的"，
// 所以每次运行都会把当时的生效绑定写进任务轨迹。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';

export type AgentKind = 'builtin' | 'prompt' | 'skill' | 'external';

export const AGENT_KIND_LABEL: Record<AgentKind, string> = {
  builtin: '内置 Agent', prompt: '自写 Prompt', skill: '自写 Skill', external: '外部 Agent',
};

export interface StageDef {
  stage: string;
  /** 面向人的名字 */
  label: string;
  /** 内置 prompt 的 role（与 prompts 表对应） */
  builtinRole: string;
  /** 输入约定（人读 + 外部 agent 契约共用） */
  input: string;
  /** 输出约定（Schema 名） */
  output: string;
  /** 该阶段可用的知识种类（P9 注入用，见设计 §7.5） */
  knowledgeKinds: string[];
  knowledgeBudget: number;
}

/**
 * 阶段清单（设计 §8.1）。外部 agent 也按这份约定接，避免为每个工具写适配。
 */
export const STAGES: StageDef[] = [
  { stage: 'api_extract', label: '接口面提取', builtinRole: '接口提取', input: '仓库路径 / HAR 产物路径', output: 'ApiSymbol[]', knowledgeKinds: [], knowledgeBudget: 0 },
  { stage: 'demo_parse', label: 'demo 资产解析', builtinRole: 'demo 解析', input: 'demo 工程路径', output: 'DemoAsset[]', knowledgeKinds: [], knowledgeBudget: 0 },
  { stage: 'matrix_build', label: '覆盖矩阵构建', builtinRole: '覆盖矩阵', input: 'symbols + assets + 遍历报告', output: 'MatrixRow[]', knowledgeKinds: ['traversal_quirk'], knowledgeBudget: 800 },
  { stage: 'case_draft', label: '用例生成（四类场景）', builtinRole: '用例生成', input: '矩阵切片（接口 + 场景 + 页面 + 控件）', output: 'DraftCase[]（含 scenario_kind、oracle、priority）', knowledgeKinds: ['oracle_recipe', 'demo_patch'], knowledgeBudget: 1500 },
  { stage: 'case_optimize', label: '用例优化（补缺）', builtinRole: '用例优化', input: '现有用例 + 未覆盖项 + oracle 规则', output: 'DraftCase[]（改写 + 新增）', knowledgeKinds: ['oracle_recipe', 'demo_patch', 'human_verdict'], knowledgeBudget: 1500 },
  { stage: 'testability', label: '可测性判定', builtinRole: '可测性判定', input: '用例 + demo 资产', output: 'TestabilityVerdict（A/B/C/D + 理由）', knowledgeKinds: ['blocked_reason'], knowledgeBudget: 800 },
  { stage: 'demo_patch', label: 'demo 补丁草案', builtinRole: 'demo 补丁', input: 'C 类判定 + demo 源码 + 接口签名', output: 'PatchDraft[]', knowledgeKinds: ['demo_patch', 'special_handling'], knowledgeBudget: 1200 },
  { stage: 'triage', label: '可行性分流', builtinRole: '可行性分流', input: '用例 + 判定规则', output: 'Auto|Manual + 阻塞类别', knowledgeKinds: ['blocked_reason', 'special_handling'], knowledgeBudget: 800 },
  { stage: 'script_gen', label: '脚本生成', builtinRole: '脚本生成', input: '用例 + oracle + 句式契约', output: 'Hypium 脚本 + 映射记录', knowledgeKinds: ['oracle_recipe'], knowledgeBudget: 1200 },
];

export function stageDef(stage: string): StageDef | undefined {
  return STAGES.find((s) => s.stage === stage);
}

export interface ResolvedBinding {
  stage: string;
  kind: AgentKind;
  /** 生效来源说明（人读；可追溯） */
  source: string;
  scope: 'global' | 'library' | 'default';
  libraryId: number | null;
  promptId: number | null;
  skillPath: string;
  model: string;
  params: Record<string, unknown>;
  externalCmd: string;
}

/**
 * 解析某个阶段在某库下**实际生效**的绑定。
 *
 * 优先级：按库绑定 > 全局绑定 > 内置默认。
 * 这样"默认全用内置、个别库换自写 agent"是最省事的用法，也支持全局替换。
 */
export async function resolveBinding(stage: string, libraryId?: number | null): Promise<ResolvedBinding> {
  const db = getDb();
  const def = stageDef(stage);
  const rows = await db.prepare(`SELECT * FROM agent_bindings WHERE stage = ? AND enabled = 1
    AND ((scope = 'library' AND library_id = ?) OR scope = 'global') ORDER BY (scope = 'library') DESC, id DESC`)
    .all<Record<string, unknown>>(stage, libraryId ?? null);
  const hit = rows[0];
  if (hit) {
    return {
      stage,
      kind: String(hit.kind ?? 'prompt') as AgentKind,
      source: hit.scope === 'library' ? `按库绑定（库 #${String(hit.library_id)}）` : '全局绑定',
      scope: String(hit.scope) === 'library' ? 'library' : 'global',
      libraryId: hit.library_id === null || hit.library_id === undefined ? null : Number(hit.library_id),
      promptId: hit.prompt_id === null || hit.prompt_id === undefined ? null : Number(hit.prompt_id),
      skillPath: String(hit.skill_path ?? ''),
      model: String(hit.model ?? ''),
      params: (() => { try { return JSON.parse(String(hit.params_json || '{}')) as Record<string, unknown>; } catch { return {}; } })(),
      externalCmd: String(hit.external_cmd ?? ''),
    };
  }
  return {
    stage, kind: 'builtin', source: `内置默认（${def?.builtinRole ?? stage}）`,
    scope: 'default', libraryId: null, promptId: null, skillPath: '',
    model: String(getSetting('agent.defaultModel', '') || ''), params: {}, externalCmd: '',
  };
}

/** 全部阶段的生效绑定（Agent 绑定页用）。 */
export async function listResolvedBindings(libraryId?: number | null): Promise<Array<ResolvedBinding & { def: StageDef; raw: Record<string, unknown> | null }>> {
  const db = getDb();
  const raw = await db.prepare('SELECT * FROM agent_bindings ORDER BY stage, scope').all<Record<string, unknown>>();
  return Promise.all(STAGES.map(async (def) => ({
    ...(await resolveBinding(def.stage, libraryId)),
    def,
    raw: raw.find((r) => r.stage === def.stage && (libraryId ? (String(r.scope) === 'library' && Number(r.library_id) === libraryId) : String(r.scope) === 'global'))
      ?? raw.find((r) => r.stage === def.stage && String(r.scope) === 'global') ?? null,
  })));
}

/** 写入/更新绑定（切换即生效：下一次任务就按新绑定跑）。 */
export async function upsertBinding(b: {
  stage: string; scope: 'global' | 'library'; libraryId?: number | null; kind: AgentKind;
  promptId?: number | null; skillPath?: string; model?: string; params?: Record<string, unknown>;
  externalCmd?: string; enabled?: boolean;
}): Promise<ResolvedBinding> {
  if (!stageDef(b.stage)) throw Object.assign(new Error(`未知阶段：${b.stage}（可用阶段见 /agent/stages）`), { statusCode: 400 });
  if (b.scope === 'library' && !b.libraryId) throw Object.assign(new Error('按库绑定必须指定 libraryId'), { statusCode: 400 });
  if (b.kind === 'skill' && !String(b.skillPath ?? '').trim()) throw Object.assign(new Error('绑定 Skill 必须给出 skillPath'), { statusCode: 400 });
  if (b.kind === 'prompt' && !b.promptId) throw Object.assign(new Error('绑定自写 Prompt 必须给出 promptId'), { statusCode: 400 });
  if (b.kind === 'external' && !String(b.externalCmd ?? '').trim()) throw Object.assign(new Error('绑定外部 Agent 必须给出 externalCmd'), { statusCode: 400 });

  const db = getDb();
  const t = now();
  const existing = await db.prepare('SELECT id FROM agent_bindings WHERE stage = ? AND scope = ? AND library_id IS ?')
    .get<{ id: number }>(b.stage, b.scope, b.scope === 'library' ? b.libraryId ?? null : null);
  const params = JSON.stringify(b.params ?? {});
  const enabled = b.enabled === false ? 0 : 1;
  if (existing) {
    await db.prepare(`UPDATE agent_bindings SET prompt_id = ?, skill_path = ?, model = ?, params_json = ?, kind = ?, external_cmd = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .run(b.promptId ?? null, String(b.skillPath ?? ''), String(b.model ?? ''), params, b.kind, String(b.externalCmd ?? ''), enabled, t, existing.id);
  } else {
    await db.prepare(`INSERT INTO agent_bindings (stage, scope, library_id, prompt_id, skill_path, model, params_json, kind, external_cmd, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.stage, b.scope, b.scope === 'library' ? b.libraryId ?? null : null, b.promptId ?? null,
        String(b.skillPath ?? ''), String(b.model ?? ''), params, b.kind, String(b.externalCmd ?? ''), enabled, t, t);
  }
  return resolveBinding(b.stage, b.libraryId ?? null);
}

/** 删除绑定（回到上一级默认）。 */
export async function deleteBinding(id: number): Promise<{ ok: boolean }> {
  const r = await getDb().prepare('DELETE FROM agent_bindings WHERE id = ?').run(id);
  return { ok: (r.changes ?? 0) > 0 };
}

/** 把生效绑定写进任务轨迹（可追溯：这条用例是哪个 agent 生成的）。 */
export function bindingTraceLine(b: ResolvedBinding): string {
  const parts = [`阶段 ${b.stage}`, `来源 ${b.source}`, `实现 ${AGENT_KIND_LABEL[b.kind]}`];
  if (b.promptId) parts.push(`prompt #${b.promptId}`);
  if (b.skillPath) parts.push(`skill ${b.skillPath}`);
  if (b.model) parts.push(`model ${b.model}`);
  if (b.externalCmd) parts.push(`cmd ${b.externalCmd}`);
  const keys = Object.keys(b.params);
  if (keys.length > 0) parts.push(`params ${JSON.stringify(b.params)}`);
  return parts.join(' · ');
}

// ---------- 外部 agent（命令行适配 + 最小 MCP 服务端） ----------

/** 外部 agent 的可用性探测（不实际调用，只看命令是否存在）。 */
export function externalCmdAvailable(cmd: string): { available: boolean; reason: string } {
  const first = String(cmd).trim().split(/\s+/)[0];
  if (!first) return { available: false, reason: '未配置命令' };
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try { if (d && fs.existsSync(path.join(d, first + ext))) return { available: true, reason: `${path.join(d, first + ext)}` }; } catch { /* 忽略 */ }
    }
  }
  return { available: false, reason: `在 PATH 中找不到可执行文件 ${first}` };
}

/** MCP 工具清单：把平台能力暴露给外部 agent（设计 §8.4）。 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function mcpTools(): McpTool[] {
  const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object', properties: props, required, additionalProperties: false,
  });
  return [
    {
      name: 'autotest.api_symbols',
      description: '读取某库的导出接口清单（P2 产物：符号/签名/参数/方法）',
      inputSchema: obj({ libraryId: { type: 'number', description: '库 id' }, version: { type: 'string' } }, ['libraryId']),
    },
    {
      name: 'autotest.coverage_matrix',
      description: '读取某库的覆盖矩阵（P3 产物：每个符号的覆盖状态、判定理由、风险）',
      inputSchema: obj({ libraryId: { type: 'number' }, status: { type: 'string', enum: ['covered', 'partial', 'not_covered', 'blocked'] } }, ['libraryId']),
    },
    {
      name: 'autotest.case_read',
      description: '按库读取手工用例（含场景维度、可测性判定、oracle）',
      inputSchema: obj({ libraryId: { type: 'number' }, libraryName: { type: 'string' }, limit: { type: 'number' } }),
    },
    {
      name: 'autotest.case_write',
      description: '写入一条用例（必须带 oracles，否则拒绝 —— 断言为空的用例是假通过）',
      inputSchema: obj({
        libraryId: { type: 'number' }, name: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } },
        expected: { type: 'string' }, scenarioKind: { type: 'string' }, oracles: { type: 'array', items: { type: 'object' } },
      }, ['libraryId', 'name', 'steps', 'oracles']),
    },
    {
      name: 'autotest.knowledge_retrieve',
      description: '检索项目知识库（LLM wiki，无向量：作用域键 + 关键词）',
      inputSchema: obj({ library: { type: 'string' }, apiName: { type: 'string' }, scenarioKind: { type: 'string' }, budgetChars: { type: 'number' } }),
    },
    {
      name: 'autotest.human_queue',
      description: '读取人工接管队列（自动跑不了的用例及其阻塞原因）',
      inputSchema: obj({ libraryId: { type: 'number' }, status: { type: 'string' } }, ['libraryId']),
    },
    {
      name: 'autotest.quality',
      description: '读取质量硬门槛状态（断言覆盖率 / 假通过数）',
      inputSchema: obj({ libraryId: { type: 'number' } }, ['libraryId']),
    },
  ];
}

/** JSON-RPC 2.0 错误码（MCP 基于 JSON-RPC）。 */
export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** 构造 JSON-RPC 响应（纯函数，便于自检）。 */
export function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
export function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** MCP initialize 的结果（最小实现：协议版本 + 能力 + 服务信息）。 */
export function mcpInitializeResult(): Record<string, unknown> {
  return {
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'dsh-autotest', version: '0.1.0' },
    instructions: '本服务暴露鸿蒙三方库测试流水线的只读查询与用例写入能力。所有写入都会过 oracle 校验（断言为空一律拒绝）。',
  };
}
