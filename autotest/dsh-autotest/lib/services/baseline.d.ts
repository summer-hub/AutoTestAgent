export type BaselineSource = 'latest' | 'pr' | 'tag' | 'manual';
export interface LibraryCore {
    id: number;
    name: string;
    repo_url: string;
    repo_subpath: string;
    current_version: string;
    last_commit: string;
}
export declare function nextBaselineNo(): Promise<string>;
export declare function nextRunNo(): Promise<string>;
/** 基线根目录：<workspace>/baselines。 */
export declare function baselinesDir(): string;
export interface SnapshotRow {
    id: number;
    repo_url: string;
    commit_sha: string;
    rel_dir: string;
    version_label: string;
    source: string;
    source_pr_id: number | null;
    status: string;
    size_bytes: number;
    metadata_json: string;
    error: string;
    created_by: string;
    created_at: string;
    updated_at: string;
}
/**
 * 解析基线 commit。latest 取工作克隆 HEAD；tag/manual 用 rev-parse 校验；
 * pr 用 merge_commit_sha（B4 ref:'head' 时优先 head_sha —— PR 预验证通道，
 * merge 缺失退 head 并标注"非合入提交"）。拿不到就抛错 —— 不伪造（设计 §5.4 不变量 7）。
 */
export declare function resolveBaselineCommit(lib: LibraryCore, source: BaselineSource, opts?: {
    ref?: string;
    commitSha?: string;
    prId?: number;
}): Promise<{
    commit: string;
    versionLabel: string;
    prId: number | null;
    note: string;
}>;
/**
 * 创建（或复用）物理快照：repo_snapshots 按 (repo_url, commit_sha) 幂等。
 * ready 的快照直接复用；failed 允许重试；creating 拒绝并发重复创建。
 */
export declare function ensureSnapshot(lib: LibraryCore, commit: string, meta: {
    source: BaselineSource;
    versionLabel: string;
    prId: number | null;
    createdBy: string;
    note?: string;
}): Promise<SnapshotRow>;
export interface BaselineRow {
    id: number;
    baseline_no: string;
    snapshot_id: number;
    library_id: number;
    repo_subpath: string;
    version_label: string;
    source: string;
    status: string;
    note: string;
    created_by: string;
    created_at: string;
    updated_at: string;
}
export declare function loadLibrary(libraryId: number): Promise<LibraryCore>;
/**
 * 为库创建（或复用）逻辑基线。(snapshot_id, library_id) 唯一 → 同库同 commit 重复创建幂等返回。
 */
export declare function createBaselineForLibrary(libraryId: number, opts: {
    source: BaselineSource;
    ref?: string;
    commitSha?: string;
    prId?: number;
    versionLabel?: string;
    createdBy?: string;
    note?: string;
}): Promise<{
    baseline: BaselineRow;
    snapshot: SnapshotRow;
    reused: boolean;
}>;
/** 库的最新 ready 基线（按创建时间倒序）。 */
export declare function latestReadyBaseline(libraryId: number): Promise<BaselineRow | undefined>;
/**
 * 计划运行时的基线解析（设计 §6.4 步骤 1 / §5.3.8）：
 *  - fixed：必须命中 ready 基线；
 *  - pr：按 merge_commit_sha 解析（B4 未同步 PR 时明确报错，不静默回退）；
 *  - latest：取库最新 ready 基线；不存在则按工作克隆当前 HEAD 懒创建（写清 note）。
 */
export declare function resolveBaselineForRun(libraryId: number, mode: string, baselineId: number | null): Promise<BaselineRow>;
export interface BaselineDetail extends BaselineRow {
    commit_sha: string;
    repo_url: string;
    rel_dir: string;
    snapshot_status: string;
    size_bytes: number;
    source_pr_id: number | null;
    exec_count: number;
    referenced_by_plan: boolean;
}
export declare function listBaselines(libraryId: number): Promise<BaselineDetail[]>;
export declare function getBaselineDetail(id: number): Promise<BaselineDetail | undefined>;
export interface VerifyResult {
    ok: boolean;
    problems: string[];
    sizeBytes: number;
}
/** 校验基线：目录存在、标记文件 commit 匹配、子目录存在、快照 ready。 */
export declare function verifyBaseline(id: number): Promise<VerifyResult>;
/** 归档（软删）：基线不再出现在可选列表；被计划引用时拒绝。 */
export declare function archiveBaseline(id: number): Promise<void>;
/** 硬删：无引用 + 目录清理。执行记录中的 baseline_id 保留（历史指向允许悬空，详情页显示「已删除」）。 */
export declare function deleteBaseline(id: number): Promise<void>;
/** 基线磁盘占用（配额检查用）。 */
export declare function baselineTotalBytes(): Promise<number>;
/** 创建前配额检查（超限抛 409，提示清理）。 */
export declare function assertBaselineQuota(): Promise<void>;
