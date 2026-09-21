// 场景级覆盖度（Demo 场景 × Demo 代码）的规则层自检。
// 无设备、无 LLM、无 DB：只调 lib/services/demoScenarios.js 里的纯函数。
//
// 这套必须严的原因：场景覆盖度是"demo 到底验证了没有"的对外数字，
// 最容易犯的错是**解析器悄悄失败却输出 0%**（看着像"没覆盖"，其实是文档格式没认出来）。
// 所以这里既钉解析规则，也钉"认不出来必须报警告而不是给默认值"。
//
// 用法：npm run build && npm run verify:demo-scenarios
import {
  parseStatus, parseRatio, splitRow, parseScenarioHeading, extractInterfaces, normalizeApi,
  parseScenarioList, parseCoverageReport, mergeScenarioCoverage, summarizeScenarioCoverage,
  renderScenarioCoverageMarkdown, STATUS_LABEL,
} from '../lib/services/demoScenarios.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

// ---------- 1. 基本解析原语 ----------
console.log('— 解析原语 —');
{
  eq(parseStatus('✅'), 'covered', '✅ → covered');
  eq(parseStatus('🔶'), 'partial', '🔶 → partial');
  eq(parseStatus('❌'), 'uncovered', '❌ → uncovered');
  eq(parseStatus('✅ 完全覆盖'), 'covered', '「✅ 完全覆盖」也能认');
  eq(parseStatus('未覆盖'), 'uncovered', '纯文字「未覆盖」也能认');
  eq(parseStatus('???'), null, '★ 认不出的状态一律返回 null（不许默认成 covered/uncovered）');

  eq(parseRatio('2/2 (100%)'), { covered: 2, total: 2 }, '2/2 (100%) 解析');
  eq(parseRatio('0/4 (0%)'), { covered: 0, total: 4 }, '0/4 (0%) 解析');
  eq(parseRatio('—'), null, '★ 非比例格子返回 null');

  eq(splitRow('| a | b | c |'), ['a', 'b', 'c'], '表格行拆分');
  eq(splitRow('不是表格'), [], '非表格行返回空');

  eq(parseScenarioHeading('#### P01 简单类型校验'), { no: 'P01', name: '简单类型校验' }, '场景标题解析');
  eq(parseScenarioHeading('#### N07 空值 / 空容器边界'), { no: 'N07', name: '空值 / 空容器边界' }, '反向场景标题解析');
  eq(parseScenarioHeading('### 正向场景'), null, '非场景标题返回 null');

  eq(extractInterfaces('- 执行校验（对应接口：`Validator.validate(instance, schema)` → `ValidatorResult.valid`）'),
    ['Validator.validate', 'ValidatorResult.valid'], '功能点里取接口（去掉调用括号/参数）');
  eq(normalizeApi('new Validator()'), 'Validator', '`new Validator()` → Validator');
  eq(normalizeApi('Validator.prototype.customFormats'), 'Validator.prototype.customFormats', 'prototype 形式保留');
}

// ---------- 2. 场景清单解析 ----------
console.log('— 场景清单解析 —');
const SCENARIO_MD = [
  '# demo 场景',
  '',
  '## 功能模块映射',
  '',
  '| 模块 | 主要接口 | 正向场景 | 反向场景 |',
  '|---|---|---|---|',
  '| 校验入口 | `new Validator()`、`Validator.validate()` | P01, P02 | N01 |',
  '| 错误对象 | `ValidatorResult` | P03 | — |',
  '',
  '## 场景列表',
  '',
  '### 正向场景',
  '',
  '#### P01 简单类型校验',
  '',
  '**场景类型**：正向',
  '',
  '**场景涉及的功能点**',
  '- 创建校验器（对应接口：`new Validator()`）',
  '- 执行校验（对应接口：`Validator.validate(instance, schema)`）',
  '',
  '**依据**：README。',
  '',
  '#### P02 带引用的复杂对象',
  '',
  '**场景类型**：正向',
  '',
  '**场景涉及的功能点**',
  '- 注册子 schema（对应接口：`Validator.addSchema(schema, uri)`）',
  '',
  '#### P03 结果对象可读',
  '',
  '**场景类型**：正向',
  '',
  '**场景涉及的功能点**',
  '- 读取结果（对应接口：`ValidatorResult`）',
  '',
  '### 反向场景',
  '',
  '#### N01 未定义实例',
  '',
  '**场景类型**：反向',
  '',
  '**场景涉及的功能点**',
  '- 空值（对应接口：`Validator.validate()`）',
  '',
].join('\n');

{
  const r = parseScenarioList(SCENARIO_MD);
  eq(r.scenarios.length, 4, '解析出 4 个场景');
  eq(r.scenarios.map((s) => s.no), ['P01', 'P02', 'P03', 'N01'], '场景编号与顺序');
  eq(r.scenarios[0].kind, 'positive', 'P01 是正向');
  eq(r.scenarios[3].kind, 'negative', 'N01 是反向');
  eq(r.scenarios[0].module, '校验入口', '模块归属来自映射表');
  eq(r.scenarios[2].module, '错误对象', 'P03 归到错误对象模块');
  eq(r.scenarios[0].interfaces, ['Validator', 'Validator.validate'], 'P01 的接口清单');
  eq(r.warnings, [], '正常文档不应产生告警');

  // ★ 缺「场景类型」行 → 必须告警，而不是静默按前缀猜
  const noType = parseScenarioList(SCENARIO_MD.replace('**场景类型**：反向\n', ''));
  check(noType.warnings.some((w) => w.includes('缺少「场景类型」')), '★ 缺场景类型行会产生告警');
  eq(noType.scenarios[3].kind, 'negative', '缺类型行时按编号前缀 N 兜底为反向');

  // ★ 完全解析不出场景 → 必须告警
  const broken = parseScenarioList('# 只是一份说明\n没有表格也没有场景标题\n');
  check(broken.warnings.some((w) => w.includes('功能模块映射')), '★ 缺模块表要告警');
  check(broken.warnings.some((w) => w.includes('场景标题')), '★ 解析不出场景要告警');
  eq(broken.scenarios.length, 0, '解析不出来就是 0 条，不编造');
}

// ---------- 3. 覆盖率报告解析 ----------
console.log('— 覆盖率报告解析 —');
const REPORT_MD = [
  '# 覆盖率报告',
  '',
  '> **基线 Demo（用户仓库，只读）**：整体覆盖率 **62.5%**',
  '',
  '### 正向场景覆盖',
  '',
  '| 编号 | 场景名称 | 覆盖状态 | 接口覆盖率 | 匹配文件（行号） | 差距说明 |',
  '|---|---|---|---|---|---|',
  '| P01 | 简单类型校验 | ✅ | 2/2 (100%) | VerySimpleValidatePage.ets:98/101 | — |',
  '| P02 | 带引用的复杂对象 | 🔶 | 2/3 (67%) | AllValidatePage.ets:108-110 | 缺少 setSchemas 覆盖 |',
  '| P03 | 结果对象可读 | ✅ | 1/1 (100%) | LocalErrorMessagePage.ets:101 | — |',
  '',
  '### 反向场景覆盖',
  '',
  '| 编号 | 场景名称 | 覆盖状态 | 接口覆盖率 | 匹配文件（行号） | 差距说明 |',
  '|---|---|---|---|---|---|',
  '| N01 | 未定义实例 | ❌ | 0/1 (0%) | — | 没有空值输入 |',
  '',
  '### 接口维度逐条核对（场景清单涉及的 N 个对外接口/选项）',
  '',
  '| 接口 / 选项 | demo 是否真实执行 | 证据 |',
  '|---|---|---|',
  '| `new Validator()` | ✅ | 16 个页面 |',
  '| `Validator.validate()` | ✅ | 15 个页面 |',
  '| `scan` | ❌ | 零出现 |',
  '| `customFormats` | ⚠️ 跨模块注册 | IntereceTest.ts:380 |',
  '',
  '## 其它章节',
  '',
  '| 编号 | 覆盖状态 |',
  '|---|---|',
  '| P99 | ✅ |',
  '',
].join('\n');

{
  const r = parseCoverageReport(REPORT_MD);
  eq(r.judgements.length, 4, '解析出 4 条场景结论（「其它章节」里的伪表格不计入）');
  eq(r.judgements.map((j) => j.no), ['P01', 'P02', 'P03', 'N01'], '结论顺序');
  eq(r.judgements[1].status, 'partial', 'P02 判为部分覆盖');
  eq(r.judgements[1].apiCovered, 2, 'P02 接口覆盖分子');
  eq(r.judgements[1].apiTotal, 3, 'P02 接口覆盖分母');
  check(r.judgements[0].evidence.includes('VerySimpleValidatePage.ets:98'), 'P01 证据带文件与行号');
  eq(r.interfaces.length, 4, '接口逐条核对解析出 4 行');
  eq(r.interfaces.map((i) => i.verdict), ['executed', 'executed', 'missing', 'conditional'], '接口判定：执行/执行/零调用/有条件');
  check(r.baselineNote !== null, '基线说明被识别');

  // ★ 状态列认不出 → 告警，且不产生这条结论
  const badMark = parseCoverageReport(REPORT_MD.replace('| P01 | 简单类型校验 | ✅ |', '| P01 | 简单类型校验 | ？ |'));
  check(badMark.warnings.some((w) => w.includes('无法识别')), '★ 状态列认不出要告警');
  eq(badMark.judgements.length, 3, '认不出的那条不进结论');

  const noTables = parseCoverageReport('# 空报告\n');
  check(noTables.warnings.length >= 2, '★ 没有表格的报告必须告警（不许静默 0 条）');
}

// ---------- 4. 合并 + 自洽核对 ----------
console.log('— 合并与自洽核对 —');
{
  const ok = mergeScenarioCoverage(SCENARIO_MD, REPORT_MD);
  eq(ok.rows.length, 4, '合并后 4 行');
  eq(ok.rows.map((r) => r.status), ['covered', 'partial', 'covered', 'uncovered'], '状态合并正确');
  eq(ok.summary.total, 4, '总数');
  eq(ok.summary.covered, 2, '完全覆盖数');
  eq(ok.summary.partial, 1, '部分覆盖数');
  eq(ok.summary.uncovered, 1, '未覆盖数');
  eq(ok.summary.positive, 3, '正向数');
  eq(ok.summary.negative, 1, '反向数');
  // (2 + 1*0.5)/4 = 62.5
  eq(ok.summary.overall, 62.5, '整体覆盖率 =(covered+partial*0.5)/total');
  eq(ok.summary.apiExecuted, 2, '接口维度：真实执行');
  eq(ok.summary.apiConditional, 1, '接口维度：有条件');
  eq(ok.summary.apiMissing, 1, '接口维度：零调用');
  // (2 + 1*0.5)/4 = 62.5
  eq(ok.summary.apiRate, 62.5, '接口维度覆盖率（有条件计 0.5）');
  check(ok.summary.byModule.length === 2, '模块统计按场景归属聚合出 2 个模块');
  // 校验入口模块 = P01(✅) + P02(🔶) + N01(❌) → (1 + 0.5)/3 = 50%
  const entry = ok.summary.byModule.find((m) => m.module === '校验入口');
  eq(entry?.total, 3, '校验入口模块有 3 条场景（含映射表里挂到该模块的 N01）');
  eq(entry?.rate, 50, '校验入口模块覆盖率 =(1+1*0.5)/3 = 50%');

  // ★ 场景清单有、报告没有结论 → 必须告警且按未覆盖处理（宁可低估，不许高估）
  const missingJudgement = REPORT_MD.replace('| P03 | 结果对象可读 | ✅ | 1/1 (100%) | LocalErrorMessagePage.ets:101 | — |\n', '');
  const mj = mergeScenarioCoverage(SCENARIO_MD, missingJudgement);
  check(mj.warnings.some((w) => w.includes('P03') && w.includes('没有结论')), '★ 缺结论要告警');
  eq(mj.rows.find((r) => r.no === 'P03')?.status, 'uncovered', '缺结论按未覆盖处理（不虚报）');

  // ★ 报告有结论、清单没有该场景 → 悬空结论告警
  const extraJudgement = REPORT_MD.replace('| N01 | 未定义实例 | ❌ | 0/1 (0%) | — | 没有空值输入 |',
    '| N01 | 未定义实例 | ❌ | 0/1 (0%) | — | 没有空值输入 |\n| P77 | 幽灵场景 | ✅ | 1/1 (100%) | X.ets:1 | — |');
  const ej = mergeScenarioCoverage(SCENARIO_MD, extraJudgement);
  check(ej.warnings.some((w) => w.includes('P77') && w.includes('结论悬空')), '★ 悬空结论要告警');
  eq(ej.rows.length, 4, '悬空结论不会被塞进结果行');

  // ★ ✅ 但接口覆盖率不足 → 告警 + note
  const inconsistent = REPORT_MD.replace('| P03 | 结果对象可读 | ✅ | 1/1 (100%) |', '| P03 | 结果对象可读 | ✅ | 0/1 (0%) |');
  const inc = mergeScenarioCoverage(SCENARIO_MD, inconsistent);
  check(inc.warnings.some((w) => w.includes('P03') && w.includes('判为完全覆盖但接口覆盖率')), '★ 完全覆盖但接口覆盖率为 0 要告警');
  check((inc.rows.find((r) => r.no === 'P03')?.note ?? '').length > 0, '矛盾写进行内 note');

  // ★ 未覆盖但接口列显示有调用：**没有差距说明**才报警（有解释就当记录，不打扰）
  const weird = REPORT_MD.replace('| N01 | 未定义实例 | ❌ | 0/1 (0%) | — | 没有空值输入 |', '| N01 | 未定义实例 | ❌ | 1/2 (50%) | X.ets:1 | — |');
  const wj = mergeScenarioCoverage(SCENARIO_MD, weird);
  check(wj.warnings.some((w) => w.includes('N01') && w.includes('没有差距说明')), '★ 未覆盖却有调用且无解释 → 告警');
  const weirdExplained = REPORT_MD.replace('| N01 | 未定义实例 | ❌ | 0/1 (0%) | — | 没有空值输入 |', '| N01 | 未定义实例 | ❌ | 1/2 (50%) | X.ets:1 | 代码里有构造但流程永不执行，故不算覆盖 |');
  const wje = mergeScenarioCoverage(SCENARIO_MD, weirdExplained);
  check(!wje.warnings.some((w) => w.includes('N01') && w.includes('没有差距说明')), '★ 有解释就不再告警（告警只留待处理的）');
  check((wje.rows.find((r) => r.no === 'N01')?.note ?? '').includes('已解释'), '有解释时写进行内 note');

  // ★ 多模块声明：场景块里有 `**模块**：` 时以它为准；映射表多命中且无显式声明 → 告警
  const withModule = SCENARIO_MD.replace('**场景类型**：正向\n\n**场景涉及的功能点**', '**场景类型**：正向\n**模块**：错误对象\n\n**场景涉及的功能点**');
  const wm = parseScenarioList(withModule);
  eq(wm.scenarios[0].module, '错误对象', '显式 `**模块**：` 覆盖映射表归属');
  check(!wm.warnings.some((w) => w.includes('P01') && w.includes('没有模块归属')), '显式声明后不再报缺模块');

  const dupModule = SCENARIO_MD.replace('| 错误对象 | `ValidatorResult` | P03 | — |', '| 错误对象 | `ValidatorResult` | P01, P03 | — |');
  const dm = parseScenarioList(dupModule);
  check(dm.warnings.some((w) => w.includes('P01') && w.includes('多个模块')), '★ 映射表多命中要告警（不静默选一个）');
  eq(dm.scenarios[0].module, '错误对象', '多命中时按最后一个（并由告警提示补显式声明）');

  const mismatch = withModule.replace('| 校验入口 | `new Validator()`、`Validator.validate()` | P01, P02 | N01 |', '| 错误对象 | `new Validator()`、`Validator.validate()` | P01, P02 | N01 |');
  const mm = parseScenarioList(mismatch);
  check(!mm.warnings.some((w) => w.includes('P01') && w.includes('不一致')), '显式声明与映射表一致时不告警');
}

// ---------- 5. 空输入与渲染 ----------
console.log('— 空输入与渲染 —');
{
  const empty = mergeScenarioCoverage('', '');
  eq(empty.rows.length, 0, '两份文档都为空 → 0 行（不编造场景）');
  check(empty.warnings.length >= 2, '★ 空输入必须告警，而不是输出一个 0% 的"结论"');
  eq(empty.summary.overall, 0, '空输入的 overall 为 0');

  const md = renderScenarioCoverageMarkdown('demo-lib', mergeScenarioCoverage(SCENARIO_MD, REPORT_MD).rows,
    mergeScenarioCoverage(SCENARIO_MD, REPORT_MD).summary, [], { scenarioDoc: 'a.md', reportDoc: 'b.md' });
  check(md.includes('demo-lib · Demo 场景覆盖度'), 'markdown 标题含库名');
  check(md.includes('62.5%'), 'markdown 含整体覆盖率');
  check(md.includes('| P01 |'), 'markdown 含场景行');
  check(md.includes('## 模块覆盖'), 'markdown 含模块统计');
  eq(STATUS_LABEL.partial, '部分覆盖', '状态中文标签');

  const withWarnings = renderScenarioCoverageMarkdown('demo-lib', [], summarizeScenarioCoverage([], []), ['问题甲'],
    { scenarioDoc: 'a.md', reportDoc: 'b.md' });
  check(withWarnings.includes('自洽核对告警') && withWarnings.includes('问题甲'), '有告警时 rendermarkdown 必须列出告警');
}

console.log('');
if (fail === 0) console.log('全部自检通过 ✅');
else { console.log(`自检失败 ${fail} 项 ❌`); process.exit(1); }
