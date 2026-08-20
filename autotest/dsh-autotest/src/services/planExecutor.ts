// 执行引擎：将执行计划解析为用例集 → 生成 executions（含逐步轨迹 + AI 思考）→ 更新计划状态
// 当前执行器为「模拟执行」：轨迹按用例步骤模板生成，思考过程按归因模板生成；
// 真实设备执行链路（hdc / UI 自动化）在 M5 之后的设备执行引擎迭代接入。
import { getDb, now } from '../db/connection.js';
import { getSetting } from './settings.js';

interface PlanRow {
  id: number; plan_no: string; name: string; type: string; cron: string | null;
  scope: string; device_ids: string; status: string; fail_policy: string;
  last_run_at: string | null; created_at: string; updated_at: string;
}
interface CaseRow {
  id: number; library_id: number; case_no: string; name: string; steps: string; status: string;
}
interface DeviceRow { id: number; serial: string; model: string; }

/** 解析计划 scope → 用例 id 列表（空 = 全量） */
function resolveCaseIds(db: ReturnType<typeof getDb>, scope: { libraryIds: number[]; caseIds: number[] }): Array<{ id: number; library_id: number }> {
  if (scope.caseIds && scope.caseIds.length > 0) {
    const marks = scope.caseIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, library_id FROM cases WHERE id IN (${marks})`).all(...scope.caseIds) as Array<{ id: number; library_id: number }>;
  }
  if (scope.libraryIds && scope.libraryIds.length > 0) {
    const marks = scope.libraryIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, library_id FROM cases WHERE library_id IN (${marks})`).all(...scope.libraryIds) as Array<{ id: number; library_id: number }>;
  }
  return db.prepare('SELECT id, library_id FROM cases').all() as Array<{ id: number; library_id: number }>;
}

const UI_VERBS = ['打开', '点击', '滑动', '长按', '输入', '等待', '验证', '切换', '滚动', '选择'];
const UI_TARGETS = ['主界面', '设置项', '列表项', '弹窗', '输入框', '下拉菜单', '确认按钮', '返回按钮', '详情页', '二级菜单'];
const UI_STATES = ['界面响应', '数据刷新', '状态保持', '渲染完成', '焦点位置', '动画结束', '文案显示', '样式一致'];

/** 为单个用例构造执行轨迹（模拟） */
function buildSteps(caseRow: CaseRow, failed: boolean): Array<{ seq: number; desc: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number }> {
  const raw = JSON.parse(caseRow.steps || '[]') as string[];
  const steps = raw.length >= 3
    ? raw.slice(0, 6)
    : Array.from({ length: 4 + (caseRow.id % 3) }, (_, i) => `${UI_VERBS[i % UI_VERBS.length]}${UI_TARGETS[(caseRow.id + i) % UI_TARGETS.length]}，验证${UI_STATES[(caseRow.id + i) % UI_STATES.length]}`);
  const failAt = 1 + (caseRow.id % 2); // 失败步骤位置（1-2 步）
  return steps.map((desc, i) => {
    const seq = i + 1;
    let status: 'passed' | 'failed' | 'skipped' = 'passed';
    if (failed && i === failAt) status = 'failed';
    if (failed && i > failAt) status = 'skipped';
    return { seq, desc: `${desc}`, status, durationMs: 300 + ((caseRow.id * 7 + i * 131) % 2600) };
  });
}

function buildThinking(caseRow: CaseRow, failed: boolean): string {
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

export async function executePlan(planId: number): Promise<void> {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
  if (!plan) return;
  const t = now();
  const t2 = now();

  db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(t, planId);

  const scope = JSON.parse(plan.scope || '{"libraryIds":[],"caseIds":[]}') as { libraryIds: number[]; caseIds: number[] };
  const cases = resolveCaseIds(db, scope);
  const devices = (JSON.parse(plan.device_ids || '[]') as number[]).map((id) =>
    db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined,
  ).filter(Boolean) as DeviceRow[];
  const device: { id: number | null; serial: string; model: string } =
    devices[0] ?? { id: null, serial: 'SIM-0000', model: '模拟设备' };

  // 限制单次执行规模（演示）：全量计划抽样 60 条，避免 4.5 万条全跑
  const fullSample = getSetting('exec.planSampleFull', 60);
  const batchSample = getSetting('exec.planSampleBatch', 30);
  const singleSample = getSetting('exec.planSampleSingle', 200);
  const sample = plan.type === 'full'
    ? cases.filter((_, i) => i % 750 === 0).slice(0, fullSample)
    : cases.slice(0, plan.type === 'batch' ? batchSample : singleSample);

  let passed = 0;
  let failed = 0;
  db.transaction(() => {
    const insExec = db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, thinking, logs, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of sample) {
      const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id) as CaseRow;
      const isFail = caseRow.status === '失败' || (caseRow.id % 17 === 0); // 失败率 ~6%
      const status = isFail ? 'failed' : 'passed';
      if (isFail) failed++; else passed++;
      const started = t;
      const finished = t2;
      insExec.run(
        planId, c.id, c.library_id, device.id, status,
        JSON.stringify(buildSteps(caseRow, isFail)),
        buildThinking(caseRow, isFail),
        `[${started}] 设备 ${device.serial} · 用例 ${caseRow.case_no} ${status === 'passed' ? '通过' : '失败'}`,
        started, finished,
      );
    }
  })();

  db.prepare(`UPDATE plans SET status='done', last_run_at=?, updated_at=? WHERE id=?`).run(t2, t2, planId);
  console.log(`[plan #${planId}] ${plan.name} 执行完成：${sample.length} 用例，通过 ${passed} / 失败 ${failed}`);
}
