export type ApprovalKind = 'repo.pull' | 'repo.update' | 'library.delete' | 'case.delete' | 'task.delete' | 'script.delete' | 'script.generate' | 'agent.external';
/** 危险操作的中文名（审批列表与错误提示用）。 */
export declare const APPROVAL_KIND_LABEL: Record<string, string>;
export declare function autoApproveEnabled(): boolean;
/** 审批待批：调用方捕获后向用户转达"批准后重试同一操作"。 */
export declare class ApprovalPendingError extends Error {
    readonly approvalId: number;
    readonly kind: string;
    readonly target: string;
    readonly statusCode = 409;
    constructor(approvalId: number, kind: string, target: string);
}
/**
 * 危险操作闸门（执行入口调用）。
 * 返回 'auto'（自动放行）或 'approved'（消费了一次性令牌）；
 * 抛 ApprovalPendingError（409）= 已入队，等人工批准。
 */
export declare function requireApproval(kind: string, target: string, payload?: Record<string, unknown>, requestedBy?: string): Promise<'auto' | 'approved'>;
export interface ApprovalInfo {
    id: number;
    kind: string;
    kindLabel: string;
    target: string;
    payload: Record<string, unknown>;
    status: 'pending' | 'approved' | 'rejected';
    requestedBy: string;
    decidedBy: string;
    reason: string;
    consumed: boolean;
    createdAt: string;
    decidedAt: string;
}
export declare function listApprovals(status?: string, limit?: number): Promise<ApprovalInfo[]>;
export declare function pendingApprovalCount(): Promise<number>;
/** 人工决策：approve → 签发待消费令牌；reject → 拒绝（重试仍被拦）。 */
export declare function decideApproval(id: number, decision: 'approve' | 'reject', decidedBy: string, reason?: string): Promise<{
    ok: boolean;
    status: string;
}>;
