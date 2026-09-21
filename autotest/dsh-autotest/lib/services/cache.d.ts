export declare function cacheGet<T>(key: string): Promise<T | undefined>;
export declare function cacheSet(key: string, value: unknown, ttlOverrideMs?: number): Promise<void>;
/** 按前缀失效（写路径调用，如 cacheDel('cases') 清掉所有 cases:* 键）。 */
export declare function cacheDel(prefix: string): Promise<void>;
/**
 * 计数器 +1（固定窗口限流用，全局限流必须落在共享存储上才有多节点意义）。
 * 限流计数**故意不写内存 LRU**：多节点部署下各节点各算一份等于没限。
 * Redis 未启用或出错时返回 null，由调用方回退到进程内计数。
 */
export declare function cacheIncr(key: string, ttlMs: number): Promise<number | null>;
