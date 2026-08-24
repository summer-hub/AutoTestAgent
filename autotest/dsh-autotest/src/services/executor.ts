// AI 任务执行器（DSH 插件版）：AI 调用经 ctx.llm（LlmCall 注入）
// write_cases / explore_cases / update_cases / to_script 为真实 LLM 调用；
// pull_repo / update_repo 走真实 git CLI（clone/pull + 变更解析）。
// 用例生成统一走「Prompt 管理」的用例生成 Agent（content + 绑定 skill），并带自审进化循环：
// 评审 Agent 按「真实可操作 / 逻辑合理 / 预期明确清晰」标准挑毛病 → 直接修订 → 教训沉淀到 agent-memory 供后续生成规避。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { ensureLibraryByRepoUrl, inspectRepo, pullRepo, recentChanges, refreshPackageInfo, updateRepo, workspaceDir, type RepoLib } from './gitRepo.js';
import { getSetting } from './settings.js';
import { extractJson, lastLlmCall, type LlmCall } from './llmHarness.js';
import { exploreApp, ensureDeviceOnline, saveExploreReport, type ExploreResult, type ExploredPage } from './uiExplorer.js';
import { writeHypiumProject } from './hypiumGen.js';

// ---------- 定向用例设计（write_cases）辅助 ----------

const normKey = (s: string): string => s.toLowerCase().replace(/[\s_\-./\\()（）]/g, '');

/** 从任务输入提取关键词（中英文词元）。 */
function inputTerms(input: string): string[] {
  return input
    .split(/[^\w\u4e00-\u9fa5]+/)
    .map((t) => normKey(t))
    .filter((t) => t.length >= 2);
}

/** 任务输入 → 命中的页面文件列表（按匹配度排序，最多 2 个）。 */
function pickTargetPages(input: string, pages: string[]): Array<{ file: string; score: number }> {
  const terms = inputTerms(input);
  if (terms.length === 0 || pages.length === 0) return [];
  return pages
    .map((file) => {
      const pn = normKey(path.basename(file, '.ets'));
      let score = 0;
      for (const t of terms) {
        if (pn === t) score += 5;
        else if (pn.includes(t) || t.includes(pn)) score += 2;
      }
      return { file, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

/** 最新一次真机遍历报告（无则 null，不强制要求设备/遍历过）。 */
function latestExploreResult(libName: string): ExploreResult | null {
  try {
    const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
    const files = fs.readdirSync(dir).filter((f) => /^explore_\d+\.json$/.test(f)).sort();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')) as ExploreResult;
  } catch { return null; }
}

interface TaskRow {
  id: number; task_no: string; type: string; title: string;
  library_id: number | null; input: string; status: string;
  progress: number; result_summary: string | null; error: string | null;
  created_at: string; updated_at: string;
}

interface TraceEntry { seq: number; at: string; title: string; detail: string; }

/** 往任务的 AI 执行轨迹追加一条记录（tasks.trace JSON 数组）。 */
async function traceTask(taskId: number, title: string, detail = ''): Promise<void> {
  const db = getDb();
  const row = await db.prepare('SELECT trace FROM tasks WHERE id = ?').get<{ trace: string }>(taskId);
  if (!row) return;
  const trace = JSON.parse(row.trace || '[]') as TraceEntry[];
  trace.push({ seq: trace.length + 1, at: now(), title, detail });
  await db.prepare('UPDATE tasks SET trace = ? WHERE id = ?').run(JSON.stringify(trace), taskId);
}

export async function runTask(taskId: number, llm: LlmCall): Promise<void> {
  const db = getDb();
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get<TaskRow>(taskId);
  if (!task) return;

  const set = async (patch: Partial<TaskRow>): Promise<void> => {
    const fields = Object.entries(patch).filter(([k]) => k !== 'id');
    const sets = fields.map(([k]) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map(([, v]) => v), now(), taskId);
  };

  try {
    await set({ status: 'running', progress: 10, error: null });
    await traceTask(taskId, '任务开始', `${task.title}（${task.type}）`);
    const result = await execute(task, llm);
    await set({ status: 'done', progress: 100, result_summary: result });
    await traceTask(taskId, '任务完成', result);
  } catch (e) {
    await set({ status: 'failed', error: (e as Error).message.slice(0, 500), result_summary: null });
    await traceTask(taskId, '任务失败', (e as Error).message.slice(0, 500));
  }
}

async function execute(task: TaskRow, llm: LlmCall): Promise<string> {
  const db = getDb();
  const lib = task.library_id
    ? (await db.prepare('SELECT * FROM libraries WHERE id = ?').get<{ id: number; name: string; description: string; current_version: string; repo_url: string; last_commit: string }>(task.library_id))
    : undefined;
  if (!lib && task.library_id !== null && task.library_id !== undefined) {
    throw new Error(`三方库 #${task.library_id} 不存在`);
  }

  switch (task.type) {
    case 'pull_repo':
    case 'update_repo':
      return await repoTask(task, lib);
    case 'write_cases':
      return await writeCases(task, lib!, llm);
    case 'explore_cases':
      return await exploreCases(task, lib!, llm);
    case 'update_cases':
      return await updateCases(task, lib!, llm);
    case 'to_script':
      return await toScript(task, lib!, llm);
    default:
      throw new Error(`未知任务类型：${task.type}`);
  }
}

async function repoTask(task: TaskRow, lib?: { id: number; name: string; repo_url: string; current_version: string; last_commit: string }): Promise<string> {
  const db = getDb();
  const url = (task.input || '').trim();
  const looksLikeUrl = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(url);
  let target = lib;
  await traceTask(task.id, '解析仓库', target ? `库：${target.name}` : url || '（未指定）');
  if (!target && looksLikeUrl) {
    target = await ensureLibraryByRepoUrl(url);
    await db.prepare('UPDATE tasks SET library_id = ? WHERE id = ?').run(target.id, task.id);
    await traceTask(task.id, '自动创建三方库', `${target.name}（${url}）`);
  } else if (target && !target.repo_url && looksLikeUrl) {
    await db.prepare('UPDATE libraries SET repo_url = ?, updated_at = ? WHERE id = ?').run(url, now(), target.id);
    target = { ...target, repo_url: url };
  }
  if (!target) throw new Error('请选择三方库，或输入仓库地址（http/https/git/ssh URL）后重试。');
  const [r] = await withProgress(task.id, [
    [25, async () => (task.type === 'pull_repo' ? pullRepo(target) : updateRepo(target))],
  ]);
  await traceTask(task.id, task.type === 'pull_repo' ? 'git clone/pull 完成' : 'git 更新完成', r.summary);
  return r.summary;
}

async function promptFor(role: string, fallback: string): Promise<string> {
  const db = getDb();
  const row = await db.prepare(`SELECT content FROM prompts WHERE role = ? ORDER BY id LIMIT 1`).get<{ content: string }>(role);
  return row?.content ?? fallback;
}

/** 读取 Prompt 模板内容 + 绑定技能（用户可在 Prompt 管理中自定义技能说明）。 */
async function promptBundle(role: string, fallback: string): Promise<{ content: string; skill: string }> {
  const db = getDb();
  const row = await db.prepare(`SELECT content, skill FROM prompts WHERE role = ? ORDER BY id LIMIT 1`).get<{ content: string; skill: string }>(role);
  return { content: row?.content ?? fallback, skill: row?.skill ?? '' };
}

async function withProgress<T>(taskId: number, steps: Array<[number, () => Promise<T>]>): Promise<T[]> {
  const db = getDb();
  const out: T[] = [];
  for (const [pct, fn] of steps) {
    await db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(pct, now(), taskId);
    out.push(await fn());
  }
  return out;
}

// ---------- 用例生成公共层：归一化 / 自审进化 / 经验记忆 / 入库 ----------

interface DraftCase { name: string; source: string; precondition: string; steps: string[]; expected: string }

/** 用例生成 Agent 的内置兜底 Prompt（Prompt 管理里 role=用例生成 可覆盖）。 */
const CASE_GEN_FALLBACK = `你是鸿蒙三方库 UI 测试用例设计 Agent。基于已下载仓库的真实工程代码设计用例：
1. 解析 bundleName / mainAbility 与 entry/src/main/ets/pages 真实页面与控件；
2. 操作步骤必须是真实界面可触发的动作（打开应用 / 点击 / 输入 / 滑动 / 等待 / 验证文本或动画），严禁臆造；
3. 预期结果写明具体动画（Lottie json 名）、UI 表现与 hilog 日志；
4. 来源固定为 AI 生成；
5. 输出 JSON 数组：{ name, precondition, steps[], expected }，覆盖正向/边界/异常。
只输出 JSON，不要任何解释。`;

/** 自审评审标准（真实可操作 / 逻辑合理 / 预期明确清晰 / 覆盖完整）。 */
export const REVIEW_RUBRIC = `评审标准（逐条对照）：
1. 真实可操作：每个步骤在真实鸿蒙界面可触发，引用的控件/页面必须来自给定的界面数据，严禁臆造不存在的按钮、菜单或跳转；
2. 逻辑合理：步骤顺序符合真实用户操作路径，前置条件完整，无跳步、无重复步骤、场景间互不矛盾；
3. 预期结果明确清晰：可观察、可验证——具体到动画名/控件文本/回调 JSON 字段/hilog 日志内容，禁止「显示正常」「工作正常」等空泛描述；
4. 覆盖完整：对照给定界面数据逐个核对——目标范围内的主要可交互元素（按钮/开关/输入项/异常输入）都应有用例覆盖；预期证据在首屏之下（scrolls>0 或源码含滚动容器）而步骤没有「向上滑动查看输出区域」的，视为问题并在修订中补上。`;

/** 归一化 LLM 输出（兼容 title/preconditions/testCases 包装等自然形态）。 */
function normalizeDraftCases(parsed: unknown): DraftCase[] {
  const rawList: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? parsed as Array<Record<string, unknown>>
    : parsed && Array.isArray((parsed as { testCases?: unknown }).testCases)
      ? ((parsed as { testCases: unknown }).testCases as Array<Record<string, unknown>>)
      : parsed
        ? [parsed as Record<string, unknown>]
        : [];
  return rawList.map((r) => {
    const pre = r.preconditions ?? r.precondition ?? '';
    const exp = r.expected ?? '';
    const rawSteps = Array.isArray(r.steps) ? (r.steps as unknown[]) : [];
    const steps = rawSteps
      .map((s) => (typeof s === 'string' ? s : String((s as { step?: unknown })?.step ?? (s as { text?: unknown })?.text ?? (s as { expected?: unknown })?.expected ?? '')))
      .filter(Boolean);
    return {
      name: String(r.name ?? r.title ?? r.id ?? '未命名用例'),
      source: String(r.source ?? 'AI 生成'),
      precondition: Array.isArray(pre) ? (pre as string[]).join('；') : String(pre ?? ''),
      steps: steps.length > 0 ? steps : ['步骤待细化'],
      expected: typeof exp === 'string' ? exp : exp ? JSON.stringify(exp) : '',
    };
  });
}

/** 库级经验教训文件（自审发现的问题沉淀于此，后续生成时注入规避 → 自我进化）。 */
function lessonsFile(libName: string): string {
  return path.join(workspaceDir(), 'agent-memory', `${libName.replace(/[^\w.-]/g, '_')}_lessons.json`);
}

function loadLessons(libName: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(lessonsFile(libName), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(-20) : [];
  } catch { return []; }
}

function appendLessons(libName: string, issues: string[]): number {
  if (issues.length === 0) return 0;
  try {
    const file = lessonsFile(libName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = loadLessons(libName);
    const merged = [...prev, ...issues].filter((x, i, a) => a.indexOf(x) === i).slice(-20);
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged.length - prev.length;
  } catch { return 0; }
}

/**
 * 自审进化循环：评审 Agent 按标准挑毛病并直接修订草稿；发现的问题写入 agent-memory。
 * 轮次上限读系统配置 agent.caseReviewRounds（默认 2，0 = 关闭）。
 */
async function reviewAndRefine(
  taskId: number,
  llm: LlmCall,
  libName: string,
  cases: DraftCase[],
  sceneCtx: string,
): Promise<{ cases: DraftCase[]; fixedRounds: number }> {
  const maxRounds = Math.max(0, Math.min(4, Number(getSetting('agent.caseReviewRounds', 2)) || 0));
  let cur = cases;
  let fixed = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const sys = `你是测试用例评审 Agent。对给定用例草稿逐条审查并直接修订有问题的用例。\n${REVIEW_RUBRIC}\n只输出 JSON，不要解释：{ "pass": true|false, "issues": ["问题描述"], "cases": [{ "name": "...", "precondition": "...", "steps": ["..."], "expected": "..." }] }`;
    const user = `${sceneCtx}
用例草稿（共 ${cur.length} 条）：
${JSON.stringify(cur, null, 1)}
历史教训（修订时务必规避）：
${loadLessons(libName).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）'}`;
    try {
      const text = await llm({ system: sys, user, maxTokens: 4000 });
      const data = extractJson<{ pass?: boolean; issues?: unknown; cases?: unknown }>(text);
      const issues = Array.isArray(data.issues) ? data.issues.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 10) : [];
      const revised = normalizeDraftCases(data.cases);
      const passed = data.pass === true || issues.length === 0;
      await traceTask(taskId, `AI 自审 · 第 ${round} 轮`, passed
        ? '通过：未发现真实性问题'
        : `发现 ${issues.length} 处问题，已自动修订：\n${issues.map((s) => `· ${s}`).join('\n')}`);
      appendLessons(libName, issues);
      if (passed) break;
      if (revised.length > 0) { cur = revised; fixed++; }
    } catch (e) {
      await traceTask(taskId, `AI 自审 · 第 ${round} 轮异常`, `${(e as Error).message.slice(0, 200)}（保留当前草稿继续）`);
      break;
    }
  }
  return { cases: cur, fixedRounds: fixed };
}

/** 草稿入库：来源统一 AI 生成，V1 快照入 case_versions（author_type=ai），返回入库条数。 */
async function insertDraftCases(libraryId: number, rows: DraftCase[], note: string): Promise<number> {
  const db = getDb();
  const t = now();
  const inserted = await db.transaction(async () => {
    let n = 0;
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get<{ n: number }>(libraryId)) ?? { n: 0 };
    const maxCases = getSetting('agent.maxCasesPerTask', 20);
    for (const r of rows.slice(0, maxCases)) {
      const caseNo = `C-AI-${String(count.n + ++n).padStart(3, '0')}`;
      const res = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '待确认', '未绑定', 1, ?, ?)`).run(
        libraryId, caseNo, r.name, r.source || 'AI 生成', r.precondition, JSON.stringify(r.steps), r.expected, t, t,
      );
      const caseId = Number(res.lastInsertRowid);
      await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, ?, 'AI 用例生成 Agent', 'ai', ?)`).run(caseId, JSON.stringify({
        id: caseId, libraryId, caseNo, name: r.name, source: r.source || 'AI 生成',
        precondition: r.precondition, steps: r.steps, expected: r.expected,
        status: '待确认', scriptStatus: '未绑定', currentVersion: 1, createdAt: t, updatedAt: t,
      }), note, t);
    }
    return n;
  });
  return inserted;
}

async function writeCases(task: TaskRow, lib: RepoLib & { description: string }, llm: LlmCall): Promise<string> {
  // 确保仓库已下载到本地（真实代码上下文）
  const insp0 = inspectRepo(lib);
  if (!fs.existsSync(path.join(insp0.dir, '.git')) && lib.repo_url) {
    await pullRepo(lib);
    await traceTask(task.id, '拉取仓库', lib.repo_url);
  }
  const insp = inspectRepo(lib);
  await traceTask(task.id, '解析仓库工程', `bundleName=${insp.bundleName || '—'} · mainAbility=${insp.abilityName || 'EntryAbility'} · 页面=${insp.pages.join(', ') || '—'}`);

  // 定向目标：任务输入 → 命中页面文件（读真实源码）+ 命中遍历报告页（拿真实控件清单）
  const targets = pickTargetPages(task.input, insp.pages);
  let targetCode = '';
  for (const t of targets) {
    try {
      targetCode += `\n── 页面源码 ${t.file} ──\n${fs.readFileSync(path.join(insp.dir, 'entry', 'src', 'main', 'ets', 'pages', t.file), 'utf8').slice(0, 12000)}\n`;
    } catch { /* 忽略不可读文件 */ }
  }
  if (targetCode.length > 24000) targetCode = targetCode.slice(0, 24000) + '\n（源码过长已截断）';
  const exploreReport = latestExploreResult(lib.name);
  const terms = inputTerms(task.input);
  let hitExplorePages: ExploredPage[] = (exploreReport?.pages ?? [])
    .filter((pg) => terms.some((t) => normKey(pg.path.join('')).includes(t)))
    .slice(0, 3);
  // 关键词命中不了页面路径时（如中文功能描述 vs 英文页面名）→ 注入全部遍历页的紧凑清单，保证 AI 看得到真实控件
  let uiCtxScope = '命中目标页';
  if (hitExplorePages.length === 0 && (exploreReport?.pages.length ?? 0) > 0) {
    hitExplorePages = exploreReport!.pages.slice(0, 12);
    uiCtxScope = '全部遍历页（未命中具体页，供对照真实控件）';
  }
  const uiCtx = hitExplorePages.length > 0
    ? `【真机遍历对照数据 · ${uiCtxScope}】（最近一次真机遍历的真实 dump；步骤引用的控件文本必须来自这里或页面源码；scrolls>0 表示内容超一屏、预期证据可能要滑动后才可见）：
${JSON.stringify(hitExplorePages.map((pg) => ({ path: pg.path.join(' → '), controls: pg.controls.map((c) => (c.text || c.desc).trim()).filter(Boolean), scrolls: pg.scrolls ?? 0 })))}`
    : '';

  if (targets.length > 0) {
    await traceTask(task.id, '定位目标页面', `${targets.map((t) => t.file).join('、')}（按任务输入关键词命中，已读取真实源码）`);
  } else {
    await traceTask(task.id, '定向范围', `任务输入未命中具体页面文件，按通用工程结构设计（页面清单：${insp.pages.join(', ') || '—'}）`);
  }
  if (hitExplorePages.length > 0) {
    await traceTask(task.id, '关联真机遍历数据', `命中 ${hitExplorePages.length} 个遍历页，真实控件清单已注入上下文`);
  }

  const repoContext = insp.bundleName || insp.pages.length > 0
    ? `已下载仓库目录：${insp.dir}
bundleName：${insp.bundleName || '（未解析到，尝试 AppScope/app.json5）'}
mainAbility：${insp.abilityName || '（未解析到，默认 EntryAbility）'}
全部页面文件：${insp.pages.join(', ') || '（未找到 entry/src/main/ets/pages）'}
${targets.length > 0 ? `\n定向命中的目标页面源码：\n${targetCode}` : `\n入口页代码（截取前 8000 字符）：\n${insp.entryDemo || '（无）'}`}
${uiCtx}`
    : '仓库未下载或未解析到工程结构，请基于库简介合理设计通用用例。';

  const sceneCtx = `三方库：${lib.name}
库版本：${lib.current_version}
库简介：${lib.description}
用户指定的测试目标：${task.input || '（未指定，请围绕工程核心功能面设计）'}
${repoContext}`;

  const tpl = await promptBundle('用例生成', CASE_GEN_FALLBACK);
  const directedAddendum = `

【定向用例设计模式】
1. 聚焦「用户指定的测试目标」深挖，不要发散到无关页面；目标未指明时围绕给定代码中最核心的功能面展开并说明选择理由；
2. 先枚举目标页面的全部可交互元素（源码中 ForEach/循环生成的按钮列表要逐项展开，对照真机遍历对照数据核对真实控件文本），再设计场景——严禁只挑前几个按钮；
3. 对目标做场景矩阵拆解后取 4-12 条：正向主流程 / 边界值 / 异常输入与状态（null/空串/非法值/超大数据）/ 交互组合 / 连续重复操作；
4. 页面内容超过一屏（scrolls>0 或源码含可滚动容器）时：涉及回调输出、日志区、动画状态等预期证据的用例，操作步骤必须包含「向上滑动查看输出区域」，预期结果写明滑动后应看到的证据内容（如回调 JSON 字段、日志文本）；
5. 预期结果写具体证据：动画名 / 控件文本 / 回调 JSON 字段 / hilog 日志内容，禁止空泛描述。`;
  const sys = `${tpl.content}${tpl.skill ? `\n\n【绑定技能】\n${tpl.skill}` : ''}${directedAddendum}`;
  const user = `${sceneCtx}
历史教训（生成时务必规避）：
${loadLessons(lib.name).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）'}`;
  // LLM 解析：首次失败用「精简模式」重试一次（防输出过长被截断）
  const sysCompact = `只输出一个 JSON 数组，不要任何解释、围栏或多余字段。4 条精简用例，每项仅：{ name, precondition, steps(≤4 步), expected }，steps/expected 简洁具体。`;
  let parsed: unknown = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const text = await llm(attempt === 0
        ? { system: sys, user, maxTokens: 4000 }
        : { system: sysCompact, user: `三方库：${lib.name}（${lib.current_version}）\n${repoContext}`, maxTokens: 2500 });
      await traceTask(task.id, `AI 返回（${text.length} 字符${lastLlmCall.model ? ` · ${lastLlmCall.provider}/${lastLlmCall.model}` : ''}）`, text.slice(0, 600));
      parsed = extractJson<unknown>(text);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!parsed) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  await getDb().prepare('UPDATE tasks SET progress = 35, updated_at = ? WHERE id = ?').run(now(), task.id);

  let rows = normalizeDraftCases(parsed);
  if (rows.length === 0) throw new Error('AI 未返回有效用例（JSON 解析失败）');
  await traceTask(task.id, '草稿解析完成', `${rows.length} 条草稿，进入自审进化循环`);

  // 自审进化：按「真实可操作 / 逻辑合理 / 预期明确清晰」修订，教训沉淀 agent-memory
  const reviewed = await reviewAndRefine(task.id, llm, lib.name, rows, sceneCtx);
  rows = reviewed.cases;
  if (rows.length === 0) throw new Error('自审后无有效用例');
  await getDb().prepare('UPDATE tasks SET progress = 70, updated_at = ? WHERE id = ?').run(now(), task.id);

  const inserted = await insertDraftCases(lib.id, rows, reviewed.fixedRounds > 0 ? `AI 生成（经 ${reviewed.fixedRounds} 轮自审修订）` : 'AI 生成初始创建');
  await traceTask(task.id, '写入用例库', `生成 ${rows.length} 条（自审修订 ${reviewed.fixedRounds} 轮），入库 ${inserted} 条（V1，状态：待确认）`);
  return `AI 已生成 ${rows.length} 条用例${reviewed.fixedRounds > 0 ? `（自审自动修订 ${reviewed.fixedRounds} 轮）` : ''}，入库 ${inserted} 条（V1，状态：待确认）。`;
}

/**
 * 真机遍历生成用例（explore_cases）：真机 BFS 遍历 → 遍历数据交给「用例生成 Agent」（Prompt 管理 content+skill）
 * 设计用例 → 自审进化循环修订 → 入库（来源=AI 生成）→ 同步产出遍历报告与 Hypium 工程。
 */
async function exploreCases(task: TaskRow, lib: RepoLib & { description: string }, llm: LlmCall): Promise<string> {
  const db = getDb();
  // 1. 设备与启动入口
  const online = await db.prepare(`SELECT serial FROM devices WHERE status = 'online' ORDER BY id LIMIT 1`).get<{ serial: string }>();
  const serial = online?.serial ?? '';
  if (!serial) throw new Error('没有在线真机，请先在设备管理页「识别设备」连接真机');
  if (!(await ensureDeviceOnline(serial))) throw new Error(`设备 ${serial} 不在线`);
  const libFull = await db.prepare('SELECT package_name, main_ability FROM libraries WHERE id = ?').get<{ package_name: string; main_ability: string }>(lib.id);
  let launchAbility = '';
  const pkg = String(libFull?.package_name ?? '').trim();
  const ability = String(libFull?.main_ability ?? '').trim();
  if (pkg) launchAbility = ability && !ability.includes('.') ? `${pkg}/${ability}` : pkg;
  if (!launchAbility) {
    try {
      const map = JSON.parse(String(getSetting('device.appAbilities', '{}') || '{}')) as Record<string, string>;
      launchAbility = map[lib.name] ?? '';
    } catch { /* 忽略 */ }
  }
  if (!launchAbility) launchAbility = lib.name;
  const bundle = pkg.split('/')[0] || launchAbility.split('/')[0] || lib.name;
  await traceTask(task.id, '真机遍历开始', `设备 ${serial} · bundle=${bundle} · 入口=${launchAbility} · 参数读系统配置 explore.*`);

  // 2. 真机 BFS 遍历（含双向滚动探索、状态栏过滤）
  const result = await exploreApp(serial, bundle, { launchAbility });
  saveExploreReport(lib.name, result);
  await refreshPackageInfo({ id: lib.id, name: lib.name });
  await getDb().prepare('UPDATE tasks SET progress = 40, updated_at = ? WHERE id = ?').run(now(), task.id);
  await traceTask(task.id, '遍历完成', `${result.pages.length} 个页面 · 去重页 ${result.visitedCount} · 耗时 ${Math.round(result.durationMs / 1000)}s\n报告已存 workspace/explore/${lib.name}/`);

  // 3. 遍历数据 → 用例生成 Agent（content + skill）
  const pagesCompact = result.pages.map((p) => ({
    path: p.path.join(' → '),
    controls: p.controls.map((c) => (c.text || c.desc).trim()).filter(Boolean).slice(0, 12),
    swipes: p.swipes,
    scrolls: p.scrolls ?? 0,
    animation: Boolean(p.animation),
  }));
  const sceneCtx = `三方库：${lib.name}（${lib.current_version}）
库简介：${lib.description}
【真机遍历数据】（真实 dump，唯一事实来源）：
${JSON.stringify(pagesCompact)}`;
  const exploreAddendum = `

【真机遍历数据驱动补充规则】
1. 只能基于上方【真机遍历数据】中出现的页面与控件设计用例；步骤引用的按钮/文本必须原样出现在对应页面的 controls 清单中；
2. 每个遍历到的页面至少 1 条正向用例（按 path 导航路径进入）；controls 数量多或 scrolls>0 的页面说明内容超一屏——涉及回调输出/日志区/动画状态的预期证据，步骤必须包含「向上滑动查看输出区域」，预期写明滑动后应看到的证据；
3. 预期结果写明具体控件文本与动画表现（越界动画页注明"滑动后完整可见"），可结合 hilog 日志断言；
4. 来源固定为 AI 生成。`;

  const tpl = await promptBundle('用例生成', CASE_GEN_FALLBACK);
  const sys = `${tpl.content}${tpl.skill ? `\n\n【绑定技能】\n${tpl.skill}` : ''}${exploreAddendum}`;
  const user = `${sceneCtx}
任务要求：${task.input || '基于遍历数据为每个页面设计可执行用例，交互丰富的页面补边界/异常场景。'}
历史教训（生成时务必规避）：
${loadLessons(lib.name).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）'}`;

  const sysCompact = `只输出一个 JSON 数组，不要任何解释、围栏或多余字段。4 条精简用例，每项仅：{ name, precondition, steps(≤4 步), expected }，步骤引用的控件必须来自遍历数据。`;
  let parsed: unknown = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const text = await llm(attempt === 0
        ? { system: sys, user, maxTokens: 4000 }
        : { system: sysCompact, user: sceneCtx, maxTokens: 2500 });
      await traceTask(task.id, `AI 返回（${text.length} 字符${lastLlmCall.model ? ` · ${lastLlmCall.provider}/${lastLlmCall.model}` : ''}）`, text.slice(0, 600));
      parsed = extractJson<unknown>(text);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!parsed) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  await getDb().prepare('UPDATE tasks SET progress = 65, updated_at = ? WHERE id = ?').run(now(), task.id);

  let rows = normalizeDraftCases(parsed);
  if (rows.length === 0) throw new Error('AI 未返回有效用例（JSON 解析失败）');
  await traceTask(task.id, '草稿解析完成', `${rows.length} 条草稿，进入自审进化循环`);

  // 4. 自审进化循环
  const reviewed = await reviewAndRefine(task.id, llm, lib.name, rows, sceneCtx);
  rows = reviewed.cases;
  if (rows.length === 0) throw new Error('自审后无有效用例');
  await getDb().prepare('UPDATE tasks SET progress = 80, updated_at = ? WHERE id = ?').run(now(), task.id);

  // 5. 入库（来源=AI 生成）+ Hypium 工程落盘
  const inserted = await insertDraftCases(lib.id, rows, `真机遍历 + 用例生成 Agent（自审修订 ${reviewed.fixedRounds} 轮）`);
  const project = writeHypiumProject({ name: lib.name, packageName: bundle }, result.pages, serial);
  await traceTask(task.id, '写入用例库', `入库 ${inserted} 条（V1，状态：待确认，来源=AI 生成）`);
  await traceTask(task.id, 'Hypium 工程已生成', project.dir);
  return `真机遍历 ${result.pages.length} 页 → AI 设计 ${rows.length} 条用例（自审修订 ${reviewed.fixedRounds} 轮），入库 ${inserted} 条（V1，来源=AI 生成）。Hypium：${project.dir}`;
}

async function updateCases(task: TaskRow, lib: RepoLib & { current_version: string }, llm: LlmCall): Promise<string> {
  const db = getDb();
  const samples = await db.prepare(`SELECT case_no, name FROM cases WHERE library_id = ? ORDER BY id LIMIT 10`).all<{ case_no: string; name: string }>(lib.id);
  const changes = recentChanges(lib);
  const changeCtx = changes.length > 0
    ? `自上次同步以来的仓库变更文件（前 20）：\n${changes.slice(0, 20).join('\n')}`
    : '（未检测到仓库变更，按版本号变更更新）';
  const tplUpd = await promptBundle('用例更新', `你是鸿蒙三方库测试用例更新 Agent。
根据三方库版本变更，迭代更新给定用例，输出 JSON 数组，每项包含：
caseNo(原用例编号), name(新名称), expected(更新后的预期), changeNote(更新点说明)。
只输出 JSON。`);
  const sys = tplUpd.skill ? `${tplUpd.content}\n\n【绑定技能】\n${tplUpd.skill}` : tplUpd.content;
  const user = `三方库：${lib.name}（${lib.current_version}）
${changeCtx}
现有用例：${JSON.stringify(samples)}
任务要求：${task.input || '根据最新版本变更更新上述用例（版本自动递增）。'}`;
  // 与 write_cases 相同的健壮性：首次解析失败用「精简模式」重试一次
  const sysCompactUpd = `只输出一个 JSON 数组，不要任何解释、围栏或多余字段。4 条精简建议，每项仅：{ caseNo, reason, suggestedAction, newExpected }，文本简洁。`;
  let updates: Array<{ caseNo: string; name?: string; expected?: string; changeNote?: string }> | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !updates; attempt++) {
    try {
      const text = await llm(attempt === 0
        ? { system: sys, user }
        : { system: sysCompactUpd, user: `三方库：${lib.name}（${lib.current_version}）\n${changeCtx}\n现有用例：${JSON.stringify(samples)}` });
      await traceTask(task.id, `AI 返回（${text.length} 字符${lastLlmCall.model ? ` · ${lastLlmCall.provider}/${lastLlmCall.model}` : ''}）`, text.slice(0, 600));
      updates = extractJson<Array<{ caseNo: string; name?: string; expected?: string; changeNote?: string }>>(text);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!updates) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  await getDb().prepare('UPDATE tasks SET progress = 40, updated_at = ? WHERE id = ?').run(now(), task.id);
  const t = now();
  let updated = 0;
  await db.transaction(async () => {
    for (const u of (Array.isArray(updates) ? updates : [])) {
      const row = await db.prepare('SELECT * FROM cases WHERE case_no = ? AND library_id = ?').get<{ id: number; current_version: number; name: string; expected: string; steps: string }>(u.caseNo, lib.id);
      if (!row) continue;
      const next = row.current_version + 1;
      const snapshot = {
        id: row.id, libraryId: lib.id, caseNo: u.caseNo, name: u.name ?? row.name,
        source: '问题单跟踪', precondition: '', steps: JSON.parse(row.steps),
        expected: u.expected ?? row.expected, status: '待确认', scriptStatus: '未绑定',
        currentVersion: next, createdAt: t, updatedAt: t,
      };
      await db.prepare(`UPDATE cases SET name=?, expected=?, current_version=?, updated_at=? WHERE id=?`).run(snapshot.name, snapshot.expected, next, t, row.id);
      await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, 'AI 用例更新 Agent', 'ai', ?)`).run(row.id, next, JSON.stringify(snapshot), u.changeNote ?? 'AI 自动更新：版本自动递增。', t);
      updated++;
    }
  });
  await traceTask(task.id, '写入用例库', `更新 ${updated} 条用例（版本自动递增）`);
  return `AI 已更新 ${updated} 条用例（版本自动递增，时间线完整）。`;
}

async function toScript(task: TaskRow, lib: { id: number; name: string }, llm: LlmCall): Promise<string> {
  const db = getDb();
  const cases = await db.prepare(`SELECT case_no, name, steps FROM cases WHERE library_id = ? AND script_status = '未绑定' ORDER BY id LIMIT 10`).all<{ case_no: string; name: string; steps: string }>(lib.id);
  if (cases.length === 0) return '没有未绑定脚本的用例，无需转换。';
  const sys = `你是鸿蒙 UI 自动化脚本生成 Agent（OpenHarmony）。
将测试用例转换为 TypeScript 自动化脚本骨架（基于 @ohos/hypium 或 UI 测试框架风格），
输出 JSON 数组，每项：{ caseNo, script }。script 为可直接使用的代码文本。只输出 JSON。`;
  const user = `三方库：${lib.name}
用例：${JSON.stringify(cases.map((c) => ({ ...c, steps: JSON.parse(c.steps) })))}`;
  const sysCompactScript = `只输出一个 JSON 数组，不要任何解释、围栏或多余字段。3 条精简脚本，每项仅：{ caseNo, script }，script 为简短 TS 骨架。`;
  let scripts: Array<{ caseNo: string; script: string }> | null = null;
  let lastErrScript: unknown = null;
  for (let attempt = 0; attempt < 2 && !scripts; attempt++) {
    try {
      const text = await llm(attempt === 0
        ? { system: sys, user }
        : { system: sysCompactScript, user: `三方库：${lib.name}\n用例：${JSON.stringify(cases.map((c) => ({ ...c, steps: JSON.parse(c.steps) })))}` });
      await traceTask(task.id, `AI 返回（${text.length} 字符${lastLlmCall.model ? ` · ${lastLlmCall.provider}/${lastLlmCall.model}` : ''}）`, text.slice(0, 600));
      scripts = extractJson<Array<{ caseNo: string; script: string }>>(text);
    } catch (e) {
      lastErrScript = e;
    }
  }
  if (!scripts) throw lastErrScript instanceof Error ? lastErrScript : new Error(String(lastErrScript));
  await getDb().prepare('UPDATE tasks SET progress = 45, updated_at = ? WHERE id = ?').run(now(), task.id);
  const t = now();
  const dir = path.join(workspaceDir(), 'scripts', lib.name.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  let bound = 0;
  const files: string[] = [];
  await db.transaction(async () => {
    for (const s of (Array.isArray(scripts) ? scripts : [])) {
      const row = await db.prepare('SELECT id, name FROM cases WHERE case_no = ? AND library_id = ?').get<{ id: number; name: string }>(s.caseNo, lib.id);
      if (!row) continue;
      await db.prepare(`UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?`).run(t, row.id);
      const file = path.join(dir, `${s.caseNo}.ts`);
      fs.writeFileSync(file, `// ${s.caseNo} — ${row.name}（${lib.name}）自动化脚本\n// 生成时间：${t} · AI 生成\n\n${s.script}\n`);
      files.push(file);
      bound++;
    }
  });
  await traceTask(task.id, '脚本落盘', `${bound} 个文件 → ${dir}`);
  return `AI 已生成 ${bound} 个自动化脚本并落盘到：${dir}\n文件：${files.map((f) => path.basename(f)).join(', ') || '—'}`;
}
