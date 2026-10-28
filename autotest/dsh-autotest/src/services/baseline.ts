// B1：测试基线服务（设计：docs/设计-独立版产品化与测试基线追溯.md §6）
//  - 物理层 repo_snapshots：每仓库每 commit 一份只读检出（git worktree --detach，失败退化为只读复制）
//  - 逻辑层 test_baselines：每库引用一个物理快照 + repo_subpath（单体仓同 commit 多库共享一份物理目录）
//  - 不变量：快照 ready 后只读；构建/补丁/场景资源一律写入 runs 运行副本，绝不写基线
//  - 不伪造：无法解析的 commit 直接失败；历史执行不反推基线
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dbMode, getDb, now } from '../db/connection.js';
import {
  normalizeRepoUrl, normalizeSubpath, repoName, repoRootForLib, workspaceDir,
} from './gitRepo.js';
import { getSetting } from './settings.js';

const execFileAsync = promisify(execFile);

export type BaselineSource = 'latest' | 'pr' | 'tag' | 'manual';

export interface LibraryCore {
  id: number;
  name: string;
  repo_url: string;
  repo_subpath: string;
  current_version: string;
  last_commit: string;
}

// ---------- 编号 ----------

async function nextNo(prefix: string, table: string, col: string, floor: number): Promise<string> {
  const db = getDb();
  const date = now().slice(0, 10).replace(/-/g, '');
  const like = `${prefix}-${date}-%`;
  // CAST(SUBSTRING(x AS UNSIGNED))：MySQL 原生；SQLite 由 connection 的方言翻译自动转成 AS INTEGER
  const row = await db.prepare(
    `SELECT MAX(CAST(SUBSTRING(${col}, ${prefix.length + date.length + 3}) AS UNSIGNED)) AS m FROM ${table} WHERE ${col} LIKE ?`,
  ).get<{ m: number | null }>(like);
  const seq = (row?.m ?? floor) + 1;
  return `${prefix}-${date}-${String(seq).padStart(3, '0')}`;
}

export async function nextBaselineNo(): Promise<string> {
  return nextNo('BL', 'test_baselines', 'baseline_no', 0);
}

export async function nextRunNo(): Promise<string> {
  return nextNo('TR', 'test_runs', 'run_no', 0);
}

// ---------- git ----------

async function git(args: string[], cwd: string, timeoutMs = 180000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

/** 基线根目录：<workspace>/baselines。 */
export function baselinesDir(): string {
  const dir = path.join(workspaceDir(), 'baselines');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { try { total += fs.statSync(p).size; } catch { /* 并发删除 */ } }
    }
  };
  walk(dir, 0);
  return total;
}

/** 排除目录（与 testability.makeCopy 的排除清单保持一致语义：构建/依赖产物不进基线体积统计与复制）。 */
const COPY_EXCLUDE = new Set(['.git', 'build', 'node_modules', 'oh_modules', '.hvigor', '.idea', 'dist']);

/** 只读复制退路：worktree 不可用（子模块/网络盘/权限）时使用。 */
function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const walk = (s: string, d: string, depth: number): void => {
    if (depth > 14) return;
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (COPY_EXCLUDE.has(e.name)) continue;
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) walk(sp, dp, depth + 1);
      else if (e.isFile()) fs.copyFileSync(sp, dp);
      // 符号链接不复制（安全：禁止把链接目标带进基线）
    }
  };
  walk(src, dest, 0);
}

// ---------- 物理快照 ----------

export interface SnapshotRow {
  id: number;
  repo_url: string;
  commit_sha: string;
  rel_dir: string;
  version_label: string;
  source: string;
  source_pr_id: number | null;
  status: string;
  size_bytes: number;
  metadata_json: string;
  error: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * 解析基线 commit。latest 取工作克隆 HEAD；tag/manual 用 rev-parse 校验；
 * pr 用 merge_commit_sha（B4 ref:'head' 时优先 head_sha —— PR 预验证通道，
 * merge 缺失退 head 并标注"非合入提交"）。拿不到就抛错 —— 不伪造（设计 §5.4 不变量 7）。
 */
export async function resolveBaselineCommit(
  lib: LibraryCore,
  source: BaselineSource,
  opts: { ref?: string; commitSha?: string; prId?: number } = {},
): Promise<{ commit: string; versionLabel: string; prId: number | null; note: string }> {
  const repoRoot = repoRootForLib(lib);
  if (!lib.repo_url) throw Object.assign(new Error('该库未配置仓库地址（repo_url 为空），无法创建基线。'), { statusCode: 400 });
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw Object.assign(new Error(`本地尚未克隆仓库（${repoRoot}）。请先在库工作区拉取仓库，再创建基线。`), { statusCode: 409 });
  }
  if (source === 'pr') {
    const db = getDb();
    const pr = await db.prepare('SELECT id, number, merge_commit_sha, head_sha, title FROM pull_requests WHERE id = ?')
      .get<{ id: number; number: number; merge_commit_sha: string; head_sha: string; title: string }>(Number(opts.prId));
    if (!pr) throw Object.assign(new Error(`PR #${opts.prId} 不存在（请先同步 PR 或检查 prId）。`), { statusCode: 404 });
    // B4：ref='head' 是显式的预验证通道 —— 即便 merge_commit 存在也优先用 head
    const preferHead = String(opts.ref ?? '') === 'head';
    const commit = ((preferHead ? pr.head_sha : '') || pr.merge_commit_sha || pr.head_sha || '').trim();
    if (!commit) throw Object.assign(new Error(`PR #${pr.number} 既无合入提交也无 head 提交，无法建基线。`), { statusCode: 409 });
    const note = preferHead && pr.merge_commit_sha && commit !== pr.merge_commit_sha
      ? '使用 head 提交（人为选择预验证），非合入提交，不代表已合入主干。'
      : pr.merge_commit_sha ? '' : '非合入提交（merge_commit 缺失），仅用于 head 预验证，不代表已合入主干。';
    return { commit, versionLabel: `pr-${pr.number}`, prId: pr.id, note };
  }
  if (source === 'tag' || source === 'manual') {
    const ref = String(opts.ref ?? opts.commitSha ?? '').trim();
    if (!ref) throw Object.assign(new Error('tag/manual 来源必须提供 ref 或 commitSha。'), { statusCode: 400 });
    const commit = await git(['rev-parse', `${ref}^{commit}`], repoRoot);
    return { commit, versionLabel: source === 'tag' ? ref : `dev-${commit.slice(0, 7)}`, prId: null, note: '' };
  }
  // latest：工作克隆 HEAD
  const commit = await git(['rev-parse', 'HEAD'], repoRoot);
  if (!commit) throw Object.assign(new Error('无法读取仓库 HEAD（git rev-parse 返回为空）。'), { statusCode: 500 });
  return { commit, versionLabel: lib.current_version || `dev-${commit.slice(0, 7)}`, prId: null, note: '' };
}

/**
 * 创建（或复用）物理快照：repo_snapshots 按 (repo_url, commit_sha) 幂等。
 * ready 的快照直接复用；failed 允许重试；creating 拒绝并发重复创建。
 */
export async function ensureSnapshot(
  lib: LibraryCore,
  commit: string,
  meta: { source: BaselineSource; versionLabel: string; prId: number | null; createdBy: string; note?: string },
): Promise<SnapshotRow> {
  const db = getDb();
  const repoUrl = normalizeRepoUrl(lib.repo_url);
  const t = now();
  const existing = await db.prepare('SELECT * FROM repo_snapshots WHERE repo_url = ? AND commit_sha = ?').get<SnapshotRow>(repoUrl, commit);
  if (existing && existing.status === 'ready') return existing;
  if (existing && existing.status === 'creating') {
    throw Object.assign(new Error('该提交的物理快照正在创建中，请稍候再试。'), { statusCode: 409 });
  }

  const repoRoot = repoRootForLib(lib);
  const short = commit.slice(0, 10);
  const relDir = path.join('baselines', repoName(path.basename(repoRoot)), short);
  const absDir = path.join(workspaceDir(), relDir);
  let snapshotId: number;
  if (existing) {
    // failed/archived 重试：清掉半成品目录再来
    fs.rmSync(absDir, { recursive: true, force: true });
    await db.prepare(`UPDATE repo_snapshots SET status='creating', error='', rel_dir=?, updated_at=? WHERE id=?`)
      .run(relDir, t, existing.id);
    snapshotId = existing.id;
  } else {
    const ins = await db.prepare(
      `INSERT INTO repo_snapshots (repo_url, commit_sha, rel_dir, version_label, source, source_pr_id, status, size_bytes, metadata_json, error, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'creating', 0, '{}', '', ?, ?, ?)`,
    ).run(repoUrl, commit, relDir, meta.versionLabel, meta.source, meta.prId, meta.createdBy, t, t);
    snapshotId = Number(ins.lastInsertRowid);
  }

  try {
    // 确认 commit 在本地对象库中存在；不在则先 fetch（不切分支，不影响工作克隆的检出状态）
    let hasCommit = false;
    try { await git(['cat-file', '-e', `${commit}^{commit}`], repoRoot); hasCommit = true; } catch { hasCommit = false; }
    if (!hasCommit) {
      await git(['fetch', 'origin'], repoRoot, 300000);
      await git(['cat-file', '-e', `${commit}^{commit}`], repoRoot);
    }

    fs.mkdirSync(path.dirname(absDir), { recursive: true });
    let method = 'worktree';
    try {
      await git(['worktree', 'add', '--detach', absDir, commit], repoRoot, 300000);
    } catch (e) {
      // worktree 不可用（仓库本身是 worktree / 目标盘不支持 / 路径过长）→ 退化为只读复制
      method = 'copy';
      fs.rmSync(absDir, { recursive: true, force: true });
      // 用临时检出保证复制的文件内容确实来自该 commit，而不是工作克隆当前检出的无关状态
      const tmp = `${absDir}.tmp-${Date.now()}`;
      await git(['worktree', 'add', '--detach', tmp, commit], repoRoot, 300000);
      try { copyTree(tmp, absDir); } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        try { await git(['worktree', 'remove', '--force', tmp], repoRoot); } catch { /* 已删 */ }
      }
      if (e instanceof Error) {
        console.warn(`[baseline] worktree 直建失败，退化为复制（${e.message.slice(0, 120)}）`);
      }
    }

    // 快照标记文件：目录身份自描述（防止目录被挪动后误用）
    fs.writeFileSync(path.join(absDir, '.autotest-baseline.json'), JSON.stringify({
      repoUrl, commit, versionLabel: meta.versionLabel, source: meta.source, prId: meta.prId, snapshotId, createdAt: t,
    }, null, 2), 'utf8');

    const metadata = JSON.stringify({ method, note: meta.note ?? '', createdBy: meta.createdBy, repoRoot });
    const size = dirSizeBytes(absDir);
    await db.prepare(`UPDATE repo_snapshots SET status='ready', size_bytes=?, metadata_json=?, updated_at=? WHERE id=?`)
      .run(size, metadata, now(), snapshotId);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await db.prepare(`UPDATE repo_snapshots SET status='failed', error=?, updated_at=? WHERE id=?`)
      .run(msg.slice(0, 990), now(), snapshotId);
    fs.rmSync(absDir, { recursive: true, force: true });
    throw Object.assign(new Error(`物理快照创建失败：${msg}`), { statusCode: 500 });
  }
  return (await db.prepare('SELECT * FROM repo_snapshots WHERE id = ?').get<SnapshotRow>(snapshotId)) as SnapshotRow;
}

// ---------- 逻辑基线 ----------

export interface BaselineRow {
  id: number;
  baseline_no: string;
  snapshot_id: number;
  library_id: number;
  repo_subpath: string;
  version_label: string;
  source: string;
  status: string;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function loadLibrary(libraryId: number): Promise<LibraryCore> {
  const db = getDb();
  const lib = await db.prepare('SELECT id, name, repo_url, repo_subpath, current_version, last_commit FROM libraries WHERE id = ?')
    .get<LibraryCore>(libraryId);
  if (!lib) throw Object.assign(new Error('库不存在。'), { statusCode: 404 });
  return lib;
}

/**
 * 为库创建（或复用）逻辑基线。(snapshot_id, library_id) 唯一 → 同库同 commit 重复创建幂等返回。
 */
export async function createBaselineForLibrary(
  libraryId: number,
  opts: {
    source: BaselineSource;
    ref?: string;
    commitSha?: string;
    prId?: number;
    versionLabel?: string;
    createdBy?: string;
    note?: string;
  },
): Promise<{ baseline: BaselineRow; snapshot: SnapshotRow; reused: boolean }> {
  const db = getDb();
  const lib = await loadLibrary(libraryId);
  const { commit, versionLabel, prId, note } = await resolveBaselineCommit(lib, opts.source, opts);
  const snapshot = await ensureSnapshot(lib, commit, {
    source: opts.source,
    versionLabel: opts.versionLabel || versionLabel,
    prId,
    createdBy: opts.createdBy ?? '',
    note: opts.note || note,
  });

  const existing = await db.prepare('SELECT * FROM test_baselines WHERE snapshot_id = ? AND library_id = ?')
    .get<BaselineRow>(snapshot.id, libraryId);
  if (existing) {
    if (existing.status === 'archived') {
      // 归档基线重新创建 = 解除归档（同 commit 同库，物理目录还在）
      await db.prepare(`UPDATE test_baselines SET status='ready', updated_at=? WHERE id=?`).run(now(), existing.id);
      existing.status = 'ready';
    }
    return { baseline: existing, snapshot, reused: true };
  }

  const subpath = normalizeSubpath(String(lib.repo_subpath ?? ''));
  // 单体仓子目录必须存在于快照中（commit 里可能还没有该目录 → 明确报错，不给出空基线）
  if (subpath) {
    const subAbs = path.join(workspaceDir(), snapshot.rel_dir, subpath);
    if (!fs.existsSync(subAbs)) {
      throw Object.assign(new Error(`基线快照（${commit.slice(0, 8)}）中不存在子目录 ${subpath}，无法为该库建基线。`), { statusCode: 409 });
    }
  }
  const t = now();
  const baselineNo = await nextBaselineNo();
  const ins = await db.prepare(
    `INSERT INTO test_baselines (baseline_no, snapshot_id, library_id, repo_subpath, version_label, source, status, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
  ).run(baselineNo, snapshot.id, libraryId, subpath, opts.versionLabel || versionLabel, opts.source, (opts.note || note).slice(0, 490), opts.createdBy ?? '', t, t);
  const baseline = (await db.prepare('SELECT * FROM test_baselines WHERE id = ?').get<BaselineRow>(Number(ins.lastInsertRowid))) as BaselineRow;
  if (prId) {
    const upsert = dbMode() === 'sqlite'
      ? `INSERT OR IGNORE INTO baseline_prs (baseline_id, pr_id, relation, created_at) VALUES (?, ?, 'source', ?)`
      : `INSERT IGNORE INTO baseline_prs (baseline_id, pr_id, relation, created_at) VALUES (?, ?, 'source', ?)`;
    await db.prepare(upsert).run(baseline.id, prId, t);
  }
  return { baseline, snapshot, reused: false };
}

/** 库的最新 ready 基线（按创建时间倒序）。 */
export async function latestReadyBaseline(libraryId: number): Promise<BaselineRow | undefined> {
  return getDb().prepare(
    `SELECT * FROM test_baselines WHERE library_id = ? AND status = 'ready' ORDER BY id DESC LIMIT 1`,
  ).get<BaselineRow>(libraryId);
}

/**
 * 计划运行时的基线解析（设计 §6.4 步骤 1 / §5.3.8）：
 *  - fixed：必须命中 ready 基线；
 *  - pr：按 merge_commit_sha 解析（B4 未同步 PR 时明确报错，不静默回退）；
 *  - latest：取库最新 ready 基线；不存在则按工作克隆当前 HEAD 懒创建（写清 note）。
 */
export async function resolveBaselineForRun(
  libraryId: number,
  mode: string,
  baselineId: number | null,
): Promise<BaselineRow> {
  if (mode === 'fixed') {
    if (!baselineId) throw Object.assign(new Error('计划为固定基线模式但未选择基线（baseline_id 为空）。'), { statusCode: 400 });
    const row = await getDb().prepare('SELECT * FROM test_baselines WHERE id = ? AND library_id = ?')
      .get<BaselineRow>(baselineId, libraryId);
    if (!row) throw Object.assign(new Error(`基线 #${baselineId} 不存在或不属于该库。`), { statusCode: 404 });
    if (row.status !== 'ready') throw Object.assign(new Error(`基线 ${row.baseline_no} 状态为 ${row.status}，不是 ready，不能用于运行。`), { statusCode: 409 });
    return row;
  }
  if (mode === 'pr') {
    throw Object.assign(new Error('PR 基线模式需要先同步 PR（B4），当前版本暂不支持，请改用 latest 或 fixed。'), { statusCode: 400 });
  }
  // latest：懒创建（设计 §5.3.8 —— 运行时解析为当前库最新可用基线，不存在则按当前 HEAD 创建并写清日志）
  const existing = await latestReadyBaseline(libraryId);
  if (existing) return existing;
  const { baseline } = await createBaselineForLibrary(libraryId, {
    source: 'latest', createdBy: 'plan-run', note: '计划运行时无可用基线，按工作克隆当前 HEAD 懒创建。',
  });
  console.log(`[baseline] 库 #${libraryId} 无 ready 基线，已按当前 HEAD 懒创建 ${baseline.baseline_no}（${baseline.version_label}）`);
  return baseline;
}

// ---------- 查询 / 校验 / 归档 / 删除 ----------

export interface BaselineDetail extends BaselineRow {
  commit_sha: string;
  repo_url: string;
  rel_dir: string;
  snapshot_status: string;
  size_bytes: number;
  source_pr_id: number | null;
  exec_count: number;
  referenced_by_plan: boolean;
}

export async function listBaselines(libraryId: number): Promise<BaselineDetail[]> {
  const db = getDb();
  return db.prepare(
    `SELECT b.*, s.commit_sha, s.repo_url, s.rel_dir, s.status AS snapshot_status, s.size_bytes, s.source_pr_id,
       (SELECT COUNT(*) FROM executions e WHERE e.baseline_id = b.id) AS exec_count,
       EXISTS(SELECT 1 FROM plans p WHERE p.baseline_id = b.id) AS referenced_by_plan
     FROM test_baselines b JOIN repo_snapshots s ON s.id = b.snapshot_id
     WHERE b.library_id = ? ORDER BY b.id DESC`,
  ).all<BaselineDetail>(libraryId);
}

export async function getBaselineDetail(id: number): Promise<BaselineDetail | undefined> {
  const db = getDb();
  return db.prepare(
    `SELECT b.*, s.commit_sha, s.repo_url, s.rel_dir, s.status AS snapshot_status, s.size_bytes, s.source_pr_id,
       (SELECT COUNT(*) FROM executions e WHERE e.baseline_id = b.id) AS exec_count,
       EXISTS(SELECT 1 FROM plans p WHERE p.baseline_id = b.id) AS referenced_by_plan
     FROM test_baselines b JOIN repo_snapshots s ON s.id = b.snapshot_id
     WHERE b.id = ?`,
  ).get<BaselineDetail>(id);
}

export interface VerifyResult { ok: boolean; problems: string[]; sizeBytes: number }

/** 校验基线：目录存在、标记文件 commit 匹配、子目录存在、快照 ready。 */
export async function verifyBaseline(id: number): Promise<VerifyResult> {
  const row = await getBaselineDetail(id);
  if (!row) throw Object.assign(new Error('基线不存在。'), { statusCode: 404 });
  const problems: string[] = [];
  const abs = path.join(workspaceDir(), row.rel_dir);
  if (!fs.existsSync(abs)) problems.push(`快照目录不存在：${row.rel_dir}`);
  else {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(abs, '.autotest-baseline.json'), 'utf8')) as { commit?: string };
      if (marker.commit !== row.commit_sha) problems.push(`标记文件 commit 不匹配：${marker.commit} ≠ ${row.commit_sha}`);
    } catch {
      problems.push('标记文件 .autotest-baseline.json 缺失或损坏');
    }
    if (row.repo_subpath && !fs.existsSync(path.join(abs, row.repo_subpath))) {
      problems.push(`库子目录不存在：${row.repo_subpath}`);
    }
  }
  if (row.snapshot_status !== 'ready') problems.push(`物理快照状态为 ${row.snapshot_status}`);
  return { ok: problems.length === 0, problems, sizeBytes: row.size_bytes };
}

/** 归档（软删）：基线不再出现在可选列表；被计划引用时拒绝。 */
export async function archiveBaseline(id: number): Promise<void> {
  const db = getDb();
  const row = await getBaselineDetail(id);
  if (!row) throw Object.assign(new Error('基线不存在。'), { statusCode: 404 });
  if (row.referenced_by_plan) throw Object.assign(new Error('基线被固定基线计划引用，不能归档（请先调整计划）。'), { statusCode: 409 });
  await db.prepare(`UPDATE test_baselines SET status='archived', updated_at=? WHERE id=?`).run(now(), id);
}

/** 硬删：无引用 + 目录清理。执行记录中的 baseline_id 保留（历史指向允许悬空，详情页显示「已删除」）。 */
export async function deleteBaseline(id: number): Promise<void> {
  const db = getDb();
  const row = await getBaselineDetail(id);
  if (!row) throw Object.assign(new Error('基线不存在。'), { statusCode: 404 });
  if (row.exec_count > 0) throw Object.assign(new Error(`基线已有 ${row.exec_count} 条执行记录引用，禁止硬删（可归档）。`), { statusCode: 409 });
  if (row.referenced_by_plan) throw Object.assign(new Error('基线被固定基线计划引用，禁止删除。'), { statusCode: 409 });
  await db.prepare('DELETE FROM test_baselines WHERE id = ?').run(id);
  await db.prepare('DELETE FROM baseline_prs WHERE baseline_id = ?').run(id);
  // 物理快照可能被同 commit 的其他库基线共享：无其他引用才删目录与快照行
  const others = await db.prepare('SELECT COUNT(*) AS n FROM test_baselines WHERE snapshot_id = ?').get<{ n: number }>(row.snapshot_id);
  if (!others || others.n === 0) {
    const snap = await db.prepare('SELECT * FROM repo_snapshots WHERE id = ?').get<SnapshotRow>(row.snapshot_id);
    if (snap) {
      const abs = path.join(workspaceDir(), snap.rel_dir);
      if (snap.rel_dir.startsWith('baselines') && fs.existsSync(abs)) {
        // worktree 快照需先注销，否则 git worktree list 残留
        try {
          const meta = JSON.parse(snap.metadata_json) as { method?: string };
          if (meta.method === 'worktree') await git(['worktree', 'remove', '--force', abs], path.join(workspaceDir(), 'repos'), 60000);
        } catch { /* 退化为直接删目录 */ }
        fs.rmSync(abs, { recursive: true, force: true });
      }
      await db.prepare('DELETE FROM repo_snapshots WHERE id = ?').run(snap.id);
    }
  }
}

/** 基线磁盘占用（配额检查用）。 */
export async function baselineTotalBytes(): Promise<number> {
  const row = await getDb().prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM repo_snapshots WHERE status = 'ready'`).get<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 创建前配额检查（超限抛 409，提示清理）。 */
export async function assertBaselineQuota(): Promise<void> {
  const maxGb = Number(getSetting('baseline.maxTotalGb', 50)) || 0;
  if (maxGb <= 0) return;
  const total = await baselineTotalBytes();
  if (total > maxGb * 1024 * 1024 * 1024) {
    throw Object.assign(
      new Error(`基线总占用已超配额（${(total / 1024 / 1024 / 1024).toFixed(1)}GB > ${maxGb}GB）。请先归档/删除未被引用的旧基线（设置 baseline.maxTotalGb 可调）。`),
      { statusCode: 409 },
    );
  }
}
