// LLM 集成（DSH 版）：复用 ctx.llm（模型配置/Key 全部来自 DSH 设置，无需自建凭据）
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { writeFileSync } from 'node:fs';

export interface LlmTextInput {
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type LlmCall = (input: LlmTextInput) => Promise<string>;

/** 从 ctx.llm 构造一个非流式文本调用（优先默认 provider，取该 provider 首个模型） */
export function makeLlm(ctx: Context): LlmCall {
  return async (input: LlmTextInput): Promise<string> => {
    const providers = ctx.llm.listProviders();
    if (!providers || providers.length === 0) {
      throw new Error('DSH 未注册任何模型提供方（如 dsh-llm-deepseek），请检查 profile 配置');
    }
    const provider = providers[0].id;
    let models: string[] = [];
    try {
      const list = await ctx.llm.listModels(provider);
      models = (list ?? []).map((m) => m.id);
    } catch {
      /* 部分适配器不实现 listModels，走默认模型 */
    }
    if (models.length === 0) {
      throw new Error('未配置可用模型：请在 DSH 设置（设置 → 模型）中配置模型后重试');
    }
    let lastErr: unknown = new Error('LLM 返回为空');
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          console.log(`[dsh-autotest] llm call: provider=${provider} model=${model} attempt=${attempt + 1}`);
          let text = '';
          for await (const chunk of ctx.llm.stream({
            provider,
            model,
            system: input.system,
            messages: [createUserMessage({ content: [{ type: 'text', text: input.user }], source: { kind: 'user' } })],
            temperature: input.temperature ?? 0.4,
            maxTokens: input.maxTokens ?? 2048,
            signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
          })) {
            if (chunk.type === 'text-delta') text += chunk.text;
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              throw new Error(chunk.reason.failure?.message ?? 'LLM 调用失败');
            }
          }
          if (text.trim()) return text;
          lastErr = new Error('LLM 返回为空');
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
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
        try {
          writeFileSync('D:/code/HarmonyProject/20260604/AutoTestAgent/autotest/dsh-autotest/data/llm-raw.json', t, 'utf8');
        } catch { /* 落盘失败不阻塞 */ }
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
