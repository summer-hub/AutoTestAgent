// envkit 环境画像编排：一次「环境准备」从建 run 到逐 step 执行的完整生命周期。
//
// 为什么单独一层（而不是把逻辑散在 API 里）：环境准备是长任务（几十分钟），
// 涉及「建 run → 逐 step 执行 → 产物采集 → 失败归类 → 缓存复用 → 取消」，
// 这些都必须可复用：API 要调、批次流水线（R2）要调、agent-tools 要调。
// 收敛成一处，三处消费同一套语义，才不会出现"API 跑的与批次跑的行为不一致"。
//
// 三条关键设计：
//  1. **缓存复用**：fingerprint（工具链 + 步骤 + 参数 + 代码 commit）相同的已通过 run
//     不重跑，直接标 cached_from。这是"二次执行耗时 < 20%"的实现方式。
//  2. **步骤独立**：每 step 一行 env_run_steps，单步失败只记该步，
//     required=0 的步骤失败不中断整链（如可选的签名步骤）。
//  3. **取消贯通**：signal 一路传到 spawn，任务 lane / 批次取消时在途子进程立即被杀。
import { getDb, now, transaction } from '../../db/connection.js';
import { createHash } from 'node:crypto';
import { runScriptStep } from './runner.js';
import { getScript } from './scripts.js';
import { resolveParams } from './contract.js';
import { requireApproval } from '../approvals.js';
/** 生成 run_no（可读 + 唯一）。 */
function runNo() {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
    return `ER-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
/**
 * 计算指纹：工具链 + 步骤序列 + 参数 + 代码 commit。
 * 任一变（换了 SDK、改了参数、代码更新）都应当重跑，所以全都要进哈希。
 */
export function fingerprintOf(profile, steps, commit = '') {
    const payload = JSON.stringify({
        toolchain: profile.toolchain,
        steps: steps.map((s) => ({ id: s.scriptId, params: s.params, required: s.required })),
        commit,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}
/** 取画像的步骤序列（按 seq 升序）。 */
export async function loadProfileSteps(profileId) {
    const rows = await getDb().prepare('SELECT seq, script_id, params_json, required, skip_if FROM env_profile_steps WHERE profile_id = ? ORDER BY seq').all(profileId);
    return rows.map((r) => ({
        seq: Number(r.seq), scriptId: String(r.script_id),
        params: (() => { try {
            return JSON.parse(String(r.params_json ?? '{}'));
        }
        catch {
            return {};
        } })(),
        required: Number(r.required ?? 1) === 1, skipIf: String(r.skip_if ?? ''),
    }));
}
/** 找可复用的 run（指纹相同且已终态：passed 或 failed）。 */
async function findReusableRun(fingerprint) {
    // 为什么 failed 也复用：环境失败（工具链缺失、编译失败、依赖缺失）在代码与
    // 工具链不变的情况下**每次都会同样地失败**。不复用就意味着同一环境反复重跑，
    // 每次都白等几十分钟——这正是"二次执行耗时 < 20%"要防的。
    // 代价：人修好工具链后需要 forceRun 或改指纹（换 commit / 改参数）才会重跑，
    // 这一点在 API 层显式暴露 allowCache=false 供人工触发。
    const row = await getDb().prepare(`SELECT id FROM env_runs WHERE fingerprint = ? AND status IN ('passed','failed') ORDER BY id DESC LIMIT 1`).get(fingerprint);
    return row ? Number(row.id) : null;
}
/**
 * 执行一次环境准备。
 *
 * 流程：建 run（pending）→ 查缓存（命中即 cached 返回）→ 逐 step 执行 →
 *       写 env_run_steps → 汇总 run 终态。
 * 永不抛异常（审批待批除外，那是 409 需要调用方转达给人的）：失败也是结果。
 */
export async function runEnvProfile(opts) {
    const startedAt = Date.now();
    const profile = await getDb().prepare('SELECT * FROM env_profiles WHERE id = ?').get(opts.profileId);
    if (!profile)
        throw Object.assign(new Error('环境画像不存在'), { statusCode: 404 });
    const p = {
        id: Number(profile.id), libraryId: Number(profile.library_id), name: String(profile.name),
        status: String(profile.status), presetKind: String(profile.preset_kind ?? ''),
        toolchain: (() => { try {
            return JSON.parse(String(profile.toolchain_json ?? '{}'));
        }
        catch {
            return {};
        } })(),
        components: (() => { try {
            return JSON.parse(String(profile.components_json ?? '{}'));
        }
        catch {
            return {};
        } })(),
        source: String(profile.source ?? ''), confidence: Number(profile.confidence ?? 50),
    };
    const steps = await loadProfileSteps(p.id);
    const fingerprint = fingerprintOf(p, steps, opts.commit ?? '');
    // 建 run
    const t0 = now();
    const ins = await getDb().prepare(`INSERT INTO env_runs
    (run_no, profile_id, library_id, trigger, status, fingerprint, cached_from, duration_ms, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', ?, NULL, 0, '', ?, ?)`)
        .run(runNo(), p.id, p.libraryId, opts.trigger ?? 'manual', fingerprint, t0, t0);
    const runId = Number(ins.lastInsertRowid);
    // 缓存复用：指纹相同且已通过 → 不重跑
    if (opts.allowCache !== false) {
        const reuse = await findReusableRun(fingerprint);
        if (reuse !== null) {
            await getDb().prepare(`UPDATE env_runs SET status='cached', cached_from=?, duration_ms=?, updated_at=? WHERE id=?`)
                .run(reuse, Date.now() - startedAt, now(), runId);
            return { runId, runNo: '', status: 'cached', cachedFrom: reuse, steps: [], durationMs: Date.now() - startedAt, error: '' };
        }
    }
    const cwd = opts.cwd ?? (await libraryRepoDir(p.libraryId));
    const logRoot = opts.logRoot ?? pathJoin('env-runs', String(runId));
    const outcomes = [];
    let failed = false;
    for (const step of steps) {
        if (opts.signal?.aborted) {
            outcomes.push({ seq: step.seq, scriptId: step.scriptId, status: 'skipped', exitCode: 4, failureKind: 'cancelled', failureWhat: '批次已取消，本步未执行', durationMs: 0, artifacts: [], logPath: '' });
            continue;
        }
        if (failed && step.required) {
            outcomes.push({ seq: step.seq, scriptId: step.scriptId, status: 'skipped', exitCode: 0, failureKind: '', failureWhat: '前置必填步骤已失败，跳过', durationMs: 0, artifacts: [], logPath: '' });
            continue;
        }
        const script = await getScript(step.scriptId);
        if (!script || !script.enabled) {
            outcomes.push({ seq: step.seq, scriptId: step.scriptId, status: 'failed', exitCode: 2, failureKind: 'toolchain_missing', failureWhat: `脚本资产不存在或已禁用：${step.scriptId}`, durationMs: 0, artifacts: [], logPath: '' });
            if (step.required)
                failed = true;
            await recordStep(runId, step.seq, step.scriptId, outcomes[outcomes.length - 1]);
            continue;
        }
        // 审批闸门：approval 级别非 none 的步骤走统一闸门（autoApprove 默认放行）
        if (script.approval !== 'none') {
            try {
                await requireApproval(`env.step`, `${p.libraryId}:${step.scriptId}`, { runId, profileId: p.id, seq: step.seq }, opts.requestedBy ?? '');
            }
            catch (e) {
                const err = e;
                if (err.statusCode === 409) {
                    outcomes.push({ seq: step.seq, scriptId: step.scriptId, status: 'skipped', exitCode: 0, failureKind: '', failureWhat: `等待人工审批（#${err.approvalId}）`, durationMs: 0, artifacts: [], logPath: '' });
                    await recordStep(runId, step.seq, step.scriptId, outcomes[outcomes.length - 1]);
                    continue;
                }
                throw e;
            }
        }
        const resolved = resolveParams(script.contract, step.params);
        if (!resolved.ok) {
            outcomes.push({ seq: step.seq, scriptId: step.scriptId, status: 'failed', exitCode: 1, failureKind: 'unknown', failureWhat: `参数不合法：${resolved.problems.join('；')}`, durationMs: 0, artifacts: [], logPath: '' });
            if (step.required)
                failed = true;
            await recordStep(runId, step.seq, step.scriptId, outcomes[outcomes.length - 1]);
            continue;
        }
        const r = await runScriptStep({
            contract: script.contract, params: resolved.params, cwd,
            signal: opts.signal, logDir: logRoot,
        });
        const outcome = {
            seq: step.seq, scriptId: step.scriptId,
            status: r.ok ? 'passed' : 'failed',
            exitCode: r.exitCode, failureKind: r.failureKind, failureWhat: r.failureWhat,
            durationMs: r.durationMs, artifacts: r.artifacts, logPath: r.logPath,
        };
        outcomes.push(outcome);
        await recordStep(runId, step.seq, step.scriptId, outcome);
        if (!r.ok && step.required)
            failed = true;
    }
    const cancelled = opts.signal?.aborted === true;
    const status = cancelled ? 'cancelled' : (failed ? 'failed' : 'passed');
    const durationMs = Date.now() - startedAt;
    await getDb().prepare(`UPDATE env_runs SET status=?, duration_ms=?, error=?, updated_at=? WHERE id=?`)
        .run(status, durationMs, failed ? (outcomes.find((o) => o.status === 'failed')?.failureWhat ?? '') : '', now(), runId);
    return { runId, runNo: '', status, cachedFrom: null, steps: outcomes, durationMs, error: failed ? (outcomes.find((o) => o.status === 'failed')?.failureWhat ?? '') : '' };
}
async function recordStep(runId, seq, scriptId, o) {
    const t = now();
    await getDb().prepare(`INSERT OR REPLACE INTO env_run_steps
    (run_id, seq, script_id, status, exit_code, failure_kind, artifacts_json, log_path, duration_ms, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, seq, scriptId, o.status, o.exitCode, o.failureKind, JSON.stringify(o.artifacts), o.logPath, o.durationMs, t, t);
}
/** 库的仓库目录（从 gitRepo 推导；拿不到返回空串由调用方决定）。 */
async function libraryRepoDir(libraryId) {
    const row = await getDb().prepare('SELECT name, repo_url, repo_subpath FROM libraries WHERE id = ?').get(libraryId);
    if (!row)
        return '';
    const { repoDirFor } = await import('../gitRepo.js');
    return repoDirFor({ name: String(row.name), repo_url: String(row.repo_url ?? ''), repo_subpath: String(row.repo_subpath ?? '') });
}
/** 避免在文件顶部引 path 只为拼一个相对目录。 */
function pathJoin(...parts) {
    return parts.join('/').replace(/\\/g, '/');
}
/** 事务导入（供自检复用，避免每个用例各写一遍 BEGIN/COMMIT）。 */
export { transaction };
