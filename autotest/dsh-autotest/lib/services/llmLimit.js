// LLM 限流：按分钟窗口卡调用次数，防刷模型额度。
//
// 为什么从 http.ts 搬出来：
// 原来是 http.ts 里的模块级 `llmCalls` 数组，只在**本进程**有效。多节点部署
// （docs/deploy/multi-node.md）下每个节点各算一份，限额形同虚设；而且模块级数组
// 在插件重载时会翻倍累计。
//
// 两级实现：
//  - Redis 可用（data.redisCache + data.redisUrl）：固定窗口 INCR 全局计数，多节点共享；
//  - 不可用：进程内滑动窗口（保持原有语义，至少单节点仍有限流作用）。
//
// 计数点刻意只挂在 API 入口（http.ts 里 { llm: true } 的路由）：一次任务内部会连环
// 调十几次模型，按分钟条数卡会让任务直接失败——那部分成本由 token 预算管
// （services/tokenBudget.ts 的 agent.maxTokensPerTask）。
import { cacheIncr } from './cache.js';
import { getSetting } from './settings.js';
const WINDOW_MS = 60_000;
let localCalls = [];
/** 每分钟上限（exec.llmRatePerMin，最小 1）。 */
function limitPerMin() {
    return Math.max(1, Number(getSetting('exec.llmRatePerMin', 10)) || 10);
}
/** 超限错误（带 statusCode，http.ts 统一转 429）。 */
function tooManyRequests(max) {
    return Object.assign(new Error(`LLM 调用过于频繁（${max} 次/分钟），请稍后再试`), { statusCode: 429 });
}
/**
 * 限流检查：超限抛 429，通过则计入一次。
 * Redis 不可用时静默回退进程内计数（不因限流组件故障阻断正常请求）。
 */
export async function checkLlmRate() {
    const max = limitPerMin();
    // 固定窗口键：按分钟取整，跨窗口自然重置
    const bucket = `llmrl:${Math.floor(Date.now() / WINDOW_MS)}`;
    const n = await cacheIncr(bucket, WINDOW_MS * 2);
    if (n !== null) {
        if (n > max)
            throw tooManyRequests(max);
        return;
    }
    const nowMs = Date.now();
    localCalls = localCalls.filter((t) => nowMs - t < WINDOW_MS);
    if (localCalls.length >= max)
        throw tooManyRequests(max);
    localCalls.push(nowMs);
}
/** 自检/测试用：清空进程内计数。 */
export function resetLlmRateForTest() {
    localCalls = [];
}
