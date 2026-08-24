// 数据分析 / 归因分析服务：
//  - 从 GitCode 拉取三方库真实 PR（Gitee v5 兼容 API），
//  - 用 ctx.llm 生成「更新点 / 影响范围 / 建议用例更新」与失败归因结论，
//  - LLM 不可用时降级为规则分析（保证无模型也能产出结果），
//  - 全部结果写入 analyses 表（kind：pr_analysis / case_update_analysis / attribution）。
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';
import type { LlmCall } from './llmHarness.js';
import { extractJson } from './llmHarness.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const GITCODE_API = 'https://gitcode.com/api/v5';

/** fetch 封装：瞬时网络错误自动重试，失败时透出真实原因（e.cause）。 */
async function fetchWithRetry(url: string, timeoutMs: number, retries = 2): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  const err = lastErr as Error & { cause?: unknown };
  const cause = err?.cause instanceof Error ? `：${err.cause.message}` : err?.cause ? `：${String(err.cause)}` : '';
  throw new Error(`网络请求失败${cause}（${err?.message ?? '未知错误'}）`);
}

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface GitCodePr {
  number: number;
  title: string;
  state: string;
  body: string;
  created_at: string;
  merged_at: string | null;
  added_lines: number;
  removed_lines: number;
  web_url: string;
  files: PrFile[];
}

/** 从仓库 URL 提取 GitCode owner/repo；非 GitCode 地址返回 null。 */
export function parseRepoPath(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const m = repoUrl.match(/gitcode\.com\/([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 拉取仓库 PR 列表 + 每个 PR 的变更文件（并发拉取文件，失败不影响主体）。 */
export async function fetchPrs(repoPath: string, limit = 8, timeoutMs = 25000): Promise<GitCodePr[]> {
  const listRes = await fetchWithRetry(`${GITCODE_API}/repos/${repoPath}/pulls?state=all&per_page=${limit}&page=1`, timeoutMs);
  if (!listRes.ok) {
    throw new Error(`拉取 PR 列表失败：GitCode HTTP ${listRes.status}（repo: ${repoPath}）`);
  }
  const list = (await listRes.json()) as Array<Record<string, any>>;
  const prs = list.slice(0, limit).map(mapPr);
  await Promise.all(prs.map(async (pr) => {
    try {
      const filesRes = await fetch(`${GITCODE_API}/repos/${repoPath}/pulls/${pr.number}/files?per_page=100`, {
        signal: AbortSignal.timeout(12000),
      });
      if (filesRes.ok) {
        const files = (await filesRes.json()) as Array<Record<string, any>>;
        pr.files = files.slice(0, 30).map((f) => ({
          filename: String(f.filename ?? ''),
          additions: Number(f.additions) || 0,
          deletions: Number(f.deletions) || 0,
        }));
      }
    } catch {
      pr.files = [];
    }
  }));
  return prs as GitCodePr[];
}

function mapPr(pr: Record<string, any>): GitCodePr {
  return {
    number: Number(pr.number ?? pr.iid),
    title: String(pr.title ?? ''),
    state: String(pr.state ?? ''),
    body: String(pr.body ?? '').slice(0, 2000),
    created_at: String(pr.created_at ?? ''),
    merged_at: pr.merged_at ? String(pr.merged_at) : null,
    added_lines: Number(pr.added_lines) || 0,
    removed_lines: Number(pr.removed_lines) || 0,
    web_url: String(pr.html_url ?? pr.web_url ?? ''),
    files: [] as PrFile[],
  };
}

/** 拉取单个 PR（含变更文件），供「选择 #PR 分析」使用。 */
export async function fetchPr(repoPath: string, prNumber: number, timeoutMs = 25000): Promise<GitCodePr> {
  const res = await fetchWithRetry(`${GITCODE_API}/repos/${repoPath}/pulls/${prNumber}`, timeoutMs);
  if (!res.ok) {
    throw new Error(`拉取 PR #${prNumber} 失败：GitCode HTTP ${res.status}`);
  }
  const pr = mapPr((await res.json()) as Record<string, any>);
  try {
    const filesRes = await fetch(`${GITCODE_API}/repos/${repoPath}/pulls/${prNumber}/files?per_page=100`, {
      signal: AbortSignal.timeout(12000),
    });
    if (filesRes.ok) {
      const files = (await filesRes.json()) as Array<Record<string, any>>;
      pr.files = files.slice(0, 30).map((f) => ({
        filename: String(f.filename ?? ''),
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
      }));
    }
  } catch {
    pr.files = [];
  }
  return pr;
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
}

/**
 * GitCode API 不可用时的降级方案：在本地已拉取的仓库目录下用 git 命令，
 * 把最近提交当作「PR」数据（number = 提交序号 1..N，title = 提交标题，state = merged，
 * files = 该提交变更的文件），供分析流程继续使用。
 */
export function fetchPrsFromGit(dir: string, opts: { limit?: number; numbers?: number[] } = {}): GitCodePr[] {
  if (!fs.existsSync(dir) || !fs.existsSync(`${dir}/.git`)) return [];
  const limit = opts.limit ?? 8;
  const need = Math.max(limit, ...(opts.numbers ?? []));
  let log = '';
  try {
    // --no-merges：只取真实变更提交，编号与文件列表更干净
    log = gitIn(dir, ['log', '--no-merges', '--format=%H%x09%s%x09%ad', '--date=short', '-n', String(need)]);
  } catch {
    return [];
  }
  const commitList = log.split(/\r?\n/).filter(Boolean).map((line, i) => {
    const [hash, subject, date] = line.split('\t');
    return { hash, subject: subject ?? '', date: date ?? '', index: i + 1 };
  });
  const selected = opts.numbers && opts.numbers.length > 0
    ? commitList.filter((c) => opts.numbers!.includes(c.index))
    : commitList.slice(0, limit);
  const prs: GitCodePr[] = [];
  for (const c of selected) {
    let files: PrFile[] = [];
    try {
      files = gitIn(dir, ['show', '--name-status', '--format=', c.hash])
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          return { filename: parts[parts.length - 1] ?? '', additions: 0, deletions: 0 };
        });
    } catch {
      files = [];
    }
    prs.push({
      number: c.index,
      title: c.subject,
      state: 'merged',
      body: '',
      created_at: c.date,
      merged_at: c.date,
      added_lines: 0,
      removed_lines: 0,
      web_url: '',
      files,
    });
  }
  return prs;
}

export interface LibraryRow {
  id: number;
  name: string;
  repo_url: string;
  current_version: string;
  description: string;
}

function saveAnalysis(row: {
  kind: string;
  granularity: string;
  libraryId: number | null;
  caseId: number | null;
  title: string;
  content: unknown;
  round: string;
}): void {
  getDb().prepare(`INSERT INTO analyses (kind, granularity, library_id, case_id, title, content, round, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.kind, row.granularity, row.libraryId, row.caseId, row.title, JSON.stringify(row.content), row.round, now(),
  );
}

function prContext(prs: GitCodePr[]): string {
  return prs.map((pr) => {
    const files = pr.files.map((f) => `  - ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
    return `PR #${pr.number} [${pr.state}] ${pr.title}
创建：${pr.created_at}${pr.merged_at ? ` 合并：${pr.merged_at}` : ''}（+${pr.added_lines}/-${pr.removed_lines}）
描述：${pr.body.slice(0, 600) || '（无）'}
变更文件：\n${files || '  （未获取）'}`;
  }).join('\n\n');
}

/** LLM 调用带重试：偶发空返回/瞬时错误时重试，仍失败再抛错交给调用方降级。 */
async function llmWithRetry(llm: LlmCall, input: Parameters<LlmCall>[0], tries = 5): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const text = await llm(input);
      if (text.trim()) return text;
      lastErr = new Error('LLM 返回为空');
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function riskOf(pr: GitCodePr): string {
  const changed = pr.added_lines + pr.removed_lines;
  const cpp = pr.files.some((f) => /\.(cpp|h|hpp|c)$/.test(f.filename));
  if (changed > 200 || (cpp && changed > 80)) return 'high';
  if (changed > 60) return 'medium';
  return 'low';
}

/** 规则兜底：从 PR 标题/文件推导更新点与影响（无 LLM 时使用）。 */
function ruleBasedPrAnalysis(prs: GitCodePr[]): Array<Record<string, unknown>> {
  const strip = (s: string): string => s.replace(/^(fix|feat|docs|refactor|chore|perf|test)(\([^)]*\))?[:\s]*/i, '');
  return prs.map((pr) => {
    const updatePoints = [strip(pr.title) || `更新 ${pr.number}`];
    const files = pr.files.map((f) => f.filename);
    const impacted = files.slice(0, 6);
    const cppCore = files.some((f) => /lottie_(controller|render|parser)|lottiemodel|\.cpp$/.test(f));
    return {
      prNumber: pr.number,
      title: pr.title,
      updatePoints,
      impact: `变更 ${files.length} 个文件（+${pr.added_lines}/-${pr.removed_lines}）${cppCore ? '，涉及核心渲染/控制逻辑，需回归动画渲染与播放控制相关用例' : ''}。`,
      affectedFeatures: impacted,
      suggestedCaseUpdates: cppCore
        ? ['补充/更新动画播放控制边界用例', '回归关键帧与效果渲染用例']
        : ['按 PR 变更点人工确认后更新对应用例'],
      risk: riskOf(pr),
      state: pr.state,
      webUrl: pr.web_url,
    };
  });
}

export interface AnalyzeResult {
  analyzed: number;
  prs: number;
  source: 'llm' | 'fallback';
  message: string;
}

/** PR 数据分析：每个 PR 产出「更新点 / 影响 / 建议用例更新 / 风险」。 */
export async function analyzePrChanges(
  llm: LlmCall,
  library: LibraryRow,
  prs: GitCodePr[],
  onStage?: (stage: string) => void,
  round = '',
): Promise<AnalyzeResult> {
  if (prs.length === 0) return { analyzed: 0, prs: 0, source: 'fallback', message: '仓库暂无 PR' };
  onStage?.(`拉取到 ${prs.length} 条 PR，AI 分析中…`);
  const sys = `你是鸿蒙三方库测试分析 Agent。分析给定 GitCode PR 列表，输出 JSON 数组，每项：
{"prNumber":number,"title":"PR 标题","updatePoints":["更新点1",...],"impact":"影响范围与可能影响的模块/用例","affectedFeatures":["受影响功能"],"suggestedCaseUpdates":["建议的用例更新动作"],"risk":"low|medium|high"}
只输出 JSON。`;
  const user = `三方库：${library.name}（${library.current_version}）
仓库：${library.repo_url}
库简介：${library.description}

PR 列表：
${prContext(prs)}`;
  try {
    const text = await llmWithRetry(llm, {
      system: sys, user, maxTokens: 8192,
      temperature: getSetting('exec.llmTemperature', 0.4), timeoutMs: getSetting('exec.llmTimeoutMs', 180000),
    });
    onStage?.('AI 已返回分析结果，正在写入 analyses…');
    const parsed = extractJson<Array<Record<string, unknown>>>(text);
    const items = Array.isArray(parsed) ? parsed.slice(0, prs.length) : [];
    for (const item of items) {
      const pr = prs.find((x) => x.number === Number(item.prNumber));
      if (pr) item.webUrl = pr.web_url;
      saveAnalysis({
        kind: 'pr_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `PR #${item.prNumber} · 数据分析`, content: item,
      });
    }
    onStage?.('完成');
    return { analyzed: items.length, prs: prs.length, source: 'llm', message: `AI 分析完成：${items.length}/${prs.length} 条 PR` };
  } catch (e) {
    onStage?.('LLM 不可用，规则分析降级中…');
    const items = ruleBasedPrAnalysis(prs);
    for (const item of items) {
      saveAnalysis({
        kind: 'pr_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `PR #${item.prNumber} · 数据分析（规则降级）`, content: item,
      });
    }
    return { analyzed: items.length, prs: prs.length, source: 'fallback', message: `LLM 不可用，已用规则分析降级：${(e as Error).message}` };
  }
}

/** 用例更新分析：结合 PR 变更与现有用例，产出需要更新的用例及理由。 */
export async function analyzeCaseUpdates(
  llm: LlmCall,
  library: LibraryRow,
  prs: GitCodePr[],
  onStage?: (stage: string) => void,
  round = '',
): Promise<AnalyzeResult> {
  const db = getDb();
  const samples = db.prepare('SELECT case_no, name, expected FROM cases WHERE library_id = ? ORDER BY id LIMIT 15')
    .all(library.id) as Array<{ case_no: string; name: string; expected: string }>;
  if (prs.length === 0 || samples.length === 0) {
    return { analyzed: 0, prs: prs.length, source: 'fallback', message: '没有 PR 或用例可供分析' };
  }
  onStage?.('结合 PR 变更与现有用例，AI 分析中…');
  const sys = `你是鸿蒙三方库用例维护 Agent。结合最新 PR 变更与现有用例，输出需要更新/新增的用例建议，JSON 数组，每项：
{"caseNo":"现有用例编号（新增填 null）","reason":"为什么需要更新（对应哪个 PR 的更新点）","suggestedAction":"建议动作（更新前置/步骤/预期/新增用例）","newExpected":"更新后的预期结果"}
只输出 JSON。`;
  const user = `三方库：${library.name}（${library.current_version}）

近期 PR：
${prContext(prs.slice(0, 6))}

现有用例样例：
${samples.map((c) => `- ${c.case_no} ${c.name}：${(c.expected || '').slice(0, 120)}`).join('\n')}`;
  try {
    const text = await llmWithRetry(llm, {
      system: sys, user, maxTokens: 8192,
      temperature: getSetting('exec.llmTemperature', 0.4), timeoutMs: getSetting('exec.llmTimeoutMs', 180000),
    });
    onStage?.('AI 已返回建议，正在写入 analyses…');
    const parsed = extractJson<Array<Record<string, unknown>>>(text);
    const items = Array.isArray(parsed) ? parsed.slice(0, 20) : [];
    for (const item of items) {
      saveAnalysis({
        kind: 'case_update_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `用例更新建议 · ${String(item.caseNo ?? '新增')}`, content: item,
      });
    }
    onStage?.('完成');
    return { analyzed: items.length, prs: prs.length, source: 'llm', message: `AI 分析完成：${items.length} 条用例更新建议` };
  } catch (e) {
    onStage?.('LLM 不可用，规则分析降级中…');
    const items = prs.slice(0, 6).map((pr) => ({
      caseNo: null,
      reason: `PR #${pr.number}：${pr.title}（规则降级分析）`,
      suggestedAction: '人工确认 PR 变更点后，更新/新增受影响模块的用例（保存时版本自动递增）',
      newExpected: '',
    }));
    for (const item of items) {
      saveAnalysis({
        kind: 'case_update_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `用例更新建议 · PR #${prs[items.indexOf(item)].number}（规则降级）`, content: item,
      });
    }
    return { analyzed: items.length, prs: prs.length, source: 'fallback', message: `LLM 不可用，已用规则分析降级：${(e as Error).message}` };
  }
}

export interface AttributionOptions {
  granularity: 'single' | 'lib' | 'multi';
  libraryId?: number | null;
  caseId?: number | null;
}

interface FailedExecRow {
  id: number;
  case_no: string;
  case_name: string;
  library_id: number | null;
  library_name: string | null;
  thinking: string | null;
  logs: string | null;
  status: string;
  started_at: string | null;
}

/** 归因分析：按粒度（单用例/单库/多库）对失败执行做 AI 归因。 */
export async function analyzeAttribution(llm: LlmCall, opts: AttributionOptions): Promise<AnalyzeResult> {
  const db = getDb();
  const conds = ['e.status = \'failed\''];
  const p: Record<string, unknown> = { limit: opts.granularity === 'single' ? 3 : 20 };
  if (opts.caseId) { conds.push('e.case_id = @caseId'); p.caseId = opts.caseId; }
  if (opts.libraryId) { conds.push('e.library_id = @libraryId'); p.libraryId = opts.libraryId; }
  const where = conds.join(' AND ');
  const rows = db.prepare(
    `SELECT e.id, e.case_id, c.case_no, c.name AS case_name, e.library_id, l.name AS library_name,
            e.thinking, e.logs, e.status, e.started_at
     FROM executions e
     LEFT JOIN cases c ON c.id = e.case_id
     LEFT JOIN libraries l ON l.id = e.library_id
     WHERE ${where} ORDER BY e.id DESC LIMIT @limit`,
  ).all(p) as FailedExecRow[];
  if (rows.length === 0) {
    return { analyzed: 0, prs: 0, source: 'fallback', message: '没有匹配的失败执行记录，先执行计划产生失败用例' };
  }

  const granularityLabel = { single: '单用例', lib: '单库', multi: '多库' }[opts.granularity];
  const sys = `你是鸿蒙三方库测试归因分析 Agent。基于失败执行记录（含 AI 思考过程）做 ${granularityLabel} 粒度归因，输出 JSON：
{"conclusion":"结论","rootCauses":["根因1",...],"evidence":["依据1",...],"suggestions":["建议1",...]}
只输出 JSON。`;
  const user = `归因粒度：${granularityLabel}
${opts.caseId ? `目标用例：#${opts.caseId}` : ''}${opts.libraryId ? `目标库：#${opts.libraryId}` : ''}

失败执行记录（${rows.length} 条）：
${rows.map((r) => `- [${r.started_at ?? ''}] ${r.library_name ?? '?'}/${r.case_no} ${r.case_name}（执行 #${r.id}）
  思考：${(r.thinking ?? '').slice(0, 600)}
  日志：${(r.logs ?? '').slice(0, 300)}`).join('\n\n')}`;

  const title = opts.caseId ? `归因 · 单用例 #${opts.caseId}`
    : opts.libraryId ? `归因 · 单库 #${opts.libraryId}`
    : '归因 · 多库聚合';
  try {
    const text = await llmWithRetry(llm, {
      system: sys, user, maxTokens: 8192,
      temperature: getSetting('exec.llmTemperature', 0.4), timeoutMs: getSetting('exec.llmTimeoutMs', 180000),
    });
    const parsed = extractJson<Record<string, unknown>>(text);
    saveAnalysis({
      kind: 'attribution', granularity: opts.granularity, libraryId: opts.libraryId ?? null,
      caseId: opts.caseId ?? null, title, round: '', content: parsed,
    });
    return { analyzed: 1, prs: rows.length, source: 'llm', message: `AI 归因完成（基于 ${rows.length} 条失败执行）` };
  } catch (e) {
    const conclusions = rows.map((r) => {
      const t = r.thinking ?? '';
      const causes: string[] = [];
      if (/超时|timeout/i.test(t)) causes.push('执行超时（等待预期事件未返回）');
      if (/未收到预期事件|异常日志/i.test(t)) causes.push('界面/事件响应与预期不符');
      if (/回归缺陷|代码变更/i.test(t)) causes.push('三方库近期代码变更引入回归');
      if (causes.length === 0) causes.push('执行环境或用例步骤与设备状态不匹配');
      return { caseNo: r.case_no, library: r.library_name, causes, thinking: t.slice(0, 200) };
    });
    saveAnalysis({
      kind: 'attribution', granularity: opts.granularity, libraryId: opts.libraryId ?? null,
      caseId: opts.caseId ?? null, round: '', title: `${title}（规则降级）`,
      content: {
        conclusion: `基于 ${rows.length} 条失败执行记录，按 ${granularityLabel} 粒度聚合：失败集中在 ${[...new Set(conclusions.flatMap((c) => c.causes))].join('、')}。`,
        rootCauses: [...new Set(conclusions.flatMap((c) => c.causes))],
        evidence: conclusions.slice(0, 10).map((c) => `${c.library ?? '?'}/${c.caseNo}：${c.causes.join('、')}`),
        suggestions: ['核对近期合并 PR 是否影响相关模块', '用调试会话逐步骤复核失败用例', '更新用例脚本参数并重新执行'],
      },
    });
    return { analyzed: 1, prs: rows.length, source: 'fallback', message: `LLM 不可用，已用规则归因降级：${(e as Error).message}` };
  }
}
