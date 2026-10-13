// 最小 RFC6455 帧编解码（零依赖自实现——不为一个实时通道引入 ws 包）。
//
// 服务端视角：
//   - 客户端→服务端帧**必须 mask**（RFC 要求），未 mask 直接抛错（协议错误 1002）；
//   - 服务端→客户端帧**不 mask**；
//   - 支持 opcode：text(1) / continuation(0) / close(8) / ping(9) / pong(10)；
//   - 长度：7 位 / 16 位 / 64 位；分片由调用方按 fin 标志累积。
import { createHash } from 'node:crypto';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 握手 Sec-WebSocket-Accept = base64(sha1(key + GUID))。 */
export function computeAccept(key) {
    return createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}
/** 从缓冲区解析一帧；字节不足返回 null（等更多数据）。协议违规抛错。 */
export function parseFrame(buf) {
    if (buf.length < 2)
        return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    if (!masked)
        throw new Error('客户端帧必须携带 mask（RFC6455）');
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buf.length < offset + 2)
            return null;
        len = buf.readUInt16BE(offset);
        offset += 2;
    }
    else if (len === 127) {
        if (buf.length < offset + 8)
            return null;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error('帧长度超过安全整数范围');
        len = Number(big);
        offset += 8;
    }
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + len)
        return null;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++)
        payload[i] = buf[offset + i] ^ maskKey[i % 4];
    return { frame: { opcode, payload }, fin, bytesConsumed: offset + len };
}
/** 编码一个服务端帧（FIN + opcode，不 mask）。 */
export function buildFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    }
    else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, payload]);
}
export function textFrame(text) {
    return buildFrame(1, Buffer.from(text, 'utf8'));
}
export function closeFrame(code = 1000, reason = '') {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    return buildFrame(8, payload);
}
export function pingFrame(payload = Buffer.alloc(0)) {
    return buildFrame(9, payload);
}
export function pongFrame(payload = Buffer.alloc(0)) {
    return buildFrame(10, payload);
}
