/**
 * 限流检查：超限抛 429，通过则计入一次。
 * Redis 不可用时静默回退进程内计数（不因限流组件故障阻断正常请求）。
 */
export declare function checkLlmRate(): Promise<void>;
/** 自检/测试用：清空进程内计数。 */
export declare function resetLlmRateForTest(): void;
