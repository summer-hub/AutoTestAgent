import type { RawRepoScan } from './facts.js';
export interface ScanResult {
    ok: boolean;
    scan?: RawRepoScan;
    reason?: string;
    /** 扫描到的文件数（诊断用） */
    fileCount?: number;
}
/**
 * 扫描仓库目录。目录不存在/不可读 → ok=false + reason（调用方记失败分类）。
 * 注意：仓库未 clone 是**常见且预期**的情况（348 个库不可能全部 clone），
 * 上层应把它归成"待拉取"而不是错误。
 */
export declare function scanRepo(repoDir: string, libraryName: string): ScanResult;
