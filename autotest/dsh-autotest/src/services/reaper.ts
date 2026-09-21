// 运行态清理（reaper）
//
// 问题：tasks / plans 的 'running' 只由执行体自己写成终态。进程被强杀、插件重载、或执行体抛出
// 未被兜住的异常时，这些行会永久停在 running，而前端 Tasks 页每 3 秒、Plans 页每 2 秒轮询 ——
// 用户看到的是"永远转圈"。历史上只能靠手工跑 scripts/clean-stale-tasks.mjs 收拾（该脚本还写错了库文件）。
//
// 这里提供两种清理：
//  - 启动清理（不限空闲时长）：本进程刚起来，任何 running 都必然是上一次生命周期的残留；
//  - 周期清理（按空闲时长）：只收拾 updated_at 早已不再更新的行，避免误杀正在跑的计划
//    （执行体每步都会刷新 updated_at，长时间无更新说明它已经不在推进了）。
import { getDb, now } from '../db/connection.js';

export interface ReapResult {
  tasks: number;
  plans: number;
}

/** 把残留的运行中任务/计划标记为中断，返回清理行数。 */
export async function reapStaleRuns(opts: { maxIdleMinutes?: number; reason?: string } = {}): Promise<ReapResult> {
  const db = getDb();
  const t = now();
  const reason = opts.reason ?? '进程重启中断';
  const note = `${reason}（旧执行残留）`;
  const idle = opts.maxIdleMinutes;
  // updated_at 是固定格式的 ISO 字符串，字典序即时间序，可直接比较
  const cutoff = typeof idle === 'number' && Number.isFinite(idle)
    ? new Date(Date.now() - idle * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  const taskSql = cutoff
    ? `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE status='running' AND updated_at < ?`
    : `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE status='running'`;
  const taskArgs: unknown[] = cutoff ? [note, t, cutoff] : [note, t];
  const taskRes = await db.prepare(taskSql).run(...taskArgs);

  const planSql = cutoff
    ? `UPDATE plans SET status='failed', error=?, progress=100, progress_note=?, updated_at=? WHERE status='running' AND updated_at < ?`
    : `UPDATE plans SET status='failed', error=?, progress=100, progress_note=?, updated_at=? WHERE status='running'`;
  const planNote = `失败：${reason}`;
  const planArgs: unknown[] = cutoff ? [note, planNote, t, cutoff] : [note, planNote, t];
  const planRes = await db.prepare(planSql).run(...planArgs);

  return { tasks: Number(taskRes.changes) || 0, plans: Number(planRes.changes) || 0 };
}

/** 启动清理：清理上一次进程遗留的 running（本进程内不可能有正在跑的任务）。 */
export async function reapOnStartup(): Promise<ReapResult> {
  const r = await reapStaleRuns({ reason: '进程重启中断' });
  // 遗留的 pending：入队后没轮到执行（lane 是进程内队列，重启即消失）。
  // 不标记的话它会永远停在 pending，前端永远转圈，且重试入口都不给（重试仅限 failed/cancelled）
  const orphan = await getDb().prepare(
    `UPDATE tasks SET status='failed', error=?, progress=0, updated_at=? WHERE status='pending'`,
  ).run('进程重启中断（任务在队列中未执行）', now());
  const n = Number(orphan.changes) || 0;
  if (r.tasks > 0 || r.plans > 0 || n > 0) {
    console.log(`[dsh-autotest] 启动清理：${r.tasks} 个任务 / ${r.plans} 个计划标记为中断（上次运行残留），${n} 个未执行任务标记为中断`);
  }
  return r;
}
