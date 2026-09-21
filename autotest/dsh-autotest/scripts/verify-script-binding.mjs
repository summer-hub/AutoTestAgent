// P8 用例 ↔ 脚本映射与生成纪律的自检（无设备、无 LLM、无 DB）。
//
// 三条必须钉死的纪律，每一条都对应一个真实后果：
//   ① 步骤无法映射 → **生成失败**（旧行为是产出注释行，脚本"看起来正常"地跑完并通过 = 假通过）；
//   ② 脚本没有断言 → **拒绝绑定**（修 R12）；
//   ③ 用例升版 → 脚本标 stale 并提示「可能过期」；人工改过的脚本标 manual 且**不自动覆盖**。
//
// 用法：npm run build && npm run verify:binding
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateCaseScript, scriptHasAssertion, oracleToPython, oracleSupportModuleSource,
  UnmappedStepError, NoAssertionError, caseClassName,
} from '../lib/services/hypiumGen.js';
import { computeBindingStatus, hashScript, BINDING_LABEL } from '../lib/services/scriptBinding.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

const LIB = { name: 'demo-lib', packageName: 'com.demo.lib' };
const gen = (steps, oracles) => generateCaseScript(LIB, { caseNo: 'C-1', name: '用例', steps, oracles });

// ---------- 1. 未映射即失败 ----------
console.log('— 未映射即失败（不再产出注释行）—');
{
  let err = null;
  try { gen(['打开应用', '随便写点什么不存在的动作']); } catch (e) { err = e; }
  check(err instanceof UnmappedStepError, '★ 无法映射的步骤 → 抛 UnmappedStepError（不再静默生成注释行）');
  check(err?.stepIndex === 1, '错误里带步骤序号（人能直接定位）', `index=${err?.stepIndex}`);
  check(err?.step === '随便写点什么不存在的动作', '错误里带步骤原文');
  check(/契约句式/.test(err?.message ?? ''), '错误里告诉人怎么改（契约句式）', String(err?.message).slice(0, 60));
  check(!gen(['打开应用', '点击「验证」']).includes('未映射步骤'), '★ 能映射的步骤不会出现"未映射"注释');
  check(!gen(['打开应用', '点击「验证」']).includes('# 未映射'), '生成结果里不再有未映射注释行');
  // 空步骤列表不报错（由断言校验兜底）
  check(typeof gen([]) === 'string', '空步骤列表仍能生成（随后被空脚本校验拦住）');
}

// ---------- 2. 空脚本拦截 ----------
console.log('\n— 空脚本拦截（修 R12）—');
{
  check(scriptHasAssertion('self.driver.assert_component_exist(BY.text("x"))'), '识别 Hypium 断言方法');
  check(scriptHasAssertion('        assert (result.valid), "msg"'), '识别 Python assert 语句');
  check(scriptHasAssertion('        assert_control_text(self.driver, "验证")'), '识别 oracle 支持模块的断言函数');
  check(!scriptHasAssertion('# 只有注释\nself.driver.touch(BY.text("x"))'), '★ 只有操作没有断言的脚本判为"无断言"');
  check(!scriptHasAssertion(''), '空内容判为"无断言"');

  // 只有操作步骤、没有 oracle → 生成的脚本无断言 → 拒绝绑定（writeCaseScript 会抛 NoAssertionError）
  const noAssert = gen(['打开应用', '点击「验证」']);
  check(!scriptHasAssertion(noAssert), '★ 只点按钮不验证的用例 → 生成的脚本无断言（这就是要被拦住的 R12 形态）');
  const okScript = gen(['打开应用', '点击「验证」', '验证「实际结果：true」'], [{ type: 'text_value', control: '实际结果：', value: 'true' }]);
  check(scriptHasAssertion(okScript), '有验证步骤 + oracle 的脚本含断言');
  check(NoAssertionError.name === 'NoAssertionError', 'NoAssertionError 类型可用（写库前拦截用）');
}

// ---------- 3. oracle → 断言 ----------
console.log('\n— oracle → 断言映射（7 种取值域）—');
{
  const cases = [
    [{ type: 'control_text', control: '实际结果：', expect: 'appear' }, 'assert_control_text', '控件出现'],
    [{ type: 'text_value', control: '实际结果：', op: 'contains', value: 'true' }, 'assert_text_value', '文本包含'],
    [{ type: 'state_flag', control: '自动播放', state: true }, 'assert_state_flag', '状态标志'],
    [{ type: 'hilog_keyword', keyword: 'jsonschema' }, 'assert_hilog_keyword', 'hilog 关键字'],
    [{ type: 'no_crash' }, 'assert_no_crash', '无崩溃'],
    [{ type: 'screenshot_diff', threshold: 0.05 }, 'assert_screenshot_diff', '截图差异'],
  ];
  for (const [o, fn, label] of cases) {
    const lines = oracleToPython(o).join('\n');
    check(lines.includes(fn), `${label} → 调用 ${fn}`, lines.trim().slice(0, 60));
    check(lines.includes('self.driver'), `${label} 的断言拿到 driver`);
  }
  const sa = oracleToPython({ type: 'script_assert', expr: 'result.valid is True' }).join('\n');
  check(sa.trim().startsWith('assert ('), 'script_assert 内联成真正的 Python 断言', sa.trim());
  check(oracleToPython({ type: 'script_assert' }).join('').includes('raise AssertionError'), 'script_assert 缺表达式 → 直接报错（不静默通过）');
  check(oracleToPython({ type: 'unknown_x' }).join('').includes('raise AssertionError'), '未知 oracle 类型 → 直接报错');

  const script = gen(['打开应用', '点击「验证」'], [
    { type: 'text_value', control: '实际结果：', op: 'contains', value: 'true' },
    { type: 'no_crash' },
  ]);
  check(script.includes('可机器校验判据：2 条'), '脚本头部标注判据条数（人一眼看到）');
  // 约定：判据断言模块归位到共享 aw/ 包（单工程多库，不再放工程根）
  check(script.includes('from aw.autotest_oracle import ('), '按需 import aw/ 下的判据断言模块');
  // 约定：文件名 = 类名 = 模块名（xdevice 用 -l <模块名> 加载，类名必须与之一致）
  check(script.includes(`class ${caseClassName(LIB.name, 'C-1')}(TestCase):`),
    '类名 = 模块名 <lib>_<caseNo>（四方一致）', caseClassName(LIB.name, 'C-1'));
  check(script.includes('assert_text_value') && script.includes('assert_no_crash'), '两种 oracle 的断言都写进脚本');
  check(!script.includes('assert_control_text'), '未用到的断言函数不会被 import（保持脚本干净）');

  // ★ 支持模块：判据落空必须抛「框架认的」异常，绝不能静默通过
  const support = oracleSupportModuleSource();
  check(support.includes('from devicetest.core.exception import TestAssertionError'),
    '★ 支持模块抛 TestAssertionError（devicetest 的 _exec_func 会判为用例失败）');
  const raises = (support.match(/raise TestAssertionError/g) ?? []).length;
  check(raises >= 5, '每个可能落空的判据都显式抛错（≥5 处）', `实际 ${raises} 处`);
  // 支持模块调用的 driver API 必须逐个落在已核实白名单内
  // （旧生成器的 assert_component_exist 就是这么漏出去的：hypium 包里根本没有该方法）
  const VERIFIED_DRIVER_API = new Set([
    'wait_for_component', 'wait_for_component_disappear', 'get_component_property', 'current_app',
    'shell', 'hdc', 'capture_screen', 'take_screenshot', 'find_component', 'find_all_components',
    'touch', 'input_text', 'clear_text', 'swipe', 'swipe_to_back', 'slide', 'fling', 'drag',
    'press_key', 'press_back', 'press_home', 'go_back', 'go_home', 'wait', 'start_app', 'stop_app',
    'has_app', 'install_app', 'uninstall_app', 'get_display_size', 'get_window_size', 'log', 'config',
  ]);
  const called = [...support.matchAll(/driver\.([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]);
  const unknown = [...new Set(called)].filter((c) => !VERIFIED_DRIVER_API.has(c));
  check(unknown.length === 0, '★ 支持模块只调用核实存在的 driver API',
    unknown.length ? `未核实：${unknown.join(', ')}` : `调用 ${[...new Set(called)].length} 种`);
  check(!support.includes('assert_component_exist'), '★ 不再出现 hypium 里不存在的 assert_component_exist');
  check(support.includes('wait_for_component') && support.includes('BY.text'),
    'control_text 用 wait_for_component + BY.text 实现（已核实的 API）');
  // 关键字参数也要核实：capture_screen(save_path, in_pc=True, area=None) 没有 timeout 形参
  const captureKw = /capture_screen\([^)]*\)/.exec(support)?.[0] ?? '';
  const badKw = [...captureKw.matchAll(/([a-zA-Z_]\w*)\s*=/g)].map((m) => m[1]).filter((k) => k !== 'in_pc' && k !== 'area');
  check(badKw.length === 0, '★ capture_screen 只传它真实支持的参数', badKw.length ? `多传：${badKw.join(', ')}` : captureKw.trim());
  // 没有基线时保存基线并判失败，而不是当作通过
  check(/os\.replace\(current, baseline\)/.test(support) && /首次运行/.test(support),
    '截图首次运行：存下基线并要求人工确认（不静默通过）');
}

// ---------- 4. 绑定状态判定 ----------
console.log('\n— 绑定状态（fresh / stale / manual / broken）—');
{
  const base = { caseVersion: 2, boundVersion: 2, fileExists: true, hasAssertion: true, currentHash: 'h1', boundHash: 'h1' };
  eq(computeBindingStatus(base).status, 'fresh', '版本一致且内容未变 → fresh');
  check(computeBindingStatus(base).reason.includes('V2'), 'fresh 的理由带上版本号');

  const stale = computeBindingStatus({ ...base, caseVersion: 3 });
  eq(stale.status, 'stale', '★ 用例升版 → stale');
  check(stale.reason.includes('V3') && stale.reason.includes('V2'), '★ 提示写明"用例已更新到 V3，脚本基于 V2"', stale.reason);
  check(stale.reason.includes('重新生成'), '提示给出下一步（是否重新生成）');

  const manual = computeBindingStatus({ ...base, currentHash: 'h2' });
  eq(manual.status, 'manual', '★ 脚本内容与记录不一致 → manual（人为改过）');
  check(manual.reason.includes('不会自动覆盖'), '★ manual 明确"不会自动覆盖"', manual.reason);

  const missing = computeBindingStatus({ ...base, fileExists: false });
  eq(missing.status, 'broken', '脚本文件不存在 → broken');
  const noAssert = computeBindingStatus({ ...base, hasAssertion: false });
  eq(noAssert.status, 'broken', '脚本没有断言 → broken');
  check(noAssert.reason.includes('断言'), '理由指向断言的缺失');

  // 优先级：文件丢失 > 人工改过 > 用例升版
  eq(computeBindingStatus({ ...base, fileExists: false, currentHash: 'h2', caseVersion: 9 }).status, 'broken',
    '★ 优先级：文件丢失优先于人工改过与升版');
  eq(computeBindingStatus({ ...base, currentHash: 'h2', caseVersion: 9 }).status, 'manual',
    '★ 优先级：人工改过优先于升版（否则会误导人直接覆盖手改内容）');
  // 人工确认后不再提示过期
  eq(computeBindingStatus({ ...base, caseVersion: 3, confirmedVersion: 3 }).status, 'fresh',
    '人工确认过的版本不再提示过期');

  eq(Object.keys(BINDING_LABEL).length, 4, '四种状态都有中文标签');
  check(BINDING_LABEL.stale.includes('过期'), 'stale 的标签直接说"可能过期"（人看得懂）');
}

// ---------- 5. 哈希 ----------
console.log('\n— 脚本哈希（判断"人为改过"的依据）—');
{
  eq(hashScript('a\nb'), hashScript('a\r\nb'), '★ Windows/Linux 换行差异不算"人为改过"（否则每次 checkout 都误报）');
  check(hashScript('a') !== hashScript('b'), '内容不同哈希不同');
  eq(hashScript('same').length, 32, '哈希长度固定 32');
  eq(hashScript('same'), hashScript('same'), '同内容哈希稳定');
}

// ---------- 6. 端到端：生成 → 落盘 → 重算状态 ----------
console.log('\n— 端到端（生成 → 落盘 → 改内容 → 判定）—');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-p8-'));
  const file = path.join(tmp, 'C-1.py');
  const script = gen(['打开应用', '点击「验证」'], [{ type: 'control_text', control: '实际结果：' }]);
  fs.writeFileSync(file, script, 'utf8');
  const h1 = hashScript(fs.readFileSync(file, 'utf8'));
  eq(computeBindingStatus({ caseVersion: 1, boundVersion: 1, fileExists: true, hasAssertion: scriptHasAssertion(fs.readFileSync(file, 'utf8')), currentHash: h1, boundHash: h1 }).status,
    'fresh', '刚落盘的脚本 → fresh');
  fs.writeFileSync(file, script + '\n# 人工补了一行\n', 'utf8');
  const h2 = hashScript(fs.readFileSync(file, 'utf8'));
  eq(computeBindingStatus({ caseVersion: 1, boundVersion: 1, fileExists: true, hasAssertion: true, currentHash: h2, boundHash: h1 }).status,
    'manual', '★ 人工改过之后 → manual');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
