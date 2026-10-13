/** 握手 Sec-WebSocket-Accept = base64(sha1(key + GUID))。 */
export declare function computeAccept(key: string): string;
export interface ParsedFrame {
    frame: {
        opcode: number;
        payload: Buffer;
    };
    /** FIN 标志：false 表示分片待续，调用方应累积 */
    fin: boolean;
    bytesConsumed: number;
}
/** 从缓冲区解析一帧；字节不足返回 null（等更多数据）。协议违规抛错。 */
export declare function parseFrame(buf: Buffer): ParsedFrame | null;
/** 编码一个服务端帧（FIN + opcode，不 mask）。 */
export declare function buildFrame(opcode: number, payload: Buffer): Buffer;
export declare function textFrame(text: string): Buffer;
export declare function closeFrame(code?: number, reason?: string): Buffer;
export declare function pingFrame(payload?: Buffer): Buffer;
export declare function pongFrame(payload?: Buffer): Buffer;
