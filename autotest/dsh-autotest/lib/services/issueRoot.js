// R5：问题现象驱动的根因定位服务。
//
// 用户场景（需求原话）：针对已有用例有疑问 → 填「问题现象」→ AI 克隆工程、
// 分析问题、定位根因并自测试 → 人类验收。
//
// 与既有「归因分析」（analyzer.ts）的分工，避免重复造轮子：
//   · analyzer.ts  分析**执行失败**（输入是失败轨迹/日志/PR），回答"这次为什么没过"；
//   · 本服务      分析**人的疑问**（输入是用例 + 人写的问题现象），回答"这个现象根因是什么"。
// 输入不同、结论形态不同，所以是两套服务；但复用同一批地基（inspectRepo / llmJson /
// traceTask / withProgress / 知识沉淀）。
//
// 三条纪律（都是踩过坑才这么定的）：
//   1. **绝不编造 file:line**：拿不到证据就写"未获取"。编造一个看起来精确的行号，
//      比没有证据更糟——人会照着去改一个不存在问题的位置。
//   2. **LLM 不可用要能降级**：规则分析至少给出"该看哪些文件/哪些接口"，
//      而不是整条链路崩掉（与 analyzer.ts 的降级策略一致）。
//   3. **上下文有界**：源码/遍历 dump/执行日志都设上限，否则一个巨型仓库
//      会把 prompt 撑爆或把延迟拉到不可接受。
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { llmJson } from './llmCore.js';
import { inspectRepo, pullRepo, workspaceDir } from './gitRepo.js';
import { loadStoredSymbols } from './apiExtract.js';
/** 源码/日志的读取上限（防巨型仓库撑爆 prompt）。 */
const MAX_CODE_CHARS = 16000;
const MAX_EXPLORE_CHARS = 6000;
const MAX_LOG_CHARS = 4000;
const MAX_README_CHARS = 6000;
const MAX_SYMBOLS = 20;
/** 读取文件的安全封装（不存在/不可读都返回空串，不抛）。 */
function readSafe(file, max = MAX_CODE_CHARS) {
    try {
        if (!fs.existsSync(file))
            return '';
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 4 * 1024 * 1024)
            return '';
        return fs.readFileSync(file, 'utf8').slice(0, max);
    }
    catch {
        return '';
    }
}
/**
 * 从症状文本提关键词（中英混排）。
 *
 * ⚠️ 中文必须按**二元组（bigram）**切，不能整句当一个 token：
 * 「点击播放后进度条不动」整串匹配不上源码里的「进度条」，而按相邻两字切出
 * 「进度」「度条」后就能命中。这是实测踩过的坑——症状是中文、源码注释也是中文，
 * 整句切分等于永远命中不了，targetCode 恒为空、AI 只能靠猜。
 *
 * 英文仍按驼峰/下划线再切一遍（getSchema → get / schema）。
 */
function symptomTerms(symptom, caseName) {
    const text = `${symptom} ${caseName}`.toLowerCase();
    const out = new Set();
    // 英文/数字词
    const words = text.split(/[^\w\u4e00-\u9fa5]+/).filter((w) => w.length >= 2);
    for (const w of words) {
        out.add(w);
        for (const part of w.split(/[_-]/))
            if (part.length >= 3)
                out.add(part);
    }
    // 中文按二元组切（「进度条不动」→ 进度 / 度条 / 条不 / 不动）
    const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    for (const run of cjkRuns) {
        for (let i = 0; i + 2 <= run.length; i++)
            out.add(run.slice(i, i + 2));
    }
    // 单字不成词，但常见功能单字（播/停/进/度）在短症状里有用，保留高频的几个
    return [...out].filter((t) => t.length >= 2).slice(0, 40);
}
/**
 * 组装分析上下文。
 *
 * 为什么单独一个函数：上下文是"AI 看到的世界"，它决定了根因结论的上限。
 * 单独拆出来才能被自检覆盖（给定假仓库 → 断言组装结果有界、命中逻辑正确、
 * 缺数据时如实留空而不是填假数据）。
 */
export async function buildIssueContext(ticketId) {
    const db = getDb();
    const t = await db.prepare('SELECT * FROM issue_tickets WHERE id = ?').get(ticketId);
    if (!t)
        throw Object.assign(new Error('工单不存在'), { statusCode: 404 });
    const caseId = Number(t.case_id);
    const c = await db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!c)
        throw Object.assign(new Error(`用例 #${caseId} 不存在（工单引用了已删除的用例）`), { statusCode: 404 });
    const lib = await db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(t.library_id));
    if (!lib)
        throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const steps = (() => { try {
        return JSON.parse(String(c.steps ?? '[]'));
    }
    catch {
        return [];
    } })();
    const oracles = (() => { try {
        return JSON.parse(String(c.oracle_json ?? '[]'));
    }
    catch {
        return [];
    } })();
    const symptom = String(t.symptom ?? '');
    // 仓库：未 clone 则先拉（"克隆工程分析问题"是需求的明确要求）。
    // ⚠️ 目录已存在但不是 git 仓库时**不能**直接 pullRepo——它会抛错中断整条分析链路。
    //   真实场景里这很常见：用户手动把代码放到工作区、或上次 clone 中断留下残目录。
    //   此时按"已有本地代码"继续分析（读文件不依赖 .git），只在上下文里注明未做 git 操作，
    //   让人知道这份代码可能不是最新提交。
    const insp0 = inspectRepo({ name: String(lib.name), repo_url: String(lib.repo_url ?? ''), repo_subpath: String(lib.repo_subpath ?? '') });
    let insp = insp0;
    let repoNote = '';
    const hasGit = fs.existsSync(path.join(insp0.dir, '.git'));
    if (!hasGit) {
        const hasLocalCode = fs.existsSync(insp0.dir) && fs.readdirSync(insp0.dir).length > 0;
        if (hasLocalCode) {
            repoNote = '本地目录已有代码但非 git 仓库，未执行 clone/update（分析基于当前文件）';
        }
        else if (lib.repo_url) {
            try {
                await pullRepo({ name: String(lib.name), repo_url: String(lib.repo_url ?? ''), repo_subpath: String(lib.repo_subpath ?? ''), last_commit: String(lib.last_commit ?? '') });
                insp = inspectRepo({ name: String(lib.name), repo_url: String(lib.repo_url ?? ''), repo_subpath: String(lib.repo_subpath ?? '') });
                repoNote = '';
            }
            catch (e) {
                // clone 失败不阻断分析：上下文照常组装，但注明"代码可能不是最新"，
                // 让人知道结论的时效性边界（而不是拿到一个看似新鲜的结论）。
                repoNote = `clone 失败（${e.message.slice(0, 120)}），分析基于本地已有文件`;
            }
        }
        else {
            repoNote = '库未配置仓库地址，且本地无代码';
        }
    }
    // 目标页源码：按症状关键词命中页面。
    // ⚠️ 必须匹配**文件内容**而不是只匹配文件名：症状是中文描述（「进度条不动」「点击播放」），
    //    而页面文件名是英文（Player.ets），按名字匹配永远命中不了——
    //    但源码里往往真有这些词。这是实测踩过的坑（自检当场抓住：targetCode 为空）。
    const terms = symptomTerms(symptom, String(c.name ?? ''));
    const pagesRoot = path.join(insp.dir, 'entry', 'src', 'main', 'ets', 'pages');
    const pageFiles = (insp.pages ?? []).length > 0
        ? insp.pages
        : (fs.existsSync(pagesRoot) ? fs.readdirSync(pagesRoot).filter((f) => f.endsWith('.ets')).sort() : []);
    const scored = [];
    for (const p of pageFiles) {
        const body = readSafe(path.join(pagesRoot, p));
        // 名字命中权重 1，内容命中权重 2（内容才是"这个页面管什么功能"的真证据）
        const nameHits = terms.filter((tm) => p.toLowerCase().includes(tm)).length;
        const bodyHits = terms.filter((tm) => body.toLowerCase().includes(tm)).length;
        if (nameHits + bodyHits > 0)
            scored.push({ file: p, score: nameHits + bodyHits * 2 });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, 2);
    let targetCode = '';
    for (const h of hits) {
        targetCode += `\n── 页面源码 ${h.file} ──\n${readSafe(path.join(pagesRoot, h.file))}\n`;
    }
    if (targetCode.length > MAX_CODE_CHARS * 2)
        targetCode = targetCode.slice(0, MAX_CODE_CHARS * 2) + '\n（源码过长已截断）';
    const targetScope = hits.length > 0
        ? `命中 ${hits.length} 个页面（按症状关键词匹配页面内容）`
        : `未命中具体页面；工程页面清单：${pageFiles.join(', ') || '（无）'}`;
    // 真机遍历 dump（最近一次）：症状若与 UI 相关，这是最硬的证据来源
    const explore = latestExploreForLib(String(lib.name));
    const exploreCtx = explore
        ? `【真机遍历数据 · ${explore.pages.length} 页】（控件文本必须逐字来自这里）\n${JSON.stringify(explore.pages.slice(0, 6).map((pg) => ({ path: pg.path.join(' → '), controls: pg.controls.map((cc) => (cc.text || cc.desc).trim()).filter(Boolean).slice(0, 20) }))).slice(0, MAX_EXPLORE_CHARS)}`
        : '';
    // 导出符号中与症状相关的（api_symbols 是接口面的事实来源）
    const relatedSymbols = [];
    try {
        const { symbols } = await loadStoredSymbols(Number(t.library_id));
        for (const s of symbols) {
            const hay = `${s.name} ${s.signature ?? ''}`.toLowerCase();
            if (terms.some((tm) => hay.includes(tm))) {
                relatedSymbols.push({
                    name: s.name, kind: s.kind, signature: String(s.signature ?? ''),
                    sourceFile: String(s.sourceFile ?? ''), sourceLine: Number(s.sourceLine ?? 0),
                });
                if (relatedSymbols.length >= MAX_SYMBOLS)
                    break;
            }
        }
    }
    catch { /* 没有接口面数据时留空，不阻塞分析 */ }
    // 最近一次执行日志（现象若是执行中观察到的，日志是关键）
    const lastExec = await db.prepare('SELECT id, status, logs FROM executions WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(caseId);
    const lastExecutionLog = lastExec?.logs
        ? `【最近一次执行 #${lastExec.id} · ${lastExec.status}】\n${String(lastExec.logs).slice(-MAX_LOG_CHARS)}`
        : '';
    const readmeExcerpt = readSafe(path.join(insp.dir, 'README.md'), MAX_README_CHARS)
        || readSafe(path.join(insp.dir, 'readme.md'), MAX_README_CHARS);
    return {
        caseId, caseNo: String(c.case_no ?? ''), caseName: String(c.name ?? ''),
        libraryId: Number(t.library_id), libraryName: String(lib.name ?? ''),
        symptom, steps, expected: String(c.expected ?? ''), oracles,
        repoDir: insp.dir, bundleName: insp.bundleName || '',
        repoNote,
        targetCode, targetScope, exploreCtx, relatedSymbols, lastExecutionLog, readmeExcerpt,
    };
}
/** 取该库最近一次遍历结果（探针 workspace 下的 report 文件）。 */
function latestExploreForLib(libName) {
    const dir = path.join(workspaceDir(), 'explore', libName);
    if (!fs.existsSync(dir))
        return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (parsed?.pages?.length)
                return parsed;
        }
        catch { /* 跳过坏文件 */ }
    }
    return null;
}
const ROOT_CAUSE_SYSTEM = [
    '你是鸿蒙三方库的"问题根因定位"Agent。输入是一条测试用例、人观察到的**问题现象**，',
    '以及工程的真实上下文（源码 / 真机遍历 dump / 接口签名 / 执行日志 / README）。',
    '你要给出根因假设、可回查的证据、修复建议。',
    '',
    '硬性纪律（违反即作废）：',
    '① 不臆造——证据必须来自给定上下文。上下文里没有的信息，写进 uncertainties 问人，',
    '   绝不编造 file:line、绝不编造一个不存在的函数名；',
    '② 根因必须具体到机制（"进度条不更新是因为 onAnimationUpdate 回调未在 UI 线程触发"），',
    '   禁止"可能是兼容性问题""建议检查代码"这类无法验证的废话；',
    '③ 没有证据就不给高置信度：evidence 为空时 confidence 不得超过 40；',
    '④ 修复建议必须具体到动作（改哪个文件、加什么判断、补什么判据）；',
    '⑤ 只输出 JSON，不要解释、不要围栏。',
].join('\n');
/**
 * 用 LLM 做根因分析。失败不抛（由调用方降级）——但在返回里如实标注 analysisBy。
 */
export async function analyzeWithLlm(ctx, llm) {
    const user = [
        `## 用例`, `- 编号：${ctx.caseNo}`, `- 名称：${ctx.caseName}`,
        `- 步骤：${JSON.stringify(ctx.steps)}`,
        `- 预期：${ctx.expected}`,
        `- 机器判据：${JSON.stringify(ctx.oracles)}`,
        `## 人观察的问题现象（分析对象）`, ctx.symptom || '（未填写）',
        `## 工程`, `- 库：${ctx.libraryName}`, `- 目录：${ctx.repoDir}`, `- bundleName：${ctx.bundleName || '（未解析到）'}`,
        `## 目标范围`, ctx.targetScope,
        ctx.targetCode ? `## 相关页面源码\n${ctx.targetCode}` : '',
        ctx.exploreCtx || '',
        ctx.relatedSymbols.length > 0
            ? `## 相关导出符号\n${JSON.stringify(ctx.relatedSymbols.map((s) => ({ name: s.name, kind: s.kind, sig: s.signature, file: s.sourceFile, line: s.sourceLine })))}`
            : '## 相关导出符号\n（接口面数据里没有与症状相关的符号）',
        ctx.lastExecutionLog || '## 最近执行日志\n（该用例没有执行记录）',
        ctx.readmeExcerpt ? `## README 摘录\n${ctx.readmeExcerpt}` : '',
        '',
        '请输出 JSON：{ "rootCause": "...", "confidence": 0-100, "evidence": [{"kind":"source|symbol|explore|execution|readme","ref":"...","line":0,"excerpt":"...","supports":"..."}], "fixSuggestions": ["..."], "needsDemoPatch": true|false, "uncertainties": ["..."] }',
    ].filter(Boolean).join('\n');
    const r = await llmJson(llm, {
        system: ROOT_CAUSE_SYSTEM, user, temperature: 0.2, maxTokens: 2500,
        meta: { kind: 'issue.root_cause' },
    });
    const v = r.data ?? {};
    // 规格收紧：证据为空时置信度不许高（防"听起来很自信但其实什么都没看到"）
    const evidence = Array.isArray(v.evidence) ? v.evidence.filter((e) => e && e.ref) : [];
    const confidence = evidence.length === 0
        ? Math.min(Number(v.confidence ?? 0) || 0, 40)
        : Math.max(0, Math.min(100, Number(v.confidence ?? 0) || 0));
    return {
        rootCause: String(v.rootCause ?? '').slice(0, 1200),
        confidence,
        evidence: evidence.slice(0, 12).map((e) => ({
            kind: ['source', 'symbol', 'explore', 'execution', 'readme'].includes(String(e.kind)) ? String(e.kind) : 'source',
            ref: String(e.ref ?? '').slice(0, 300),
            line: Number(e.line ?? 0) || 0,
            excerpt: String(e.excerpt ?? '').slice(0, 400),
            supports: String(e.supports ?? '').slice(0, 300),
        })),
        fixSuggestions: (Array.isArray(v.fixSuggestions) ? v.fixSuggestions : []).map((s) => String(s).slice(0, 400)).slice(0, 8),
        needsDemoPatch: v.needsDemoPatch === true,
        uncertainties: (Array.isArray(v.uncertainties) ? v.uncertainties : []).map((s) => String(s).slice(0, 300)).slice(0, 6),
        analysisBy: 'llm',
    };
}
/**
 * 规则降级分析（LLM 不可用时）。
 *
 * 不给根因（没有模型就不该猜根因），但给"该看什么"——把上下文里**真实存在**的
 * 线索列出来，让人能自己接着查。这比返回一个空结论有用得多。
 */
export function analyzeByRule(ctx) {
    const evidence = [];
    const fix = [];
    if (ctx.targetCode) {
        evidence.push({ kind: 'source', ref: ctx.targetScope, line: 0, excerpt: ctx.targetCode.slice(0, 300), supports: '症状关键词命中的页面源码' });
        fix.push(`先读 ${ctx.targetScope}，对照用例步骤逐行检查交互逻辑`);
    }
    for (const s of ctx.relatedSymbols.slice(0, 5)) {
        evidence.push({ kind: 'symbol', ref: `${s.name}${s.sourceFile ? ` @ ${s.sourceFile}:${s.sourceLine || '?'}` : ''}`, line: s.sourceLine, excerpt: s.signature, supports: '接口名/签名与症状相关' });
        fix.push(`核对 ${s.name} 的调用参数与返回值是否符合预期（${s.signature}）`);
    }
    if (ctx.exploreCtx) {
        evidence.push({ kind: 'explore', ref: '真机遍历 dump', line: 0, excerpt: ctx.exploreCtx.slice(0, 300), supports: '真机上真实存在的控件清单' });
        fix.push('用真机遍历 dump 核对步骤引用的控件文本是否逐字存在');
    }
    if (ctx.lastExecutionLog) {
        evidence.push({ kind: 'execution', ref: '最近一次执行日志', line: 0, excerpt: ctx.lastExecutionLog.slice(0, 300), supports: '现象发生时的运行时输出' });
        fix.push('从最近一次执行日志里找错误码/异常堆栈');
    }
    if (ctx.readmeExcerpt) {
        evidence.push({ kind: 'readme', ref: 'README', line: 0, excerpt: ctx.readmeExcerpt.slice(0, 300), supports: '依赖/前置条件/已知问题' });
        fix.push('核对 README 的前置条件与已知问题是否与现象匹配');
    }
    return {
        rootCause: evidence.length > 0
            ? '（规则降级：未调用模型，不做根因推断）已列出上述可回查线索，请人工或配置模型后继续'
            : '（规则降级：未调用模型，且上下文中没有可回查线索——请先拉取仓库并采集接口面）',
        confidence: 0,
        evidence,
        fixSuggestions: fix.slice(0, 8),
        needsDemoPatch: false,
        uncertainties: ['未配置可用模型，无法做根因推断'],
        analysisBy: 'rule',
    };
}
/** 工单状态流转（集中一处，避免散落的状态字符串写错）。 */
export const TICKET_STATUS = {
    pending: 'pending',
    analyzing: 'analyzing',
    rootCaused: 'root_caused',
    verifying: 'verifying',
    accepted: 'accepted',
    rejected: 'rejected',
    failed: 'failed',
};
/**
 * 生成工单号（可读 + 唯一）。
 *
 * ⚠️ 唯一性靠两件事共同保证，缺一不可（自检当场抓住过只靠随机后缀的版本：
 * 时间戳是**秒级**，50 次同秒生成时 3 位 base36 后缀约 4.6 万种取值，
 * 碰撞概率约 2.6%，而 ticket_no 在库里是 UNIQUE 约束，撞了插入直接失败）：
 *   ① 进程内单调计数器 —— 同一进程内绝不重复（批量建单时这是主保障）；
 *   ② 随机后缀 —— 跨进程/重启后仍不重复（计数器归零后靠它）。
 */
let ticketSeq = 0;
export function ticketNo() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    ticketSeq = (ticketSeq + 1) % 100000;
    const rand = Math.random().toString(36).slice(2, 8);
    return `IT-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(ticketSeq).padStart(5, '0')}${rand}`;
}
