// 数据分析 / 归因分析服务：
//  - 从 GitCode 拉取三方库真实 PR（Gitee v5 兼容 API），
//  - 用 ctx.llm 生成「更新点 / 影响范围 / 建议用例更新」与失败归因结论，
//  - LLM 不可用**不再降级为规则分析**：直接抛错，由上层（进度 error / HTTP error）
//    把「LLM 不可用」以红色告警呈现。规则分析只会照抄 PR 标题、拼凑套话，
//    却和 AI 结论混在同一个列表里，肉眼分不出哪条是推测——那比没有结论更坏。
//  - 全部结果写入 analyses 表（kind：pr_analysis / case_update_analysis / attribution）。
import { getDb, now } from '../db/connection.js';
import { normalizeRepoUrl } from './gitRepo.js';
import { getSetting } from './settings.js';
import type { LlmCall } from './llmCore.js';
import { extractJson } from './llmCore.js';
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
  const u = normalizeRepoUrl(repoUrl);
  const m = u.match(/gitcode\.com\/([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/);
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

async function saveAnalysis(row: {
  kind: string;
  granularity: string;
  libraryId: number | null;
  caseId: number | null;
  title: string;
  content: unknown;
  round: string;
}): Promise<void> {
  await getDb().prepare(`INSERT INTO analyses (kind, granularity, library_id, case_id, title, content, round, created_at)
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

/** LLM 调用带重试：偶发空返回/瞬时错误时重试，仍失败再抛错交给调用方告警。 */
async function llmWithRetry(llm: LlmCall, input: Parameters<LlmCall>[0], tries = 5): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const { text } = await llm(input);
      if (text.trim()) return text;
      lastErr = new Error('LLM 返回为空');
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * LLM 不可用：转成一条能直接指路的告警错误（上层以红色呈现，不再落任何分析结果）。
 *
 * 不降级的原因：规则兜底只会照抄 PR 标题、按文件名猜影响，产出的结论和 AI 结论
 * 长得一模一样、存在同一张列表里，使用者分不出哪条是推测——误把套话当根因，
 * 比干脆没有结论更危险。所以这里只报错，并把排查动作写进消息里。
 */
export function llmUnavailableError(scope: string, e: unknown): Error {
  const reason = e instanceof Error ? e.message : String(e);
  return new Error(
    `${scope}：LLM 不可用，${reason}。`
    + '请到「系统配置 → 模型」检查模型的 baseUrl / modelId / API Key 与协议（openai / anthropic），'
    + '并确认网络或代理可达，修复后重新发起分析（数据分析不再降级为规则分析，避免把推测当结论）。',
  );
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
      await saveAnalysis({
        kind: 'pr_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `PR #${item.prNumber} · 数据分析`, content: item,
      });
    }
    onStage?.('完成');
    return { analyzed: items.length, prs: prs.length, source: 'llm', message: `AI 分析完成：${items.length}/${prs.length} 条 PR` };
  } catch (e) {
    throw llmUnavailableError('PR 数据分析', e);
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
  const samples = await db.prepare('SELECT case_no, name, expected FROM cases WHERE library_id = ? ORDER BY id LIMIT 15')
    .all<{ case_no: string; name: string; expected: string }>(library.id);
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
      await saveAnalysis({
        kind: 'case_update_analysis', granularity: 'single', libraryId: library.id, caseId: null, round,
        title: `用例更新建议 · ${String(item.caseNo ?? '新增')}`, content: item,
      });
    }
    onStage?.('完成');
    return { analyzed: items.length, prs: prs.length, source: 'llm', message: `AI 分析完成：${items.length} 条用例更新建议` };
  } catch (e) {
    throw llmUnavailableError('用例更新分析', e);
  }
}

export interface AttributionOptions {
  /** 勾选的用例 id（跨库任意多选；与 libraryIds 可组合） */
  caseIds?: number[];
  /** 库级选择（该库全部失败执行） */
  libraryIds?: number[];
  /** 全部库所有失败执行 */
  allLibraries?: boolean;
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

/** 归因分析：按勾选范围（任意用例多选 / 库级 / 全部）对失败执行做 AI 归因。 */
export async function analyzeAttribution(llm: LlmCall, opts: AttributionOptions): Promise<AnalyzeResult> {
  const db = getDb();
  const conds = ['e.status = \'failed\''];
  const args: unknown[] = [];
  if (opts.caseIds && opts.caseIds.length > 0) {
    conds.push(`e.case_id IN (${opts.caseIds.map(() => '?').join(',')})`);
    args.push(...opts.caseIds);
  } else if (opts.libraryIds && opts.libraryIds.length > 0) {
    conds.push(`e.library_id IN (${opts.libraryIds.map(() => '?').join(',')})`);
    args.push(...opts.libraryIds);
  } else if (!opts.allLibraries) {
    return { analyzed: 0, prs: 0, source: 'fallback', message: '请先勾选要归因的失败用例或选择库' };
  }
  const rows = await db.prepare(
    `SELECT e.id, e.case_id, c.case_no, c.name AS case_name, e.library_id, l.name AS library_name,
            e.thinking, e.logs, e.status, e.started_at
     FROM executions e
     LEFT JOIN cases c ON c.id = e.case_id
     LEFT JOIN libraries l ON l.id = e.library_id
     WHERE ${conds.join(' AND ')} ORDER BY e.id DESC LIMIT 50`,
  ).all<FailedExecRow>(...args);
  if (rows.length === 0) {
    return { analyzed: 0, prs: 0, source: 'fallback', message: '勾选范围内没有失败执行记录，先执行计划产生失败用例' };
  }

  // 范围描述与标题
  const libs = [...new Set(rows.map((r) => r.library_name ?? '?'))];
  let scopeLabel: string;
  if (opts.caseIds?.length) scopeLabel = `自选用例 ${rows.length} 条`;
  else if (opts.libraryIds?.length === 1) scopeLabel = `库级 · ${libs[0]}`;
  else if (opts.allLibraries && !opts.libraryIds?.length && !opts.caseIds?.length) scopeLabel = `全部库聚合（${libs.length} 库 / ${rows.length} 条）`;
  else scopeLabel = `多库聚合（${libs.length} 库 / ${rows.length} 条）`;

  const sys = `你是鸿蒙三方库测试归因分析 Agent。基于失败执行记录（含 AI 思考过程与真实设备日志）做归因分析，输出 JSON：
{"conclusion":"结论","rootCauses":["根因1",...],"evidence":["依据1",...],"suggestions":["建议1",...]}
只输出 JSON。`;
  const user = `归因范围：${scopeLabel}

失败执行记录（${rows.length} 条）：
${rows.map((r) => `- [${r.started_at ?? ''}] ${r.library_name ?? '?'}/${r.case_no} ${r.case_name}（执行 #${r.id}）
  思考：${(r.thinking ?? '').slice(0, 600)}
  日志：${(r.logs ?? '').slice(0, 300)}`).join('\n\n')}`;

  const title = `归因 · ${scopeLabel}`;
  try {
    const text = await llmWithRetry(llm, {
      system: sys, user, maxTokens: 8192,
      temperature: getSetting('exec.llmTemperature', 0.4), timeoutMs: getSetting('exec.llmTimeoutMs', 180000),
    });
    const parsed = extractJson<Record<string, unknown>>(text);
    await saveAnalysis({
      kind: 'attribution', granularity: opts.caseIds?.length ? 'single' : 'custom', libraryId: opts.libraryIds?.[0] ?? null,
      caseId: opts.caseIds?.[0] ?? null, title, round: '', content: parsed,
    });
    return { analyzed: 1, prs: rows.length, source: 'llm', message: `AI 归因完成（基于 ${rows.length} 条失败执行 · ${scopeLabel}）` };
  } catch (e) {
    throw llmUnavailableError('失败归因分析', e);
  }
}
