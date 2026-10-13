import { enforceAuth } from '../services/auth.js';
import { bus } from '../services/eventBus.js';
import { closeFrame, computeAccept, parseFrame, pingFrame, pongFrame, textFrame } from './wsFrame.js';
const conns = new Set();
const KEEPALIVE_MS = 30_000;
let keepalive = null;
function send(conn, obj) {
    if (conn.socket.destroyed || conn.socket.writableEnded)
        return;
    try {
        conn.socket.write(textFrame(JSON.stringify(obj)));
    }
    catch {
        /* 写失败由 close/error 事件清理 */
    }
}
function isValidChannel(ch) {
    return ch === 'global' || /^task:\d+$/.test(ch);
}
function subscribe(conn, channel) {
    if (conn.channels.has(channel))
        return;
    conn.channels.add(channel);
    const handler = (p) => {
        // 去重：同一事件可能同时命中 task:<id> 与 global 两个频道——按 (taskId, seq) 只投一次。
        // seq 按任务单调递增，记录已投递最大值即可；容量上限防长连接内存膨胀。
        const last = conn.delivered.get(p.taskId) ?? 0;
        if (p.seq <= last)
            return;
        if (conn.delivered.size > 4096)
            conn.delivered.clear();
        conn.delivered.set(p.taskId, p.seq);
        // 线上协议：type 是消息判别字段（task_event），事件自身类型放 eventType——
        // 直接展开 payload 会把 type 覆盖成 'trace'（TS2783 同款隐患）。
        send(conn, { type: 'task_event', taskId: p.taskId, seq: p.seq, eventType: p.type, title: p.title, detail: p.detail, at: p.at });
    };
    bus.on(channel, handler);
    conn.handlers.set(channel, handler);
}
function unsubscribe(conn, channel) {
    const handler = conn.handlers.get(channel);
    if (handler)
        bus.off(channel, handler);
    conn.handlers.delete(channel);
    conn.channels.delete(channel);
}
function cleanup(conn) {
    for (const channel of [...conn.channels])
        unsubscribe(conn, channel);
    conns.delete(conn);
}
function handleMessage(conn, text) {
    let msg;
    try {
        msg = JSON.parse(text);
    }
    catch {
        send(conn, { type: 'error', message: '不是合法 JSON 文本帧' });
        return;
    }
    const action = String(msg.action ?? '');
    if (action === 'ping') {
        send(conn, { type: 'pong' });
        return;
    }
    if (action === 'subscribe' || action === 'unsubscribe') {
        const channel = String(msg.channel ?? '');
        if (!isValidChannel(channel)) {
            send(conn, { type: 'error', message: `非法频道：${channel || '(空)'}（合法：global 或 task:<id>）` });
            return;
        }
        if (action === 'subscribe') {
            subscribe(conn, channel);
            send(conn, { type: 'subscribed', channel });
        }
        else {
            unsubscribe(conn, channel);
            send(conn, { type: 'unsubscribed', channel });
        }
        return;
    }
    send(conn, { type: 'error', message: `未知 action：${action || '(空)'}（合法：subscribe/unsubscribe/ping）` });
}
/** 处理一个连接的数据流：解帧 → 分片累积 → 消息分发。 */
function attachDataLoop(conn, head) {
    let buf = head;
    const fragment = [];
    const onData = (chunk) => {
        conn.alive = true;
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
            let parsed;
            try {
                parsed = parseFrame(buf);
            }
            catch (e) {
                // 协议错误（如未 mask）：1002 关闭
                try {
                    conn.socket.write(closeFrame(1002, e.message));
                }
                catch { /* ignore */ }
                conn.socket.end();
                return;
            }
            if (!parsed)
                break; // 字节不足，等下一个 chunk
            buf = buf.subarray(parsed.bytesConsumed);
            const { opcode, payload } = parsed.frame;
            if (opcode === 8) { // close：回 close 并结束
                try {
                    conn.socket.write(closeFrame(1000));
                }
                catch { /* ignore */ }
                conn.socket.end();
                return;
            }
            if (opcode === 9) { // ping → pong
                conn.socket.write(pongFrame(payload));
                continue;
            }
            if (opcode === 10)
                continue; // pong：alive 已在入口置位
            if (opcode === 1)
                fragment.length = 0; // 新文本帧（起点）
            if (opcode === 0 || opcode === 1) {
                fragment.push(payload);
                if (!parsed.fin)
                    continue; // 分片未完
                handleMessage(conn, Buffer.concat(fragment).toString('utf8'));
                fragment.length = 0;
                continue;
            }
            // 未知 opcode：忽略（宽容）
        }
    };
    conn.socket.on('data', onData);
    conn.socket.on('close', () => cleanup(conn));
    conn.socket.on('error', () => cleanup(conn));
}
function startKeepalive() {
    if (keepalive)
        return;
    keepalive = setInterval(() => {
        for (const conn of [...conns]) {
            if (!conn.alive) {
                // 上一周期 ping 后无任何响应：判定死连接，清理
                try {
                    conn.socket.write(closeFrame(1001, 'ping timeout'));
                }
                catch { /* ignore */ }
                conn.socket.destroy();
                cleanup(conn);
                continue;
            }
            conn.alive = false;
            try {
                conn.socket.write(pingFrame());
            }
            catch { /* ignore */ }
        }
    }, KEEPALIVE_MS);
    keepalive.unref();
}
/**
 * 处理 WS 升级（http server 的 'upgrade' 事件）。
 * path 判定（/api/autotest/ws）由调用方完成；本函数负责鉴权 → 握手 → 连接生命周期。
 */
export async function handleWsUpgrade(req, socket, head) {
    // query token 合成 Authorization 头，复用 enforceAuth 全量语义（角色/豁免/失效）
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const qToken = url.searchParams.get('token');
        if (qToken && !req.headers.authorization) {
            req.headers.authorization = `Bearer ${qToken}`;
        }
        await enforceAuth(req, 'viewer');
    }
    catch (e) {
        const status = e.statusCode ?? 401;
        const reason = status === 403 ? 'Forbidden' : 'Unauthorized';
        try {
            socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(JSON.stringify({ message: e.message }))}\r\n\r\n${JSON.stringify({ message: e.message })}`);
        }
        catch { /* ignore */ }
        return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key) {
        try {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
        catch { /* ignore */ }
        return;
    }
    try {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`);
    }
    catch {
        return;
    }
    const conn = { socket, channels: new Set(), handlers: new Map(), delivered: new Map(), alive: true };
    conns.add(conn);
    subscribe(conn, 'global'); // 默认订阅全局频道
    attachDataLoop(conn, head ?? Buffer.alloc(0));
    startKeepalive();
}
/** 关闭全部 WS 连接并停止 keepalive（进程优雅退出时调用）。 */
export function stopAllWs() {
    if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
    }
    for (const conn of [...conns]) {
        try {
            conn.socket.write(closeFrame(1001, 'server shutting down'));
        }
        catch { /* ignore */ }
        try {
            conn.socket.end();
        }
        catch { /* ignore */ }
        cleanup(conn);
    }
}
/** 当前 WS 连接数（自检/诊断用）。 */
export function wsConnectionCount() {
    return conns.size;
}
