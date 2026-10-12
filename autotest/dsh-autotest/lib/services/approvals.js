// 危险操作审批（企业级 P0-4）：AI 任务与 API 调用里的危险操作，从"静默执行"变为"可拦下等人批"。
//
// 机制（一次性批准令牌）：
//  1. exec.autoApprove=true（默认）→ requireApproval 直接放行。**既有部署/自检/DSH 插件零感知**；
//     企业部署在系统配置关掉它，即进入审批模式。
//  2. autoApprove=false 时，执行入口调 requireApproval(kind, target, payload)：
//     - 存在 matching 的 approved 且未消费令牌 → 消费（consumed=1）并放行 —— 这是"批准后重试"的路径；
//     - 存在 matching 的 pending → 幂等复用同一条（重复点击不会堆审批单）；
//     - 否则创建 pending 审批，抛 ApprovalPendingError（409，携带审批 id）。
//  3. 人工在「人工队列」页批准/拒绝：approve 即把该条置 approved（成为待消费令牌）；
//     reject 置 rejected（重试仍被拦，需重新发起）。
//
// 为什么用"令牌 + 重试"而不是"批准时直接重放"：危险操作分散在服务层/HTTP 层/executor，
// 每种操作的 payload 可执行化成本高且容易漏参数；而"重试同一操作"对 UI 操作（再点一次删除）
// 和 agent 任务（重试任务）都是最自然的交互，令牌机制把复杂度收敛在一个通用闸门里。
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';
/** 危险操作的中文名（审批列表与错误提示用）。 */
export const APPROVAL_KIND_LABEL = {
    'repo.pull': '拉取仓库代码',
    'repo.update': '更新仓库代码',
    'library.delete': '删除三方库（级联删除用例与执行历史）',
    'case.delete': '删除测试用例',
    'task.delete': '删除任务',
    'script.delete': '删除自动化脚本',
    'script.generate': '生成自动化脚本（写入工程目录）',
    'agent.external': '执行外部 Agent 命令',
};
export function autoApproveEnabled() {
    return getSetting('exec.autoApprove', true) === true;
}
/** 审批待批：调用方捕获后向用户转达"批准后重试同一操作"。 */
export class ApprovalPendingError extends Error {
    approvalId;
    kind;
    target;
    statusCode = 409;
    constructor(approvalId, kind, target) {
        super(`该操作需要人工审批（#${approvalId} · ${APPROVAL_KIND_LABEL[kind] ?? kind} · ${target}）。请在「人工队列」页批准后重试同一操作。`);
        this.approvalId = approvalId;
        this.kind = kind;
        this.target = target;
        this.name = 'ApprovalPendingError';
    }
}
/**
 * 危险操作闸门（执行入口调用）。
 * 返回 'auto'（自动放行）或 'approved'（消费了一次性令牌）；
 * 抛 ApprovalPendingError（409）= 已入队，等人工批准。
 */
export async function requireApproval(kind, target, payload = {}, requestedBy = '') {
    if (autoApproveEnabled())
        return 'auto';
    // 1. 一次性令牌：approve 后未被消费的同 (kind,target) 记录
    const token = await getDb().prepare(`SELECT id FROM approvals WHERE kind = ? AND target = ? AND status = 'approved' AND consumed = 0 ORDER BY id LIMIT 1`).get(kind, target);
    if (token) {
        await getDb().prepare(`UPDATE approvals SET consumed = 1, decided_at = ? WHERE id = ?`).run(now(), token.id);
        return 'approved';
    }
    // 2. 幂等：已有 pending 的同 (kind,target) 不重复建单（重复点击/并发重试收敛到同一条）
    const existing = await getDb().prepare(`SELECT id FROM approvals WHERE kind = ? AND target = ? AND status = 'pending' ORDER BY id LIMIT 1`).get(kind, target);
    if (existing)
        throw new ApprovalPendingError(existing.id, kind, target);
    // 3. 建单待批
    const res = await getDb().prepare(`INSERT INTO approvals (kind, target, payload_json, status, requested_by, decided_by, reason, consumed, created_at, decided_at)
     VALUES (?, ?, ?, 'pending', ?, '', '', 0, ?, '')`).run(kind, target, JSON.stringify(payload), requestedBy, now());
    throw new ApprovalPendingError(Number(res.lastInsertRowid), kind, target);
}
export async function listApprovals(status, limit = 100) {
    const cond = status ? 'WHERE status = ?' : '';
    const args = status ? [status] : [];
    const rows = await getDb().prepare(`SELECT * FROM approvals ${cond} ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, Math.trunc(limit)))}`).all(...args);
    return rows.map((r) => ({
        id: Number(r.id),
        kind: String(r.kind),
        kindLabel: APPROVAL_KIND_LABEL[String(r.kind)] ?? String(r.kind),
        target: String(r.target),
        payload: (() => { try {
            return JSON.parse(String(r.payload_json ?? '{}'));
        }
        catch {
            return {};
        } })(),
        status: String(r.status),
        requestedBy: String(r.requested_by ?? ''),
        decidedBy: String(r.decided_by ?? ''),
        reason: String(r.reason ?? ''),
        consumed: Number(r.consumed) === 1,
        createdAt: String(r.created_at),
        decidedAt: String(r.decided_at ?? ''),
    }));
}
export async function pendingApprovalCount() {
    const row = await getDb().prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).get();
    return Number(row?.n ?? 0);
}
/** 人工决策：approve → 签发待消费令牌；reject → 拒绝（重试仍被拦）。 */
export async function decideApproval(id, decision, decidedBy, reason = '') {
    if (decision !== 'approve' && decision !== 'reject') {
        throw Object.assign(new Error('decision 必须是 approve/reject'), { statusCode: 400 });
    }
    const row = await getDb().prepare('SELECT id, status FROM approvals WHERE id = ?').get(id);
    if (!row)
        throw Object.assign(new Error('审批不存在'), { statusCode: 404 });
    if (row.status !== 'pending')
        throw Object.assign(new Error(`该审批已是终态（${row.status}），不能重复决策`), { statusCode: 409 });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await getDb().prepare(`UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ?`)
        .run(status, decidedBy || 'web', reason, now(), id);
    return { ok: true, status };
}
