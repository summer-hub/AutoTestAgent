// P5 可测性判定与补丁的自检（无设备、无 LLM、无 DB）。
//
// 这套里最要紧的是**补丁应用/回退**那一组：补丁会动真实文件，判错就是改坏别人的工程。
// 所以逐条钉住：越界路径拒绝、before 不一致拒绝、应用后能精确回退、回退后字节还原。
//
// 用法：npm run build && npm run verify:testability
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLASS_LABEL, detectUntestable, requiredInputsOf, referencedControls, classifyCase,
  scenarioValueFor, draftPatch, isInside, applyPatchToCopy, revertCopy, extractTemplateLiteral,
} from '../lib/services/testability.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const sym = (over = {}) => ({
  id: 1, name: 'S', kind: 'function', signature: '(a)',
  params: [], returns: { type: '', doc: '' }, throws: [], methods: [], ...over,
});
const cs = (over = {}) => ({
  caseId: 1, caseNo: 'C-1', name: '用例', scenarioKind: 'happy', steps: ['打开应用'], expected: '成功', ...over,
});
const demo = (over = {}) => ({
  demoCalls: [], deviceControls: [], paramPoints: [], testCallCount: 0, ...over,
});
const CALL = { pagePath: 'pages/A', sourceFile: 'entry/src/main/ets/pages/A.ets', sourceLine: 20, snippet: '' };

// ---------- 1. 四类判定（设计 §6.5 的规则表） ----------
console.log('— 四类判定（A 开箱 / B 改参数 / C 需改代码 / D 无法测）—');
{
  eq(Object.keys(CLASS_LABEL).length, 4, '四类标签齐全');

  // D：外部依赖 / 人工判定 / 超长时 —— 只认明确信号词
  check(detectUntestable(cs({ steps: ['打开应用', '连接数据库查询'] }), sym()).isD, 'D：步骤提到数据库');
  check(detectUntestable(cs({ expected: '肉眼看画面是否流畅' }), sym()).isD, 'D：期望要求人工判定');
  check(detectUntestable(cs({ steps: ['连续播放 30 分钟'] }), sym()).isD, 'D：超长时运行');
  check(detectUntestable(cs({ steps: ['打开应用', '点击「验证」'] }), sym()).isD === false, '普通用例不会被误判 D');
  const d1 = classifyCase(cs({ steps: ['连接服务器上传文件'] }), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证'] }));
  eq(d1.class, 'D', 'D 类优先级最高（即便 demo 有入口，外部依赖仍然测不了）');
  check(d1.evidence.some((e) => e.includes('信号')), 'D 类要写明是哪个信号命中', JSON.stringify(d1.evidence));
  check(d1.reason.includes('无法测'), 'D 类理由写清"无法测"并进人工队列');

  // C：demo 没调用
  const c1 = classifyCase(cs(), sym(), demo({ deviceControls: ['验证'] }));
  eq(c1.class, 'C', 'demo 无调用点 → C（需要新增入口）');
  check(c1.reason.includes('未调用'), 'C 类理由说明 demo 未调用', c1.reason);
  const c1t = classifyCase(cs(), sym(), demo({ deviceControls: ['验证'], testCallCount: 3 }));
  eq(c1t.class, 'C', '只有单元测试调用仍是 C（真机路径不可达）');
  check(c1t.evidence.some((e) => e.includes('单元测试')), 'C 类证据里写出"仅单元测试调用"');

  // C：有调用但真机没有控件
  const c2 = classifyCase(cs(), sym(), demo({ demoCalls: [CALL] }));
  eq(c2.class, 'C', '有调用但真机无控件 → C（触达不了）');
  check(c2.reason.includes('控件'), 'C 类理由说明缺控件');

  // A：有调用 + 有控件 + 正向
  const a1 = classifyCase(cs(), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证', '期待结果：'] }));
  eq(a1.class, 'A', 'demo 有调用 + 真机有控件 + 正向 → A');
  eq(a1.triggerControl, '验证', 'A 类给出触发控件');

  // B：有调用 + 有控件 + 非正向 + 有可改数据点
  const b1 = classifyCase(cs({ scenarioKind: 'empty' }), sym({ params: [{ name: 'a', type: 'string', optional: true, defaultValue: '', doc: '' }] }),
    demo({ demoCalls: [CALL], deviceControls: ['验证'], paramPoints: [{ pagePath: 'pages/A', name: 'message0', sourceFile: CALL.sourceFile, sourceLine: 25 }] }));
  eq(b1.class, 'B', '负向场景 + 有可改字面量 → B（改参数即可）');
  check(b1.reason.includes('字面量'), 'B 类理由说明可通过改字面量满足');

  // C：非正向但页面没有可注入数据点
  const c3 = classifyCase(cs({ scenarioKind: 'boundary' }), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证'] }));
  eq(c3.class, 'C', '负向场景 + 无数据点 → C（要改代码构造输入）');

  // ★ 用例引用的控件在真机上不存在 → 先解决入口
  const c4 = classifyCase(cs({ steps: ['点击「不存在的按钮XYZ」'] }), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证'] }));
  eq(c4.class, 'C', '★ 用例引用的控件真机上不存在 → C（不判 A 让人白跑）');
  check(c4.reason.includes('不存在'), 'C 类理由指出哪个控件不存在');
  const a2 = classifyCase(cs({ steps: ['点击「验证」'] }), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证', '期待结果：'] }));
  eq(a2.class, 'A', '引用的控件真机上存在 → A');

  // 未关联接口符号的用例也必须拿到判定（100% 覆盖要求）
  const u1 = classifyCase(cs({ steps: ['点击「验证」'] }), null, demo({ deviceControls: ['验证'] }));
  eq(u1.class, 'A', '未关联符号：引用的控件存在 → A');
  const u2 = classifyCase(cs({ steps: ['点击「不存在X」'] }), null, demo({ deviceControls: ['验证'] }));
  eq(u2.class, 'C', '未关联符号：引用的控件不存在 → C');
  const u3 = classifyCase(cs(), null, demo());
  eq(u3.class, 'C', '未关联符号且无遍历控件 → C 并说明需人工确认');
  const u4 = classifyCase(cs(), null, demo({ deviceControls: ['验证'] }));
  eq(u4.class, 'B', '未关联符号且步骤没引用控件 → B（需在 demo 指定入口）');
  check([u1, u2, u3, u4].every((v) => v.class && v.reason.length > 0), '★ 任何用例都能拿到 A/B/C/D + 理由（不留空）');
}

// ---------- 2. 输入抽取与场景取值 ----------
console.log('\n— 输入抽取与场景取值 —');
{
  eq(referencedControls(['点击「验证」', '输入「abc」到「输入框」', '验证「结果」']), ['验证', 'abc', '输入框', '结果'],
    '从真机句式里抽出被引用的控件/文本');
  eq(referencedControls(['打开应用', '等待 3 秒']), [], '没有引用控件的步骤返回空');
  eq(referencedControls(['点击「验证」', '再点击「验证」']), ['验证'], '同一控件去重');

  const req = requiredInputsOf(cs({ scenarioKind: 'empty' }), sym({ params: [{ name: 'a', type: 'string', optional: true, defaultValue: '', doc: '' }] }));
  check(req.some((r) => r.includes('a')), '空值场景的输入要求指向具体参数', JSON.stringify(req));
  eq(requiredInputsOf(cs({ scenarioKind: 'happy' }), sym()).length, 1, '无参数的正向场景仍给出"无需构造输入"');

  eq(scenarioValueFor('empty', 'let x = 1000').value, "''", '空值：替换为空串');
  eq(scenarioValueFor('bigdata', 'let x = 1').value.includes('padEnd'), true, '大数据：替换为放大量级的表达式');
  check(scenarioValueFor('boundary', 'let x = 1').value.includes('invalid'), '边界：替换为非法值');
  eq(scenarioValueFor('happy', 'let x = 1').value, 'let x = 1', '正向：不改动');
}

// ---------- 3. 补丁草案生成 ----------
console.log('\n— 补丁草案生成 —');
{
  const readFile = (rel) => (rel === CALL.sourceFile ? ['import x', '', 'struct A {', '  @State message: string = \'hello\'', '}'].join('\n') : null);
  const point = { pagePath: 'pages/A', name: 'message', sourceFile: CALL.sourceFile, sourceLine: 4 };

  // A 类不生成补丁
  const pdA = draftPatch(cs(), sym(), demo({ demoCalls: [CALL], deviceControls: ['验证'] }), { class: 'A', reason: '', evidence: [], requiredInputs: [], triggerPage: 'pages/A', triggerControl: '验证' }, readFile);
  eq(pdA.edits.length, 0, 'A 类不生成补丁');
  check(pdA.reason.includes('无需补丁'), 'A 类理由写明无需补丁');

  // D 类不生成补丁
  const pdD = draftPatch(cs(), sym(), demo(), { class: 'D', reason: '需要外部数据库', evidence: [], requiredInputs: [], triggerPage: '', triggerControl: '' }, readFile);
  eq(pdD.edits.length, 0, 'D 类不生成补丁（进人工队列）');
  check(pdD.reason.includes('人工接管'), 'D 类理由写明进人工队列');

  // B 类：最小替换，before 必须与文件真实内容一致
  const pdB = draftPatch(cs({ scenarioKind: 'empty' }), sym(), demo({ paramPoints: [point] }),
    { class: 'B', reason: '可通过改字面量满足', evidence: [], requiredInputs: [], triggerPage: 'pages/A', triggerControl: '验证' }, readFile);
  eq(pdB.edits.length, 1, 'B 类生成 1 处最小替换');
  eq(pdB.edits[0].before, "  @State message: string = 'hello'", '★ before 取文件真实行内容（否则应用时会拒绝）');
  check(pdB.edits[0].after.includes("''"), 'after 是空值');
  eq(pdB.edits[0].line, 4, '行号来自数据点');
  check(pdB.revert.includes('副本') || pdB.revert.includes('未改动'), 'revert 说明原仓库未改动', pdB.revert);
  check(pdB.verify.length > 0, 'verify 给出校验命令');

  // 读不到文件时不硬造补丁
  const pdB2 = draftPatch(cs({ scenarioKind: 'empty' }), sym(), demo({ paramPoints: [point] }),
    { class: 'B', reason: '', evidence: [], requiredInputs: [], triggerPage: '', triggerControl: '' }, () => null);
  eq(pdB2.edits.length, 0, '★ 读不到文件时不生成补丁，并在理由里说明需人工编写');
  check(pdB2.reason.includes('人工编写'), '理由写明需人工编写');

  // 跨行模板字面量：整体替换（真机 demo 的数据点几乎都是多行样例代码，不认它等于放弃整类）
  const multiSrc = 'const a = 1;\n  @State code: string = `line1\nline2\nline3`\n  build() {}\n';
  const pdM = draftPatch(cs({ scenarioKind: 'empty' }), sym(),
    demo({ paramPoints: [{ pagePath: 'pages/A', name: 'code', sourceFile: CALL.sourceFile, sourceLine: 2 }] }),
    { class: 'B', reason: '', evidence: [], requiredInputs: [], triggerPage: 'pages/A', triggerControl: '' }, () => multiSrc);
  eq(pdM.edits.length, 1, '★ 多行模板字面量也能生成补丁（整体替换）');
  eq(pdM.edits[0].before, '`line1\nline2\nline3`', '★ before 是整个字面量（含换行）');
  eq(pdM.edits[0].line, 2, '起始行号正确');
  check(pdM.edits[0].after.includes('AUTOTEST_EMPTY'), 'after 是该场景的取值', pdM.edits[0].after);

  // 字面量在文件里出现多次 → 不生成补丁（位置不唯一会改错地方）
  const dupSrc = 'let x = 1;\n  @State a: string = `same`\n  @State b: string = `same`\n';
  const pdDup = draftPatch(cs({ scenarioKind: 'empty' }), sym(),
    demo({ paramPoints: [{ pagePath: 'pages/A', name: 'a', sourceFile: CALL.sourceFile, sourceLine: 2 }] }),
    { class: 'B', reason: '', evidence: [], requiredInputs: [], triggerPage: 'pages/A', triggerControl: '' }, () => dupSrc);
  eq(pdDup.edits.length, 0, '★ 字面量出现多次时不生成补丁（避免改错地方）');
  check(pdDup.reason.includes('唯一'), '理由写明需要唯一才能安全替换', pdDup.reason);

  // extractTemplateLiteral 的基本行为
  eq(extractTemplateLiteral(multiSrc, 2)?.text, '`line1\nline2\nline3`', 'extractTemplateLiteral 取出完整字面量');
  eq(extractTemplateLiteral('const a = 1;\n', 1), null, '没有反引号时返回 null');

  // C 类：无调用点 → 新增控件草案
  const pageFile = 'entry/src/main/ets/pages/A.ets';
  const readPage = (rel) => (rel === pageFile || rel === pageFile.replace(/\.ets$/, '') ? 'build() {\n  Column() {\n  }\n}\n' : null);
  const pdC = draftPatch(cs(), sym({ name: 'setLoop', params: [] }), demo(),
    { class: 'C', reason: 'demo 未调用', evidence: [], requiredInputs: [], triggerPage: 'pages/A', triggerControl: '' }, readPage);
  check(pdC.edits.length === 1 || pdC.edits.length === 0, 'C 类给出"新增控件"草案或明确说明需人工编写', `edits=${pdC.edits.length}`);
  if (pdC.edits.length > 0) {
    check(pdC.edits[0].after.includes('setLoop'), '新增控件的草案里带上接口名');
    check(pdC.edits[0].note.includes('人工'), 'note 提醒调用体需人工补全');
    check(Array.isArray(pdC.impact) && pdC.impact.length > 0, 'C 类带影响面说明');
  }
}

// ---------- 4. 补丁应用 / 回退（安全关键） ----------
console.log('\n— 补丁应用 / 回退（只在独立副本上）—');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-p5-'));
{
  const copy = path.join(tmp, 'copy');
  fs.mkdirSync(path.join(copy, 'entry/src/main/ets/pages'), { recursive: true });
  const target = 'entry/src/main/ets/pages/A.ets';
  const original = ['struct A {', "  @State message: string = 'hello'", '  build() {}', '}'].join('\n');
  fs.writeFileSync(path.join(copy, target), original, 'utf8');
  // 副本之外的"原仓库"文件：绝不能被改
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'entry/src/main/ets/pages'), { recursive: true });
  fs.writeFileSync(path.join(repo, target), original, 'utf8');

  const patch = {
    class: 'B', target, reason: '置空', revert: '删除副本', verify: [], risk: '',
    edits: [{ file: target, line: 2, before: "  @State message: string = 'hello'", after: "  @State message: string = ''", note: 'empty' }],
  };

  const res = applyPatchToCopy(copy, patch);
  eq(res.ok, true, '应用成功');
  eq(res.applied.length, 1, '1 处改动被应用');
  check(fs.readFileSync(path.join(copy, target), 'utf8').includes("''"), '副本里的文件被改');
  eq(fs.readFileSync(path.join(repo, target), 'utf8'), original, '★ 原仓库文件一字未改（只动副本）');
  check(fs.existsSync(res.manifestFile), '写入 manifest（含原始内容，保证可回退）');

  const rev = revertCopy(copy);
  eq(rev.ok, true, '回退成功');
  eq(rev.removed, [target], '回退了被改的文件');
  eq(fs.readFileSync(path.join(copy, target), 'utf8'), original, '★ 回退后副本文件字节还原');
  check(!fs.existsSync(path.join(copy, 'autotest-patch-manifest.json')), '回退后 manifest 被清理');

  // ★ 越界路径必须拒绝（目录穿越：补丁绝不能写到副本之外）
  const evil = { ...patch, edits: [{ file: '../../repo/entry/src/main/ets/pages/A.ets', line: 2, before: original.split('\n')[1], after: 'HACKED', note: '' }] };
  const evilRes = applyPatchToCopy(copy, evil);
  eq(evilRes.applied.length, 0, '★ 越界路径被拒绝（0 处应用）');
  check(evilRes.failed[0].reason.includes('越界'), '拒绝理由写明"越界"', evilRes.failed[0].reason);
  eq(fs.readFileSync(path.join(repo, target), 'utf8'), original, '★ 目录穿越尝试后原仓库仍未被改');
  check(isInside(copy, target) && !isInside(copy, '../../repo/x'), 'isInside 正确区分内外');

  // ★ before 与文件不一致必须拒绝（代码已变，硬替换会改坏工程）
  const drifted = { ...patch, edits: [{ file: target, line: 2, before: "  @State message: string = 'OLD'", after: 'X', note: '' }] };
  const driftRes = applyPatchToCopy(copy, drifted);
  eq(driftRes.applied.length, 0, '★ before 与文件不一致 → 拒绝应用');
  check(driftRes.failed[0].reason.includes('不一致'), '拒绝理由写明内容不一致', driftRes.failed[0].reason);
  eq(fs.readFileSync(path.join(copy, target), 'utf8'), original, '拒绝后文件保持原样');

  // 行号轻微位移时按内容就近匹配（代码整体下移几行是常态）
  const shifted = ['// new header', '', ...original.split('\n')].join('\n');
  fs.writeFileSync(path.join(copy, target), shifted, 'utf8');
  const shiftRes = applyPatchToCopy(copy, patch);
  eq(shiftRes.applied.length, 1, '★ 行号位移时按内容就近匹配成功');
  check(fs.readFileSync(path.join(copy, target), 'utf8').includes("''"), '位移场景下改动也落到了正确位置');
  revertCopy(copy);
  eq(fs.readFileSync(path.join(copy, target), 'utf8'), shifted, '位移场景回退后还原');

  // 文件不存在
  const missing = applyPatchToCopy(copy, { ...patch, edits: [{ file: 'nope.ets', line: 1, before: 'a', after: 'b', note: '' }] });
  check(missing.failed[0].reason.includes('不存在'), '目标文件不存在 → 明确报错');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
