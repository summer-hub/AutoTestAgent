import type { LlmCall } from './llmHarness.js';
/** 入队。同库串行、跨库并行；创建任务与重试都走这里。 */
export declare function enqueueTask(taskId: number, libraryId: number | null, llm: LlmCall): void;
export type CancelResult = 'cancelled' | 'not_found' | 'already_finished';
/**
 * 取消任务：排队中 → 出队并直接标 cancelled；运行中 → abort（执行器捕获后终止，
 * 终态由守卫决定不被覆盖）；两者都不在（重启遗留的 pending）→ 库里还是 pending 就直接标 cancelled。
 */
export declare function cancelTask(taskId: number): Promise<CancelResult>;
/** 插件卸载：abort 全部在跑任务、清空队列（DB 行的终态由执行器捕获 / reaper 收尾）。 */
export declare function stopAllTaskLanes(): void;
/** 队列概况（启动日志/排查用）。 */
export declare function laneStats(): Array<{
    lane: string;
    queued: number;
    running: number | null;
}>;
