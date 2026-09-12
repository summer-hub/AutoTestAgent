// P8：用例 ↔ 脚本映射与版本联动。
//
// 这是需求里明确的一条：**手工用例更新后，要能提示对应自动化脚本可能过期**。
// 只靠"生成过一次"是不够的 —— 用例改了三版，脚本还是按第一版写的，跑出来的结论没有意义。
//
// 四种状态（设计 §6.8）：
//   fresh  脚本与当前用例版本一致，且脚本内容没被人工改过
//   stale  用例已升版（bindings.case_version < cases.current_version）→ 提示「可能过期」
//   manual 脚本内容与库中记录不一致（人为改过）→ **不自动覆盖**
//   broken 脚本文件丢失或已无断言 → 需要重新生成
//
// 纯函数（状态判定）+ 少量 IO（落库、哈希、执行结果回写）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { hypiumCaseScriptPath, hypiumProjectDir, writeCaseScript, NoAssertionError, UnmappedStepError, scriptHasAssertion } from './hypiumGen.js';

export type BindingStatus = 'fresh' | 'stale' | 'manual' | 'broken';

export const BINDING_LABEL: Record<BindingStatus, string> = {
  fresh: '最新',
  stale: '可能过期',
  manual: '人工改过',
  broken: '需重新生成',
};

export const BINDING_COLOR: Record<BindingStatus, string> = {
  fresh: 'green', stale: 'amber', manual: 'blue', broken: 'red',
};

/** 脚本内容哈希（判断"人为改过"）。 */
export function hashScript(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 状态判定（纯函数，可离线单测）。
 *
 * 优先级是刻意的：**文件丢了/没断言 > 人工改过 > 用例升版 > 最新**。
 * 把 manual 排在 stale 之前，是因为"人为改过"意味着脚本已经不是生成的产物了，
 * 这时候提示"可能过期"会误导人直接点重新生成、把手改的内容覆盖掉。
 */
export function computeBindingStatus(input: {
  caseVersion: number;
  boundVersion: number;
  fileExists: boolean;
  hasAssertion: boolean;
  currentHash: string;
  boundHash: string;
  confirmedVersion?: number | null;
}): { status: BindingStatus; reason: string } {
  if (!input.fileExists) {
    return { status: 'broken', reason: '脚本文件不存在（可能被删除或工程被清理），需要重新生成' };
  }
  if (!input.hasAssertion) {
    return { status: 'broken', reason: '脚本里没有任何断言：跑通了也说明不了任何事，需要重新生成' };
  }
  if (input.boundHash && input.currentHash !== input.boundHash) {
    // 人工确认过的版本不再提示过期；但脚本被改过仍要标出来（不自动覆盖）
    return { status: 'manual', reason: '脚本内容与生成的版本不一致（人为改过）：不会自动覆盖，如需重新生成请先确认' };
  }
  if (input.confirmedVersion === input.caseVersion) {
    return { status: 'fresh', reason: `人工已确认脚本与用例 V${input.caseVersion} 对应` };
  }
  if (input.boundVersion < input.caseVersion) {
    return {
      status: 'stale',
      reason: `用例已更新到 V${input.caseVersion}，脚本基于 V${input.boundVersion}：请判断是否重新生成`,
    };
  }
  return { status: 'fresh', reason: `脚本与用例 V${input.caseVersion} 一致` };
}

export interface BindingRow {
  caseId: number;
  caseNo: string;
  caseName: string;
  caseVersion: number;
  libraryId: number;
  libraryName: string;
  scriptPath: string;
  scriptHash: string;
  moduleStem: string;
  status: BindingStatus;
  statusReason: string;
  lastRunStatus: string;
  lastRunAt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  fileExists: boolean;
}

/** 读出某库全部绑定并**在每个条目上重新判定状态**（状态是算出来的，不是存在库里的快照）。 */
export async function listBindings(libraryId: number): Promise<BindingRow[]> {
  const db = getDb();
  const rows = await db.prepare(`SELECT b.*, c.case_no, c.name AS case_name, c.current_version, l.name AS library_name
    FROM case_script_bindings b
    JOIN cases c ON c.id = b.case_id
    JOIN libraries l ON l.id = c.library_id
    WHERE c.library_id = ? ORDER BY b.status, c.id`).all<Record<string, unknown>>(libraryId);
  return Promise.all(rows.map((r) => judge(r)));
}

async function judge(r: Record<string, unknown>): Promise<BindingRow> {
  const scriptPath = String(r.script_path ?? '');
  const fileExists = !!scriptPath && fs.existsSync(scriptPath);
  const content = fileExists ? fs.readFileSync(scriptPath, 'utf8') : '';
  const confirmedAt = (r.confirmed_at as string | null) ?? null;
  const { status, reason } = computeBindingStatus({
    caseVersion: Number(r.current_version ?? 1),
    boundVersion: Number(r.case_version ?? 1),
    fileExists,
    hasAssertion: fileExists ? scriptHasAssertion(content) : false,
    currentHash: fileExists ? hashScript(content) : '',
    boundHash: String(r.script_hash ?? ''),
    confirmedVersion: confirmedAt ? Number(r.current_version ?? 1) : null,
  });
  return {
    caseId: Number(r.case_id), caseNo: String(r.case_no ?? ''), caseName: String(r.case_name ?? ''),
    caseVersion: Number(r.current_version ?? 1), libraryId: Number(r.library_id), libraryName: String(r.library_name ?? ''),
    scriptPath, scriptHash: String(r.script_hash ?? ''), moduleStem: String(r.module_stem ?? ''),
    status, statusReason: reason,
    lastRunStatus: String(r.last_run_status ?? ''), lastRunAt: (r.last_run_at as string | null) ?? null,
    confirmedAt, updatedAt: String(r.updated_at ?? ''), fileExists,
  };
}

/** 全库重算状态并落库（前端列表直接读 status 列时可省一次计算；判定逻辑仍以 judge 为准）。 */
export async function refreshBindingStatuses(libraryId: number): Promise<{ total: number; byStatus: Record<string, number> }> {
  const db = getDb();
  const rows = await listBindings(libraryId);
  const byStatus: Record<string, number> = {};
  const t = now();
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    await db.prepare('UPDATE case_script_bindings SET status = ?, updated_at = ? WHERE case_id = ?').run(r.status, t, r.caseId);
  }
  return { total: rows.length, byStatus };
}

export interface BindResult {
  ok: boolean;
  binding?: BindingRow;
  reason?: string;
  unmappedStep?: { index: number; step: string };
}

/**
 * 生成（或重新生成）脚本并写入绑定。
 *
 * 三种失败都必须**明确回报而不是留一个旧绑定**：
 *   - 步骤无法映射 → UnmappedStepError（不再产出注释行）
 *   - 脚本无断言 → NoAssertionError（拒绝绑定）
 *   - 用例没人手脚本工程 → 由 writeCaseScript 抛错
 */
export async function bindCaseScript(caseId: number, opts: { force?: boolean } = {}): Promise<BindResult> {
  const db = getDb();
  const c = await db.prepare(`SELECT c.id, c.case_no, c.name, c.steps, c.current_version, c.oracle_json,
      l.id AS library_id, l.name AS library_name, l.package_name
    FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`)
    .get<{ id: number; case_no: string; name: string; steps: string; current_version: number; oracle_json: string; library_id: number; library_name: string; package_name: string }>(caseId);
  if (!c) throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
  let steps: string[] = [];
  try { steps = JSON.parse(c.steps || '[]') as string[]; } catch { steps = []; }
  let oracles: Array<Record<string, unknown>> = [];
  try { oracles = JSON.parse(c.oracle_json || '[]') as Array<Record<string, unknown>>; } catch { oracles = []; }

  // 人工改过的脚本默认不覆盖（设计明确要求）
  const existing = await db.prepare('SELECT * FROM case_script_bindings WHERE case_id = ?').get<Record<string, unknown>>(caseId);
  if (existing) {
    const cur = await judge({ ...existing, case_no: c.case_no, case_name: c.name, current_version: c.current_version, library_name: c.library_name, library_id: c.library_id });
    if (cur.status === 'manual' && !opts.force) {
      return { ok: false, binding: cur, reason: `${cur.statusReason}（如需覆盖请显式确认 force）` };
    }
  }

  const lib = { name: c.library_name, packageName: c.package_name || c.library_name };
  let scriptPath = '';
  try {
    scriptPath = writeCaseScript(lib, { caseNo: c.case_no, name: c.name, steps, oracles });
  } catch (e) {
    if (e instanceof UnmappedStepError) return { ok: false, reason: e.message, unmappedStep: { index: e.stepIndex, step: e.step } };
    if (e instanceof NoAssertionError) return { ok: false, reason: e.message };
    throw e;
  }
  const content = fs.readFileSync(scriptPath, 'utf8');
  const hash = hashScript(content);
  const moduleStem = path.basename(scriptPath).replace(/\.py$/, '');
  const t = now();
  if (existing) {
    await db.prepare(`UPDATE case_script_bindings SET case_version = ?, script_path = ?, script_hash = ?, module_stem = ?, status = 'fresh', confirmed_at = NULL, updated_at = ? WHERE case_id = ?`)
      .run(c.current_version, scriptPath, hash, moduleStem, t, caseId);
  } else {
    await db.prepare(`INSERT INTO case_script_bindings (case_id, case_version, script_path, script_hash, module_stem, status, last_run_status, last_run_at, confirmed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'fresh', '', NULL, NULL, ?, ?)`)
      .run(caseId, c.current_version, scriptPath, hash, moduleStem, t, t);
  }
  await db.prepare("UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?").run(t, caseId);
  const rows = await db.prepare(`SELECT b.*, c.case_no, c.name AS case_name, c.current_version, l.name AS library_name
    FROM case_script_bindings b JOIN cases c ON c.id = b.case_id JOIN libraries l ON l.id = c.library_id
    WHERE b.case_id = ?`).get<Record<string, unknown>>(caseId);
  return { ok: true, binding: rows ? await judge(rows) : undefined };
}

/** 三个动作之一：保留脚本并标记已确认（之后不再提示过期，直到用例再次升版）。 */
export async function confirmBinding(caseId: number): Promise<{ ok: boolean; binding?: BindingRow }> {
  const db = getDb();
  const t = now();
  const r = await db.prepare('UPDATE case_script_bindings SET confirmed_at = ?, updated_at = ? WHERE case_id = ?').run(t, t, caseId);
  if (!r.changes) throw Object.assign(new Error('该用例没有脚本绑定'), { statusCode: 404 });
  const row = await db.prepare(`SELECT b.*, c.case_no, c.name AS case_name, c.current_version, l.name AS library_name
    FROM case_script_bindings b JOIN cases c ON c.id = b.case_id JOIN libraries l ON l.id = c.library_id
    WHERE b.case_id = ?`).get<Record<string, unknown>>(caseId);
  return { ok: true, binding: row ? await judge(row) : undefined };
}

/** 三个动作之三：解除绑定（删除绑定记录与脚本文件）。 */
export async function unbindCaseScript(caseId: number, opts: { removeFile?: boolean } = {}): Promise<{ ok: boolean; removedFile: string }> {
  const db = getDb();
  const row = await db.prepare('SELECT script_path FROM case_script_bindings WHERE case_id = ?').get<{ script_path: string }>(caseId);
  if (!row) throw Object.assign(new Error('该用例没有脚本绑定'), { statusCode: 404 });
  let removedFile = '';
  if (opts.removeFile !== false && row.script_path && fs.existsSync(row.script_path)) {
    fs.rmSync(row.script_path, { force: true });
    removedFile = row.script_path;
  }
  const t = now();
  await db.prepare('DELETE FROM case_script_bindings WHERE case_id = ?').run(caseId);
  await db.prepare("UPDATE cases SET script_status = '未绑定', updated_at = ? WHERE id = ?").run(t, caseId);
  return { ok: true, removedFile };
}

/** 执行结果回写（用于 flaky 识别与"脚本到底跑没跑过"）。 */
export async function recordScriptRun(caseId: number, status: string): Promise<void> {
  const db = getDb();
  const t = now();
  await db.prepare('UPDATE case_script_bindings SET last_run_status = ?, last_run_at = ?, updated_at = ? WHERE case_id = ?')
    .run(status.slice(0, 16), t, t, caseId);
}

/**
 * 用例升版时联动：把该用例绑定标为 stale（若脚本没被人工改过）。
 * 由用例更新路径调用，保证"用例改了 → 脚本立刻被标可能过期"。
 */
export async function markBindingStaleOnCaseBump(caseId: number, newVersion: number): Promise<void> {
  const db = getDb();
  const row = await db.prepare('SELECT script_path, script_hash FROM case_script_bindings WHERE case_id = ?')
    .get<{ script_path: string; script_hash: string }>(caseId);
  if (!row) return;
  const content = row.script_path && fs.existsSync(row.script_path) ? fs.readFileSync(row.script_path, 'utf8') : '';
  const manual = content && hashScript(content) !== row.script_hash;
  await db.prepare('UPDATE case_script_bindings SET case_version = ?, status = ?, updated_at = ? WHERE case_id = ?')
    .run(newVersion - 1, manual ? 'manual' : 'stale', now(), caseId);
}

/** Hypium 工程里脚本所在目录（前端展示/打开用）。 */
export function scriptDirFor(libName: string): string {
  return path.join(hypiumProjectDir(libName), 'testcases', libName.replace(/[^\w.-]/g, '_'));
}

void hypiumCaseScriptPath;
