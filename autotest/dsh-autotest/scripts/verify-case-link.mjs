// P11 用例 ↔ 接口关联层的自检（无设备、无 LLM；用临时 SQLite 库 + 临时工作区，不碰用户数据）。
//
// 这套要钉住的核心事实只有一句：**一条没有 api_symbol_id 的「初版用例」，必须能进入覆盖矩阵的
// 「用例」列**。这正是 P3 矩阵原先做不到的事（它只看 cases.api_symbol_id，而那一列只有矩阵驱动
// 生成时才写入），也是"矩阵无法回答初版用例覆盖到什么程度"的根因。
//
// 另外三条纪律同样逐条钉：
//   ① 每条关联必须有依据（basis）与置信度，弱证据只列出、不据此判覆盖；
//   ② 人工确认（manual）的关联在重新关联时不得被覆盖；
//   ③ 重新关联是幂等的（跑两次结果一致，不累积重复行）。
//
// 用法：npm run build && npm run verify:case-link
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3 与 workspace
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-link-db-'));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-link-ws-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = tmpWs;
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const {
  inferLinks, resolveCaseRoute, nameHits, isTrustedLink, BASIS_LABEL,
  linkCasesForLibrary, listLinks, setManualLink, loadLinksBySymbol, renderLinkReport,
} = await import('../lib/services/caseLink.js');
const { symbolCases, summarizeMatrix, buildCoverageMatrix } = await import('../lib/services/coverageMatrix.js');
const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} · 临时工作区：${tmpWs} —\n`);

// ---------- 0. 纯规则用的小工具 ----------
const traversalOf = (entries) => ({
  reportFile: 'fake.json',
  routes: new Map(entries.map((e) => [e.route, { controls: e.controls ?? [], path: e.path ?? [] }])),
  allControls: entries.flatMap((e) => e.controls ?? []),
  breadcrumbToRoute: new Map(entries.filter((e) => e.path?.length).map((e) => [e.path.join(' → '), e.route])),
});
const caseOf = (over = {}) => ({
  id: 1, caseNo: 'C-1', name: '用例', steps: ['打开应用'], expected: '', pagePath: '', apiSymbolId: null, ...over,
});
const symOf = (over = {}) => ({
  id: 10, name: 'validate', kind: 'function', methods: [], demoCallPages: [], deviceControls: [], ...over,
});

// ---------- 1. 页面写法对齐（面包屑 ↔ 路由名） ----------
console.log('— 页面写法对齐（初版用例记的是面包屑，接口记的是路由名）—');
{
  const ev = traversalOf([
    { route: 'pages/SimpleValidatePage', path: ['首页', '简单校验'], controls: ['校验', '校验通过'] },
    { route: 'pages/ComplicatedPage', path: ['首页', '复杂校验'], controls: ['提交'] },
  ]);
  eq(resolveCaseRoute('首页 → 简单校验', ev).route, 'pages/SimpleValidatePage', '面包屑完全匹配 → 路由');
  eq(resolveCaseRoute('简单校验', ev).route, 'pages/SimpleValidatePage', '模型把面包屑写短（只剩页面名）也能认');
  eq(resolveCaseRoute('pages/ComplicatedPage', ev).route, 'pages/ComplicatedPage', '用例直接写路由名也能认');
  eq(resolveCaseRoute('不存在页面', ev).route, '', '认不出就返回空 —— 不硬猜');
  eq(resolveCaseRoute('', ev).route, '', '空页面路径返回空');
  eq(resolveCaseRoute('首页 → 简单校验', null).route, '', '没有遍历报告时不猜');
}

// ---------- 2. inferLinks 的四类依据与优先级 ----------
console.log('\n— 关联依据（explicit > page > name）—');
{
  const ev = traversalOf([
    { route: 'pages/Y', path: ['首页', 'Y页'], controls: ['校验', '校验通过', '提交'] },
  ]);
  const s1 = symOf({ id: 10, name: 'validate', demoCallPages: ['pages/Y'], deviceControls: ['校验', '校验通过'] });
  const s2 = symOf({ id: 11, name: 'serialize', demoCallPages: ['pages/Z'], deviceControls: [] });
  const s3 = symOf({ id: 12, name: 'unrelatedThing', demoCallPages: [], deviceControls: [] });

  // ① 生成时指定：最强
  const explicit = inferLinks(caseOf({ apiSymbolId: 10, pagePath: '首页 → Y页' }), [s1, s2, s3], ev);
  eq(explicit.map((l) => [l.symbolId, l.basis, l.confidence]), [[10, 'explicit', 'high']], '生成时指定 → explicit/high（不再重复算页面命中）');

  // ② 页面命中：初版用例（api_symbol_id 为空）也能命中
  const byPage = inferLinks(caseOf({ pagePath: '首页 → Y页', steps: ['打开应用', '点击「校验」'] }), [s1, s2, s3], ev);
  eq(byPage.map((l) => [l.symbolId, l.basis, l.confidence]), [[10, 'page', 'high']], '页面命中 → page/high（这是初版用例进矩阵的关键路径）');
  check(byPage[0].detail.includes('pages/Y'), '关联依据写清了命中的路由（可核对）', byPage[0].detail.slice(0, 80));
  check(byPage[0].detail.includes('校验'), '步骤引用的控件也作为佐证写进依据');

  // ③ 名称命中：弱证据，标 medium，不参与覆盖判定
  const byName = inferLinks(caseOf({ name: '调用 validate 校验失败', pagePath: '首页 → 其他页' }), [s1, s2, s3], ev);
  eq(byName.map((l) => [l.symbolId, l.basis, l.confidence]), [[10, 'name', 'medium']], '名称命中 → name/medium');
  check(!isTrustedLink({ confidence: 'low' }) && isTrustedLink({ confidence: 'medium' }), 'low 不参与覆盖判定，medium/high 参与');

  // ④ 什么都不命中 → 不产生关联（宁可不关联，也不硬绑）
  eq(inferLinks(caseOf({ name: '随便点点', pagePath: '首页 → 其他页' }), [s1, s2, s3], ev).length, 0, '无任何证据 → 不产生关联');

  // ⑤ 类型符号不做推断关联（类型没有运行时行为）
  const typeSym = symOf({ id: 20, name: 'SchemaError', kind: 'type', demoCallPages: ['pages/Y'] });
  eq(inferLinks(caseOf({ pagePath: '首页 → Y页' }), [typeSym], ev).length, 0, '类型符号不做推断关联（只在生成时指定时才关联）');
  eq(inferLinks(caseOf({ apiSymbolId: 20 }), [typeSym], ev).map((l) => l.basis), ['explicit'], '类型符号仍可按"生成时指定"关联（保留溯源）');

  // ⑥ 名称命中的词边界：不能把 ValidatorList 当成 Validator
  eq(nameHits('点开 ValidatorList 页面', 'Validator', []).length, 0, '英文名按词边界匹配（ValidatorList 不算命中 Validator）');
  eq(nameHits('调用 Validator 校验', 'Validator', []).length, 1, '完整词命中');
  eq(nameHits('调用了 validate()', 'Validator', ['validate']).length, 1, '方法名命中');
  eq(nameHits('任意文本', 'ab', []).length, 0, '过短的符号名不参与文本匹配（避免误伤）');
}

// ---------- 3. 矩阵装配：并集 + 弱关联单列 ----------
console.log('\n— 矩阵装配（关联用例与 api_symbol_id 用例取并集）—');
{
  const caseRows = [
    { id: 1, case_no: 'C-1', name: '初版用例', scenario_kind: 'happy', api_symbol_id: null },
    { id: 2, case_no: 'C-2', name: '矩阵生成用例', scenario_kind: 'boundary', api_symbol_id: 10 },
    { id: 3, case_no: 'C-3', name: '弱关联用例', scenario_kind: 'empty', api_symbol_id: null },
  ];
  const links = [
    { caseId: 1, caseNo: 'C-1', basis: 'page', confidence: 'high' },
    { caseId: 3, caseNo: 'C-3', basis: 'name', confidence: 'low' },
  ];
  const r = symbolCases(10, caseRows, links);
  eq(r.cases.map((c) => c.caseNo).sort(), ['C-1', 'C-2'], '初版用例（无 api_symbol_id）与矩阵用例都在 cases 里');
  eq(r.weakCases.map((c) => c.caseNo), ['C-3'], '弱关联单列进 weakCases');

  // 汇总口径：weakCases 不影响"有用例"的判定
  const mk = (over) => ({
    symbolId: 1, symbolName: 'S', kind: 'function', status: 'partial', statusReason: '', riskFlags: [],
    scenarioFit: { happy: true, empty: false, boundary: false, bigdata: false },
    evidence: { testCallCount: 0, traversalReport: '', deviceControls: [], devicePagePath: '', caseNos: [], negativeCaseNos: [], paramPoints: [] },
    deviceReachable: false, ...over,
  });
  const s = mk({ evidence: { ...mk({}).evidence, caseNos: ['C-1'], weakLinkCaseNos: ['C-3'] } });
  eq(summarizeMatrix([s], { unlinkedCases: 4, totalCases: 9 }).unlinkedCases, 4, '未关联用例数进汇总（矩阵页要显示它）');
  eq(summarizeMatrix([s]).unlinkedCases, 0, '不传则默认为 0（不虚报）');
}

// ---------- 4. 落库：幂等 / 人工保护 / 未关联统计 ----------
console.log('\n— 落库（临时库真实写入）—');
const libRes = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, last_commit, package_name, main_ability, status, created_at, updated_at)
  VALUES (?, '', '自检库', '1.0.0', '', '', '', 'active', ?, ?)`).run('link-fixture-lib', now(), now());
const libId = Number(libRes.lastInsertRowid ?? libRes.lastID);

const t = now();
// 遍历报告：让"面包屑 → 路由"能建立起来（与真机报告同构）
const exploreDir = path.join(tmpWs, 'explore', 'link-fixture-lib');
fs.mkdirSync(exploreDir, { recursive: true });
fs.writeFileSync(path.join(exploreDir, 'r1.json'), JSON.stringify({
  pages: [{ path: ['首页', '校验页'], controls: [{ text: '校验' }, { text: '校验通过' }] }],
  ops: [{ action: '进入判定', detail: '点击「校验页」→ 进入新页面 · pagePath=pages/Y' }],
}), 'utf8');

await db.prepare(`INSERT INTO api_symbols (library_id, library_version, name, kind, signature, detail_level, params_json, returns_json, throws_json, source_file, source_line, methods_json, doc_refs, created_at, updated_at)
  VALUES (?, '1.0.0', 'validate', 'function', '(a)', 'full', '[]', '{}', '[]', 'library/index.ts', 12, '[]', '[]', ?, ?)`).run(libId, t, t);
const symId = Number((await db.prepare('SELECT id FROM api_symbols WHERE library_id = ? AND name = ?').get(libId, 'validate')).id);
await db.prepare(`INSERT INTO demo_assets (library_id, library_version, kind, name, page_path, source_file, source_line, snippet, created_at)
  VALUES (?, '1.0.0', 'call', 'validate', 'pages/Y', 'entry/src/main/ets/pages/Y.ets', 30, 'v.validate()', ?)`).run(libId, t);

const insertCase = async (caseNo, name, steps, apiSym, pagePath) => {
  const res = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, api_symbol_id, scenario_kind, priority, oracle_json, created_at, updated_at)
    VALUES (?, ?, ?, 'AI 生成', '', ?, '期望', '待确认', '未绑定', 1, ?, 'happy', 'P1', '[]', ?, ?)`)
    .run(libId, caseNo, name, JSON.stringify(steps), apiSym, t, t);
  const id = Number(res.lastInsertRowid ?? res.lastID);
  // 用例所属页面只存版本快照（cases 表没有 page_path 列）—— 关联层必须读快照才拿得到
  await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
    VALUES (?, 1, ?, '', '测试', 'ai', ?)`).run(id, JSON.stringify({ id, caseNo, name, steps, pagePath }), t);
  return id;
};
// 初版（遍历）用例：没有 api_symbol_id，只有页面面包屑
const c1 = await insertCase('C-AI-001', '校验通过后提示', ['打开应用', '点击「校验」', '验证「校验通过」'], null, '首页 → 校验页');
// 与任何接口都无关的用例
const c2 = await insertCase('C-AI-002', '随便看看界面', ['打开应用', '点击「帮助」'], null, '');
// 矩阵驱动生成的用例：带 api_symbol_id
const c3 = await insertCase('C-AI-003', '空 schema 边界', ['打开应用', '点击「校验」'], symId, '首页 → 校验页');

const run1 = await linkCasesForLibrary(libId);
check(run1.links >= 2, '初版用例与矩阵用例都被关联上', JSON.stringify(run1.byBasis));
eq(run1.totalCases, 3, '用例总数');
eq(run1.unlinkedCases, 1, '未关联用例数 = 1（那条与任何接口无关的用例）');
const links1 = await listLinks(libId);
const c1links = links1.filter((l) => l.caseNo === 'C-AI-001');
check(c1links.some((l) => l.basis === 'page' && l.symbolName === 'validate'), '★ 初版用例（api_symbol_id 为空）被 page 依据关联到接口', JSON.stringify(c1links.map((l) => [l.basis, l.symbolName])));
check(links1.every((l) => l.detail.length > 0), '每条关联都带可核对的依据说明');
check(links1.some((l) => l.caseNo === 'C-AI-003' && l.basis === 'explicit'), '矩阵用例按 explicit 关联（保留原溯源）');

// 幂等：再跑一次，行数与依据不变
const run2 = await linkCasesForLibrary(libId);
const links2 = await listLinks(libId);
eq(links2.length, links1.length, '重新关联是幂等的（不累积重复行）');
eq(run2.links, run1.links, '重新关联条数一致');

// 人工保护：人工确认后，重跑不得被自动依据覆盖/删除
await setManualLink(c2, symId, true);
const manualBefore = (await listLinks(libId)).find((l) => l.caseNo === 'C-AI-002' && l.symbolId === symId);
check(manualBefore?.basis === 'manual', '人工确认写入 basis=manual');
const run3 = await linkCasesForLibrary(libId);
const manualAfter = (await listLinks(libId)).find((l) => l.caseNo === 'C-AI-002' && l.symbolId === symId);
check(manualAfter?.basis === 'manual' && manualAfter.confidence === 'high', '★ 重新关联不覆盖人工确认（人手改的不能被机器冲掉）');
eq(run3.preservedManual, 1, '报告里说明保留了人工关联条数');
eq(run3.unlinkedCases, 0, '人工确认后未关联数降为 0');

// 取消人工关联
await setManualLink(c2, symId, false);
eq((await listLinks(libId)).filter((l) => l.caseNo === 'C-AI-002').length, 0, '取消人工关联生效');

// ---------- 5. 端到端：初版用例出现在矩阵的「用例」列 ----------
console.log('\n— 端到端：矩阵是否看得见初版用例 —');
{
  const built = await buildCoverageMatrix(libId);
  const row = built.matrix.find((r) => r.symbolId === symId);
  check(!!row, '矩阵里有该接口的行');
  check(row.evidence.caseNos.includes('C-AI-001'), '★ 初版用例 C-AI-001 出现在矩阵的「用例」列', JSON.stringify(row.evidence.caseNos));
  check(row.evidence.caseNos.includes('C-AI-003'), '矩阵生成的用例 C-AI-003 也在（两条来源取并集，不互相顶掉）');
  const refs = row.evidence.caseRefs ?? [];
  check(refs.some((r) => r.caseNo === 'C-AI-001' && r.basis === 'page'), '矩阵证据里写明该用例的关联依据（前端可展示）');
  eq(built.summary.totalCases, 3, '汇总带出用例总数');
  // 上一步已取消人工关联，所以此时未关联数应为 1（C-AI-002 又与接口无关了）
  eq(built.summary.unlinkedCases, 1, '汇总带出未关联用例数（构建路径）');
  const loaded = await (await import('../lib/services/coverageMatrix.js')).loadCoverageMatrix(libId);
  eq(loaded.summary.unlinkedCases, 1, '读取已落库矩阵时的未关联数与构建路径一致（两条路径口径必须相同）');
}

// ---------- 6. 「初版草稿」的判定（决定整合任务升级谁） ----------
console.log('\n— 初版草稿判定（决定整合任务升级谁）—');
{
  const { isDraftCase } = await import('../lib/services/caseLink.js');
  const { validateOracles } = await import('../lib/services/oracle.js');
  check(isDraftCase('[]', validateOracles), '判据为空 → 草稿');
  check(isDraftCase('', validateOracles), '判据字段为空 → 草稿');
  check(isDraftCase('not-json', validateOracles), '判据解析不出来 → 草稿（不能当成有判据）');
  check(isDraftCase(JSON.stringify([{ type: 'control_text', control: '正常' }]), validateOracles), '指向笼统控件的判据 → 仍算草稿');
  check(isDraftCase(JSON.stringify([{ type: 'script_assert', expr: 'true' }]), validateOracles), '恒真断言 → 仍算草稿（等于没断言）');
  check(!isDraftCase(JSON.stringify([{ type: 'control_text', control: '校验通过' }]), validateOracles), '有可核对判据 → 不是草稿（不再重复升级）');
}

// ---------- 7. 报告文案 ----------
console.log('\n— 关联报告 —');
{
  const text = renderLinkReport({ name: 'link-fixture-lib' }, { libraryId: libId, links: 3, linkedCases: 2, totalCases: 3, unlinkedCases: 1, byBasis: { page: 2, explicit: 1 }, preservedManual: 0 });
  check(text.includes('未关联 1 条'), '报告明确写出未关联条数（这是要推动人清理的数字）', '');
  check(text.includes(BASIS_LABEL.page), '报告把依据翻译成人话');
}

// SQLite 连接句柄在进程内仍开着，临时库文件删不掉是正常的（Windows 会报 EBUSY）——
// 清理失败不影响结论，且目录在 %TEMP% 下，绝不能因为清理报错把自检判成失败。
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 句柄未释放，交给系统清理 */ }
try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch { /* 同上 */ }
console.log(fail === 0 ? '\n全部自检通过' : `\n自检失败：${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
