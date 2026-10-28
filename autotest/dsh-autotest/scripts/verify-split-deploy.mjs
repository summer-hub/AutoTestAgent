// A3 分离部署自检（verify:split-deploy，设计 §13/§15.3）——进程内 http+ws 服务 + 裸 socket 握手：
//  ① runtime-config：AUTOTEST_PUBLIC_API_BASE/WS_BASE 透传；缺省空串；authOpen 可匿名读；
//  ② 同源基线：无 Origin（CLI）放行；同源 Origin 放行；跨源/Sec-Fetch-Site: cross-site → 403；
//  ③ CORS 白名单（AUTOTEST_CORS_ORIGINS）：命中 → 200 + ACAO 回显 + Vary: Origin + 允许 Authorization；
//     未命中 → 403；预检 OPTIONS → 204 且不要求认证；非白名单预检 → 403；永不 `*`、无 credentials 头；
// ④ 旧开关兼容：AUTOTEST_ALLOW_CROSS_ORIGIN=1 → 跨源放行（闸门关闭语义不变）；
//  ⑤ WS 来源闸门：无 Origin → 101；同源 → 101；白名单 → 101；跨源未列白名单 → 403；
//  ⑥ 构建产物（dist/web 存在时）：config.js 存在且被 index.html 前置引用、不预压缩；
//     静态服务 config.js/index.html no-cache、assets/ immutable、SPA 回退。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dshRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(dshRoot, '..');

// ⚠️ 临时数据目录：绝不碰用户真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-split-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;
delete process.env.AUTOTEST_CORS_ORIGINS;
delete process.env.AUTOTEST_PUBLIC_API_BASE;
delete process.env.AUTOTEST_PUBLIC_WS_BASE;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const asUrl = (p) => pathToFileURL(p).href;

const { makeApiHandler } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'http.js')));
const { handleWsUpgrade } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'ws.js')));

// ---------- 进程内 http + ws 服务（挂载方式与 standalone.ts 一致） ----------
const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
const handler = makeApiHandler(stubLlm);
const server = http.createServer((req, res) => { void handler(req, res); });
server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api/autotest/ws') { void handleWsUpgrade(req, socket, head); return; }
  socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`— 自检服务：http://127.0.0.1:${port}（ws: /api/autotest/ws）—`);

/** 裸 http 请求（完全控制请求头；fetch/undici 会留 keep-alive socket，process.exit 时在 Windows 上触发 libuv 断言崩溃）。 */
function req(method, pathname, headers = {}, overridePort) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: overridePort ?? port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** 裸 WS 握手（只关心握手状态行；可注入 Origin/token）。 */
async function wsHandshake(headers = {}) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    `GET /api/autotest/ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n',
  );
  const header = await new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (c) => {
      chunks.push(c);
      const joined = Buffer.concat(chunks);
      if (joined.indexOf('\r\n\r\n') >= 0) { socket.off('data', onData); resolve(joined); }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('握手超时')), 5000);
  });
  const status = header.toString('utf8').split('\r\n')[0];
  socket.destroy();
  return status;
}

const ORIGIN_OK = 'https://ui.example.com';

async function main() {
  // ① runtime-config（authOpen：匿名可读；env 在请求期解析，可动态切换）
  {
    process.env.AUTOTEST_PUBLIC_API_BASE = 'https://api.example.com/api/autotest';
    process.env.AUTOTEST_PUBLIC_WS_BASE = 'wss://api.example.com';
    const r = await req('GET', '/api/autotest/runtime-config');
    let cfg = null;
    try { cfg = JSON.parse(r.body); } catch { /* 下方断言兜底 */ }
    check(r.status === 200, 'runtime-config：authOpen 匿名可读（200）', `status=${r.status}`);
    check(cfg?.edition === 'standalone', 'runtime-config：edition=standalone');
    check(cfg?.apiBase === 'https://api.example.com/api/autotest', 'runtime-config：透传 AUTOTEST_PUBLIC_API_BASE', String(cfg?.apiBase));
    check(cfg?.wsBase === 'wss://api.example.com', 'runtime-config：透传 AUTOTEST_PUBLIC_WS_BASE', String(cfg?.wsBase));
    check(cfg?.features?.baseline === true && cfg?.features?.scenarioAssets === true, 'runtime-config：features 开关齐备');

    delete process.env.AUTOTEST_PUBLIC_API_BASE;
    delete process.env.AUTOTEST_PUBLIC_WS_BASE;
    const r2 = await req('GET', '/api/autotest/runtime-config');
    const cfg2 = JSON.parse(r2.body);
    check(cfg2.apiBase === '' && cfg2.wsBase === '', 'runtime-config：缺省空串（= 同源默认）', `apiBase="${cfg2.apiBase}"`);
  }

  // ② 同源基线（无白名单：仅同源，保持现状）
  {
    const r1 = await req('GET', '/api/autotest/health');
    check(r1.status === 200, '同源基线：无 Origin（服务端/CLI）→ 200');
    const r2 = await req('GET', '/api/autotest/health', { Origin: `http://127.0.0.1:${port}` });
    check(r2.status === 200 && !r2.headers['access-control-allow-origin'],
      '同源基线：Origin == Host → 200 且无 CORS 头');
    const r3 = await req('GET', '/api/autotest/health', { Origin: 'https://evil.example.com' });
    check(r3.status === 403, '同源基线：跨源 Origin 未列白名单 → 403', `status=${r3.status}`);
    const r4 = await req('GET', '/api/autotest/health', { 'Sec-Fetch-Site': 'cross-site' });
    check(r4.status === 403, '同源基线：Sec-Fetch-Site: cross-site → 403', `status=${r4.status}`);
  }

  // ③ CORS 白名单
  {
    process.env.AUTOTEST_CORS_ORIGINS = `${ORIGIN_OK},http://ui2.example.com`;
    const r1 = await req('GET', '/api/autotest/health', { Origin: ORIGIN_OK });
    check(r1.status === 200, '白名单：命中 Origin → 200', `status=${r1.status}`);
    check(r1.headers['access-control-allow-origin'] === ORIGIN_OK, '白名单：ACAO 精确回显 Origin', String(r1.headers['access-control-allow-origin']));
    check(String(r1.headers.vary ?? '').includes('Origin'), '白名单：Vary: Origin');
    check(String(r1.headers['access-control-allow-headers'] ?? '').includes('Authorization'), '白名单：允许 Authorization 头');
    check(r1.headers['access-control-allow-origin'] !== '*', '安全：永不回显 Access-Control-Allow-Origin: *');
    check(r1.headers['access-control-allow-credentials'] === undefined, '安全：无 credentials 头（令牌走 Authorization，不依赖 Cookie）');

    const r2 = await req('GET', '/api/autotest/health', { Origin: 'HTTPS://UI.EXAMPLE.COM' });
    check(r2.status === 200, '白名单：大小写/尾部斜杠归一化匹配', `status=${r2.status}`);

    const r3 = await req('GET', '/api/autotest/health', { Origin: 'https://ui.example.com.evil.com' });
    check(r3.status === 403 && !r3.headers['access-control-allow-origin'],
      '白名单：后缀仿冒 Origin → 403 且无 ACAO', `status=${r3.status}`);

    // 预检：不要求认证（预检不带 Authorization），命中白名单 → 204 + CORS 头
    const p1 = await req('OPTIONS', '/api/autotest/libraries', {
      Origin: ORIGIN_OK,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization, content-type',
    });
    check(p1.status === 204, '预检：白名单 Origin OPTIONS → 204（不要求认证）', `status=${p1.status}`);
    check(p1.headers['access-control-allow-origin'] === ORIGIN_OK, '预检：带 CORS 头');
    check(String(p1.headers['access-control-allow-methods'] ?? '').includes('GET'), '预检：Allow-Methods 含 GET');
    check(String(p1.headers['access-control-allow-headers'] ?? '').includes('Authorization'), '预检：Allow-Headers 含 Authorization');

    const p2 = await req('OPTIONS', '/api/autotest/libraries', {
      Origin: 'https://evil.example.com',
      'Access-Control-Request-Method': 'GET',
    });
    check(p2.status === 403, '预检：非白名单 Origin OPTIONS → 403', `status=${p2.status}`);
  }

  // ④ 旧开关兼容（AUTOTEST_ALLOW_CROSS_ORIGIN=1 = 完全放开，既有部署语义不变）
  {
    delete process.env.AUTOTEST_CORS_ORIGINS;
    process.env.AUTOTEST_ALLOW_CROSS_ORIGIN = '1';
    const r = await req('GET', '/api/autotest/health', { Origin: 'https://legacy.example.com' });
    check(r.status === 200, '旧开关：AUTOTEST_ALLOW_CROSS_ORIGIN=1 → 跨源放行（向后兼容）', `status=${r.status}`);
    delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;
  }

  // ⑤ WS 来源闸门
  {
    const s1 = await wsHandshake();
    check(s1.includes('101'), 'WS：无 Origin（CLI/服务端）→ 101', s1);
    const s2 = await wsHandshake({ Origin: `http://127.0.0.1:${port}` });
    check(s2.includes('101'), 'WS：同源 Origin → 101', s2);
    const s3 = await wsHandshake({ Origin: 'https://evil.example.com' });
    check(s3.includes('403'), 'WS：跨源未列白名单 → 403 拒绝握手', s3);

    process.env.AUTOTEST_CORS_ORIGINS = ORIGIN_OK;
    const s4 = await wsHandshake({ Origin: ORIGIN_OK });
    check(s4.includes('101'), 'WS：白名单 Origin → 101', s4);
    const s5 = await wsHandshake({ Origin: 'https://evil.example.com' });
    check(s5.includes('403'), 'WS：白名单存在时未命中 → 仍 403', s5);
    delete process.env.AUTOTEST_CORS_ORIGINS;

    process.env.AUTOTEST_ALLOW_CROSS_ORIGIN = '1';
    const s6 = await wsHandshake({ Origin: 'https://legacy.example.com' });
    check(s6.includes('101'), 'WS：旧开关 → 放行（向后兼容）', s6);
    delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;
  }

  // ⑥ 构建产物（dist/web 由 build:standalone 产出；未构建时跳过本组并提示）
  const distWeb = path.join(dshRoot, 'dist', 'web');
  if (fs.existsSync(path.join(distWeb, 'index.html'))) {
    const cfg = fs.readFileSync(path.join(distWeb, 'config.js'), 'utf8');
    check(cfg.includes('window.__AUTOTEST_CONFIG__') && cfg.includes("apiBase: '/api/autotest'"),
      '产物：dist/web/config.js 存在且含默认 apiBase');
    check(!fs.existsSync(path.join(distWeb, 'config.js.gz')),
      '产物：config.js 未预压缩（否则部署期改动永不生效）');
    const html = fs.readFileSync(path.join(distWeb, 'index.html'), 'utf8');
    const cfgIdx = html.indexOf('/config.js');
    const bundleIdx = html.indexOf('type="module"');
    check(cfgIdx >= 0, '产物：index.html 引用 config.js');
    check(cfgIdx >= 0 && bundleIdx >= 0 && cfgIdx < bundleIdx, '产物：config.js 在 bundle 之前加载');

    // 静态服务语义（与 standalone.ts 同参数）：no-cache / immutable / SPA 回退
    const { makeStaticHandler } = await import(asUrl(path.join(dshRoot, 'lib', 'static.js')));
    const staticServer = http.createServer(makeStaticHandler(distWeb, { spa: true, gzip: true, immutable: true }));
    await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
    const sport = staticServer.address().port;
    const get = async (p) => req('GET', p, {}, sport);
    const c1 = await get('/config.js');
    check(c1.status === 200 && String(c1.headers['content-type'] ?? '').includes('javascript'),
      '静态：/config.js 200 且 MIME 正确');
    check(String(c1.headers['cache-control'] ?? '') === 'no-cache', '静态：config.js no-cache（部署期可编辑）');
    const c2 = await get('/');
    check(c2.status === 200 && String(c2.headers['cache-control'] ?? '') === 'no-cache',
      '静态：index.html no-cache（引用 hashed 资产，须每次校验）');
    const c3 = await get('/some/spa/route');
    check(c3.status === 200 && String(c3.headers['content-type'] ?? '').includes('text/html'),
      '静态：SPA 回退（未知路径 → index.html）');
    const assetsDir = path.join(distWeb, 'assets');
    if (fs.existsSync(assetsDir)) {
      const one = fs.readdirSync(assetsDir).find((f) => f.endsWith('.js'));
      if (one) {
        const c4 = await get(`/assets/${one}`);
        check(String(c4.headers['cache-control'] ?? '').includes('immutable'),
          '静态：/assets/* 长缓存 immutable');
      }
    }
    staticServer.close();
  } else {
    console.log('NOTE  dist/web 未构建（npm run build:standalone），跳过构建产物断言组');
  }

  console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify:split-deploy] 执行失败：', e);
  process.exit(2);
});
