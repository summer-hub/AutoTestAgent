// 执行引擎：执行计划直接运行用例绑定的自动化脚本（Python/Hypium + xdevice）
//  - 严格前置：真机在线 + Python 环境可用，否则计划置 failed 并写明原因（绝不模拟）
//  - 未绑定脚本的用例：记 skipped「未绑定自动化脚本」，不执行
//  - 绑定脚本：workspace/hypium/<lib>/testcases/<lib>/<caseNo>.py；
//    单用例执行 = 重写 main.py 的模块名 → python main.py <module> → 解析 reports/latest/result/<module>.xml 判定结果
//  - 实时进度：plans.progress / progress_note 每步更新，前端轮询展示
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDb, now } from '../db/connection.js';
import { hdcAvailable, listTargets } from './hdc.js';
import { getSetting } from './settings.js';
import { ensureHypiumProject, hypiumProjectDir, hypiumCaseScriptPath, caseClassName } from './hypiumGen.js';

const execFileAsync = promisify(execFile);

interface PlanRow {
  id: number; plan_no: string; name: string; type: string; cron: string | null;
  scope: string; device_ids: string; status: string; fail_policy: string;
  last_run_at: string | null; created_at: string; updated_at: string;
}
interface CaseRow {
  id: number; library_id: number; case_no: string; name: string; steps: string; status: string; library_name: string;
}

/** 检测本机 Python 命令。 */
async function detectPython(): Promise<string | null> {
  for (const cmd of ['python', 'python3']) {
    try {
      await execFileAsync(cmd, ['--version'], { timeout: 8000 });
      return cmd;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 运行单个 Hypium 模块并解析结果 XML。返回 passed/failed + 日志摘要。 */
async function runHypiumModule(
  pythonCmd: string,
  projDir: string,
  moduleStem: string,
  timeoutMs: number,
): Promise<{ status: 'passed' | 'failed'; log: string }> {
  // main.py 支持argv传模块名；兼容旧版占位符 main.py（重写一次）
  const mainFile = path.join(projDir, 'main.py');
  let src = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
  if (!src.includes('sys.argv')) {
    fs.writeFileSync(mainFile, [
      '# -*- coding: utf-8 -*-',
      'import sys',
      'from xdevice.__main__ import main_process',
      '',
      'if __name__ == "__main__":',
      '  module = "PLACEHOLDER"',
      '  if len(sys.argv) > 1:',
      '    module = sys.argv[1]',
      '  main_process(f"run -l {module} -ta agent_mode:bin;screenshot:true")',
      '',
    ].join('\n'), 'utf8');
    src = fs.readFileSync(mainFile, 'utf8');
  }
  const reportsDir = path.join(projDir, 'reports');
  const knownReports = new Set(fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : []);

  let stdout = '';
  try {
    const r = await execFileAsync(pythonCmd, ['main.py', moduleStem], { cwd: projDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    stdout = (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    stdout = (err.stdout || '') + (err.stderr || '') + `\n[process] ${err.message ?? ''}`;
  }

  // 定位本次新生成的报告目录
  let latest = '';
  if (fs.existsSync(reportsDir)) {
    const fresh = fs.readdirSync(reportsDir).filter((d) => !knownReports.has(d));
    if (fresh.length > 0) latest = fresh.sort().pop() ?? '';
    else latest = fs.readdirSync(reportsDir).sort().pop() ?? '';
  }
  const resultXml = path.join(reportsDir, latest, 'result', `${moduleStem}.xml`);
  if (!fs.existsSync(resultXml)) {
    return { status: 'failed', log: `未找到结果报告 ${path.relative(projDir, resultXml)}；输出尾部：${stdout.slice(-400)}` };
  }
  const xml = fs.readFileSync(resultXml, 'utf8');
  const attr = (k: string): string => new RegExp(`${k}="([^"]*)"`).exec(xml)?.[1] ?? '';
  const failures = Number(attr('failures') || 0) + Number(attr('errors') || 0);
  const unavailable = attr('unavailable') === '1';
  const message = (attr('message') || '').replace(/&#\d+;/g, '').slice(0, 200);
  if (unavailable) {
    return { status: 'failed', log: `环境不可用：${message || '设备条件不满足'}` };
  }
  if (failures > 0) {
    return { status: 'failed', log: `Hypium 执行失败（failures/errors=${failures}）${message ? `：${message}` : ''}；输出尾部：${stdout.slice(-300)}` };
  }
  return { status: 'passed', log: `Hypium 通过（${attr('tests') || '?'} tests, ${attr('time') || '0'}s），报告：reports/${latest}` };
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
    await failPlan('真机未连接：hdc list targets 为空。请在「设备管理」页点击「识别设备」连接真机后重试。');
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

  // 展开用例详情并按库分组
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
    const item: Item = {
      row,
      scriptPath: bound ? scriptPath : null,
      moduleStem: path.basename(scriptPath, '.py'),
      projDir: hypiumProjectDir(libName),
    };
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
    // 未绑定 → 全部跳过
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

    // 工程骨架 + 设备序列号刷新
    const pkgRow = await db.prepare('SELECT package_name FROM libraries WHERE name = ?').get<{ package_name: string }>(libName);
    ensureHypiumProject({ name: libName, packageName: pkgRow?.package_name || libName }, deviceSerial);

    for (const item of boundItems) {
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
      const status = result.status;
      await insExec.run(
        planId, item.row.id, item.row.library_id, deviceId, status,
        JSON.stringify([
          { seq: 1, desc: `运行 Hypium 脚本 ${item.moduleStem}.py${attempts > 1 ? `（重试 ${attempts - 1} 次）` : ''}`, status, durationMs },
        ]),
        status === 'passed'
          ? `在真实设备（${deviceSerial}）上通过 xdevice/Hypium 执行绑定脚本 ${item.moduleStem}.py，结果通过。`
          : `在真实设备（${deviceSerial}）上执行绑定脚本 ${item.moduleStem}.py 失败。\n${result.log}`,
        [`[${now()}] 设备 ${deviceSerial} · ${item.row.case_no} · python main.py ${item.moduleStem}`, result.log].join('\n'),
        t, now(),
      );
      done++;
      if (status === 'passed') passed++; else failed++;
      if (status === 'failed' && failPolicy === 'abort_library') {
        for (const rest of boundItems.slice(boundItems.indexOf(item) + 1)) {
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
      await setProgress(2 + (done / total) * 95, `${done}/${total} · ${item.row.case_no} ${status === 'passed' ? '通过' : '失败'}`);
    }
  }

  await db.prepare(`UPDATE plans SET status='done', progress=100, progress_note=?, last_run_at=?, updated_at=? WHERE id=?`)
    .run(`完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（共 ${total} 条，真机 ${deviceSerial}）`, now(), planId);
  console.log(`[plan #${planId}] ${plan.name} 执行完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（真机 ${deviceSerial}）`);
}
