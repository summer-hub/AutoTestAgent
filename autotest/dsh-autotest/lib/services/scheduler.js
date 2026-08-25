// 定时调度器：注册 scheduled 计划，cron 到点触发 executePlan；设备自动检测常驻
import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { executePlan } from './planExecutor.js';
import { archiveOldExecutions } from './archive.js';
import { warmStatsCache } from './stats.js';
import { getSetting } from './settings.js';
import { startDeviceAutoScan } from './deviceScanner.js';
const jobs = new Map();
export async function startScheduler() {
    // 设备自动检测：与计划调度无关，任何节点都维护本地 devices 表在线状态
    startDeviceAutoScan();
    if (!getSetting('exec.schedulerEnabled', true)) {
        console.log('[autotest] 调度器已禁用（exec.schedulerEnabled=false，多节点模式仅主节点开启）');
        return;
    }
    const db = getDb();
    const plans = await db.prepare(`SELECT id, name, cron FROM plans WHERE type = 'scheduled' AND status != 'stopped' AND cron IS NOT NULL`).all();
    for (const p of plans) {
        try {
            if (!cron.validate(p.cron)) {
                console.warn(`[autotest] 忽略非法 cron「${p.cron}」：计划 #${p.id}`);
                continue;
            }
            const job = cron.schedule(p.cron, () => { executePlan(p.id).catch((e) => console.error(`[autotest] 计划 #${p.id} 执行失败：`, e)); });
            jobs.set(p.id, job);
            console.log(`[autotest] 已注册定时计划 #${p.id} ${p.name} @ ${p.cron}`);
        }
        catch (e) {
            console.warn(`[autotest] 注册失败 #${p.id}：`, e.message);
        }
    }
    // 每日凌晨 3 点归档 6 个月前的执行记录
    cron.schedule('0 3 * * *', () => {
        archiveOldExecutions(6)
            .then((n) => { if (n > 0)
            console.log(`[autotest] 已归档 ${n} 条历史执行记录`); })
            .catch((e) => console.error('[autotest] 执行归档失败：', e.message));
    });
    // 每分钟预热统计缓存（首页覆盖率/分片卡片不实时 COUNT）
    cron.schedule('*/1 * * * *', () => {
        warmStatsCache().catch((e) => console.warn('[autotest] 统计预热失败：', e.message));
    });
}
export function registerScheduledPlan(planId, cronExpr) {
    const existing = jobs.get(planId);
    if (existing) {
        existing.stop();
        jobs.delete(planId);
    }
    if (!cron.validate(cronExpr))
        throw new Error(`非法 cron 表达式：${cronExpr}`);
    const job = cron.schedule(cronExpr, () => { executePlan(planId).catch((e) => console.error(`[autotest] 计划 #${planId} 执行失败：`, e)); });
    jobs.set(planId, job);
    console.log(`[autotest] 已注册定时计划 #${planId} @ ${cronExpr}`);
}
