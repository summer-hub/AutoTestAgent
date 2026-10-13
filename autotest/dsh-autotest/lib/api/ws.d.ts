import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
/**
 * 处理 WS 升级（http server 的 'upgrade' 事件）。
 * path 判定（/api/autotest/ws）由调用方完成；本函数负责鉴权 → 握手 → 连接生命周期。
 */
export declare function handleWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
/** 关闭全部 WS 连接并停止 keepalive（进程优雅退出时调用）。 */
export declare function stopAllWs(): void;
/** 当前 WS 连接数（自检/诊断用）。 */
export declare function wsConnectionCount(): number;
