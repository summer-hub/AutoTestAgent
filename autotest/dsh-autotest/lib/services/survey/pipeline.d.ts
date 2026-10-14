import { type LibraryFacts, type LibraryKind } from './facts.js';
export interface SurveyBatchOptions {
    /** all = 全量；kinds = 按类别；ids = 指定库 */
    scope?: 'all' | 'kinds' | 'ids';
    /** scope=kinds 时的类别列表 */
    kinds?: LibraryKind[];
    /** scope=ids 时的库 id 列表 */
    ids?: number[];
    /** 并发度（默认 4） */
    concurrency?: number;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 是否复用已 done 且 commit 未变的记录（默认 true） */
    resume?: boolean;
    /** 是否顺带按 preset 生成 env_profiles 草稿（默认 true） */
    createProfiles?: boolean;
}
export interface SurveyBatchResult {
    batchId: number;
    batchNo: string;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    needsLlm: number;
    /** 按类别统计（验收指标：画像完整率 / 预设命中率） */
    byKind: Record<string, number>;
    durationMs: number;
}
/** 单库采集（批次与手动单跑共用）。返回是否成功与是否需要 LLM。 */
export declare function surveyLibrary(libraryId: number, opts?: {
    createProfiles?: boolean;
    signal?: AbortSignal;
}): Promise<{
    ok: boolean;
    skipped: boolean;
    needsLlm: boolean;
    failureKind: string;
    failureWhat: string;
    kind?: LibraryKind;
}>;
/**
 * 跑一批采集。
 *
 * 并发实现用「固定 worker 池 + 共享队列」而不是 Promise.all 分批：
 * 348 个库里单个库的耗时差异极大（空目录 vs 几千文件），固定池能让
 * 快库不闲着、慢库不堵住整批。
 */
export declare function runSurveyBatch(opts?: SurveyBatchOptions): Promise<SurveyBatchResult>;
/** 批次概况（前端「全量分析」页与验收指标共用）。 */
export declare function surveyStats(): Promise<{
    batches: Array<Record<string, unknown>>;
    byKind: Array<{
        kind: string;
        count: number;
        needsLlm: number;
    }>;
    totals: {
        libraries: number;
        surveyed: number;
        needsLlm: number;
        failed: number;
        presetsMatched: number;
    };
}>;
/**
 * L1 预设匹配 → env_profiles 草稿。
 * 幂等：同库同 preset 类别已有画像则不重复建（库名唯一键兜底）。
 */
declare function createProfileFromPreset(libraryId: number, libraryName: string, kind: LibraryKind, facts: LibraryFacts): Promise<{
    ok: boolean;
    reason?: string;
}>;
/** 供自检复用：把 facts 直接写库（不依赖仓库扫描）。 */
export declare function saveFactsForTest(libraryId: number, commit: string, f: LibraryFacts): Promise<void>;
/** 导出内部工具（自检与 preset 匹配用）。 */
export { createProfileFromPreset };
