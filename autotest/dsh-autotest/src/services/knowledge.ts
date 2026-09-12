// P9：知识沉淀（LLM wiki）—— 把人工确认过的结论变成下次任务能复用的知识。
//
// 为什么是 wiki 而不是 RAG/向量库（设计 §7.1，也是你的明确要求）：目标机器可能没有显卡，
// 向量方案要么加算力要么加外部 API 依赖。而 markdown + front-matter + 关键词检索：
//   - 零额外硬件，与 Node 同进程；
//   - 命中即命中，能逐字解释"为什么召回这条"（向量是黑盒）；
//   - 一条 = 一个完整结论，人能直接读、直接改；git 原生可 diff/blame/回滚。
//
// 一条纪律：**md 是唯一事实来源**，DB 里的 knowledge_entries 只是索引（由扫描 md 生成）。
// 双写一定会不一致，而知识条目正是最不能悄悄错的东西。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, now } from '../db/connection.js';
import { workspaceDir } from './gitRepo.js';

export type ScopeKind = 'library' | 'api' | 'control' | 'scenario' | 'global';
export type KnowledgeKind = 'traversal_quirk' | 'oracle_recipe' | 'special_handling' | 'blocked_reason' | 'demo_patch' | 'human_verdict';
export type KnowledgeStatus = 'ai_draft' | 'human_confirmed' | 'rejected' | 'deprecated';

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  library: '库级', api: '接口级', control: '控件级', scenario: '场景级', global: '全局',
};
export const KIND_LABEL: Record<KnowledgeKind, string> = {
  traversal_quirk: '遍历怪癖', oracle_recipe: '判据配方', special_handling: '特殊处置',
  blocked_reason: '阻塞原因', demo_patch: 'demo 补丁', human_verdict: '人工结论',
};
export const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  ai_draft: 'AI 草稿（未确认）', human_confirmed: '人工已确认', rejected: '已否决', deprecated: '已过时',
};

export interface KnowledgeEntry {
  id: string;
  scopeKind: ScopeKind;
  scopeKey: string;
  kind: KnowledgeKind;
  title: string;
  keywords: string[];
  status: KnowledgeStatus;
  confidence: number;
  evidence: Array<Record<string, unknown>>;
  /** 正文四段：现象 / 原因 / 处置 / 结论 */
  body: string;
  createdAt: string;
  updatedAt: string;
  /** 相对 workspace/knowledge/wiki 的路径（落盘位置） */
  wikiPath: string;
}

// ---------- 1. front-matter 读写（纯函数） ----------

/** 生成 slug（文件名安全、可读）。 */
export function slugify(title: string): string {
  const s = title
    .replace(/[「」『』【】（）()《》]/g, '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'entry';
}

/** 渲染成 markdown（front-matter + 正文）。 */
export function renderEntry(e: KnowledgeEntry): string {
  const fm = [
    '---',
    `id: ${e.id}`,
    `scope_kind: ${e.scopeKind}`,
    `scope_key: ${e.scopeKey}`,
    `kind: ${e.kind}`,
    `title: ${e.title}`,
    `keywords: ${e.keywords.join(' ')}`,
    `status: ${e.status}`,
    `confidence: ${e.confidence}`,
    'evidence:',
    ...(e.evidence.length > 0 ? e.evidence.map((v) => `  - ${JSON.stringify(v)}`) : ['  - {}']),
    `created_at: ${e.createdAt}`,
    `updated_at: ${e.updatedAt}`,
    '---',
    '',
  ];
  return fm.join('\n') + (e.body.trim() ? `${e.body.trim()}\n` : '');
}

/**
 * 解析 markdown → 条目。**解析失败返回 null 而不是抛错**：
 * 知识目录里可能有半成品/手写笔记，一条坏文件不该让整个知识库读不出来。
 */
export function parseEntry(md: string): Omit<KnowledgeEntry, 'wikiPath'> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md.trim());
  if (!m) return null;
  const [, fmText, body] = m;
  const meta: Record<string, string> = {};
  const evidence: Array<Record<string, unknown>> = [];
  let inEvidence = false;
  for (const rawLine of fmText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^evidence:\s*$/.test(line)) { inEvidence = true; continue; }
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (inEvidence && item) {
      try { evidence.push(JSON.parse(item[1]) as Record<string, unknown>); } catch { evidence.push({ note: item[1] }); }
      continue;
    }
    inEvidence = false;
    const kv = /^([\w_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const scopeKind = (meta.scope_kind ?? 'global') as ScopeKind;
  const kind = (meta.kind ?? 'human_verdict') as KnowledgeKind;
  const status = (meta.status ?? 'ai_draft') as KnowledgeStatus;
  if (!meta.id || !meta.title) return null;
  return {
    id: meta.id,
    scopeKind: ['library', 'api', 'control', 'scenario', 'global'].includes(scopeKind) ? scopeKind : 'global',
    scopeKey: meta.scope_key ?? '',
    kind: ['traversal_quirk', 'oracle_recipe', 'special_handling', 'blocked_reason', 'demo_patch', 'human_verdict'].includes(kind) ? kind : 'human_verdict',
    title: meta.title,
    keywords: (meta.keywords ?? '').split(/\s+/).filter(Boolean),
    status: ['ai_draft', 'human_confirmed', 'rejected', 'deprecated'].includes(status) ? status : 'ai_draft',
    confidence: Math.max(0, Math.min(100, Number(meta.confidence ?? 50) || 50)),
    evidence,
    body: body.trim(),
    createdAt: meta.created_at ?? new Date().toISOString(),
    updatedAt: meta.updated_at ?? new Date().toISOString(),
  };
}

/** 内容哈希（md 是否变化；也为将来切片入向量库预留，设计 §7.7）。 */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 32);
}

// ---------- 2. 检索（三级、无向量，纯函数） ----------

export interface RetrieveQuery {
  library?: string;
  apiName?: string;
  controlFingerprint?: string;
  scenarioKind?: string;
  stage?: string;
  /** 预算（字符数）：按 score 截断 */
  budgetChars?: number;
}

const SCOPE_PRIORITY: Record<ScopeKind, number> = { api: 5, control: 4, library: 3, scenario: 2, global: 1 };

/** 关键词分词：中文按字/词混合、英文按单词；去停用词与单字噪声。 */
export function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const words = lower.split(/[^\w\u4e00-\u9fa5]+/).filter((w) => w.length >= 2);
  const out = new Set<string>(words);
  // 接口名再按驼峰/下划线切一遍（getSchema → get / schema）
  for (const w of words) {
    for (const part of w.split(/[_-]/)) if (part.length >= 3) out.add(part);
  }
  return [...out];
}

/**
 * 三级检索（设计 §7.4）：
 *   ① 结构化命中：scope_kind + scope_key 精确匹配
 *   ② 关键词命中：命中 keywords 的条目按命中数排序
 *   ③ 排序截断：score = 3*scope精确 + 2*关键词命中数 + (human_confirmed ? 2 : 0) + confidence/100
 *      保证至少注入 1 条 library 级 + 1 条 scenario 级（若有），再按 score 取到预算为止
 *
 * 已否决/已过时的条目不参与（rejected/deprecated）。
 */
export function retrieve(query: RetrieveQuery, entries: KnowledgeEntry[], budgetChars = 1500): {
  selected: KnowledgeEntry[];
  scored: Array<{ entry: KnowledgeEntry; score: number; why: string }>;
  truncated: number;
} {
  const usable = entries.filter((e) => e.status === 'human_confirmed' || e.status === 'ai_draft');
  const queryTokens = new Set([
    ...tokenize(query.apiName ?? ''),
    ...tokenize(query.library ?? ''),
    ...tokenize(query.scenarioKind ?? ''),
    ...tokenize(query.controlFingerprint ?? ''),
  ]);
  const scored: Array<{ entry: KnowledgeEntry; score: number; why: string }> = [];
  for (const e of usable) {
    const scopeExact = (query.apiName && e.scopeKind === 'api' && e.scopeKey === query.apiName)
      || (query.library && e.scopeKind === 'library' && e.scopeKey === query.library)
      || (query.scenarioKind && e.scopeKind === 'scenario' && e.scopeKey === query.scenarioKind)
      || (query.controlFingerprint && e.scopeKind === 'control' && e.scopeKey === query.controlFingerprint);
    const kwHits = e.keywords.filter((k) => queryTokens.has(k.toLowerCase())).length
      + tokenize(e.title).filter((t) => queryTokens.has(t)).length;
    if (!scopeExact && kwHits === 0) continue;
    const score = 3 * (scopeExact ? 1 : 0) + 2 * kwHits + (e.status === 'human_confirmed' ? 2 : 0) + e.confidence / 100;
    scored.push({
      entry: e, score: Math.round(score * 100) / 100,
      why: [scopeExact ? `作用域精确命中(${e.scopeKind}:${e.scopeKey})` : '', kwHits > 0 ? `关键词命中 ${kwHits}` : '',
        e.status === 'human_confirmed' ? '人工已确认' : 'AI 草稿'].filter(Boolean).join(' · '),
    });
  }
  scored.sort((a, b) => b.score - a.score || (SCOPE_PRIORITY[b.entry.scopeKind] - SCOPE_PRIORITY[a.entry.scopeKind]));

  // 必注入：至少 1 条 library 级 + 1 条 scenario 级（若有）
  const must: typeof scored = [];
  for (const kind of ['library', 'scenario'] as const) {
    const hit = scored.find((s) => s.entry.scopeKind === kind && !must.includes(s));
    if (hit) must.push(hit);
  }
  const ordered = [...must, ...scored.filter((s) => !must.includes(s))];

  const selected: KnowledgeEntry[] = [];
  let used = 0;
  let truncated = 0;
  for (const s of ordered) {
    const size = s.entry.title.length + s.entry.body.length + 40;
    if (used + size > budgetChars && selected.length >= must.length) { truncated++; continue; }
    selected.push(s.entry);
    used += size;
  }
  return { selected, scored, truncated };
}

/** 注入格式（设计 §7.4-4）：标题 + 现象 + 处置 + 结论，不含 front-matter，标注来源与置信度。 */
export function renderInjection(selected: KnowledgeEntry[]): string {
  if (selected.length === 0) return '';
  const blocks = selected.map((e, i) => {
    const body = e.body
      .split(/\r?\n/)
      .filter((l) => !/^##\s*(原因|证据)\s*$/.test(l.trim()))   // 原因段对生成帮助不大，省预算
      .join('\n')
      .trim();
    return [
      `### [${i + 1}] ${e.title}`,
      `（来源：${SCOPE_LABEL[e.scopeKind]} · ${KIND_LABEL[e.kind]} · 置信度 ${e.confidence} · ${e.status === 'human_confirmed' ? '人工已确认' : '⚠️ AI 草稿，未经人工确认'}）`,
      body,
    ].join('\n');
  });
  return [`【历史经验（来自本项目的知识库，不是通用常识）】`, ...blocks].join('\n\n');
}

// ---------- 3. 目录与索引 IO ----------

export function wikiRoot(): string {
  return path.join(workspaceDir(), 'knowledge', 'wiki');
}

/** 条目落盘目录（按 scope 分层，设计 §7.3）。 */
export function entryDir(e: Pick<KnowledgeEntry, 'scopeKind' | 'scopeKey'>): string {
  const root = wikiRoot();
  const safe = (s: string): string => s.replace(/[^\w.-]/g, '_').slice(0, 60) || '_';
  switch (e.scopeKind) {
    case 'library': return path.join(root, 'libraries', safe(e.scopeKey));
    case 'api': return path.join(root, 'apis', safe(e.scopeKey));
    case 'control': return path.join(root, 'controls');
    case 'scenario': return path.join(root, 'scenarios');
    default: return path.join(root, 'global');
  }
}

function walkMd(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 扫描 md → 条目数组（**md 是唯一事实来源**）。坏文件会被跳过并计数，不影响其余。 */
export function loadEntriesFromDisk(): { entries: KnowledgeEntry[]; broken: string[] } {
  const root = wikiRoot();
  const entries: KnowledgeEntry[] = [];
  const broken: string[] = [];
  for (const file of walkMd(root)) {
    try {
      const parsed = parseEntry(fs.readFileSync(file, 'utf8'));
      if (!parsed) { broken.push(path.relative(root, file)); continue; }
      entries.push({ ...parsed, wikiPath: path.relative(root, file).replace(/\\/g, '/') });
    } catch {
      broken.push(path.relative(root, file));
    }
  }
  return { entries, broken };
}

/** 写一条条目（md + 重建索引 + 刷新 DB 索引）。 */
export async function saveEntry(e: Omit<KnowledgeEntry, 'wikiPath' | 'updatedAt'> & { updatedAt?: string }): Promise<KnowledgeEntry> {
  const dir = entryDir(e);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugify(e.title)}.md`);
  const entry: KnowledgeEntry = { ...e, updatedAt: e.updatedAt ?? new Date().toISOString(), wikiPath: path.relative(wikiRoot(), file).replace(/\\/g, '/') };
  fs.writeFileSync(file, renderEntry(entry), 'utf8');
  await rebuildIndex();
  return entry;
}

/** 由 md 重建 index.json 与 DB 索引表。 */
export async function rebuildIndex(): Promise<{ total: number; broken: string[] }> {
  const { entries, broken } = loadEntriesFromDisk();
  const root = wikiRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: entries.length,
    entries: entries.map((e) => ({
      id: e.id, wikiPath: e.wikiPath, scopeKind: e.scopeKind, scopeKey: e.scopeKey, kind: e.kind,
      title: e.title, keywords: e.keywords, status: e.status, confidence: e.confidence,
      updatedAt: e.updatedAt, contentHash: contentHash(renderEntry(e)),
    })),
  }, null, 2), 'utf8');

  const db = getDb();
  const t = now();
  await db.transaction(async () => {
    await db.prepare('DELETE FROM knowledge_entries').run();
    for (const e of entries) {
      await db.prepare(`INSERT INTO knowledge_entries
        (wiki_path, scope_kind, scope_key, kind, title, keywords, status, confidence, evidence_json, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.wikiPath, e.scopeKind, e.scopeKey, e.kind, e.title, e.keywords.join(' '), e.status, e.confidence,
          JSON.stringify(e.evidence), contentHash(renderEntry(e)), e.createdAt, e.updatedAt);
    }
  });
  return { total: entries.length, broken };
}

/**
 * 人工确认（生命周期 §7.6）：**没有 evidence 的条目不允许确认** ——
 * 知识条目的价值来自"这事真发生过"，没有证据的结论就是传闻。
 */
export function canConfirm(e: KnowledgeEntry): { ok: boolean; reason: string } {
  if (e.status === 'human_confirmed') return { ok: true, reason: '已是人工确认状态' };
  const real = e.evidence.filter((v) => Object.keys(v).length > 0);
  if (real.length === 0) {
    return { ok: false, reason: '该条目没有证据（任务/报告/日志引用）：没有证据的结论不允许标为人工确认（知识库不能收传闻）' };
  }
  return { ok: true, reason: `有 ${real.length} 条证据，可以确认` };
}

/** 接口签名变化 → api 级条目自动降级为 deprecated（设计 §7.6）。 */
export async function deprecateStaleApiEntries(libraryId: number): Promise<{ checked: number; deprecated: string[] }> {
  const db = getDb();
  const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(libraryId);
  if (!lib) return { checked: 0, deprecated: [] };
  const { entries } = loadEntriesFromDisk();
  const apiEntries = entries.filter((e) => e.scopeKind === 'api' && e.scopeKey.startsWith(`${lib.name}:`));
  const deprecated: string[] = [];
  for (const e of apiEntries) {
    const symbolName = e.scopeKey.slice(lib.name.length + 1);
    const sigInEntry = String((e.evidence.find((v) => typeof v.signature === 'string')?.signature) ?? '');
    const cur = await db.prepare('SELECT signature FROM api_symbols WHERE library_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
      .get<{ signature: string }>(libraryId, symbolName);
    if (sigInEntry && cur?.signature && cur.signature !== sigInEntry) {
      await saveEntry({ ...e, status: 'deprecated', body: `${e.body}\n\n## 已过时\n接口签名已变化（记录时：${sigInEntry} → 现在：${cur.signature}），本条结论需要复核。` });
      deprecated.push(e.title);
    }
  }
  return { checked: apiEntries.length, deprecated };
}

/**
 * 从人工队列的结论沉淀知识条目（设计 §6.7：「结论一律沉淀为知识条目」）。
 * stage → kind 的映射是刻意的：队列里人解决的是哪类问题，决定这条知识属于哪一类。
 */
export function kindForStage(stage: string): KnowledgeKind {
  switch (stage) {
    case 'demo_patch': return 'demo_patch';
    case 'oracle_missing': return 'oracle_recipe';
    case 'external_dep': case 'animation': case 'video': case 'device_blocked': case 'untestable': return 'blocked_reason';
    case 'flaky': return 'traversal_quirk';
    case 'long_running': return 'special_handling';
    default: return 'human_verdict';
  }
}

export async function sediteFromQueue(item: {
  libraryId: number; libraryName: string; caseNo: string; stage: string;
  reason: string; question: string; resolution: string; payload: Record<string, unknown>;
}): Promise<KnowledgeEntry> {
  const kind = kindForStage(item.stage);
  const id = `kn-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;
  const title = `[${item.libraryName}] ${KIND_LABEL[kind]}：${item.reason.slice(0, 40)}`;
  const body = [
    '## 现象', item.reason,
    '', '## 需要人做什么', item.question,
    '', '## 处置（人工回填）', item.resolution,
    '', '## 结论',
    `- 来源：${item.libraryName} / ${item.caseNo || '（无关联用例）'} / 阻塞类别 ${item.stage}`,
    `- 状态：AI 草稿，等待人工在知识页确认后生效`,
  ].join('\n');
  return saveEntry({
    id, scopeKind: 'library', scopeKey: item.libraryName, kind, title,
    keywords: tokenize(`${item.libraryName} ${item.stage} ${item.reason} ${item.resolution}`).slice(0, 12),
    status: 'ai_draft', confidence: 60,
    evidence: [{ source: 'human_queue', caseNo: item.caseNo, stage: item.stage, estimatedSeconds: item.payload.estimatedSeconds }],
    body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

/** 为某个阶段检索并渲染注入文本（各阶段按 §7.5 的预算与 kinds 取用）。 */
export function injectForStage(stage: string, query: RetrieveQuery): { text: string; picked: Array<{ title: string; why: string }>; truncated: number } {
  const budgets: Record<string, number> = { explore: 800, case_draft: 1500, case_optimize: 1500, triage: 800, script_gen: 1200 };
  const budget = budgets[stage] ?? 1200;
  const { entries } = loadEntriesFromDisk();
  const r = retrieve({ ...query, stage }, entries, budget);
  return {
    text: renderInjection(r.selected),
    picked: r.selected.map((e) => ({ title: e.title, why: r.scored.find((s) => s.entry.id === e.id)?.why ?? '' })),
    truncated: r.truncated,
  };
}
