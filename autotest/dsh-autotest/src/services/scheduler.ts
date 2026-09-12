// 定时调度器：注册 scheduled 计划，cron 到点触发 executePlan；设备自动检测常驻；周期 reaper
//
// 生命周期：所有 cron/interval 句柄都集中在这里，插件卸载或重载时由 stopAllSchedulers() 统一释放。
// 历史上没有任何注销路径，导致（1）删除计划后 cron 永久空转报错，（2）插件重载后定时任务叠加。
import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { executePlan } from './planExecutor.js';
import { archiveOldExecutions } from './archive.js';
import { warmStatsCache } from './stats.js';
import { getSetting } from './settings.js';
import { startDeviceAutoScan } from './deviceScanner.js';
import { reconcileRepos } from './gitRepo.js';
import { reapStaleRuns } from './reaper.js';

const jobs = new Map<number, cron.ScheduledTask>();
const backgroundJobs: cron.ScheduledTask[] = [];
const disposers: Array<() => void> = [];

/** 注销单个计划的定时任务（删除计划 / 计划改为非定时时调用）。 */
export function unregisterScheduledPlan(planId: number): void {
  const existing = jobs.get(planId);
  if (!existing) return;
  existing.stop();
  jobs.delete(planId);
  console.log(`[autotest] 已注销定时计划 #${planId}`);
}

/** 停止全部定时任务与常驻轮询（插件卸载时调用，避免重载后任务叠加）。 */
export function stopAllSchedulers(): void {
  for (const planId of [...jobs.keys()]) unregisterScheduledPlan(planId);
  for (const job of backgroundJobs.splice(0)) job.stop();
  for (const dispose of disposers.splice(0)) {
    try { dispose(); } catch { /* 忽略 */ }
  }
}

export async function startScheduler(): Promise<void> {
  // 幂等：重复调用（插件重载）先清空旧任务，否则会叠加出多份定时计划
  stopAllSchedulers();
  // 设备自动检测：与计划调度无关，任何节点都维护本地 devices 表在线状态
  disposers.push(startDeviceAutoScan());
  if (!getSetting('exec.schedulerEnabled', true)) {
    console.log('[autotest] 调度器已禁用（exec.schedulerEnabled=false，多节点模式仅主节点开启）');
    return;
  }
  const db = getDb();
  const plans = await db.prepare(`SELECT id, name, cron FROM plans WHERE type = 'scheduled' AND status != 'stopped' AND cron IS NOT NULL`).all<{ id: number; name: string; cron: string }>();
  for (const p of plans) {
    try {
      if (!cron.validate(p.cron)) { console.warn(`[autotest] 忽略非法 cron「${p.cron}」：计划 #${p.id}`); continue; }
      const job = cron.schedule(p.cron, () => { executePlan(p.id).catch((e) => console.error(`[autotest] 计划 #${p.id} 执行失败：`, (e as Error).message)); });
      jobs.set(p.id, job);
      console.log(`[autotest] 已注册定时计划 #${p.id} ${p.name} @ ${p.cron}`);
    } catch (e) { console.warn(`[autotest] 注册失败 #${p.id}：`, (e as Error).message); }
  }
  // 每日凌晨 3 点归档 6 个月前的执行记录
  backgroundJobs.push(cron.schedule('0 3 * * *', () => {
    archiveOldExecutions(6)
      .then((n) => { if (n > 0) console.log(`[autotest] 已归档 ${n} 条历史执行记录`); })
      .catch((e) => console.error('[autotest] 执行归档失败：', (e as Error).message));
  }));
  // 每分钟：统计缓存预热 + 仓库目录对账（运行中删除仓库目录 → 库状态实时清空，无需重启）
  backgroundJobs.push(cron.schedule('*/1 * * * *', () => {
    warmStatsCache().catch((e) => console.warn('[autotest] 统计预热失败：', (e as Error).message));
    reconcileRepos()
      .then((n) => { if (n > 0) console.log(`[autotest] 仓库对账：${n} 个库的同步状态已清空（目录已不存在）`); })
      .catch((e) => console.warn('[autotest] 仓库对账失败：', (e as Error).message));
  }));
  // 每 5 分钟：收拾长时间不再推进的 running 任务/计划（进程被强杀留下的僵死状态）
  backgroundJobs.push(cron.schedule('*/5 * * * *', () => {
    reapStaleRuns({ maxIdleMinutes: 30, reason: '执行进程已中断' })
      .then((r) => { if (r.tasks > 0 || r.plans > 0) console.warn(`[autotest] 清理僵死运行态：任务 ${r.tasks} / 计划 ${r.plans}`); })
      .catch((e) => console.warn('[autotest] 僵死运行态清理失败：', (e as Error).message));
  }));
}

export function registerScheduledPlan(planId: number, cronExpr: string): void {
  unregisterScheduledPlan(planId);
  if (!cron.validate(cronExpr)) throw new Error(`非法 cron 表达式：${cronExpr}`);
  const job = cron.schedule(cronExpr, () => { executePlan(planId).catch((e) => console.error(`[autotest] 计划 #${planId} 执行失败：`, (e as Error).message)); });
  jobs.set(planId, job);
  console.log(`[autotest] 已注册定时计划 #${planId} @ ${cronExpr}`);
}
