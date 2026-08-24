export declare function computeCaseStats(): Promise<{
    total: number;
    byStatus: Array<Record<string, unknown>>;
    versioned: number;
}>;
/** 预热统计缓存（写路径 cacheDel 后由下一次定时刷新兜底）。 */
export declare function warmStatsCache(): Promise<void>;
