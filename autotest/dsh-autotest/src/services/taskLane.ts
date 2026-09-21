// 任务 lane 调度器（进程内 FIFO）：
//  - lane 键 = library_id（null → 'global'）：同一三方库的任务串行（git 工作区 / 用例库写入互斥），
//    不同库的任务并行。AI 任务动辄数分钟，无串行时同库两个任务会互相踩工作区与用例表。
//  - 每个在跑任务持有一个 AbortController：取消 = abort + DB 标 cancelled。
//  - 进程内队列不持久化：插件重载/进程重启后队列消失，DB 里遗留的 running 由 reaper 启动清理收尸，
//    遗留的 pending（入队后没轮到执行）同样在启动时标记中断，不会永远排队。
import { getDb, now } from '../db/connection.js';
import { runTask } from './executor.js';
import type { LlmCall } from './llmHarness.js';

interface QueueItem {
  id: number;
  llm: LlmCall;
}

interface Lane {
  queue: QueueItem[];
  running: number | null;
}

const lanes = new Map<string, Lane>();
const controllers = new Map<number, AbortController>();
/** 排队中（尚未开始执行）的任务 id —— 取消时直接出队，不进执行器。 */
const queued = new Set<number>();

function laneKey(libraryId: number | null | undefined): string {
  return libraryId == null ? 'global' : `lib:${libraryId}`;
}

function pump(key: string): void {
  const lane = lanes.get(key);
  if (!lane || lane.running !== null) return;
  const next = lane.queue.shift();
  if (next === undefined) {
    lanes.delete(key);
    return;
  }
  queued.delete(next.id);
  lane.running = next.id;
  const controller = new AbortController();
  controllers.set(next.id, controller);
  void runTask(next.id, next.llm, controller.signal).finally(() => {
    controllers.delete(next.id);
    if (lane.running === next.id) lane.running = null;
    pump(key);
  });
}

/** 入队。同库串行、跨库并行；创建任务与重试都走这里。 */
export function enqueueTask(taskId: number, libraryId: number | null, llm: LlmCall): void {
  const key = laneKey(libraryId);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { queue: [], running: null };
    lanes.set(key, lane);
  }
  lane.queue.push({ id: taskId, llm });
  queued.add(taskId);
  pump(key);
}

export type CancelResult = 'cancelled' | 'not_found' | 'already_finished';

async function markCancelled(taskId: number): Promise<void> {
  // 守卫：终态（done/failed/cancelled）不被迟到的取消覆盖；排队/运行中才允许置位
  await getDb().prepare(
    `UPDATE tasks SET status='cancelled', error='已取消', progress=0, updated_at=? WHERE id=? AND status IN ('pending','running')`,
  ).run(now(), taskId);
}

/**
 * 取消任务：排队中 → 出队并直接标 cancelled；运行中 → abort（执行器捕获后终止，
 * 终态由守卫决定不被覆盖）；两者都不在（重启遗留的 pending）→ 库里还是 pending 就直接标 cancelled。
 */
export async function cancelTask(taskId: number): Promise<CancelResult> {
  if (queued.delete(taskId)) {
    for (const lane of lanes.values()) {
      const i = lane.queue.findIndex((x) => x.id === taskId);
      if (i >= 0) lane.queue.splice(i, 1);
    }
    await markCancelled(taskId);
    return 'cancelled';
  }
  const controller = controllers.get(taskId);
  if (controller) {
    controller.abort();
    await markCancelled(taskId);
    return 'cancelled';
  }
  const row = await getDb().prepare('SELECT status FROM tasks WHERE id = ?').get<{ status: string }>(taskId);
  if (!row) return 'not_found';
  if (row.status === 'pending') {
    await markCancelled(taskId);
    return 'cancelled';
  }
  return 'already_finished';
}

/** 插件卸载：abort 全部在跑任务、清空队列（DB 行的终态由执行器捕获 / reaper 收尾）。 */
export function stopAllTaskLanes(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  for (const lane of lanes.values()) lane.queue.length = 0;
  lanes.clear();
  queued.clear();
}

/** 队列概况（启动日志/排查用）。 */
export function laneStats(): Array<{ lane: string; queued: number; running: number | null }> {
  return [...lanes.entries()].map(([lane, l]) => ({ lane, queued: l.queue.length, running: l.running }));
}
