// 任务轨迹事件流（append-only）：tasks.trace 只是它物化出来的快照。
//
// 为什么换掉读改写：旧 traceTask 是 `SELECT trace → JSON.parse → push → UPDATE`，
// 同一任务被并发推进（重试 + reaper + 任务自身）时互相覆盖丢轨迹。现在：
//   - seq 由 `INSERT..SELECT MAX(seq)+1` 一条语句原子分配，唯一键 (task_id, seq) 兜底；
//   - 同一任务的「追加 + 快照刷新」在进程内整体串行（chain）；
//   - 快照可随时从事件流重建（rebuildTraceSnapshot），trace 列损坏不再是数据事故；
//   - readTaskEvents(afterSeq) 是 #6 SSE 增量推送的地基。
import { getDb, now } from '../db/connection.js';

export interface TaskEvent {
  seq: number;
  type: string;
  title: string;
  detail: string;
  at: string;
}

// 每任务一条追加链：前一个追加（含快照刷新）落定后才开始下一个。
// 双保险——SQL 层 seq 原子分配 + 进程内串行，确保不会出现同一 seq 撞唯一键。
const chains = new Map<number, Promise<unknown>>();

function chain<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(taskId) ?? Promise.resolve();
  // 前一个失败也要继续跑：一条轨迹写失败不该让后续轨迹全部断掉
  const next = prev.then(fn, fn);
  const tracked = next.then(
    () => { if (chains.get(taskId) === tracked) chains.delete(taskId); },
    () => { if (chains.get(taskId) === tracked) chains.delete(taskId); },
  );
  chains.set(taskId, tracked);
  return next;
}

async function insertEvent(taskId: number, type: string, title: string, detail: string): Promise<number> {
  const at = now();
  await getDb().prepare(
    `INSERT INTO task_events (task_id, seq, type, title, detail, created_at)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM task_events WHERE task_id = ?`,
  ).run(taskId, type, title, detail, at, taskId);
  const row = await getDb().prepare(
    'SELECT seq FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1',
  ).get<{ seq: number }>(taskId);
  return row?.seq ?? 0;
}

/**
 * 追加一条任务轨迹并刷新 tasks.trace 快照（调用方无需关心事件流）。
 * 快照写不带 status 守卫：取消/终态之后迟到的轨迹（「任务已取消」）也必须能落进快照，
 * 否则 trace 视图看不到取消现场。
 */
export async function appendTrace(taskId: number, title: string, detail = ''): Promise<number> {
  return chain(taskId, async () => {
    const seq = await insertEvent(taskId, 'trace', title, detail);
    await rebuildTraceSnapshot(taskId);
    return seq;
  });
}

/** 增量读事件（afterSeq 之后，升序）。前端轮询/SSE 都走它，不用每次拉全量。 */
export async function readTaskEvents(taskId: number, opts: { afterSeq?: number; limit?: number } = {}): Promise<TaskEvent[]> {
  const rawAfter = Number(opts.afterSeq);
  const afterSeq = Number.isFinite(rawAfter) && rawAfter > 0 ? Math.trunc(rawAfter) : 0;
  const rawLimit = Number(opts.limit);
  // 上下限都要夹：SQLite 的 `LIMIT -1` 是"无限制"，负数参数会变全表返回
  const limit = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, Math.trunc(rawLimit))) : 500;
  const rows = await getDb().prepare(
    `SELECT seq, type, title, detail, created_at FROM task_events
     WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  ).all<{ seq: number; type: string; title: string; detail: string; created_at: string }>(taskId, afterSeq, limit);
  return rows.map((r) => ({ seq: r.seq, type: r.type, title: r.title, detail: r.detail, at: r.created_at }));
}

/** 从事件流重建 tasks.trace 快照（不设上限：宁可全量，不要静默截断）。 */
export async function rebuildTraceSnapshot(taskId: number): Promise<number> {
  const rows = await getDb().prepare(
    'SELECT seq, title, detail, created_at FROM task_events WHERE task_id = ? ORDER BY seq ASC',
  ).all<{ seq: number; title: string; detail: string; created_at: string }>(taskId);
  const trace = rows.map((r) => ({ seq: r.seq, at: r.created_at, title: r.title, detail: r.detail }));
  await getDb().prepare('UPDATE tasks SET trace = ? WHERE id = ?').run(JSON.stringify(trace), taskId);
  return trace.length;
}
