// 执行引擎：将执行计划解析为用例集 → 生成 executions（含逐步轨迹 + AI 思考）→ 更新计划状态
// 执行模式由配置 device.execEngine 决定：
//  - hdc（默认）：连接真实设备（hdc/uiautomator）执行；无 hdc 或设备未连接时自动回退模拟
//  - simulate：始终模拟（演示/无设备环境）
// 脚本模式 exec.scriptMode：script（默认，用例绑定脚本时解析脚本动作步骤执行）/ step（始终走用例步骤）
// 失败策略 fail_policy：continue / abort_library / retry_twice
import { getDb, now } from '../db/connection.js';
import { executeCaseSteps, hdcAvailable, listTargets } from './hdc.js';
import { getSetting } from './settings.js';
import { parseScriptSteps, readBoundScript } from './scriptRunner.js';
/** 解析计划 scope → 用例 id 列表（空 = 全量） */
function resolveCaseIds(db, scope) {
    if (scope.caseIds && scope.caseIds.length > 0) {
        const marks = scope.caseIds.map(() => '?').join(',');
        return db.prepare(`SELECT id, library_id FROM cases WHERE id IN (${marks})`).all(...scope.caseIds);
    }
    if (scope.libraryIds && scope.libraryIds.length > 0) {
        const marks = scope.libraryIds.map(() => '?').join(',');
        return db.prepare(`SELECT id, library_id FROM cases WHERE library_id IN (${marks})`).all(...scope.libraryIds);
    }
    return db.prepare('SELECT id, library_id FROM cases').all();
}
const UI_VERBS = ['打开', '点击', '滑动', '长按', '输入', '等待', '验证', '切换', '滚动', '选择'];
const UI_TARGETS = ['主界面', '设置项', '列表项', '弹窗', '输入框', '下拉菜单', '确认按钮', '返回按钮', '详情页', '二级菜单'];
const UI_STATES = ['界面响应', '数据刷新', '状态保持', '渲染完成', '焦点位置', '动画结束', '文案显示', '样式一致'];
/** 为单个用例构造执行轨迹（模拟） */
function buildSteps(caseRow, failed, stepsOverride) {
    const raw = stepsOverride ?? JSON.parse(caseRow.steps || '[]');
    const steps = raw.length >= 3
        ? raw.slice(0, stepsOverride ? 8 : 6)
        : Array.from({ length: 4 + (caseRow.id % 3) }, (_, i) => `${UI_VERBS[i % UI_VERBS.length]}${UI_TARGETS[(caseRow.id + i) % UI_TARGETS.length]}，验证${UI_STATES[(caseRow.id + i) % UI_STATES.length]}`);
    const failAt = 1 + (caseRow.id % 2); // 失败步骤位置（1-2 步）
    return steps.map((desc, i) => {
        const seq = i + 1;
        let status = 'passed';
        if (failed && i === failAt)
            status = 'failed';
        if (failed && i > failAt)
            status = 'skipped';
        return { seq, desc: `${desc}`, status, durationMs: 300 + ((caseRow.id * 7 + i * 131) % 2600) };
    });
}
function buildThinking(caseRow, failed) {
    if (!failed) {
        return `任务：执行用例 ${caseRow.case_no}（${caseRow.name}）。
逐步骤执行完毕，全部通过。
结论：用例执行成功，界面状态与预期一致，无异常日志。`;
    }
    const libHint = `对比代码：近期 PR 变更涉及手势事件优先级 / 数据懒加载 / 并发锁升级`;
    return `任务：执行用例 ${caseRow.case_no}（${caseRow.name}）。
检测到异常：某步骤超时未收到预期事件，开始分析…
${libHint}。
根因（置信度 92%）：三方库回归缺陷（环境或代码变更导致），与脚本无关。
建议：上报问题单跟踪；更新脚本适配参数；相关用例升级版本。`;
}
function realThinking(caseRow, run) {
    const fails = run.steps.filter((s) => s.status === 'failed');
    if (fails.length === 0) {
        return `任务：在真实设备上执行用例 ${caseRow.case_no}（${caseRow.name}）。
全部 ${run.steps.length} 步执行通过（hdc/uiautomator 实测，逐步轨迹见左侧）。
结论：用例执行成功，界面状态与预期一致。`;
    }
    return `任务：在真实设备上执行用例 ${caseRow.case_no}（${caseRow.name}）。
检测到 ${fails.length} 个失败步骤：
${fails.map((f) => `- 步骤 ${f.seq}「${f.desc}」：${f.log}`).join('\n')}
根因：基于真实执行日志定位（控件未找到 / 断言失败 / 命令异常），建议进入归因分析进一步排查。`;
}
export async function executePlan(planId) {
    const db = getDb();
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan)
        return;
    const t = now();
    const t2 = now();
    db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(t, planId);
    const scope = JSON.parse(plan.scope || '{"libraryIds":[],"caseIds":[]}');
    const cases = resolveCaseIds(db, scope);
    const devices = JSON.parse(plan.device_ids || '[]').map((id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id)).filter(Boolean);
    const device = devices[0] ?? { id: null, serial: 'SIM-0000', model: '模拟设备' };
    // 限制单次执行规模（演示）：全量计划抽样 60 条，避免 4.5 万条全跑
    const fullSample = getSetting('exec.planSampleFull', 60);
    const batchSample = getSetting('exec.planSampleBatch', 30);
    const singleSample = getSetting('exec.planSampleSingle', 200);
    const sample = plan.type === 'full'
        ? cases.filter((_, i) => i % 750 === 0).slice(0, fullSample)
        : cases.slice(0, plan.type === 'batch' ? batchSample : singleSample);
    const engine = String(getSetting('device.execEngine', 'hdc'));
    const scriptMode = String(getSetting('exec.scriptMode', 'script'));
    const hdcReady = engine !== 'simulate' && !device.serial.startsWith('SIM-') && (await hdcAvailable());
    const connected = hdcReady ? (await listTargets()).includes(device.serial) : false;
    const useReal = hdcReady && connected;
    if (hdcReady && !connected) {
        console.warn(`[plan #${planId}] hdc 可用但设备 ${device.serial} 未连接，本次回退模拟执行`);
    }
    const failPolicy = plan.fail_policy || 'continue';
    const retryTimes = failPolicy === 'retry_twice' ? 2 : 0;
    const abortedLibs = new Set();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const insExec = db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, thinking, logs, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const runOnce = async (caseRow, stepsArr, extraLogs) => {
        if (useReal) {
            const run = await executeCaseSteps(stepsArr, device.serial);
            const status = run.passed ? 'passed' : 'failed';
            return {
                status,
                stepsJson: JSON.stringify(run.steps.map((s) => ({ seq: s.seq, desc: s.desc, status: s.status, durationMs: s.durationMs }))),
                thinking: realThinking(caseRow, run),
                logs: [...extraLogs, ...run.logs].join('\n'),
            };
        }
        const isFail = caseRow.status === '失败' || (caseRow.id % 17 === 0); // 失败率 ~6%
        const status = isFail ? 'failed' : 'passed';
        return {
            status,
            stepsJson: JSON.stringify(buildSteps(caseRow, isFail, stepsArr)),
            thinking: buildThinking(caseRow, isFail),
            logs: [...extraLogs, `[${t}] 设备 ${device.serial} · 用例 ${caseRow.case_no} ${status === 'passed' ? '通过' : '失败'}`].join('\n'),
        };
    };
    for (const c of sample) {
        const caseRow = db.prepare(`SELECT c.*, l.name AS library_name FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`).get(c.id);
        if (!caseRow)
            continue;
        // failPolicy: abort_library — 该库已有失败用例时跳过后续用例
        if (abortedLibs.has(c.library_id)) {
            insExec.run(planId, c.id, c.library_id, device.id, 'skipped', JSON.stringify([{ seq: 1, desc: '整库失败中止，本用例跳过', status: 'skipped', durationMs: 0 }]), '按失败策略 abort_library：该库已有失败用例，后续用例跳过。', `[${t}] 设备 ${device.serial} · 用例 ${caseRow.case_no} 跳过（整库中止）`, t, now());
            skipped++;
            continue;
        }
        // script 模式：用例绑定脚本时解析脚本动作步骤执行
        let stepsArr = JSON.parse(caseRow.steps || '[]');
        const extraLogs = [];
        if (scriptMode === 'script') {
            const script = readBoundScript(caseRow.library_name, caseRow.case_no);
            if (script) {
                const parsed = parseScriptSteps(script);
                if (parsed.length > 0) {
                    stepsArr = parsed;
                    extraLogs.push(`[script] 用例已绑定脚本，解析出 ${parsed.length} 个动作步骤执行`);
                }
            }
        }
        let result = await runOnce(caseRow, stepsArr, extraLogs);
        for (let attempt = 1; attempt <= retryTimes && result.status === 'failed'; attempt++) {
            extraLogs.push(`[retry] 第 ${attempt}/${retryTimes} 次重试…`);
            result = await runOnce(caseRow, stepsArr, extraLogs);
        }
        if (result.status === 'failed' && failPolicy === 'abort_library')
            abortedLibs.add(c.library_id);
        if (result.status === 'failed')
            failed++;
        else
            passed++;
        insExec.run(planId, c.id, c.library_id, device.id, result.status, result.stepsJson, result.thinking, result.logs, t, now());
    }
    db.prepare(`UPDATE plans SET status='done', last_run_at=?, updated_at=? WHERE id=?`).run(t2, t2, planId);
    console.log(`[plan #${planId}] ${plan.name} 执行完成：${sample.length} 用例，通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（${useReal ? 'hdc 真机' : '模拟'}）`);
}
