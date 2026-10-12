// 指标注册表（P0-3 可观测出口）：零依赖，Prometheus 文本格式。
//
// 为什么不用 prom-client：本项目依赖纪律是"原生模块只留 better-sqlite3 一个"，
// 而 counter/gauge/histogram 三类 + 文本序列化几十行即可覆盖，没有引入新依赖的理由。
//
// 语义边界（写进文档，避免误读）：
//  - **进程内聚合**：集群模式下每个 worker 各有一份计数。需要全集群精确值时，
//    要么从 LB/节点 exporter 侧聚合，要么接 Redis（本项目已有）——注册表本身不跨进程。
//  - 路由标签用**模式**（/libraries/:id）而非实际路径，防止 :id 基数爆炸。
import { performance } from 'node:perf_hooks';

function fmtLabels(labels: Record<string, string>): string {
  // 按 key 排序输出：与调用方构造对象的键序解耦，输出确定性（测试断言与 diff 友好）
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const inner = keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
  return `{${inner}}`;
}

export class Counter {
  private values = new Map<string, number>();
  constructor(private spec: { name: string; help: string; labels: string[] }) {}
  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = JSON.stringify(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  serialize(): string {
    const lines = [`# HELP ${this.spec.name} ${this.spec.help}`, `# TYPE ${this.spec.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.spec.name}${fmtLabels(JSON.parse(k) as Record<string, string>)} ${v}`);
    return lines.join('\n');
  }
}

export class Gauge {
  private values = new Map<string, number>();
  constructor(private spec: { name: string; help: string; labels: string[] }) {}
  set(labels: Record<string, string>, value: number): void {
    this.values.set(JSON.stringify(labels), value);
  }
  serialize(): string {
    const lines = [`# HELP ${this.spec.name} ${this.spec.help}`, `# TYPE ${this.spec.name} gauge`];
    for (const [k, v] of this.values) lines.push(`${this.spec.name}${fmtLabels(JSON.parse(k) as Record<string, string>)} ${v}`);
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  private buckets: number[];
  /** labelKey → 各桶累计计数（长度 = buckets.length + 1，末位 +Inf） */
  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  constructor(private spec: { name: string; help: string; labels: string[] }, buckets = DEFAULT_BUCKETS) {
    this.buckets = [...buckets, Infinity];
  }
  observe(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    let arr = this.counts.get(key);
    if (!arr) { arr = new Array(this.buckets.length).fill(0); this.counts.set(key, arr); }
    // Prometheus 直方图是**累积**语义：所有 le >= value 的桶都 +1（末桶 +Inf 必中，
    // 因此末桶计数即观测总数）。只给首个命中桶 +1 是错的——那会让 le 更大的桶偏小。
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) arr[i] += 1;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }
  serialize(): string {
    const lines = [`# HELP ${this.spec.name} ${this.spec.help}`, `# TYPE ${this.spec.name} histogram`];
    for (const [key, arr] of this.counts) {
      const labels = JSON.parse(key) as Record<string, string>;
      const total = arr[arr.length - 1];
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i] === Infinity ? '+Inf' : String(this.buckets[i]);
        lines.push(`${this.spec.name}_bucket${fmtLabels({ ...labels, le })} ${arr[i]}`);
      }
      lines.push(`${this.spec.name}_sum${fmtLabels(labels)} ${(this.sums.get(key) ?? 0).toFixed(6)}`);
      lines.push(`${this.spec.name}_count${fmtLabels(labels)} ${total}`);
    }
    return lines.join('\n');
  }
}

// ---------- 本项目的指标实例 ----------

/** HTTP 请求总数（按方法 × 路由模式 × 状态码）。5xx 率 = 服务健康度的第一信号。 */
export const httpRequests = new Counter({
  name: 'autotest_http_requests_total', help: 'HTTP 请求总数（5xx 率是服务健康度第一信号）', labels: ['method', 'route', 'status'],
});
/** HTTP 请求延迟直方图（秒）。P99 看桶分布，无需额外存储。 */
export const httpDuration = new Histogram({
  name: 'autotest_http_request_duration_seconds', help: 'HTTP 请求延迟（秒）', labels: ['method', 'route'],
});
/** LLM 调用总数（按 provider × model × status）。失败率与单模型集中度一眼可见。 */
export const llmCalls = new Counter({
  name: 'autotest_llm_calls_total', help: 'LLM 调用总数', labels: ['provider', 'model', 'status'],
});
/** LLM token 总量（kind=in|out）。成本核算的原始输入。 */
export const llmTokens = new Counter({
  name: 'autotest_llm_tokens_total', help: 'LLM token 总量（成本核算原始输入）', labels: ['kind'],
});
/** 任务 lane 事件（enqueued/started/finished/cancelled）。积压与取消率看这里。 */
export const taskLaneEvents = new Counter({
  name: 'autotest_task_lane_events_total', help: '任务 lane 事件', labels: ['event'],
});
/** 任务 lane 当前排队深度（跨 lane 合计）。持续增长 = 执行能力不足。 */
export const taskLaneQueued = new Gauge({
  name: 'autotest_task_lane_queued', help: '任务 lane 当前排队深度（合计）', labels: [],
});
/** 任务 lane 当前运行中数量。 */
export const taskLaneRunning = new Gauge({
  name: 'autotest_task_lane_running', help: '任务 lane 当前运行中数量', labels: [],
});

/** 进程启动至今的秒数（uptime，Grafana 常用）。 */
export const processUptime = new Gauge({ name: 'autotest_process_uptime_seconds', help: '进程启动至今（秒）', labels: [] });
const BOOT_TS = Date.now() / 1000;

/** Prometheus 文本格式（text/plain; version=0.0.4）。 */
export function renderMetrics(): string {
  processUptime.set({}, Number((Date.now() / 1000 - BOOT_TS).toFixed(3)));
  return [
    httpRequests.serialize(),
    httpDuration.serialize(),
    llmCalls.serialize(),
    llmTokens.serialize(),
    taskLaneEvents.serialize(),
    taskLaneQueued.serialize(),
    taskLaneRunning.serialize(),
    processUptime.serialize(),
  ].join('\n\n') + '\n';
}

/** 供自检/测试复位（避免跨用例计数串扰）。 */
export function resetMetrics(): void {
  for (const m of [httpRequests, httpDuration, llmCalls, llmTokens, taskLaneEvents, taskLaneQueued, taskLaneRunning]) {
    // 私有 Map 逐个清：不暴露内部结构，但测试需要干净起点
    (m as unknown as { values?: Map<string, unknown>; counts?: Map<string, unknown>; sums?: Map<string, number> }).values?.clear();
    (m as unknown as { counts?: Map<string, unknown> }).counts?.clear();
    (m as unknown as { sums?: Map<string, number> }).sums?.clear();
  }
}

export { performance };
