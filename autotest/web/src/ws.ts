// WebSocket 客户端（B4）：连接管理 + 订阅 + 指数退避重连。
//
// 设计要点：
//   - 断线自动重连（1s → 30s 指数退避 + jitter），页面无感续期；
//   - 订阅频道：task:<id> / global（与服务端协议一致）；
//   - 状态回调：connecting / open / closed，供页面做「WS 优先 + 轮询兜底」切换；
//   - 令牌：复用 api.ts 的 sessionStorage key（Authorization 同源）；WS 握手不支持
//     自定义头，token 走 query 参数（服务端 /api/autotest/ws?token=）。
//   - A3（设计 §13.2）：连接地址三档推导 —— runtime config 的 wsBase 优先 →
//     apiBase 为绝对地址时推导协议+host → 回落当前页面 host；路径恒为 /api/autotest/ws。
import { getApiBase, getApiKey, getRuntimeConfig } from './api';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface TaskEventMessage {
  type: 'task_event';
  taskId: number;
  seq: number;
  eventType: string;
  title: string;
  detail: string;
  at: string;
}

type MessageHandler = (msg: TaskEventMessage) => void;
type StatusHandler = (status: WsStatus) => void;

const WS_PATH = '/api/autotest/ws';
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * 解析 WS 连接地址（A3 · 设计 §13.2）。
 * 优先级：runtime config 的 wsBase（http(s):// 或 ws(s):// 均接受）→
 * apiBase 为绝对 URL 时推导 wss/ws 协议 + host → 当前页面协议+host。
 * 路径固定 WS_PATH；token 走 query（见类注释）。
 */
function resolveWsUrl(token: string): string {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const wsBase = String(getRuntimeConfig().wsBase ?? '').trim();
  if (wsBase) {
    const withWsProto = /^wss?:\/\//i.test(wsBase)
      ? wsBase
      : wsBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    return `${withWsProto.replace(/\/+$/, '')}${WS_PATH}${qs}`;
  }
  const apiBase = getApiBase();
  if (/^https?:\/\//i.test(apiBase)) {
    try {
      const u = new URL(apiBase);
      return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}${WS_PATH}${qs}`;
    } catch { /* 非法配置 → 回落当前页面 host */ }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${WS_PATH}${qs}`;
}

export class TaskWsClient {
  private ws: WebSocket | null = null;
  private channels = new Set<string>();
  private msgHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  /** 建立连接（幂等：已打开则跳过）。 */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.emitStatus('connecting');

    const token = getApiKey();
    const ws = new WebSocket(resolveWsUrl(token));
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = BACKOFF_MIN_MS;
      this.emitStatus('open');
      // 重连后恢复订阅
      for (const ch of this.channels) this.send({ action: 'subscribe', channel: ch });
    };
    ws.onclose = () => {
      this.emitStatus('closed');
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose 紧随其后，重连逻辑统一放 onclose
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      const m = msg as { type?: string };
      if (m?.type === 'task_event') {
        for (const h of this.msgHandlers) h(msg as TaskEventMessage);
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.backoff, BACKOFF_MAX_MS) + Math.random() * 500; // jitter 防惊群
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.connect();
    }, delay);
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private emitStatus(s: WsStatus): void {
    for (const h of this.statusHandlers) h(s);
  }

  /** 订阅频道（连接未就绪时先记录，onopen 后补发）。 */
  subscribe(channel: string): void {
    this.channels.add(channel);
    this.send({ action: 'subscribe', channel });
  }

  unsubscribe(channel: string): void {
    this.channels.delete(channel);
    this.send({ action: 'unsubscribe', channel });
  }

  onMessage(h: MessageHandler): () => void {
    this.msgHandlers.add(h);
    return () => this.msgHandlers.delete(h);
  }

  onStatus(h: StatusHandler): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  /** 主动断开（不再重连）。 */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.channels.clear();
    this.ws?.close();
    this.ws = null;
  }
}

/** 全局单例（页面共享一条连接）。 */
export const taskWs = new TaskWsClient();
