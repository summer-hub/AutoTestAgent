// B4：PR 派生测试状态（设计 §7.3）。
//
// PR 的测试状态不由 PR 表自己维护，而是**派生**：该 PR 关联的基线
// （baseline_prs → test_baselines）下有哪些运行项 / 执行，按固定规则统计。
// 这样避免"PR 上手动点一个状态"与真实执行不一致。
//
// 规则（§7.3，固定不可协商）：
//   无基线或无执行            → untested
//   有运行中（running/pending）→ testing
//   有失败                    → failed
//   有执行且全部通过          → passed
//   其余（混合/跳过）         → partial
import { getDb } from '../db/connection.js';
/** PR 的执行状态 → 是否算"还在跑"。 */
function isRunning(status) {
    return status === 'running' || status === 'pending';
}
/** 从关联基线派生 PR 测试状态（§7.3）。无基线/无执行如实 untested，不伪造。 */
export async function derivePrTestStatus(prId) {
    const db = getDb();
    const baselines = await db.prepare('SELECT baseline_id FROM baseline_prs WHERE pr_id = ?').all(Number(prId));
    const baselineIds = baselines.map((b) => Number(b.baseline_id));
    const empty = { status: 'untested', baselineCount: 0, runItemCount: 0, executionCount: 0, passedCount: 0, failedCount: 0, lastRunAt: '' };
    if (baselineIds.length === 0)
        return empty;
    const placeholders = baselineIds.map(() => '?').join(', ');
    const runItems = await db.prepare(`SELECT status FROM test_run_items WHERE baseline_id IN (${placeholders})`).all(...baselineIds);
    const execs = await db.prepare(`SELECT status, started_at, finished_at FROM executions WHERE baseline_id IN (${placeholders})`).all(...baselineIds);
    const executionCount = execs.length;
    const failedCount = execs.filter((e) => e.status === 'failed').length;
    const passedCount = execs.filter((e) => e.status === 'passed').length;
    const lastRunAt = execs.reduce((m, e) => {
        const stamp = String(e.finished_at ?? e.started_at ?? '');
        return stamp > m ? stamp : m;
    }, '');
    let status;
    if (executionCount === 0 && runItems.length === 0) {
        status = 'untested';
    }
    else if (runItems.some((r) => isRunning(String(r.status ?? ''))) || execs.some((e) => isRunning(String(e.status ?? '')))) {
        status = 'testing';
    }
    else if (failedCount > 0) {
        status = 'failed';
    }
    else if (executionCount > 0 && passedCount === executionCount) {
        status = 'passed';
    }
    else {
        status = 'partial';
    }
    return { status, baselineCount: baselineIds.length, runItemCount: runItems.length, executionCount, passedCount, failedCount, lastRunAt };
}
