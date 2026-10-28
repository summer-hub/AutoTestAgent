// 执行引擎：执行计划直接运行用例绑定的自动化脚本（Python/Hypium + xdevice）
//  - 严格前置：真机在线 + Python 环境可用，否则计划置 failed 并写明原因（绝不模拟）
//  - 未绑定脚本的用例：记 skipped「未绑定自动化脚本」，不执行
//  - 绑定脚本：workspace/hypium/<lib>/testcases/<lib>/<caseNo>.py；
//    单用例执行 = python main.py <module> → 解析 reports/latest/result/<module>.xml 判定结果
//  - 实时进度：plans.progress / progress_note 每步更新，前端轮询展示
//  - B1 追溯：每次运行创建 test_runs + test_run_items（基线、用例版本快照），
//    每条 executions 写 test_run_id/baseline_id/case_version/case_snapshot_json/actual_json。
//    库无本地克隆时该库不参与基线追溯（执行照常，列留空并写明原因 —— 不伪造，向后兼容）。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { hdcAvailable, listTargets } from './hdc.js';
import { getSetting } from './settings.js';
import { ensureHypiumProject, hypiumProjectDir, hypiumCaseScriptPath, caseClassName } from './hypiumGen.js';
import { detectPython, runHypiumModule, probePythons, describePythonProbe } from './hypiumRunner.js';
import { recordScriptRun } from './scriptBinding.js';
import { nextRunNo, resolveBaselineForRun, getBaselineDetail, type BaselineDetail } from './baseline.js';
import { recordRunItemAssets } from './scenarioAssets.js';

interface PlanRow {
  id: number; plan_no: string; name: string; type: string; cron: string | null;
  scope: string; device_ids: string; status: string; fail_policy: string;
  baseline_id: number | null; baseline_mode: string;
  last_run_at: string | null; created_at: string; updated_at: string;
}
interface CaseRow {
  id: number; library_id: number; case_no: string; name: string; steps: string; status: string; library_name: string;
}

interface RunItemCtx {
  itemId: number;
  baselineId: number | null;
  baselineNo: string;
  commitSha: string;
  libraryVersion: string;
  resourceSetNo: string;
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

  // 原子占位：只有「把 status 从非 running 改成 running」的那一次调用才真正执行。
  // 否则连点两次「立即执行」、或 cron 触发与手动触发重叠时，同一计划会在真机上跑两份
  // （设备争抢 + 执行记录翻倍）。
  const claim = await db.prepare(
    `UPDATE plans SET status='running', error='', progress=2, progress_note='准备中…', updated_at=? WHERE id=? AND status <> 'running'`,
  ).run(t, planId);
  if (!Number(claim.changes)) {
    console.warn(`[plan #${planId}] 已有实例在执行中，本次触发跳过`);
    return;
  }

  try {
    await runPlanOnce(planId, plan, t);
  } catch (e) {
    // 任何异常（包括 device_ids 的 JSON.parse 这类前置解析）都必须落到终态：
    // 否则计划永久停在 running，而前端每 2 秒轮询一个永远不会结束的状态。
    const reason = (e as Error)?.message || String(e);
    console.error(`[plan #${planId}] 执行异常：${reason}`);
    // B1：本次运行期间创建的 test_runs / test_run_items 一并落终态（不留 running 悬挂）
    try {
      await db.prepare(`UPDATE test_run_items SET status='failed', error=?, finished_at=? WHERE run_id IN (SELECT id FROM test_runs WHERE plan_id=? AND status='running') AND status='running'`)
        .run(reason.slice(0, 480), now(), planId);
      await db.prepare(`UPDATE test_runs SET status='failed', error=?, finished_at=?, updated_at=? WHERE plan_id=? AND status='running'`)
        .run(reason.slice(0, 990), now(), now(), planId);
    } catch { /* 表未建等极端情况不掩盖原始异常 */ }
    await db.prepare(`UPDATE plans SET status='failed', error=?, progress=100, progress_note=?, last_run_at=?, updated_at=? WHERE id=?`)
      .run(reason.slice(0, 480), `失败：${reason.slice(0, 120)}`, t, now(), planId);
    throw e;
  }
}

/** 计划主体（已被 executePlan 原子占位，保证同一计划同时只有一个实例在执行）。 */
async function runPlanOnce(planId: number, plan: PlanRow, t: string): Promise<void> {
  const db = getDb();
  const planTraceId = `tr-plan-${planId}-${Date.now()}`;
  const setProgress = async (pct: number, note: string): Promise<void> => {
    await db.prepare(`UPDATE plans SET progress = ?, progress_note = ?, updated_at = ? WHERE id = ?`)
      .run(Math.max(0, Math.min(100, Math.round(pct))), note.slice(0, 280), now(), planId);
  };
  const failPlan = async (reason: string): Promise<void> => {
    await db.prepare(`UPDATE plans SET status='failed', error=?, progress=100, progress_note=?, last_run_at=?, updated_at=? WHERE id=?`)
      .run(reason.slice(0, 480), `失败：${reason.slice(0, 120)}`, t, now(), planId);
    console.warn(`[plan #${planId}] ${plan.name} 执行失败：${reason}`);
  };

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
    await failPlan(describePythonProbe(await probePythons()));
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

  // ---- B1：运行快照（test_runs + test_run_items + 用例版本快照）----
  // feature.baseline 关闭或库无本地克隆时降级为旧行为（执行照常，追溯列留空并写明原因）。
  const baselineEnabled = getSetting('feature.baseline', true);
  const baselineMode = plan.baseline_mode || 'latest';
  let testRunId: number | null = null;
  let runNo = '';
  const runItems = new Map<number, RunItemCtx>(); // library_id -> run item 上下文
  const untracedLibs: string[] = [];
  if (baselineEnabled && total > 0) {
    runNo = await nextRunNo();
    const insRun = await db.prepare(
      `INSERT INTO test_runs (run_no, plan_id, trigger_kind, status, device_id, manifest_json, error, started_at, created_by, created_at, updated_at)
       VALUES (?, ?, 'manual', 'running', ?, '{}', '', ?, 'plan', ?, ?)`,
    ).run(runNo, planId, deviceId, t, t, t);
    testRunId = Number(insRun.lastInsertRowid);

    for (const [libName, items] of groups) {
      const libId = items[0].row.library_id;
      // 用例版本快照：运行开始时的 caseId -> current_version（运行中改用例不影响本次执行）
      const caseVersions: Record<string, number> = {};
      for (const it of items) {
        const cv = await db.prepare('SELECT current_version AS v FROM cases WHERE id = ?').get<{ v: number }>(it.row.id);
        if (cv && cv.v > 0) caseVersions[String(it.row.id)] = cv.v;
      }
      try {
        const baseline = await resolveBaselineForRun(libId, baselineMode, plan.baseline_id);
        const detail = await getBaselineDetail(baseline.id);
        const libVersionRow = await db.prepare('SELECT current_version AS v FROM libraries WHERE id = ?').get<{ v: string }>(libId);
        const insItem = await db.prepare(
          `INSERT INTO test_run_items (run_id, library_id, baseline_id, commit_sha, repo_subpath, workspace_rel_dir, case_versions_json, status, error, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '', ?, NULL)`,
        ).run(
          testRunId, libId, baseline.id, detail?.commit_sha ?? '', baseline.repo_subpath,
          `runs/${runNo}/${libName}`, JSON.stringify(caseVersions), t,
        );
        runItems.set(libId, {
          itemId: Number(insItem.lastInsertRowid),
          baselineId: baseline.id,
          baselineNo: baseline.baseline_no,
          commitSha: detail?.commit_sha ?? '',
          libraryVersion: libVersionRow?.v ?? '',
          resourceSetNo: '',
        });
        // B2：收集本次运行用例关联的场景资产 —— 资源集快照（版本/sha256）+ run_item_assets 登记
        // feature.scenarioAssets 关闭时跳过（运行照常，只是资源不可追溯）。
        if (getSetting('feature.scenarioAssets', true)) {
          try {
            const rs = await recordRunItemAssets(testRunId, Number(insItem.lastInsertRowid), libId, items.map((i) => i.row.id), runNo);
            if (rs) {
              const ctx0 = runItems.get(libId)!;
              ctx0.resourceSetNo = rs.setNo;
            }
          } catch (e) {
            // 资产登记失败不阻断执行 —— 但必须留痕（运行可继续，报告可查原因）
            console.warn(`[plan #${planId}] 库 ${libName} 场景资产登记失败：${(e as Error).message}`);
            await db.prepare(`UPDATE test_run_items SET error = ? WHERE id = ?`)
              .run(`场景资产登记失败：${(e as Error).message}`.slice(0, 450), Number(insItem.lastInsertRowid));
          }
        }
      } catch (e) {
        // latest 模式下解析失败（典型：库未配置仓库/未克隆）不阻断执行 —— 追溯缺失但执行照常。
        // fixed 模式是显式用户意图，失败必须让计划失败（在外层由 failPlan 兜底，这里先记录）。
        const reason = (e as Error)?.message || String(e);
        if (baselineMode === 'fixed') {
          await failPlan(`固定基线解析失败（${libName}）：${reason}`);
          await db.prepare(`UPDATE test_run_items SET status='failed', error=?, finished_at=? WHERE run_id=? AND status='running'`)
            .run(`固定基线解析失败：${reason}`.slice(0, 480), now(), testRunId);
          await db.prepare(`UPDATE test_runs SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?`)
            .run(`固定基线解析失败：${reason}`.slice(0, 990), now(), now(), testRunId);
          return;
        }
        untracedLibs.push(libName);
        console.warn(`[plan #${planId}] 库 ${libName} 基线追溯跳过：${reason}`);
      }
    }
  }

  // ---- executions 写入（含 B1 追溯列）----
  const caseMetaCache = new Map<number, { version: number | null; snapshotJson: string | null }>();
  const caseMeta = async (caseId: number): Promise<{ version: number | null; snapshotJson: string | null }> => {
    if (!caseMetaCache.has(caseId)) {
      const row = await db.prepare(
        `SELECT c.current_version AS v, cv.snapshot AS s FROM cases c
         LEFT JOIN case_versions cv ON cv.case_id = c.id AND cv.version = c.current_version
         WHERE c.id = ?`,
      ).get<{ v: number | null; s: string | null }>(caseId);
      caseMetaCache.set(caseId, row ? { version: row.v ?? null, snapshotJson: row.s ?? null } : { version: null, snapshotJson: null });
    }
    return caseMetaCache.get(caseId)!;
  };

  /** actual_json（设计 §6.6）：steps 可为整批 summary，但 result/baseline/caseVersion 必填。 */
  const buildActualJson = (ctx: RunItemCtx | undefined, caseVersion: number | null, status: string, reason: string, steps: Array<Record<string, unknown>>, startedAt: string, finishedAt: string): string => {
    return JSON.stringify({
      schemaVersion: 1,
      baseline: ctx ? { id: ctx.baselineId, no: ctx.baselineNo, commit: ctx.commitSha, version: ctx.libraryVersion } : null,
      resourceSet: ctx && ctx.resourceSetNo ? { no: ctx.resourceSetNo } : null,
      caseVersion,
      device: { serial: deviceSerial },
      startedAt,
      finishedAt,
      result: { status, reason },
      steps,
      untracedReason: ctx ? undefined : (baselineEnabled ? '库无本地克隆或基线解析失败，本次执行未纳入基线追溯' : '基线功能已关闭（feature.baseline=false）'),
    });
  };

  const insExec = db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id,
    test_run_id, run_item_id, baseline_id, case_version, case_snapshot_json, library_version, commit_sha, actual_json,
    thinking, logs, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const [libName, items] of groups) {
    const libId = items[0].row.library_id;
    const ctx = runItems.get(libId);
    const boundItems = items.filter((i) => i.scriptPath !== null);
    for (const item of items.filter((i) => i.scriptPath === null)) {
      done++;
      skipped++;
      const meta = await caseMeta(item.row.id);
      await insExec.run(
        planId, item.row.id, item.row.library_id, deviceId, 'skipped',
        JSON.stringify([{ seq: 1, desc: '未绑定自动化脚本，跳过执行', status: 'skipped', durationMs: 0 }]),
        planTraceId,
        testRunId, ctx?.itemId ?? null, ctx?.baselineId ?? null, meta.version, meta.snapshotJson,
        ctx?.libraryVersion ?? '', ctx?.commitSha ?? '',
        buildActualJson(ctx, meta.version, 'skipped', '未绑定自动化脚本', [{ seq: 1, desc: '未绑定自动化脚本', status: 'skipped' }], t, now()),
        '该用例尚未绑定自动化脚本（Python/Hypium）。请在任务页使用「用例转自动化脚本」生成，或在自动化脚本页手工新建 <用例编号>.py 后重试。',
        `[${t}] 设备 ${deviceSerial} · 用例 ${item.row.case_no} 跳过（未绑定脚本）`, t, now(),
      );
      await setProgress(2 + (done / total) * 95, `${done}/${total} · ${item.row.case_no} 跳过（未绑定脚本）`);
    }
    if (boundItems.length === 0) {
      // 全部未绑定脚本：该库无实际执行，run item 直接收口
      if (ctx) {
        try {
          await db.prepare(`UPDATE test_run_items SET status='done', finished_at=? WHERE id=?`).run(now(), ctx.itemId);
        } catch { /* 不影响执行结果 */ }
      }
      continue;
    }

    const pkgRow = await db.prepare('SELECT package_name FROM libraries WHERE name = ?').get<{ package_name: string }>(libName);
    ensureHypiumProject({ name: libName, packageName: pkgRow?.package_name || libName }, deviceSerial);

    for (let idx = 0; idx < boundItems.length; idx++) {
      const item = boundItems[idx];
      const cls = caseClassName(libName, item.row.case_no);
      await setProgress(2 + (done / total) * 95, `${done}/${total} · 正在执行 ${item.row.case_no}（${cls}）…`);
      const t0 = Date.now();
      let result = await runHypiumModule(pythonCmd, item.projDir, item.moduleStem, 10 * 60_000);
      let attempts = 1;
      while (result.status === 'failed' && attempts <= retryTimes) {
        result = await runHypiumModule(pythonCmd, item.projDir, item.moduleStem, 10 * 60_000);
        attempts++;
      }
      const durationMs = Date.now() - t0;
      const meta = await caseMeta(item.row.id);
      const stepDesc = `运行 Hypium 脚本 ${item.moduleStem}.py${attempts > 1 ? `（重试 ${attempts - 1} 次）` : ''}`;
      const stepsJson = [{ seq: 1, desc: stepDesc, status: result.status, durationMs }];
      await insExec.run(
        planId, item.row.id, item.row.library_id, deviceId, result.status,
        JSON.stringify(stepsJson),
        planTraceId,
        testRunId, ctx?.itemId ?? null, ctx?.baselineId ?? null, meta.version, meta.snapshotJson,
        ctx?.libraryVersion ?? '', ctx?.commitSha ?? '',
        buildActualJson(ctx, meta.version, result.status, result.status === 'failed' ? result.log.slice(0, 500) : '', stepsJson, t, now()),
        realThinking(item.row, result.status, result.log),
        [`[${now()}] 设备 ${deviceSerial} · ${item.row.case_no} · python main.py ${item.moduleStem}`, result.log].join('\n'),
        t, now(),
      );
      done++;
      if (result.status === 'passed') passed++; else failed++;
      // P8：脚本执行结果回写绑定（供 flaky 识别与"这个脚本到底跑没跑过"）
      try { await recordScriptRun(item.row.id, result.status); } catch { /* 回写失败不影响执行结果 */ }
      if (result.status === 'failed' && failPolicy === 'abort_library') {
        for (const rest of boundItems.slice(idx + 1)) {
          done++;
          skipped++;
          const restMeta = await caseMeta(rest.row.id);
          await insExec.run(
            planId, rest.row.id, rest.row.library_id, deviceId, 'skipped',
            JSON.stringify([{ seq: 1, desc: '整库失败中止，跳过执行', status: 'skipped', durationMs: 0 }]),
            planTraceId,
            testRunId, ctx?.itemId ?? null, ctx?.baselineId ?? null, restMeta.version, restMeta.snapshotJson,
            ctx?.libraryVersion ?? '', ctx?.commitSha ?? '',
            buildActualJson(ctx, restMeta.version, 'skipped', '整库失败中止', [{ seq: 1, desc: '整库失败中止', status: 'skipped' }], t, now()),
            '按失败策略 abort_library：该库已有失败用例，后续用例跳过。',
            `[${t}] 设备 ${deviceSerial} · 用例 ${rest.row.case_no} 跳过（整库中止）`, t, now(),
          );
        }
        break;
      }
      await setProgress(2 + (done / total) * 95, `${done}/${total} · ${item.row.case_no} ${result.status === 'passed' ? '通过' : '失败'}`);
    }
    // 该库执行结束，收口 run item
    if (ctx) {
      try {
        await db.prepare(`UPDATE test_run_items SET status='done', finished_at=? WHERE id=?`).run(now(), ctx.itemId);
      } catch { /* 不影响执行结果 */ }
    }
  }

  // ---- B1：test_runs 收口 ----
  if (testRunId) {
    const manifest = {
      planNo: plan.plan_no, baselineMode, untracedLibs,
      runCopyCreated: false, // B1：Hypium 脚本直接跑 workspace/hypium，未从基线复制运行副本（B2 场景资源阶段引入）
    };
    await db.prepare(`UPDATE test_runs SET status='done', manifest_json=?, finished_at=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(manifest), now(), now(), testRunId);
  }

  const traceNote = untracedLibs.length > 0 ? `；未纳入基线追溯：${untracedLibs.join('、')}` : '';
  await db.prepare(`UPDATE plans SET status='done', progress=100, progress_note=?, last_run_at=?, updated_at=? WHERE id=?`)
    .run(`完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（共 ${total} 条，真机 ${deviceSerial}）${traceNote}`.slice(0, 280), now(), planId);
  console.log(`[plan #${planId}] ${plan.name} 执行完成：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（真机 ${deviceSerial}${runNo ? ` · run ${runNo}` : ''}）`);
}
