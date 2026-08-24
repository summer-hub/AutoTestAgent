export declare function cacheGet<T>(key: string): Promise<T | undefined>;
export declare function cacheSet(key: string, value: unknown, ttlOverrideMs?: number): Promise<void>;
/** 按前缀失效（写路径调用，如 cacheDel('cases') 清掉所有 cases:* 键）。 */
export declare function cacheDel(prefix: string): Promise<void>;
