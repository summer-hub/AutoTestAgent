import { performance } from 'node:perf_hooks';
export declare class Counter {
    private spec;
    private values;
    constructor(spec: {
        name: string;
        help: string;
        labels: string[];
    });
    inc(labels?: Record<string, string>, by?: number): void;
    serialize(): string;
}
export declare class Gauge {
    private spec;
    private values;
    constructor(spec: {
        name: string;
        help: string;
        labels: string[];
    });
    set(labels: Record<string, string>, value: number): void;
    serialize(): string;
}
export declare class Histogram {
    private spec;
    private buckets;
    /** labelKey → 各桶累计计数（长度 = buckets.length + 1，末位 +Inf） */
    private counts;
    private sums;
    constructor(spec: {
        name: string;
        help: string;
        labels: string[];
    }, buckets?: number[]);
    observe(labels: Record<string, string>, value: number): void;
    serialize(): string;
}
/** HTTP 请求总数（按方法 × 路由模式 × 状态码）。5xx 率 = 服务健康度的第一信号。 */
export declare const httpRequests: Counter;
/** HTTP 请求延迟直方图（秒）。P99 看桶分布，无需额外存储。 */
export declare const httpDuration: Histogram;
/** LLM 调用总数（按 provider × model × status）。失败率与单模型集中度一眼可见。 */
export declare const llmCalls: Counter;
/** LLM token 总量（kind=in|out）。成本核算的原始输入。 */
export declare const llmTokens: Counter;
/** 任务 lane 事件（enqueued/started/finished/cancelled）。积压与取消率看这里。 */
export declare const taskLaneEvents: Counter;
/** 任务 lane 当前排队深度（跨 lane 合计）。持续增长 = 执行能力不足。 */
export declare const taskLaneQueued: Gauge;
/** 任务 lane 当前运行中数量。 */
export declare const taskLaneRunning: Gauge;
/** 进程启动至今的秒数（uptime，Grafana 常用）。 */
export declare const processUptime: Gauge;
/** Prometheus 文本格式（text/plain; version=0.0.4）。 */
export declare function renderMetrics(): string;
/** 供自检/测试复位（避免跨用例计数串扰）。 */
export declare function resetMetrics(): void;
export { performance };
