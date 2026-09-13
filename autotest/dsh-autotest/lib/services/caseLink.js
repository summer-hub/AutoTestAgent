// P11 用例 ↔ 接口关联层：把「初版用例（真机遍历产出）」与「对外接口」对上。
//
// 为什么需要这一层：覆盖矩阵的「用例」列原先只看 `cases.api_symbol_id`，而这一列**只有矩阵驱动
// 生成时才写入**；真机遍历生成与源码驱动生成的用例落库时一律为 NULL。结果是矩阵只能看见它自己
// 生成的用例，遍历产出的初版用例在矩阵里既不算已覆盖也不算部分覆盖 —— 矩阵于是无法回答用户真正
// 想看的问题："我这份初版用例，把对外接口覆盖到什么程度了？"
//
// 另外，一条用例可能覆盖多个接口（点一次按钮可能同时走校验+序列化），一个接口也需要多条用例
// （正向/空值/边界/大数据），单列 `api_symbol_id` 表达不了这种多对多，所以单独建关联表。
//
// 三条纪律：
//   1. **每条关联必须写出依据**（basis）与置信度：没有依据的关联等于编造，宁可不关联；
//   2. 低置信度（low）只列出、不参与"已覆盖/部分覆盖"判定 —— 不为凑覆盖率放宽证据；
//   3. 人工确认的关联（manual）在重新关联时**不被覆盖**（人手改的东西不能被机器默默冲掉）。
import { getDb, now } from '../db/connection.js';
import { loadTraversalEvidence } from './traversalEvidence.js';
export const BASIS_LABEL = {
    explicit: '生成时指定接口',
    page: '用例所属页面命中该接口的 demo 调用页',
    name: '用例文本命中接口/方法名',
    manual: '人工确认',
};
/** 生成 evidence 时纳入统计的置信度（low 只展示，不据此判覆盖）。 */
export function isTrustedLink(l) {
    return l.confidence === 'high' || l.confidence === 'medium';
}
/** 类型/接口符号没有运行时行为：只在"生成时指定"这一种情况下才有资格被关联。 */
function isTypeSymbol(kind) {
    return kind === 'type' || kind === 'interface';
}
/** 用例可能写的是面包屑（首页 → Y），也可能直接写路由名（pages/Y）：两种都要能认。 */
export function resolveCaseRoute(pagePath, traversal) {
    const p = String(pagePath || '').trim();
    if (!p || !traversal)
        return { route: '', how: '' };
    const exact = traversal.breadcrumbToRoute.get(p);
    if (exact)
        return { route: exact, how: '面包屑完全匹配' };
    // 兜底：按最后一段（页面名）匹配 —— 模型重写步骤时常把面包屑写短
    const last = p.split('→').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    if (last) {
        for (const [crumb, route] of traversal.breadcrumbToRoute) {
            const crumbLast = crumb.split('→').map((s) => s.trim()).filter(Boolean).pop() ?? '';
            if (crumbLast && crumbLast === last)
                return { route, how: `末段页面名「${last}」匹配` };
        }
    }
    // 最后再试：用例直接写了路由名
    if (traversal.routes.has(p))
        return { route: p, how: '直接写的路由名' };
    return { route: '', how: '' };
}
/** 名称命中：符号名或其方法名出现在用例文本里（要求 ≥3 字符，避免 validate 这类通用词误伤短名）。 */
export function nameHits(text, symbolName, methods) {
    const hay = text.toLowerCase();
    const hits = [];
    const candidates = [symbolName, ...methods].filter((n) => typeof n === 'string' && n.trim().length >= 3);
    for (const c of candidates) {
        const needle = c.trim().toLowerCase();
        if (!needle || needle.length < 3)
            continue;
        // 词边界近似：英文名要求前后不是标识符字符，避免 "Validator" 命中 "ValidatorList"
        const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = /^[a-z0-9_$]+$/i.test(needle) ? new RegExp(`(^|[^a-z0-9_$])${esc}([^a-z0-9_$]|$)`, 'i') : new RegExp(esc, 'i');
        if (re.test(hay))
            hits.push(c.trim());
    }
    return hits;
}
/**
 * 推断一条用例覆盖了哪些接口（纯函数，可离线逐条核对）。
 *
 * 优先级：explicit > page > name。同一个符号只保留最强的一条依据。
 */
export function inferLinks(c, symbols, traversal) {
    const text = [c.name, c.expected, ...c.steps].join('\n');
    const resolved = resolveCaseRoute(c.pagePath, traversal);
    const out = new Map();
    const put = (sym, basis, confidence, detail) => {
        const prev = out.get(sym.id);
        const rank = { explicit: 4, page: 3, name: 2, manual: 5 };
        if (prev && rank[prev.basis] >= rank[basis])
            return;
        out.set(sym.id, { caseId: c.id, symbolId: sym.id, basis, confidence, detail });
    };
    for (const s of symbols) {
        // ① 生成时指定（矩阵驱动生成的用例带 api_symbol_id）—— 最强证据
        if (c.apiSymbolId === s.id) {
            put(s, 'explicit', 'high', '用例生成时即指定该接口');
            continue;
        }
        if (isTypeSymbol(s.kind))
            continue; // 类型符号没有 UI 行为，不做推断关联
        // ② 页面命中：用例所属页 → 路由 → 该接口的 demo 调用页
        if (resolved.route && s.demoCallPages.includes(resolved.route)) {
            const controls = controlsOf(c, s.deviceControls);
            put(s, 'page', 'high', `用例页面「${c.pagePath}」→ 路由 ${resolved.route}（${resolved.how}），该接口正是在此页被调用`
                + (controls.length > 0 ? `；步骤引用的控件「${controls.slice(0, 3).join('、')}」也在该接口可达控件内` : ''));
            continue;
        }
        // ③ 名称命中：符号名或方法名出现在用例文本里（弱证据，标 medium）
        const hits = nameHits(text, s.name, s.methods);
        if (hits.length > 0) {
            put(s, 'name', 'medium', `用例文本出现「${hits.slice(0, 3).join('、')}」（可能与接口相关，需人工确认）`);
        }
    }
    return [...out.values()];
}
/** 用例步骤里「」引用的控件中，落在该接口真机可达控件内的那些。 */
function controlsOf(c, deviceControls) {
    if (deviceControls.length === 0)
        return [];
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    const pool = new Set(deviceControls.map(norm));
    const refs = new Set();
    for (const step of c.steps)
        for (const m of step.matchAll(/「([^「」]{1,40})」/g))
            refs.add(norm(m[1]));
    return [...refs].filter((r) => r && pool.has(r));
}
/**
 * 为一个库重建用例↔接口关联（幂等）：
 * `manual` 关联原样保留，其余先删后插 —— 关联是"当前事实的快照"，不是累积流水。
 */
export async function linkCasesForLibrary(libraryId) {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId);
    if (!lib)
        throw Object.assign(new Error('库不存在'), { statusCode: 404 });
    const version = (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version ?? '';
    const symbolRows = await db.prepare('SELECT id, name, kind, methods_json FROM api_symbols WHERE library_id = ? AND library_version = ? ORDER BY id')
        .all(libraryId, version);
    const callAssets = await db.prepare(`SELECT name, page_path FROM demo_assets WHERE library_id = ? AND library_version = ? AND kind = 'call'`)
        .all(libraryId, version);
    // 注意：cases 表没有 page_path 列 —— 用例所属页面只存在版本快照里（case_versions.snapshot），
    // 优化 Agent 也是这么取的。不读快照就会把"页面命中"这条最强的自动关联依据整条丢掉。
    const caseRows = await db.prepare(`
    SELECT c.id, c.case_no, c.name, c.steps, c.expected, c.api_symbol_id,
           v.snapshot AS snapshot
      FROM cases c
      LEFT JOIN case_versions v ON v.case_id = c.id AND v.version = c.current_version
     WHERE c.library_id = ?`)
        .all(libraryId);
    const traversal = loadTraversalEvidence(lib.name);
    const symbols = symbolRows.map((s) => {
        const pages = callAssets.filter((a) => a.name === s.name).map((a) => String(a.page_path || '')).filter(Boolean);
        const controls = new Set();
        for (const p of pages)
            for (const ctl of traversal?.routes.get(p)?.controls ?? [])
                controls.add(ctl);
        return {
            id: Number(s.id), name: String(s.name), kind: String(s.kind),
            methods: JSON.parse(String(s.methods_json || '[]')),
            demoCallPages: [...new Set(pages)],
            deviceControls: [...controls],
        };
    });
    const t = now();
    const candidates = [];
    for (const c of caseRows) {
        let pagePath = '';
        try {
            pagePath = String(JSON.parse(String(c.snapshot ?? '{}')).pagePath ?? '');
        }
        catch {
            pagePath = '';
        }
        const row = {
            id: Number(c.id), caseNo: String(c.case_no), name: String(c.name),
            steps: JSON.parse(String(c.steps || '[]')),
            expected: String(c.expected ?? ''), pagePath,
            apiSymbolId: c.api_symbol_id === null || c.api_symbol_id === undefined ? null : Number(c.api_symbol_id),
        };
        for (const l of inferLinks(row, symbols, traversal))
            candidates.push({ ...l, caseNo: row.caseNo });
    }
    const manual = await db.prepare(`SELECT id, case_id, symbol_id, confidence, detail FROM case_symbol_links WHERE library_id = ? AND basis = 'manual'`)
        .all(libraryId);
    const manualKeys = new Set(manual.map((m) => `${m.case_id}:${m.symbol_id}`));
    await db.transaction(async () => {
        await db.prepare(`DELETE FROM case_symbol_links WHERE library_id = ? AND basis <> 'manual'`).run(libraryId);
        for (const l of candidates) {
            if (manualKeys.has(`${l.caseId}:${l.symbolId}`))
                continue; // 人工确认的不动
            await db.prepare(`INSERT INTO case_symbol_links (library_id, case_id, symbol_id, basis, confidence, detail, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(libraryId, l.caseId, l.symbolId, l.basis, l.confidence, l.detail.slice(0, 400), t, t);
        }
    });
    const byBasis = {};
    for (const l of candidates)
        byBasis[l.basis] = (byBasis[l.basis] ?? 0) + 1;
    const linkedCaseIds = new Set(candidates.map((c) => c.caseId));
    for (const m of manual)
        linkedCaseIds.add(m.case_id);
    return {
        libraryId,
        links: candidates.length,
        linkedCases: linkedCaseIds.size,
        totalCases: caseRows.length,
        unlinkedCases: caseRows.length - linkedCaseIds.size,
        byBasis,
        preservedManual: manual.length,
    };
}
/** 读取一个库的关联（默认排除 low，除非显式要看）。 */
export async function listLinks(libraryId, opts = {}) {
    const db = getDb();
    const rows = await db.prepare(`
    SELECT l.case_id, l.symbol_id, l.basis, l.confidence, l.detail,
           c.case_no, c.name AS case_name, c.scenario_kind, s.name AS symbol_name
      FROM case_symbol_links l
      LEFT JOIN cases c ON c.id = l.case_id
      LEFT JOIN api_symbols s ON s.id = l.symbol_id
     WHERE l.library_id = ?
     ORDER BY l.case_id, l.symbol_id`).all(libraryId);
    return rows
        .filter((r) => opts.includeWeak !== false || String(r.confidence) !== 'low')
        .map((r) => ({
        caseId: Number(r.case_id), symbolId: Number(r.symbol_id),
        caseNo: String(r.case_no ?? ''), caseName: String(r.case_name ?? ''),
        scenarioKind: String(r.scenario_kind ?? 'happy'), symbolName: String(r.symbol_name ?? ''),
        basis: String(r.basis ?? ''), confidence: String(r.confidence ?? ''),
        detail: String(r.detail ?? ''),
    }));
}
/** 关联快照：symbolId → 该接口下的用例（供覆盖矩阵装配使用，避免矩阵自己再算一遍）。 */
export async function loadLinksBySymbol(libraryId) {
    const rows = await listLinks(libraryId, { includeWeak: true });
    const map = new Map();
    for (const r of rows) {
        const list = map.get(r.symbolId) ?? [];
        list.push({ caseId: r.caseId, caseNo: r.caseNo, basis: r.basis, confidence: r.confidence });
        map.set(r.symbolId, list);
    }
    return map;
}
/** 人工确认/取消一条关联（basis=manual，重新关联时受保护）。 */
export async function setManualLink(caseId, symbolId, linked) {
    const db = getDb();
    const c = await db.prepare('SELECT id, library_id FROM cases WHERE id = ?').get(caseId);
    if (!c)
        return { ok: false, message: '用例不存在' };
    const s = await db.prepare('SELECT id FROM api_symbols WHERE id = ?').get(symbolId);
    if (!s)
        return { ok: false, message: '接口符号不存在' };
    const t = now();
    if (!linked) {
        await db.prepare(`DELETE FROM case_symbol_links WHERE case_id = ? AND symbol_id = ?`).run(caseId, symbolId);
        return { ok: true, message: '已取消关联' };
    }
    const exists = await db.prepare('SELECT id FROM case_symbol_links WHERE case_id = ? AND symbol_id = ?')
        .get(caseId, symbolId);
    if (exists) {
        await db.prepare(`UPDATE case_symbol_links SET basis = 'manual', confidence = 'high', detail = ?, updated_at = ? WHERE id = ?`)
            .run('人工确认', t, exists.id);
    }
    else {
        await db.prepare(`INSERT INTO case_symbol_links (library_id, case_id, symbol_id, basis, confidence, detail, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', 'high', ?, ?, ?)`).run(Number(c.library_id), caseId, symbolId, '人工确认', t, t);
    }
    return { ok: true, message: '已人工确认关联' };
}
/** 供执行器使用：给一批用例写"整合时确认"的关联（basis=explicit，带来源说明）。 */
export async function linkCaseToSymbols(caseId, symbolIds, detail) {
    if (symbolIds.length === 0)
        return 0;
    const db = getDb();
    const c = await db.prepare('SELECT library_id FROM cases WHERE id = ?').get(caseId);
    if (!c)
        return 0;
    const t = now();
    let n = 0;
    for (const sid of [...new Set(symbolIds)]) {
        const manual = await db.prepare(`SELECT id FROM case_symbol_links WHERE case_id = ? AND symbol_id = ? AND basis = 'manual'`)
            .get(caseId, sid);
        if (manual)
            continue; // 人工确认优先，不覆盖
        const exists = await db.prepare('SELECT id FROM case_symbol_links WHERE case_id = ? AND symbol_id = ?').get(caseId, sid);
        if (exists) {
            await db.prepare(`UPDATE case_symbol_links SET basis = 'explicit', confidence = 'high', detail = ?, updated_at = ? WHERE id = ?`)
                .run(detail.slice(0, 400), t, exists.id);
        }
        else {
            await db.prepare(`INSERT INTO case_symbol_links (library_id, case_id, symbol_id, basis, confidence, detail, created_at, updated_at)
        VALUES (?, ?, ?, 'explicit', 'high', ?, ?, ?)`).run(Number(c.library_id), caseId, sid, detail.slice(0, 400), t, t);
        }
        n++;
    }
    return n;
}
/**
 * 这条用例是不是"初版草稿"（P11 整合任务的目标筛选依据）。
 *
 * 判据就是本项目对"草稿 / 正式用例"的定义性差别：**有没有可机器校验的判据**。
 * 有判据 = 已能判定通过与否 = 正式；没有（或判据不可核对、恒真）= 草稿。
 * 用别的特征（来源、版本号、名字）都不成立：人手工录的用例也可能没判据。
 */
export function isDraftCase(oracleJson, validate) {
    let oracles;
    try {
        oracles = JSON.parse(String(oracleJson || '[]'));
    }
    catch {
        return true; // 解析不出来 = 没有可用判据
    }
    if (!Array.isArray(oracles) || oracles.length === 0)
        return true;
    return validate(oracles).length > 0;
}
/** 关联情况的人类可读报告（任务轨迹与接口返回共用）。 */ export function renderLinkReport(lib, r) {
    const basisText = Object.entries(r.byBasis).map(([k, v]) => `${BASIS_LABEL[k] ?? k} ${v} 条`).join(' · ') || '（无）';
    return [
        `库「${lib.name}」用例 ${r.totalCases} 条：已关联到接口 ${r.linkedCases} 条，**未关联 ${r.unlinkedCases} 条**`,
        `写入关联 ${r.links} 条（${basisText}）`,
        r.preservedManual > 0 ? `保留人工确认关联 ${r.preservedManual} 条（重新关联不会覆盖）` : '',
        r.unlinkedCases > 0 ? '未关联用例不参与接口覆盖率统计，矩阵页会单独列出。' : '',
    ].filter(Boolean).join('\n');
}
