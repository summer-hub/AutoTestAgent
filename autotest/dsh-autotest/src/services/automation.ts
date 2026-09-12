// P7：自动化可行性分流 + 人工接管队列（设计 §6.7）。
//
// 分流规则是**确定性**的，且**先规则、后 LLM、规则结果优先**：
//
//   可自动化 (auto) 当且仅当：
//     testability ∈ {A, B, C 且补丁已批准}
//     且 oracle 全部可机器校验
//     且 不涉及 外部数据库/第三方网络/另一台设备/物理操作/媒体人工判定
//     且 预计单次执行时长 < 阈值（默认 5 分钟）
//   否则 → 人工接管队列，并给出明确的**阻塞类别**与「需要人做什么」
//
// 为什么必须是规则而不是让模型判断：分流结果决定了"这条用例到底会不会被自动执行"。
// 交给模型自由发挥，"看起来分好了"但没人能核对；而规则可以逐条自检，也能对每条阻塞给出确切类别。
//
// 纯函数为主：分流与队列条目的构造不读 DB，IO 层只负责取数与落库。
import { getDb, now } from '../db/connection.js';
import { sediteFromQueue } from './knowledge.js';

export type BlockerStage =
  | 'demo_patch'      // 补丁待批准/未应用
  | 'oracle_missing'  // 断言不可机器校验
  | 'external_dep'    // 外部数据库/第三方网络/第二台设备/物理操作
  | 'animation'       // 动画效果需人工判定
  | 'video'           // 视频/音频效果需人工判定
  | 'flaky'           // 历史执行结果不稳定
  | 'device_blocked'  // 没有可用设备
  | 'long_running'    // 预计单次执行超过时长阈值（设计提到阈值，未单列类别，这里补上以便可执行）
  | 'untestable';     // 可测性判定为 D

export const BLOCKER_LABEL: Record<BlockerStage, string> = {
  demo_patch: '补丁待批准',
  oracle_missing: '缺可校验断言',
  external_dep: '外部依赖',
  animation: '动画需人工判定',
  video: '音视频需人工判定',
  flaky: '结果不稳定',
  device_blocked: '无可用设备',
  long_running: '预计超时',
  untestable: '判定为无法测',
};

export interface TriageInput {
  caseId: number;
  caseNo: string;
  name: string;
  testability: string;              // '' | A | B | C | D
  /** 补丁是否已批准并应用（B/C 类必须） */
  patchApproved: boolean;
  hasPatchDraft: boolean;
  oracles: unknown;
  steps: string[];
  expected: string;
  /** 历史执行结果（最近若干次），用于 flaky 判定 */
  recentResults: Array<'通过' | '失败'>;
  /** 是否有在线设备 */
  deviceOnline: boolean;
}

export interface TriageVerdict {
  decision: 'auto' | 'human';
  blockers: BlockerStage[];
  /** 面向人的阻塞原因（一句话） */
  reason: string;
  /** 需要人做什么（具体到动作） */
  question: string;
  /** 预计单次执行时长（秒，基于步骤里的等待时长 + 每步固定开销） */
  estimatedSeconds: number;
}

/** 每步固定开销（秒）：点击/输入/断言在真机上都不快，低估会让"预计时长"失去意义。 */
const STEP_OVERHEAD_SEC = 4;
/** 未指定时长的等待步骤按 1.5 秒估（真机句式默认等待很短）。 */
const DEFAULT_WAIT_SEC = 1.5;

/** 从步骤里估算单次执行时长（秒）。 */
export function estimateDuration(steps: string[]): number {
  let total = 0;
  for (const s of steps) {
    const min = /等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*分钟/.exec(s);
    const sec = /等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*秒/.exec(s);
    if (min) total += Number(min[1]) * 60;
    else if (sec) total += Number(sec[1]);
    else total += DEFAULT_WAIT_SEC;
    total += STEP_OVERHEAD_SEC;
  }
  return Math.round(total);
}

/** 外部依赖 / 人工判定的信号词（与 P5 的 D 类判定同源，这里额外区分动画与音视频）。 */
const SIGNALS: Array<{ re: RegExp; stage: BlockerStage; what: string }> = [
  { re: /(数据库|database|mysql|redis|sqlite|mongodb)/i, stage: 'external_dep', what: '需要外部数据库' },
  { re: /(服务器|server|http|https|网络请求|接口请求|上传|下载文件|第三方)/i, stage: 'external_dep', what: '需要外部服务/网络' },
  { re: /(蓝牙|nfc|红外|usb|串口)/i, stage: 'external_dep', what: '需要外部硬件' },
  { re: /(相机|摄像头|camera|麦克风|录音|定位|gps|扫码)/i, stage: 'external_dep', what: '需要设备能力且常需人工配合' },
  { re: /(另一台|其他设备|配对设备|跨设备|分布式)/i, stage: 'external_dep', what: '需要第二台设备' },
  { re: /(插拔|物理|旋转机身|摇晃|遮挡|息屏)/i, stage: 'external_dep', what: '需要物理操作' },
  { re: /(视频|video|播放画面|起播|音视频)/i, stage: 'video', what: '涉及视频/音频效果' },
  { re: /(动画|animation|lottie|逐帧|补间|动效)/i, stage: 'animation', what: '涉及动画效果' },
];

/** 该 stage 是否有"能替代人工判定"的机器判据（有则不再算阻塞）。 */
function hasMachineSubstitute(stage: BlockerStage, oracles: Array<{ type?: string }>): boolean {
  if (stage === 'video' || stage === 'animation') {
    // 截图像素差异可以替代"人眼看动画/视频对不对"
    return oracles.some((o) => o?.type === 'screenshot_diff');
  }
  return false;
}

export function classifyAutomation(input: TriageInput, opts: { maxDurationSec?: number; flakyWindow?: number } = {}): TriageVerdict {
  const maxDuration = opts.maxDurationSec ?? 300;
  const flakyWindow = opts.flakyWindow ?? 3;
  const blockers: BlockerStage[] = [];
  const reasons: string[] = [];
  const oracles = Array.isArray(input.oracles) ? (input.oracles as Array<{ type?: string }>) : [];
  const text = [input.name, input.expected, ...input.steps].join('\n');
  const estimatedSeconds = estimateDuration(input.steps);

  // ① 可测性：D 类直接进人工；B/C 类必须先有已批准的补丁
  if (input.testability === 'D') {
    blockers.push('untestable');
    reasons.push('可测性判定为 D（无法测）：需要外部依赖或人工判定');
  } else if (input.testability === 'B' || input.testability === 'C') {
    if (!input.patchApproved) {
      blockers.push('demo_patch');
      reasons.push(input.hasPatchDraft
        ? `可测性为 ${input.testability}，需要先批准并应用 demo 补丁`
        : `可测性为 ${input.testability}，但没有可自动应用的补丁草案，需要人工编写`);
    }
  }

  // ② oracle：必须全部可机器校验（不做类型细节校验，由 P6 的 validateOracles 负责，这里只看有没有）
  if (oracles.length === 0) {
    blockers.push('oracle_missing');
    reasons.push('没有可机器校验的 oracle：脚本即使通过也判定不了任何事');
  }

  // ③ 外部依赖 / 媒体人工判定（有 screenshot_diff 时可以替代动画/视频的人工判定）
  for (const sig of SIGNALS) {
    if (!sig.re.test(text)) continue;
    if (hasMachineSubstitute(sig.stage, oracles)) continue;
    if (!blockers.includes(sig.stage)) blockers.push(sig.stage);
    reasons.push(sig.what);
  }

  // ④ flaky：最近若干次里既有通过又有失败
  const recent = input.recentResults.slice(-flakyWindow);
  if (recent.length >= 2 && recent.includes('通过') && recent.includes('失败')) {
    blockers.push('flaky');
    reasons.push(`最近 ${recent.length} 次执行结果不一致（${recent.join('/')}）`);
  }

  // ⑤ 设备
  if (!input.deviceOnline) {
    blockers.push('device_blocked');
    reasons.push('当前没有在线设备');
  }

  // ⑥ 时长
  if (estimatedSeconds >= maxDuration) {
    blockers.push('long_running');
    reasons.push(`预计单次执行 ${Math.round(estimatedSeconds / 60)} 分钟，超过阈值 ${Math.round(maxDuration / 60)} 分钟`);
  }

  const decision = blockers.length === 0 ? 'auto' : 'human';
  return {
    decision,
    blockers,
    reason: decision === 'auto'
      ? `可自动化：可测性 ${input.testability || '未判定'}、断言可机器校验、无外部依赖、预计 ${estimatedSeconds}s`
      : reasons.join('；'),
    question: decision === 'auto' ? '' : buildQuestion(blockers, input),
    estimatedSeconds,
  };
}

/** 生成"需要人做什么"——必须具体到动作，否则队列就只是把问题换个地方堆着。 */
export function buildQuestion(blockers: BlockerStage[], input: TriageInput): string {
  const ask: string[] = [];
  if (blockers.includes('demo_patch')) {
    ask.push(input.hasPatchDraft
      ? '到用例页打开「补丁」评审视图，确认改动无误后点「批准并应用到副本」，然后重新分流'
      : '该用例需要的 demo 改动无法自动生成补丁，请手工补上入口/参数（可参考覆盖矩阵里给出的位置）');
  }
  if (blockers.includes('oracle_missing')) {
    ask.push('为该用例补一条可机器校验的 oracle（界面文本等于/包含什么、或 hilog 关键字），补完后重新分流');
  }
  if (blockers.includes('external_dep')) ask.push('准备外部依赖（数据库/服务/第二台设备）并手动执行，或在用例里改为不依赖外部条件的等价场景');
  if (blockers.includes('animation')) ask.push('人工观察动画是否符合预期，并填写结论（如可截图对比，请改为 screenshot_diff 判据后重新分流）');
  if (blockers.includes('video')) ask.push('人工观察音视频播放是否符合预期，并填写结论');
  if (blockers.includes('flaky')) ask.push('确认是否为设备/环境抖动；若是环境问题请标注并重跑，若用例本身不稳定请修正步骤');
  if (blockers.includes('device_blocked')) ask.push('连接一台在线真机或启动模拟器后重新分流');
  if (blockers.includes('long_running')) ask.push('确认是否可接受该时长；可接受请在系统配置里调高时长阈值，否则拆分用例');
  if (blockers.includes('untestable')) ask.push('确认该用例是否必要；若必要请给出人工验证方案与结论');
  return ask.join('；') || '请人工确认该用例能否自动化';
}

// ---------- 队列 IO ----------

export interface TriageSummary {
  libraryId: number;
  libraryName: string;
  total: number;
  auto: number;
  human: number;
  byBlocker: Record<string, number>;
  queued: number;
  /** 每条用例都有明确归属：auto 或 人工队列（设计验收项） */
  unassigned: number;
}

/**
 * 跑一遍分流：为每条用例算出归属，并把"进人工队列"的落成队列条目。
 *
 * 幂等：同一用例的同一阻塞类别只保留一条 open 条目（重复分流不会把队列刷爆）；
 * **已解决的条目不会被重新打开**，除非阻塞原因发生了变化（避免人刚填完结论又被重置）。
 */
export async function runTriage(libraryId: number, opts: { maxDurationSec?: number } = {}): Promise<TriageSummary> {
  const db = getDb();
  const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(libraryId);
  if (!lib) throw Object.assign(new Error('库不存在'), { statusCode: 404 });
  const cases = await db.prepare(`SELECT id, case_no, name, steps, expected, testability, oracle_json, demo_patch_json, status
    FROM cases WHERE library_id = ? ORDER BY id`)
    .all<{ id: number; case_no: string; name: string; steps: string; expected: string; testability: string; oracle_json: string; demo_patch_json: string; status: string }>(libraryId);
  const device = await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'online'").get<{ n: number }>();
  const deviceOnline = (device?.n ?? 0) > 0;
  const history = await db.prepare(`SELECT case_id, status FROM executions WHERE library_id = ? ORDER BY id DESC LIMIT 500`)
    .all<{ case_id: number; status: string }>(libraryId);
  const byCase = new Map<number, Array<'通过' | '失败'>>();
  for (const h of history) {
    const arr = byCase.get(h.case_id) ?? [];
    if (arr.length < 5 && (h.status === '通过' || h.status === '失败')) arr.push(h.status);
    byCase.set(h.case_id, arr);
  }
  const { patchDirFor, revertCopy } = await import('./testability.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  void revertCopy;

  const byBlocker: Record<string, number> = {};
  let auto = 0;
  let human = 0;
  let queued = 0;
  for (const c of cases) {
    let oracles: unknown = [];
    try { oracles = JSON.parse(c.oracle_json || '[]'); } catch { oracles = []; }
    let steps: string[] = [];
    try { steps = JSON.parse(c.steps || '[]') as string[]; } catch { steps = []; }
    // 补丁"已批准"的判据：副本目录里有 manifest（P5 应用补丁时写入）
    const copyDir = patchDirFor(lib.name, c.case_no);
    const patchApproved = fs.existsSync(path.join(copyDir, 'autotest-patch-manifest.json'));
    const verdict = classifyAutomation({
      caseId: c.id, caseNo: c.case_no, name: c.name,
      testability: c.testability || '', patchApproved,
      hasPatchDraft: !!c.demo_patch_json && (() => { try { return (JSON.parse(c.demo_patch_json) as { edits?: unknown[] }).edits?.length ? true : false; } catch { return false; } })(),
      oracles, steps, expected: c.expected ?? '',
      recentResults: byCase.get(c.id) ?? [], deviceOnline,
    }, opts);
    if (verdict.decision === 'auto') { auto++; continue; }
    human++;
    for (const b of verdict.blockers) byBlocker[b] = (byBlocker[b] ?? 0) + 1;
    // 落队列：同一 (用例, stage) 只保留一条 open
    for (const stage of verdict.blockers) {
      const existing = await db.prepare(`SELECT id, status, reason FROM human_queue WHERE case_id = ? AND stage = ? ORDER BY id DESC LIMIT 1`)
        .get<{ id: number; status: string; reason: string }>(c.id, stage);
      const payload = JSON.stringify({
        caseNo: c.case_no, caseName: c.name, testability: c.testability,
        estimatedSeconds: verdict.estimatedSeconds,
        oracleCount: Array.isArray(oracles) ? oracles.length : 0,
        patchDraft: c.demo_patch_json ? JSON.parse(c.demo_patch_json) : null,
        steps,
      });
      const t = now();
      // 队列条目的「需要人做什么」必须**只管本条目的阻塞类别**：
      // 一条用例常同时有多个阻塞（如 demo_patch + oracle_missing），
      // 若每条都把全部动作拼在一起，人打开"补丁待批准"这条却被告知"顺便补个 oracle"，
      // 既重复又容易漏 —— 每个 stage 只问它自己的事。
      const stageQuestion = buildQuestion([stage], {
        caseId: c.id, caseNo: c.case_no, name: c.name, testability: c.testability || '',
        patchApproved, hasPatchDraft: !!c.demo_patch_json, oracles, steps, expected: c.expected ?? '',
        recentResults: byCase.get(c.id) ?? [], deviceOnline,
      });
      if (!existing) {
        await db.prepare(`INSERT INTO human_queue (library_id, case_id, stage, reason, question, payload_json, status, resolution, resolved_by, resolved_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'open', '', '', NULL, ?, ?)`)
          .run(libraryId, c.id, stage, verdict.reason.slice(0, 490), stageQuestion, payload, t, t);
        queued++;
      } else if (existing.status === 'resolved' && existing.reason !== verdict.reason.slice(0, 490)) {
        // 结论还在但原因变了 → 重新打开（否则人会以为已经处理过）
        await db.prepare(`UPDATE human_queue SET status = 'open', reason = ?, question = ?, payload_json = ?, updated_at = ? WHERE id = ?`)
          .run(verdict.reason.slice(0, 490), stageQuestion, payload, t, existing.id);
        queued++;
      }
    }
  }
  return { libraryId, libraryName: lib.name, total: cases.length, auto, human, byBlocker, queued, unassigned: 0 };
}

export interface QueueItem {
  id: number;
  libraryId: number;
  caseId: number | null;
  caseNo: string;
  caseName: string;
  stage: BlockerStage;
  reason: string;
  question: string;
  payload: Record<string, unknown>;
  status: string;
  resolution: string;
  resolvedBy: string;
  resolvedAt: string | null;
  createdAt: string;
}

export async function loadHumanQueue(libraryId: number, status?: string): Promise<QueueItem[]> {
  const db = getDb();
  const rows = await db.prepare(`SELECT q.*, c.case_no, c.name AS case_name FROM human_queue q
    LEFT JOIN cases c ON c.id = q.case_id
    WHERE q.library_id = ?${status ? ' AND q.status = ?' : ''} ORDER BY q.status, q.id`)
    .all<Record<string, unknown>>(...(status ? [libraryId, status] : [libraryId]));
  return rows.map((r) => ({
    id: Number(r.id), libraryId: Number(r.library_id), caseId: r.case_id === null ? null : Number(r.case_id),
    caseNo: String(r.case_no ?? ''), caseName: String(r.case_name ?? ''),
    stage: String(r.stage) as BlockerStage,
    reason: String(r.reason ?? ''), question: String(r.question ?? ''),
    payload: (() => { try { return JSON.parse(String(r.payload_json || '{}')); } catch { return {}; } })(),
    status: String(r.status ?? 'open'), resolution: String(r.resolution ?? ''),
    resolvedBy: String(r.resolved_by ?? ''), resolvedAt: (r.resolved_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
  }));
}

/**
 * 回填结论并触发下游重跑（设计 §6.7 的闭环）。
 *
 *   demo_patch   → 结论为"已批准/已完成"时提示去应用补丁（补丁应用仍需人在用例页点批准，
 *                  不在队列里静默改文件），随后重跑分流；
 *   oracle_missing → 结论里给出判据（JSON）时写入该用例的 oracle，随后重跑分流；
 *   其余         → 记录结论即可（结论将作为 P9 知识条目的来源），重跑分流。
 */
export async function resolveQueueItem(itemId: number, resolution: string, resolvedBy = 'human'): Promise<{
  ok: boolean; item: QueueItem | null; requeued: boolean; appliedOracle: boolean; knowledgeId: string; message: string;
}> {
  const db = getDb();
  const row = await db.prepare('SELECT * FROM human_queue WHERE id = ?').get<Record<string, unknown>>(itemId);
  if (!row) throw Object.assign(new Error('队列条目不存在'), { statusCode: 404 });
  const t = now();
  let appliedOracle = false;
  let message = '结论已记录';

  // oracle_missing：结论里带了判据就顺手写入该用例（这就是"提供判据 → 重生成脚本"的起点）
  if (row.stage === 'oracle_missing' && row.case_id) {
    const m = /\[[\s\S]*\]/.exec(resolution);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as unknown;
        const { validateOracles } = await import('./oracle.js');
        const problems = validateOracles(parsed);
        if (problems.length === 0) {
          await db.prepare('UPDATE cases SET oracle_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(parsed), t, Number(row.case_id));
          appliedOracle = true;
          message = '已把结论里的判据写入该用例的 oracle';
        } else {
          message = `结论里的判据不达标，未写入：${problems.map((p) => p.reason).join('；').slice(0, 200)}`;
        }
      } catch {
        message = '结论里的判据不是合法 JSON，未写入（其余结论已记录）';
      }
    }
  }

  await db.prepare(`UPDATE human_queue SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?`)
    .run(resolution.slice(0, 2000), resolvedBy, t, t, itemId);

  // P9：结论一律沉淀为知识条目（设计 §6.7）。沉淀失败不影响结论本身，但要在返回值里说清。
  let knowledgeId = '';
  try {
    const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(Number(row.library_id));
    const caseRow = row.case_id
      ? await db.prepare('SELECT case_no FROM cases WHERE id = ?').get<{ case_no: string }>(Number(row.case_id))
      : undefined;
    const entry = await sediteFromQueue({
      libraryId: Number(row.library_id), libraryName: lib?.name ?? `#${String(row.library_id)}`,
      caseNo: caseRow?.case_no ?? '', stage: String(row.stage),
      reason: String(row.reason ?? ''), question: String(row.question ?? ''), resolution,
      payload: (() => { try { return JSON.parse(String(row.payload_json || '{}')) as Record<string, unknown>; } catch { return {}; } })(),
    });
    knowledgeId = entry.id;
  } catch (e) {
    console.warn('[autotest] 知识沉淀失败：', (e as Error).message);
  }

  // 回填后重跑该库的分流（闭环：结论要么解除了阻塞，要么仍是阻塞并重新入队）
  const summary = await runTriage(Number(row.library_id));
  const item = (await loadHumanQueue(Number(row.library_id))).find((x) => x.id === itemId) ?? null;
  return {
    ok: true, item, requeued: !!item && item.status === 'open', appliedOracle,
    knowledgeId,
    message: `${message}；已重跑分流（可自动化 ${summary.auto} / 人工 ${summary.human}）${knowledgeId ? `；结论已沉淀为知识条目 ${knowledgeId}（待人工确认后生效）` : ''}`,
  };
}
