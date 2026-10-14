// R2：全量库采集流水线自检 —— 分类判定 / 事实构建 / 预设匹配 / 资源合成 / 批次语义。
//
// 为什么值得单独一套：这一层的失败模式决定"348 个库能不能被分层处理"——
//   · 分类判错 → 套错 preset → 整类库的环境方案全错（且看起来都"有方案"）；
//   · 资源不校验 → 畸形 json 被当成合法输入，测出来的失败毫无意义；
//   · 批次不隔离 → 一个扫不动的库把整批拖死；
//   · 断点续跑失效 → 348 个库每次都全量重扫，规模化变成空话。
// 四类问题都不报错，只会让平台"看起来很忙但不可信"。
//
// 用法：npm run build && npm run verify:survey
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自检在临时数据目录里跑，绝不碰使用者真实数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-survey-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb } = await import('../lib/db/connection.js');
const S = await import('../lib/services/survey/index.js');
const R = await import('../lib/services/resourcekit/index.js');

/** 构造一份 RawRepoScan（纯函数输入，不碰磁盘）。 */
const scan = (over = {}) => ({
  files: over.files ?? [],
  readme: over.readme ?? '',
  ohPackage: over.ohPackage ?? null,
  buildProfile: over.buildProfile ?? null,
  gitmodules: over.gitmodules ?? '',
  binaryFiles: over.binaryFiles ?? [],
  libraryName: over.libraryName ?? 'demo-lib',
});

// ---------- 1. 库类别判定（有序规则，先匹配到的赢）----------
console.log('— 库类别判定（可逐条核对，不是模型一句"看起来像"）—');
{
  const lottie = S.classifyKind(scan({
    libraryName: 'lottie_turbo',
    readme: 'Lottie is a mobile library for Android and iOS that renders After Effects animations in realtime.',
    ohPackage: { name: 'lottie', version: '1.0.0', dependencies: { '@ohos/lottie': '^1.0.0' } },
  }));
  check(lottie.kind === 'animation' && lottie.confidence >= 85, 'lottie → animation（强信号）', `${lottie.kind}/${lottie.confidence}`);
  check(lottie.reason.length > 0, '判定带可解释理由', lottie.reason.slice(0, 60));

  const net = S.classifyKind(scan({
    libraryName: 'okhttp-like',
    readme: 'An HTTP+HTTP/2 client for Android and HarmonyOS. Supports websocket and retrofit.',
  }));
  check(net.kind === 'network', 'http/websocket/retrofit → network', net.kind);

  const store = S.classifyKind(scan({
    libraryName: 'mmkv-like',
    readme: 'MMKV is an efficient, small, easy-to-use mobile key-value storage framework. 数据库 本地存储',
  }));
  check(store.kind === 'storage', 'mmkv/数据库 → storage', store.kind);

  const codec = S.classifyKind(scan({
    libraryName: 'libpng-like',
    readme: 'libpng is the official PNG reference library for encoding and decoding PNG images.',
  }));
  check(codec.kind === 'codec', 'libpng/编解码 → codec', codec.kind);

  const crypto = S.classifyKind(scan({
    libraryName: 'aes-like',
    readme: 'AES encryption and decryption, RSA sign and verify, SHA256 digest.',
  }));
  check(crypto.kind === 'crypto', 'aes/rsa/sha → crypto', crypto.kind);

  const ui = S.classifyKind(scan({
    libraryName: 'swiper-like',
    readme: 'A RecyclerView and ViewPager based UI component with Swiper and TabLayout.',
  }));
  check(ui.kind === 'ui_component', 'recyclerview/viewpager → ui_component', ui.kind);

  const unknown = S.classifyKind(scan({ libraryName: 'mystery', readme: 'A library that does things.' }));
  check(unknown.kind === 'unknown' && unknown.confidence === 0, '无信号 → unknown（交给 LLM）', `${unknown.kind}/${unknown.confidence}`);

  // 顺序即产品决策：UI 组件的信号最泛，放最后，不能吞掉前面的强信号
  const animNotUi = S.classifyKind(scan({
    libraryName: 'x', readme: 'Lottie animation component with custom UI widget',
  }));
  check(animNotUi.kind === 'animation', '动画库不会被误判成 UI 组件（顺序保护）', animNotUi.kind);

  // 弱信号叠加才给中等置信度
  const weak = S.classifyKind(scan({ libraryName: 'y', readme: 'handles frame rate and easing curves' }));
  check(weak.kind === 'animation' && weak.confidence === 55, '弱信号叠加 → 中等置信度 55', `${weak.kind}/${weak.confidence}`);
}

// ---------- 2. 事实构建 ----------
console.log('\n— 事实构建（二进制/子模块/构建目标/入口）—');
{
  const f = S.buildLibraryFacts(scan({
    libraryName: 'lottie_turbo',
    readme: 'Lottie animation engine with native core.',
    binaryFiles: ['library/src/main/cpp/types/libentry/libarm64-v8a/liblottie.so', 'library/libs/libfoo.a'],
    gitmodules: '[submodule "third_party/zlib"]\n\tpath = third_party/zlib',
    buildProfile: { modules: ['entry', 'library'], bundleName: 'com.example.lottie', apiLevel: '12' },
    files: ['hvigorw', 'entry/src/main/ets/Index.ets', 'entry/src/main/ets/pages/Home.ets', 'library/src/main/cpp/types/libentry/index.d.ts'],
  }));
  check(f.kind === 'animation', '类别正确', f.kind);
  check(f.hasBinary && f.binaryKinds.includes('so:arm64-v8a'), '二进制 ABI 识别', f.binaryKinds.join(','));
  check(f.hasBinary && f.binaryKinds.includes('static:a'), '静态库识别', f.binaryKinds.join(','));
  check(f.hasSubmodules, '子模块识别');
  check(f.buildTarget === 'hap', '有 entry 模块 → hap', f.buildTarget);
  check(f.hasDemo, '有 ets 页面 → 有 demo');
  check(!!f.entryFile, '入口文件定位', f.entryFile);
  check(f.facts.ohpmDeps.length === 0 && f.facts.moduleNames.length === 2, '模块清单正确', f.facts.moduleNames.join(','));
  check(f.needsLlm.some((r) => r.includes('二进制')), '含 .so → 标记需 LLM 决策', f.needsLlm.join('；'));

  // 纯库结构（无 entry）→ har
  const har = S.buildLibraryFacts(scan({
    libraryName: 'purelib',
    buildProfile: { modules: ['library'], bundleName: '', apiLevel: '' },
  }));
  check(har.buildTarget === 'har', '无 entry → har', har.buildTarget);

  // 无 build-profile → 构建目标 unknown + 需 LLM
  const noBp = S.buildLibraryFacts(scan({ libraryName: 'bare' }));
  check(noBp.buildTarget === 'unknown' && noBp.needsLlm.some((r) => r.includes('构建目标')), '缺 build-profile → unknown + 需 LLM', noBp.needsLlm.join('；'));
}

// ---------- 3. README 情报抽取 ----------
console.log('\n— README 情报抽取（依赖/构建命令/前置/已知问题）—');
{
  const intel = S.extractReadmeIntel([
    '# Demo',
    'Run `ohpm install` then `hvigorw assembleHap` to build.',
    'Requires OpenSSL >= 3.0 and DevEco Studio 5.0.',
    '⚠️ Note: this library needs a real device with network access.',
    'Known issue: does not support API 9.',
    'Sample assets: demo/resources/animation.json',
  ].join('\n'));
  const kinds = intel.map((i) => i.kind);
  check(kinds.includes('build_cmd'), '识别构建命令', intel.find((i) => i.kind === 'build_cmd')?.text.slice(0, 40));
  check(kinds.includes('dependency'), '识别依赖要求', intel.find((i) => i.kind === 'dependency')?.text.slice(0, 40));
  check(kinds.includes('prerequisite'), '识别前置条件', intel.find((i) => i.kind === 'prerequisite')?.text.slice(0, 40));
  check(kinds.includes('known_issue'), '识别已知问题', intel.find((i) => i.kind === 'known_issue')?.text.slice(0, 40));
  check(kinds.includes('sample_asset'), '识别样本资源', intel.find((i) => i.kind === 'sample_asset')?.text.slice(0, 40));
  check(intel.every((i) => i.line > 0), '每条情报带行号（可回查）');
}

// ---------- 4. 资源候选发现 ----------
console.log('\n— 资源候选发现（仓库检出，不猜内容）—');
{
  const f = S.buildLibraryFacts(scan({
    libraryName: 'x',
    files: [
      'entry/src/main/resources/rawfile/lottie_demo.json',
      'entry/src/main/resources/rawfile/icon.png',
      'entry/src/main/resources/rawfile/sample.mp4',
      'library/certs/test_ca.pem',
      'test/fixtures/mock_response.json',
      'test/data/seed.db',
    ],
  }));
  const kinds = f.resourceCandidates.map((c) => c.kind);
  check(kinds.includes('animation_json'), '动画 json 候选', f.resourceCandidates.find((c) => c.kind === 'animation_json')?.ref);
  check(kinds.includes('image'), '图片候选');
  check(kinds.includes('media'), '音视频候选');
  check(kinds.includes('ca_cert'), '证书候选');
  check(kinds.includes('server_fixture'), '服务端 fixture 候选');
  check(kinds.includes('db_fixture'), '数据库 fixture 候选');
  check(f.resourceCandidates.every((c) => c.reason.length > 0), '每个候选都带理由（可核对）');
}

// ---------- 5. 动画 JSON schema 校验 ----------
console.log('\n— 动画 JSON schema 校验（区分"畸形"与"合法边界"）—');
{
  const valid = JSON.parse(R.synthesizeAnimation('lottie-minimal').text);
  check(R.validateAnimationJson(valid).length === 0, '合成的最小动画通过 schema', JSON.stringify(R.validateAnimationJson(valid)));

  const empty = JSON.parse(R.synthesizeAnimation('lottie-empty-layers').text);
  check(R.validateAnimationJson(empty).length === 0, '空 layers 是合法边界（不是畸形）');

  const missingFr = { ...valid }; delete missingFr.fr;
  check(R.validateAnimationJson(missingFr).some((p) => p.path === '$.fr'), '缺 fr 被指出');

  const badLayers = { ...valid, layers: 'not-array' };
  check(R.validateAnimationJson(badLayers).some((p) => p.path === '$.layers'), 'layers 非数组被指出');

  const badRange = { ...valid, fr: -1 };
  check(R.validateAnimationJson(badRange).some((p) => p.path === '$.fr'), '帧率非正被指出');

  const badRange2 = { ...valid, op: 0, ip: 10 };
  check(R.validateAnimationJson(badRange2).some((p) => p.path === '$.op'), 'op < ip 被指出');

  check(R.validateAnimationJson(null).length > 0, '根节点非对象被指出');
  check(R.validateAnimationJson([1, 2]).some((p) => p.path === '$'), '数组根被指出');
}

// ---------- 6. 合成动画资源（"怎么测试"的落地）----------
console.log('\n— 合成动画资源（六种变体对应六类测试意图）—');
{
  const variants = ['lottie-minimal', 'lottie-empty-layers', 'lottie-huge-layers', 'lottie-nested-precomp', 'lottie-malformed', 'lottie-bad-encoding'];
  for (const v of variants) {
    const g = R.synthesizeAnimation(v);
    check(g.text.length > 0 && g.intent.length > 0, `合成资源有内容与意图：${v}`, g.intent.slice(0, 40));
  }
  // 合法变体必须过 schema
  for (const v of ['lottie-minimal', 'lottie-empty-layers', 'lottie-huge-layers', 'lottie-nested-precomp']) {
    const g = R.synthesizeAnimation(v);
    let parsed = null;
    try { parsed = JSON.parse(g.text); } catch { /* noop */ }
    check(R.validateAnimationJson(parsed).length === 0, `合法变体过 schema：${v}`);
  }
  // 畸形变体必须**不能**被解析（这是它的用途：走错误回调）
  const malformed = R.synthesizeAnimation('lottie-malformed');
  let threw = false;
  try { JSON.parse(malformed.text); } catch { threw = true; }
  check(threw, '畸形 JSON 确实解析失败（才能测错误分支）');
  check(!malformed.valid, '畸形资源标记为 invalid');

  const huge = R.synthesizeAnimation('lottie-huge-layers');
  const hugeObj = JSON.parse(huge.text);
  check(hugeObj.layers.length === 200, '大数据变体含 200 图层', `layers=${hugeObj.layers.length}`);

  const nested = JSON.parse(R.synthesizeAnimation('lottie-nested-precomp').text);
  check(Array.isArray(nested.assets) && nested.assets.length === 1, '嵌套变体注册了被引用的合成');

  check(/^[0-9a-f]{32}$/.test(R.contentHash('abc')), '内容哈希 32 位十六进制');
  check(R.contentHash('abc') !== R.contentHash('abd'), '内容变 → 哈希变');
}

// ---------- 7. 预设库 ----------
console.log('\n— 预设库（五类别的开箱方案）—');
{
  const kinds = S.availablePresetKinds();
  check(kinds.length >= 5, '至少 5 类预设可用', kinds.join(','));
  for (const k of ['animation', 'network', 'storage', 'codec', 'ui_component']) {
    check(kinds.includes(k), `预设存在：${k}`);
  }
  for (const k of kinds) {
    const p = S.loadPreset(k);
    check(!!p && p.steps.length > 0, `预设可加载且有步骤：${k}`, `${p?.steps.length} 步`);
    check(!!p && p.toolchain && Object.keys(p.toolchain).length > 0, `预设带工具链要求：${k}`);
    check(!!p && p.oracles.length > 0, `预设带判据配方：${k}`, `${p?.oracles.length} 条`);
    check(!!p && p.resources.length > 0, `预设带资源清单：${k}`, `${p?.resources.length} 项`);
    // 步骤必须引用真实存在的脚本资产（否则画像建出来也跑不了）
    for (const s of p?.steps ?? []) {
      const script = S.builtinScriptFor?.(s.scriptId);
      void script;
    }
  }
  // 预设里的 scriptId 必须都在内置脚本表里（这条最关键：悬空引用会让画像跑不起来）
  const builtinIds = ['ohpm_install', 'build_manifest', 'build_har', 'build_hap', 'hdc_install'];
  for (const k of kinds) {
    const p = S.loadPreset(k);
    const dangling = (p?.steps ?? []).filter((s) => !builtinIds.includes(s.scriptId));
    check(dangling.length === 0, `预设步骤无悬空脚本引用：${k}`, dangling.map((d) => d.scriptId).join(','));
  }
}

// ---------- 8. 资源登记（幂等 + 版本 + sha256）----------
console.log('\n— 资源登记（幂等 / 版本 / 复用）—');
await ensureReady();
{
  const r1 = await R.registerResource({
    resourceId: 'selfcheck-anim', kind: 'animation_json', origin: 'synthesized',
    scopeKind: 'library_kind', scopeKey: 'animation', content: R.synthesizeAnimation('lottie-minimal').text,
    intent: '自检用',
  });
  check(r1.ok, '首次登记成功', `id=${r1.id}`);
  check(r1.problems.length === 0, '合法资源无校验问题');

  const r2 = await R.registerResource({
    resourceId: 'selfcheck-anim', kind: 'animation_json', origin: 'synthesized',
    scopeKind: 'library_kind', scopeKey: 'animation', content: R.synthesizeAnimation('lottie-minimal').text,
  });
  check(r2.ok && r2.id === r1.id, '重复登记不新建行（幂等）', `${r1.id} vs ${r2.id}`);

  const r3 = await R.registerResource({
    resourceId: 'selfcheck-anim', kind: 'animation_json', origin: 'synthesized',
    content: R.synthesizeAnimation('lottie-huge-layers').text,
  });
  check(r3.ok && r3.versionBumped, '内容变化 → 记新版本', `bumped=${r3.versionBumped}`);

  // 畸形资源也要登记，但标出问题
  const bad = await R.registerResource({
    resourceId: 'selfcheck-malformed', kind: 'animation_json', origin: 'synthesized',
    content: R.synthesizeAnimation('lottie-malformed').text,
  });
  check(bad.ok && bad.problems.length > 0, '畸形资源可登记且问题被记录', bad.problems[0]?.slice(0, 50));

  await R.bumpReuse('selfcheck-anim');
  await R.bumpReuse('selfcheck-anim');
  const listed = await R.listResources({ kind: 'animation_json' });
  const mine = listed.find((r) => r.resourceId === 'selfcheck-anim');
  check(mine?.reuseCount === 2, '复用计数正确', `reuse=${mine?.reuseCount}`);
  check(!!mine?.fileSha256 && /^[0-9a-f]{32}$/.test(mine.fileSha256), '登记带内容哈希');

  // 未知资源类型被拒
  const badKind = await R.registerResource({ resourceId: 'x', kind: 'nope', origin: 'synthesized', content: '{}' });
  check(!badKind.ok, '未知资源类型被拒', badKind.problems[0]);

  // 合成登记（animation 全量六变体）
  const synth = await R.registerSyntheticForKind('animation');
  check(synth.registered === 6 && synth.ids.length === 6, 'animation 合成登记 6 个', JSON.stringify(synth.ids));
}

// ---------- 9. 批次语义（隔离 / 续跑 / 统计）----------
console.log('\n— 批次语义（隔离 / 断点续跑 / 统计）—');
{
  // 造 3 个库：1 个目录不存在（应失败但不影响其他）、2 个可扫
  const t = now();
  const ids = [];
  const repoA = path.join(tmpDir, 'repo-ok-a');
  const repoB = path.join(tmpDir, 'repo-ok-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.writeFileSync(path.join(repoA, 'README.md'), 'Lottie animation library for HarmonyOS.');
  fs.writeFileSync(path.join(repoB, 'README.md'), 'An HTTP client library with websocket support.');
  fs.writeFileSync(path.join(repoA, 'oh-package.json5'), JSON.stringify({ name: 'a', version: '1.0.0', dependencies: {} }));

  for (const [name, url] of [
    ['survey-ok-a', 'https://example.invalid/survey-ok-a'],
    ['survey-ok-b', 'https://example.invalid/survey-ok-b'],
    ['survey-missing', 'https://example.invalid/survey-missing'],
  ]) {
    const ins = await getDb().prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
      VALUES (?, ?, '自检用', 'v0.0.0', 'active', ?, ?)`).run(name, url, t, t);
    ids.push(Number(ins.lastInsertRowid));
  }

  // 让前两个库的仓库目录可被 repoDirFor 找到：gitRepo 按仓库名推导目录，
  // 这里直接把工程放到 workspace/repos/<name> 下（与真实布局一致）
  const { workspaceDir } = await import('../lib/services/gitRepo.js');
  const reposRoot = path.join(workspaceDir(), 'repos');
  fs.mkdirSync(path.join(reposRoot, 'survey-ok-a'), { recursive: true });
  fs.mkdirSync(path.join(reposRoot, 'survey-ok-b'), { recursive: true });
  fs.copyFileSync(path.join(repoA, 'README.md'), path.join(reposRoot, 'survey-ok-a', 'README.md'));
  fs.copyFileSync(path.join(repoA, 'oh-package.json5'), path.join(reposRoot, 'survey-ok-a', 'oh-package.json5'));
  fs.copyFileSync(path.join(repoB, 'README.md'), path.join(reposRoot, 'survey-ok-b', 'README.md'));

  const r = await S.runSurveyBatch({ scope: 'ids', ids, concurrency: 3, resume: false, createProfiles: true });
  check(r.total === 3, '批次总数正确', `total=${r.total}`);
  check(r.done === 2, '两个可扫库完成', `done=${r.done}`);
  check(r.failed === 1, '缺目录的库失败但未拖死整批（隔离生效）', `failed=${r.failed}`);
  check(r.needsLlm >= 0 && r.byKind.animation === 1 && r.byKind.network === 1, '按类别统计正确', JSON.stringify(r.byKind));

  // 事实已落库
  const factsA = await getDb().prepare('SELECT kind, has_binary FROM library_facts WHERE library_id = ?').get(ids[0]);
  check(factsA?.kind === 'animation', '库 A 事实落库且类别正确', factsA?.kind);
  const factsB = await getDb().prepare('SELECT kind FROM library_facts WHERE library_id = ?').get(ids[1]);
  check(factsB?.kind === 'network', '库 B 事实落库且类别正确', factsB?.kind);

  // L1 预设匹配：animation 库应生成 env_profiles 草稿
  const profA = await getDb().prepare("SELECT id, source, preset_kind FROM env_profiles WHERE library_id = ?").get(ids[0]);
  check(!!profA && profA.source === 'preset' && profA.preset_kind === 'animation',
    'L1 预设匹配生成画像草稿', JSON.stringify(profA));

  // 画像带步骤且 scriptId 都真实存在
  if (profA) {
    const steps = await getDb().prepare('SELECT seq, script_id, params_json FROM env_profile_steps WHERE profile_id = ? ORDER BY seq').all(profA.id);
    check(steps.length > 0, '画像带步骤', `${steps.length} 步`);
    check(steps.every((s) => ['ohpm_install', 'build_manifest', 'build_hap', 'hdc_install'].includes(s.script_id)),
      '画像步骤都引用真实脚本', steps.map((s) => s.script_id).join(','));
    const p0 = JSON.parse(steps[0].params_json);
    check(p0.projectDir === '{{repoDir}}', 'projectDir 用占位符（运行时才替换）', String(p0.projectDir));
  }

  // 断点续跑：已 done/needs_llm 且 commit 未变 → 跳过；**失败的仍然重试**（这是刻意设计：
  // 环境失败重跑一次可能就成功了，把失败也跳过等于永远不再自愈）。所以是 2 跳过 + 1 重试失败。
  const r2 = await S.runSurveyBatch({ scope: 'ids', ids, concurrency: 3, resume: true, createProfiles: true });
  check(r2.skipped === 2 && r2.done === 0 && r2.failed === 1,
    '断点续跑：成功/待 LLM 的跳过，失败的仍重试', `skipped=${r2.skipped} done=${r2.done} failed=${r2.failed}`);

  // 失败库重跑：仍然失败（目录还是不存在），且不影响其他
  const r3 = await S.runSurveyBatch({ scope: 'ids', ids, concurrency: 2, resume: false, createProfiles: false });
  check(r3.failed === 1 && r3.done === 2, '强制重扫：失败仍隔离', `done=${r3.done} failed=${r3.failed}`);

  // 统计
  const stats = await S.surveyStats();
  check(stats.totals.libraries >= 3, '统计库总数', `libraries=${stats.totals.libraries}`);
  check(stats.totals.surveyed === 2, '统计已采集数（缺目录的不算）', `surveyed=${stats.totals.surveyed}`);
  check(stats.byKind.some((k) => k.kind === 'animation'), '统计按类别分组');
  check(stats.batches.length >= 3, '统计批次历史', `batches=${stats.batches.length}`);
}

// ---------- 10. 取消 ----------
console.log('\n— 批次可取消（不是只能等它跑完）—');
{
  const ac = new AbortController();
  ac.abort();   // 立即取消
  const r = await S.runSurveyBatch({ scope: 'all', signal: ac.signal, concurrency: 2, resume: true });
  check(r.total >= 0, '已取消的批次能正常返回（不挂死）', `total=${r.total} done=${r.done}`);
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
