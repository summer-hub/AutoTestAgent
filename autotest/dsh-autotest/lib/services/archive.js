// 数据归档：把超过 N 个月的执行记录移到 executions_archive（主表保持小，查询不衰减）
import { getDb } from '../db/connection.js';
function monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d.toISOString().replace('T', ' ').slice(0, 19);
}
/**
 * 归档列清单（与 executions 一一对应）。
 * 刻意不写 `SELECT *`：隐式依赖"两表列顺序/列数完全一致"，一旦某张表补列而另一张没补，
 * 归档就会在每天凌晨静默报错（历史事故：executions 补了 trace_id，归档表漏了）。
 * 用显式列名后，列漂移会在 schema 自检（scripts/verify-data-integrity.mjs）里被抓住。
 */
const ARCHIVE_COLUMNS = [
    'id', 'plan_id', 'case_id', 'library_id', 'device_id', 'status',
    'steps', 'trace_id', 'thinking', 'logs', 'started_at', 'finished_at',
];
/** 归档 started_at < cutoff 的执行记录，返回归档条数。 */
export async function archiveOldExecutions(months = 6) {
    const db = getDb();
    const cutoff = monthsAgo(months);
    const cols = ARCHIVE_COLUMNS.join(', ');
    return db.transaction(async () => {
        await db.prepare(`INSERT IGNORE INTO executions_archive (${cols})
       SELECT ${cols} FROM executions WHERE started_at IS NOT NULL AND started_at < ?`).run(cutoff);
        const res = await db.prepare(`DELETE FROM executions WHERE started_at IS NOT NULL AND started_at < ?`).run(cutoff);
        return res.changes;
    });
}
