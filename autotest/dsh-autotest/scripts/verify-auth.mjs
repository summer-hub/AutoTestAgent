// 认证 + RBAC 自检（verify:auth）：进程内起真实 HTTP 服务挂 makeApiHandler，
// 用真实请求验证 P0-1 全链路。不连 MySQL、不调 LLM（llm 传桩）。
// 用法：npm run build && npm run verify:auth
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-auth-'));
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

const { makeApiHandler } = await import('../lib/api/http.js');
const { createApiKey, listApiKeys, verifyApiKey } = await import('../lib/services/auth.js');
const { setSetting, getSetting } = await import('../lib/services/settings.js');
const { getDb, ensureReady } = await import('../lib/db/connection.js');

const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
const server = http.createServer((req, res) => { void makeApiHandler(stubLlm)(req, res); });
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api/autotest`;
console.log(`— 自检服务：${BASE} —\n`);

/** 低层请求：完全控制 header（Authorization / Origin）。 */
function raw(method, urlPath, { headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: urlPath, agent: agent ?? false,
        headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        res.on('error', () => {});
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('socket', (s) => s.on('error', () => {}));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

// ---------- 阶段 0：认证默认关闭（兼容） ----------
await ensureReady();
check(getSetting('auth.enabled', false) === false, '默认 auth.enabled=false（既有部署/DSH 插件零感知）');
const compat = await raw('GET', '/libraries');
check(compat.status === 200, '认证关闭时无 Key 可正常访问（兼容模式）', `status=${compat.status}`);

// ---------- 阶段 1：开启认证 + 造三类 Key ----------
setSetting('auth.enabled', true);
setSetting('auth.allowLocalBypass', false); // 先关豁免，纯测 Key 路径
const admin = await createApiKey({ name: 'admin-key', role: 'admin' });
const operator = await createApiKey({ name: 'operator-key', role: 'operator' });
const viewer = await createApiKey({ name: 'viewer-key', role: 'viewer' });
check(admin.key.startsWith('at_') && admin.key.length > 40, '创建返回明文 Key（at_ 前缀，仅此一次）', admin.key.slice(0, 10) + '…');

// ---------- 阶段 2：Key 校验矩阵 ----------
const noKey = await raw('GET', '/libraries');
check(noKey.status === 401, '无 Key → 401', `status=${noKey.status}`);
const badKey = await raw('GET', '/libraries', { headers: bearer('at_wrong') });
check(badKey.status === 401, '错误 Key → 401', `status=${badKey.status}`);

const vGet = await raw('GET', '/libraries', { headers: bearer(viewer.key) });
check(vGet.status === 200, 'viewer：GET 放行', `status=${vGet.status}`);
const vPost = await raw('POST', '/prompts', { headers: bearer(viewer.key), body: { name: 'p', content: 'c' } });
check(vPost.status === 403, 'viewer：写操作 → 403', `status=${vPost.status}`);
const vSettings = await raw('PUT', '/settings/app.workspace', { headers: bearer(viewer.key), body: { value: '/tmp/x' } });
check(vSettings.status === 403, 'viewer：改系统配置 → 403', `status=${vSettings.status}`);

const oPost = await raw('POST', '/prompts', { headers: bearer(operator.key), body: { name: 'p', content: 'c' } });
check(oPost.status === 200, 'operator：写操作放行', `status=${oPost.status}`);
const oSettings = await raw('PUT', '/settings/app.workspace', { headers: bearer(operator.key), body: { value: '/tmp/x' } });
check(oSettings.status === 403, 'operator：改系统配置 → 403（敏感组限 admin）', `status=${oSettings.status}`);

const aSettings = await raw('PUT', '/settings/app.workspace', { headers: bearer(admin.key), body: { value: '/tmp/x' } });
check(aSettings.status === 200, 'admin：改系统配置放行', `status=${aSettings.status}`);
const aKeys = await raw('GET', '/auth/keys', { headers: bearer(admin.key) });
check(aKeys.status === 200 && Array.isArray(aKeys.json?.items), 'admin：Key 列表放行', `status=${aKeys.status}`);
const aCreate = await raw('POST', '/auth/keys', { headers: bearer(admin.key), body: { name: 'via-api', role: 'viewer' } });
check(aCreate.status === 200 && aCreate.json?.key?.startsWith('at_'), 'admin：经 API 创建 Key（明文仅一次）', `status=${aCreate.status}`);
const aCreateBadRole = await raw('POST', '/auth/keys', { headers: bearer(admin.key), body: { name: 'bad', role: 'root' } });
check(aCreateBadRole.status === 400, '非法 role → 400', `status=${aCreateBadRole.status}`);
const createdId = Number(aCreate.json?.id ?? 0);
const aDelete = await raw('DELETE', `/auth/keys/${createdId}`, { headers: bearer(admin.key) });
check(aDelete.status === 200, 'admin：吊销 Key 放行', `status=${aDelete.status}`);

// ---------- 阶段 3：免鉴权路由 ----------
const health = await raw('GET', '/health');
check(health.status === 200, '/health 免鉴权（LB 探活）', `status=${health.status}`);
const status = await raw('GET', '/auth/status');
check(status.status === 200 && status.json?.enabled === true, '/auth/status 免鉴权且报告 enabled=true', `status=${status.status}`);
const statusWithKey = await raw('GET', '/auth/status', { headers: bearer(admin.key) });
check(statusWithKey.json?.role === 'admin', '/auth/status 带 Key 时报出角色', `role=${statusWithKey.json?.role}`);

// ---------- 阶段 4：回环豁免 ----------
setSetting('auth.allowLocalBypass', true);
const bypass = await raw('GET', '/libraries');
check(bypass.status === 200, '回环豁免开启：本机无 Key 放行（桌面端/本地开发）', `status=${bypass.status}`);
setSetting('auth.allowLocalBypass', false);
const noBypass = await raw('GET', '/libraries');
check(noBypass.status === 401, '回环豁免关闭：本机无 Key → 401（收紧生效）', `status=${noBypass.status}`);

// ---------- 阶段 5：Key 生命周期 ----------
const lifeKey = await createApiKey({ name: 'life-key', role: 'viewer' });
await getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(lifeKey.id);
const disabledRes = await raw('GET', '/libraries', { headers: bearer(lifeKey.key) });
check(disabledRes.status === 401, '已禁用 Key → 401', `status=${disabledRes.status}`);
const expKey = await createApiKey({ name: 'exp-key', role: 'viewer', expiresInDays: 1 });
await getDb().prepare(`UPDATE api_keys SET expires_at = '2020-01-01 00:00:00' WHERE id = ?`).run(expKey.id);
const expRes = await raw('GET', '/libraries', { headers: bearer(expKey.key) });
check(expRes.status === 401, '已过期 Key → 401', `status=${expRes.status}`);
check(await verifyApiKey(expKey.key) === null, 'verifyApiKey 拒绝过期 Key');

// ---------- 阶段 6：哈希存储（拖库也拿不到可用凭据） ----------
const row = await getDb().prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(admin.id);
const hash = String(row?.key_hash ?? '');
check(/^[0-9a-f]{64}$/.test(hash) && hash !== admin.key, '库内只存 SHA-256 哈希（非明文）', hash.slice(0, 12) + '…');
const listed = await listApiKeys();
check(!JSON.stringify(listed).includes(admin.key), '列表接口不回传明文 Key');

// ---------- 阶段 7：401 拒绝后连接可复用（未读 body 不污染 keep-alive） ----------
setSetting('auth.enabled', true);
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
const rejected = await raw('POST', '/prompts', { body: { name: 'x', content: 'y' }, agent: keepAlive }); // 无 key，带 body
const reused = await raw('GET', '/libraries', { agent: keepAlive }); // 同一连接
check(rejected.status === 401, '带 body 的无 Key POST → 401', `status=${rejected.status}`);
check(reused.status === 401, '同一 keep-alive 连接后续请求仍被 401（连接未被污染）', `status=${reused.status}`);
const reusedOk = await raw('GET', '/libraries', { headers: bearer(admin.key), agent: keepAlive });
check(reusedOk.status === 200, '带 Key 后同一连接恢复正常（socket 未坏）', `status=${reusedOk.status}`);
keepAlive.destroy();

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
server.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
