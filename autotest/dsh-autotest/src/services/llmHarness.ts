// LLM 集成（DSH 版）：复用 ctx.llm（模型配置/Key 全部来自 DSH 设置，无需自建凭据）
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { getSetting } from './settings.js';
import { workspaceDir } from './gitRepo.js';

export interface LlmTextInput {
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
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
let traceHook: ((e: LlmTraceEvent) => void) | null = null;
export function setLlmTraceHook(fn: ((e: LlmTraceEvent) => void) | null): void {
  traceHook = fn;
}

/** 读取 DSH 设置（~/.dsh/settings.yaml）里的 agent-default-model，即 DSH 当前实际默认模型。 */
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

/**
 * 从 ctx.llm 构造一个非流式文本调用：
 *  - 优先使用「系统配置 → 默认模型」（若存在于 DSH 模型列表）
 *  - 未配置时跟随 DSH 实际默认模型（agent-default-model）
 *  - 都没有则用第一个可用模型
 * 确定性执行：只调用选定模型（最多 3 次重试），不跨模型切换。
 */
export function makeLlm(ctx: Context): LlmCall {
  return async (input: LlmTextInput): Promise<LlmResult> => {
    const providers = ctx.llm.listProviders();
    if (!providers || providers.length === 0) {
      throw new Error('DSH 未注册任何模型提供方（如 dsh-llm-deepseek），请检查 profile 配置');
    }
    // 遍历所有 provider 的所有模型（包含 DSH 设置 → 模型 里添加的自定义模型 / 自定义 provider）
    const pairs: Array<{ provider: string; model: string }> = [];
    for (const p of providers) {
      try {
        const list = await ctx.llm.listModels(p.id);
        for (const m of list ?? []) pairs.push({ provider: p.id, model: String(m.id) });
      } catch {
        /* 单个 provider 不可用（如未配置 Key）不阻塞其他 provider */
      }
    }
    const seen = new Set<string>();
    const unique = pairs.filter((x) => {
      const k = `${x.provider}:${x.model}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length === 0) {
      throw new Error('未配置可用模型：请在 DSH 设置（设置 → 模型）中配置模型后重试');
    }
    const defaultModel = String(getSetting('agent.defaultModel', '') || '').trim();
    const dshDefault = readDshDefaultModel();
    const preferred = defaultModel && unique.some((x) => x.model === defaultModel)
      ? unique.find((x) => x.model === defaultModel)!
      : dshDefault && unique.some((x) => x.provider === dshDefault.provider && x.model === dshDefault.model)
        ? { provider: dshDefault.provider, model: dshDefault.model }
        : unique[0];
    let lastErr: unknown = new Error('LLM 返回为空');
    const t0 = Date.now();
    let tokensIn = 0;
    let tokensOut = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[dsh-autotest] llm call: provider=${preferred.provider} model=${preferred.model} attempt=${attempt + 1}`);
        let text = '';
        for await (const chunk of ctx.llm.stream({
          provider: preferred.provider,
          model: preferred.model,
          system: input.system,
          messages: [createUserMessage({ content: [{ type: 'text', text: input.user }], source: { kind: 'user' } })],
          temperature: input.temperature ?? 0.4,
          maxTokens: input.maxTokens ?? 2048,
          signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
        })) {
          if (chunk.type === 'text-delta') text += chunk.text;
          if (chunk.type === 'usage') {
            tokensIn += chunk.usage.inputTokens ?? 0;
            tokensOut += chunk.usage.outputTokens ?? 0;
          }
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            throw new Error(chunk.reason.failure?.message ?? 'LLM 调用失败');
          }
        }
        if (text.trim()) {
          const latencyMs = Date.now() - t0;
          const toksIn = tokensIn || undefined;
          const toksOut = tokensOut || undefined;
          traceHook?.({
            taskId: input.meta?.taskId,
            spanId: input.meta?.spanId,
            kind: input.meta?.kind ?? 'llm_call',
            provider: preferred.provider,
            model: preferred.model,
            latencyMs,
            attempts: attempt + 1,
            tokensIn: toksIn,
            tokensOut: toksOut,
            promptChars: (input.system?.length ?? 0) + input.user.length,
            outputChars: text.length,
            status: 'ok',
          });
          return { text, provider: preferred.provider, model: preferred.model, latencyMs, attempts: attempt + 1, tokensIn: toksIn, tokensOut: toksOut, taskId: input.meta?.taskId, spanId: input.meta?.spanId, kind: input.meta?.kind };
        }
        lastErr = new Error('LLM 返回为空');
      } catch (e) {
        lastErr = e;
      }
    }
    traceHook?.({
      taskId: input.meta?.taskId,
      spanId: input.meta?.spanId,
      kind: input.meta?.kind ?? 'llm_call',
      provider: preferred.provider,
      model: preferred.model,
      latencyMs: Date.now() - t0,
      attempts: 3,
      promptChars: (input.system?.length ?? 0) + input.user.length,
      outputChars: 0,
      status: 'error',
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    throw new Error(`模型 ${preferred.provider}/${preferred.model} 连续失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };
}

/** 原始 LLM 输出落盘（extractJson 彻底失败时），路径跟随 workspace，不写死绝对路径。 */
export function writeRawPayload(text: string): void {
  try {
    const dir = workspaceDir();
    const file = `${dir}/llm-raw.json`;
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
 */
export async function llmJson<T>(
  llm: LlmCall,
  input: LlmTextInput,
  opts: { retries?: number } = {},
): Promise<LlmJsonResult<T>> {
  const retries = Math.max(0, Math.min(2, opts.retries ?? 1));
  let first: LlmResult | null = null;
  for (let i = 0; i <= retries; i++) {
    const attemptInput = i === 0
      ? { ...input, user: jsonDirective(input.user) }
      : {
          ...input,
          user: `上次模型输出不是合法 JSON，解析失败原因：${(firstErr?.message ?? '未知').slice(0, 300)}\n\n请只输出修复后的纯 JSON（对象或数组），不要任何解释、围栏、注释。\n\n原始任务：${input.user.slice(0, 3000)}`,
        };
    const res = await llm(attemptInput);
    first = res;
    try {
      const data = extractJson<T>(res.text);
      return { data, text: res.text, provider: res.provider, model: res.model };
    } catch (e) {
      firstErr = e instanceof Error ? e : new Error(String(e));
      writeRawPayload(res.text);
    }
  }
  throw new Error(`JSON 解析失败（已回灌修复 ${retries} 次）：${firstErr?.message ?? '未知'}`);
}

let firstErr: Error | null = null;

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
        console.error('[llmHarness] extractJson failed:', (finalErr as Error).message);
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
        else if (ch === '}') {
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
    if (ch === '\\') { out += ch; esc = true; continue; }
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
