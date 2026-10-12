// 独立服务器压测脚本：对 /healthz 与业务 API 打并发，输出 RPS / P50 / P99 / 错误率。
//
// 用法：
//   node scripts/bench-standalone.mjs [总请求数] [并发数] [baseUrl]
// 例：
//   node scripts/bench-standalone.mjs 2000 50 http://127.0.0.1:3280
//
// 说明：
//  - 纯 node:http + keep-alive 连接池（零依赖），连接数 = 并发数，尽量复用不过度建连；
//  - 只读接口（GET），不写业务数据；SQLite 模式下同样可跑（单文件库读并发靠 WAL）；
//  - 先预热若干请求（JIT / 连接池 / 缓存），不计入结果。
import http from 'node:http';

const TOTAL = Number(process.argv[2] ?? 2000);
const CONCURRENCY = Number(process.argv[3] ?? 50);
const BASE = process.argv[4] ?? 'http://127.0.0.1:3280';
const base = new URL(BASE);

// 被测端点（按真实前端首屏会打的接口加权轮询）
const ENDPOINTS = [
  { path: '/healthz', weight: 1 },
  { path: '/api/autotest/health', weight: 2 },
  { path: '/api/autotest/libraries?pageSize=20', weight: 3 },
  { path: '/api/autotest/settings', weight: 2 },
];
const POOL = ENDPOINTS.flatMap((e) => Array(e.weight).fill(e.path));

const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY });

function hit(path) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: 'GET',
        agent,
        headers: { 'Accept-Encoding': 'gzip' }, // 与真实浏览器一致，命中 .gz 预压缩分支
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = performance.now() - t0;
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          resolve({ ok, status: res.statusCode, ms });
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: performance.now() - t0, err: e.message }));
    req.end();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  // 预热（不计入结果）
  for (const p of POOL.slice(0, 4)) await hit(p);

  const latencies = [];
  let errors = 0;
  const statusCount = new Map();
  let next = 0;
  const t0 = performance.now();

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const r = await hit(POOL[i % POOL.length]);
      if (!r.ok) errors += 1;
      statusCount.set(r.status, (statusCount.get(r.status) ?? 0) + 1);
      latencies.push(r.ms);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const totalMs = performance.now() - t0;

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, v) => s + v, 0) / Math.max(1, latencies.length);
  console.log(`\n==== 压测结果 ====`);
  console.log(`目标        : ${BASE}（${POOL.length} 个端点加权轮询）`);
  console.log(`请求        : ${TOTAL} 个，并发 ${CONCURRENCY}`);
  console.log(`总耗时      : ${(totalMs / 1000).toFixed(2)} s`);
  console.log(`RPS         : ${(TOTAL / (totalMs / 1000)).toFixed(0)}`);
  console.log(`延迟 avg/p50/p99/max : ${avg.toFixed(1)} / ${percentile(latencies, 50).toFixed(1)} / ${percentile(latencies, 99).toFixed(1)} / ${latencies[latencies.length - 1]?.toFixed(1)} ms`);
  console.log(`错误        : ${errors}（${((errors / TOTAL) * 100).toFixed(2)}%）`);
  console.log(`状态码分布  : ${[...statusCount.entries()].map(([s, n]) => `${s}×${n}`).join('  ')}`);
  agent.destroy();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => { console.error('压测失败：', e); process.exit(1); });
