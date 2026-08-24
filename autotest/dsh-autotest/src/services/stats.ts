// 统计预聚合：定时刷新到缓存，首页统计卡片不实时 COUNT
import { getDb } from '../db/connection.js';
import { cacheSet } from './cache.js';
import { shardStats } from '../db/repository.js';

export async function computeCaseStats(): Promise<{ total: number; byStatus: Array<Record<string, unknown>>; versioned: number }> {
  const db = getDb();
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM cases').get<{ n: number }>())?.n ?? 0;
  const byStatus = await db.prepare('SELECT status, COUNT(*) AS n FROM cases GROUP BY status').all();
  const versioned = (await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE current_version > 1').get<{ n: number }>())?.n ?? 0;
  return { total, byStatus, versioned };
}

/** 预热统计缓存（写路径 cacheDel 后由下一次定时刷新兜底）。 */
export async function warmStatsCache(): Promise<void> {
  const [stats, shards] = await Promise.all([computeCaseStats(), shardStats()]);
  await cacheSet('stats:cases', stats, 120_000);
  await cacheSet('stats:sharding', shards, 120_000);
}
