export interface TaskEvent {
    seq: number;
    type: string;
    title: string;
    detail: string;
    at: string;
}
/**
 * 追加一条任务轨迹并刷新 tasks.trace 快照（调用方无需关心事件流）。
 * 快照写不带 status 守卫：取消/终态之后迟到的轨迹（「任务已取消」）也必须能落进快照，
 * 否则 trace 视图看不到取消现场。
 */
export declare function appendTrace(taskId: number, title: string, detail?: string): Promise<number>;
/** 增量读事件（afterSeq 之后，升序）。前端轮询/SSE 都走它，不用每次拉全量。 */
export declare function readTaskEvents(taskId: number, opts?: {
    afterSeq?: number;
    limit?: number;
}): Promise<TaskEvent[]>;
/** 从事件流重建 tasks.trace 快照（不设上限：宁可全量，不要静默截断）。 */
export declare function rebuildTraceSnapshot(taskId: number): Promise<number>;
