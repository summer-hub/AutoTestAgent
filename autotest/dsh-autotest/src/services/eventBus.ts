// 进程内事件总线（B4）：task_events 追加 → WS 广播的 Pub/Sub 地基。
//
// 边界（写进文档，避免误读）：**单进程内**。集群模式下每个 worker 各有一份总线，
// WS 客户端连到哪个 worker 就只收该 worker 产生的事件。需要跨 worker 广播时
// 接 Redis adapter（项目已有 ioredis 依赖），当前单机/桌面端形态够用。
import { EventEmitter } from 'node:events';

export interface TaskEventPayload {
  taskId: number;
  seq: number;
  type: string;
  title: string;
  detail: string;
  at: string;
}

export const bus = new EventEmitter();
// WS 连接数不可预知，不设监听器上限（默认 10 个连接后 Node 会告警）
bus.setMaxListeners(0);

/** 广播一条任务事件：task:<id> 频道 + global 频道。 */
export function emitTaskEvent(p: TaskEventPayload): void {
  bus.emit(`task:${p.taskId}`, p);
  bus.emit('global', p);
}
