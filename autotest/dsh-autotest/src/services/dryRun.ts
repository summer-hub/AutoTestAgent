// 模拟器/真机 dry-run 执行器：把 AI 生成的用例在设备上真跑一遍，产出可回灌的结构化失败证据。
//
// harness 的核心原则「执行器为真（execution as ground truth）」：跑起来，拿真实失败喂回生成端迭代。
// 与 executeCaseSteps 的区别——后者是黑盒整批执行（用于执行计划），本模块逐步执行并在每个失败点
// 抓取「界面上实际有什么控件」，这是回灌给优化 Agent 最有价值的证据（模型据此知道真实界面长什么样）。
import { execShell, launchArgs, parseNodes, runStepWithTimeout, tailHilog, uiDump } from './hdc.js';

export interface DryRunStep {
  seq: number;
  desc: string;
  status: 'passed' | 'failed' | 'skipped';
  log: string;
  durationMs: number;
  /** 失败时刻界面的真实可见控件文本 —— 回灌修复的关键证据 */
  visibleControls?: string[];
  /** 失败时刻设备最近日志 —— 日志类断言失败时的关键证据 */
  hilogTail?: string[];
}

export interface DryRunResult {
  passed: boolean;
  steps: DryRunStep[];
  logs: string[];
  /** 结构化失败摘要，可直接作为 LLM 的修复输入；通过时为空串 */
  failureBrief: string;
  firstFailureAt?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 抓取当前界面可见控件文本（失败诊断用，失败不影响主流程）。 */
async function visibleTexts(serial: string, limit = 25): Promise<string[]> {
  try {
    const nodes = parseNodes(await uiDump(serial));
    const texts = nodes.map((n) => (n.text || n.desc || '').trim()).filter(Boolean);
    return [...new Set(texts)].slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 是否需要在失败点抓 hilog。
 * 断言/验证类步骤的失败原因可能根本不在界面上（回调没打印日志、日志关键字写错），
 * 只给控件清单会让模型误以为是控件不存在，从而把正确的日志断言改坏。
 */
function needsHilogEvidence(desc: string): boolean {
  const d = desc.trim();
  return /^(验证|检查|断言|校验|确认)/.test(d) || /日志|hilog|\blog\b/i.test(d);
}

/** 生成供 LLM 消费的失败简报：失败步骤 + 当时的真实界面控件清单 + 相关日志。 */
function buildFailureBrief(caseNo: string, caseName: string, steps: DryRunStep[]): string {
  const failed = steps.filter((s) => s.status === 'failed');
  if (failed.length === 0) return '';
  const lines = failed.map((s) => {
    const vis = s.visibleControls?.length ? s.visibleControls.join('、') : '（控件清单抓取失败）';
    const head = `- 第 ${s.seq} 步「${s.desc}」失败：${s.log}\n  当时界面实际可见控件：${vis}`;
    if (!s.hilogTail?.length) return head;
    return `${head}\n  设备最近日志：\n${s.hilogTail.map((l) => `    ${l}`).join('\n')}`;
  });
  return [
    `用例 ${caseNo}「${caseName}」在设备 dry-run 未通过，${failed.length}/${steps.length} 步失败：`,
    ...lines,
  ].join('\n');
}

/**
 * 在设备上 dry-run 单条用例。
 * 失败后默认继续跑完（一次收集全部失败点），但连续失败达 failStreakStop 步后停止——
 * 此时界面已偏离预期，后续步骤的失败原因不可信，继续跑只是浪费设备时间。
 */
export async function dryRunCase(
  caseNo: string,
  caseName: string,
  steps: string[],
  serial: string,
  opts: {
    launch?: string;                 // 执行前 aa start 的应用（bundle 或 bundle/ability）
    perStepTimeoutMs?: number;
    failStreakStop?: number;
    trace?: { taskId?: number; spanId?: string };   // 链路追踪：逐步写入 agent_events
  } = {},
): Promise<DryRunResult> {
  const perStep = opts.perStepTimeoutMs ?? 15000;
  const stopAfter = Math.max(1, opts.failStreakStop ?? 2);
  const logs: string[] = [`[dry-run] 设备 ${serial} 开始执行 ${caseNo}（${steps.length} 步）`];
  const out: DryRunStep[] = [];
  let passed = true;
  let streak = 0;

  if (opts.launch) {
    try {
      const r = await execShell(serial, launchArgs(opts.launch));
      logs.push(`[dry-run] 启动应用 ${opts.launch}：${r}`);
      await sleep(2000);
    } catch (e) {
      logs.push(`[dry-run] 启动应用失败（继续尝试步骤）：${(e as Error).message}`);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const desc = steps[i] ?? `步骤 ${i + 1}`;
    if (streak >= stopAfter) {
      out.push({ seq: i + 1, desc, status: 'skipped', log: '前序连续失败，界面已偏离，跳过', durationMs: 0 });
      continue;
    }
    const r = await runStepWithTimeout(serial, desc, perStep);
    // 全链 traceId：dry-run 每步一条事件（kind=dry_run_step），与任务/span 关联
    if (opts.trace) {
      void import('./events.js').then(({ appendEvent }) =>
        appendEvent({
          taskId: opts.trace?.taskId ?? null,
          spanId: opts.trace?.spanId ?? '',
          kind: 'dry_run_step',
          status: r.ok ? 'ok' : 'error',
          detail: `${caseNo} · 步骤${i + 1}「${desc}」→ ${r.ok ? '通过' : `失败：${r.log}`}`.slice(0, 500),
        }),
      );
    }
    if (r.ok) {
      streak = 0;
      out.push({ seq: i + 1, desc, status: 'passed', log: r.log, durationMs: r.durationMs });
      logs.push(`[${String(i + 1).padStart(2, '0')}] ${desc} → 通过：${r.log}`);
    } else {
      passed = false;
      streak++;
      const visible = await visibleTexts(serial);
      out.push({ seq: i + 1, desc, status: 'failed', log: r.log, durationMs: r.durationMs, visibleControls: visible });
      logs.push(`[${String(i + 1).padStart(2, '0')}] ${desc} → 失败：${r.log}；界面可见控件 ${visible.length} 个`);
    }
  }

  const first = out.find((s) => s.status === 'failed')?.seq;
  logs.push(`[dry-run] ${caseNo} 执行结束：${passed ? '全部通过' : `存在失败步骤（首个失败于第 ${first} 步）`}`);
  return {
    passed,
    steps: out,
    logs,
    failureBrief: passed ? '' : buildFailureBrief(caseNo, caseName, out),
    ...(first ? { firstFailureAt: first } : {}),
  };
}

/** 汇总多条用例的 dry-run 结果，产出一次性回灌给 LLM 的修复简报。 */
export function mergeFailureBriefs(results: Array<{ caseNo: string; name: string; brief: string }>): string {
  const valid = results.filter((r) => r.brief);
  if (valid.length === 0) return '';
  return [
    `以下用例已在模拟器/真机 dry-run，未通过。请依据每条失败步骤给出的【当时界面实际可见控件】重写步骤，`,
    `禁止引用界面上不存在的控件；无法从可见控件推断出等价操作时，删除该步骤而不是臆造。`,
    '',
    ...valid.map((r) => r.brief),
  ].join('\n');
}
