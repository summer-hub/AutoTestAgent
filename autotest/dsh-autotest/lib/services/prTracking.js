// B4：PR 追踪服务（设计 §7.2 / §7.3 / §7.4 / §10.3 / §11.3）。
//
// 定位：PR 是"变更"的锚点 —— 同步真实 PR（GitCode 优先，本地 git 降级）落
// pull_requests 表，测试状态**派生**（基线 → 运行/执行统计），不由 PR 表自维护，
// 避免"PR 上手动点一个状态"与真实执行不一致（§7.3）。
//
// 纪律：
//   1. merge_commit_sha 拿不到就留空，绝不编造 —— head 基线标注"仅预验证"；
//   2. 本地 git 降级只作为 provider='local' 的提交记录，不冒充 PR（§7.2）；
//   3. 测试状态规则固定：无执行 untested / 有 running testing / 有失败 failed /
//      全过 passed / 其余 partial；
//   4. 从 PR 建基线复用 baseline.createBaselineForLibrary（幂等、审批、物理快照
//      机制全部继承），本服务只做 PR 侧解析与校验。
import fs from 'node:fs';
import path from 'node:path';
import { dbMode, getDb, now } from '../db/connection.js';
import { fetchPrs, fetchPrsFromGit, parseRepoPath } from './analyzer.js';
import { normalizeRepoUrl, repoDirFor } from './gitRepo.js';
import { createBaselineForLibrary } from './baseline.js';
import { derivePrTestStatus } from './prStatus.js';
function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}
function toPrRow(r) {
    return {
        id: Number(r.id),
        provider: String(r.provider ?? ''),
        repoUrl: String(r.repo_url ?? ''),
        number: Number(r.number),
        libraryId: r.library_id ?? null,
        title: String(r.title ?? ''),
        state: String(r.state ?? ''),
        url: String(r.url ?? ''),
        baseBranch: String(r.base_branch ?? ''),
        headBranch: String(r.head_branch ?? ''),
        headSha: String(r.head_sha ?? ''),
        mergeCommitSha: String(r.merge_commit_sha ?? ''),
        mergedAt: r.merged_at ?? null,
        author: String(r.author ?? ''),
        bodyExcerpt: String(r.body_excerpt ?? ''),
        filesJson: String(r.files_json ?? '[]'),
        syncedAt: r.synced_at ?? null,
        createdAt: String(r.created_at ?? ''),
        updatedAt: String(r.updated_at ?? ''),
    };
}
export async function getPr(prId) {
    const r = await getDb().prepare('SELECT * FROM pull_requests WHERE id = ?').get(Number(prId));
    return r ? toPrRow(r) : null;
}
// ---------- 同步（§7.2） ----------
/**
 * 同步库的 PR 到 pull_requests 表：GitCode API 优先；失败/非 GitCode 地址降级
 * 本地 git 历史（provider='local'，只作为提交记录，不冒充 PR）。
 * 按 (provider, repo_url, number) 幂等 upsert —— 状态/合入提交随外部系统更新。
 */
export async function syncLibraryPrs(libraryId, opts = {}) {
    const db = getDb();
    const lib = await db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(libraryId));
    if (!lib)
        throw httpError(404, `库 #${libraryId} 不存在`);
    const libName = String(lib.name ?? '');
    const repoUrl = normalizeRepoUrl(String(lib.repo_url ?? ''));
    const limit = Math.min(50, Math.max(1, Number(opts.limit ?? 20) || 20));
    let provider = 'gitcode';
    let prs = [];
    const notes = [];
    const repoPath = parseRepoPath(String(lib.repo_url ?? ''));
    if (repoPath) {
        try {
            prs = await fetchPrs(repoPath, limit);
        }
        catch (e) {
            notes.push(`GitCode 拉取失败：${e.message.slice(0, 160)}`);
            prs = [];
        }
    }
    else {
        notes.push('仓库地址非 GitCode，无法走 API 同步');
    }
    if (prs.length === 0) {
        provider = 'local';
        const dir = repoDirFor({ name: libName, repo_url: String(lib.repo_url ?? ''), repo_subpath: String(lib.repo_subpath ?? '') });
        prs = fs.existsSync(path.join(dir, '.git')) ? fetchPrsFromGit(dir, { limit }) : [];
        if (prs.length === 0)
            notes.push('本地也无可用 git 历史（未克隆或无提交）');
    }
    const t = now();
    let synced = 0;
    for (const pr of prs) {
        const existing = await db.prepare('SELECT id FROM pull_requests WHERE provider = ? AND repo_url = ? AND number = ?')
            .get(provider, repoUrl, pr.number);
        const filesJson = JSON.stringify(pr.files ?? []);
        if (existing) {
            await db.prepare(`UPDATE pull_requests SET title = ?, state = ?, url = ?, base_branch = ?, head_branch = ?,
        head_sha = ?, merged_at = ?, author = ?, body_excerpt = ?, files_json = ?, synced_at = ?, updated_at = ?
        WHERE id = ?`)
                .run(pr.title.slice(0, 500), pr.state, pr.web_url, pr.base_branch ?? '', pr.head_branch ?? '', pr.head_sha ?? '', pr.merged_at ?? '', pr.author ?? '', pr.body.slice(0, 2000), filesJson, t, t, existing.id);
        }
        else {
            await db.prepare(`INSERT INTO pull_requests
        (provider, repo_url, number, library_id, title, state, url, base_branch, head_branch, head_sha,
         merge_commit_sha, merged_at, author, body_excerpt, files_json, synced_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(provider, repoUrl, pr.number, libraryId, pr.title.slice(0, 500), pr.state, pr.web_url, pr.base_branch ?? '', pr.head_branch ?? '', pr.head_sha ?? '', 
            // merge_commit_sha 只信 provider 原文：GitCode API 当前不返回 → 留空（head 基线仍可用）
            pr.merge_commit_sha ?? '', pr.merged_at ?? '', pr.author ?? '', pr.body.slice(0, 2000), filesJson, t, t, t);
        }
        synced++;
        const prRow = existing ? { id: existing.id } : await db.prepare('SELECT id FROM pull_requests WHERE provider = ? AND repo_url = ? AND number = ?')
            .get(provider, repoUrl, pr.number);
        if (prRow) {
            const upsertLib = dbMode() === 'sqlite'
                ? 'INSERT OR IGNORE INTO pr_libraries (pr_id, library_id, relation, created_at) VALUES (?, ?, ?, ?)'
                : 'INSERT IGNORE INTO pr_libraries (pr_id, library_id, relation, created_at) VALUES (?, ?, ?, ?)';
            await db.prepare(upsertLib).run(prRow.id, libraryId, 'affects', t);
        }
    }
    const items = await listLibraryPrs(libraryId);
    return { provider, synced, note: notes.join('；'), items };
}
// ---------- 列表 / 详情 ----------
export async function listLibraryPrs(libraryId, opts = {}) {
    const db = getDb();
    const lib = await db.prepare('SELECT id FROM libraries WHERE id = ?').get(Number(libraryId));
    if (!lib)
        throw httpError(404, `库 #${libraryId} 不存在`);
    const conds = ['pl.library_id = ?'];
    const args = [Number(libraryId)];
    if (opts.state) {
        conds.push('pr.state = ?');
        args.push(opts.state);
    }
    if (opts.q) {
        conds.push('(pr.title LIKE ? OR CAST(pr.number AS CHAR) LIKE ?)');
        args.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    args.push(Math.min(200, Math.max(1, opts.limit ?? 50)));
    // CAST(pr.number AS CHAR)：MySQL 原生；SQLite 由 connection 方言翻译。PR number 按OpenStack 倒序：新 PR 在前
    const rows = await db.prepare(`SELECT pr.* FROM pull_requests pr JOIN pr_libraries pl ON pl.pr_id = pr.id
     WHERE ${conds.join(' AND ')} ORDER BY pr.number DESC LIMIT ?`).all(...args);
    const out = [];
    for (const r of rows) {
        const pr = toPrRow(r);
        out.push(await attachPrExtras(pr));
    }
    return out;
}
/** 附加派生字段：关联计数 + 派生测试状态（列表与详情共用）。 */
async function attachPrExtras(pr) {
    const db = getDb();
    const requirementCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM pr_requirements WHERE pr_id = ?').get(pr.id))?.c ?? 0);
    const caseCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM pr_cases WHERE pr_id = ?').get(pr.id))?.c ?? 0);
    const baselineCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM baseline_prs WHERE pr_id = ?').get(pr.id))?.c ?? 0);
    return { ...pr, requirementCount, caseCount, baselineCount, testStatus: await derivePrTestStatus(pr.id) };
}
export async function getPrDetail(prId) {
    const db = getDb();
    const pr = await getPr(prId);
    if (!pr)
        throw httpError(404, `PR #${prId} 不存在`);
    const lib = pr.libraryId
        ? await db.prepare('SELECT name FROM libraries WHERE id = ?').get(pr.libraryId)
        : null;
    const requirements = await db.prepare(`SELECT r.id, r.requirement_no, r.title, r.status
     FROM pr_requirements p2r JOIN requirements r ON r.id = p2r.requirement_id
     WHERE p2r.pr_id = ? ORDER BY r.requirement_no`).all(prId);
    const cases = await db.prepare(`SELECT c.id, c.case_no, c.name, pc.basis
     FROM pr_cases pc JOIN cases c ON c.id = pc.case_id
     WHERE pc.pr_id = ? ORDER BY c.case_no`).all(prId);
    const baselines = await db.prepare(`SELECT tb.id, tb.baseline_no, tb.version_label, tb.status, rs.commit_sha
     FROM baseline_prs bp JOIN test_baselines tb ON tb.id = bp.baseline_id
     LEFT JOIN repo_snapshots rs ON rs.id = tb.snapshot_id
     WHERE bp.pr_id = ? ORDER BY tb.id DESC`).all(prId);
    return {
        ...(await attachPrExtras(pr)),
        libraryName: lib?.name ?? '',
        requirements: requirements.map((r) => ({
            id: Number(r.id), requirementNo: String(r.requirement_no ?? ''),
            title: String(r.title ?? ''), status: String(r.status ?? ''),
        })),
        cases: cases.map((c) => ({
            id: Number(c.id), caseNo: String(c.case_no ?? ''), name: String(c.name ?? ''),
            basis: String(c.basis ?? 'manual'),
        })),
        baselines: baselines.map((b) => ({
            id: Number(b.id), baselineNo: String(b.baseline_no ?? ''),
            versionLabel: String(b.version_label ?? ''), status: String(b.status ?? ''),
            commitSha: String(b.commit_sha ?? ''),
        })),
    };
}
// ---------- 关联（§10.3） ----------
export async function linkPrRequirements(prId, requirementIds) {
    const pr = await getPr(prId);
    if (!pr)
        throw httpError(404, `PR #${prId} 不存在`);
    const t = now();
    const upsert = dbMode() === 'sqlite'
        ? 'INSERT OR IGNORE INTO pr_requirements (pr_id, requirement_id, created_at) VALUES (?, ?, ?)'
        : 'INSERT IGNORE INTO pr_requirements (pr_id, requirement_id, created_at) VALUES (?, ?, ?)';
    let linked = 0;
    for (const rid of requirementIds) {
        const r = await getDb().prepare('SELECT id FROM requirements WHERE id = ?').get(Number(rid));
        if (!r)
            throw httpError(404, `需求 #${rid} 不存在`);
        const res = await getDb().prepare(upsert).run(prId, Number(rid), t);
        if (Number(res.changes) > 0)
            linked++;
    }
    return { linked };
}
export async function linkPrCases(prId, caseIds, basis = 'manual') {
    const pr = await getPr(prId);
    if (!pr)
        throw httpError(404, `PR #${prId} 不存在`);
    const b = ['manual', 'file'].includes(String(basis)) ? String(basis) : 'manual';
    const t = now();
    const upsert = dbMode() === 'sqlite'
        ? 'INSERT OR IGNORE INTO pr_cases (pr_id, case_id, basis, created_at) VALUES (?, ?, ?, ?)'
        : 'INSERT IGNORE INTO pr_cases (pr_id, case_id, basis, created_at) VALUES (?, ?, ?, ?)';
    let linked = 0;
    for (const cid of caseIds) {
        const c = await getDb().prepare('SELECT id FROM cases WHERE id = ?').get(Number(cid));
        if (!c)
            throw httpError(404, `用例 #${cid} 不存在`);
        const res = await getDb().prepare(upsert).run(prId, Number(cid), b, t);
        if (Number(res.changes) > 0)
            linked++;
    }
    return { linked };
}
// ---------- 从 PR 建基线（§7.4） ----------
/**
 * 用 PR 的合入提交（或 head 提交）建基线。
 * merge：必须已有 merge_commit_sha（不伪造"已合入"）；head：PR 未合入时的
 * 预验证通道（snapshot.source 标 'pr'，baseline note 写明"非合入提交，仅预验证"）。
 */
export async function createBaselineFromPr(prId, opts = {}) {
    const pr = await getPr(prId);
    if (!pr)
        throw httpError(404, `PR #${prId} 不存在`);
    if (!pr.libraryId)
        throw httpError(400, `PR #${pr.number} 未关联库，无法建基线（请先同步 PR 或补 library_id）`);
    const ref = opts.ref === 'head' ? 'head' : 'merge';
    if (ref === 'merge' && !pr.mergeCommitSha) {
        throw httpError(409, `PR #${pr.number} 无合入提交（未合入或 provider 未提供 merge_commit_sha）。可用 ref:"head" 建立 head 预验证基线 —— 但那不代表已合入主干。`);
    }
    if (ref === 'head' && !pr.headSha) {
        throw httpError(409, `PR #${pr.number} 无 head 提交信息，无法建立 head 预验证基线`);
    }
    return createBaselineForLibrary(pr.libraryId, {
        source: 'pr', prId, ref, versionLabel: opts.versionLabel, createdBy: opts.createdBy,
    });
}
