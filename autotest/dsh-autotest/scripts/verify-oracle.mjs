// P6 oracle 强制与反假通过的自检（无设备、无 LLM、无 DB）。
//
// 本项目的两条**硬门槛**就落在这里：断言覆盖率 100%、假通过 0。
// 而这两条最容易变成数字游戏：把"预期结果：功能正常"当作一条断言，覆盖率就能刷到 100%，
// 但真跑起来什么都判定不了。所以这套自检的重点是**拦住伪判据**：
// 含糊的期望值、恒真断言、指向不存在控件的断言、通过但没校验任何 oracle 的执行结果。
//
// 用法：npm run build && npm run verify:oracle
import {
  validateOracles, hasVerifiableOracle, detectFalsePass, isVerifyStep, ORACLE_LABEL,
} from '../lib/services/oracle.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
const problemsOf = (o) => validateOracles(o).map((p) => p.reason).join('；');

// ---------- 1. 七种 oracle 类型都可用 ----------
console.log('— 七种 oracle 取值域（设计 §6.6）—');
{
  eq(Object.keys(ORACLE_LABEL).length, 7, '取值域恰好 7 种');
  const good = [
    [[{ type: 'control_text', control: '验证结果：', expect: 'appear' }], '控件出现/消失'],
    [[{ type: 'text_value', control: '实际结果：', op: 'contains', value: 'true' }], '控件文本等于/包含'],
    [[{ type: 'hilog_keyword', keyword: 'jsonschema' }], 'hilog 关键字'],
    [[{ type: 'state_flag', control: '自动播放', state: true }], '控件勾选状态'],
    [[{ type: 'no_crash', level: 'E' }], '无崩溃/无 E 级日志'],
    [[{ type: 'screenshot_diff', threshold: 0.05 }], '截图差异'],
    [[{ type: 'script_assert', expr: "expect(res.valid).assertTrue()" }], '脚本断言'],
  ];
  for (const [o, label] of good) {
    check(hasVerifiableOracle(o), `${label} 的合法 oracle 通过校验`, problemsOf(o));
  }

  // ★ 点击名为「验证」的按钮**不是**验证步骤：真机 demo 每个页面都有这个按钮，
  // 若按"整句里出现过验证二字"判断，任何点了它的用例都会"看起来有断言"
  check(isVerifyStep('验证「实际结果：true」'), '验证「…」是验证步骤');
  check(isVerifyStep('  断言 返回值为 true'), '断言开头的步骤是验证步骤');
  check(!isVerifyStep('点击「验证」'), '★ 点击「验证」按钮不是验证步骤（按钮就叫验证）');
  check(!isVerifyStep('打开应用'), '普通操作步骤不是验证步骤');
}

// ---------- 2. 伪判据必须被拦住（这是本节的核心） ----------
console.log('\n— 伪判据拦截（否则"断言覆盖率 100%"就是数字游戏）—');
{
  eq(problemsOf([]).includes('没有任何 oracle'), true, '★ 空 oracle 数组被拒（断言为空的用例就是假通过）');
  check(!hasVerifiableOracle(undefined), '★ undefined 被拒（缺字段不能蒙混过关）');
  check(!hasVerifiableOracle([{ type: 'unknown_kind', value: 'x' }]), '未知 oracle 类型被拒', problemsOf([{ type: 'unknown_kind' }]));

  // 含糊的期望值 —— R9 的典型形态
  const vague1 = [{ type: 'text_value', control: '结果', value: '正常' }];
  check(!hasVerifiableOracle(vague1), '★ "正常" 这类含糊期望值被拒', problemsOf(vague1));
  check(problemsOf(vague1).includes('不具体'), '拒绝理由说明"不具体，无法核对"');
  for (const v of ['成功', '功能正常', '符合预期', '可用']) {
    check(!hasVerifiableOracle([{ type: 'text_value', control: '结果', value: v }]), `★ 含糊词「${v}」被拒`);
  }
  check(hasVerifiableOracle([{ type: 'text_value', control: '实际结果：', value: 'true' }]), '机器字面量 true 仍然通过（界面上真的会显示它，不能当成含糊值拒掉）');
  check(hasVerifiableOracle([{ type: 'text_value', control: '状态', value: 'ok' }]), '机器字面量 ok 同样放行');
  check(hasVerifiableOracle([{ type: 'text_value', control: '计数', value: '0' }]), '数字字面量放行');

  // 含糊的控件名
  const vague2 = [{ type: 'control_text', control: '正常' }];
  check(!hasVerifiableOracle(vague2), '★ 指向"正常"这种笼统控件的断言被拒', problemsOf(vague2));

  // 恒真断言
  const always = [{ type: 'script_assert', expr: 'assert true' }];
  check(!hasVerifiableOracle(always), '★ assert true 被拒（等于没有断言）', problemsOf(always));
  check(problemsOf(always).includes('恒真'), '拒绝理由写明"恒真断言"');

  // 缺字段
  check(!hasVerifiableOracle([{ type: 'control_text' }]), 'control_text 缺控件名被拒', problemsOf([{ type: 'control_text' }]));
  check(!hasVerifiableOracle([{ type: 'text_value', control: '结果' }]), 'text_value 缺期望值被拒', problemsOf([{ type: 'text_value', control: '结果' }]));
  check(!hasVerifiableOracle([{ type: 'state_flag', control: '开关' }]), 'state_flag 缺期望状态被拒', problemsOf([{ type: 'state_flag', control: '开关' }]));
  check(!hasVerifiableOracle([{ type: 'hilog_keyword' }]), 'hilog_keyword 缺关键字被拒', problemsOf([{ type: 'hilog_keyword' }]));
  check(!hasVerifiableOracle([{ type: 'screenshot_diff', threshold: 2 }]), 'screenshot_diff 阈值越界被拒', problemsOf([{ type: 'screenshot_diff', threshold: 2 }]));
  check(!hasVerifiableOracle([{ type: 'script_assert' }]), 'script_assert 缺表达式被拒', problemsOf([{ type: 'script_assert' }]));

  // 默认值补齐（不改变判定，只让落库的数据完整）
  const filled = [{ type: 'control_text', control: '验证结果：' }];
  validateOracles(filled);
  eq(filled[0].expect, 'appear', 'control_text 补齐默认 expect=appear');
  const filled2 = [{ type: 'no_crash' }];
  validateOracles(filled2);
  eq(filled2[0].level, 'E', 'no_crash 补齐默认 level=E');
  const filled3 = [{ type: 'text_value', control: 'x', value: 'y' }];
  validateOracles(filled3);
  eq(filled3[0].op, 'contains', 'text_value 补齐默认 op=contains');

  // 数组里只要有一条坏的就整体不通过（不允许"一条好用就万事大吉"）
  const mixed = [{ type: 'control_text', control: '验证' }, { type: 'script_assert', expr: 'assert true' }];
  check(!hasVerifiableOracle(mixed), '★ 多条里只要有一条是伪判据，整条用例就不达标');
}

// ---------- 3. 反假通过 ----------
console.log('\n— 反假通过（修 R12：脚本通过但断言为空）—');
{
  const okOracle = [{ type: 'control_text', control: '实际结果：true' }];
  const steps = ['打开应用', '点击「验证」', '验证「实际结果：true」'];

  const v1 = detectFalsePass(okOracle, { passed: true, steps, oraclesChecked: 1 });
  eq([v1.falsePass, v1.severity], [false, 'none'], '通过 + oracle 已校验 → 不是假通过');

  const v2 = detectFalsePass(okOracle, { passed: true, steps, oraclesChecked: 0 });
  eq([v2.falsePass, v2.severity], [true, 'false'], '★ 通过但一个 oracle 都没校验 → 假通过');
  check(v2.reason.includes('没有任何 oracle 被校验'), '理由写明未校验', v2.reason);

  const v3 = detectFalsePass([], { passed: true, steps, oraclesChecked: 0 });
  eq([v3.falsePass, v3.severity], [true, 'false'], '★ 通过但断言为空 → 假通过（最严重）');
  check(v3.reason.includes('断言不可核验') || v3.reason.includes('没有任何 oracle'), '理由指向断言缺失', v3.reason);

  const v4 = detectFalsePass([{ type: 'text_value', control: '结果', value: '正常' }], { passed: true, steps, oraclesChecked: 1 });
  eq(v4.falsePass, true, '★ 通过但断言是不可核对的含糊值 → 仍是假通过');

  const v5 = detectFalsePass(okOracle, { passed: false, steps, oraclesChecked: 0 });
  eq([v5.falsePass, v5.severity], [false, 'none'], '★ 未通过不算假通过（失败本身是有效信号）');

  const v6 = detectFalsePass(okOracle, { passed: true, steps: ['打开应用', '点击「验证」'], oraclesChecked: 1 });
  eq([v6.falsePass, v6.severity], [false, 'weak'], '通过但步骤里没有验证动作 → 弱通过（不算假通过但要提示）');
  check(v6.reason.includes('建议补一步验证'), '弱通过给出改进建议', v6.reason);

  const v7 = detectFalsePass(okOracle, {
    passed: true, steps,
    stepResults: [{ desc: '验证「实际结果：true」', status: 'passed' }], oraclesChecked: 1,
  });
  eq(v7.severity, 'none', '步骤结果里验证动作确实执行了 → 正常');
  const v8 = detectFalsePass(okOracle, {
    passed: true, steps,
    stepResults: [{ desc: '验证「实际结果：true」', status: 'skipped' }], oraclesChecked: 1,
  });
  eq(v8.severity, 'weak', '★ 验证步骤被跳过（skipped）→ 判为弱通过，不算"已验证"');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
