// 定时调度器：注册 scheduled 计划，cron 到点触发 executePlan
import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { executePlan } from './planExecutor.js';
import { archiveOldExecutions } from './archive.js';
import { warmStatsCache } from './stats.js';

const jobs = new Map<number, cron.ScheduledTask>();

export async function startScheduler(): Promise<void> {
  const db = getDb();
  const plans = await db.prepare(`SELECT id, name, cron FROM plans WHERE type = 'scheduled' AND status != 'stopped' AND cron IS NOT NULL`).all<{ id: number; name: string; cron: string }>();
  for (const p of plans) {
    try {
      if (!cron.validate(p.cron)) { console.warn(`[autotest] 忽略非法 cron「${p.cron}」：计划 #${p.id}`); continue; }
      const job = cron.schedule(p.cron, () => { executePlan(p.id).catch((e) => console.error(`[autotest] 计划 #${p.id} 执行失败：`, e)); });
      jobs.set(p.id, job);
      console.log(`[autotest] 已注册定时计划 #${p.id} ${p.name} @ ${p.cron}`);
    } catch (e) { console.warn(`[autotest] 注册失败 #${p.id}：`, (e as Error).message); }
  }
  // 每日凌晨 3 点归档 6 个月前的执行记录
  cron.schedule('0 3 * * *', () => {
    archiveOldExecutions(6)
      .then((n) => { if (n > 0) console.log(`[autotest] 已归档 ${n} 条历史执行记录`); })
      .catch((e) => console.error('[autotest] 执行归档失败：', (e as Error).message));
  });
  // 每分钟预热统计缓存（首页覆盖率/分片卡片不实时 COUNT）
  cron.schedule('*/1 * * * *', () => {
    warmStatsCache().catch((e) => console.warn('[autotest] 统计预热失败：', (e as Error).message));
  });
}

export function registerScheduledPlan(planId: number, cronExpr: string): void {
  const existing = jobs.get(planId);
  if (existing) { existing.stop(); jobs.delete(planId); }
  if (!cron.validate(cronExpr)) throw new Error(`非法 cron 表达式：${cronExpr}`);
  const job = cron.schedule(cronExpr, () => { executePlan(planId).catch((e) => console.error(`[autotest] 计划 #${planId} 执行失败：`, e)); });
  jobs.set(planId, job);
  console.log(`[autotest] 已注册定时计划 #${planId} @ ${cronExpr}`);
}
