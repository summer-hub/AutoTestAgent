// P3 覆盖矩阵的规则层自检（无设备、无 LLM、无 DB；纯函数直接调用）。
//
// 为什么这套必须最严：矩阵是"覆盖够不够"的唯一答案，而它最容易犯的错是
// **把没测的判成测了**（假覆盖）——那会让整条流水线的质量结论全部失效。
// 所以这里逐条钉住状态判定的规则表，并专门覆盖"不许虚报 covered"的边界。
//
// 用法：npm run build && npm run verify:coverage
import {
  isTypeSymbol, isNegativeScenario, computeScenarioFit, computeStatus, computeRisks,
  collectDeviceControls, buildMatrixRow, summarizeMatrix, renderMatrixMarkdown, renderMatrixCsv,
} from '../lib/services/coverageMatrix.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

/** 造一个符号输入，只覆盖本用例关心的字段。 */
function input(over = {}) {
  return {
    symbol: {
      id: 1, name: 'S', kind: 'function', params: [], methods: [], deprecated: false,
      detailLevel: 'full', sourceFile: 'library/index.ts', sourceLine: 1, signature: '(a)',
      ...(over.symbol ?? {}),
    },
    demoCalls: over.demoCalls ?? [],
    testCalls: over.testCalls ?? [],
    paramPoints: over.paramPoints ?? [],
    traversal: over.traversal ?? null,
    cases: over.cases ?? [],
  };
}
const caseOf = (no, kind) => ({ id: 1, caseNo: no, name: `用例 ${no}`, scenarioKind: kind });

// ---------- 1. 状态判定规则表 ----------
console.log('— 状态判定规则表（covered / partial / not_covered / blocked）—');
{
  const call = { pagePath: 'pages/A', sourceFile: 'entry/src/main/ets/pages/A.ets', sourceLine: 10, snippet: 'new S()' };

  eq(computeStatus(input({ symbol: { kind: 'type' }, demoCalls: [call] })).status, 'blocked',
    '类型符号即使 demo 里用了也是 blocked（真机 UI 触发不了类型）');
  eq(computeStatus(input({ symbol: { kind: 'interface' } })).status, 'blocked', 'interface 同样 blocked');
  check(computeStatus(input({ symbol: { kind: 'type' } })).reason.includes('真机'), 'blocked 的理由说明"真机不可触发"');
  eq(computeStatus(input({ symbol: { deprecated: true }, demoCalls: [call] })).status, 'blocked',
    '已废弃接口 blocked（不再为它补用例）');

  eq(computeStatus(input()).status, 'not_covered', '完全没被碰过 → not_covered');
  eq(computeStatus(input({ testCalls: [{ sourceFile: 'x.test.ets', sourceLine: 1 }] })).status, 'partial',
    '只有单元测试调用 → partial（真机路径未覆盖），不是 covered');
  check(computeStatus(input({ testCalls: [{ sourceFile: 'x.test.ets', sourceLine: 1 }] })).reason.includes('真机路径未覆盖'),
    'test-only 的理由写清"真机路径未覆盖"');
  eq(computeStatus(input({ cases: [caseOf('C-1', 'happy')] })).status, 'partial',
    '有用例但 demo 没调用 → partial（用例可执行性待确认）');

  // ★ 不许虚报 covered：demo 调用本身只是"正向"
  eq(computeStatus(input({ demoCalls: [call] })).status, 'partial', '★ demo 有调用但无用例 → partial（不虚报 covered）');
  eq(computeStatus(input({ demoCalls: [call], cases: [caseOf('C-1', 'happy')] })).status, 'partial',
    '★ demo 调用 + 只有正向用例 → 仍是 partial');
  eq(computeStatus(input({ demoCalls: [call], cases: [caseOf('C-9', 'bigdata')] })).status, 'partial',
    '★ 大数据用例不算负向 → 仍 partial');
  eq(computeStatus(input({ demoCalls: [call], cases: [caseOf('C-2', 'empty')] })).status, 'covered',
    '★ demo 调用 + 空值用例 → covered');
  eq(computeStatus(input({ demoCalls: [call], cases: [caseOf('C-3', 'boundary')] })).status, 'covered',
    '★ demo 调用 + 边界用例 → covered');
  check(computeStatus(input({ demoCalls: [call], cases: [caseOf('C-2', 'empty')] })).reason.includes('C-2'),
    'covered 的理由里带负向用例编号（可核对）');
  eq(computeStatus(input({ demoCalls: [call, { ...call, sourceLine: 20 }], cases: [caseOf('C-4', 'boundary')] })).status,
    'covered', '多个调用点 + 负向用例 → covered');

  check(isNegativeScenario('empty') && isNegativeScenario('boundary'), 'empty/boundary 属于负向场景');
  check(!isNegativeScenario('happy') && !isNegativeScenario('bigdata'), 'happy/bigdata 不属于负向场景');
  check(isTypeSymbol('type') && isTypeSymbol('interface') && !isTypeSymbol('class'), '类型符号判定');
}

// ---------- 2. 真机控件装配 ----------
console.log('\n— 真机遍历证据装配 —');
{
  const traversal = {
    reportFile: 'workspace/explore/lib/explore_1.json',
    routes: new Map([
      ['pages/A', { controls: ['验证', '期待结果：'], path: ['首页', 'Simple Object Validation'] }],
      ['pages/B', { controls: ['播放'], path: ['首页', 'Very Simple'] }],
    ]),
  };
  const hit = collectDeviceControls(input({
    demoCalls: [{ pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' }],
    traversal,
  }));
  eq(hit.routes, ['pages/A'], '只匹配 demo 调用点所在页面对应的路由');
  eq(hit.controls, ['验证', '期待结果：'], '带出该页在真机上实际收录到的控件文本');
  eq(hit.pagePath, '首页 → Simple Object Validation', '带出真机上的页面路径（人可核对）');

  const miss = collectDeviceControls(input({
    demoCalls: [{ pagePath: 'pages/Z', sourceFile: 'z.ets', sourceLine: 1, snippet: '' }],
    traversal,
  }));
  eq(miss.routes, [], '遍历报告里没有的页面 → 不编造控件证据');

  const none = collectDeviceControls(input({ demoCalls: [call0()], traversal: null }));
  eq(none.routes, [] , '没有遍历报告时不报错、返回空证据');
  function call0() { return { pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' }; }
}

// ---------- 3. 场景适用性 ----------
console.log('\n— 场景适用性（静态初判）—');
{
  const fit0 = computeScenarioFit(input({ symbol: { params: [] } }));
  eq(fit0, { happy: true, empty: false, boundary: false, bigdata: false }, '无参数无方法：只有 happy 适用');
  const fit1 = computeScenarioFit(input({ symbol: { params: [{ name: 'a', type: 'string', optional: false, defaultValue: '', doc: '' }] } }));
  eq(fit1, { happy: true, empty: true, boundary: true, bigdata: true }, 'string 参数：四类都适用');
  const fit2 = computeScenarioFit(input({ symbol: { params: [{ name: 'n', type: 'number', optional: false, defaultValue: '', doc: '' }] } }));
  eq(fit2, { happy: true, empty: true, boundary: true, bigdata: false }, 'number 参数：大数据不适用');
  const fit3 = computeScenarioFit(input({ symbol: { methods: ['validate', 'addSchema'] } }));
  eq(fit3, { happy: true, empty: true, boundary: true, bigdata: false }, '类（有方法但构造无参）：empty/boundary 适用');
  const fit4 = computeScenarioFit(input({ symbol: { params: [{ name: 'xs', type: 'Array', optional: false, defaultValue: '', doc: '' }] } }));
  check(fit4.bigdata === true, 'Array 参数 → 大数据适用');
}

// ---------- 4. 风险标记 ----------
console.log('\n— 风险标记 —');
{
  const call = { pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' };
  const traversal = { reportFile: 'r.json', routes: new Map([['pages/A', { controls: ['验证'], path: ['首页', 'A'] }]]) };

  eq(computeRisks(input({ symbol: { name: 'X', detailLevel: 'name-only' } }), 'not_covered'), ['name_only_signature', 'no_case', 'no_traversal_evidence'],
    '未定位到定义体 → name_only_signature');
  check(!computeRisks(input({ symbol: { detailLevel: 'decl-only' } }), 'partial').includes('name_only_signature'),
    '★ decl-only 不算签名不可信（否则 16 个符号会误标 14 个，真问题被淹没）');
  check(!computeRisks(input({ symbol: { detailLevel: 'full' } }), 'partial').includes('name_only_signature'), 'full 不算签名不可信');

  check(computeRisks(input({ symbol: { kind: 'type' } }), 'blocked').includes('type_symbol'), '类型符号带 type_symbol');
  check(computeRisks(input({ testCalls: [{ sourceFile: 't.ets', sourceLine: 1 }] }), 'partial').includes('test_only'), '只有单测 → test_only');
  check(computeRisks(input({ cases: [caseOf('C-1', 'happy')] }), 'partial').includes('no_negative_case'), '只有正向用例 → no_negative_case');
  check(!computeRisks(input({ cases: [caseOf('C-2', 'boundary')] }), 'covered').includes('no_negative_case'), '有负向用例就不标 no_negative_case');
  check(computeRisks(input({ cases: [caseOf('C-2', 'boundary')] }), 'covered').includes('no_case') === false, '有用例就不标 no_case');
  check(computeRisks(input({ demoCalls: [call], traversal }), 'partial').includes('no_device_control') === false,
    '遍历报告里有对应页面 → 不标 no_device_control');
  check(computeRisks(input({ demoCalls: [call], traversal: { reportFile: 'r.json', routes: new Map() } }), 'partial').includes('no_device_control'),
    'demo 调用了但遍历里没这页 → no_device_control');
  check(computeRisks(input({ symbol: { deprecated: true } }), 'blocked').includes('deprecated'), '废弃接口带 deprecated');
  check(computeRisks(input({
    symbol: { params: [{ name: 'a', type: 'string', optional: false, defaultValue: '', doc: '' }] },
    demoCalls: [call], traversal,
  }), 'partial').includes('no_endpoint_for_param'), '有参数但页面上没有可注入数据点 → no_endpoint_for_param');
  check(!computeRisks(input({
    symbol: { params: [{ name: 'a', type: 'string', optional: false, defaultValue: '', doc: '' }] },
    demoCalls: [call], paramPoints: [{ pagePath: 'pages/A', name: 'message0', sourceFile: 'a.ets', sourceLine: 3 }], traversal,
  }), 'partial').includes('no_endpoint_for_param'), '页面上有数据点 → 不标 no_endpoint_for_param');
  check(!computeRisks(input({}), 'not_covered').includes('api_only'),
    'api_only 不由规则自动产生（静态证明不了"UI 触发不到"，硬标就是猜）');
}

// ---------- 5. 行装配 ----------
console.log('\n— 行装配与统计 —');
{
  const call = { pagePath: 'pages/A', sourceFile: 'entry/src/main/ets/pages/A.ets', sourceLine: 42, snippet: 'new S()' };
  const traversal = { reportFile: 'r.json', routes: new Map([['pages/A', { controls: ['验证'], path: ['首页', 'A'] }]]) };
  const row = buildMatrixRow(input({
    symbol: { id: 7, name: 'Validator', kind: 'class', params: [{ name: 'x', type: 'object', optional: false, defaultValue: '', doc: '' }] },
    demoCalls: [call], testCalls: [{ sourceFile: 't.ets', sourceLine: 9 }],
    cases: [caseOf('C-1', 'happy'), caseOf('C-2', 'boundary')], traversal,
    paramPoints: [{ pagePath: 'pages/A', name: 'message0', sourceFile: 'a.ets', sourceLine: 3 }],
  }));
  eq(row.status, 'covered', '装配后的状态');
  eq(row.symbolId, 7, '带符号 id');
  eq(row.evidence.demoCall.sourceLine, 42, '证据带 demo 调用点行号');
  eq(row.evidence.testCallCount, 1, '证据带单元测试调用数');
  eq(row.evidence.negativeCaseNos, ['C-2'], '证据区分负向用例');
  eq(row.evidence.deviceControls, ['验证'], '证据带真机控件');
  check(row.deviceReachable === true, '标记真机可达');
  eq(row.evidence.traversalReport, 'r.json', '证据记录遍历报告来源');
}

// ---------- 6. 覆盖率统计 ----------
console.log('\n— 覆盖率统计 —');
{
  const mk = (status, cases = [], fit = { happy: true, empty: false, boundary: false, bigdata: false }, neg = []) => ({
    symbolId: 1, symbolName: 's', kind: 'function', status, statusReason: '', riskFlags: [],
    scenarioFit: fit, deviceReachable: false,
    evidence: { testCallCount: 0, traversalReport: '', deviceControls: [], devicePagePath: '', caseNos: cases, negativeCaseNos: neg, paramPoints: [] },
  });
  const s = summarizeMatrix([
    mk('covered', ['C-1'], { happy: true, empty: true, boundary: true, bigdata: false }, ['C-1']),
    mk('partial'),
    mk('not_covered'),
    mk('blocked'),
  ]);
  eq([s.total, s.covered, s.partial, s.notCovered, s.blocked], [4, 1, 1, 1, 1], '各状态计数');
  // 可测符号 = 非 blocked = 3；有用例的 = 1 → 33.3%
  eq(s.apiCoverage, 33.3, '★ 接口覆盖率的分母排除 blocked（真机测不了的别拉低指标）');
  const empty = summarizeMatrix([]);
  eq([empty.total, empty.apiCoverage, empty.scenarioCoverage], [0, 0, 0], '空矩阵不出现 NaN');
  const allBlocked = summarizeMatrix([mk('blocked')]);
  eq(allBlocked.apiCoverage, 0, '全部 blocked 时覆盖率为 0 而不是 NaN');
}

// ---------- 7. 导出 ----------
console.log('\n— 导出（Markdown / CSV）—');
{
  const row = buildMatrixRow(input({
    symbol: { id: 1, name: 'Validator', kind: 'class', params: [{ name: 'a', type: 'string', optional: false, defaultValue: '', doc: '' }] },
    demoCalls: [{ pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 3, snippet: '' }],
    cases: [caseOf('C-2', 'boundary')],
  }));
  row.riskFlags = ['test_only'];
  const summary = summarizeMatrix([row]);
  const md = renderMatrixMarkdown('demo-lib', '1.0.0', [row], summary);
  check(md.includes('# demo-lib · 接口覆盖矩阵'), 'Markdown 标题含库名');
  check(md.includes('| `Validator` | class | **covered** |'), 'Markdown 表格含符号与状态');
  check(md.includes('接口覆盖率'), 'Markdown 含覆盖率指标');
  check(md.includes('风险分布') && md.includes('test_only'), 'Markdown 含风险分布段');

  const csv = renderMatrixCsv([row]);
  const lines = csv.split('\n');
  check(lines[0].startsWith('"symbol","kind","status"'), 'CSV 表头正确', lines[0]);
  check(lines.length === 2, 'CSV 行数 = 1 表头 + 1 数据');
  check(lines[1].includes('"Validator"') && lines[1].includes('"covered"'), 'CSV 数据行含符号与状态');
  // 逗号/引号必须被转义，否则丢进 Excel 会串列
  const messy = buildMatrixRow(input({
    symbol: { id: 2, name: 'Weird,Name', kind: 'function' },
    demoCalls: [{ pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 3, snippet: '' }],
  }));
  const csv2 = renderMatrixCsv([messy]);
  check(csv2.includes('"Weird,Name"'), '★ 名字里的逗号被引号包住（不串列）', csv2.split('\n')[1].slice(0, 40));
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
