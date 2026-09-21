// 单任务 token 预算（成本闸门）：一次任务到底烧了多少模型额度。
// 事实来源是 agent_events 表（installLlmTracing 每次 LLM 调用都写 tokens_in/tokens_out），
// 不另存状态 —— 因此重启 / 重试 / 多节点共享同一个 MySQL 时账目天然一致，也不需要清理钩子。
import { getDb } from '../db/connection.js';
import { getSetting } from './settings.js';
/** 汇总某任务已消耗的 token（无埋点行时返回 0）。 */
export async function taskTokenUsage(taskId) {
    const row = await getDb().prepare(`SELECT COALESCE(SUM(tokens_in), 0) AS i, COALESCE(SUM(tokens_out), 0) AS o
       FROM agent_events WHERE task_id = ?`).get(taskId);
    const tokensIn = Number(row?.i ?? 0);
    const tokensOut = Number(row?.o ?? 0);
    return { tokensIn, tokensOut, total: tokensIn + tokensOut };
}
/** 预算上限（0 = 不限制）。 */
export function taskTokenBudget() {
    return Math.max(0, Number(getSetting('agent.maxTokensPerTask', 300000)) || 0);
}
/**
 * 调用前检查：超出预算直接抛错，让任务失败留痕，而不是继续烧额度。
 * 未带 taskId 的调用（分析 / 追问等非任务入口）不设闸门。
 */
export async function ensureTaskTokenBudget(taskId) {
    if (!taskId)
        return;
    const budget = taskTokenBudget();
    if (budget <= 0)
        return;
    const used = await taskTokenUsage(taskId);
    if (used.total >= budget) {
        throw new Error(`任务 token 预算已用尽（已用 ${used.total} / 上限 ${budget}），已中止后续模型调用；可在系统配置调大 agent.maxTokensPerTask`);
    }
}
