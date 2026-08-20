// M7 压测：并发请求 AutoTest API，输出 QPS / p50 / p95 / p99。
// 用法：
//   node scripts/stress.mjs                    # 默认 16 并发 × 200 请求
//   CONCURRENCY=32 REQUESTS=500 node scripts/stress.mjs
// 流程：先跑一轮（冷缓存）→ 再跑一轮（热缓存），对比缓存收益；结果写入 stress-report.json。
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.AUTOTEST_URL ?? 'http://localhost:3080/api/autotest';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const REQUESTS = Number(process.env.REQUESTS ?? 200);

const ENDPOINTS = [
  '/health',
  '/libraries?pageSize=50',
  '/libraries/1',
  '/libraries/1/cases?pageSize=50',
  '/cases/stats/overview',
  '/prompts',
  '/devices',
  '/stats/sharding',
];

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function run(label) {
  const tasks = Array.from({ length: REQUESTS }, (_, i) => ENDPOINTS[i % ENDPOINTS.length]);
  let cursor = 0;
  const latencies = [];
  let errors = 0;
  const started = Date.now();

  async function worker() {
    while (cursor < tasks.length) {
      const path = tasks[cursor++];
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedMs = Date.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    label, concurrency: CONCURRENCY, requests: latencies.length, errors,
    qps: Math.round((latencies.length / elapsedMs) * 1000),
    p50: Math.round(pct(sorted, 50) * 10) / 10,
    p95: Math.round(pct(sorted, 95) * 10) / 10,
    p99: Math.round(pct(sorted, 99) * 10) / 10,
    elapsedMs,
  };
  console.log(JSON.stringify(report));
  return report;
}

console.log(`压测 ${BASE} · ${CONCURRENCY} 并发 × ${REQUESTS} 请求`);
const cold = await run('cold');
const warm = await run('warm');

const out = { base: BASE, cold, warm, speedup: warm.qps > 0 ? Math.round((cold.qps / warm.qps) * 100) / 100 : 0, at: new Date().toISOString() };
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'stress-report.json');
writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
console.log('报告已写入', file);
