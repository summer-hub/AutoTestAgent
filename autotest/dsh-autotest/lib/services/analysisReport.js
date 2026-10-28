// B3：Markdown 分析报告服务（设计 §9 / §5.3.16 / §10.7 / §15.6）。
//
// 定位：把一次问题归因（issue ticket）的全部可追溯上下文 —— 基线/执行/用例版本/
// 场景资产/资源集/归因结论/证据/排除过程/自测试与人工验收 —— 渲染成一份
// 人可直接归档、可直接下发的 Markdown 报告（设计 §9.5 模板）。
//
// 三条纪律：
//   1. **不可变**：analysis_reports 一旦生成不改不删（设计 §5.4-6）。重新生成
//      产生新 report_no，工单指向最新，旧报告保留 —— 推翻结论后仍能回看
//      「当时为什么这么判断」，这是归因可审计的底线。
//   2. **不伪造**：拿不到的字段写「未知/未绑定/历史数据」，绝不反推。
//      无真机时验证段写「未验证：无在线真机」，不写通过。
//   3. **正文双写**：文件（workspace/reports/<lib>/<reportNo>.md）+ DB（MEDIUMTEXT）
//      同时落；下载优先读文件并校验 hash，文件丢失时回退 DB 正文 —— 报告是
//      审计资产，不能因为一次误删目录就丢历史。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { workspaceDir } from './gitRepo.js';
import { getSetting } from './settings.js';
import { ATTRIBUTION_LABELS, loadTicket, } from './issueRoot.js';
// ---------- 编号与目录 ----------
async function nextReportNo() {
    const db = getDb();
    const date = now().slice(0, 10).replace(/-/g, '');
    const like = `RP-${date}-%`;
    // CAST(SUBSTRING(x AS UNSIGNED))：MySQL 原生；SQLite 由 connection 的方言翻译自动转成 AS INTEGER
    const row = await db.prepare(`SELECT MAX(CAST(SUBSTRING(report_no, ${'RP'.length + date.length + 3}) AS UNSIGNED)) AS m FROM analysis_reports WHERE report_no LIKE ?`).get(like);
    const seq = (row?.m ?? 0) + 1;
    return `RP-${date}-${String(seq).padStart(3, '0')}`;
}
/** 库名 → 安全目录名（与场景资产同一套清洗规则）。 */
function libDirName(libName) {
    const cleaned = libName.trim().replace(/[\\/:*?"<>|\s]+/g, '_');
    return cleaned || 'lib';
}
function reportsRootDir() {
    const dir = path.join(workspaceDir(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}
// ---------- 行映射 ----------
function toReportRow(r, withContent) {
    return {
        id: Number(r.id),
        reportNo: String(r.report_no ?? ''),
        kind: String(r.kind ?? ''),
        issueId: r.issue_id ?? null,
        executionId: r.execution_id ?? null,
        testRunId: r.test_run_id ?? null,
        libraryId: r.library_id ?? null,
        caseId: r.case_id ?? null,
        baselineId: r.baseline_id ?? null,
        title: String(r.title ?? ''),
        mdPath: String(r.md_path ?? ''),
        contentHash: String(r.content_hash ?? ''),
        content: withContent ? String(r.content ?? '') : '',
        createdBy: String(r.created_by ?? ''),
        createdAt: String(r.created_at ?? ''),
    };
}
const REPORT_COLUMNS = 'id, report_no, kind, issue_id, execution_id, test_run_id, library_id, case_id, baseline_id, title, md_path, content_hash, created_by, created_at';
export async function getReport(id, opts = {}) {
    const withContent = opts.withContent ?? true;
    const r = await getDb().prepare(`SELECT ${withContent ? '*' : REPORT_COLUMNS} FROM analysis_reports WHERE id = ?`)
        .get(id);
    return r ? toReportRow(r, withContent) : null;
}
export async function getReportByIssue(ticketId, opts = {}) {
    const withContent = opts.withContent ?? true;
    // 工单 report_id 指向最新报告；直接按工单查兜底（工单行旧数据可能没回填）
    const r = await getDb().prepare(`SELECT ${withContent ? '*' : REPORT_COLUMNS} FROM analysis_reports WHERE issue_id = ? ORDER BY id DESC LIMIT 1`).get(ticketId);
    return r ? toReportRow(r, withContent) : null;
}
export async function listReports(opts = {}) {
    const conds = [];
    const args = [];
    if (opts.libraryId) {
        conds.push('library_id = ?');
        args.push(opts.libraryId);
    }
    if (opts.kind) {
        conds.push('kind = ?');
        args.push(opts.kind);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(200, Math.max(1, opts.limit ?? 100)));
    const rows = await getDb().prepare(`SELECT ${REPORT_COLUMNS} FROM analysis_reports ${where} ORDER BY id DESC LIMIT ?`).all(...args);
    return rows.map((r) => toReportRow(r, false));
}
/**
 * 报告正文（下载用）：优先读文件并校验 hash；文件丢失/损坏时回退 DB 正文。
 * 返回 content + source，让下载方知道拿到的是原件还是库内副本。
 */
export async function getReportMarkdown(id) {
    const report = await getReport(id);
    if (!report)
        throw httpError(404, `报告 #${id} 不存在`);
    const abs = path.join(workspaceDir(), report.mdPath);
    try {
        if (fs.existsSync(abs)) {
            const content = fs.readFileSync(abs, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            if (hash === report.contentHash)
                return { report, content, source: 'file' };
        }
    }
    catch { /* 读失败回退 DB */ }
    return { report, content: report.content, source: 'db' };
}
const MAX_LOG_TAIL = 4000;
const MAX_GUIDE_CHARS = 4000;
/** JSON 安全解析（坏数据当空值，报告里如实呈现「未知」，不炸整份报告）。 */
function parseJsonSafe(raw, fallback) {
    try {
        return JSON.parse(String(raw ?? ''));
    }
    catch {
        return fallback;
    }
}
/**
 * 组装报告上下文（设计 §9.2）：在 R5 既有输入上补 基线/执行链/预置条件/场景资产/资源集。
 * 全部只读取证 —— 报告是快照，组装过程绝不写库。
 */
export async function buildIssueReportContext(ticketId) {
    const db = getDb();
    const ticket = await loadTicket(ticketId);
    if (!ticket)
        throw httpError(404, `工单 #${ticketId} 不存在`);
    const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get(ticket.libraryId);
    const c = await db.prepare('SELECT * FROM cases WHERE id = ?').get(ticket.caseId);
    if (!c)
        throw httpError(404, `用例 #${ticket.caseId} 不存在（工单引用了已删除的用例）`);
    // 执行：绑定的优先；未绑定时取最近一次执行仅作参考呈现（标注未绑定）
    let exec = null;
    let bound = false;
    if (ticket.executionId) {
        exec = await db.prepare('SELECT * FROM executions WHERE id = ?').get(ticket.executionId) ?? null;
        bound = !!exec;
    }
    if (!exec) {
        exec = await db.prepare('SELECT * FROM executions WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(ticket.caseId) ?? null;
    }
    let deviceModel = '';
    if (exec?.device_id) {
        const d = await db.prepare('SELECT model, serial FROM devices WHERE id = ?').get(Number(exec.device_id));
        deviceModel = d ? `${d.model || d.serial}` : '';
    }
    // 运行 / 运行项 / 基线链
    let testRunNo = '';
    if (ticket.testRunId) {
        const tr = await db.prepare('SELECT run_no FROM test_runs WHERE id = ?').get(ticket.testRunId);
        testRunNo = tr?.run_no ?? '';
    }
    let baseline = null;
    if (ticket.baselineId) {
        const b = await db.prepare(`SELECT tb.baseline_no, tb.version_label AS v1, rs.commit_sha, rs.version_label AS v2
      FROM test_baselines tb LEFT JOIN repo_snapshots rs ON rs.id = tb.snapshot_id WHERE tb.id = ?`)
            .get(ticket.baselineId);
        if (b)
            baseline = { baselineNo: b.baseline_no, versionLabel: b.v1 ?? '', commitSha: b.commit_sha ?? '', versionLabel2: b.v2 ?? '' };
    }
    // 场景资产：该用例关联的全部资产（含已下架——下架也是历史事实）
    const assetRows = await db.prepare(`SELECT sa.asset_no, sa.title, sa.kind, sa.scenario_kind, sa.status, sa.version, sa.config_guide_md, sac.role
    FROM scenario_asset_cases sac JOIN scenario_assets sa ON sa.id = sac.asset_id
    WHERE sac.case_id = ? ORDER BY sa.asset_no`).all(ticket.caseId);
    const scenarioAssets = assetRows.map((r) => ({
        asset_no: String(r.asset_no ?? ''),
        title: String(r.title ?? ''),
        kind: String(r.kind ?? ''),
        scenario_kind: String(r.scenario_kind ?? ''),
        status: String(r.status ?? ''),
        version: String(r.version ?? ''),
        config_guide_md: String(r.config_guide_md ?? '').slice(0, MAX_GUIDE_CHARS),
        role: String(r.role ?? ''),
    }));
    // 本次运行实际登记的资产版本（run_item_assets）：回答"这次失败用的哪个版本"
    const runAssetRefs = [];
    if (ticket.runItemId) {
        const rows = await db.prepare(`SELECT sa.asset_no, ria.version, ria.apply_status
      FROM run_item_assets ria JOIN scenario_assets sa ON sa.id = ria.asset_id
      WHERE ria.run_item_id = ? ORDER BY sa.asset_no`).all(ticket.runItemId);
        for (const r of rows)
            runAssetRefs.push({ asset_no: r.asset_no, version: r.version, apply_status: r.apply_status });
    }
    // 资源集（runs 副本实际引用的集合）
    let resourceSetNo = '';
    if (ticket.runItemId) {
        const ri = await db.prepare('SELECT resource_set_id FROM test_run_items WHERE id = ?').get(ticket.runItemId);
        if (ri?.resource_set_id) {
            const rs = await db.prepare('SELECT set_no FROM test_resource_sets WHERE id = ?').get(Number(ri.resource_set_id));
            resourceSetNo = rs?.set_no ?? '';
        }
    }
    // B4：用例关联的需求 + 基线来源 PR（报告 §1 基本信息：需求/PR/merge commit）
    const reqRows = await db.prepare(`SELECT r.requirement_no, r.title, r.url
    FROM requirement_cases rc JOIN requirements r ON r.id = rc.requirement_id
    WHERE rc.case_id = ? ORDER BY r.requirement_no`).all(ticket.caseId);
    const requirements = reqRows.map((r) => ({ requirementNo: r.requirement_no, title: r.title, url: r.url }));
    const prs = [];
    if (ticket.baselineId) {
        const prRows = await db.prepare(`SELECT pr.number, pr.title, pr.merge_commit_sha, pr.url
      FROM baseline_prs bp JOIN pull_requests pr ON pr.id = bp.pr_id
      WHERE bp.baseline_id = ? ORDER BY pr.number`).all(ticket.baselineId);
        for (const r of prRows)
            prs.push({ number: Number(r.number), title: r.title, mergeCommitSha: r.merge_commit_sha, url: r.url });
    }
    return {
        ticket,
        libraryName: lib?.name ?? `#${ticket.libraryId}`,
        caseNo: String(c.case_no ?? ''),
        caseName: String(c.name ?? ''),
        caseVersion: ticket.caseVersion ?? (Number(c.current_version) || null),
        precondition: String(c.precondition ?? ''),
        steps: parseJsonSafe(c.steps, []),
        expected: String(c.expected ?? ''),
        oracles: parseJsonSafe(c.oracle_json, []),
        execution: exec ? {
            id: Number(exec.id),
            status: String(exec.status ?? ''),
            startedAt: exec.started_at ?? null,
            finishedAt: exec.finished_at ?? null,
            deviceModel,
            libraryVersion: String(exec.library_version ?? ''),
            commitSha: String(exec.commit_sha ?? ''),
            actualJson: exec.actual_json ?? null,
            logsTail: String(exec.logs ?? '').slice(-MAX_LOG_TAIL),
        } : null,
        testRunNo,
        baseline,
        requirements,
        prs,
        scenarioAssets,
        runAssetRefs,
        resourceSetNo,
        rootCause: ticket.rootCause,
        verification: ticket.verification,
    };
}
// ---------- 渲染（设计 §9.5 模板） ----------
const STEP_RESULT_LABELS = {
    confirmed: '成立',
    excluded: '排除',
    uncertain: '不确定',
};
/** 归因显示标签（含人工修正历史时的原始 LLM 归因）。 */
function attributionLabel(kind) {
    return ATTRIBUTION_LABELS[kind] ?? kind;
}
function mdEscapeCell(s) {
    return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}
/**
 * 按 §9.5 模板渲染 Markdown。
 * 独立纯函数（无 IO）：给定上下文出确定文本，便于自检逐段断言。
 */
export function renderIssueReport(ctx) {
    const t = ctx.ticket;
    const v = ctx.rootCause;
    const L = [];
    L.push(`# ${ctx.libraryName} / ${ctx.caseNo} 问题分析报告`, '');
    L.push(`> 报告编号：见文件名 · 生成时间：${now()} · 工单：${t.ticketNo}`, '');
    // 0. 结论
    L.push('## 0. 结论');
    L.push(`- 归因：**${attributionLabel(t.attribution)}**（${t.attribution}）`);
    if (t.attributionReason)
        L.push(`- 归因修正记录：${t.attributionReason.replace(/\r?\n/g, '；')}`);
    L.push(`- 置信度：${v ? v.confidence : '未知（无 LLM 结论）'}`);
    L.push(`- 一句话根因：${v ? v.rootCause : '未知（分析未产出结论）'}`);
    L.push('');
    // 1. 基本信息
    L.push('## 1. 基本信息');
    L.push(`- 工单：${t.ticketNo}（${t.status}）`);
    L.push(`- 用例：${ctx.caseNo} ${ctx.caseName}${ctx.caseVersion ? ` / V${ctx.caseVersion}` : ' / 版本未知'}`);
    if (ctx.requirements.length > 0) {
        L.push(`- 需求：${ctx.requirements.map((r) => `${r.requirementNo} ${r.title}`.trim()).join('、')}`);
    }
    else {
        L.push('- 需求：未关联');
    }
    if (ctx.prs.length > 0) {
        L.push(`- PR：${ctx.prs.map((p) => `#${p.number}${p.mergeCommitSha ? `（merge ${p.mergeCommitSha.slice(0, 12)}）` : ''}`).join('、')}`);
    }
    else {
        L.push('- PR：未关联（历史数据或非 PR 来源基线）');
    }
    if (ctx.execution) {
        L.push(`- 执行：#${ctx.execution.id} · ${ctx.execution.status}`
            + `${t.executionId ? '' : '（未绑定具体执行，此为该用例最近一次执行）'}`);
        L.push(`- 执行时间：${ctx.execution.startedAt ?? '未知'} ~ ${ctx.execution.finishedAt ?? '未知'}`
            + `${ctx.execution.deviceModel ? ` · 设备：${ctx.execution.deviceModel}` : ''}`);
    }
    else {
        L.push('- 执行：无执行记录（未绑定具体执行）');
    }
    if (ctx.testRunNo)
        L.push(`- 运行：${ctx.testRunNo}`);
    if (ctx.baseline) {
        L.push(`- 基线：${ctx.baseline.baselineNo}${ctx.baseline.versionLabel ? `（${ctx.baseline.versionLabel}）` : ''}`
            + `${ctx.baseline.commitSha ? ` · commit ${ctx.baseline.commitSha.slice(0, 12)}` : ' · commit 未知（历史数据）'}`);
    }
    else {
        L.push('- 基线：未知（历史数据或未走基线链路）');
    }
    if (ctx.execution?.libraryVersion)
        L.push(`- 库版本：${ctx.execution.libraryVersion}`);
    if (ctx.runAssetRefs.length > 0) {
        L.push(`- 运行登记资产：${ctx.runAssetRefs.map((a) => `${a.asset_no} V${a.version}（${a.apply_status}）`).join('、')}`);
    }
    if (ctx.resourceSetNo)
        L.push(`- 资源集：${ctx.resourceSetNo}`);
    L.push('');
    // 2. 输入快照
    L.push('## 2. 输入快照');
    L.push('### 2.1 预置条件', ctx.precondition || '（未填写）', '');
    L.push('### 2.2 步骤');
    if (ctx.steps.length === 0)
        L.push('（未填写）');
    ctx.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push('');
    L.push('### 2.3 预期结果', ctx.expected || '（未填写）', '');
    L.push('### 2.4 机器判据（oracle）');
    if (ctx.oracles.length === 0)
        L.push('（无 oracle）');
    ctx.oracles.forEach((o) => L.push(`- ${JSON.stringify(o)}`));
    L.push('');
    L.push('### 2.5 场景资源与配置指导');
    if (ctx.scenarioAssets.length === 0) {
        L.push('（该用例未关联场景资产）');
    }
    else {
        for (const a of ctx.scenarioAssets) {
            L.push(`- **${a.asset_no} ${a.title}**（${a.kind} · ${a.scenario_kind} · ${a.status} · V${a.version} · 关联角色 ${a.role}）`);
            if (a.config_guide_md) {
                L.push('', '  ```');
                for (const line of a.config_guide_md.split(/\r?\n/).slice(0, 60))
                    L.push(`  ${line}`);
                L.push('  ```');
            }
        }
    }
    L.push('');
    L.push('### 2.6 问题现象（人提交）', t.symptom || '（未填写）', '');
    // 3. 实际结果
    L.push('## 3. 实际结果');
    if (ctx.execution) {
        L.push(`- 执行状态：${ctx.execution.status}`);
        if (ctx.execution.actualJson) {
            L.push('- 结构化实际结果（actual_json）：', '', '```json');
            try {
                const actual = JSON.parse(ctx.execution.actualJson);
                L.push(JSON.stringify(actual, null, 2).slice(0, 4000));
            }
            catch {
                L.push(ctx.execution.actualJson.slice(0, 4000));
            }
            L.push('```');
        }
        else {
            L.push('- 结构化实际结果：未知（历史数据，执行时未记录 actual_json）');
        }
        if (ctx.execution.logsTail) {
            L.push('- 执行日志（尾部）：', '', '```', ctx.execution.logsTail, '```');
        }
    }
    else {
        L.push('- 无执行记录，无实际结果可呈现。');
    }
    L.push('');
    // 4. 分析过程（§9.4：怎么排除的）
    L.push('## 4. 分析过程');
    if (v?.process?.length) {
        v.process.forEach((p, i) => {
            L.push(`- 假设 ${String.fromCharCode(65 + i)}：${p.hypothesis}`);
            L.push(`  - 检查：${p.checked}`);
            L.push(`  - 结论：${STEP_RESULT_LABELS[p.result] ?? p.result}`);
        });
    }
    else {
        L.push('（AI 未产出结构化排除过程 —— 该工单可能是旧版本数据）');
    }
    if (v?.uncertainties?.length) {
        L.push('', '待人工确认：');
        v.uncertainties.forEach((u) => L.push(`- ${u}`));
    }
    L.push('');
    // 5. 证据
    L.push('## 5. 证据');
    const evidence = v?.evidence ?? t.evidence;
    if (evidence.length === 0) {
        L.push('（无证据 —— 结论置信度必须低，请谨慎采信）');
    }
    else {
        L.push('| 类型 | 位置 | 片段 | 支持什么 |', '|---|---|---|---|');
        for (const e of evidence) {
            L.push(`| ${e.kind} | ${mdEscapeCell(e.ref)}${e.line ? `:${e.line}` : ''} | ${mdEscapeCell(e.excerpt).slice(0, 200)} | ${mdEscapeCell(e.supports)} |`);
        }
    }
    L.push('');
    // 6. 修复建议
    L.push('## 6. 修复建议');
    if (v?.fixSuggestions?.length) {
        v.fixSuggestions.forEach((s) => L.push(`- ${s}`));
        if (v.needsDemoPatch)
            L.push('- ⚠ 需要 demo 工程补丁验证（needsDemoPatch=true）');
    }
    else {
        L.push('（无建议 —— 分析未产出）');
    }
    L.push('');
    // 7. 验证与验收（不伪造：无真机写"未验证"）
    L.push('## 7. 验证与验收');
    const verif = ctx.verification ?? {};
    const mode = String(verif.mode ?? '');
    if (mode === 'device') {
        L.push(`- 自测试：真机复现（设备 ${String(verif.serial ?? '')}）`);
    }
    else if (mode === 'skipped_no_device') {
        L.push('- 自测试：**未验证：无在线真机**（不伪造通过）');
    }
    else if (mode === 'skipped_no_hdc') {
        L.push('- 自测试：**未验证：未检测到 hdc**');
    }
    else if (mode === 'skipped_no_oracle') {
        L.push('- 自测试：未验证（用例无机器判据，无法判定对错）');
    }
    else if (mode === 'skipped') {
        L.push('- 自测试：未验证（用例无可执行步骤）');
    }
    else if (Object.keys(verif).length > 0) {
        L.push(`- 自测试：${JSON.stringify(verif).slice(0, 300)}`);
    }
    else {
        L.push('- 自测试：未验证（无验证记录）');
    }
    L.push(`- 人工验收：${t.verdict === 'accepted' ? '接受' : t.verdict === 'rejected' ? '驳回' : '未验收'}`
        + `${t.verdictReason ? ` —— ${t.verdictReason}` : ''}${t.verdictBy ? `（${t.verdictBy}）` : ''}`);
    L.push(`- 知识沉淀：${t.knowledgeId || '（未沉淀 —— 接受验收后自动生成）'}`);
    L.push('');
    L.push('---', '', `*本报告由系统自动生成，生成后不可修改；重新分析会生成新报告。*`);
    return L.join('\n') + '\n';
}
// ---------- 生成 ----------
/**
 * 为工单生成 Markdown 报告（设计 §9.6）。
 *
 * - 每次生成 = 新 report_no + 新文件 + 新 analysis_reports 行（不可变纪律）；
 * - 工单 report_id 指向最新，旧报告保留可查；
 * - 正文双写：文件 + DB；
 * - feature.mdReport=false 时直接 403（与路由层同一开关，服务层再挡一道
 *   防止任务链路在开关关闭时静默写文件）。
 */
export async function generateIssueReport(ticketId, opts = {}) {
    if (!getSetting('feature.mdReport', true)) {
        throw httpError(403, '报告功能已关闭（feature.mdReport=false）');
    }
    const db = getDb();
    const ctx = await buildIssueReportContext(ticketId);
    const reportNo = await nextReportNo();
    const content = renderIssueReport(ctx);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const relDir = path.join('reports', libDirName(ctx.libraryName));
    const relPath = path.join(relDir, `${reportNo}.md`).replace(/\\/g, '/');
    const absDir = path.join(workspaceDir(), relDir);
    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir(), relPath), content, 'utf8');
    const t = now();
    const ins = await db.prepare(`INSERT INTO analysis_reports
    (report_no, kind, issue_id, execution_id, test_run_id, library_id, case_id, baseline_id, title, md_path, content_hash, content, created_by, created_at)
    VALUES (?, 'issue_root_cause', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reportNo, ctx.ticket.id, ctx.ticket.executionId, ctx.ticket.testRunId, ctx.ticket.libraryId, ctx.ticket.caseId, ctx.ticket.baselineId, `${ctx.libraryName} / ${ctx.caseNo} 问题分析报告`.slice(0, 255), relPath, contentHash, content, opts.createdBy ?? 'system', t);
    const id = Number(ins.lastInsertRowid);
    // 工单指向最新报告（旧报告行不动 —— 不可变）
    await db.prepare('UPDATE issue_tickets SET report_id = ?, updated_at = ? WHERE id = ?').run(id, t, ticketId);
    const row = await getReport(id);
    if (!row)
        throw new Error(`报告 ${reportNo} 生成后读取失败`);
    return row;
}
