// B3 Markdown 分析报告链路自检（设计 §15.6 六项验收）：不连 MySQL、不调 LLM、不需要设备。
//  1. 从执行建工单：execution/test_run/run_item/baseline/用例版本 链路快照进工单；
//     从用例建工单：最近执行仅回填链路、execution_id 留空（不伪造绑定）；跨用例执行 400
//  2. 报告生成：RP- 编号、文件落盘（workspace/reports/<lib>/RP-*.md）、content_hash == 文件 sha256
//  3. 报告内容（§9.5 模板逐段）：需求/PR/merge commit/基线 commit/用例 V/预置/步骤/预期/
//     现象/场景资产/资源集/运行登记资产/分析过程/证据表/归因/未验证标注
//  4. 归因：LLM 白名单枚举（normalizeAttribution）、修正必留理由（历史追加、空理由 400）
//  5. 正文双写兜底：文件丢失 → getReportMarkdown 回退 DB 正文（hash 仍校验）
//  6. 不可变：重新生成 = 新 report_no 新文件，旧报告行/文件不动；feature.mdReport=false → 403
//  7. 验收：接受 → 知识条目生成 + knowledge_id 回填；报告保留不变
// 用法：npm run build && npm run verify:analysis-reports
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ⚠️ 必须指向临时目录：绝不碰用户正在使用的 data/autotest.sqlite3 与真实工作区
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-report-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const expectError = async (fn, label, code = '') => {
  try { await fn(); check(false, label, '未抛错'); return null; }
  catch (e) {
    const ok = code === '' || String(e.statusCode ?? e.status ?? 0) === code;
    check(ok, label, `${String(e.message).slice(0, 80)}`);
    return e;
  }
};

const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —`);

const { workspaceDir } = await import('../lib/services/gitRepo.js');
const sa = await import('../lib/services/scenarioAssets.js');
const ir = await import('../lib/services/issueRoot.js');
const ar = await import('../lib/services/analysisReport.js');
const kn = await import('../lib/services/knowledge.js');
const { setSetting, getSetting } = await import('../lib/services/settings.js');

const t = now();

// ---------- 骨架：库 / 用例 / 需求 / PR / 基线 / 运行 / 设备 / 场景资产 ----------
const insLib = await db.prepare(
  `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
   VALUES ('ar-lib', 'https://git.example/ar-lib.git', '', 'B3 自检库', 'v1.2.0', '', 'active', ?, ?)`,
).run(t, t);
const libId = Number(insLib.lastInsertRowid);
const insCase = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, oracle_json, status, current_version, created_at, updated_at)
   VALUES (?, 'C-001', '空列表边界', '新需求引入', '已登录且列表为空', '["进入列表页","下拉刷新"]', '页面显示"暂无数据"',
     '[{"kind":"ui_exists","target":"暂无数据"}]', 'active', 2, ?, ?)`,
).run(libId, t, t);
const caseId = Number(insCase.lastInsertRowid);
const insCaseOther = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, current_version, created_at, updated_at)
   VALUES (?, 'C-002', '别用例', '新需求引入', '', '[]', '[]', 'active', 1, ?, ?)`,
).run(libId, t, t);
const caseOther = Number(insCaseOther.lastInsertRowid);

// 需求 ↔ 用例（B4 链路，报告 §1 需求行）
const insReq = await db.prepare(
  `INSERT INTO requirements (requirement_no, external_id, source, title, url, primary_library_id, status, acceptance_md, created_at, updated_at)
   VALUES ('RQ-001', '', 'manual', '列表为空时提示', '', ?, 'active', '', ?, ?)`,
).run(libId, t, t);
const reqId = Number(insReq.lastInsertRowid);
await db.prepare('INSERT INTO requirement_cases (requirement_id, case_id, relation, created_at) VALUES (?, ?, ?, ?)').run(reqId, caseId, 'covers', t);

// PR → 快照 → 基线 → baseline_prs（报告 §1 PR 行 + §1 基线 commit）
const mergeSha = 'f' + 'e'.repeat(39) + 'd'; // 41 位 merge commit
const headSha = 'a'.repeat(40);
const insPr = await db.prepare(
  `INSERT INTO pull_requests (provider, repo_url, number, library_id, title, state, url, base_branch, head_branch, head_sha, merge_commit_sha, merged_at, author, body_excerpt, files_json, synced_at, created_at, updated_at)
   VALUES ('gitee', 'https://git.example/ar-lib.git', 7, ?, '修复空列表', 'merged', 'https://git.example/ar-lib/pull/7', 'main', 'fix/empty', ?, ?, ?, 'dev', '', '[]', ?, ?, ?)`,
).run(libId, headSha, mergeSha, t, t, t, t);
const prId = Number(insPr.lastInsertRowid);
const insSnap = await db.prepare(
  `INSERT INTO repo_snapshots (repo_url, commit_sha, rel_dir, version_label, source, source_pr_id, status, size_bytes, metadata_json, error, created_by, created_at, updated_at)
   VALUES ('https://git.example/ar-lib.git', ?, 'snapshots/ar-lib/v1.0.0', 'v1.0.0', 'pr', ?, 'ready', 1024, '{}', '', 'verify', ?, ?)`,
).run(mergeSha, prId, t, t);
const snapId = Number(insSnap.lastInsertRowid);
const insBl = await db.prepare(
  `INSERT INTO test_baselines (baseline_no, snapshot_id, library_id, repo_subpath, version_label, source, status, note, created_by, created_at, updated_at)
   VALUES ('BL-20260101-001', ?, ?, 'harmony/ar-lib', 'v1.0.0', 'pr', 'ready', 'B3 自检基线', 'verify', ?, ?)`,
).run(snapId, libId, t, t);
const baselineId = Number(insBl.lastInsertRowid);
await db.prepare('INSERT INTO baseline_prs (baseline_id, pr_id, relation, created_at) VALUES (?, ?, ?, ?)').run(baselineId, prId, 'source', t);

// 设备（报告 §1 执行时间行 · 设备型号）
const insDev = await db.prepare(
  `INSERT INTO devices (serial, model, os_version, status, created_at) VALUES ('SERIAL-X', 'TesterPhone 5.0', '5.0.0', 'offline', ?)`,
).run(t);
const deviceId = Number(insDev.lastInsertRowid);

// 场景资产（OneBox）+ 关联用例 → 报告 §2.5 / 资源集 / run_item_assets
const onebox = await sa.createAsset({ libraryId: libId, title: 'OneBox 空列表指引', kind: 'onebox_link', scenarioKind: 'empty', uri: 'https://onebox.example/doc/1', configGuideMd: '# 指导\n1. 打开 OneBox', createdBy: 'verify' });
await sa.linkCases(onebox.id, [caseId], 'precondition');

// 运行 + 运行项 + 资源集（recordRunItemAssets 生成 RS- 并登记 run_item_assets）
const runNo = await (await import('../lib/services/baseline.js')).nextRunNo();
const insRun = await db.prepare(
  `INSERT INTO test_runs (run_no, plan_id, trigger_kind, status, manifest_json, error, started_at, created_by, created_at, updated_at)
   VALUES (?, NULL, 'manual', 'running', '{}', '', ?, 'verify', ?, ?)`,
).run(runNo, t, t, t);
const runId = Number(insRun.lastInsertRowid);
const insItem = await db.prepare(
  `INSERT INTO test_run_items (run_id, library_id, baseline_id, commit_sha, repo_subpath, workspace_rel_dir, case_versions_json, status, started_at)
   VALUES (?, ?, ?, ?, '', ?, ?, 'running', ?)`,
).run(runId, libId, baselineId, mergeSha, `runs/${runNo}/ar-lib`, JSON.stringify({ [String(caseId)]: 2 }), t);
const runItemId = Number(insItem.lastInsertRowid);
const rs = await sa.recordRunItemAssets(runId, runItemId, libId, [caseId], runNo);
check(rs !== null && /^RS-\d{8}-001$/.test(rs.setNo), '资源集编号 RS-YYYYMMDD-001（运行登记）', rs?.setNo);

// 执行记录（工单链路快照的来源；含 actual_json / 日志 / 设备 / 用例版本）
const insExec = await db.prepare(
  `INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, test_run_id, run_item_id, baseline_id, case_version, library_version, commit_sha, actual_json, logs, started_at, finished_at)
   VALUES (NULL, ?, ?, ?, 'failed', '[]', 'TR-1', ?, ?, ?, 2, 'v1.2.0', ?, ?, ?, ?, ?)`,
).run(caseId, libId, deviceId, runId, runItemId, baselineId, mergeSha,
  JSON.stringify({ result: 'no_data_tip_missing' }), '[hilog] Empty list rendered without tip', t, t);
const execId = Number(insExec.lastInsertRowid);

// ---------- 1. 从执行建工单（§15.6-1 链路回填） ----------
console.log('\n— 建工单（链路快照） —');
await expectError(() => ir.createTicket({ caseId, symptom: '' }), '空现象拒绝（400）', '400');
await expectError(() => ir.createTicket({ caseId, symptom: 'x', executionId: 999999 }), '不存在的执行拒绝（404）', '404');
await expectError(() => ir.createTicket({ caseId: caseOther, symptom: 'x', executionId: execId }), '执行不属于该用例拒绝（400）', '400');
const tk = await ir.createTicket({ caseId, symptom: '空列表时没有出现"暂无数据"提示', executionId: execId });
check(/^IT-\d{14}-\d{5}[a-z0-9]+$/.test(tk.ticketNo), '工单编号 IT-<时间戳>-<序号><随机>', tk.ticketNo);
check(tk.executionId === execId, 'execution_id 精确绑定');
check(tk.testRunId === runId && tk.runItemId === runItemId, 'test_run_id / run_item_id 链路快照');
check(tk.baselineId === baselineId, 'baseline_id 链路快照');
check(tk.caseVersion === 2, '用例版本快照 V2');
check(tk.attribution === 'unknown', '初始归因 unknown（不预判）');

// 从用例发起：最近执行仅回填链路，execution_id 留空（不伪造绑定）
const tkCase = await ir.createTicket({ caseId: caseOther, symptom: '历史疑问' });
check(tkCase.executionId === null, '从用例发起 execution_id 留空');
await expectError(() => ir.createTicket({ caseId: 999999, symptom: 'x' }), '不存在的用例拒绝（404）', '404');

// ---------- 2. 归因枚举 + 根因落库 ----------
console.log('\n— 归因（枚举白名单） —');
check(ir.normalizeAttribution('demo') === 'demo', '合法归因原样通过');
check(ir.normalizeAttribution('bogus') === 'unknown', '非法归因 → unknown（白名单过滤）');
check(ir.normalizeAttribution(undefined) === 'unknown', '缺失归因 → unknown');
const verdict = {
  rootCause: 'Empty 组件未处理 data.length===0 分支，空态文案节点未挂载',
  attribution: 'library',
  confidence: 82,
  process: [
    { hypothesis: '用例预置条件不满足', checked: '执行日志显示已进入列表页且数据为空', result: 'excluded' },
    { hypothesis: 'Empty 组件缺空态分支', checked: '源码 Empty.ets 无 length===0 判断', result: 'confirmed' },
  ],
  evidence: [
    { kind: 'source', ref: 'harmony/ar-lib/src/main/ets/components/Empty.ets', line: 42, excerpt: 'build() { ForEach(this.data) }', supports: '无空态分支' },
    { kind: 'asset', ref: onebox.asset_no, line: 0, excerpt: 'OneBox 指导第 1 步', supports: '配置指导与现象相关' },
  ],
  fixSuggestions: ['Empty.ets build() 增加 if (this.data.length === 0) 空态节点'],
  needsDemoPatch: false,
  uncertainties: [],
  analysisBy: 'llm',
};
await ir.saveTicketRootCause(tk.id, verdict);
const tkRooted = await ir.loadTicket(tk.id);
check(tkRooted.status === 'root_caused' && tkRooted.attribution === 'library', '根因落库 → root_caused + attribution 列');
// 无真机 → 不伪造（§15.6-4）
await ir.saveTicketVerification(tk.id, { mode: 'skipped_no_device' }, 'verifying');

// ---------- 3. 报告生成 + 内容逐段断言（§15.6-1/3/4） ----------
console.log('\n— 报告生成（§9.5 模板） —');
const report = await ar.generateIssueReport(tk.id, { createdBy: 'verify' });
check(/^RP-\d{8}-\d{3}$/.test(report.reportNo), '报告编号 RP-YYYYMMDD-NNN', report.reportNo);
const mdFile = path.join(workspaceDir(), report.mdPath);
check(fs.existsSync(mdFile), '报告文件落盘（workspace/reports/<lib>/RP-*.md）', report.mdPath);
check(report.mdPath.startsWith(`reports/ar-lib/${report.reportNo}.md`), 'md_path 相对路径规范', report.mdPath);
const fileContent = fs.readFileSync(mdFile, 'utf8');
check(sha256(fileContent) === report.contentHash, 'content_hash == 文件 sha256（§15.6-2）');
check(report.content === fileContent, 'DB 正文与文件一致（双写）');
check(report.issueId === tk.id && report.executionId === execId && report.baselineId === baselineId && report.testRunId === runId, '报告行链路列齐全');

const mustContain = [
  ['# ar-lib / C-001 问题分析报告', '标题（库/用例）'],
  ['- 归因：**库本身**（library）', '§0 结论归因'],
  ['- 置信度：82', '§0 置信度'],
  ['- 一句话根因：Empty 组件未处理 data.length===0 分支，空态文案节点未挂载', '§0 根因'],
  [`- 工单：${tk.ticketNo}`, '§1 工单号'],
  ['- 用例：C-001 空列表边界 / V2', '§1 用例版本'],
  ['- 需求：RQ-001 列表为空时提示', '§1 需求（B4 链路）'],
  [`- PR：#7（merge ${mergeSha.slice(0, 12)}）`, '§1 PR + merge commit'],
  [`- 执行：#${execId} · failed`, '§1 执行绑定'],
  ['- 执行时间：' , '§1 执行时间行'],
  ['TesterPhone 5.0', '§1 设备型号'],
  [`- 运行：${runNo}`, '§1 运行编号'],
  ['- 基线：BL-20260101-001（v1.0.0）', '§1 基线编号'],
  [`commit ${mergeSha.slice(0, 12)}`, '§1 基线 commit'],
  [`- 资源集：${rs.setNo}`, '§1 资源集'],
  [`${onebox.asset_no} V1（recorded）`, '§1 运行登记资产'],
  ['- 库版本：v1.2.0', '§1 库版本'],
  ['### 2.1 预置条件', '§2.1 预置条件标题'],
  ['已登录且列表为空', '§2.1 预置条件内容'],
  ['1. 进入列表页', '§2.2 步骤'],
  ['### 2.3 预期结果', '§2.3 预期标题'],
  ['页面显示"暂无数据"', '§2.3 预期内容'],
  ['### 2.4 机器判据（oracle）', '§2.4 oracle'],
  [`**${onebox.asset_no} OneBox 空列表指引**`, '§2.5 场景资产'],
  ['# 指导', '§2.5 配置指导摘录'],
  ['### 2.6 问题现象（人提交）', '§2.6 现象标题'],
  ['空列表时没有出现"暂无数据"提示', '§2.6 现象内容'],
  ['- 结构化实际结果（actual_json）', '§3 actual_json'],
  ['no_data_tip_missing', '§3 actual 内容'],
  ['## 4. 分析过程', '§4 分析过程标题'],
  ['- 假设 A：用例预置条件不满足', '§4 假设 A'],
  ['结论：排除', '§4 排除结论'],
  ['- 假设 B：Empty 组件缺空态分支', '§4 假设 B'],
  ['结论：成立', '§4 成立结论'],
  ['## 5. 证据', '§5 证据标题'],
  ['| source | harmony/ar-lib/src/main/ets/components/Empty.ets:42', '§5 证据表 source'],
  [`| asset | ${onebox.asset_no}`, '§5 证据表 asset'],
  ['## 6. 修复建议', '§6 修复建议标题'],
  ['增加 if (this.data.length === 0) 空态节点', '§6 建议'],
  ['## 7. 验证与验收', '§7 验证标题'],
  ['- 自测试：**未验证：无在线真机**（不伪造通过）', '§7 无真机不伪造（§15.6-4）'],
  ['- 人工验收：未验收', '§7 未验收'],
  ['- 知识沉淀：（未沉淀 —— 接受验收后自动生成）', '§7 未沉淀标注'],
  ['[hilog] Empty list rendered without tip', '§3 执行日志尾部'],
];
for (const [needle, label] of mustContain) check(report.content.includes(needle), `报告含：${label}`, needle.slice(0, 40));

// ---------- 4. 正文双写兜底：文件丢失回退 DB（§15.6-2 反面） ----------
console.log('\n— 文件丢失回退 DB —');
const viaFile = await ar.getReportMarkdown(report.id);
check(viaFile.source === 'file' && viaFile.content === fileContent, '文件在 → source=file 正文一致');
fs.unlinkSync(mdFile);
const viaDb = await ar.getReportMarkdown(report.id);
check(viaDb.source === 'db' && viaDb.content === fileContent, '文件丢失 → 回退 DB 正文一致（审计资产不丢）');
fs.writeFileSync(mdFile, fileContent, 'utf8');

// ---------- 5. 归因修正（必留理由 + 历史追加） ----------
console.log('\n— 归因修正 —');
await expectError(() => ir.updateTicketAttribution({ ticketId: tk.id, attribution: 'environment', reason: '  ' }), '空修正理由拒绝（400）', '400');
await expectError(() => ir.updateTicketAttribution({ ticketId: 999999, attribution: 'environment', reason: 'x' }), '不存在的工单拒绝（404）', '404');
const fixed = await ir.updateTicketAttribution({ ticketId: tk.id, attribution: 'environment', reason: '真机复测发现同版本 demo 正常，设备 hdc 版本过旧', by: 'verifier' });
check(fixed.attribution === 'environment', '修正后归因 environment');
check(fixed.attributionReason.includes('library → environment'), '修正历史含 原归因→新归因');
check(fixed.attributionReason.includes('设备 hdc 版本过旧'), '修正历史含理由');

// ---------- 6. 不可变：重新生成 = 新报告（§15.6-6） ----------
console.log('\n— 重新生成（不可变） —');
const savedFlag = getSetting('feature.mdReport', true);
setSetting('feature.mdReport', false);
await expectError(() => ar.generateIssueReport(tk.id), 'feature.mdReport=false → 403', '403');
setSetting('feature.mdReport', savedFlag);

const report2 = await ar.generateIssueReport(tk.id, { createdBy: 'verify' });
check(report2.reportNo !== report.reportNo, '重新生成产生新 report_no', `${report.reportNo} → ${report2.reportNo}`);
check(fs.existsSync(mdFile), '旧报告文件保留（不覆盖）');
const oldRow = await ar.getReport(report.id, { withContent: true });
check(oldRow !== null && oldRow.contentHash === report.contentHash, '旧报告行不动（hash 不变）');
check(report2.content.includes('- 归因：**环境（设备/工具链）**（environment）'), '新报告反映修正后归因');
check(report2.content.includes('归因修正记录：'), '新报告含修正记录');
const tkFinal = await ir.loadTicket(tk.id);
check(tkFinal.reportId === report2.id, '工单 report_id 指向最新报告');
const byIssue = await ar.getReportByIssue(tk.id);
check(byIssue !== null && byIssue.id === report2.id, 'getReportByIssue 返回最新报告');
const all = await ar.listReports({ libraryId: libId });
check(all.length === 2 && all.every((r) => r.content === undefined || r.content === ''), 'listReports 列表不带正文（omitContent）', String(all.length));

// ---------- 7. 验收：知识条目 + 报告保留（§15.6-5） ----------
console.log('\n— 验收（接受 → 知识沉淀） —');
await expectError(() => ir.decideTicket({ ticketId: tk.id, accept: true, reason: '' }), '空验收结论拒绝（400）', '400');
const beforeAccept = await ir.loadTicket(tk.id);
const accepted = await ir.decideTicket({ ticketId: tk.id, accept: true, reason: '根因成立，按建议补空态分支', by: 'verifier' });
check(accepted.status === 'accepted' && accepted.verdict === 'accepted', '接受 → accepted');
// 沉淀知识（与 http.ts POST /issues/:id/accept 同一路径）
const entry = await kn.sediteFromQueue({
  libraryId: accepted.libraryId, libraryName: 'ar-lib',
  caseNo: 'C-001', stage: 'issue_root_cause',
  reason: `问题现象：${accepted.symptom}`, question: '请人工确认根因是否成立',
  resolution: `根因：${beforeAccept.rootCause?.rootCause ?? ''}\n人工验收：根因成立，按建议补空态分支`,
  payload: { ticketId: accepted.id, ticketNo: accepted.ticketNo },
});
check(entry.id.startsWith('kn-'), '知识条目生成（kn- 编号）', entry.id);
await db.prepare('UPDATE issue_tickets SET knowledge_id = ?, updated_at = ? WHERE id = ?').run(entry.id, now(), tk.id);
const tkDone = await ir.loadTicket(tk.id);
check(tkDone.knowledgeId === entry.id, '工单 knowledge_id 回填');
check(fs.existsSync(mdFile) && fs.existsSync(path.join(workspaceDir(), report2.mdPath)), '验收后报告文件保留（§15.6-5）');
const rowAfterAccept = await ar.getReport(report.id, { withContent: true });
check(rowAfterAccept !== null && rowAfterAccept.contentHash === report.contentHash && rowAfterAccept.createdAt === report.createdAt, '验收不改报告行（不可变）');

// 重新生成拒绝：POST /issues/:id/report 要求 rootCause（服务层同校验）——已 root_caused 的工单可重生成，验证 rootCause 缺失场景
const tkNoRoot = await ir.createTicket({ caseId: caseOther, symptom: '待分析' });
const ctxNoRoot = await ar.buildIssueReportContext(tkNoRoot.id);
check(ctxNoRoot.execution === null && ctxNoRoot.baseline === null, '无执行/无基线工单上下文不炸（未知如实呈现）');
const mdNoRoot = ar.renderIssueReport(ctxNoRoot);
check(mdNoRoot.includes('- 执行：无执行记录（未绑定具体执行）'), '无执行报告标注"未绑定"');
check(mdNoRoot.includes('- 基线：未知（历史数据或未走基线链路）'), '无基线报告标注"未知"');
check(mdNoRoot.includes('- 需求：未关联'), '无需求报告标注"未关联"');
check(mdNoRoot.includes('- PR：未关联（历史数据或非 PR 来源基线）'), '无 PR 报告标注"未关联"');
check(mdNoRoot.includes('- 自测试：未验证（无验证记录）'), '无验证记录不伪造');

console.log(`\n${fail === 0 ? 'ALL PASS' : `FAILED: ${fail}`}  （临时目录：${tmpDir}）`);
process.exit(fail === 0 ? 0 : 1);
