// 分表路由层（M7）：cases 按 library_id % shardCount 分片。
// 当前单表（caseTableFor 返回 'cases'）；数据量上来后返回 `cases_${shardOf(libraryId)}`，
// 路由/缓存键/分片统计全部走本层，切换点真实存在。
import { getDb } from './connection.js';
import { getSetting } from '../services/settings.js';

export function shardCount(): number {
  return getSetting('data.shardCount', 16) as number;
}

/** library_id → 分片号（确定性、均匀）。 */
export function shardOf(libraryId: number): number {
  return ((Math.abs(libraryId) % shardCount()) + shardCount()) % shardCount();
}

/** 该库用例所在表名（dev 单表；生产可返回 cases_{shard}）。 */
export function caseTableFor(libraryId: number): string {
  void shardOf(libraryId);
  return 'cases';
}

/** 各分片库数/用例数统计（验证分片均匀性）。 */
export async function shardStats(): Promise<Array<{ shard: number; libraries: number; cases: number }>> {
  const db = getDb();
  const rows = await db.prepare('SELECT library_id, COUNT(*) AS n FROM cases GROUP BY library_id').all<{ library_id: number; n: number }>();
  const per = new Map<number, { libraries: number; cases: number }>();
  for (const r of rows) {
    const s = shardOf(r.library_id);
    const cur = per.get(s) ?? { libraries: 0, cases: 0 };
    cur.libraries += 1;
    cur.cases += r.n;
    per.set(s, cur);
  }
  return Array.from({ length: shardCount() }, (_, s) => per.get(s) ?? { libraries: 0, cases: 0 })
    .map((v, s) => ({ shard: s, ...v }));
}
