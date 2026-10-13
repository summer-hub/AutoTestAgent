// WS 通道自检（verify:ws，B4-3）——进程内起 http+ws 服务 + 自实现最小 WS 客户端：
//  ① 握手：101 协商成功；ping → pong；未知 action → error 帧；非法频道 → error 帧；
//  ② 订阅推送：subscribe task:<id> → subscribed → appendTrace → task_event 帧（字段完整）；
//     global 频道（默认订阅）收其他任务事件；退订确认；
//  ③ 鉴权：auth 开启 + 关回环豁免 → 无 token 升级被 401 拒绝；admin token → 可用；
//  ④ 协议卫生：未 mask 帧 → 服务端 1002 关闭连接；
//  ⑤ 连接计数与关闭握手。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dshRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ⚠️ 临时数据目录：绝不碰用户真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ws-'));
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
const asUrl = (p) => pathToFileURL(p).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { makeApiHandler } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'http.js')));
const { handleWsUpgrade, wsConnectionCount } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'ws.js')));
const { setSetting } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'settings.js')));
const { createApiKey, revokeApiKey } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'auth.js')));
const { appendTrace } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'taskEvents.js')));
const { getDb, ensureReady } = await import(asUrl(path.join(dshRoot, 'lib', 'db', 'connection.js')));

await ensureReady();

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

// 造两个任务行（appendTrace 的快照 UPDATE 需要它们存在）
const db = getDb();
const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
for (const no of ['WS-T1', 'WS-T2']) {
  await db.prepare(`INSERT INTO tasks (task_no, type, title, status, input, trace, created_at, updated_at) VALUES (?, 'pull_repo', ?, 'running', '', '[]', ?, ?)`).run(no, `WS 自检任务 ${no}`, t, t);
}
const task1 = (await db.prepare(`SELECT id FROM tasks WHERE task_no = 'WS-T1'`).get()).id;
const task2 = (await db.prepare(`SELECT id FROM tasks WHERE task_no = 'WS-T2'`).get()).id;

// ---------- 最小 WS 客户端（net 裸 socket + 手工握手 + 帧编解码） ----------

/** 客户端帧编码（RFC6455：客户端必须 mask；测试未 mask 场景时传 mask=false）。 */
function encodeClientFrame(opcode, payload, mask = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = (mask ? 0x80 : 0) | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

class WsTestConn {
  constructor(socket, serverPort) {
    this.socket = socket;
    this.serverPort = serverPort;
    this.buf = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error('连接已关闭'));
    });
    socket.on('error', () => { /* close 紧随其后 */ });
  }

  /** 建立 WS 连接（完成握手）。token 走 query（服务端协议）。非 101 抛错（带状态行）。 */
  static async connect(serverPort, queryToken) {
    const socket = net.connect(serverPort, '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const key = crypto.randomBytes(16).toString('base64');
    const qs = queryToken ? `?token=${encodeURIComponent(queryToken)}` : '';
    socket.write(
      `GET /api/autotest/ws${qs} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${serverPort}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    // 读握手响应头（读到 \r\n\r\n 为止）
    const headerBuf = await new Promise((resolve, reject) => {
      const chunks = [];
      const onData = (c) => {
        chunks.push(c);
        const joined = Buffer.concat(chunks);
        const idx = joined.indexOf('\r\n\r\n');
        if (idx >= 0) {
          socket.off('data', onData);
          resolve(joined);
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('握手超时')), 5000);
    });
    const statusLine = headerBuf.toString('utf8').split('\r\n')[0];
    if (!statusLine.includes('101')) {
      socket.destroy();
      throw new Error(`升级被拒绝：${statusLine}`);
    }
    const conn = new WsTestConn(socket, serverPort);
    // 握手响应后可能已后续帧数据，补交给帧循环
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx >= 0 && idx + 4 < headerBuf.length) {
      conn.onData(headerBuf.subarray(idx + 4));
    }
    return conn;
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        len = Number(this.buf.readBigUInt64BE(offset));
        offset += 8;
      }
      if (masked) offset += 4;
      if (this.buf.length < offset + len) return;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (opcode === 8) { this.closed = true; return; }
      if (opcode === 9) { this.socket.write(encodeClientFrame(10, payload)); continue; } // ping → pong
      if (opcode === 10) continue;
      if (opcode !== 1) continue;
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(msg);
        else this.messages.push(msg);
      } catch { /* 非 JSON 帧忽略 */ }
    }
  }

  sendText(obj) {
    this.socket.write(encodeClientFrame(1, Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  /** 发送原始帧（mask=false 用于构造协议违规场景）。 */
  sendRaw(opcode, payload, mask) {
    this.socket.write(encodeClientFrame(opcode, payload, mask));
  }

  sendClose() {
    this.socket.write(encodeClientFrame(8, Buffer.alloc(0)));
  }

  /** 等下一条消息（带超时）。 */
  waitForMessage(timeoutMs = 3000) {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
      this.waiters.push({
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  destroy() {
    this.socket.destroy();
  }
}

// ---------- 用例 ----------

async function main() {
  // ① 握手 + 协议基础
  {
    const conn = await WsTestConn.connect(port);
    check(true, '握手：101 协商成功');
    conn.sendText({ action: 'ping' });
    const pong = await conn.waitForMessage();
    check(pong.type === 'pong', '协议：ping → pong');
    conn.sendText({ action: 'bogus' });
    const err = await conn.waitForMessage();
    check(err.type === 'error' && typeof err.message === 'string', '协议：未知 action → error 帧', String(err.message).slice(0, 40));
    conn.sendText({ action: 'subscribe', channel: 'evil' });
    const err2 = await conn.waitForMessage();
    check(err2.type === 'error', '协议：非法频道 → error 帧');
    conn.destroy();
  }

  // ② 订阅推送（task:<id> + global + 退订）
  {
    const conn = await WsTestConn.connect(port);
    conn.sendText({ action: 'subscribe', channel: `task:${task1}` });
    const sub = await conn.waitForMessage();
    check(sub.type === 'subscribed' && sub.channel === `task:${task1}`, '订阅：task:<id> → subscribed 确认');

    await appendTrace(task1, 'WS 推送测试', '第一条轨迹');
    const ev = await conn.waitForMessage();
    check(ev.type === 'task_event' && ev.taskId === task1 && typeof ev.seq === 'number',
      '推送：appendTrace → task_event 帧到达', `taskId=${ev.taskId} seq=${ev.seq}`);
    check(ev.eventType === 'trace' && ev.title === 'WS 推送测试', '推送：字段完整（eventType/title）', `eventType=${ev.eventType}`);

    await appendTrace(task2, '全局频道测试', '第二条轨迹');
    const ev2 = await conn.waitForMessage();
    check(ev2.type === 'task_event' && ev2.taskId === task2, '推送：global 频道收到其他任务事件', `taskId=${ev2.taskId}`);

    conn.sendText({ action: 'unsubscribe', channel: `task:${task1}` });
    const unsub = await conn.waitForMessage();
    check(unsub.type === 'unsubscribed', '退订：unsubscribed 确认');
    conn.destroy();
  }

  // ③ 鉴权（auth 开启 + 关回环豁免）
  {
    setSetting('auth.enabled', true);
    setSetting('auth.allowLocalBypass', false);
    let rejected = false;
    try {
      await WsTestConn.connect(port);
    } catch (e) {
      rejected = String((e && e.message) || e).includes('401');
    }
    check(rejected, '鉴权：auth 开启 + 无 token → 升级被 401 拒绝');

    const key = await createApiKey({ name: 'verify-ws', role: 'admin' });
    const conn = await WsTestConn.connect(port, key.key);
    conn.sendText({ action: 'ping' });
    const pong = await conn.waitForMessage();
    check(pong.type === 'pong', '鉴权：有效 admin token → 连接并可用');
    conn.destroy();

    await revokeApiKey(key.id);
    setSetting('auth.enabled', false);
    setSetting('auth.allowLocalBypass', true);
  }

  // ④ 协议卫生：未 mask 帧 → 1002 关闭
  {
    const conn = await WsTestConn.connect(port);
    conn.sendRaw(1, Buffer.from('{"action":"ping"}', 'utf8'), false);
    await sleep(500);
    check(conn.closed, '协议卫生：未 mask 帧 → 服务端 1002 关闭连接');
    conn.destroy();
  }

  // ⑤ 连接计数与关闭握手
  {
    const before = wsConnectionCount();
    const conn = await WsTestConn.connect(port);
    check(wsConnectionCount() === before + 1, '连接计数：连接建立 +1', `${before} → ${wsConnectionCount()}`);
    conn.sendClose();
    await sleep(500);
    check(conn.closed, '关闭握手：客户端 close → 连接结束');
    conn.destroy();
    await sleep(300);
    check(wsConnectionCount() === before, '连接计数：断开后归位');
  }

  console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify:ws] 执行失败：', e);
  process.exit(2);
});
