// P7 自动化可行性分流与人工队列的自检（无设备、无 LLM、无 DB）。
//
// 分流决定了"这条用例到底会不会被自动执行"，交给模型自由发挥就无法核对。
// 所以这里把规则表逐条钉死，并专门验证两个验收项：
//   ① 每条用例都有明确归属（auto 或 人工队列，不会两头不靠）；
//   ② 阻塞类别必须具体（不能笼统"需要人工确认"），「需要人做什么」必须能照着做。
//
// 用法：npm run build && npm run verify:automation
import {
  classifyAutomation, estimateDuration, buildQuestion, BLOCKER_LABEL,
} from '../lib/services/automation.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const OK_ORACLE = [{ type: 'text_value', control: '实际结果：', op: 'contains', value: 'true' }];
const tri = (over = {}) => ({
  caseId: 1, caseNo: 'C-1', name: '用例', testability: 'A',
  patchApproved: false, hasPatchDraft: false, oracles: OK_ORACLE,
  steps: ['打开应用', '点击「验证」', '验证「实际结果：true」'],
  expected: '出现校验结果', recentResults: [], deviceOnline: true, ...over,
});

// ---------- 1. auto 路径 ----------
console.log('— 可自动化（auto）的充要条件 —');
{
  const v = classifyAutomation(tri());
  eq([v.decision, v.blockers], ['auto', []], 'A 类 + 有 oracle + 无外部依赖 + 有设备 → auto');
  check(v.reason.includes('可自动化'), 'auto 的理由说明为什么可自动化', v.reason);
  eq(v.question, '', 'auto 不需要问人（question 为空）');
  eq(classifyAutomation(tri({ testability: 'B', patchApproved: true })).decision, 'auto', '★ B 类且补丁已批准 → auto');
  eq(classifyAutomation(tri({ testability: 'C', patchApproved: true })).decision, 'auto', '★ C 类且补丁已批准 → auto');
  eq(classifyAutomation(tri({ testability: '' })).decision, 'auto', '未判定可测性时不因它阻塞（只要断言与依赖都满足）');
}

// ---------- 2. 各类阻塞 ----------
console.log('\n— 阻塞类别（设计 §6.7 的全部分支）—');
{
  const b1 = classifyAutomation(tri({ testability: 'B', hasPatchDraft: true }));
  eq(b1.blockers, ['demo_patch'], 'B 类补丁未批准 → demo_patch');
  check(b1.question.includes('批准'), '★ 有补丁草案时，「需要人做什么」指向批准并应用', b1.question);
  const b1c = classifyAutomation(tri({ testability: 'C', hasPatchDraft: false }));
  eq(b1c.blockers, ['demo_patch'], 'C 类无补丁草案 → demo_patch');
  check(b1c.question.includes('手工补上'), '★ 没有可自动应用的补丁时，明确告诉人要手工做', b1c.question);
  check(b1c.question.includes('覆盖矩阵'), '并指出可以去哪里找位置（覆盖矩阵）', b1c.question);

  eq(classifyAutomation(tri({ oracles: [] })).blockers, ['oracle_missing'], '无 oracle → oracle_missing');
  check(classifyAutomation(tri({ oracles: [] })).question.includes('补一条'), 'oracle_missing 的处置是"补一条可校验断言"');
  eq(classifyAutomation(tri({ oracles: undefined })).blockers, ['oracle_missing'], 'oracles 缺失同样判 oracle_missing');

  eq(classifyAutomation(tri({ testability: 'D' })).blockers, ['untestable'], 'D 类 → untestable');
  eq(classifyAutomation(tri({ steps: ['打开应用', '连接数据库查询'] })).blockers, ['external_dep'], '数据库 → external_dep');
  eq(classifyAutomation(tri({ steps: ['打开应用', '上传文件到服务器'] })).blockers, ['external_dep'], '网络/第三方 → external_dep');
  eq(classifyAutomation(tri({ steps: ['打开应用', '与另一台设备配对'] })).blockers, ['external_dep'], '第二台设备 → external_dep');
  eq(classifyAutomation(tri({ steps: ['打开应用', '插拔耳机'] })).blockers, ['external_dep'], '物理操作 → external_dep');
  eq(classifyAutomation(tri({ steps: ['打开应用', '播放视频'] })).blockers, ['video'], '视频 → video');
  eq(classifyAutomation(tri({ steps: ['打开应用', '观察动画效果'] })).blockers, ['animation'], '动画 → animation');
  eq(classifyAutomation(tri({ deviceOnline: false })).blockers, ['device_blocked'], '没有在线设备 → device_blocked');

  // ★ 有 screenshot_diff 时，动画/视频的人工判定被机器判据替代
  const withShot = classifyAutomation(tri({
    steps: ['打开应用', '播放视频'],
    oracles: [...OK_ORACLE, { type: 'screenshot_diff', threshold: 0.05 }],
  }));
  eq(withShot.blockers, [], '★ 有 screenshot_diff 判据时，视频不再需要人工判定');
  check(classifyAutomation(tri({ steps: ['打开应用', '播放视频'] })).question.includes('人工观察'),
    '没有机器判据时，明确要求人工观察并填结论');

  // flaky：最近若干次既有通过又有失败
  eq(classifyAutomation(tri({ recentResults: ['通过', '失败'] })).blockers, ['flaky'], '★ 通过/失败交替 → flaky');
  eq(classifyAutomation(tri({ recentResults: ['通过', '通过', '通过'] })).blockers, [], '一直通过不算 flaky');
  eq(classifyAutomation(tri({ recentResults: ['失败'] })).blockers, [], '只失败一次不算 flaky（可能是真缺陷）');

  // 多条阻塞同时存在时全部列出（不能只报第一条）
  const multi = classifyAutomation(tri({ testability: 'B', oracles: [], steps: ['打开应用', '播放视频', '连接数据库'], deviceOnline: false }));
  check(multi.blockers.length >= 4, '★ 多条阻塞同时存在时全部列出', JSON.stringify(multi.blockers));
  check(multi.blockers.includes('demo_patch') && multi.blockers.includes('oracle_missing')
    && multi.blockers.includes('video') && multi.blockers.includes('external_dep') && multi.blockers.includes('device_blocked'),
    '多阻塞类别齐全', JSON.stringify(multi.blockers));
  check(multi.question.split('；').length >= 4, '★ 「需要人做什么」覆盖每一项阻塞（不是只答一条）', multi.question);
  // 但队列条目要按 stage 分别落库，每条只问自己的事（见 runTriage）——
  // 这里验证"按单个 stage 生成的问题"不会牵扯别的 stage
  const onlyOracle = buildQuestion(['oracle_missing'], tri());
  check(onlyOracle.includes('oracle') && !onlyOracle.includes('批准'), '★ 单 stage 的问题只问该 stage 的事（不牵连其他阻塞）', onlyOracle);
  const onlyPatch = buildQuestion(['demo_patch'], tri({ testability: 'B', hasPatchDraft: true }));
  check(onlyPatch.includes('批准') && !onlyPatch.includes('oracle'), '★ 补丁条目不顺带要求补 oracle', onlyPatch);
}

// ---------- 3. 时长阈值 ----------
console.log('\n— 预计时长与阈值 —');
{
  eq(estimateDuration(['打开应用']), 6, '单步时长 = 固定开销 4s + 默认等待 1.5s（向上取整为 6s）');
  eq(estimateDuration(['等待 3 秒']), 7, '显式等待按实际秒数计（3 + 4）');
  eq(estimateDuration(['等待 2 分钟']), 124, '分钟级等待正确换算（120 + 4）');
  eq(estimateDuration(['打开应用', '点击「验证」']), 11, '多步累加');
  eq(estimateDuration([]), 0, '没有步骤时预估为 0（不凭空造时长）');
  const long = classifyAutomation(tri({ steps: ['打开应用', '等待 10 分钟'] }));
  check(long.blockers.includes('long_running'), '★ 预计超过阈值（默认 5 分钟）→ long_running', JSON.stringify(long.blockers));
  check(long.reason.includes('超过阈值'), '理由里写明预计时长与阈值');
  eq(classifyAutomation(tri({ steps: ['打开应用', '等待 10 分钟'] }), { maxDurationSec: 1200 }).blockers, [],
    '阈值可调（调高后不再阻塞）');
  eq(classifyAutomation(tri()).estimatedSeconds > 0, true, '总是给出预计时长（哪怕只是估计）');
  check(classifyAutomation(tri({ steps: ['打开应用', '等待 10 分钟'] })).question.includes('阈值'),
    '超时处置提示可以调阈值或拆分用例');
}

// ---------- 4. 验收项：明确归属 + 类别可读 ----------
console.log('\n— 验收项：每条用例都有明确归属 —');
{
  const cases = [
    tri({ caseId: 1, caseNo: 'A' }),
    tri({ caseId: 2, caseNo: 'B', testability: 'B' }),
    tri({ caseId: 3, caseNo: 'C', oracles: [] }),
    tri({ caseId: 4, caseNo: 'D', testability: 'D' }),
    tri({ caseId: 5, caseNo: 'E', deviceOnline: false }),
  ];
  const verdicts = cases.map((c) => classifyAutomation(c));
  check(verdicts.every((v) => v.decision === 'auto' || v.blockers.length > 0),
    '★ 每条用例要么 auto，要么带明确的阻塞类别（不存在两头不靠）', JSON.stringify(verdicts.map((v) => v.decision)));
  check(verdicts.filter((v) => v.decision === 'human').every((v) => v.reason.length > 0 && v.question.length > 0),
    '★ 进人工队列的都必须有原因与"需要人做什么"');
  const stages = new Set(verdicts.flatMap((v) => v.blockers));
  check([...stages].every((s) => !!BLOCKER_LABEL[s]), '阻塞类别都有中文标签（前端能直接显示）', JSON.stringify([...stages]));
  eq(Object.keys(BLOCKER_LABEL).length, 9, '阻塞类别共 9 种（设计 7 种 + long_running + untestable）');
}

// ---------- 5. 队列问题生成 ----------
console.log('\n— 队列问题生成 —');
{
  eq(buildQuestion([], tri()), '请人工确认该用例能否自动化', '没有已知阻塞时也有兜底问题（不留空）');
  const q = buildQuestion(['animation'], tri());
  check(q.includes('人工观察') && q.includes('screenshot_diff'), '动画类给出"人工观察 + 可改截图对比"两条出路');
  const q2 = buildQuestion(['flaky'], tri());
  check(q2.includes('抖动') || q2.includes('不稳定'), 'flaky 区分环境抖动与用例本身不稳定');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
