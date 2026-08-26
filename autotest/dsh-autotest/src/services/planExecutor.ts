// 执行引擎：执行计划直接运行用例绑定的自动化脚本（Python/Hypium + xdevice）
//  - 严格前置：真机在线 + Python 环境可用，否则计划置 failed 并写明原因（绝不模拟）
//  - 未绑定脚本的用例：记 skipped「未绑定自动化脚本」，不执行
//  - 绑定脚本：workspace/hypium/<lib>/testcases/<lib>/<caseNo>.py；
//    单用例执行 = python main.py <module> → 解析 reports/latest/result/<module>.xml 判定结果
//  - 实时进度：plans.progress / progress_note 每步更新，前端轮询展示
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { hdcAvailable, listTargets } from './hdc.js';
import { getSetting } from './settings.js';
import { ensureHypiumProject, hypiumProjectDir, hypiumCaseScriptPath, caseClassName } from './hypiumGen.js';
import { detectPython, runHypiumModule } from './hypiumRunner.js';

interface PlanRow {
  id: number; plan_no: string; name: string; type: string; cron: string | null;
  scope: string; device_ids: string; status: string; fail_policy: string;
  last_run_at: string | null; created_at: string; updated_at: string;
}
interface CaseRow {
  id: number; library_id: number; case_no: string; name: string; steps: string; status: string; library_name: string;
}

function realThinking(caseRow: CaseRow, status: 'passed' | 'failed', failLog: string): string {
  if (status === 'passed') {
    return `任务：在真实设备上通过 xdevice/Hypium 运行绑定脚本 ${caseRow.case_no}.py。
全部断言通过，结果解析自 reports/result XML。
结论：用例执行成功。`;
  }
  return `任务：在真实设备上通过 xdevice/Hypium 运行绑定脚本 ${caseRow.case_no}.py。
执行失败，详情：
${failLog}
根因方向：基于真实执行日志定位（断言失败 / 控件未找到 / 设备或环境异常），建议进入归因分析进一步排查。`;
}

export async function executePlan(planId: number): Promise<void> {
  const db = getDb();
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get<PlanRow>(planId);
  if (!plan) return;
  const t = now();
  const setProgress = async (pct: number, note: string): Promise<void> => {
    await db.prepare(`UPDATE plans SET progress = ?, progress_note = ?, updated_at = ? WHERE id = ?`)
      .run(Math.max(0, Math.min(100, Math.round(pct))), note.slice(0, 280), now(), planId);
  };
  const failPlan = async (reason: string): Promise<void> => {
    await db.prepare(`UPDATE plans SET status='failed', error=?, progress=100, progress_note=?, updated_at=? WHERE id=?`)
      .run(reason.slice(0, 480), `失败：${reason.slice(0, 120)}`, now(), planId);
    console.warn(`[plan #${planId}] ${plan.name} 执行失败：${reason}`);
  };

  await db.prepare(`UPDATE plans SET status='running', error='', progress=2, progress_note='准备中…', updated_at=? WHERE id=?`).run(t, planId);

  // ---- 前置校验 ----
  if (!(await hdcAvailable())) {
    await failPlan('真机未连接：未检测到 hdc 命令或服务不可用。请安装 HarmonyOS Device Connector 并连接设备后重试。');
    return;
  }
  const targets = await listTargets();
  if (targets.length === 0) {
    await failPlan('真机未连接：hdc list targets 为空。请在「设备管理」页确认设备自动上线后重试。');
    return;
  }
  let deviceSerial = '';
  const wantedIds = JSON.parse(plan.device_ids || '[]') as number[];
  for (const id of wantedIds) {
    const d = await db.prepare('SELECT serial FROM devices WHERE id = ?').get<{ serial: string }>(id);
    if (d && targets.includes(d.serial)) { deviceSerial = d.serial; break; }
  }
  if (!deviceSerial) deviceSerial = targets[0];
  const pythonCmd = await detectPython();
  if (!pythonCmd) {
    await failPlan('未检测到 Python 环境（python / python3）。Hypium 脚本执行需要 Python + xdevice，请安装后重试。');
    return;
  }

  // ---- 范围与抽样 ----
  const scope = JSON.parse(plan.scope || '{"libraryIds":[],"caseIds":[]}') as { libraryIds: number[]; caseIds: number[] };
  let sample: Array<{ id: number; library_id: number }> = [];
  if (scope.caseIds?.length > 0) {
    const marks = scope.caseIds.map(() => '?').join(',');
    sample = await db.prepare(`SELECT id, library_id FROM cases WHERE id IN (${marks})`).all(...scope.caseIds);
  } else if (scope.libraryIds?.length > 0) {
    const marks = scope.libraryIds.map(() => '?').join(',');
    sample = await db.prepare(`SELECT id, library_id FROM cases WHERE library_id IN (${marks})`).all(...scope.libraryIds);
  } else {
    sample = await db.prepare('SELECT id, library_id FROM cases').all();
  }
  if (sample.length === 0) {
    await failPlan('执行范围为空：scope 未命中任何用例，请检查计划的库/用例选择。');
    return;
  }
  const fullSample = getSetting('exec.planSampleFull', 60);
  const batchSample = getSetting('exec.planSampleBatch', 30);
  const singleSample = getSetting('exec.planSampleSingle', 200);
  sample = plan.type === 'full'
    ? sample.filter((_, i) => i % 750 === 0).slice(0, fullSample)
    : sample.slice(0, plan.type === 'batch' ? batchSample : singleSample);

  const failPolicy = plan.fail_policy || 'continue';
  const retryTimes = failPolicy === 'retry_twice' ? 2 : 0;

  const insExec = db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, thinking, logs, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  interface Item { row: CaseRow; scriptPath: string | null; moduleStem: string; projDir: string }
  const groups = new Map<string, Item[]>();
  for (const c of sample) {
    const row = await db.prepare(
      `SELECT c.*, l.name AS library_name FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`,
    ).get<CaseRow>(c.id);
    if (!row) continue;
    const libName = row.library_name;
    const scriptPath = hypiumCaseScriptPath(libName, row.case_no);
    const bound = fs.existsSync(scriptPath);
    const item: Item = { row, scriptPath: bound ? scriptPath : null, moduleStem: path.basename(scriptPath, '.py'), projDir: hypiumProjectDir(libName) };
    if (!groups.has(libName)) groups.set(libName, []);
    groups.get(libName)!.push(item);
  }

  const total = [...groups.values()].flat().length;
  const deviceIdRow = await db.prepare('SELECT id FROM devices WHERE serial = ?').get<{ id: number }>(deviceSerial);
  const deviceId = deviceIdRow?.id ?? null;
  let done = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const [libName, items] of groups) {
    const boundItems = items.filter((i) => i.scriptPath !== null);
    for (const item of items.filter((i) => i.scriptPath === null)) {
      done++;
      skipped++;
      await insExec.run(
        planId, item.row.id, item.row.library_id, deviceId, 'skipped',
        JSON.stringify([{ seq: 1, desc: '未绑定自动化脚本，跳过执行', status: 'skipped', durationMs: 0 }]),
        '该用例尚未绑定自动化脚本（Python/Hypium）。请在任务页使用「用例转自动化脚本」生成，或在自动化脚本页手工新建 <用例编号>.py 后重试。',
        `[${t}] 设备 ${deviceSerial} · 用例 ${item.row.case_no} 跳过（未绑定脚本）`, t, now(),
      );
      await setProgress(2 + (done / total) * 95, `${done}/${total} · ${item.row.case_no} 跳过（未绑定脚本）`);
    }
    if (boundItems.length === 0) continue;

    const pkgRow = await db.prepare('SELECT package_name FROM libraries WHERE name = ?').get<{ package_name: string }>(libName);
    ensureHypiumProject({ name: libName, packageName: pkgRow?.package_name || libName }, deviceSerial);

    for (let idx = 0; idx < boundItems.length; idx++) {
      const item = boundItems[idx];
      const cls = caseClassName(item.row.case_no);
      await setProgress(2 + (done / total) * 95, `${done}/${total} · 正在执行 ${item.row.case_no}（${cls}）…`);
      const t0 = Date.now();
      let result = await runHypiumModule(pythonCmd, item.projDir, item.moduleStem, 10 * 60_000);
      let attempts = 1;
      while (result.status === 'failed' && attempts <= retryTimes) {
        result = await runHypiumModule(pythonCmd, item.projDir, item.moduleStem, 10 * 60_000);
        attempts++;
      }
      const durationMs = Date.now() - t0;
      await insExec.run(
        planId, item.row.id, item.row.library_id, deviceId, result.status,
        JSON.stringify([{ seq: 1, desc: `运行 Hypium 脚本 ${item.moduleStem}.py${attempts > 1 ? `（重试 ${attempts - 1} 次）` : ''}`, status: result.status, durationMs }]),
        realThinking(item.row, result.status, result.log),
        [`[${now()}] 设备 ${deviceSerial} · ${item.row.case_no} · python main.py ${item.moduleStem}`, result.log].join('\n'),
        t, now(),
      );
      done++;
      if (result.status === 'passed') passed++; else failed++;
      if (result.status === 'failed' && failPolicy === 'abort_library') {
        for (const rest of boundItems.slice(idx + 1)) {
          done++;
          skipped++;
          await insExec.run(
            planId, rest.row.id, rest.row.library_id, deviceId, 'skipped',
            JSON.stringify([{ seq: 1, desc: '整库失败中止，跳过执行', status: 'skipped', durationMs: 0 }]),
            '按失败策略 abort_library：该库已有失败用例，后续用例跳过。',
            `[${t}] 设备 ${deviceSerial} · 用例 ${rest.row.case_no} 跳过（整库中止）`, t, now(),
          );
        }
        break;
      }
      await setProgress(2 + (done / total) * 95, `${done}/${total} · ${item.row.case_no} ${result.status === 'passed' ? '通过' : '失败'}`);
    }
  }

  await db.prepare(`UPDATE plans SET status='done', progress=100, progress_note=?, last_run_at=?, updated_at=? WHERE id=?`)
    .run(`完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（共 ${total} 条，真机 ${deviceSerial}）`, now(), planId);
  console.log(`[plan #${planId}] ${plan.name} 执行完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（真机 ${deviceSerial}）`);
}
