// P4 用例计划的规则层自检（无设备、无 LLM、无 DB；纯函数直接调用）。
//
// 为什么必须钉死：P4 决定"该造哪几条用例、造几条"。判错有两个方向都致命 ——
//   造多了：给没有输入的接口硬编"大数据"用例，产出一批跑不了也断言不了的垃圾；
//   造少了：带 3 种异常码的接口只给 1 条边界用例，漏测。
// 而这两件事一旦交给 LLM 自行判断就无法核对，所以适用性/条数全部由这里的纯函数决定，
// LLM 只负责把每条计划写成具体用例。
//
// 用法：npm run build && npm run verify:case-plan
import {
  computeApplicability, computeNegExtra, computeTriggers, planSymbolCases, samplePlan, summarizePlans,
  SCENARIO_LABEL, SCENARIO_ORDER,
} from '../lib/services/casePlan.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

/** 造一个符号输入。 */
function sym(over = {}) {
  return {
    id: 1, name: 'S', kind: 'function', signature: '(a)', detailLevel: 'full', deprecated: false,
    params: [], returns: { type: '', doc: '' }, throws: [], methods: [],
    demoCalls: [], testCallCount: 0, deviceControls: [], paramPoints: [],
    ...over,
  };
}
const P = (name, type, optional = false, doc = '') => ({ name, type, optional, defaultValue: '', doc });

// ---------- 1. happy 恒适用 ----------
console.log('— happy 恒适用 —');
{
  const a1 = computeApplicability(sym());
  check(a1.fit.happy === true, '无参数无方法的接口也必适用正向');
  check(a1.reasons.happy.includes('必适用'), '正向的理由写明"必适用"');
  const plans = planSymbolCases(sym());
  eq(plans.length, 1, '只适用正向时恰好 1 条用例');
  eq(plans[0].scenario, 'happy', '该条是正向');
  eq(plans[0].priority, 'P0', '正向是 P0（必跑）');
}

// ---------- 2. empty 适用性 ----------
console.log('\n— empty 空值适用性 —');
{
  check(computeApplicability(sym({ params: [P('a', 'string')] })).fit.empty === true, '字符串参数 → 空值适用（可传空串）');
  check(computeApplicability(sym({ params: [P('xs', 'Array')] })).fit.empty === true, '数组参数 → 空值适用（可传空数组）');
  check(computeApplicability(sym({ params: [P('o', 'object')] })).fit.empty === true, '对象参数 → 空值适用');
  check(computeApplicability(sym({ params: [P('n', 'number')] })).fit.empty === false, '仅数值参数且非可选 → 空值不适用');
  check(computeApplicability(sym({ params: [P('n', 'number', true)] })).fit.empty === true, '可选参数 → 空值适用（不传即空值路径）');
  check(computeApplicability(sym({ kind: 'class', methods: ['setData', 'render'] })).fit.empty === true, 'setter 类接口 → 空值适用（可设空值）');
  check(computeApplicability(sym({ kind: 'class', methods: ['render'] })).fit.empty === true, '类方法可在未初始化状态下调用 → 空值适用');
  const r = computeApplicability(sym({ params: [P('n', 'number')] }));
  check(r.reasons.empty.includes('不适用'), '不适用的理由要写出来（不是留空）', r.reasons.empty);
  const r2 = computeApplicability(sym({ params: [P('a', 'string')] }));
  check(r2.reasons.empty.includes('字符串') || r2.reasons.empty.includes('容器'), '适用的理由指到具体参数', r2.reasons.empty);
}

// ---------- 3. boundary 适用性 ----------
console.log('\n— boundary 边界异常适用性 —');
{
  check(computeApplicability(sym({ throws: [{ type: 'SchemaError', doc: '非法 schema' }] })).fit.boundary === true,
    '有声明异常 → 边界适用');
  check(computeApplicability(sym({ params: [P('n', 'number')] })).fit.boundary === true, '数值参数 → 有取值范围，边界适用');
  check(computeApplicability(sym({ kind: 'class', methods: ['init', 'release', 'play'] })).fit.boundary === true,
    '状态机方法（init/release/play）→ 边界适用（可重复/逆序/释放后调用）');
  check(computeApplicability(sym({ params: [P('schema', 'object')] })).fit.boundary === true, '结构体参数 → 可构造类型错误，边界适用');
  check(computeApplicability(sym({ params: [P('s', 'string')] })).fit.boundary === false,
    '仅字符串参数、无异常声明、无状态机 → 边界不适用（不硬凑）');
  const r = computeApplicability(sym({ params: [P('s', 'string')] }));
  check(r.reasons.boundary.includes('不适用'), '不适用的理由写出来', r.reasons.boundary);
}

// ---------- 4. bigdata 适用性 ----------
console.log('\n— bigdata 大数据适用性 —');
{
  check(computeApplicability(sym({ params: [P('list', 'Array')] })).fit.bigdata === true, '数组参数 → 大数据适用');
  check(computeApplicability(sym({ params: [P('count', 'number', false, '条目数量')] })).fit.bigdata === true,
    '参数说明含"数量" → 大数据适用');
  check(computeApplicability(sym({ name: 'render' })).fit.bigdata === true, '接口名涉及渲染 → 大数据适用');
  check(computeApplicability(sym({ kind: 'class', methods: ['setData'] })).fit.bigdata === true, '方法处理内容（setData）→ 大数据适用');
  check(computeApplicability(sym({ name: 'validate' })).fit.bigdata === false,
    '"validate" 这类名字本身不含集合/媒体语义 → 不靠名字判适用（真实数据里它是靠参数类型判适用的）');
  check(computeApplicability(sym({ name: 'noop', params: [P('flag', 'boolean')] })).fit.bigdata === false,
    '无尺寸参数且与集合·媒体无关 → 大数据不适用');
}

// ---------- 5. 数量模型 ----------
console.log('\n— 数量模型（设计与实现的算式逐项核对）—');
{
  // 无参数无异常：只有 happy → 1 条
  eq(planSymbolCases(sym()).length, 1, '纯 happy = 1 条');

  // 字符串参数：happy + empty + 无 boundary/bigdata? （string 是容器类型 → bigdata 适用）
  const a = planSymbolCases(sym({ params: [P('s', 'string')] }));
  eq(a.filter((x) => x.scenario === 'happy').length, 1, 'happy 1 条');
  eq(a.filter((x) => x.scenario === 'empty').length, 1, 'empty 1 条');
  eq(a.filter((x) => x.scenario === 'boundary').length, 0, 'boundary 不适用 → 0 条（不硬凑）');
  eq(a.filter((x) => x.scenario === 'bigdata').length, 1, 'bigdata 1 条');

  // 异常码 3 种 → 边界类 = 1 + 3 = 4
  const b = planSymbolCases(sym({
    params: [P('n', 'number')],
    throws: [{ type: 'E1', doc: '' }, { type: 'E2', doc: '' }, { type: 'E3', doc: '' }],
  }));
  eq(b.filter((x) => x.scenario === 'boundary').length, 4, '★ 声明 3 类异常 → 边界类 1+3=4 条（负向条数由语义决定）');
  check(b.filter((x) => x.scenario === 'boundary').slice(1).every((x) => x.because.includes('异常')), '每条额外边界用例的理由写明是哪个异常',
    JSON.stringify(b.filter((x) => x.scenario === 'boundary').map((x) => x.because)));

  // 状态机 → 边界类额外 +1
  const c = planSymbolCases(sym({ kind: 'class', methods: ['init', 'release'] }));
  const cBoundary = c.filter((x) => x.scenario === 'boundary');
  eq(cBoundary.length, 2, '★ 状态机 → 边界类 1+1=2 条（重复调用/未初始化）');
  check(cBoundary.some((x) => x.because.includes('状态机')), '状态机那条有理由');

  // 两个以上可选参数 → empty 额外 +1
  const d = planSymbolCases(sym({ params: [P('a', 'string', true), P('b', 'string', true)] }));
  eq(d.filter((x) => x.scenario === 'empty').length, 2, '两个可选参数 → empty 1+1=2 条');

  // negExtra 的返回值本身
  eq(computeNegExtra(sym({ throws: [{ type: 'E1', doc: '' }, { type: 'E2', doc: '' }], methods: ['init'] })).boundary, 3,
    'negExtra.boundary = 异常数 2 + 状态机 1');
  eq(computeNegExtra(sym({ params: [P('a', 'string', true), P('b', 'string', true)] })).empty, 1,
    'negExtra.empty = 多个可选参数 +1');
  eq(computeNegExtra(sym({ params: [P('a', 'string', true)] })).empty, 0, '只有一个可选参数时不加');
}

// ---------- 6. 触发器展开 ----------
console.log('\n— 触发器展开（同一接口多个入口）—');
{
  const one = sym({ demoCalls: [{ pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' }] });
  eq(computeTriggers(one).length, 1, '一个入口 → 1 个触发器');
  eq(planSymbolCases(one).filter((x) => x.scenario === 'happy').length, 1, '一个入口 → 1 条正向');

  const three = sym({
    demoCalls: [
      { pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' },
      { pagePath: 'pages/B', sourceFile: 'b.ets', sourceLine: 2, snippet: '' },
      { pagePath: 'pages/C', sourceFile: 'c.ets', sourceLine: 3, snippet: '' },
    ],
  });
  eq(computeTriggers(three).length, 3, '三个页面 → 3 个触发器');
  const threePlans = planSymbolCases(three);
  eq(threePlans.filter((x) => x.scenario === 'happy').length, 3, '★ 三个入口 → 正向按入口展开为 3 条');
  check(threePlans.filter((x) => x.scenario === 'happy').slice(1).every((x) => x.because.includes('入口')), '扩展出来的条目标明是按入口展开');
  eq(threePlans.filter((x) => x.scenario === 'happy').map((x) => x.triggerPage), ['pages/A', 'pages/B', 'pages/C'], '每条绑定到自己的入口页面');

  // 入口很多时：计划条数被截，理由里必须写明"共 N 个入口，本次展开前 M 个"
  const manyPage = sym({ demoCalls: Array.from({ length: 9 }, (_, i) => ({ pagePath: `pages/P${i}`, sourceFile: 'a.ets', sourceLine: i + 1, snippet: '' })) });
  const capped3 = planSymbolCases(manyPage);
  eq(capped3.filter((x) => x.scenario === 'happy').length, 3, '入口很多时正向只展开 3 条（防爆炸）');
  check(capped3.filter((x) => x.scenario === 'happy').slice(1).every((x) => x.because.includes('共 9 个入口')), '★ 截断要在理由里写明"共 9 个入口，本次前 3 个"（不静默截断）',
    capped3[1].because);

  // 同一页面多次调用只算一个入口
  const samePage = sym({ demoCalls: [
    { pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 1, snippet: '' },
    { pagePath: 'pages/A', sourceFile: 'a.ets', sourceLine: 9, snippet: '' },
  ] });
  eq(computeTriggers(samePage).length, 1, '同页多次调用 → 只算 1 个入口');

  // 防爆炸：入口数受限
  const capped = planSymbolCases(three, { maxTriggersPerSymbol: 2 });
  eq(capped.filter((x) => x.scenario === 'happy').length, 2, 'maxTriggersPerSymbol 生效（防条数爆炸）');
  const cappedAll = planSymbolCases(sym({ params: [P('n', 'number')], throws: [{ type: 'E', doc: '' }] }), { maxCasesPerSymbol: 2 });
  eq(cappedAll.length, 2, 'maxCasesPerSymbol 生效');
}

// ---------- 7. 优先级与完整性保证 ----------
console.log('\n— 优先级与"每接口 ≥1 正向" —');
{
  const all = planSymbolCases(sym({ params: [P('n', 'number')], throws: [{ type: 'E', doc: '' }], methods: ['init'] }));
  const byScenario = {};
  for (const x of all) byScenario[x.scenario] = (byScenario[x.scenario] ?? 0) + 1;
  check(byScenario.happy >= 1, '★ 每接口至少 1 条正向（设计验收项）', JSON.stringify(byScenario));
  eq(all.filter((x) => x.scenario === 'happy').map((x) => x.priority), ['P0'], '正向优先级 P0');
  check(all.filter((x) => x.scenario === 'empty' || x.scenario === 'boundary').every((x) => x.priority === 'P1'), '空值/边界优先级 P1');
  check(all.filter((x) => x.scenario === 'bigdata').every((x) => x.priority === 'P2'), '大数据优先级 P2');
  // 适用维度全覆盖：判定适用的维度都必须有计划条目
  const fit = computeApplicability(sym({ params: [P('n', 'number')], throws: [{ type: 'E', doc: '' }], methods: ['init'] }));
  const planned = new Set(all.map((x) => x.scenario));
  check(SCENARIO_ORDER.every((s) => !fit.fit[s] || planned.has(s)), '★ 判定适用的维度全部有计划条目（设计验收项）',
    JSON.stringify({ fit: fit.fit, planned: [...planned] }));
  check(all.every((x) => x.purpose && x.because && x.inputPlan && x.assertionPlan), '每条都有目的/依据/输入设计/断言要点（可解释）');
  check(all.every((x) => x.symbolId === 1 && x.symbolName === 'S'), '每条都带符号溯源（能回填 api_symbol_id）');
  check(SCENARIO_LABEL.happy === '正向' && SCENARIO_LABEL.bigdata === '大数据', '场景中文标签齐全');
}

// ---------- 8. 数量报告必须与计划一致 ----------
console.log('\n— 数量报告 ↔ 计划一致性 —');
{
  const symA = sym({ id: 1, name: 'A', demoCalls: Array.from({ length: 9 }, (_, i) => ({ pagePath: `pages/P${i}`, sourceFile: 'x', sourceLine: i, snippet: '' })) });
  const symB = sym({ id: 2, name: 'B', kind: 'class', params: [P('n', 'number')], throws: [{ type: 'E1', doc: '' }, { type: 'E2', doc: '' }], methods: ['init', 'release'] });
  const plansA = planSymbolCases(symA);
  const plansB = planSymbolCases(symB);
  const all = [...plansA, ...plansB];
  const s = summarizePlans([{ symbolId: 1, name: 'A' }, { symbolId: 2, name: 'B' }], all);

  eq(s.planned, all.length, '总数 = 实际计划条数');
  eq(s.byScenario.happy + s.byScenario.empty + s.byScenario.boundary + s.byScenario.bigdata, all.length,
    '★ 场景分布之和 = 总数（不丢不重）');
  eq(s.byPriority.P0 + s.byPriority.P1 + s.byPriority.P2, all.length, '★ 优先级分布之和 = 总数');
  // ★ 报告写的条数必须等于实际生成的条数（这里曾出现"报告 17 条、实际 3 条"）
  const rowA = s.perSymbolBreakdown.find((x) => x.name === 'A');
  eq(rowA.happy, plansA.filter((x) => x.scenario === 'happy').length,
    '★ 分解表里的"正向条数"等于实际生成条数（曾出现报告 17 / 实际 3 的不一致）', `报告=${rowA.happy} 实际=${plansA.filter((x) => x.scenario === 'happy').length}`);
  const rowB = s.perSymbolBreakdown.find((x) => x.name === 'B');
  eq([rowB.happy, rowB.empty, rowB.boundary, rowB.bigdata],
    ['happy', 'empty', 'boundary', 'bigdata'].map((sc) => plansB.filter((x) => x.scenario === sc).length),
    '分解表逐符号逐场景与实际一致');
  const sumRows = s.perSymbolBreakdown.reduce((n, r) => n + r.happy + r.empty + r.boundary + r.bigdata, 0);
  eq(sumRows, all.length, '★ 分解表各行之和 = 总数');
  check(s.perSymbolBreakdown.every((r) => r.name !== ''), '分解表带符号名（人对得上）');
}

// ---------- 9. 显式抽样 ----------
console.log('\n— 显式抽样（绝不静默截断）—');
{
  const many = planSymbolCases(sym({
    params: [P('n', 'number')],
    throws: [{ type: 'E1', doc: '' }, { type: 'E2', doc: '' }, { type: 'E3', doc: '' }, { type: 'E4', doc: '' }],
    methods: ['init', 'release'],
  }));
  check(many.length > 3, '构造出足够多的用例', `n=${many.length}`);

  const s1 = samplePlan(many, 100);
  eq(s1.selected.length, many.length, '预算充足时全部纳入');
  eq(s1.skipped.length, 0, '没有丢弃');
  check(s1.report.includes('全部纳入'), '报告写明全部纳入', s1.report);

  const s2 = samplePlan(many, 2);
  eq(s2.selected.length, 2, '预算内执行 2 条');
  check(s2.skipped.length === many.length - 2, '★ 未执行的条数被明确报出（不静默截断）', `skipped=${s2.skipped.length}`);
  check(s2.report.includes('未执行'), '★ 报告写明未执行多少条及原因', s2.report);
  const p0 = many.filter((x) => x.priority === 'P0');
  check(p0.every((x) => s2.selected.includes(x)), '★ 裁剪时 P0（必跑正向）一条都不丢', `P0=${p0.length}`);
  check(s2.selected.length + s2.skipped.length === many.length, '★ 执行 + 未执行 = 总数（条数守恒，不丢不重）');
  const s2b = samplePlan(many, many.length - 1);
  check(!s2b.skipped.some((x) => x.priority === 'P0'), '裁剪到只剩 1 条时，被裁掉的也不会是 P0');
  const s3 = samplePlan(many, 0);
  eq(s3.selected.length, many.length, '预算 0/不限时全部纳入');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
