import { type BaselineRow } from './baseline.js';
import type { PrTestStatus } from './prStatus.js';
export interface PrRow {
    id: number;
    provider: string;
    repoUrl: string;
    number: number;
    libraryId: number | null;
    title: string;
    state: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    headSha: string;
    mergeCommitSha: string;
    mergedAt: string | null;
    author: string;
    bodyExcerpt: string;
    filesJson: string;
    syncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface PrListItem extends PrRow {
    requirementCount: number;
    caseCount: number;
    baselineCount: number;
    /** 派生测试状态（§7.3） */
    testStatus: PrTestStatus;
}
export interface PrDetail extends PrListItem {
    libraryName: string;
    requirements: Array<{
        id: number;
        requirementNo: string;
        title: string;
        status: string;
    }>;
    cases: Array<{
        id: number;
        caseNo: string;
        name: string;
        basis: string;
    }>;
    baselines: Array<{
        id: number;
        baselineNo: string;
        versionLabel: string;
        status: string;
        commitSha: string;
    }>;
}
export type PrSyncRef = 'merge' | 'head';
export declare function getPr(prId: number): Promise<PrRow | null>;
/**
 * 同步库的 PR 到 pull_requests 表：GitCode API 优先；失败/非 GitCode 地址降级
 * 本地 git 历史（provider='local'，只作为提交记录，不冒充 PR）。
 * 按 (provider, repo_url, number) 幂等 upsert —— 状态/合入提交随外部系统更新。
 */
export declare function syncLibraryPrs(libraryId: number, opts?: {
    limit?: number;
    state?: string;
}): Promise<{
    provider: 'gitcode' | 'local';
    synced: number;
    note: string;
    items: PrListItem[];
}>;
export declare function listLibraryPrs(libraryId: number, opts?: {
    state?: string;
    q?: string;
    limit?: number;
}): Promise<PrListItem[]>;
export declare function getPrDetail(prId: number): Promise<PrDetail>;
export declare function linkPrRequirements(prId: number, requirementIds: number[]): Promise<{
    linked: number;
}>;
export declare function linkPrCases(prId: number, caseIds: number[], basis?: string): Promise<{
    linked: number;
}>;
/**
 * 用 PR 的合入提交（或 head 提交）建基线。
 * merge：必须已有 merge_commit_sha（不伪造"已合入"）；head：PR 未合入时的
 * 预验证通道（snapshot.source 标 'pr'，baseline note 写明"非合入提交，仅预验证"）。
 */
export declare function createBaselineFromPr(prId: number, opts?: {
    ref?: PrSyncRef;
    versionLabel?: string;
    createdBy?: string;
}): Promise<{
    baseline: BaselineRow;
    reused: boolean;
}>;
