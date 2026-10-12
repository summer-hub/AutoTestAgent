// LLM 调用核心（无框架依赖）：类型 / 统一埋点 / JSON 容错解析 / 取消信号合并。
//
// 这个文件是**双入口共用的地基**：
//  - DSH 插件入口（index.ts → llmHarness.makeLlm）复用它；
//  - 独立服务器入口（standalone.ts → llmDirect.makeDirectLlm）也复用它。
// 因此这里禁止 import 任何 @deepseek-ai/* 包（否则独立版不装 DSH 就跑不起来）。
// DSH 专属的 makeLlm(ctx) 留在 llmHarness.ts；直连 models 表的实现在 llmDirect.ts。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { workspaceDir } from './gitRepo.js';

/**
 * 读取 DSH 设置（~/.dsh/settings.yaml）里的 agent-default-model，即 DSH 当前实际默认模型。
 * 文件不存在 / 未安装 DSH 时返回 null——独立版没有 DSH，这个函数就是天然返回 null 的兜底，
 * 所以放这里（而非 llmHarness.ts）：否则任何 import 它的模块都会把 @deepseek-ai/dsh-llm
 * 拖进运行时依赖链（http.ts → llmHarness → dsh-llm），独立服务器直接起不来。
 */
export function readDshDefaultModel(): { provider: string; model: string } | null {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'settings.yaml');
  if (!fs.existsSync(file)) return null;
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const block = txt.match(/agent-default-model:\s*\n((?:\s+[^\n]*\n?)*)/);
    if (!block) return null;
    const provider = block[1].match(/provider:\s*["']?([^\s"']+)/)?.[1] ?? '';
    const model = block[1].match(/model:\s*["']?([^\s"']+)/)?.[1] ?? '';
    return provider && model ? { provider, model } : null;
  } catch {
    return null;
  }
}

export interface LlmTextInput {
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 任务级取消信号（任务 lane 的 AbortController）：触发后立即放弃，不再重试 */
  signal?: AbortSignal;
  meta?: { taskId?: number; spanId?: string; kind?: string };
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  attempts: number;
  tokensIn?: number;
  tokensOut?: number;
  taskId?: number;
  spanId?: string;
  kind?: string;
}

export type LlmCall = (input: LlmTextInput) => Promise<LlmResult>;

export interface LlmJsonResult<T> {
  data: T;
  text: string;
  provider: string;
  model: string;
}

/** 统一埋点钩子（agent_events 表写入由 events.ts 注入，避免循环依赖）。 */
export interface LlmTraceEvent {
  taskId?: number;
  spanId?: string;
  kind: string;
  provider: string;
  model: string;
  latencyMs: number;
  attempts: number;
  tokensIn?: number;
  tokensOut?: number;
  promptChars: number;
  outputChars: number;
  status: 'ok' | 'error';
  error?: string;
}
// 埋点消费者支持多个：events.ts 的链路追踪（setLlmTraceHook 覆盖式设置）与
// metrics 的指标埋点（addLlmTraceHook 追加式）并存，互不覆盖；
// 单个消费者异常被隔离，不影响其他消费者与 LLM 业务本身。
const traceHooks: Array<(e: LlmTraceEvent) => void> = [];
export function setLlmTraceHook(fn: ((e: LlmTraceEvent) => void) | null): void {
  traceHooks.length = 0;
  if (fn) traceHooks.push(fn);
}
/** 追加一个埋点消费者（不清空既有消费者）。 */
export function addLlmTraceHook(fn: (e: LlmTraceEvent) => void): void {
  traceHooks.push(fn);
}

/** 发一条 LLM 埋点（无消费者时静默）。 */
export function emitLlmTrace(e: LlmTraceEvent): void {
  for (const h of traceHooks) {
    try { h(e); } catch { /* 消费者异常隔离 */ }
  }
}

/**
 * 合并「调用方取消信号」与「单次调用超时」：任一触发即中断。
 * AbortSignal.any 需 Node 20.3+，低版本退化为手动级联（本项目已用 AbortSignal.timeout，
 * 运行环境不会低于 Node 18，这里只是兜底）。
 */
export function combineSignals(taskSignal: AbortSignal, timeout: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([taskSignal, timeout]);
  const c = new AbortController();
  const onAbort = (): void => c.abort();
  taskSignal.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  return c.signal;
}

/**
 * 原始 LLM 输出落盘（extractJson 彻底失败时），路径跟随 workspace，不写死绝对路径。
 * tag 用于区分调用来源：并发分片同时解析失败时，若都写同一个文件只会留下最后一次，
 * 前面几次的原始输出（排查解析问题唯一的一手证据）就被覆盖掉了。
 */
export function writeRawPayload(text: string, tag?: string): void {
  try {
    const dir = workspaceDir();
    const suffix = tag ? `-${String(tag).replace(/[^\w.-]/g, '_')}` : '';
    const file = `${dir}/llm-raw${suffix}.json`;
    writeFileSync(file, text, 'utf8');
  } catch { /* 落盘失败不阻塞 */ }
}

/** JSON 指令后缀（严格输出，配合 llmJson 的解析失败回灌修复）。 */
function jsonDirective(prompt: string): string {
  return `${prompt}\n\n严格只输出一个 JSON（对象或数组），不要 markdown 围栏、不要前后解释、不要注释。首个非空白字符必须是 { 或 [。`;
}

/**
 * 结构化输出三保险：严格 JSON 指令 → extractJson 容错 → 解析失败把错误回灌 LLM 修复一次。
 * 相比裸 extractJson，二次回灌让模型看到"哪里解析失败"，显著提升结构可靠性。
 *
 * 注意：解析错误必须保存在**本次调用的局部变量**里。
 * 这里曾是模块级 `let firstErr`，而分片生成是并发的（agent.genShardConcurrency 默认 3），
 * 于是各分片会互相把对方的错误塞进自己的修复提示；且上一次调用的错误会残留到下一次。
 * 这与已经修掉的全局 lastLlmCall 是同一类问题，别再改回全局。
 */
export async function llmJson<T>(
  llm: LlmCall,
  input: LlmTextInput,
  opts: { retries?: number } = {},
): Promise<LlmJsonResult<T>> {
  const retries = Math.max(0, Math.min(2, opts.retries ?? 1));
  let lastParseErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    const attemptInput = i === 0
      ? { ...input, user: jsonDirective(input.user) }
      : {
          ...input,
          user: `上次模型输出不是合法 JSON，解析失败原因：${(lastParseErr?.message ?? '未知').slice(0, 300)}\n\n请只输出修复后的纯 JSON（对象或数组），不要任何解释、围栏、注释。\n\n原始任务：${input.user.slice(0, 3000)}`,
        };
    const res = await llm(attemptInput);
    try {
      const data = extractJson<T>(res.text);
      return { data, text: res.text, provider: res.provider, model: res.model };
    } catch (e) {
      lastParseErr = e instanceof Error ? e : new Error(String(e));
      // 落盘文件名带上调用方标识，避免并发分片互相覆盖同一份原始输出
      writeRawPayload(res.text, input.meta?.kind);
    }
  }
  throw new Error(`JSON 解析失败（已回灌修复 ${retries} 次）：${lastParseErr?.message ?? '未知'}`);
}

/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后杂文） */
export function extractJson<T>(text: string): T {
  const raw = text.trim();
  let t = raw;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  if (t.startsWith('[')) {
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  } else {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    // 常见模型输出瑕疵：字符串内含原始换行/制表符、尾逗号 → 尝试修复后重解析
    const repaired = repairJson(t);
    try {
      return JSON.parse(repaired) as T;
    } catch {
      const noTrailingComma = repaired.replace(/,(\s*[}\]])/g, '$1');
      try {
        return JSON.parse(noTrailingComma) as T;
      } catch (finalErr) {
        // 兜底：多个连续 JSON 对象（无数组包裹，模型常见输出）→ 自动包装为数组
        const objects = extractTopLevelObjects(t);
        if (objects.length > 0) {
          return (objects.length === 1 ? objects[0] : objects) as T;
        }
        writeRawPayload(t);
        console.error('[llmCore] extractJson failed:', (finalErr as Error).message);
        throw finalErr;
      }
    }
  }
}

/** 扫描文本中所有顶层 JSON 对象（容忍对象间任意分隔文本）。 */
function extractTopLevelObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
    }
    if (end < 0) {
      // 该对象未闭合（如外层容器被截断）→ 跳过起点，继续收集内部完整对象
      i = start + 1;
      continue;
    }
    try {
      out.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      /* 单个对象解析失败则跳过 */
    }
    i = end + 1;
  }
  return out;
}

/** 修复字符串内的原始控制字符（换行/回车/制表符），使其成为合法 JSON。 */
function repairJson(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    }
    out += ch;
  }
  return out;
}
