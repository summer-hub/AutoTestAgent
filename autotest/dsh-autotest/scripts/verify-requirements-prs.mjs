// B4 需求/PR 追踪链路自检（设计 §7/§10.2/§10.3）：不连 MySQL、不调 LLM、不需要设备。
//  需求（§7.1/§10.2）：
//   1. RQ-YYYYMMDD-NNN 编号；title 必填 400；source/status 白名单 400；(source, external_id) 查重 409
//   2. 更新：状态/标题（改空 400）/不存在 404
//   3. 统计现算：caseCount/prCount/recentFailed/baselineCount；列表过滤 status/q
//   4. 关联：requirement_cases（covers 幂等）、解除关联、getRequirementDetail（cases/prs/scenarioAssets）
//  PR（§7.2/§7.3/§7.4/§10.3）：
//   5. 本地 git 降级同步：provider='local'、head_sha=提交 hash、merge_commit_sha 留空（不冒充）
//   6. (provider, repo_url, number) 幂等 upsert；pr_libraries affects 关联
//   7. 派生测试状态（§7.3）：untested → testing（有 running）→ failed（有失败）→ passed（全通过）
//   8. merge 缺失建 merge 基线 409（提示 head 通道）；补 merge_commit 后建基线：baseline_prs 写入
//   9. head 预验证基线：note 标注"非合入提交/预验证"；同 PR 同 ref 幂等复用
// 用法：npm run build && npm run verify:requirements-prs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3 与真实工作区
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-b4-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const expectError = async (fn, label, code = '') => {
  try { await fn(); check(false, label, '未抛错'); return null; }
  catch (e) {
    const ok = code === '' || String(e.statusCode ?? e.status ?? 0) === code;
    check(ok, label, `${String(e.message).slice(0, 90)}`);
    return e;
  }
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

// ---------- 本地 git 环境（origin + 手工克隆，同 verify-baseline 模式） ----------
const origin = path.join(tmpDir, 'origin.git');
fs.mkdirSync(origin, { recursive: true });
git(['init', '-q', '-b', 'main'], origin);
git(['config', 'user.email', 'verify@autotest.local'], origin);
git(['config', 'user.name', 'verify'], origin);
fs.writeFileSync(path.join(origin, 'README.md'), '# verify\n', 'utf8');
git(['add', '.'], origin);
git(['commit', '-q', '-m', 'c1'], origin);
const commit1 = git(['rev-parse', 'HEAD'], origin);
fs.writeFileSync(path.join(origin, 'lib.js'), 'export const v = 2;\n', 'utf8');
git(['add', '.'], origin);
git(['commit', '-q', '-m', 'c2'], origin);
const commit2 = git(['rev-parse', 'HEAD'], origin);

const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —`);

const { repoRootForLib } = await import('../lib/services/gitRepo.js');
const rq = await import('../lib/services/requirements.js');
const pt = await import('../lib/services/prTracking.js');
const ps = await import('../lib/services/prStatus.js');
const baseline = await import('../lib/services/baseline.js');

// ---------- 库 + 用例 + 手工克隆 ----------
const t = now();
const libName = 'b4-lib';
const insLib = await db.prepare(
  `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
   VALUES (?, ?, '', 'B4 自检库', 'v0.1.0', ?, 'active', ?, ?)`,
).run(libName, origin, commit2, t, t);
const libId = Number(insLib.lastInsertRowid);
const lib = await baseline.loadLibrary(libId);
const cloneDir = repoRootForLib(lib);
fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
execFileSync('git', ['clone', '-q', origin, cloneDir], { windowsHide: true });
git(['config', 'user.email', 'verify@autotest.local'], cloneDir);
git(['config', 'user.name', 'verify'], cloneDir);

const insCase = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, oracle_json, status, current_version, created_at, updated_at)
   VALUES (?, 'C-001', '空列表提示', '新需求引入', '', '[]', '显示"暂无数据"', '[]', 'active', 1, ?, ?)`,
).run(libId, t, t);
const caseId = Number(insCase.lastInsertRowid);

// ========== A. 需求（§7.1 / §10.2） ==========
console.log('\n— 需求 CRUD —');
const no1 = await rq.nextRequirementNo();
check(/^RQ-\d{8}-001$/.test(no1), '需求编号 RQ-YYYYMMDD-001', no1);
await expectError(() => rq.createRequirement({ title: '  ' }), '空标题 400（标题是需求的身份）', '400');
await expectError(() => rq.createRequirement({ title: 'x', source: 'jira' }), '非法 source 400（白名单）', '400');
await expectError(() => rq.createRequirement({ title: 'x', status: 'weird' }), '非法 status 400（白名单）', '400');

const r1 = await rq.createRequirement({ title: '列表为空时提示', source: 'manual', primaryLibraryId: libId, acceptanceMd: '- 显示"暂无数据"' });
check(/^RQ-\d{8}-\d{3}$/.test(r1.requirementNo), '需求创建返回编号', r1.requirementNo);
check(r1.status === 'active' && r1.priority === 'P1', '默认 status=active / priority=P1');
const r2 = await rq.createRequirement({ title: '第二个需求', source: 'onebox', externalId: 'OB-9' });
check(r2.requirementNo !== r1.requirementNo, '第二个需求编号不同（自增）', r2.requirementNo);
await expectError(() => rq.createRequirement({ title: '重复外部 ID', source: 'onebox', externalId: 'OB-9' }), '同 source+external_id 查重 409', '409');
const notDup = await rq.createRequirement({ title: '不同源同 ID 不算重复', source: 'manual', externalId: 'OB-9' });
check(Boolean(notDup), '不同 source 同 external_id 允许（查重按源隔离）');

const upd = await rq.updateRequirement(r1.id, { status: 'done', priority: 'P0' });
check(upd.status === 'done' && upd.priority === 'P0', '更新状态/优先级生效');
await expectError(() => rq.updateRequirement(r1.id, { title: ' ' }), '标题改空 400', '400');
await expectError(() => rq.updateRequirement(999999, { status: 'active' }), '更新不存在的需求 404', '404');

console.log('\n— 需求关联与统计 —');
const linked1 = await rq.linkRequirementCases(r1.id, [caseId]);
check(linked1.linked === 1, '关联用例 covers 首次 linked=1');
const linkedAgain = await rq.linkRequirementCases(r1.id, [caseId]);
check(linkedAgain.linked === 0, '重复关联幂等 linked=0');
await expectError(() => rq.linkRequirementCases(r1.id, [999999]), '关联不存在的用例 404', '404');

let list = await rq.listRequirements({ status: 'done' });
check(list.some((x) => x.id === r1.id) && !list.some((x) => x.id === r2.id), '列表按 status 过滤');
list = await rq.listRequirements({ q: '列表为空' });
check(list.some((x) => x.id === r1.id), '列表按关键词过滤（标题 LIKE）');
list = await rq.listRequirements({});
const statRow = list.find((x) => x.id === r1.id);
check(Boolean(statRow) && statRow.caseCount === 1, '统计现算 caseCount=1');
check(statRow.recentFailed === 0 && statRow.baselineCount === 0, '无执行时 recentFailed=0 / baselineCount=0（不伪造）');

const detail = await rq.getRequirementDetail(r1.id);
check(detail.cases.length === 1 && detail.cases[0].caseNo === 'C-001' && detail.cases[0].relation === 'covers', '详情带出关联用例（relation）');
check(detail.prs.length === 0 && detail.scenarioAssets.length === 0, '未关联时 prs/scenarioAssets 为空数组');

const unlinked = await rq.unlinkRequirementCase(r1.id, caseId);
check(unlinked.removed === 1, '解除用例关联 removed=1');
check((await rq.getRequirementDetail(r1.id)).cases.length === 0, '解除后详情 cases=0');
await rq.linkRequirementCases(r1.id, [caseId], 'verifies');

// ========== B. PR 同步（§7.2 本地降级） ==========
console.log('\n— PR 同步（本地 git 降级） —');
const sync1 = await pt.syncLibraryPrs(libId, { limit: 10 });
check(sync1.provider === 'local', '本地路径非 GitCode → provider=local（降级不冒充 gitcode）', `provider=${sync1.provider}`);
check(sync1.synced === 2, '两条提交各记一条 PR', `synced=${sync1.synced}`);
const prRows = await db.prepare('SELECT * FROM pull_requests ORDER BY number').all();
check(prRows.length === 2, 'pull_requests 落库 2 行');
// git log 新提交在前：number 1 = c2，number 2 = c1
const prNew = prRows.find((p) => Number(p.number) === 1);
const prOld = prRows.find((p) => Number(p.number) === 2);
check(Boolean(prNew) && prNew.head_sha === commit2, 'PR#1 head_sha = 提交 hash（本地降级记 head）');
check(Boolean(prNew) && prNew.merge_commit_sha === '', '本地降级 merge_commit_sha 留空（本地提交不是合入提交，不冒充 §7.2）');
check(Boolean(prOld) && prOld.head_sha === commit1, 'PR#2 head_sha = c1');
const prLibRow = await db.prepare('SELECT COUNT(*) AS c FROM pr_libraries WHERE library_id = ?').get(libId);
check(Number(prLibRow.c) === 2, 'pr_libraries affects 关联 2 行', `count=${prLibRow.c}`);

const sync2 = await pt.syncLibraryPrs(libId, { limit: 10 });
const prRows2 = await db.prepare('SELECT * FROM pull_requests').all();
check(prRows2.length === 2 && sync2.synced === 2, '重复同步幂等 upsert（不重复插入）', `rows=${prRows2.length}`);

const prList = await pt.listLibraryPrs(libId);
check(prList.length === 2, 'listLibraryPrs 返回 2 条');
check(prList.every((p) => p.testStatus.status === 'untested'), '无基线时派生状态 untested（§7.3）');
check(prList.every((p) => p.requirementCount === 0 && p.caseCount === 0 && p.baselineCount === 0), '未关联时计数全 0');

// ========== C. PR 关联 + 派生状态 + 建基线（§7.3/§7.4） ==========
console.log('\n— PR 关联与派生状态 —');
const prNewId = Number(prNew.id);
const reqLink = await pt.linkPrRequirements(prNewId, [r1.id]);
check(reqLink.linked === 1, 'PR ↔ 需求关联 linked=1');
check((await rq.getRequirementDetail(r1.id)).prs.length === 1, '需求详情反向带出 PR（prCount 链路）');
const reqStat = (await rq.listRequirements({})).find((x) => x.id === r1.id);
check(reqStat.prCount === 1, '需求统计 prCount=1（现算）');

const caseLink = await pt.linkPrCases(prNewId, [caseId]);
check(caseLink.linked === 1, 'PR ↔ 用例关联（pr_cases 新表）linked=1');
const caseLinkAgain = await pt.linkPrCases(prNewId, [caseId]);
check(caseLinkAgain.linked === 0, 'PR ↔ 用例关联幂等');
const prDetail = await pt.getPrDetail(prNewId);
check(prDetail.cases.length === 1 && prDetail.cases[0].basis === 'manual', 'PR 详情带出用例（basis=manual）');
check(prDetail.requirements.length === 1 && prDetail.requirements[0].requirementNo === r1.requirementNo, 'PR 详情带出需求');

// merge 缺失：ref=merge 409（提示 head 通道）
await expectError(() => pt.createBaselineFromPr(prNewId, { ref: 'merge', createdBy: 'verify' }), 'merge_commit 为空时建 merge 基线 409（提示 head 预验证）', '409');
check((await ps.derivePrTestStatus(prNewId)).status === 'untested', '建基线前派生状态 untested');

// 补 merge_commit（模拟已合入）→ merge 基线
await db.prepare('UPDATE pull_requests SET merge_commit_sha = ? WHERE id = ?').run(commit2, prNewId);
const bl1 = await pt.createBaselineFromPr(prNewId, { ref: 'merge', versionLabel: 'v2.0.0-pr', createdBy: 'verify' });
check(/^BL-\d{8}-\d{3}$/.test(bl1.baseline.baseline_no), 'merge 基线编号 BL-YYYYMMDD-NNN', bl1.baseline.baseline_no);
check(bl1.baseline.source === 'pr', '基线 source=pr');
const blPrRow = await db.prepare('SELECT COUNT(*) AS c FROM baseline_prs WHERE pr_id = ? AND baseline_id = ?').get(prNewId, bl1.baseline.id);
check(Number(blPrRow.c) === 1, 'baseline_prs 写入（PR → 基线链路）');
const bl1Again = await pt.createBaselineFromPr(prNewId, { ref: 'merge', createdBy: 'verify' });
check(bl1Again.reused === true && bl1Again.baseline.id === bl1.baseline.id, '同 PR 同 ref 重复建基线幂等复用');

// 派生状态转换：untested → testing → failed → passed
const st1 = await ps.derivePrTestStatus(prNewId);
check(st1.status === 'untested' && st1.baselineCount === 1, '有基线无执行仍 untested（executionCount=0 不伪造）');
const insExecRunning = await db.prepare(
  `INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, baseline_id, case_version, library_version, commit_sha, actual_json, logs, started_at, finished_at)
   VALUES (NULL, ?, ?, NULL, 'running', '[]', 'tr-b4', ?, 1, 'v0.1.0', ?, '{}', '', ?, NULL)`,
).run(caseId, libId, bl1.baseline.id, commit2, t);
const st2 = await ps.derivePrTestStatus(prNewId);
check(st2.status === 'testing', '有 running 执行 → testing（§7.3 优先级最高）');
await db.prepare(
  `INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, baseline_id, case_version, library_version, commit_sha, actual_json, logs, started_at, finished_at)
   VALUES (NULL, ?, ?, NULL, 'failed', '[]', 'tr-b4', ?, 1, 'v0.1.0', ?, '{}', '', ?, ?)`,
).run(caseId, libId, bl1.baseline.id, commit2, t, t);
const st3 = await ps.derivePrTestStatus(prNewId);
check(st3.status === 'testing' && st3.failedCount === 1, 'running 未结束 + 有失败 → 仍 testing（running 优先）');
await db.prepare('UPDATE executions SET status = ?, finished_at = ? WHERE id = ?').run('passed', t, Number(insExecRunning.lastInsertRowid));
const st4 = await ps.derivePrTestStatus(prNewId);
check(st4.status === 'failed', 'running 结束后存在失败 → failed');
await db.prepare('UPDATE executions SET status = ?, finished_at = ? WHERE baseline_id = ?').run('passed', t, bl1.baseline.id);
const st5 = await ps.derivePrTestStatus(prNewId);
check(st5.status === 'passed' && st5.executionCount === 2 && st5.passedCount === 2, '全部通过 → passed（执行 2/2）');

// 需求侧统计随执行刷新（recentFailed 0；baselineCount 1）
const reqStat2 = (await rq.listRequirements({})).find((x) => x.id === r1.id);
check(reqStat2.recentFailed === 0 && reqStat2.baselineCount === 1, '需求统计 recentFailed=0 / baselineCount=1（现算随执行刷新）');
// 再插入一条 failed 执行 → recentFailed=1
await db.prepare(
  `INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, baseline_id, case_version, library_version, commit_sha, actual_json, logs, started_at, finished_at)
   VALUES (NULL, ?, ?, NULL, 'failed', '[]', 'tr-b4', ?, 1, 'v0.1.0', ?, '{}', '', ?, ?)`,
).run(caseId, libId, bl1.baseline.id, commit2, t, t);
const reqStat3 = (await rq.listRequirements({})).find((x) => x.id === r1.id);
check(reqStat3.recentFailed === 1, '关联用例最近执行失败 → recentFailed=1');

console.log('\n— head 预验证基线（§7.4 预验证通道） —');
const prOldId = Number(prOld.id);
// PR#2 只有 head（merge 为空）：merge 409 → head 可建
await expectError(() => pt.createBaselineFromPr(prOldId, { ref: 'merge', createdBy: 'verify' }), 'PR#2 merge 缺失建 merge 基线 409', '409');
const hb1 = await pt.createBaselineFromPr(prOldId, { ref: 'head', createdBy: 'verify' });
check(/^BL-\d{8}-\d{3}$/.test(hb1.baseline.baseline_no), 'head 预验证基线创建成功', hb1.baseline.baseline_no);
const hbSnapshot = await db.prepare('SELECT * FROM repo_snapshots WHERE id = ?').get(hb1.baseline.snapshot_id);
check(Boolean(hbSnapshot) && hbSnapshot.commit_sha === commit1, 'head 基线 commit = PR head_sha（c1）');
check(Boolean(hbSnapshot) && hbSnapshot.source === 'pr', '快照 source=pr');
const hbPrRow = await db.prepare('SELECT COUNT(*) AS c FROM baseline_prs WHERE pr_id = ?').get(prOldId);
check(Number(hbPrRow.c) === 1, 'head 基线同样写入 baseline_prs');
const hbNote = await db.prepare('SELECT note FROM test_baselines WHERE id = ?').get(hb1.baseline.id);
check(String(hbNote.note).includes('预验证') || String(hbNote.note).includes('非合入'), 'note 标注"非合入提交/预验证"（不冒充已合入）', String(hbNote.note).slice(0, 60));
const hb1Again = await pt.createBaselineFromPr(prOldId, { ref: 'head', createdBy: 'verify' });
check(hb1Again.reused === true && hb1Again.baseline.id === hb1.baseline.id, 'head 基线重复创建幂等复用');

// 不存在的 PR / 未关联库
await expectError(() => pt.createBaselineFromPr(999999, {}), '不存在的 PR 建基线 404', '404');
await expectError(() => pt.linkPrRequirements(999999, [r1.id]), '不存在的 PR 关联需求 404', '404');
await expectError(() => pt.linkPrRequirements(prNewId, [999999]), 'PR 关联不存在的需求 404', '404');
await expectError(() => pt.getPrDetail(999999), '不存在的 PR 详情 404', '404');

console.log(`\n${fail === 0 ? 'ALL PASS' : `FAILED: ${fail}`}  （临时目录：${tmpDir}）`);
process.exit(fail === 0 ? 0 : 1);
