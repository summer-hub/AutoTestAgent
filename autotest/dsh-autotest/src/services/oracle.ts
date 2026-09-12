// P6：oracle 强制与反假通过。
//
// 这是本项目的**硬门槛**：断言覆盖率 100%、假通过 0。
// 它要解决的正是最初审计里最严重的两个问题（R9/R12）：
//   - 用例的"预期结果"是一句自然语言（"功能正常"），脚本通过与否无法判定；
//   - 脚本"通过了"，但其实一条断言都没有 —— 这是最坏的假通过：它把"没测"变成"测过了"。
//
// 因此这里的规则只有两条，但都必须能离线逐条核对：
//   ① 每条用例必须有**至少一条可机器校验的 oracle**（7 种取值域，见下）；否则不允许入库；
//   ② 跑通过（passed）但没有任何可校验判据的，一律判为**假通过**，不计入覆盖率成绩。
//
// 纯函数：不读 DB、不碰设备、不调 LLM。
import { getDb, now } from '../db/connection.js';

/** 设计 §6.6 的 7 种 oracle 取值域。 */
export type OracleType =
  | 'control_text'      // 界面出现/消失指定控件文本（ui layout 检索）
  | 'text_value'        // 指定控件文本等于/包含某值（ui layout 读 text）
  | 'hilog_keyword'     // hilog 出现关键字（含错误码）（devecocli log）
  | 'state_flag'        // 控件 checkable 状态为真/假（ui layout 读标志）
  | 'no_crash'          // 执行期间无 E 级日志/无崩溃（devecocli log --level E）
  | 'screenshot_diff'   // 截图像素差异在阈值内/外
  | 'script_assert';    // 脚本内断言（Hypium）

export const ORACLE_LABEL: Record<OracleType, string> = {
  control_text: '控件出现/消失',
  text_value: '控件文本等于/包含',
  hilog_keyword: 'hilog 关键字',
  state_flag: '控件勾选状态',
  no_crash: '无崩溃/无 E 级日志',
  screenshot_diff: '截图差异',
  script_assert: '脚本断言',
};

/** 哪些 oracle 类型**天然可机器校验**（无需人工看图）。 */
const MACHINE_VERIFIABLE: Record<OracleType, boolean> = {
  control_text: true,
  text_value: true,
  hilog_keyword: true,
  state_flag: true,
  no_crash: true,
  screenshot_diff: true,
  script_assert: true,
};

export interface Oracle {
  type: OracleType;
  /** 目标控件文本（control_text / text_value / state_flag 必填） */
  control?: string;
  /** control_text：期望出现还是消失 */
  expect?: 'appear' | 'disappear';
  /** text_value：比较方式 */
  op?: 'equals' | 'contains' | 'matches';
  /** text_value / hilog_keyword 的期望值 */
  value?: string;
  keyword?: string;
  /** no_crash / hilog_keyword 关注的日志级别 */
  level?: 'E' | 'W' | 'I';
  /** state_flag：期望的 checkable 值 */
  state?: boolean;
  /** screenshot_diff 的允许差异比例（0-1） */
  threshold?: number;
  /** script_assert 的断言表达式（必须非平凡） */
  expr?: string;
  /** 判据说明（人读；不参与校验） */
  note?: string;
}

/**
 * 不可核对的"伪判据"词：这些词出现在期望值里说明判据本身没有内容。
 * 它们正是 R9（预期结果含糊，如"预期结果：功能正常"）的典型形态，必须拦住，
 * 否则"断言覆盖率 100%"就成了数字游戏。
 *
 * 取舍说明：这里**刻意偏严**。"正常/成功"这类词偶尔真的会出现在界面上，
 * 那时作者把它写成界面上真正会出现的文本（如"验证成功：true"）即可；
 * 而放行的代价是留下一条永远不可能失败的断言 —— 假通过的代价远大于改写一个词。
 * 反过来，机器字面量（true/false/ok/1/0）是**真实会显示在界面上的值**，一律放行，
 * 不能因为"看着像布尔"就拒掉（实测 demo 的界面就显示 `实际结果：true`）。
 */
const VAGUE_VALUES = /^(功能正常|符合预期|符合期望|没有异常|无异常|没问题|正常|成功|失败|正确|可用|好|没问题)$/i;

export interface OracleProblem {
  index: number;
  reason: string;
}

/**
 * 校验一组 oracle 是否**真的可机器校验**。
 * 返回空数组表示通过 —— 这是"允许入库"的唯一依据。
 */
export function validateOracles(oracles: unknown): OracleProblem[] {
  const problems: OracleProblem[] = [];
  if (!Array.isArray(oracles)) {
    return [{ index: -1, reason: 'oracle 必须是数组（没有 oracle 的用例不允许入库）' }];
  }
  if (oracles.length === 0) {
    return [{ index: -1, reason: '没有任何 oracle：断言为空的用例就是假通过，不允许入库' }];
  }
  oracles.forEach((raw, index) => {
    const o = raw as Oracle;
    if (!o || typeof o !== 'object') { problems.push({ index, reason: 'oracle 不是对象' }); return; }
    if (!o.type || !(o.type in MACHINE_VERIFIABLE)) {
      problems.push({ index, reason: `未知的 oracle 类型：${String(o.type)}` });
      return;
    }
    if (!MACHINE_VERIFIABLE[o.type]) {
      problems.push({ index, reason: `${ORACLE_LABEL[o.type]} 无法机器校验，需人工看图` });
    }
    switch (o.type) {
      case 'control_text':
        if (!o.control?.trim()) problems.push({ index, reason: 'control_text 缺少目标控件文本' });
        if (o.control && VAGUE_VALUES.test(o.control.trim())) problems.push({ index, reason: `control_text 的目标控件「${o.control}」过于笼统，无法定位` });
        if (o.expect !== 'disappear') o.expect = 'appear';
        break;
      case 'text_value':
        if (!o.control?.trim()) problems.push({ index, reason: 'text_value 缺少目标控件文本' });
        if (!o.value?.trim()) problems.push({ index, reason: 'text_value 缺少期望值' });
        if (o.value && VAGUE_VALUES.test(o.value.trim())) {
          problems.push({ index, reason: `text_value 的期望值「${o.value}」不具体（"正常/成功"这类词无法核对），必须写成界面上真正会出现的文本` });
        }
        if (!['equals', 'contains', 'matches'].includes(String(o.op))) o.op = 'contains';
        break;
      case 'hilog_keyword':
        if (!o.keyword?.trim() && !o.value?.trim()) problems.push({ index, reason: 'hilog_keyword 缺少关键字' });
        break;
      case 'state_flag':
        if (!o.control?.trim()) problems.push({ index, reason: 'state_flag 缺少目标控件文本' });
        if (typeof o.state !== 'boolean') problems.push({ index, reason: 'state_flag 缺少期望状态（true/false）' });
        break;
      case 'no_crash':
        if (!o.level) o.level = 'E';
        break;
      case 'screenshot_diff':
        if (typeof o.threshold !== 'number' || o.threshold < 0 || o.threshold > 1) problems.push({ index, reason: 'screenshot_diff 缺少合法的阈值（0-1）' });
        break;
      case 'script_assert':
        if (!o.expr?.trim()) problems.push({ index, reason: 'script_assert 缺少断言表达式' });
        else if (/^assert\s+(true|1)\b/i.test(o.expr.trim())) problems.push({ index, reason: 'script_assert 是恒真断言（assert true），等于没有断言' });
        break;
      default:
        break;
    }
  });
  return problems;
}

/** 用例是否达到"可机器校验"的入库门槛。 */
export function hasVerifiableOracle(oracles: unknown): boolean {
  return validateOracles(oracles).length === 0;
}

// ---------- 反假通过 ----------

export interface ExecutionFacts {
  passed: boolean;
  /** 实际执行的步骤（真机句式） */
  steps: string[];
  /** 执行器记录的每步结果 */
  stepResults?: Array<{ desc: string; status: 'passed' | 'failed' | 'skipped' }>;
  /** 执行期间是否校验了 oracle（由执行器在断言步骤上打点） */
  oraclesChecked?: number;
}

export interface FalsePassVerdict {
  falsePass: boolean;
  severity: 'none' | 'weak' | 'false';
  reason: string;
}

/**
 * 是否是"验证步骤"。
 *
 * 必须按**句式开头**判断，不能在整句里找"验证"两个字：
 * 真机 demo 里按钮就叫「验证」（json-schema 的每个页面都有一个），
 * 于是 `点击「验证」` 会被误认为验证步骤 —— 那样任何点了这个按钮的用例
 * 都会"看起来有断言"，正是我们要防的假通过。
 */
export function isVerifyStep(step: string): boolean {
  return /^\s*(验证|断言|检查|确认结果|核对)/.test(String(step ?? ''));
}

/**
 * 反假通过（修 R12）。
 *
 * 判据只有一条主线：**"通过"必须有可核对的依据**。
 *   - 通过了但一条 oracle 都没有 → 假通过（最严重：把没测变成测过）；
 *   - 通过了但一个 oracle 都没被实际校验（oraclesChecked=0）→ 假通过；
 *   - 通过了但步骤里没有任何验证动作 → 弱通过（说明用例本身没设计断言）。
 * 失败（未通过）的用例不属于假通过 —— 它至少暴露了问题。
 */
export function detectFalsePass(oracles: unknown, exec: ExecutionFacts): FalsePassVerdict {
  if (!exec.passed) return { falsePass: false, severity: 'none', reason: '用例未通过：不属于假通过（失败本身是有效信号）' };
  const problems = validateOracles(oracles);
  if (problems.length > 0) {
    return {
      falsePass: true,
      severity: 'false',
      reason: `脚本通过但断言不可核验：${problems.map((p) => p.reason).join('；')}`,
    };
  }
  if (exec.oraclesChecked === 0) {
    return { falsePass: true, severity: 'false', reason: '脚本通过但执行期间没有任何 oracle 被校验（oraclesChecked=0）' };
  }
  const declared = exec.steps.some(isVerifyStep);
  // 有步骤结果时，要求验证步骤**真的执行过**（skipped 不算）
  const executed = exec.stepResults
    ? exec.stepResults.some((r) => isVerifyStep(r.desc) && r.status === 'passed')
    : declared;
  if (!declared && !executed) {
    return { falsePass: false, severity: 'weak', reason: '脚本通过且 oracle 已校验，但步骤里没有显式的验证动作（建议补一步验证）' };
  }
  if (declared && exec.stepResults && !executed) {
    return { falsePass: false, severity: 'weak', reason: '验证步骤被跳过或未执行（skipped），不能算"已验证"' };
  }
  return { falsePass: false, severity: 'none', reason: '通过且有可核对的断言依据' };
}

// ---------- 质量度量（硬门槛） ----------

export interface QualityReport {
  libraryId: number;
  total: number;
  /** 带可机器校验 oracle 的用例数 */
  withOracle: number;
  /** 断言覆盖率（硬门槛 100%） */
  oracleCoverage: number;
  /** 通过但断言为空/未校验的用例（硬门槛 0） */
  falsePass: number;
  falsePassCases: Array<{ caseNo: string; name: string; reason: string }>;
  missingOracleCases: Array<{ caseNo: string; name: string; reason: string }>;
  /** 两个硬门槛是否达标 */
  gates: { oracleCoverage: boolean; falsePass: boolean; allPassed: boolean };
}

/** 计算某库的质量指标并判定硬门槛（数据来自库里已落地的用例）。 */
export async function evaluateQuality(libraryId: number): Promise<QualityReport> {
  const db = getDb();
  const rows = await db.prepare(`SELECT id, case_no, name, steps, oracle_json, status FROM cases WHERE library_id = ? ORDER BY id`)
    .all<{ id: number; case_no: string; name: string; steps: string; oracle_json: string; status: string }>(libraryId);
  const missingOracleCases: QualityReport['missingOracleCases'] = [];
  let withOracle = 0;
  for (const r of rows) {
    let oracles: unknown = [];
    try { oracles = JSON.parse(r.oracle_json || '[]'); } catch { oracles = []; }
    const problems = validateOracles(oracles);
    if (problems.length === 0) withOracle++;
    else missingOracleCases.push({ caseNo: r.case_no, name: r.name, reason: problems.map((p) => p.reason).join('；').slice(0, 200) });
  }
  // 假通过：库里状态为"通过"的用例，逐一核对是否有可核验断言
  const passed = rows.filter((r) => r.status === '通过');
  const falsePassCases: QualityReport['falsePassCases'] = [];
  for (const r of passed) {
    let oracles: unknown = [];
    try { oracles = JSON.parse(r.oracle_json || '[]'); } catch { oracles = []; }
    let steps: string[] = [];
    try { steps = JSON.parse(r.steps || '[]') as string[]; } catch { steps = []; }
    const v = detectFalsePass(oracles, { passed: true, steps, oraclesChecked: Array.isArray(oracles) ? oracles.length : 0 });
    if (v.falsePass) falsePassCases.push({ caseNo: r.case_no, name: r.name, reason: v.reason });
  }
  const total = rows.length;
  const oracleCoverage = total === 0 ? 0 : Math.round((withOracle / total) * 1000) / 10;
  const gates = {
    oracleCoverage: total === 0 ? true : oracleCoverage >= 100,
    falsePass: falsePassCases.length === 0,
    allPassed: false,
  };
  gates.allPassed = gates.oracleCoverage && gates.falsePass;
  return { libraryId, total, withOracle, oracleCoverage, falsePass: falsePassCases.length, falsePassCases, missingOracleCases, gates };
}

/** 把 oracle 写入用例（生成/优化阶段落库）。 */
export async function saveCaseOracles(caseId: number, oracles: Oracle[]): Promise<void> {
  await getDb().prepare('UPDATE cases SET oracle_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(oracles), now(), caseId);
}
