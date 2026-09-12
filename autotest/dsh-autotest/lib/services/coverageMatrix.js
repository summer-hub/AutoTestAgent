// P3：覆盖矩阵 —— 一张表回答"每个对外接口，在 demo 里有没有被用到？在真机上有没有对应控件？
// 有没有负向用例？"
//
// 为什么它必须存在：P2 给出了分母（导出符号），但"覆盖够不够"这个问题在只有分母时
// 完全不可证伪 —— 没有人能说清哪几个接口压根没测。矩阵把每个符号的**证据**摆出来，
// 让"未覆盖"变成可以逐行核对的事实，而不是一句感觉。
//
// 设计原则（沿用本项目纪律）：
//   1. 判定规则全部是**纯函数**，确定性、可离线单测（verify-coverage-matrix.mjs）；
//   2. 每行都必须带**证据**（evidence_json）与**判定理由**（status_reason），
//      否则又变成"看起来覆盖了"；
//   3. 宁可判 partial/blocked 也不虚报 covered：把"没测"报成"测了"是本项目最严重的错误。
import { getDb, now } from '../db/connection.js';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './gitRepo.js';
// ---------- 纯规则层 ----------
/** 类型/接口类符号：没有运行时行为，真机 UI 上既触发不了也断言不了。 */
export function isTypeSymbol(kind) {
    return kind === 'type' || kind === 'interface';
}
/** 负向场景：空值与边界异常（大数据算压力，不算负向）。 */
export function isNegativeScenario(kind) {
    return kind === 'empty' || kind === 'boundary';
}
/**
 * 场景适用性（静态初判）。
 *
 * 只依据**已有事实**判断，不猜：happy 任何接口都适用；empty/boundary/bigdata 需要
 * 至少有一个参数可被构造出对应取值。签名不可信（name-only）时**不给 false 以外的结论**
 * —— 拿不准就判不适用，让 P4 用 oracle 补齐，而不是先假定适用再生成一堆跑不了的用例。
 */
export function computeScenarioFit(input) {
    const { symbol } = input;
    const params = symbol.params;
    const typeText = params.map((p) => `${p.type} ${p.doc}`).join(' ');
    const hasParams = params.length > 0;
    const containerish = /array|\[\]|list|map|set|object|record|string|buffer|byte/i.test(typeText);
    // 方法也算"接口有输入"（类的可测单元是它的方法，但方法参数不在签名里，只能保守判断）
    const effectivelyHasInput = hasParams || symbol.methods.length > 0;
    return {
        happy: true,
        empty: effectivelyHasInput,
        boundary: effectivelyHasInput && (params.length > 0 || symbol.methods.length > 0),
        bigdata: containerish,
    };
}
/**
 * 状态判定（确定性规则表，逐条可测）。
 *
 * 规则顺序是刻意的：先排除"真机上根本测不了"的（blocked），再排"完全没碰过"的
 * （not_covered），最后才在"碰过"的里面区分 covered / partial。
 * 任何一条路径都不会把"没测"判成 covered —— covered 必须同时有**正向调用**和**负向用例**。
 */
export function computeStatus(input) {
    const { symbol, demoCalls, testCalls, cases, traversal } = input;
    const negative = cases.filter((c) => isNegativeScenario(c.scenarioKind));
    // ① 真机上不可触发 / 不可断言
    if (isTypeSymbol(symbol.kind)) {
        return { status: 'blocked', reason: `类型/接口符号（${symbol.kind}）：没有运行时行为，真机 UI 既触发不了也断言不了，需要靠单元测试或类型检查覆盖` };
    }
    if (symbol.deprecated) {
        return { status: 'blocked', reason: '接口已标记废弃：不再为它补用例（若要测需先确认是否仍在维护）' };
    }
    // ② demo 里完全没被调用
    if (demoCalls.length === 0) {
        if (testCalls.length > 0) {
            return {
                status: 'partial',
                reason: `demo（src/main）里没有调用，只有单元测试调用 ${testCalls.length} 处：真机路径未覆盖`,
            };
        }
        if (cases.length > 0) {
            return { status: 'partial', reason: `demo 里没有调用，但有 ${cases.length} 条用例直接针对它（用例可执行性待确认）` };
        }
        // 遍历里也没有任何间接证据才叫 not_covered
        const deviceHint = traversal && traversal.routes.size > 0
            ? '遍历报告里没有出现该符号相关的页面'
            : '也没有真机遍历报告可作为间接证据';
        return { status: 'not_covered', reason: `demo 源码里查不到该符号，${deviceHint}` };
    }
    // ③ demo 里有调用：正向已具备，看负向
    if (negative.length > 0) {
        return { status: 'covered', reason: `demo 调用 ${demoCalls.length} 处 + 负向用例 ${negative.length} 条（${negative.map((c) => c.caseNo).join('、')}）` };
    }
    if (cases.length > 0) {
        return { status: 'partial', reason: `demo 调用 ${demoCalls.length} 处、用例 ${cases.length} 条，但都只是正向场景（缺空值/边界）` };
    }
    const reach = deviceReachableText(input);
    return { status: 'partial', reason: `demo 调用 ${demoCalls.length} 处，但没有任何针对该接口的用例${reach ? `；${reach}` : ''}` };
}
function deviceReachableText(input) {
    const t = input.traversal;
    if (!t)
        return '且没有真机遍历报告';
    const hit = collectDeviceControls(input);
    return hit.routes.length > 0 ? `真机遍历已覆盖页面 ${hit.routes.join('、')}` : '真机遍历报告里没找到对应页面';
}
/**
 * 该符号在 demo 调用页面 → 真机遍历报告里的页面 → 控件文本。
 * 这是"真机上有没有对应控件"这一列的来源（遍历报告由 P1 产出）。
 */
export function collectDeviceControls(input) {
    const t = input.traversal;
    if (!t)
        return { routes: [], controls: [], pagePath: '' };
    const routes = [];
    const controls = [];
    let firstPagePath = '';
    for (const call of input.demoCalls) {
        const route = String(call.pagePath || '').trim();
        if (!route)
            continue;
        const entry = t.routes.get(route);
        if (!entry)
            continue;
        if (!routes.includes(route))
            routes.push(route);
        if (!firstPagePath)
            firstPagePath = entry.path.join(' → ');
        for (const c of entry.controls)
            if (!controls.includes(c))
                controls.push(c);
    }
    return { routes, controls, pagePath: firstPagePath };
}
/** 风险标记：只标能拿出依据的，不制造噪音。 */
export function computeRisks(input, status) {
    const { symbol, demoCalls, testCalls, cases, traversal, paramPoints } = input;
    const flags = [];
    if (symbol.deprecated)
        flags.push('deprecated');
    // 只有"压根没定位到定义体"才算签名不可信；decl-only（只读到一行声明）与 full 都不算，
    // 否则 16 个符号里会有 14 个被标红，真问题反而看不见
    if (symbol.detailLevel === 'name-only')
        flags.push('name_only_signature');
    if (isTypeSymbol(symbol.kind))
        flags.push('type_symbol');
    if (demoCalls.length === 0 && testCalls.length > 0)
        flags.push('test_only');
    if (cases.length === 0)
        flags.push('no_case');
    else if (!cases.some((c) => isNegativeScenario(c.scenarioKind)))
        flags.push('no_negative_case');
    if (!traversal)
        flags.push('no_traversal_evidence');
    else if (demoCalls.length > 0 && collectDeviceControls(input).routes.length === 0)
        flags.push('no_device_control');
    if (symbol.params.length > 0 && demoCalls.length > 0) {
        const reachable = new Set(demoCalls.map((c) => c.pagePath));
        const usable = paramPoints.some((p) => reachable.has(p.pagePath));
        if (!usable)
            flags.push('no_endpoint_for_param');
    }
    void status;
    return flags;
}
/** 组装一行矩阵：状态 + 理由 + 风险 + 场景适用性 + 证据。 */
export function buildMatrixRow(input) {
    const { symbol, demoCalls, testCalls, cases, traversal, paramPoints } = input;
    const { status, reason } = computeStatus(input);
    const device = collectDeviceControls(input);
    const negative = cases.filter((c) => isNegativeScenario(c.scenarioKind));
    const preferred = demoCalls[0];
    return {
        symbolId: symbol.id,
        symbolName: symbol.name,
        kind: symbol.kind,
        status,
        statusReason: reason,
        riskFlags: computeRisks(input, status),
        scenarioFit: computeScenarioFit(input),
        evidence: {
            demoCall: preferred ? { pagePath: preferred.pagePath, sourceFile: preferred.sourceFile, sourceLine: preferred.sourceLine, snippet: preferred.snippet } : undefined,
            testCallCount: testCalls.length,
            traversalReport: traversal?.reportFile ?? '',
            deviceControls: device.controls,
            devicePagePath: device.pagePath,
            caseNos: cases.map((c) => c.caseNo),
            negativeCaseNos: negative.map((c) => c.caseNo),
            paramPoints,
        },
        deviceReachable: device.routes.length > 0,
    };
}
/** 覆盖率统计（首页 KPI 与矩阵页头部用）。 */
export function summarizeMatrix(rows) {
    const total = rows.length;
    const testable = rows.filter((r) => r.status !== 'blocked').length;
    const withCase = rows.filter((r) => r.evidence.caseNos.length > 0).length;
    const applicable = rows.reduce((n, r) => n + Object.values(r.scenarioFit).filter(Boolean).length, 0);
    const coveredDims = rows.reduce((n, r) => n + Object.entries(r.scenarioFit)
        .filter(([k, v]) => v && r.evidence.caseNos.length > 0 && (k === 'happy' || r.evidence.negativeCaseNos.length > 0)).length, 0);
    const byRisk = {};
    for (const r of rows)
        for (const f of r.riskFlags)
            byRisk[f] = (byRisk[f] ?? 0) + 1;
    return {
        total,
        covered: rows.filter((r) => r.status === 'covered').length,
        partial: rows.filter((r) => r.status === 'partial').length,
        notCovered: rows.filter((r) => r.status === 'not_covered').length,
        blocked: rows.filter((r) => r.status === 'blocked').length,
        apiCoverage: testable === 0 ? 0 : Math.round((withCase / testable) * 1000) / 10,
        scenarioCoverage: applicable === 0 ? 0 : Math.round((coveredDims / applicable) * 1000) / 10,
        byRisk,
    };
}
/**
 * 从 P1 的遍历报告里取出「路由 → 该页控件文本」。
 *
 * 报告里页面记录用的是点击路径（人看得懂），而路由名在操作轨迹的
 * `进入判定 · 点击「X」→ 进入新页面 · pagePath=pages/Y` 这条 op 里。
 * 两者拼起来才能把 demo 源码里的 `pages/SimpleValidatePage` 对上真机页面。
 */
export function loadTraversalEvidence(libName) {
    const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
    if (!fs.existsSync(dir))
        return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0)
        return null;
    const file = path.join(dir, files[files.length - 1]);
    let report;
    try {
        report = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
    // 从操作轨迹取出「点击的控件标签 → 路由名」。
    // 遍历报告的页面记录只有点击路径（人看得懂），路由名只出现在这条 op 里，两者要拼起来。
    const labelToRoute = new Map();
    for (const op of report.ops ?? []) {
        const m = /点击「(.+?)」[^]*?→ 进入新页面 · pagePath=(\S+)/.exec(String(op.detail ?? ''));
        if (m)
            labelToRoute.set(m[1], m[2]);
    }
    const routes = new Map();
    const allControls = new Set();
    for (const p of report.pages ?? []) {
        const pageControls = (p.controls ?? [])
            .map((c) => String(c.text || c.desc || '').trim())
            .filter((s) => s.length > 1 && s.length < 40);
        for (const c of pageControls)
            allControls.add(c);
        const labels = p.path ?? [];
        const last = labels.length > 1 ? labels[labels.length - 1] : '';
        const route = labelToRoute.get(last);
        if (!route)
            continue; // 首页等没有路由名的页面不进 routes，但控件已进 allControls
        const controls = pageControls;
        const prev = routes.get(route);
        const merged = [...new Set([...(prev?.controls ?? []), ...controls])].slice(0, 40);
        routes.set(route, { controls: merged, path: labels });
    }
    return { reportFile: file, routes, allControls: [...allControls] };
}
/**
 * 装配并落库覆盖矩阵。同一库重复构建时**先删后插**（矩阵是快照，不是累积流水）。
 */
export async function buildCoverageMatrix(libraryId) {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId);
    if (!lib)
        throw Object.assign(new Error('库不存在'), { statusCode: 404 });
    const version = (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version ?? '';
    const symbolRows = await db.prepare('SELECT * FROM api_symbols WHERE library_id = ? AND library_version = ? ORDER BY id')
        .all(libraryId, version);
    if (symbolRows.length === 0) {
        throw Object.assign(new Error('该库还没有接口清单，请先在「接口清单」页执行采集。'), { statusCode: 400 });
    }
    const assets = await db.prepare(`SELECT kind, name, page_path, source_file, source_line, snippet
    FROM demo_assets WHERE library_id = ? AND library_version = ?`)
        .all(libraryId, version);
    const paramPoints = assets.filter((a) => a.kind === 'param').map((a) => ({
        pagePath: a.page_path, name: a.name, sourceFile: a.source_file, sourceLine: a.source_line,
    }));
    const callAssets = assets.filter((a) => a.kind === 'call' || a.kind === 'test_call');
    const caseRows = await db.prepare(`SELECT id, case_no, name, scenario_kind, api_symbol_id FROM cases WHERE library_id = ?`)
        .all(libraryId);
    const traversal = loadTraversalEvidence(lib.name);
    const rows = [];
    for (const s of symbolRows) {
        const name = String(s.name);
        const calls = callAssets.filter((a) => a.name === name);
        const input = {
            symbol: {
                id: Number(s.id), name, kind: String(s.kind),
                params: JSON.parse(String(s.params_json || '[]')),
                methods: JSON.parse(String(s.methods_json || '[]')),
                deprecated: Number(s.deprecated ?? 0) === 1,
                detailLevel: String(s.detail_level ?? 'name-only'),
                sourceFile: String(s.source_file ?? ''), sourceLine: Number(s.source_line ?? 0),
                signature: String(s.signature ?? ''),
            },
            demoCalls: calls.filter((a) => a.kind === 'call').map((a) => ({
                pagePath: a.page_path, sourceFile: a.source_file, sourceLine: a.source_line, snippet: a.snippet,
            })),
            testCalls: calls.filter((a) => a.kind === 'test_call').map((a) => ({ sourceFile: a.source_file, sourceLine: a.source_line })),
            paramPoints: paramPoints.filter((p) => calls.some((c) => c.page_path && c.page_path === p.pagePath)),
            traversal,
            cases: caseRows.filter((c) => c.api_symbol_id === Number(s.id))
                .map((c) => ({ id: c.id, caseNo: c.case_no, name: c.name, scenarioKind: c.scenario_kind })),
        };
        rows.push(buildMatrixRow(input));
    }
    const t = now();
    await db.transaction(async () => {
        await db.prepare('DELETE FROM coverage_matrix WHERE library_id = ?').run(libraryId);
        for (const r of rows) {
            await db.prepare(`INSERT INTO coverage_matrix
        (library_id, symbol_id, demo_asset_id, control_ref, page_path, status, status_reason, risk_flags, evidence_json, scenario_fit, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(libraryId, r.symbolId, r.evidence.demoCall ? `${r.evidence.demoCall.sourceFile}:${r.evidence.demoCall.sourceLine}` : '', r.evidence.demoCall?.pagePath ?? '', r.status, r.statusReason.slice(0, 250), JSON.stringify(r.riskFlags), JSON.stringify(r.evidence), JSON.stringify(r.scenarioFit), t);
        }
    });
    return { libraryId, libraryName: lib.name, version, rows: rows.length, summary: summarizeMatrix(rows), matrix: rows };
}
/** 读取已落库的矩阵（带筛选），供前端列表与导出用。 */
export async function loadCoverageMatrix(libraryId, opts = {}) {
    const db = getDb();
    const rows = await db.prepare(`SELECT c.*, s.name AS symbol_name, s.kind AS symbol_kind
    FROM coverage_matrix c JOIN api_symbols s ON s.id = c.symbol_id
    WHERE c.library_id = ? ORDER BY c.id`).all(libraryId);
    const version = (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version ?? '';
    const all = rows.map((r) => ({
        symbolId: Number(r.symbol_id),
        symbolName: String(r.symbol_name),
        kind: String(r.symbol_kind),
        status: String(r.status),
        statusReason: String(r.status_reason ?? ''),
        riskFlags: JSON.parse(String(r.risk_flags || '[]')),
        scenarioFit: JSON.parse(String(r.scenario_fit || '{}')),
        evidence: JSON.parse(String(r.evidence_json || '{}')),
        deviceReachable: false,
    }));
    const filtered = all.filter((r) => (!opts.status || r.status === opts.status) && (!opts.risk || r.riskFlags.includes(opts.risk)));
    return { version, summary: summarizeMatrix(all), rows: filtered };
}
/** 导出 Markdown（评审用）。 */
export function renderMatrixMarkdown(libName, version, rows, summary) {
    const L = [];
    L.push(`# ${libName} · 接口覆盖矩阵`);
    L.push('');
    L.push(`> 由 P3 覆盖矩阵自动生成（库版本 ${version || '—'}）。判定规则见设计文档 §6.3。`);
    L.push('');
    L.push(`- 导出符号 ${summary.total}：covered ${summary.covered} · partial ${summary.partial} · not_covered ${summary.notCovered} · blocked ${summary.blocked}`);
    L.push(`- 接口覆盖率（有用例/可测符号）：${summary.apiCoverage}% · 场景维度覆盖率：${summary.scenarioCoverage}%`);
    L.push('');
    L.push('| 符号 | 类型 | 状态 | 判定理由 | 风险 | 场景适用性 | 证据 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
        const fit = Object.entries(r.scenarioFit).filter(([, v]) => v).map(([k]) => k).join('/') || '—';
        const ev = r.evidence.demoCall
            ? `\`${r.evidence.demoCall.sourceFile}:${r.evidence.demoCall.sourceLine}\``
            : (r.evidence.testCallCount > 0 ? `无 demo 调用，单元测试 ${r.evidence.testCallCount} 处` : '无调用');
        L.push(`| \`${r.symbolName}\` | ${r.kind} | **${r.status}** | ${r.statusReason.replace(/\|/g, '\\|')} | ${r.riskFlags.join(' ') || '—'} | ${fit} | ${ev} |`);
    }
    L.push('');
    if (summary.byRisk && Object.keys(summary.byRisk).length > 0) {
        L.push('## 风险分布');
        L.push('');
        for (const [k, v] of Object.entries(summary.byRisk).sort((a, b) => b[1] - a[1]))
            L.push(`- ${k}：${v}`);
        L.push('');
    }
    return L.join('\n');
}
/** 导出 CSV（便于丢进表格筛选）。 */
export function renderMatrixCsv(rows) {
    const head = ['symbol', 'kind', 'status', 'status_reason', 'risk_flags', 'scenario_happy', 'scenario_empty', 'scenario_boundary', 'scenario_bigdata', 'demo_call', 'test_calls', 'cases', 'negative_cases'];
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    // 表头也加引号：与数据行保持一致，且以后加带逗号的列名不会串列
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
        lines.push([
            r.symbolName, r.kind, r.status, r.statusReason, r.riskFlags.join(' '),
            r.scenarioFit.happy, r.scenarioFit.empty, r.scenarioFit.boundary, r.scenarioFit.bigdata,
            r.evidence.demoCall ? `${r.evidence.demoCall.sourceFile}:${r.evidence.demoCall.sourceLine}` : '',
            r.evidence.testCallCount, r.evidence.caseNos.join(' '), r.evidence.negativeCaseNos.join(' '),
        ].map((x) => esc(String(x))).join(','));
    }
    return lines.join('\n');
}
