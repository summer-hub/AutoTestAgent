// B1 基线链路自检：不连 MySQL、不调 LLM、不需要设备。
//  1. 建临时 git 仓库（origin）+ 手工克隆到 workspace/repos —— createBaselineForLibrary 的最低前置
//  2. latest 基线创建：snapshot ready、目录+标记文件、(snapshot_id, library_id) 幂等复用
//  3. 快照幂等：同 (repo_url, commit_sha) 只有一份物理目录
//  4. 新提交 → 新基线（BL-…-002，rel_dir 不同），listBaselines 有序返回
//  5. verifyBaseline：目录/标记文件/commit 匹配
//  6. resolveBaselineForRun：latest 懒创建（无基线时按 HEAD 创建并写清 note）
//  7. 引用保护：有执行记录禁止硬删；被计划引用禁止归档
//  8. test_runs / test_run_items：nextRunNo 编号、快照行落库与读回
// 用法：npm run build && npm run verify:baseline
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3 与真实工作区
// （gitRepo.workspaceDir 的约定：AUTOTEST_WORKSPACE 覆盖一切，自检/CI 必须走临时目录）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-baseline-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

// ---------- 本地 git 环境 ----------
const origin = path.join(tmpDir, 'origin.git');
fs.mkdirSync(origin, { recursive: true });
git(['init', '-q', '-b', 'main'], origin);
git(['config', 'user.email', 'verify@autotest.local'], origin);
git(['config', 'user.name', 'verify'], origin);
fs.writeFileSync(path.join(origin, 'README.md'), '# verify\n', 'utf8');
fs.mkdirSync(path.join(origin, 'lib-src'), { recursive: true });
fs.writeFileSync(path.join(origin, 'lib-src', 'index.js'), 'export const ok = 1;\n', 'utf8');
git(['add', '.'], origin);
git(['commit', '-q', '-m', 'c1'], origin);
const commit1 = git(['rev-parse', 'HEAD'], origin);

const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —`);

const { repoRootForLib, workspaceDir } = await import('../lib/services/gitRepo.js');
const baseline = await import('../lib/services/baseline.js');

// ---------- 库 + 手工克隆（createBaselineForLibrary 要求本地已有 clone） ----------
const t = now();
const libName = 'verify-lib';
const insLib = await db.prepare(
  `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
   VALUES (?, ?, '', 'B1 自检库', 'v0.0.1', ?, 'active', ?, ?)`,
).run(libName, origin, commit1, t, t);
const libId = Number(insLib.lastInsertRowid);
const lib = await baseline.loadLibrary(libId);
const cloneDir = repoRootForLib(lib);
fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
execFileSync('git', ['clone', '-q', origin, cloneDir], { windowsHide: true });
git(['config', 'user.email', 'verify@autotest.local'], cloneDir);
git(['config', 'user.name', 'verify'], cloneDir);

// ---------- 1. latest 基线创建 ----------
console.log('\n— 基线创建 —');
const r1 = await baseline.createBaselineForLibrary(libId, { source: 'latest', createdBy: 'verify' });
check(r1.baseline.status === 'ready', '基线创建后即为 ready', `status=${r1.baseline.status}`);
check(/^BL-\d{8}-001$/.test(r1.baseline.baseline_no), '基线编号 BL-YYYYMMDD-001', r1.baseline.baseline_no);
check(r1.snapshot.commit_sha === commit1, '快照 commit 与仓库 HEAD 一致');
const absDir = path.join(workspaceDir(), r1.snapshot.rel_dir);
check(fs.existsSync(absDir), '快照物理目录存在', r1.snapshot.rel_dir);
check(fs.existsSync(path.join(absDir, '.autotest-baseline.json')), '快照标记文件存在');
const marker = JSON.parse(fs.readFileSync(path.join(absDir, '.autotest-baseline.json'), 'utf8'));
check(marker.commit === commit1, '标记文件 commit 匹配');
check(fs.existsSync(path.join(absDir, 'README.md')), '快照内容来自目标 commit');

// ---------- 2. 幂等 ----------
const r2 = await baseline.createBaselineForLibrary(libId, { source: 'latest', createdBy: 'verify' });
check(r2.reused === true && r2.baseline.id === r1.baseline.id, '同库同 commit 重复创建幂等复用同一基线');
const snapCount = (await db.prepare('SELECT COUNT(*) AS c FROM repo_snapshots').get()).c;
check(Number(snapCount) === 1, '同 (repo_url, commit_sha) 只有一份物理快照', `count=${snapCount}`);

// ---------- 3. verify ----------
const v1 = await baseline.verifyBaseline(r1.baseline.id);
check(v1.ok, 'verifyBaseline 通过（目录/标记/子目录/状态）', v1.problems.join(' | '));

// ---------- 4. 新提交 → 新基线 ----------
fs.writeFileSync(path.join(origin, 'README.md'), '# verify c2\n', 'utf8');
git(['add', '.'], origin);
git(['commit', '-q', '-m', 'c2'], origin);
git(['pull', '-q'], cloneDir);
const r3 = await baseline.createBaselineForLibrary(libId, { source: 'latest', createdBy: 'verify' });
check(r3.baseline.id !== r1.baseline.id && /^BL-\d{8}-002$/.test(r3.baseline.baseline_no), '新提交产生新基线 BL-…-002', r3.baseline.baseline_no);
check(r3.snapshot.rel_dir !== r1.snapshot.rel_dir, '两份快照目录不同');
const list = await baseline.listBaselines(libId);
check(list.length === 2, 'listBaselines 返回两条', `len=${list.length}`);
const detail = await baseline.getBaselineDetail(r3.baseline.id);
check(Boolean(detail) && detail.commit_sha === git(['rev-parse', 'HEAD'], cloneDir), 'getBaselineDetail 带出 commit');

// ---------- 5. latest 懒创建（无 ready 基线时） ----------
const lazyLib = await (async () => {
  const ins = await db.prepare(
    `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
     VALUES (?, ?, '', 'B1 懒创建自检库', 'v0.0.1', ?, 'active', ?, ?)`,
  ).run('verify-lazy-lib', origin, commit1, t, t);
  return Number(ins.lastInsertRowid);
})();
const resolved = await baseline.resolveBaselineForRun(lazyLib, 'latest', null);
check(/^BL-/.test(resolved.baseline_no) && resolved.status === 'ready', 'latest 运行解析：无基线时按 HEAD 懒创建', resolved.baseline_no);
const resolvedAgain = await baseline.resolveBaselineForRun(lazyLib, 'latest', null);
check(resolvedAgain.id === resolved.id, 'latest 运行解析：已有基线直接复用（不重复创建）');
const fixed = await baseline.resolveBaselineForRun(libId, 'fixed', r1.baseline.id);
check(fixed.id === r1.baseline.id, 'fixed 运行解析：按 id 命中 ready 基线');
let prModeRejected = false;
try { await baseline.resolveBaselineForRun(libId, 'pr', null); } catch { prModeRejected = true; }
check(prModeRejected, 'pr 模式明确报错（B4 未实现，不静默降级）');
let fixedMissingRejected = false;
try { await baseline.resolveBaselineForRun(libId, 'fixed', null); } catch { fixedMissingRejected = true; }
check(fixedMissingRejected, 'fixed 模式缺 baselineId 明确报错');

// ---------- 6. 引用保护 ----------
console.log('\n— 引用保护 —');
await db.prepare(
  `INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, test_run_id, run_item_id, baseline_id, case_version, case_snapshot_json, library_version, commit_sha, actual_json, thinking, logs, started_at, finished_at)
   VALUES (NULL, 1, ?, NULL, 'passed', '[]', 'tr-verify', NULL, NULL, ?, 1, '{}', 'v0.0.1', ?, '{}', NULL, '', ?, ?)`,
).run(libId, r1.baseline.id, commit1, t, t);
let deleteRejected = false;
try { await baseline.deleteBaseline(r1.baseline.id); } catch { deleteRejected = true; }
check(deleteRejected, '有执行记录引用的基线禁止硬删');
const insPlan = await db.prepare(
  `INSERT INTO plans (plan_no, name, type, cron, scope, device_ids, status, fail_policy, script_mode, baseline_id, baseline_mode, error, created_at, updated_at)
   VALUES ('P-9001', 'verify-fixed', 'immediate', NULL, ?, '[]', 'draft', 'continue', '', ?, 'fixed', '', ?, ?)`,
).run(JSON.stringify({ libraryIds: [libId], caseIds: [] }), r3.baseline.id, t, t);
let archiveRejected = false;
try { await baseline.archiveBaseline(r3.baseline.id); } catch { archiveRejected = true; }
check(archiveRejected, '被固定基线计划引用的基线禁止归档');
await baseline.archiveBaseline(r1.baseline.id);
const archived = await baseline.getBaselineDetail(r1.baseline.id);
check(archived.status === 'archived', '无计划引用的基线可归档（软删）');

// ---------- 7. test_runs / test_run_items ----------
console.log('\n— 运行快照 —');
const runNo = await baseline.nextRunNo();
check(/^TR-\d{8}-001$/.test(runNo), '运行编号 TR-YYYYMMDD-001', runNo);
// 编号在落库后才自增：两次调用之间必须先 INSERT（编号分配以持久化行为准，防并发跳号）
const insRun = await db.prepare(
  `INSERT INTO test_runs (run_no, plan_id, trigger_kind, status, device_id, manifest_json, error, started_at, created_by, created_at, updated_at)
   VALUES (?, ?, 'manual', 'running', NULL, '{}', '', ?, 'verify', ?, ?)`,
).run(runNo, Number(insPlan.lastInsertRowid), t, t, t);
const runId = Number(insRun.lastInsertRowid);
const runNo2 = await baseline.nextRunNo();
check(runNo2.endsWith('-002'), '落库后运行编号自增', runNo2);
const insItem = await db.prepare(
  `INSERT INTO test_run_items (run_id, library_id, baseline_id, commit_sha, repo_subpath, workspace_rel_dir, case_versions_json, status, error, started_at, finished_at)
   VALUES (?, ?, ?, ?, '', ?, ?, 'running', '', ?, NULL)`,
).run(runId, libId, r3.baseline.id, detail.commit_sha, `runs/${runNo}/${libName}`, JSON.stringify({ '1': 1 }), t);
const runItem = await db.prepare('SELECT * FROM test_run_items WHERE id = ?').get(Number(insItem.lastInsertRowid));
check(runItem.case_versions_json === '{"1":1}', 'test_run_items 用例版本快照落库并读回一致');
const runRow = await db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId);
check(runRow.trigger_kind === 'manual' && runRow.status === 'running', 'test_runs 行落库（trigger_kind/status）');

// ---------- 8. 配额 ----------
console.log('\n— 配额 —');
const totalBytes = await baseline.baselineTotalBytes();
check(Number(totalBytes) > 0, '基线体积统计 > 0', `bytes=${totalBytes}`);
let quotaOk = true;
try { await baseline.assertBaselineQuota(); } catch { quotaOk = false; }
check(quotaOk, '默认配额（50GB）下 assertBaselineQuota 通过');

console.log(`\n${fail === 0 ? 'ALL PASS' : `FAILED: ${fail}`}  （临时目录：${tmpDir}）`);
process.exit(fail === 0 ? 0 : 1);
