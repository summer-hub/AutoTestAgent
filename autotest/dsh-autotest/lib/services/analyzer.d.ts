import type { LlmCall } from './llmCore.js';
export interface PrFile {
    filename: string;
    additions: number;
    deletions: number;
}
export interface GitCodePr {
    number: number;
    title: string;
    state: string;
    body: string;
    created_at: string;
    merged_at: string | null;
    added_lines: number;
    removed_lines: number;
    web_url: string;
    files: PrFile[];
    /** B4：合入提交（真实 PR 才有；拿不到就缺省，不伪造 —— head 基线据此标注"仅预验证"） */
    merge_commit_sha?: string;
    /** B4：head 提交（PR 分支最新提交；本地 git 降级时为提交 hash） */
    head_sha?: string;
    /** B4：目标分支 / 来源分支 */
    base_branch?: string;
    head_branch?: string;
    /** B4：作者 */
    author?: string;
}
/** 从仓库 URL 提取 GitCode owner/repo；非 GitCode 地址返回 null。 */
export declare function parseRepoPath(repoUrl: string | null | undefined): string | null;
/** 拉取仓库 PR 列表 + 每个 PR 的变更文件（并发拉取文件，失败不影响主体）。 */
export declare function fetchPrs(repoPath: string, limit?: number, timeoutMs?: number): Promise<GitCodePr[]>;
/** 拉取单个 PR（含变更文件），供「选择 #PR 分析」使用。 */
export declare function fetchPr(repoPath: string, prNumber: number, timeoutMs?: number): Promise<GitCodePr>;
/**
 * GitCode API 不可用时的降级方案：在本地已拉取的仓库目录下用 git 命令，
 * 把最近提交当作「PR」数据（number = 提交序号 1..N，title = 提交标题，state = merged，
 * files = 该提交变更的文件），供分析流程继续使用。
 */
export declare function fetchPrsFromGit(dir: string, opts?: {
    limit?: number;
    numbers?: number[];
}): GitCodePr[];
export interface LibraryRow {
    id: number;
    name: string;
    repo_url: string;
    current_version: string;
    description: string;
}
/**
 * LLM 不可用：转成一条能直接指路的告警错误（上层以红色呈现，不再落任何分析结果）。
 *
 * 不降级的原因：规则兜底只会照抄 PR 标题、按文件名猜影响，产出的结论和 AI 结论
 * 长得一模一样、存在同一张列表里，使用者分不出哪条是推测——误把套话当根因，
 * 比干脆没有结论更危险。所以这里只报错，并把排查动作写进消息里。
 */
export declare function llmUnavailableError(scope: string, e: unknown): Error;
export interface AnalyzeResult {
    analyzed: number;
    prs: number;
    source: 'llm' | 'fallback';
    message: string;
}
/** PR 数据分析：每个 PR 产出「更新点 / 影响 / 建议用例更新 / 风险」。 */
export declare function analyzePrChanges(llm: LlmCall, library: LibraryRow, prs: GitCodePr[], onStage?: (stage: string) => void, round?: string): Promise<AnalyzeResult>;
/** 用例更新分析：结合 PR 变更与现有用例，产出需要更新的用例及理由。 */
export declare function analyzeCaseUpdates(llm: LlmCall, library: LibraryRow, prs: GitCodePr[], onStage?: (stage: string) => void, round?: string): Promise<AnalyzeResult>;
export interface AttributionOptions {
    /** 勾选的用例 id（跨库任意多选；与 libraryIds 可组合） */
    caseIds?: number[];
    /** 库级选择（该库全部失败执行） */
    libraryIds?: number[];
    /** 全部库所有失败执行 */
    allLibraries?: boolean;
}
/** 归因分析：按勾选范围（任意用例多选 / 库级 / 全部）对失败执行做 AI 归因。 */
export declare function analyzeAttribution(llm: LlmCall, opts: AttributionOptions): Promise<AnalyzeResult>;
