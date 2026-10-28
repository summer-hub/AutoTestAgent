// B2 场景资产链路自检：不连 MySQL、不调 LLM、不需要设备。
//  1. OneBox 资产：uri+指导必填、SA- 编号、创建即有 V1 版本史
//  2. 本地资产：base64 文件写入（sha256/大小/版本 bump）、manifest.json + README.md 生成、路径安全（.. / 绝对路径 / 保留字拒绝）
//  3. 静态校验：onebox / 本地资产 validate 通过 → validated；文件篡改 → sha 漂移检出
//  4. 关联：link-cases 同库校验（跨库 400）、link-requirements
//  5. 资源集：recordRunItemAssets 建集（RS- 编号、版本/sha 快照）、run_item_assets 登记、resource_set_id 回填
//  6. 应用：applyAssetToDir 复制校验（sha 后复制）、applyAssetToRunItem 登记幂等
//  7. 生命周期：deprecate 下架、删除保护（有引用 409）、zip 下载结构（PK 头）
// 用法：npm run build && npm run verify:scenario-assets
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ⚠️ 必须指向临时目录：绝不碰用户正在使用的 data/autotest.sqlite3 与真实工作区
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-scenario-'));
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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
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
const baseline = await import('../lib/services/baseline.js');

const t = now();

// ---------- 库 / 用例 / 需求 / 运行骨架 ----------
const insLib = await db.prepare(
  `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
   VALUES ('sa-lib', '', '', 'B2 自检库', 'v0.0.1', '', 'active', ?, ?)`,
).run(t, t);
const libId = Number(insLib.lastInsertRowid);
const insLib2 = await db.prepare(
  `INSERT INTO libraries (name, repo_url, repo_subpath, description, current_version, last_commit, status, created_at, updated_at)
   VALUES ('sa-lib2', '', '', 'B2 自检库2', 'v0.0.1', '', 'active', ?, ?)`,
).run(t, t);
const libId2 = Number(insLib2.lastInsertRowid);
const insCase = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, current_version, created_at, updated_at)
   VALUES (?, 'C-001', '空列表边界', '新需求引入', '', '[]', '[]', 'active', 1, ?, ?)`,
).run(libId, t, t);
const caseId = Number(insCase.lastInsertRowid);
const insCase2 = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, current_version, created_at, updated_at)
   VALUES (?, 'C-002', '大数据量', '新需求引入', '', '[]', '[]', 'active', 1, ?, ?)`,
).run(libId, t, t);
const caseId2 = Number(insCase2.lastInsertRowid);
const insCaseOther = await db.prepare(
  `INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, current_version, created_at, updated_at)
   VALUES (?, 'C-101', '别库用例', '新需求引入', '', '[]', '[]', 'active', 1, ?, ?)`,
).run(libId2, t, t);
const caseOther = Number(insCaseOther.lastInsertRowid);
const insReq = await db.prepare(
  `INSERT INTO requirements (requirement_no, external_id, source, title, url, primary_library_id, status, acceptance_md, created_at, updated_at)
   VALUES ('RQ-001', '', 'manual', '列表为空时提示', '', ?, 'active', '', ?, ?)`,
).run(libId, t, t);
const reqId = Number(insReq.lastInsertRowid);

// ---------- 1. OneBox 资产 ----------
console.log('\n— OneBox 资产 —');
await expectError(() => sa.createAsset({ libraryId: libId, title: '缺链接', kind: 'onebox_link', configGuideMd: 'x' }), 'OneBox 缺 uri 拒绝（400）', '400');
await expectError(() => sa.createAsset({ libraryId: libId, title: '坏链接', kind: 'onebox_link', uri: 'ftp://x', configGuideMd: 'x' }), 'OneBox 非 http/https 拒绝（400）', '400');
await expectError(() => sa.createAsset({ libraryId: libId, title: '缺指导', kind: 'onebox_link', uri: 'https://onebox.example/doc' }), 'OneBox 缺配置指导拒绝（400）', '400');
const onebox = await sa.createAsset({ libraryId: libId, title: 'OneBox 空列表指引', kind: 'onebox_link', scenarioKind: 'empty', uri: 'https://onebox.example/doc/1', configGuideMd: '# 指导\n步骤…', createdBy: 'verify' });
check(/^SA-\d{8}-001$/.test(onebox.asset_no), 'OneBox 资产编号 SA-YYYYMMDD-001', onebox.asset_no);
check(onebox.status === 'draft' && onebox.version === '1', '创建即 draft / V1', `${onebox.status}/${onebox.version}`);
const oneboxVersions = await db.prepare('SELECT version, sha256 FROM scenario_asset_versions WHERE asset_id = ?').all(onebox.id);
check(oneboxVersions.length === 1 && oneboxVersions[0].version === '1', '创建即落 V1 版本史（sha256 可查）');
await expectError(() => sa.writeAssetFiles(onebox.id, [{ path: 'a.txt', contentBase64: b64('x') }]), 'OneBox 资产拒绝上传文件（400）', '400');

// ---------- 2. 本地资产 ----------
console.log('\n— 本地资产（demo_page）—');
const page = await sa.createAsset({ libraryId: libId, title: '空列表 demo 页', kind: 'demo_page', scenarioKind: 'empty', entryHint: 'pages/Empty.ets', configGuideMd: '# 配置\n…', createdBy: 'verify' });
check(/^SA-\d{8}-002$/.test(page.asset_no), '第二个资产编号 -002', page.asset_no);
const pageDir = path.join(workspaceDir(), page.rel_dir);
check(page.rel_dir.startsWith('scenario-assets/sa-lib/SA-'), '本地资产 rel_dir 规范', page.rel_dir);

await expectError(() => sa.writeAssetFiles(page.id, [{ path: '../evil.txt', contentBase64: b64('x') }]), '路径含 .. 拒绝（400）', '400');
await expectError(() => sa.writeAssetFiles(page.id, [{ path: '/abs/evil.txt', contentBase64: b64('x') }]), '绝对路径拒绝（400）', '400');
await expectError(() => sa.writeAssetFiles(page.id, [{ path: 'manifest.json', contentBase64: b64('x') }]), '保留字 manifest.json 拒绝（400）', '400');
await expectError(() => sa.writeAssetFiles(page.id, [{ path: 'a.txt', contentBase64: '' }]), '空内容拒绝（400）', '400');

const etsContent = '@Entry\nstruct Empty { build() {} }\n';
const jsonContent = '{"kind":"empty"}\n';
const w1 = await sa.writeAssetFiles(page.id, [
  { path: 'pages/Empty.ets', contentBase64: b64(etsContent), role: 'page' },
  { path: 'resources/empty.json', contentBase64: b64(jsonContent), role: 'fixture' },
], { note: '首批' });
check(w1.version === '2', '写入后版本 bump 到 2', w1.version);
check(w1.written[0].sha256 === sha256(etsContent), '文件 sha256 与内容一致');
check(fs.existsSync(path.join(pageDir, 'pages', 'Empty.ets')), '文件落盘（子目录）');
check(fs.existsSync(path.join(pageDir, 'manifest.json')), 'manifest.json 生成');
check(fs.existsSync(path.join(pageDir, 'README.md')), 'README.md 生成');
const manifest = JSON.parse(fs.readFileSync(path.join(pageDir, 'manifest.json'), 'utf8'));
check(manifest.assetNo === page.asset_no && manifest.version === '2', 'manifest 含编号与版本');
check(manifest.files.length === 2 && manifest.files[0].path === 'pages/Empty.ets', 'manifest 文件清单完整');
check(manifest.sha256 === w1.asset.sha256, 'manifest 与 DB 的资产指纹一致');

// 覆盖写入 → 版本 3，sha 变化
const w2 = await sa.writeAssetFiles(page.id, [{ path: 'pages/Empty.ets', contentBase64: b64(etsContent + '// v3\n'), role: 'page' }], { note: '覆盖' });
check(w2.version === '3' && w2.asset.sha256 !== w1.asset.sha256, '覆盖写入版本 3 且指纹变化', `${w2.version}`);
const versions = await db.prepare('SELECT version, sha256 FROM scenario_asset_versions WHERE asset_id = ? ORDER BY CAST(version AS UNSIGNED)').all(page.id);
check(versions.length === 3, '版本史 3 条（创建+两批）', String(versions.length));
check(versions[1].sha256 === w1.asset.sha256 && versions[2].sha256 === w2.asset.sha256, '每版 sha256 可查（§15.5）');

// ---------- 3. 静态校验 ----------
console.log('\n— 静态校验 —');
const vOnebox = await sa.validateAsset(onebox.id, 'static');
check(vOnebox.ok, 'OneBox 静态校验通过', vOnebox.problems.join('|'));
const vPage = await sa.validateAsset(page.id, 'static');
check(vPage.ok, '本地资产静态校验通过（目录/manifest/sha）', vPage.problems.join('|'));
const pageRow = await db.prepare('SELECT status, validated_at FROM scenario_assets WHERE id = ?').get(page.id);
check(pageRow.status === 'validated' && pageRow.validated_at, '校验通过 → validated + validated_at');
await expectError(() => sa.validateAsset(page.id, 'compile'), 'compile 级暂未支持（400）', '400');
// 篡改磁盘文件 → sha 漂移检出
fs.writeFileSync(path.join(pageDir, 'pages', 'Empty.ets'), 'tampered\n');
const vTampered = await sa.validateAsset(page.id, 'static');
check(!vTampered.ok && vTampered.problems.some((p) => p.includes('sha256 不一致')), '文件篡改 → sha256 漂移检出并回退 draft', vTampered.problems[0]);
fs.writeFileSync(path.join(pageDir, 'pages', 'Empty.ets'), etsContent + '// v3\n');
const vRestored = await sa.validateAsset(page.id, 'static');
check(vRestored.ok, '恢复后重新校验通过');

// ---------- 4. 关联 ----------
console.log('\n— 关联 —');
const linked = await sa.linkCases(page.id, [caseId, caseId2], 'precondition');
check(linked.linked === 2, 'link-cases 关联同库两用例');
await expectError(() => sa.linkCases(page.id, [caseOther]), '跨库用例拒绝（400）', '400');
const linkedReq = await sa.linkRequirements(page.id, [reqId]);
check(linkedReq.linked === 1, 'link-requirements 关联需求');
const dupLink = await sa.linkCases(page.id, [caseId]);
check(dupLink.linked === 0, '重复关联幂等（不重复插入）');
const detail = await sa.getAssetDetail(page.id);
check(detail.cases.length === 2 && detail.requirements.length === 1, '详情带出关联用例/需求');

// ---------- 5. 资源集（recordRunItemAssets） ----------
console.log('\n— 资源集 —');
const runNo = await baseline.nextRunNo();
const insRun = await db.prepare(
  `INSERT INTO test_runs (run_no, plan_id, trigger_kind, status, manifest_json, error, started_at, created_by, created_at, updated_at)
   VALUES (?, NULL, 'manual', 'running', '{}', '', ?, 'verify', ?, ?)`,
).run(runNo, t, t, t);
const runId = Number(insRun.lastInsertRowid);
const insItem = await db.prepare(
  `INSERT INTO test_run_items (run_id, library_id, baseline_id, commit_sha, repo_subpath, workspace_rel_dir, case_versions_json, status, started_at)
   VALUES (?, ?, 0, '', '', ?, '{}', 'running', ?)`,
).run(runId, libId, `runs/${runNo}/sa-lib`, t);
const runItemId = Number(insItem.lastInsertRowid);
const noAssets = await sa.recordRunItemAssets(runId, runItemId, libId2, [caseOther], runNo);
check(noAssets === null, '无关联资产的库不产生空资源集');
const rs = await sa.recordRunItemAssets(runId, runItemId, libId, [caseId, caseId2], runNo);
check(rs !== null && /^RS-\d{8}-001$/.test(rs.setNo), '资源集编号 RS-YYYYMMDD-001', rs?.setNo);
check(rs.assetCount === 1, '资源集快照 1 个资产（page，onebox 未关联用例）', String(rs?.assetCount));
const rsItems = await db.prepare('SELECT * FROM test_resource_set_items WHERE set_id = ?').all(rs.setId);
check(rsItems.length === 1 && rsItems[0].kind === 'scenario_asset' && rsItems[0].sha256 === w2.asset.sha256, '资源集 item 快照版本+sha256');
const ria = await db.prepare('SELECT * FROM run_item_assets WHERE run_item_id = ?').all(runItemId);
check(ria.length === 1 && ria[0].apply_status === 'recorded' && ria[0].version === '3', 'run_item_assets 登记制（recorded + 版本）');
const riaManifest = JSON.parse(ria[0].manifest_json);
check(riaManifest.applied === false && riaManifest.note.includes('未注入'), '登记 manifest 明确标注"未注入"');
const itemRow = await db.prepare('SELECT resource_set_id FROM test_run_items WHERE id = ?').get(runItemId);
check(Number(itemRow.resource_set_id) === rs.setId, 'test_run_items.resource_set_id 回填');
const runRow = await db.prepare('SELECT resource_set_id FROM test_runs WHERE id = ?').get(runId);
check(Number(runRow.resource_set_id) === rs.setId, 'test_runs.resource_set_id 回填');
const rsDetail = await sa.getResourceSet(rs.setId);
check(rsDetail.items[0].version === '3', '资源集可回查（§8.7）');

// ---------- 6. 应用 ----------
console.log('\n— 应用 —');
const applyDir = path.join(tmpDir, 'apply-dest');
const applied = await sa.applyAssetToDir(page.id, applyDir);
check(applied.copied.length === 2, 'applyAssetToDir 复制全部文件', String(applied.copied.length));
check(fs.readFileSync(path.join(applyDir, 'pages', 'Empty.ets'), 'utf8') === etsContent + '// v3\n', '复制内容与源一致');
const applyRun = await sa.applyAssetToRunItem(onebox.id, runItemId);
check(applyRun.applyStatus === 'recorded', 'apply 到运行项（登记制）');
const applyAgain = await sa.applyAssetToRunItem(onebox.id, runItemId);
check(applyAgain.applyStatus === 'recorded', 'apply 幂等（不重复插入）');
const riaAll = await db.prepare('SELECT COUNT(*) AS c FROM run_item_assets WHERE run_item_id = ?').get(runItemId);
check(Number(riaAll.c) === 2, '运行项共登记 2 个资产');
// baseline 不被改动（§15.5：应用不改基线）—— page 资产目录在 scenario-assets 下，基线目录无变化
const baselinesDir = path.join(workspaceDir(), 'baselines');
check(!fs.existsSync(baselinesDir) || fs.readdirSync(baselinesDir).length === 0, '应用不写基线目录');

// ---------- 7. 生命周期 ----------
console.log('\n— 生命周期 —');
await sa.deprecateAsset(onebox.id);
const dep = await db.prepare('SELECT status FROM scenario_assets WHERE id = ?').get(onebox.id);
check(dep.status === 'deprecated', 'deprecate → deprecated');
await expectError(() => sa.writeAssetFiles(onebox.id, [{ path: 'a', contentBase64: b64('x') }]), '已下架资产拒绝上传（409）', '409');
await expectError(() => sa.removeAsset(page.id), '有运行引用的资产拒绝删除（409）', '409');
const draftAsset = await sa.createAsset({ libraryId: libId, title: '临时', kind: 'fixture', configGuideMd: 'x' });
const rem = await sa.removeAsset(draftAsset.id);
check(rem.removed, '无引用 draft 资产可删除');
const gone = await db.prepare('SELECT COUNT(*) AS c FROM scenario_assets WHERE id = ?').get(draftAsset.id);
check(Number(gone.c) === 0, '删除后行不存在');

// zip 下载结构
const zip = await sa.buildAssetZip(page.id);
check(zip.slice(0, 2).toString('latin1') === 'PK' && zip.slice(0, 4).readUInt32LE(0) === 0x04034b50, 'zip 下载本地头 PK\\x03\\x04');
check(zip.length > etsContent.length, 'zip 非空');

// 大小限制：临时改设置再复原
const { setSetting, getSetting } = await import('../lib/services/settings.js');
const savedFileMb = getSetting('scenarioAsset.maxFileMb', 2);
setSetting('scenarioAsset.maxFileMb', 0.001); // 1KB
const bigAsset = await sa.createAsset({ libraryId: libId, title: '大小限制', kind: 'fixture', configGuideMd: 'x' });
await expectError(() => sa.writeAssetFiles(bigAsset.id, [{ path: 'big.bin', contentBase64: b64('x'.repeat(4096)) }]), '单文件超限拒绝（400）', '400');
setSetting('scenarioAsset.maxFileMb', savedFileMb);

console.log(`\n${fail === 0 ? 'ALL PASS' : `FAILED: ${fail}`}  （临时目录：${tmpDir}）`);
process.exit(fail === 0 ? 0 : 1);
