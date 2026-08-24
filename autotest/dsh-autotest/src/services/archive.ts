// 数据归档：把超过 N 个月的执行记录移到 executions_archive（主表保持小，查询不衰减）
import { getDb } from '../db/connection.js';

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** 归档 started_at < cutoff 的执行记录，返回归档条数。 */
export async function archiveOldExecutions(months = 6): Promise<number> {
  const db = getDb();
  const cutoff = monthsAgo(months);
  return db.transaction(async () => {
    await db.prepare(
      `INSERT IGNORE INTO executions_archive SELECT * FROM executions WHERE started_at IS NOT NULL AND started_at < ?`,
    ).run(cutoff);
    const res = await db.prepare(
      `DELETE FROM executions WHERE started_at IS NOT NULL AND started_at < ?`,
    ).run(cutoff);
    return res.changes;
  });
}
