import { EventEmitter } from 'node:events';
export interface TaskEventPayload {
    taskId: number;
    seq: number;
    type: string;
    title: string;
    detail: string;
    at: string;
}
export declare const bus: EventEmitter<[never]>;
/** 广播一条任务事件：task:<id> 频道 + global 频道。 */
export declare function emitTaskEvent(p: TaskEventPayload): void;
