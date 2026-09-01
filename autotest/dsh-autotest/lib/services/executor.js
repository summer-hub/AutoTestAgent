// AI 任务执行器（DSH 插件版）：AI 调用经 ctx.llm（LlmCall 注入）
// write_cases / explore_cases / update_cases / to_script 为真实 LLM 调用；
// pull_repo / update_repo 走真实 git CLI（clone/pull + 变更解析）。
// 用例生成统一走「Prompt 管理」的用例生成 Agent（content + 绑定 skill），并带自审进化循环：
// 评审 Agent 按「真实可操作 / 逻辑合理 / 预期明确清晰」标准挑毛病 → 直接修订 → 教训沉淀到 agent-memory 供后续生成规避。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { ensureLibraryByRepoUrl, inspectRepo, pullRepo, recentChanges, refreshPackageInfo, updateRepo, workspaceDir, workspaceNotice } from './gitRepo.js';
import { getSetting } from './settings.js';
import { extractJson } from './llmHarness.js';
import { exploreApp, ensureDeviceOnline, saveExploreReport } from './uiExplorer.js';
import { hypiumProjectDir, writeCaseScript } from './hypiumGen.js';
import { dryRunCase, mergeFailureBriefs } from './dryRun.js';
import { listTargets } from './hdc.js';
// ---------- 定向用例设计（write_cases）辅助 ----------
const normKey = (s) => s.toLowerCase().replace(/[\s_\-./\\()（）]/g, '');
/** 从任务输入提取关键词（中英文词元）。 */
function inputTerms(input) {
    return input
        .split(/[^\w\u4e00-\u9fa5]+/)
        .map((t) => normKey(t))
        .filter((t) => t.length >= 2);
}
/** 任务输入 → 命中的页面文件列表（按匹配度排序，最多 2 个）。 */
function pickTargetPages(input, pages) {
    const terms = inputTerms(input);
    if (terms.length === 0 || pages.length === 0)
        return [];
    return pages
        .map((file) => {
        const pn = normKey(path.basename(file, '.ets'));
        let score = 0;
        for (const t of terms) {
            if (pn === t)
                score += 5;
            else if (pn.includes(t) || t.includes(pn))
                score += 2;
        }
        return { file, score };
    })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
}
/** 最新一次真机遍历报告（无则 null，不强制要求设备/遍历过）。 */
function latestExploreResult(libName) {
    try {
        const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
        const files = fs.readdirSync(dir).filter((f) => /^explore_\d+\.json$/.test(f)).sort();
        if (files.length === 0)
            return null;
        return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    }
    catch {
        return null;
    }
}
/** 往任务的 AI 执行轨迹追加一条记录（tasks.trace JSON 数组）。 */
async function traceTask(taskId, title, detail = '') {
    const db = getDb();
    const row = await db.prepare('SELECT trace FROM tasks WHERE id = ?').get(taskId);
    if (!row)
        return;
    const trace = JSON.parse(row.trace || '[]');
    trace.push({ seq: trace.length + 1, at: now(), title, detail });
    await db.prepare('UPDATE tasks SET trace = ? WHERE id = ?').run(JSON.stringify(trace), taskId);
}
export async function runTask(taskId, llm) {
    const db = getDb();
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task)
        return;
    const set = async (patch) => {
        const fields = Object.entries(patch).filter(([k]) => k !== 'id');
        const sets = fields.map(([k]) => `${k} = ?`).join(', ');
        await db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map(([, v]) => v), now(), taskId);
    };
    try {
        await set({ status: 'running', progress: 10, error: null });
        await traceTask(taskId, '任务开始', `${task.title}（${task.type}）`);
        // 未配置工作区路径 → 明确提示（仍按回退目录继续执行）
        const wn = workspaceNotice();
        if (wn)
            await traceTask(taskId, '工作区提示', wn);
        const result = await execute(task, llm);
        await set({ status: 'done', progress: 100, result_summary: result });
        await traceTask(taskId, '任务完成', result);
    }
    catch (e) {
        await set({ status: 'failed', error: e.message.slice(0, 500), result_summary: null });
        await traceTask(taskId, '任务失败', e.message.slice(0, 500));
    }
}
async function execute(task, llm) {
    const db = getDb();
    const lib = task.library_id
        ? (await db.prepare('SELECT * FROM libraries WHERE id = ?').get(task.library_id))
        : undefined;
    if (!lib && task.library_id !== null && task.library_id !== undefined) {
        throw new Error(`三方库 #${task.library_id} 不存在`);
    }
    switch (task.type) {
        case 'pull_repo':
        case 'update_repo':
            return await repoTask(task, lib);
        case 'write_cases':
            return await writeCases(task, lib, llm);
        case 'explore_cases':
            return await exploreCases(task, lib, llm);
        case 'update_cases':
            return await updateCases(task, lib, llm);
        case 'to_script':
            return await toScript(task, lib, llm);
        default:
            throw new Error(`未知任务类型：${task.type}`);
    }
}
async function repoTask(task, lib) {
    const db = getDb();
    const url = (task.input || '').trim();
    const looksLikeUrl = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(url);
    let target = lib;
    await traceTask(task.id, '解析仓库', target ? `库：${target.name}` : url || '（未指定）');
    if (!target && looksLikeUrl) {
        target = await ensureLibraryByRepoUrl(url);
        await db.prepare('UPDATE tasks SET library_id = ? WHERE id = ?').run(target.id, task.id);
        await traceTask(task.id, '自动创建三方库', `${target.name}（${url}）`);
    }
    else if (target && !target.repo_url && looksLikeUrl) {
        await db.prepare('UPDATE libraries SET repo_url = ?, updated_at = ? WHERE id = ?').run(url, now(), target.id);
        target = { ...target, repo_url: url };
    }
    if (!target)
        throw new Error('请选择三方库，或输入仓库地址（http/https/git/ssh URL）后重试。');
    const [r] = await withProgress(task.id, [
        [25, async () => (task.type === 'pull_repo' ? pullRepo(target) : updateRepo(target))],
    ]);
    await traceTask(task.id, task.type === 'pull_repo' ? 'git clone/pull 完成' : 'git 更新完成', r.summary);
    return r.summary;
}
async function promptFor(role, fallback) {
    const db = getDb();
    const row = await db.prepare(`SELECT content FROM prompts WHERE role = ? ORDER BY id LIMIT 1`).get(role);
    return row?.content ?? fallback;
}
/** 读取 Prompt 模板内容 + 绑定技能（用户可在 Prompt 管理中自定义技能说明）。 */
async function promptBundle(role, fallback) {
    const db = getDb();
    const row = await db.prepare(`SELECT content, skill FROM prompts WHERE role = ? ORDER BY id LIMIT 1`).get(role);
    return { content: row?.content ?? fallback, skill: row?.skill ?? '' };
}
async function withProgress(taskId, steps) {
    const db = getDb();
    const out = [];
    for (const [pct, fn] of steps) {
        await db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(pct, now(), taskId);
        out.push(await fn());
    }
    return out;
}
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
/** 预期证据强化规则（动画/视频/图片等媒体类库必须落到可断言的具体证据），注入所有用例生成/优化场景。 */
export const EVIDENCE_RULE = `

【预期证据强化 · 媒体类库专项】动画、视频、图片类库的预期结果禁止「播放正常」「加载成功」式描述，必须给出至少一个可断言的具体证据：
- 从 demo 源码提取资源名（如 lottie json 文件名、图片 URL/base64 标识）、加载成功/失败回调的字段名与取值、hilog 关键字；
- 图片类：写明来源形态（base64/URL/文件路径）与成功回调 JSON 字段（如 code=0/message）或失败态文案；
- 动画类：写明资源文件、循环/进度表现、播放完成回调字段；
- 视频类：写明起播/暂停/完成的状态回调或日志标记；
- 每条 expected 至少包含一个可在界面文本或 hilog 中断言的具体字符串；对应自动化脚本将生成 assert_component_exist 断言。`;
/** 步骤句式契约：与 hypiumGen.stepToPython 的确定性映射一一对应，注入所有用例生成/优化场景。 */
export const STEP_CONTRACT = `

【步骤句式契约】操作步骤必须逐字使用以下句式之一（自动化脚本按句式确定性映射为 Hypium 调用，其他措辞将无法执行）：
- 打开应用
- 点击「控件文本」
- 输入「内容」到「控件文本」
- 等待 N 秒（N 为数字）
- 上滑 / 下滑
- 返回
- 验证「预期出现的控件文本或输出文本」
「控件文本」必须逐字来自给定页面的控件清单；不要发明其他动词句式、不要省略「」引用。`;
/** 归一化 LLM 输出（兼容 title/preconditions/testCases 包装等自然形态）。 */
function normalizeDraftCases(parsed) {
    const rawList = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.testCases)
            ? parsed.testCases
            : parsed
                ? [parsed]
                : [];
    return rawList.map((r) => {
        const pre = r.preconditions ?? r.precondition ?? '';
        const exp = r.expected ?? '';
        const pp = r.pagePath ?? r.page_path;
        const rawSteps = Array.isArray(r.steps) ? r.steps : [];
        const steps = rawSteps
            .map((s) => (typeof s === 'string' ? s : String(s?.step ?? s?.text ?? s?.expected ?? '')))
            .filter(Boolean);
        return {
            name: String(r.name ?? r.title ?? r.id ?? '未命名用例'),
            source: String(r.source ?? 'AI 生成'),
            precondition: Array.isArray(pre) ? pre.join('；') : String(pre ?? ''),
            steps: steps.length > 0 ? steps : ['步骤待细化'],
            expected: typeof exp === 'string' ? exp : exp ? JSON.stringify(exp) : '',
            pagePath: Array.isArray(pp) ? pp.join(' → ') : pp ? String(pp) : undefined,
        };
    });
}
/** 库级经验教训文件（自审发现的问题沉淀于此，后续生成时注入规避 → 自我进化）。 */
function lessonsFile(libName) {
    return path.join(workspaceDir(), 'agent-memory', `${libName.replace(/[^\w.-]/g, '_')}_lessons.json`);
}
// ---------- 确定性校验（guardrail）：纯代码可判定，先于 LLM 自审 ----------
const normLabel = (s) => s.replace(/\s+/g, '').toLowerCase();
/** 提取动作步骤中「」引用的控件文本（仅点击/输入类需要存在于控件清单；验证类豁免——输出/日志文本不要求是控件）。 */
function stepControlRefs(step) {
    const d = step.trim();
    if (!/^(点击|单击|选择|选中|切换|勾选|长按|输入|键入|填写|滚动到)/.test(d))
        return [];
    // 二段式「输入「内容」到「控件」」：只有后半段是控件引用，前半段是输入文本，不能参与控件校验
    const twoPart = d.match(/^(?:输入|键入|填写)\s*[「"](.+?)[」"]\s*(?:到|至|进入|在)\s*[「"](.+?)[」"]/);
    if (twoPart)
        return [twoPart[2].trim()].filter(Boolean);
    return [...d.matchAll(/「([^「」]{1,40})」/g)].map((m) => m[1].trim()).filter(Boolean);
}
/**
 * 校验草稿用例的控件引用真实性：点击/输入类步骤引用的「控件文本」必须存在于对应页 controls 清单
 * （支持子串双向匹配，容忍「播放」vs「播放按钮」这类前缀差异）。违规用例丢弃并返回原因。
 */
export function validateDraftsAgainstPages(rows, pagesByPath) {
    const kept = [];
    const dropped = [];
    for (const r of rows) {
        const page = r.pagePath ? pagesByPath.get(r.pagePath) : undefined;
        if (!page) {
            kept.push(r);
            continue;
        } // 无页面上下文（非遍历来源）不做控件校验
        const controls = page.controls.map(normLabel);
        const bad = [];
        for (const step of r.steps) {
            for (const ref of stepControlRefs(step)) {
                const key = normLabel(ref);
                // 子串匹配要求控件文本 ≥2 字，否则单字符控件会让 includes 恒真、校验形同虚设
                const hit = key && controls.some((c) => c === key || (c.length >= 2 && (c.includes(key) || key.includes(c))));
                if (!hit)
                    bad.push(`步骤「${step.slice(0, 30)}」引用的控件「${ref}」不在页面控件清单`);
            }
        }
        if (bad.length > 0)
            dropped.push({ row: r, name: r.name, reason: bad.join('；') });
        else
            kept.push(r);
    }
    return { kept, dropped };
}
/**
 * 违规用例定向修复：把 guardrail 检出的用例连同「该页真实控件清单」回灌 LLM 重写一次，
 * 复检后仍不合格才丢弃 —— 既保住数量，又不留不可执行的用例。
 */
async function repairDrafts(taskId, llm, offenders, pagesByPath) {
    if (offenders.length === 0)
        return { kept: [], dropped: [] };
    const payload = offenders.map(({ row, reason }, i) => ({
        index: i + 1,
        name: row.name,
        precondition: row.precondition,
        pagePath: row.pagePath ?? '',
        steps: row.steps,
        expected: row.expected,
        问题: reason,
        该页真实控件清单: (row.pagePath ? pagesByPath.get(row.pagePath)?.controls : undefined) ?? [],
    }));
    const sys = `你是测试用例修复 Agent。下列用例存在「引用了界面上根本不存在的控件」的问题，请依据每条给出的【该页真实控件清单】重写 steps。
${STEP_CONTRACT}
【硬性要求】
1. steps 中所有「控件文本」必须逐字来自对应的控件清单，禁止沿用不存在的控件名；
2. 保持原用例的测试意图与覆盖目标不变，只替换控件引用；清单中确无可替代控件时删除该步骤；
3. pagePath 必须原样保留；steps 可为空数组（表示整条无法修复）。
只输出一个 JSON 数组，每项：{ index, name, precondition, steps[], expected, pagePath }，不要解释。`;
    try {
        const { text } = await llm({ system: sys, user: JSON.stringify(payload, null, 1), maxTokens: 4000, meta: { taskId, kind: 'repair_drafts' } });
        const data = extractJson(text);
        const rawArr = Array.isArray(data) ? data : [];
        const norm = normalizeDraftCases(rawArr);
        const byIndex = new Map();
        rawArr.forEach((r, i) => {
            const idx = Number(r.index ?? i + 1);
            if (!Number.isFinite(idx) || !norm[i])
                return;
            byIndex.set(idx, { ...norm[i], pagePath: norm[i].pagePath ?? offenders[idx - 1]?.row.pagePath });
        });
        const repaired = [];
        for (let i = 0; i < offenders.length; i++) {
            const cand = byIndex.get(i + 1);
            // 修复后步骤为空 = 模型判定无法修复，视为丢弃
            if (cand && cand.steps.length > 0 && cand.steps[0] !== '步骤待细化')
                repaired.push(cand);
        }
        const recheck = validateDraftsAgainstPages(repaired, pagesByPath);
        await traceTask(taskId, '违规用例定向修复', `提交 ${offenders.length} 条，重写后复检通过 ${recheck.kept.length} 条，仍不合格 ${recheck.dropped.length} 条（丢弃）`);
        return { kept: recheck.kept, dropped: recheck.dropped };
    }
    catch (e) {
        await traceTask(taskId, '违规用例定向修复异常', `${e.message.slice(0, 200)}（按原判定丢弃）`);
        return { kept: [], dropped: offenders.map((o) => ({ row: o.row, name: o.row.name, reason: o.reason })) };
    }
}
function loadLessons(libName) {
    try {
        const raw = JSON.parse(fs.readFileSync(lessonsFile(libName), 'utf8'));
        return Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(-20) : [];
    }
    catch {
        return [];
    }
}
function appendLessons(libName, issues) {
    if (issues.length === 0)
        return 0;
    try {
        const file = lessonsFile(libName);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const prev = loadLessons(libName);
        const merged = [...prev, ...issues].filter((x, i, a) => a.indexOf(x) === i).slice(-20);
        fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
        return merged.length - prev.length;
    }
    catch {
        return 0;
    }
}
/**
 * 自审进化循环（增量合并版）：评审 Agent 只输出需要修订的条目（带 1-based index），
 * 按 index 替换对应草稿；解析失败或 revised 无合法 index 时保留原稿——绝不整表替换，
 * 从机制上消灭「评审输出截断 → 残缺列表覆盖完整草稿」的丢用例问题。
 * 发现的问题写入 agent-memory。轮次上限读系统配置 agent.caseReviewRounds（默认 2，0 = 关闭）。
 */
async function reviewAndRefine(taskId, llm, libName, cases, sceneCtx) {
    const maxRounds = Math.max(0, Math.min(4, Number(getSetting('agent.caseReviewRounds', 2)) || 0));
    let cur = cases;
    let fixed = 0;
    for (let round = 1; round <= maxRounds; round++) {
        const sys = `你是测试用例评审 Agent。逐条审查草稿，只输出需要修订的条目。
${REVIEW_RUBRIC}
输出 JSON：{ "pass": true|false, "issues": ["问题描述"], "revised": [ { "index": 草稿序号(从1开始), "name": "...", "precondition": "...", "steps": ["..."], "expected": "..." } ] }
revised 只包含有问题的条目；pass 的条目不要重复输出。只输出 JSON，不要解释。`;
        const user = `${sceneCtx}
用例草稿（共 ${cur.length} 条；revised.index 对应下方序号）：
${cur.map((c, i) => `${i + 1}. ${JSON.stringify({ name: c.name, precondition: c.precondition, steps: c.steps, expected: c.expected, pagePath: c.pagePath })}`).join('\n')}
历史教训（修订时务必规避）：
${loadLessons(libName).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）'}`;
        try {
            const { text } = await llm({ system: sys, user, maxTokens: 6000, meta: { taskId, kind: 'review_refine' } });
            const data = extractJson(text);
            const issues = Array.isArray(data.issues) ? data.issues.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 10) : [];
            const passed = data.pass === true || issues.length === 0;
            // 增量合并：只按 index 替换对应条目
            const revisedItems = Array.isArray(data.revised) ? data.revised : [];
            let merged = 0;
            const next = [...cur];
            for (const item of revisedItems) {
                const idx = Number(item.index);
                if (!Number.isInteger(idx) || idx < 1 || idx > cur.length)
                    continue;
                const norm = normalizeDraftCases([item])[0];
                if (!norm || norm.steps.length === 0)
                    continue;
                norm.pagePath = cur[idx - 1].pagePath; // 溯源字段不随评审丢失
                next[idx - 1] = norm;
                merged++;
            }
            await traceTask(taskId, `AI 自审 · 第 ${round} 轮`, passed
                ? '通过：未发现真实性问题'
                : `发现 ${issues.length} 处问题，增量修订 ${merged} 条：\n${issues.map((s) => `· ${s}`).join('\n')}`);
            appendLessons(libName, issues);
            if (passed)
                break;
            if (merged > 0) {
                cur = next;
                fixed++;
            }
        }
        catch (e) {
            await traceTask(taskId, `AI 自审 · 第 ${round} 轮异常`, `${e.message.slice(0, 200)}（保留当前草稿继续，不整表替换）`);
            break;
        }
    }
    return { cases: cur, fixedRounds: fixed };
}
/** 草稿入库：来源统一 AI 生成，V1 快照入 case_versions（含 pagePath 溯源），返回创建的用例行（供绑定脚本）。
 * maxOverride：遍历场景按「页数×每页配额」计算的动态上限，避免固定 20 条硬截断。 */
async function insertDraftCases(libraryId, rows, note, maxOverride) {
    const db = getDb();
    const t = now();
    const created = [];
    await db.transaction(async () => {
        let n = 0;
        const count = (await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get(libraryId)) ?? { n: 0 };
        const maxCases = maxOverride ?? getSetting('agent.maxCasesPerTask', 20);
        for (const r of rows.slice(0, maxCases)) {
            const caseNo = `C-AI-${String(count.n + ++n).padStart(3, '0')}`;
            const res = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '待确认', '未绑定', 1, ?, ?)`).run(libraryId, caseNo, r.name, r.source || 'AI 生成', r.precondition, JSON.stringify(r.steps), r.expected, t, t);
            const caseId = Number(res.lastInsertRowid);
            await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, ?, 'AI 用例生成 Agent', 'ai', ?)`).run(caseId, JSON.stringify({
                id: caseId, libraryId, caseNo, name: r.name, source: r.source || 'AI 生成',
                precondition: r.precondition, steps: r.steps, expected: r.expected,
                pagePath: r.pagePath ?? '', // 溯源：本用例来自哪个遍历页面（优化 Agent 据此定向取上下文）
                status: '待确认', scriptStatus: '未绑定', currentVersion: 1, createdAt: t, updatedAt: t,
            }), note, t);
            created.push({ id: caseId, caseNo, name: r.name, steps: r.steps });
        }
    });
    return created;
}
/** 为一批新建用例生成并写入 Hypium（Python）绑定脚本。 */
async function bindHypiumScripts(lib, packageName, created) {
    if (created.length === 0)
        return 0;
    const hlib = { name: lib.name, packageName: packageName || lib.name };
    let bound = 0;
    for (const c of created) {
        try {
            writeCaseScript(hlib, { caseNo: c.caseNo, name: c.name, steps: c.steps });
            await getDb().prepare(`UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?`).run(now(), c.id);
            bound++;
        }
        catch (e) {
            console.warn(`[hypium] 绑定脚本失败 ${c.caseNo}:`, e.message);
        }
    }
    return bound;
}
// ---------- dry-run 闭环（execution as ground truth） ----------
/** 依据 dry-run 真机失败证据重写用例：保持测试意图，只改在真机上跑不通的步骤，并重新绑定脚本 + 记新版本。 */
async function repairFromDryRun(taskId, llm, lib, packageName, brief, offenders) {
    const sys = `你是测试用例修复 Agent。下列用例已在鸿蒙设备/模拟器上真实执行，部分步骤执行失败。
${STEP_CONTRACT}
【硬性要求】
1. 依据每条失败步骤给出的【当时界面实际可见控件】重写步骤，禁止引用界面上不存在的控件；
2. 从可见控件推断不出等价操作时，删除该步骤，而不是臆造控件或跳转；
3. 保持原用例的测试意图与覆盖目标不变；
4. 验证类步骤的断言对象必须是真实会出现在界面或 hilog 中的文本。
只输出一个 JSON 数组，每项：{ caseNo, name, precondition, steps[], expected }，不要解释。`;
    let parsed = null;
    try {
        parsed = extractJson((await llm({ system: sys, user: brief, maxTokens: 4000, meta: { taskId, kind: 'repair_dry_run' } })).text);
    }
    catch (e) {
        await traceTask(taskId, 'dry-run 回灌修订失败', e.message.slice(0, 200));
        return 0;
    }
    const rawArr = Array.isArray(parsed) ? parsed : [];
    const norm = normalizeDraftCases(rawArr);
    const byCaseNo = new Map();
    rawArr.forEach((r, i) => {
        const no = String(r.caseNo ?? r.case_no ?? '').trim();
        if (no && norm[i])
            byCaseNo.set(no, norm[i]);
    });
    const db = getDb();
    const t = now();
    const hlib = { name: lib.name, packageName: packageName || lib.name };
    let n = 0;
    for (const o of offenders) {
        const fix = byCaseNo.get(o.caseNo);
        if (!fix || fix.steps.length === 0 || fix.steps[0] === '步骤待细化')
            continue;
        const cur = await db.prepare('SELECT * FROM cases WHERE id = ?').get(o.id);
        if (!cur)
            continue;
        const next = Number(cur.current_version ?? 1) + 1;
        const name = fix.name || String(cur.name ?? o.name);
        const precondition = fix.precondition || String(cur.precondition ?? '');
        const expected = fix.expected || String(cur.expected ?? '');
        const steps = fix.steps;
        const snapshot = {
            id: o.id, libraryId: cur.library_id, caseNo: o.caseNo, name, source: cur.source ?? 'AI 生成',
            precondition, steps, expected, status: cur.status ?? '待确认', scriptStatus: '已绑定',
            currentVersion: next, createdAt: cur.created_at, updatedAt: t,
        };
        await db.transaction(async () => {
            await db.prepare(`UPDATE cases SET name=?, precondition=?, steps=?, expected=?, current_version=?, script_status=?, updated_at=? WHERE id=?`)
                .run(name, precondition, JSON.stringify(steps), expected, next, '已绑定', t, o.id);
            await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, 'AI dry-run 回灌 Agent', 'ai', ?)`)
                .run(o.id, next, JSON.stringify(snapshot), `【dry-run 回灌】依据真机执行失败证据重写步骤（自 v${next - 1}），脚本已重新绑定。`, t);
        });
        try {
            writeCaseScript(hlib, { caseNo: o.caseNo, name, steps });
        }
        catch { /* 绑脚本失败不影响用例修订 */ }
        n++;
    }
    return n;
}
/**
 * 入库用例在设备上真跑一遍，把失败证据（含当时界面真实控件清单）回灌 LLM 重写。
 * harness 核心：执行器为真 —— 真机执行结果比任何 LLM 自审都硬。
 */
async function dryRunAndRepair(taskId, llm, lib, created, packageName) {
    const none = { ran: 0, passed: 0, repaired: 0 };
    if (getSetting('agent.dryRunEnabled', true) !== true || created.length === 0)
        return none;
    const maxCases = Math.max(1, Number(getSetting('agent.dryRunMaxCases', 5)) || 5);
    const perStep = Math.max(3000, Number(getSetting('agent.dryRunPerStepTimeoutMs', 15000)) || 15000);
    const streakStop = Math.max(1, Number(getSetting('agent.dryRunFailStreakStop', 2)) || 2);
    let serial = '';
    try {
        serial = (await listTargets())[0] ?? '';
    }
    catch { /* 无 hdc 或设备离线 */ }
    if (!serial) {
        await traceTask(taskId, 'dry-run 跳过', '未检测到在线设备（hdc list targets 为空），用例按生成结果入库');
        return none;
    }
    const batch = created.slice(0, maxCases);
    await getDb().prepare('UPDATE tasks SET progress = 85, updated_at = ? WHERE id = ?').run(now(), taskId);
    await traceTask(taskId, 'dry-run 开始', `设备 ${serial} · 对 ${batch.length}/${created.length} 条入库用例执行真机试跑`);
    const results = [];
    let passed = 0;
    for (const c of batch) {
        try {
            const r = await dryRunCase(c.caseNo, c.name, c.steps, serial, {
                launch: packageName || lib.name,
                perStepTimeoutMs: perStep,
                failStreakStop: streakStop,
            });
            if (r.passed)
                passed++;
            results.push({ c, brief: r.failureBrief, passed: r.passed });
            await traceTask(taskId, r.passed ? `dry-run 通过 · ${c.caseNo}` : `dry-run 失败 · ${c.caseNo}`, r.logs.join('\n').slice(-1500));
        }
        catch (e) {
            results.push({ c, brief: '', passed: false });
            await traceTask(taskId, `dry-run 异常 · ${c.caseNo}`, e.message.slice(0, 200));
        }
    }
    const failedCases = results.filter((r) => !r.passed);
    const brief = mergeFailureBriefs(failedCases.map((r) => ({ caseNo: r.c.caseNo, name: r.c.name, brief: r.brief })));
    if (!brief) {
        await traceTask(taskId, 'dry-run 闭环完成', `${batch.length} 条试跑全部通过，无需回灌修订`);
        return { ran: batch.length, passed, repaired: 0 };
    }
    const repaired = await repairFromDryRun(taskId, llm, lib, packageName, brief, failedCases.map((r) => r.c));
    await traceTask(taskId, 'dry-run 闭环完成', `${batch.length} 条试跑：${passed} 条通过，${failedCases.length} 条失败，依据真机证据重写 ${repaired} 条（脚本已重新绑定）`);
    return { ran: batch.length, passed, repaired };
}
async function writeCases(task, lib, llm) {
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
        }
        catch { /* 忽略不可读文件 */ }
    }
    if (targetCode.length > 24000)
        targetCode = targetCode.slice(0, 24000) + '\n（源码过长已截断）';
    const exploreReport = latestExploreResult(lib.name);
    const terms = inputTerms(task.input);
    let hitExplorePages = (exploreReport?.pages ?? [])
        .filter((pg) => terms.some((t) => normKey(pg.path.join('')).includes(t)))
        .slice(0, 3);
    // 关键词命中不了页面路径时（如中文功能描述 vs 英文页面名）→ 注入全部遍历页的紧凑清单，保证 AI 看得到真实控件
    let uiCtxScope = '命中目标页';
    if (hitExplorePages.length === 0 && (exploreReport?.pages.length ?? 0) > 0) {
        hitExplorePages = exploreReport.pages.slice(0, 12);
        uiCtxScope = '全部遍历页（未命中具体页，供对照真实控件）';
    }
    const uiCtx = hitExplorePages.length > 0
        ? `【真机遍历对照数据 · ${uiCtxScope}】（最近一次真机遍历的真实 dump；步骤引用的控件文本必须来自这里或页面源码；scrolls>0 表示内容超一屏、预期证据可能要滑动后才可见）：
${JSON.stringify(hitExplorePages.map((pg) => ({ path: pg.path.join(' → '), controls: pg.controls.map((c) => (c.text || c.desc).trim()).filter(Boolean), scrolls: pg.scrolls ?? 0 })))}`
        : '';
    if (targets.length > 0) {
        await traceTask(task.id, '定位目标页面', `${targets.map((t) => t.file).join('、')}（按任务输入关键词命中，已读取真实源码）`);
    }
    else {
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
    const sys = `${tpl.content}${tpl.skill ? `\n\n【绑定技能】\n${tpl.skill}` : ''}${directedAddendum}${STEP_CONTRACT}${EVIDENCE_RULE}`;
    const user = `${sceneCtx}
历史教训（生成时务必规避）：
${loadLessons(lib.name).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）'}`;
    // LLM 解析失败重试：同要求重试（仅强化「只输出 JSON」指令），不降级用例数量
    const sysStrict = `${sys}\n\n严格只输出一个 JSON 数组（首字符必须是 [），不要围栏、不要解释、不要多余字段。`;
    let parsed = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
            const { text, provider, model } = await llm(attempt === 0
                ? { system: sys, user, maxTokens: 6000, meta: { taskId: task.id, kind: 'write_cases' } }
                : { system: sysStrict, user, maxTokens: 6000, meta: { taskId: task.id, kind: 'write_cases' } });
            await traceTask(task.id, `AI 返回（${text.length} 字符 · ${provider}/${model}）`, text.slice(0, 600));
            parsed = extractJson(text);
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (!parsed)
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    await getDb().prepare('UPDATE tasks SET progress = 35, updated_at = ? WHERE id = ?').run(now(), task.id);
    let rows = normalizeDraftCases(parsed);
    if (rows.length === 0)
        throw new Error('AI 未返回有效用例（JSON 解析失败）');
    await traceTask(task.id, '草稿解析完成', `${rows.length} 条草稿，进入自审进化循环`);
    // 自审进化：按「真实可操作 / 逻辑合理 / 预期明确清晰」修订，教训沉淀 agent-memory
    const reviewed = await reviewAndRefine(task.id, llm, lib.name, rows, sceneCtx);
    rows = reviewed.cases;
    if (rows.length === 0)
        throw new Error('自审后无有效用例');
    await getDb().prepare('UPDATE tasks SET progress = 70, updated_at = ? WHERE id = ?').run(now(), task.id);
    // 入库（来源=AI 生成）+ 同步绑定 Hypium(Python) 脚本
    const created = await insertDraftCases(lib.id, rows, reviewed.fixedRounds > 0 ? `AI 生成（经 ${reviewed.fixedRounds} 轮自审修订）` : 'AI 生成初始创建');
    const bound = await bindHypiumScripts(lib, insp.bundleName || '', created);
    await traceTask(task.id, '写入用例库', `生成 ${rows.length} 条（自审修订 ${reviewed.fixedRounds} 轮），入库 ${created.length} 条，绑定 Python 脚本 ${bound} 条（V1，状态：待确认）`);
    return `AI 已生成 ${rows.length} 条用例${reviewed.fixedRounds > 0 ? `（自审自动修订 ${reviewed.fixedRounds} 轮）` : ''}，入库 ${created.length} 条并绑定 Hypium 脚本 ${bound} 条（V1）。`;
}
/**
 * 真机遍历生成用例（explore_cases）：真机 BFS 遍历 → 遍历数据交给「用例生成 Agent」（Prompt 管理 content+skill）
 * 设计用例 → 自审进化循环修订 → 入库（来源=AI 生成）→ 同步产出遍历报告与 Hypium 工程。
 */
async function exploreCases(task, lib, llm) {
    const db = getDb();
    // 1. 设备与启动入口
    const online = await db.prepare(`SELECT serial FROM devices WHERE status = 'online' ORDER BY id LIMIT 1`).get();
    const serial = online?.serial ?? '';
    if (!serial)
        throw new Error('没有在线真机，请先在设备管理页「识别设备」连接真机');
    if (!(await ensureDeviceOnline(serial)))
        throw new Error(`设备 ${serial} 不在线`);
    const libFull = await db.prepare('SELECT package_name, main_ability FROM libraries WHERE id = ?').get(lib.id);
    let launchAbility = '';
    const pkg = String(libFull?.package_name ?? '').trim();
    const ability = String(libFull?.main_ability ?? '').trim();
    if (pkg)
        launchAbility = ability && !ability.includes('.') ? `${pkg}/${ability}` : pkg;
    if (!launchAbility) {
        try {
            const map = JSON.parse(String(getSetting('device.appAbilities', '{}') || '{}'));
            launchAbility = map[lib.name] ?? '';
        }
        catch { /* 忽略 */ }
    }
    if (!launchAbility)
        launchAbility = lib.name;
    const bundle = pkg.split('/')[0] || launchAbility.split('/')[0] || lib.name;
    await traceTask(task.id, '真机遍历开始', `设备 ${serial} · bundle=${bundle} · 入口=${launchAbility} · 参数读系统配置 explore.*`);
    // 2. 真机 BFS 遍历（含双向滚动探索、状态栏过滤）
    const result = await exploreApp(serial, bundle, { launchAbility });
    saveExploreReport(lib.name, result);
    await refreshPackageInfo({ id: lib.id, name: lib.name });
    await getDb().prepare('UPDATE tasks SET progress = 40, updated_at = ? WHERE id = ?').run(now(), task.id);
    await traceTask(task.id, '遍历完成', `${result.pages.length} 个页面 · 去重页 ${result.visitedCount} · 耗时 ${Math.round(result.durationMs / 1000)}s\n报告已存 workspace/explore/${lib.name}/`);
    // 真机操作序列摘要（最近 100 条；完整轨迹随报告文件留存，可在任务卡片「操作日志」查看）
    if (result.ops?.length) {
        const digest = result.ops.slice(-100).map((o) => `${o.at} ${o.action}${o.detail ? ` · ${o.detail}` : ''}`).join('\n');
        await traceTask(task.id, `真机操作序列（共 ${result.ops.length} 条，显示最近 100 条）`, digest);
    }
    // 3. 遍历数据 → 分片生成（map-reduce：每片独立调用，输出永不超限；单片失败只重试该片，不全局降级）
    const pagesCompact = result.pages.map((p) => ({
        path: p.path.join(' → '),
        controls: p.controls.map((c) => (c.text || c.desc).trim()).filter(Boolean).slice(0, 30),
        swipes: p.swipes,
        scrolls: p.scrolls ?? 0,
        animation: Boolean(p.animation),
    }));
    const pagesByPath = new Map(pagesCompact.map((p) => [p.path, p]));
    const sceneCtx = `三方库：${lib.name}（${lib.current_version}）
库简介：${lib.description}`;
    const exploreAddendum = `

【真机遍历数据驱动补充规则】
1. 只能基于本批【真机遍历数据】中出现的页面与控件设计用例；步骤引用的按钮/文本必须原样出现在对应页面的 controls 清单中；
2. 每个遍历到的页面至少 1 条正向用例（按 path 导航路径进入）；controls 数量多或 scrolls>0 的页面说明内容超一屏——涉及回调输出/日志区/动画状态的预期证据，步骤必须包含「上滑」后「验证「输出区域文本」」，预期写明滑动后应看到的证据；
3. 预期结果写明具体控件文本与动画表现（越界动画页注明"滑动后完整可见"），可结合 hilog 日志断言；
4. 来源固定为 AI 生成；每条用例必须带 pagePath 字段（值 = 该用例所属页面的 path 原文）。`;
    const tpl = await promptBundle('用例生成', CASE_GEN_FALLBACK);
    const sys = `${tpl.content}${tpl.skill ? `\n\n【绑定技能】\n${tpl.skill}` : ''}${exploreAddendum}${STEP_CONTRACT}${EVIDENCE_RULE}`;
    const sysStrict = `${sys}\n\n严格只输出一个 JSON 数组（首字符必须是 [），每项：{ name, precondition, steps[], expected, pagePath }，不要围栏、不要解释。`;
    // 分片：agent.genPagesPerShard（默认 2 页/片）；每页配额按丰富度分配（富页面 2 条，普通 1 条）
    const shardSize = Math.max(1, Math.min(6, Number(getSetting('agent.genPagesPerShard', 2)) || 2));
    const shards = [];
    for (let i = 0; i < pagesCompact.length; i += shardSize)
        shards.push(pagesCompact.slice(i, i + shardSize));
    const lessonsText = loadLessons(lib.name).map((l, i) => `${i + 1}. ${l}`).join('\n') || '（暂无）';
    const allRows = [];
    let shardFail = 0;
    for (let si = 0; si < shards.length; si++) {
        const shard = shards[si];
        const quota = shard.map((p) => (p.controls.length > 8 || p.scrolls > 0 ? 2 : 1));
        const quotaTotal = quota.reduce((a, b) => a + b, 0);
        const user = `${sceneCtx}
【真机遍历数据 · 本批第 ${si + 1}/${shards.length} 批，共 ${shard.length} 页】（真实 dump，唯一事实来源）：
${JSON.stringify(shard)}
任务要求：${task.input || '基于遍历数据为每个页面设计可执行用例，交互丰富的页面补边界/异常场景。'}
本批配额：共 ${quotaTotal} 条（${shard.map((p, i) => `${p.path} × ${quota[i]}`).join('；')}）。
每条用例必须带 pagePath 字段（值 = 所属页面的 path 原文）。
历史教训（生成时务必规避）：
${lessonsText}`;
        let parsed = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
            try {
                const { text, provider, model } = await llm({ system: attempt === 0 ? sys : sysStrict, user, maxTokens: 6000, meta: { taskId: task.id, kind: 'explore_cases' } });
                await traceTask(task.id, `AI 返回 · 第 ${si + 1}/${shards.length} 批（${text.length} 字符 · ${provider}/${model}）`, text.slice(0, 600));
                parsed = extractJson(text);
            }
            catch (e) {
                lastErr = e;
            }
        }
        if (!parsed) {
            shardFail++;
            await traceTask(task.id, `第 ${si + 1}/${shards.length} 批生成失败`, `${lastErr instanceof Error ? lastErr.message : String(lastErr)}（跳过该批，不影响其他批次）`);
            continue;
        }
        const drafts = normalizeDraftCases(parsed);
        // pagePath 归属兜底：模型漏填/写偏时按批次上下文修正（单页批直接归属；多页批按末段路径匹配）
        for (const d of drafts) {
            if (!d.pagePath || !pagesByPath.has(d.pagePath)) {
                const lastSeg = d.pagePath?.split(' → ').pop();
                const hit = shard.length === 1 ? shard[0] : shard.find((p) => (lastSeg ? p.path.endsWith(lastSeg) : false));
                if (hit)
                    d.pagePath = hit.path;
            }
        }
        allRows.push(...drafts);
        await getDb().prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(40 + Math.round(((si + 1) / shards.length) * 25), now(), task.id);
    }
    if (allRows.length === 0)
        throw new Error(`分片生成全部失败（${shardFail}/${shards.length} 批）`);
    await traceTask(task.id, '草稿解析完成', `${shards.length} 批中成功 ${shards.length - shardFail} 批，共 ${allRows.length} 条草稿，进入确定性校验`);
    // 确定性校验（guardrail）：点击/输入类步骤的控件引用必须真实存在于该页遍历清单，先于 LLM 自审
    const verdict = validateDraftsAgainstPages(allRows, pagesByPath);
    let checked = verdict.kept;
    if (verdict.dropped.length > 0) {
        appendLessons(lib.name, verdict.dropped.map((d) => `用例「${d.name}」控件引用越界：${d.reason}`));
        await traceTask(task.id, '确定性校验', `保留 ${verdict.kept.length} 条，${verdict.dropped.length} 条控件引用不在遍历清单，进入定向修复：\n${verdict.dropped.map((d) => `· ${d.name}：${d.reason}`).join('\n').slice(0, 800)}`);
        const repaired = await repairDrafts(task.id, llm, verdict.dropped, pagesByPath);
        checked = [...verdict.kept, ...repaired.kept];
        if (repaired.dropped.length > 0) {
            await traceTask(task.id, '修复后仍不合格（丢弃）', `${repaired.dropped.length} 条：\n${repaired.dropped.map((d) => `· ${d.name}`).join('\n').slice(0, 400)}`);
        }
    }
    if (checked.length === 0)
        throw new Error('确定性校验后无有效用例（控件引用均不在遍历清单且修复失败）');
    // 4. 自审进化循环（增量合并，不丢用例）
    const reviewed = await reviewAndRefine(task.id, llm, lib.name, checked, sceneCtx);
    const rows = reviewed.cases;
    if (rows.length === 0)
        throw new Error('自审后无有效用例');
    await getDb().prepare('UPDATE tasks SET progress = 80, updated_at = ? WHERE id = ?').run(now(), task.id);
    // 5. 入库（来源=AI 生成，上限按页配额动态计算）+ 绑定 Python 脚本
    const pageQuotaCap = Math.max(Number(getSetting('agent.maxCasesPerTask', 20)) || 20, result.pages.length * 2);
    const created = await insertDraftCases(lib.id, rows, `真机遍历 + 用例生成 Agent（分片生成，自审修订 ${reviewed.fixedRounds} 轮）`, pageQuotaCap);
    const bound = await bindHypiumScripts(lib, bundle, created);
    await traceTask(task.id, '写入用例库', `入库 ${created.length} 条（上限按页配额=${pageQuotaCap}），绑定 Hypium 脚本 ${bound} 条（V1，状态：待确认，来源=AI 生成）`);
    // 6. dry-run 闭环：真机/模拟器试跑 → 失败证据回灌重写（执行器为真）
    let dr = { ran: 0, passed: 0, repaired: 0 };
    try {
        dr = await dryRunAndRepair(task.id, llm, lib, created, bundle);
    }
    catch (e) {
        await traceTask(task.id, 'dry-run 闭环异常', `${e.message.slice(0, 200)}（用例已按生成结果入库，不受影响）`);
    }
    const drText = dr.ran > 0 ? `；dry-run 试跑 ${dr.ran} 条（通过 ${dr.passed}），回灌重写 ${dr.repaired} 条` : '';
    return `真机遍历 ${result.pages.length} 页 → 分片生成 ${shards.length} 批（成功 ${shards.length - shardFail}），确定性校验+修复后 ${checked.length} 条，AI 自审修订 ${reviewed.fixedRounds} 轮，入库 ${created.length} 条并绑定 Python 脚本 ${bound} 条${drText}。工程：${hypiumProjectDir(lib.name)}`;
}
const CASE_OPT_FALLBACK = `你是鸿蒙三方库测试用例优化 Agent。在保持原用例测试意图与覆盖目标不变的前提下提升质量：
1. 真实可操作——步骤引用的控件必须来自给定上下文，删除或修正臆造的按钮与跳转；
2. 逻辑合理——补全前置条件，理顺操作顺序，拆分过长组合步骤，去除重复；
3. 预期结果明确清晰——具体到控件文本/动画名/回调 JSON 字段/hilog 日志，禁止空泛描述；超一屏内容补「向上滑动查看输出区域」步骤。
只输出 JSON：{ name, precondition, steps[], expected }。`;
/**
 * 单条用例 AI 优化：用例优化 Agent（Prompt 管理 content+skill）重写 → 版本 +1，
 * changeNote 以【AI优化】前缀落库（前端蓝色徽标标识）。
 */
export async function optimizeCaseById(caseId, llm) {
    const db = getDb();
    const c = await db.prepare(`SELECT c.*, l.name AS library_name, l.description AS library_desc, l.package_name
     FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`).get(caseId);
    if (!c)
        throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
    // 用例溯源：从最新版本快照读取 pagePath（生成时记录），据此定向注入「所属页面」的控件清单
    let pagePath = '';
    try {
        const ver = await db.prepare('SELECT snapshot FROM case_versions WHERE case_id = ? AND version = ?')
            .get(c.id, c.current_version);
        pagePath = String(JSON.parse(ver?.snapshot ?? '{}').pagePath ?? '');
    }
    catch { /* 快照缺失/损坏时不影响优化 */ }
    // 真机对照数据：有 pagePath 时只注入所属页面（定向），否则回退前 10 页紧凑清单
    const report = latestExploreResult(c.library_name);
    let uiCtx = '';
    if (report && report.pages.length > 0) {
        const allPages = report.pages.map((pg) => ({
            path: pg.path.join(' → '),
            controls: pg.controls.map((x) => (x.text || x.desc).trim()).filter(Boolean).slice(0, 30),
            scrolls: pg.scrolls ?? 0,
        }));
        const own = pagePath ? allPages.find((p) => p.path === pagePath) : undefined;
        uiCtx = own
            ? `【真机遍历对照数据 · 本用例所属页面】（pagePath=${own.path}；步骤只能引用这里出现的控件文本）：\n${JSON.stringify(own)}`
            : `【真机遍历对照数据】（真实 dump 控件清单，步骤只能引用这里出现的控件文本）：\n${JSON.stringify(allPages.slice(0, 10))}`;
    }
    const sceneCtx = `三方库：${c.library_name}（bundle=${c.package_name || '—'}）库简介：${c.library_desc ?? ''}
${uiCtx}
待优化用例 ${c.case_no}${pagePath ? `（所属页面：${pagePath}）` : ''}：
名称：${c.name}
前置条件：${c.precondition}
步骤：${JSON.stringify(JSON.parse(c.steps || '[]'))}
预期结果：${c.expected}`;
    const tpl = await promptBundle('用例优化', CASE_OPT_FALLBACK);
    const sys = `${tpl.content}${tpl.skill ? `\n\n【绑定技能】\n${tpl.skill}` : ''}${STEP_CONTRACT}${EVIDENCE_RULE}`;
    let parsed = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
            const { text } = await llm(attempt === 0
                ? { system: sys, user: sceneCtx, maxTokens: 3000, meta: { taskId: c.id, kind: 'optimize_case' } }
                : { system: `${sys}\n\n严格只输出一个 JSON 对象（首字符必须是 {），不要围栏、不要解释。`, user: sceneCtx, maxTokens: 3000, meta: { taskId: c.id, kind: 'optimize_case' } });
            parsed = extractJson(text);
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (!parsed)
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    const rows = normalizeDraftCases(parsed);
    if (rows.length === 0)
        throw new Error('AI 未返回有效优化结果');
    const r = rows[0];
    // 优化后自动重新生成 Hypium 脚本（先落盘，成功则置「已绑定」，失败保留「未绑定」待 to_script 补）
    let rebound = false;
    try {
        writeCaseScript({ name: c.library_name, packageName: c.package_name || c.library_name }, { caseNo: c.case_no, name: r.name || c.name, steps: r.steps });
        rebound = true;
    }
    catch (e) {
        console.warn(`[hypium] 优化后重绑脚本失败 ${c.case_no}:`, e.message);
    }
    const next = c.current_version + 1;
    const t = now();
    const snapshot = {
        id: c.id, libraryId: c.library_id, caseNo: c.case_no, name: r.name || c.name,
        source: 'AI 生成', precondition: r.precondition, steps: r.steps,
        expected: r.expected, pagePath, status: '待确认',
        scriptStatus: rebound ? '已绑定' : '未绑定',
        currentVersion: next, createdAt: t, updatedAt: t,
    };
    await db.transaction(async () => {
        await db.prepare(`UPDATE cases SET name=?, precondition=?, steps=?, expected=?, current_version=?, script_status=?, updated_at=? WHERE id=?`)
            .run(snapshot.name, snapshot.precondition, JSON.stringify(snapshot.steps), snapshot.expected, next, snapshot.scriptStatus, t, c.id);
        await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
      VALUES (?, ?, ?, ?, 'AI 用例优化 Agent', 'ai', ?)`)
            .run(c.id, next, JSON.stringify(snapshot), `【AI优化】按用例优化 Agent 重写：步骤对齐真实控件、预期落到可验证证据${pagePath ? `（所属页面 ${pagePath}）` : ''}（自 v${c.current_version}）${rebound ? '，脚本已重新绑定' : ''}。`, t);
    });
    return { caseNo: c.case_no, name: snapshot.name, version: next };
}
async function updateCases(task, lib, llm) {
    const db = getDb();
    const samples = await db.prepare(`SELECT case_no, name FROM cases WHERE library_id = ? ORDER BY id LIMIT 10`).all(lib.id);
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
    let updates = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !updates; attempt++) {
        try {
            const { text, provider, model } = await llm(attempt === 0
                ? { system: sys, user, meta: { taskId: task.id, kind: 'update_cases' } }
                : { system: sysCompactUpd, user: `三方库：${lib.name}（${lib.current_version}）\n${changeCtx}\n现有用例：${JSON.stringify(samples)}`, meta: { taskId: task.id, kind: 'update_cases' } });
            await traceTask(task.id, `AI 返回（${text.length} 字符 · ${provider}/${model}）`, text.slice(0, 600));
            updates = extractJson(text);
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (!updates)
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    await getDb().prepare('UPDATE tasks SET progress = 40, updated_at = ? WHERE id = ?').run(now(), task.id);
    const t = now();
    let updated = 0;
    await db.transaction(async () => {
        for (const u of (Array.isArray(updates) ? updates : [])) {
            const row = await db.prepare('SELECT * FROM cases WHERE case_no = ? AND library_id = ?').get(u.caseNo, lib.id);
            if (!row)
                continue;
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
async function toScript(task, lib, llm) {
    void llm; // 确定性模板生成，不消耗 token
    const db = getDb();
    const cases = await db.prepare(`SELECT id, case_no, name, steps FROM cases WHERE library_id = ? AND script_status = '未绑定' ORDER BY id LIMIT 50`).all(lib.id);
    if (cases.length === 0)
        return '没有未绑定脚本的用例，无需转换。';
    const full = await db.prepare('SELECT package_name FROM libraries WHERE id = ?').get(lib.id);
    const hlib = { name: lib.name, packageName: String(full?.package_name ?? '') || lib.name };
    let bound = 0;
    const files = [];
    for (const c of cases) {
        try {
            const file = writeCaseScript(hlib, {
                caseNo: c.case_no,
                name: c.name,
                steps: JSON.parse(c.steps || '[]'),
            });
            await db.prepare(`UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?`).run(now(), c.id);
            files.push(path.basename(file));
            bound++;
        }
        catch (e) {
            await traceTask(task.id, `脚本生成失败 ${c.case_no}`, e.message.slice(0, 200));
        }
    }
    await traceTask(task.id, 'Python 脚本落盘', `${bound} 个 → ${hypiumProjectDir(lib.name)}\\testcases\\${lib.name.replace(/[^\w.-]/g, '_')}`);
    return `已按 HypiumProjectTemplate 模板为 ${bound} 条用例生成 Python 脚本并绑定（script_status=已绑定）。\n目录：${hypiumProjectDir(lib.name)}`;
}
