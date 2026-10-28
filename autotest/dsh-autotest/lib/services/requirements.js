// B4：需求追踪服务（设计 §7.1 / §10.2 / §11.2）。
//
// 定位：需求是"人为什么做这个功能"的锚点 —— 只存 external_id + url + 验收点，
// 不复制外部系统全文（避免同步冲突）；用例 / PR / 场景资产 / 执行统计都从
// 关联表派生，需求表本身只维护身份与验收标准。
//
// 纪律：
//   1. 编号 RQ-YYYYMMDD-NNN 服务端生成，人工不指定（防止编号冲突/跳号）；
//   2. 统计（用例数/PR 数/最近失败/覆盖基线数）全部现算 —— 不在需求行上
//      存冗余计数，避免关联表与计数列不一致（那是另一套要维护的真相）；
//   3. 不伪造：关联不存在的用例/PR 直接 404；空关联如实返回空数组。
import { dbMode, getDb, now } from '../db/connection.js';
export const REQUIREMENT_SOURCES = ['manual', 'onebox', 'import'];
export const REQUIREMENT_STATUSES = ['active', 'done', 'closed', 'dropped'];
/** 最近执行统计窗口：最近 20 条（够看"最近失败"，不做全量历史聚合）。 */
const RECENT_EXEC_WINDOW = 20;
function toRow(r) {
    return {
        id: Number(r.id),
        requirementNo: String(r.requirement_no ?? ''),
        externalId: String(r.external_id ?? ''),
        source: String(r.source ?? 'manual'),
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        primaryLibraryId: r.primary_library_id ?? null,
        status: String(r.status ?? 'active'),
        priority: String(r.priority ?? 'P1'),
        acceptanceMd: String(r.acceptance_md ?? ''),
        owner: String(r.owner ?? ''),
        createdAt: String(r.created_at ?? ''),
        updatedAt: String(r.updated_at ?? ''),
    };
}
function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}
// ---------- 编号 ----------
export async function nextRequirementNo() {
    const db = getDb();
    const date = now().slice(0, 10).replace(/-/g, '');
    const like = `RQ-${date}-%`;
    // CAST(SUBSTRING(x AS UNSIGNED))：MySQL 原生；SQLite 由 connection 的方言翻译自动转成 AS INTEGER
    const row = await db.prepare(`SELECT MAX(CAST(SUBSTRING(requirement_no, ${'RQ'.length + date.length + 3}) AS UNSIGNED)) AS m FROM requirements WHERE requirement_no LIKE ?`).get(like);
    const seq = (row?.m ?? 0) + 1;
    return `RQ-${date}-${String(seq).padStart(3, '0')}`;
}
export async function createRequirement(input) {
    const title = String(input.title ?? '').trim();
    if (!title)
        throw httpError(400, '需求标题不能为空（标题是需求的身份，没有标题无法检索）');
    const source = String(input.source ?? 'manual');
    if (!REQUIREMENT_SOURCES.includes(source))
        throw httpError(400, `非法需求来源：${source}（只支持 ${REQUIREMENT_SOURCES.join(' / ')}）`);
    const status = String(input.status ?? 'active');
    if (!REQUIREMENT_STATUSES.includes(status))
        throw httpError(400, `非法需求状态：${status}`);
    const priority = String(input.priority ?? 'P1').trim() || 'P1';
    let primaryLibraryId = null;
    if (Number.isFinite(Number(input.primaryLibraryId)) && Number(input.primaryLibraryId) > 0) {
        const lib = await getDb().prepare('SELECT id FROM libraries WHERE id = ?').get(Number(input.primaryLibraryId));
        if (!lib)
            throw httpError(404, `库 #${input.primaryLibraryId} 不存在`);
        primaryLibraryId = Number(input.primaryLibraryId);
    }
    const externalId = String(input.externalId ?? '').trim();
    if (externalId) {
        const dup = await getDb().prepare('SELECT id FROM requirements WHERE source = ? AND external_id = ?').get(source, externalId);
        if (dup)
            throw httpError(409, `外部系统已登记过该需求（${source} / ${externalId}），请直接编辑原需求，不要重复录入`);
    }
    const t = now();
    const requirementNo = await nextRequirementNo();
    const ins = await getDb().prepare(`INSERT INTO requirements (requirement_no, external_id, source, title, url, primary_library_id, status, priority, acceptance_md, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requirementNo, externalId, source, title.slice(0, 250), String(input.url ?? '').slice(0, 1000), primaryLibraryId, status, priority.slice(0, 8), String(input.acceptanceMd ?? ''), String(input.owner ?? '').slice(0, 60), t, t);
    const row = await getRequirement(Number(ins.lastInsertRowid));
    if (!row)
        throw new Error('需求创建后读取失败');
    return row;
}
export async function getRequirement(id) {
    const r = await getDb().prepare('SELECT * FROM requirements WHERE id = ?').get(id);
    return r ? toRow(r) : null;
}
export async function updateRequirement(id, input) {
    const row = await getRequirement(id);
    if (!row)
        throw httpError(404, `需求 #${id} 不存在`);
    if (input.status !== undefined && !REQUIREMENT_STATUSES.includes(input.status)) {
        throw httpError(400, `非法需求状态：${input.status}`);
    }
    if (input.title !== undefined && !String(input.title).trim())
        throw httpError(400, '需求标题不能改为空');
    const sets = [];
    const args = [];
    const put = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    if (input.title !== undefined)
        put('title', String(input.title).trim().slice(0, 250));
    if (input.status !== undefined)
        put('status', input.status);
    if (input.priority !== undefined)
        put('priority', (String(input.priority).trim() || 'P1').slice(0, 8));
    if (input.url !== undefined)
        put('url', String(input.url).slice(0, 1000));
    if (input.externalId !== undefined)
        put('external_id', String(input.externalId).trim());
    if (input.acceptanceMd !== undefined)
        put('acceptance_md', String(input.acceptanceMd));
    if (input.owner !== undefined)
        put('owner', String(input.owner).slice(0, 60));
    if (sets.length === 0)
        return row;
    put('updated_at', now());
    await getDb().prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    const after = await getRequirement(id);
    if (!after)
        throw new Error('需求更新后读取失败');
    return after;
}
// ---------- 统计（现算，不存冗余计数） ----------
async function requirementStats(id) {
    const db = getDb();
    const caseCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM requirement_cases WHERE requirement_id = ?').get(id))?.c ?? 0);
    const prCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM pr_requirements WHERE requirement_id = ?').get(id))?.c ?? 0);
    // 最近失败：关联用例最近 20 条执行里的 failed 数
    const recentFailed = Number((await db.prepare(`SELECT COUNT(*) AS c FROM (
       SELECT e.status FROM executions e
       WHERE e.case_id IN (SELECT case_id FROM requirement_cases WHERE requirement_id = ?)
       ORDER BY e.id DESC LIMIT ${RECENT_EXEC_WINDOW}
     ) recent WHERE recent.status = 'failed'`).get(id))?.c ?? 0);
    // 覆盖基线：关联用例执行出现过的 distinct baseline
    const baselineCount = Number((await db.prepare(`SELECT COUNT(DISTINCT e.baseline_id) AS c FROM executions e
     WHERE e.case_id IN (SELECT case_id FROM requirement_cases WHERE requirement_id = ?) AND e.baseline_id IS NOT NULL`).get(id))?.c ?? 0);
    return { caseCount, prCount, recentFailed, baselineCount };
}
// ---------- 列表 / 详情 ----------
export async function listRequirements(opts = {}) {
    const db = getDb();
    const conds = [];
    const args = [];
    if (Number.isFinite(Number(opts.libraryId)) && Number(opts.libraryId) > 0) {
        conds.push('primary_library_id = ?');
        args.push(Number(opts.libraryId));
    }
    if (opts.status) {
        conds.push('status = ?');
        args.push(opts.status);
    }
    if (opts.q) {
        conds.push('(title LIKE ? OR requirement_no LIKE ? OR external_id LIKE ?)');
        const like = `%${opts.q}%`;
        args.push(like, like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(200, Math.max(1, opts.limit ?? 100)));
    const rows = await db.prepare(`SELECT * FROM requirements ${where} ORDER BY id DESC LIMIT ?`).all(...args);
    const out = [];
    for (const r of rows) {
        const base = toRow(r);
        out.push({ ...base, ...await requirementStats(base.id) });
    }
    return out;
}
export async function getRequirementDetail(id) {
    const db = getDb();
    const row = await getRequirement(id);
    if (!row)
        throw httpError(404, `需求 #${id} 不存在`);
    const cases = await db.prepare(`SELECT c.id, c.case_no, c.name, c.status, rc.relation
     FROM requirement_cases rc JOIN cases c ON c.id = rc.case_id
     WHERE rc.requirement_id = ? ORDER BY c.case_no`).all(id);
    const prs = await db.prepare(`SELECT pr.id, pr.number, pr.title, pr.state
     FROM pr_requirements p2r JOIN pull_requests pr ON pr.id = p2r.pr_id
     WHERE p2r.requirement_id = ? ORDER BY pr.number`).all(id);
    const scenarioAssets = await db.prepare(`SELECT sa.id, sa.asset_no, sa.title, sa.kind
     FROM scenario_asset_requirements sar JOIN scenario_assets sa ON sa.id = sar.asset_id
     WHERE sar.requirement_id = ? ORDER BY sa.asset_no`).all(id);
    return {
        ...row,
        ...await requirementStats(id),
        cases: cases.map((c) => ({
            id: Number(c.id), caseNo: String(c.case_no ?? ''), name: String(c.name ?? ''),
            status: String(c.status ?? ''), relation: String(c.relation ?? 'covers'),
        })),
        prs: prs.map((p) => ({ id: Number(p.id), number: Number(p.number), title: String(p.title ?? ''), state: String(p.state ?? '') })),
        scenarioAssets: scenarioAssets.map((a) => ({ id: Number(a.id), assetNo: String(a.asset_no ?? ''), title: String(a.title ?? ''), kind: String(a.kind ?? '') })),
    };
}
// ---------- 关联 ----------
/** 关联用例（§10.2 POST /requirements/:id/cases）。同库校验：需求有主库时用例不必同库（跨库需求存在），但用例必须存在。 */
export async function linkRequirementCases(id, caseIds, relation = 'covers') {
    const row = await getRequirement(id);
    if (!row)
        throw httpError(404, `需求 #${id} 不存在`);
    const rel = ['covers', 'verifies', 'partial'].includes(String(relation)) ? String(relation) : 'covers';
    const t = now();
    const upsert = dbMode() === 'sqlite'
        ? 'INSERT OR IGNORE INTO requirement_cases (requirement_id, case_id, relation, created_at) VALUES (?, ?, ?, ?)'
        : 'INSERT IGNORE INTO requirement_cases (requirement_id, case_id, relation, created_at) VALUES (?, ?, ?, ?)';
    let linked = 0;
    for (const cid of caseIds) {
        const c = await getDb().prepare('SELECT id FROM cases WHERE id = ?').get(Number(cid));
        if (!c)
            throw httpError(404, `用例 #${cid} 不存在`);
        const res = await getDb().prepare(upsert).run(id, Number(cid), rel, t);
        if (Number(res.changes) > 0)
            linked++;
    }
    return { linked };
}
export async function unlinkRequirementCase(id, caseId) {
    const row = await getRequirement(id);
    if (!row)
        throw httpError(404, `需求 #${id} 不存在`);
    const res = await getDb().prepare('DELETE FROM requirement_cases WHERE requirement_id = ? AND case_id = ?').run(id, Number(caseId));
    return { removed: Number(res.changes) };
}
/** 关联 PR（§10.2 POST /requirements/:id/prs → pr_requirements）。 */
export async function linkRequirementPrs(id, prIds) {
    const row = await getRequirement(id);
    if (!row)
        throw httpError(404, `需求 #${id} 不存在`);
    const t = now();
    const upsert = dbMode() === 'sqlite'
        ? 'INSERT OR IGNORE INTO pr_requirements (pr_id, requirement_id, created_at) VALUES (?, ?, ?)'
        : 'INSERT IGNORE INTO pr_requirements (pr_id, requirement_id, created_at) VALUES (?, ?, ?)';
    let linked = 0;
    for (const pid of prIds) {
        const pr = await getDb().prepare('SELECT id FROM pull_requests WHERE id = ?').get(Number(pid));
        if (!pr)
            throw httpError(404, `PR #${pid} 不存在（请先同步 PR）`);
        const res = await getDb().prepare(upsert).run(Number(pid), id, t);
        if (Number(res.changes) > 0)
            linked++;
    }
    return { linked };
}
