// 执行引擎：将执行计划解析为用例集 → 真机（hdc）逐步执行 → 生成 executions → 更新计划状态
// 严格模式：仅在真机在线时执行；设备未连接 / hdc 不可用 / 引擎配置为 simulate 时，
// 计划置为 failed 并写入原因，绝不回退模拟执行、不产生虚假执行记录。
// 脚本模式（计划级 script_mode，空 = 跟随系统配置 exec.scriptMode）：
//  - script：用例绑定了自动化脚本（workspace/scripts/<lib>/<caseNo>.ts）时解析脚本动作步骤执行
//  - step：始终按用例步骤执行
// 失败策略 fail_policy：continue / abort_library / retry_twice
import { getDb, now } from '../db/connection.js';
import { executeCaseSteps, hdcAvailable, listTargets, type CaseRun } from './hdc.js';
import { getSetting } from './settings.js';
import { parseScriptSteps, readBoundScript } from './scriptRunner.js';

interface PlanRow {
  id: number; plan_no: string; name: string; type: string; cron: string | null;
  scope: string; device_ids: string; status: string; fail_policy: string;
  script_mode: string; error: string;
  last_run_at: string | null; created_at: string; updated_at: string;
}
interface CaseRow {
  id: number; library_id: number; case_no: string; name: string; steps: string; status: string; library_name: string;
}
interface DeviceRow { id: number; serial: string; model: string; }

/** 解析计划 scope → 用例 id 列表（空 = 全量） */
async function resolveCaseIds(db: ReturnType<typeof getDb>, scope: { libraryIds: number[]; caseIds: number[] }): Promise<Array<{ id: number; library_id: number }>> {
  if (scope.caseIds && scope.caseIds.length > 0) {
    const marks = scope.caseIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, library_id FROM cases WHERE id IN (${marks})`).all<{ id: number; library_id: number }>(...scope.caseIds);
  }
  if (scope.libraryIds && scope.libraryIds.length > 0) {
    const marks = scope.libraryIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, library_id FROM cases WHERE library_id IN (${marks})`).all<{ id: number; library_id: number }>(...scope.libraryIds);
  }
  return db.prepare('SELECT id, library_id FROM cases').all<{ id: number; library_id: number }>();
}

function realThinking(caseRow: CaseRow, run: CaseRun): string {
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

export async function executePlan(planId: number): Promise<void> {
  const db = getDb();
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get<PlanRow>(planId);
  if (!plan) return;
  const t = now();
  const failPlan = async (reason: string): Promise<void> => {
    await db.prepare(`UPDATE plans SET status='failed', error=?, updated_at=? WHERE id=?`).run(reason.slice(0, 480), now(), planId);
    console.warn(`[plan #${planId}] ${plan.name} 执行失败：${reason}`);
  };

  await db.prepare(`UPDATE plans SET status='running', error='', updated_at=? WHERE id=?`).run(t, planId);

  // ---- 设备严格校验：未连接直接失败，不执行、不造数据 ----
  const engine = String(getSetting('device.execEngine', 'hdc'));
  if (engine === 'simulate') {
    await failPlan('系统配置 device.execEngine=simulate（模拟模式已停用）。请在「系统配置 → 设备与执行」改为 hdc 并连接真机后重试。');
    return;
  }
  if (!(await hdcAvailable())) {
    await failPlan('真机未连接：未检测到 hdc 命令或服务不可用。请安装 HarmonyOS Device Connector 并连接设备后重试。');
    return;
  }
  const targets = await listTargets();
  if (targets.length === 0) {
    await failPlan('真机未连接：hdc list targets 为空。请在「设备管理」页点击「识别设备」连接真机后重试。');
    return;
  }
  // 设备选择：计划指定 device_ids → 取第一台在线的；未指定 → 第一台在线设备
  let device: DeviceRow | undefined;
  const wantedIds = JSON.parse(plan.device_ids || '[]') as number[];
  for (const id of wantedIds) {
    const d = await db.prepare('SELECT * FROM devices WHERE id = ?').get<DeviceRow>(id);
    if (d && targets.includes(d.serial)) { device = d; break; }
  }
  if (!device) {
    for (const serial of targets) {
      const d = await db.prepare('SELECT * FROM devices WHERE serial = ? AND status = ?').get<DeviceRow>(serial, 'online');
      if (d) { device = d; break; }
    }
  }
  if (!device) {
    await failPlan(`真机未连接：计划内设备均不在线（在线目标：${targets.join(', ')}）。请重新识别设备后重试。`);
    return;
  }

  // ---- 解析范围与抽样 ----
  const scope = JSON.parse(plan.scope || '{"libraryIds":[],"caseIds":[]}') as { libraryIds: number[]; caseIds: number[] };
  const cases = await resolveCaseIds(db, scope);
  if (cases.length === 0) {
    await failPlan('执行范围为空：scope 未命中任何用例，请检查计划的库/用例选择。');
    return;
  }
  const fullSample = getSetting('exec.planSampleFull', 60);
  const batchSample = getSetting('exec.planSampleBatch', 30);
  const singleSample = getSetting('exec.planSampleSingle', 200);
  const sample = plan.type === 'full'
    ? cases.filter((_, i) => i % 750 === 0).slice(0, fullSample)
    : cases.slice(0, plan.type === 'batch' ? batchSample : singleSample);

  const scriptMode = (plan.script_mode || '').trim() || String(getSetting('exec.scriptMode', 'script'));

  const failPolicy = plan.fail_policy || 'continue';
  const retryTimes = failPolicy === 'retry_twice' ? 2 : 0;
  const abortedLibs = new Set<number>();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const insExec = db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, thinking, logs, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const c of sample) {
    const caseRow = await db.prepare(
      `SELECT c.*, l.name AS library_name FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`,
    ).get<CaseRow>(c.id);
    if (!caseRow) continue;

    // failPolicy: abort_library — 该库已有失败用例时跳过后续用例
    if (abortedLibs.has(c.library_id)) {
      await insExec.run(
        planId, c.id, c.library_id, device.id, 'skipped',
        JSON.stringify([{ seq: 1, desc: '整库失败中止，本用例跳过', status: 'skipped', durationMs: 0 }]),
        '按失败策略 abort_library：该库已有失败用例，后续用例跳过。',
        `[${t}] 设备 ${device.serial} · 用例 ${caseRow.case_no} 跳过（整库中止）`, t, now(),
      );
      skipped++;
      continue;
    }

    // 计划级脚本模式：script = 用例绑定脚本时解析动作步骤执行；step = 始终用例步骤
    let stepsArr = JSON.parse(caseRow.steps || '[]') as string[];
    const extraLogs: string[] = [];
    if (scriptMode === 'script') {
      const script = readBoundScript(caseRow.library_name, caseRow.case_no);
      if (script) {
        const parsed = parseScriptSteps(script);
        if (parsed.length > 0) {
          stepsArr = parsed;
          extraLogs.push(`[script] 用例绑定脚本 ${caseRow.case_no}.ts，解析出 ${parsed.length} 个动作步骤执行`);
        } else {
          extraLogs.push(`[script] 绑定脚本存在但未解析出可执行步骤，回退用例步骤`);
        }
      } else {
        extraLogs.push(`[script] 未找到绑定脚本（scripts/${caseRow.library_name}/${caseRow.case_no}.ts），按用例步骤执行`);
      }
    }

    const runOnce = async (): Promise<{ status: 'passed' | 'failed'; stepsJson: string; thinking: string; logs: string }> => {
      const run = await executeCaseSteps(stepsArr, device!.serial);
      const status = run.passed ? 'passed' : 'failed';
      return {
        status,
        stepsJson: JSON.stringify(run.steps.map((s) => ({ seq: s.seq, desc: s.desc, status: s.status, durationMs: s.durationMs }))),
        thinking: realThinking(caseRow, run),
        logs: [...extraLogs, ...run.logs].join('\n'),
      };
    };

    let result = await runOnce();
    for (let attempt = 1; attempt <= retryTimes && result.status === 'failed'; attempt++) {
      extraLogs.push(`[retry] 第 ${attempt}/${retryTimes} 次重试…`);
      result = await runOnce();
    }

    if (result.status === 'failed' && failPolicy === 'abort_library') abortedLibs.add(c.library_id);
    if (result.status === 'failed') failed++; else passed++;
    await insExec.run(planId, c.id, c.library_id, device.id, result.status, result.stepsJson, result.thinking, result.logs, t, now());
  }

  await db.prepare(`UPDATE plans SET status='done', last_run_at=?, updated_at=? WHERE id=?`).run(t, now(), planId);
  console.log(`[plan #${planId}] ${plan.name} 执行完成：${sample.length} 用例，通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（真机 ${device.serial} · 脚本模式 ${scriptMode}）`);
}
