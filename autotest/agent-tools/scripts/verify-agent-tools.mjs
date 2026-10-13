// agent 接口层自检（verify:agent-tools）——三道闸门，全部离线可跑：
//  ① 漂移检测：每条命令规格（dist/specs.mjs）的 method+path 必须在 dsh-autotest 真实路由表中
//     （API 演进后规格腐烂会被当场抓住）。故意不进 agent 面的管理路由（models/prompts/settings 等）
//     仅罗列不 FAIL——那是产品决策，不是漂移。
//  ② CLI 端到端：进程内起真实 HTTP 服务（makeApiHandler），spawn dist/cli.mjs 打真实请求：
//     health.check（exit 0 + envelope 可解析）、未知命令（exit 2）、缺必填（exit 2）、
//     网络不可达（exit 5）、认证开启+关回环豁免后无 token（exit 4）/ admin key（exit 0）。
//  ③ MCP 端到端：spawn dist/mcp-server.mjs（AUTOTEST_BASE_URL 指向进程内服务）：
//     initialize / tools/list（数量=规格数）/ tools/call 成功 / 未知工具 isError / 缺参 isError。
// 前置：dist/ 必须已构建（verify:all 链先跑 build:agent-tools）；缺失时明确报错。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const agentToolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = path.resolve(agentToolsRoot, '..', 'dsh-autotest');
const distCli = path.join(agentToolsRoot, 'dist', 'cli.mjs');
const distMcp = path.join(agentToolsRoot, 'dist', 'mcp-server.mjs');
const distSpecs = path.join(agentToolsRoot, 'dist', 'specs.mjs');

/** Windows 绝对路径必须转 file:// URL 才能喂给动态 import（否则报 protocol 'd:'）。 */
const asUrl = (p) => pathToFileURL(p).href;

for (const f of [distCli, distMcp, distSpecs]) {
  if (!fs.existsSync(f)) {
    console.error(`[verify:agent-tools] 缺少构建产物 ${f}——请先执行：cd autotest && npm run build:agent-tools`);
    process.exit(1);
  }
}

// ⚠️ 临时数据目录：绝不碰用户真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-agenttools-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { COMMANDS } = await import(asUrl(distSpecs));
const { makeApiHandler } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'http.js')));
const { setSetting } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'settings.js')));
const { createApiKey, revokeApiKey } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'auth.js')));
const { ensureReady } = await import(asUrl(path.join(dshRoot, 'lib', 'db', 'connection.js')));

// ---------- ① 规格 ↔ 路由漂移 ----------
{
  const httpSrc = fs.readFileSync(path.join(dshRoot, 'src', 'api', 'http.ts'), 'utf8');
  const routes = [...httpSrc.matchAll(/route\('(GET|POST|PUT|DELETE)',\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  const routeSet = new Set(routes);
  const specSet = new Set(COMMANDS.map((c) => `${c.method} ${c.path}`));
  const missing = COMMANDS.filter((c) => !routeSet.has(`${c.method} ${c.path}`));
  check(missing.length === 0, `规格↔路由漂移：${COMMANDS.length} 条规格全部命中真实路由`,
    missing.length ? missing.map((c) => `${c.method} ${c.path}`).join('; ') : `（路由表共 ${routes.length} 条）`);
  const uncovered = routes.filter((r) => !specSet.has(r));
  console.log(`— 路由表中 ${uncovered.length} 条未进 agent 面（管理/高级面，产品决策，仅罗列）：${uncovered.slice(0, 14).join(', ')}${uncovered.length > 14 ? ' …' : ''}`);
  // 规格参数引用的 bodyPaths 目标不校验（服务端内部结构），但角色必须合法
  const badRole = COMMANDS.filter((c) => !['viewer', 'operator', 'admin'].includes(c.role));
  check(badRole.length === 0, '规格角色标注合法（viewer/operator/admin）', badRole.map((c) => c.name).join(','));
}

// ---------- 进程内真实 HTTP 服务 ----------
const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
const handler = makeApiHandler(stubLlm);
const server = http.createServer((req, res) => { void handler(req, res); });
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api/autotest`;
console.log(`— 自检服务：${BASE} —`);
await ensureReady();

/**
 * 异步 spawn（**不能用 spawnSync**：它会冻结父进程事件循环，
 * 而本自检的 HTTP 服务就在父进程里——子进程打过来的请求没人应答，必然超时）。
 */
function runProcess(cmd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) { child.stdin.end(input); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}
const runCli = (args, env = {}) => runProcess(process.execPath, [distCli, ...args], { env });
const runMcp = (lines) => runProcess(process.execPath, [distMcp], {
  input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  env: { AUTOTEST_BASE_URL: BASE },
});
function parseEnvelope(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { return null; }
}

// ---------- ② CLI 端到端 ----------
{
  const r = await runCli(['health.check', '--base', BASE]);
  const env = parseEnvelope(r.stdout);
  check(r.status === 0 && env?.ok === true && env?.data?.ok === true, 'CLI：health.check → exit 0 + envelope ok', `exit=${r.status}`);
}
{
  const r = await runCli(['no.such.command', '--base', BASE]);
  check(r.status === 2, 'CLI：未知命令 → exit 2', `exit=${r.status}`);
}
{
  const r = await runCli(['cases.get', '--base', BASE]); // 缺必填 id
  check(r.status === 2, 'CLI：缺必填参数 → exit 2', `exit=${r.status}`);
}
{
  const r = await runCli(['health.check', '--base', 'http://127.0.0.1:39999/api/autotest']);
  check(r.status === 5, 'CLI：网络不可达 → exit 5', `exit=${r.status}`);
}
{
  // 认证开启 + 关回环豁免：无 token → exit 4；admin key → exit 0
  // 注意：必须用**非 authOpen** 的端点（如 libraries.list）——/health 按设计免鉴权（LB 探活），
  // 拿它测 401 会误报（曾在此处误判，实际是测试选错端点）。
  setSetting('auth.enabled', true);
  setSetting('auth.allowLocalBypass', false);
  const key = await createApiKey({ name: 'verify-agent-tools', role: 'admin' });
  const noTok = await runCli(['libraries.list', '--base', BASE]);
  check(noTok.status === 4, 'CLI：认证开启无 token → exit 4（Bearer 鉴权生效）', `exit=${noTok.status}`);
  const withTok = await runCli(['libraries.list', '--base', BASE, '--token', key.key]);
  const env = parseEnvelope(withTok.stdout);
  check(withTok.status === 0 && env?.ok === true, 'CLI：带 admin key → exit 0', `exit=${withTok.status}`);
  // viewer key 调 operator 命令 → exit 3（403 FORBIDDEN）
  const viewer = await createApiKey({ name: 'verify-agent-tools-viewer', role: 'viewer' });
  const forbidden = await runCli(['cases.create', '--libraryId', '1', '--caseNo', 'X', '--name', 'Y', '--base', BASE, '--token', viewer.key]);
  check(forbidden.status === 3, 'CLI：viewer 调写操作 → exit 3（角色强制）', `exit=${forbidden.status}`);
  await revokeApiKey(key.id);
  await revokeApiKey(viewer.id);
  setSetting('auth.enabled', false);
  setSetting('auth.allowLocalBypass', true);
}

// ---------- ③ MCP 端到端 ----------
{
  const r = await runMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health.check', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no.such.tool', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cases.get', arguments: {} } },
  ]);
  const msgs = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  check(byId.get(1)?.result?.serverInfo?.name === 'autotest-agent-tools', 'MCP：initialize → serverInfo 正确');
  check((byId.get(2)?.result?.tools?.length ?? 0) === COMMANDS.length, 'MCP：tools/list 数量 = 规格数', `${byId.get(2)?.result?.tools?.length}/${COMMANDS.length}`);
  const call3 = byId.get(3);
  const p3 = call3 && !call3.result.isError ? (() => { try { return JSON.parse(call3.result.content[0].text); } catch { return null; } })() : null;
  check(p3?.ok === true && p3?.data?.ok === true, 'MCP：tools/call health.check → 成功 content');
  check(byId.get(4)?.result?.isError === true, 'MCP：未知工具 → isError');
  check(byId.get(5)?.result?.isError === true, 'MCP：缺必填参数 → isError');
  check(msgs.filter((m) => m.id === undefined).length === 0, 'MCP：通知消息不产生响应（协议卫生）');
}

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
server.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
