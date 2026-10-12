// 可观测出口自检（verify:metrics）：进程内起真实 HTTP 服务，验证 P0-3 全链路。
// 用法：npm run build && npm run verify:metrics
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-metrics-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;
delete process.env.AUTOTEST_LOG_FORMAT; // 默认文本模式

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { makeApiHandler } = await import('../lib/api/http.js');
const { renderMetrics, resetMetrics, httpRequests, httpDuration, llmCalls, llmTokens } = await import('../lib/services/metrics.js');
const { installTelemetry } = await import('../lib/services/telemetry.js');
const { emitLlmTrace } = await import('../lib/services/llmCore.js');
const { createApiKey } = await import('../lib/services/auth.js');
const { setSetting } = await import('../lib/services/settings.js');
const { ensureReady } = await import('../lib/db/connection.js');

installTelemetry();
await ensureReady();

const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
const handler = makeApiHandler(stubLlm);
const server = http.createServer((req, res) => { void handler(req, res); });
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api/autotest`;

function raw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        res.on('error', () => {});
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] ?? '', text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('socket', (s) => s.on('error', () => {}));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- 1. 注册表单元行为 ----------
resetMetrics();
httpRequests.inc({ method: 'GET', route: '/x', status: '200' });
httpRequests.inc({ method: 'GET', route: '/x', status: '200' });
httpRequests.inc({ method: 'GET', route: '/x', status: '500' });
httpDuration.observe({ method: 'GET', route: '/x' }, 0.02);
const unit = renderMetrics();
check(unit.includes('autotest_http_requests_total{method="GET",route="/x",status="200"} 2'), 'Counter 累加正确');
check(unit.includes('autotest_http_requests_total{method="GET",route="/x",status="500"} 1'), 'Counter 按标签分列');
check(unit.includes('# TYPE autotest_http_requests_total counter'), 'Prometheus TYPE 注释（counter）');
check(unit.includes('autotest_http_request_duration_seconds_bucket{le="0.025",method="GET",route="/x"} 1'), 'Histogram 桶归属正确（累积语义）');
check(unit.includes('autotest_http_request_duration_seconds_bucket{le="0.01",method="GET",route="/x"} 0'), 'Histogram 小桶不含大值（0.02 > 0.01）');
check(unit.includes('autotest_http_request_duration_seconds_count{method="GET",route="/x"} 1'), 'Histogram count');
check(unit.includes('autotest_http_request_duration_seconds_sum{method="GET",route="/x"} 0.020000'), 'Histogram sum');
check(unit.includes('autotest_process_uptime_seconds'), 'uptime 仪表存在');

// ---------- 2. LLM 埋点（trace hook → 指标） ----------
resetMetrics();
emitLlmTrace({ kind: 'llm_call', provider: 'deepseek', model: 'deepseek-chat', latencyMs: 120, attempts: 1, tokensIn: 100, tokensOut: 50, promptChars: 10, outputChars: 20, status: 'ok' });
emitLlmTrace({ kind: 'llm_call', provider: 'deepseek', model: 'deepseek-chat', latencyMs: 90, attempts: 2, tokensIn: 30, tokensOut: 0, promptChars: 5, outputChars: 0, status: 'error' });
const llmOut = renderMetrics();
check(llmOut.includes('autotest_llm_calls_total{model="deepseek-chat",provider="deepseek",status="ok"} 1'), 'LLM 成功调用计数');
check(llmOut.includes('autotest_llm_calls_total{model="deepseek-chat",provider="deepseek",status="error"} 1'), 'LLM 失败调用计数');
check(llmOut.includes('autotest_llm_tokens_total{kind="in"} 130'), 'LLM token 入累计');
check(llmOut.includes('autotest_llm_tokens_total{kind="out"} 50'), 'LLM token 出累计');

// ---------- 3. HTTP 埋点（经真实服务） ----------
resetMetrics();
const libRes = await raw('GET', '/libraries?pageSize=1');
check(libRes.status === 200, '业务请求本身成功', `status=${libRes.status}`);
const missRes = await raw('GET', '/definitely-not-a-route');
check(missRes.status === 404, '未匹配路由 404', `status=${missRes.status}`);
const httpOut = renderMetrics();
check(httpOut.includes('autotest_http_requests_total{method="GET",route="/libraries",status="200"} 1'), 'HTTP 计数按路由模式聚合（:id 不会炸基数）');
check(httpOut.includes('autotest_http_requests_total{method="GET",route="(unmatched)",status="404"} 1'), '未匹配路由计入 (unmatched)');
check(/autotest_http_request_duration_seconds_bucket\{le="[^"]+",method="GET",route="\/libraries"/.test(httpOut), '延迟直方图按路由记录');

// ---------- 4. /metrics 端点（Prometheus 文本 + 认证门禁） ----------
const m1 = await raw('GET', '/metrics');
check(m1.status === 200 && m1.contentType.includes('text/plain') && m1.contentType.includes('version=0.0.4'), '/metrics 是 Prometheus 文本格式', m1.contentType);
check(m1.text.includes('autotest_http_requests_total'), '/metrics 内容含指标');

setSetting('auth.enabled', true);
setSetting('auth.allowLocalBypass', false);
const admin = await createApiKey({ name: 'm-admin', role: 'admin' });
const viewer = await createApiKey({ name: 'm-viewer', role: 'viewer' });
const mNoKey = await raw('GET', '/metrics');
check(mNoKey.status === 401, '认证开启：/metrics 无 Key → 401', `status=${mNoKey.status}`);
const mViewer = await raw('GET', '/metrics', { headers: { Authorization: `Bearer ${viewer.key}` } });
check(mViewer.status === 403, '认证开启：/metrics viewer → 403（限 admin）', `status=${mViewer.status}`);
const mAdmin = await raw('GET', '/metrics', { headers: { Authorization: `Bearer ${admin.key}` } });
check(mAdmin.status === 200 && mAdmin.text.includes('autotest_'), '认证开启：/metrics admin → 200', `status=${mAdmin.status}`);
setSetting('auth.enabled', false);
const mOff = await raw('GET', '/metrics');
check(mOff.status === 200, '认证关闭：/metrics 直通', `status=${mOff.status}`);

// ---------- 5. 结构化日志（子进程：json 模式输出 JSON 行；文本模式不输出请求行） ----------
// 子进程必须 --input-type=module：node -e 默认按 CJS 求值，顶层 await import 会直接 SyntaxError。
// 模块路径用 file:// URL（pathToFileURL）：Windows 下裸盘符路径不是合法 import 说明符。
const loggerUrl = pathToFileURL(fileURLToPath(new URL('../lib/services/logger.js', import.meta.url))).href;
const childJson = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { logger } = await import(${JSON.stringify(loggerUrl)});
logger.info('hello', { a: 1 });
logger.request('GET', '/x', 200, 12.34);
`], { env: { ...process.env, AUTOTEST_LOG_FORMAT: 'json' }, encoding: 'utf8' });
const jsonLines = childJson.stdout.trim().split('\n').filter(Boolean);
let parsedOk = false;
let reqOk = false;
try {
  const objs = jsonLines.map((l) => JSON.parse(l));
  parsedOk = objs.length === 2 && objs[0].level === 'info' && objs[0].msg === 'hello' && objs[0].a === 1 && typeof objs[0].time === 'string';
  reqOk = objs[1]?.msg === 'http_request' && objs[1]?.method === 'GET' && objs[1]?.route === '/x' && objs[1]?.status === 200 && objs[1]?.durationMs === 12.3;
} catch { /* 解析失败即不通过 */ }
check(parsedOk, 'json 日志模式：输出合法 JSON 行（level/msg/time/字段）', jsonLines[0]?.slice(0, 80));
check(reqOk, 'json 日志模式：请求行含 method/route/status/durationMs', jsonLines[1]?.slice(0, 100));

const childText = spawnSync(process.execPath, ['--input-type=module', '-e', `
const { logger } = await import(${JSON.stringify(loggerUrl)});
logger.request('GET', '/x', 200, 12.34);
console.log('TEXT_MODE_MARKER');
`], { env: { ...process.env, AUTOTEST_LOG_FORMAT: '' }, encoding: 'utf8' });
const textOut = childText.stdout;
check(textOut.includes('TEXT_MODE_MARKER') && !textOut.includes('http_request'), '文本日志模式（默认）：请求行不输出，行为不变');

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
server.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
