// 定时调度器：注册 scheduled 计划，cron 到点触发 executePlan
import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { executePlan } from './planExecutor.js';

const jobs = new Map<number, cron.ScheduledTask>();

export function startScheduler(): void {
  const db = getDb();
  const plans = db.prepare(`SELECT id, name, cron FROM plans WHERE type = 'scheduled' AND status != 'stopped' AND cron IS NOT NULL`).all() as
    Array<{ id: number; name: string; cron: string }>;
  for (const p of plans) {
    try {
      if (!cron.validate(p.cron)) { console.warn(`[autotest] 忽略非法 cron「${p.cron}」：计划 #${p.id}`); continue; }
      const job = cron.schedule(p.cron, () => { executePlan(p.id).catch((e) => console.error(`[autotest] 计划 #${p.id} 执行失败：`, e)); });
      jobs.set(p.id, job);
      console.log(`[autotest] 已注册定时计划 #${p.id} ${p.name} @ ${p.cron}`);
    } catch (e) { console.warn(`[autotest] 注册失败 #${p.id}：`, (e as Error).message); }
  }
}

export function registerScheduledPlan(planId: number, cronExpr: string): void {
  const existing = jobs.get(planId);
  if (existing) { existing.stop(); jobs.delete(planId); }
  if (!cron.validate(cronExpr)) throw new Error(`非法 cron 表达式：${cronExpr}`);
  const job = cron.schedule(cronExpr, () => { executePlan(planId).catch((e) => console.error(`[autotest] 计划 #${planId} 执行失败：`, e)); });
  jobs.set(planId, job);
  console.log(`[autotest] 已注册定时计划 #${planId} @ ${cronExpr}`);
}
