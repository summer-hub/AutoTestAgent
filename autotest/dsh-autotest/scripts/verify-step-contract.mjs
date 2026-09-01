// Agent 契约自检：不连数据库、不调 LLM，验证三件事
//  1. 步骤句式契约（STEP_CONTRACT）的每条句式都能被 hypiumGen 映射为真实 Hypium 调用
//  2. 控件引用 guardrail（validateDraftsAgainstPages）的保留/丢弃判定符合预期
//  3. 【需设备】执行端 hdc 能正确执行契约句式（检测到在线设备才跑，无设备自动跳过）
// 用途：改生成端契约或执行端映射后跑一次，防止两端脱节。
//   - 1/2 脱节会让脚本退化为注释；3 脱节会让 dry-run 产生系统性假失败（回灌修复变成噪声）。
// 用法：npm run build && node scripts/verify-step-contract.mjs
import { generateCaseScript } from '../lib/services/hypiumGen.js';
import { validateDraftsAgainstPages } from '../lib/services/executor.js';
import { dryRunCase } from '../lib/services/dryRun.js';
import { listTargets, parseNodes, uiDump } from '../lib/services/hdc.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---------- 1. 步骤句式 → Hypium 调用映射 ----------
console.log('— 步骤句式契约映射 —');
const LIB = { name: 'demo-lib', packageName: 'com.example.demo' };
const CONTRACT_SAMPLES = [
  ['打开应用', 'start_app'],
  ['点击「开始播放」', 'touch'],
  ['输入「hello」到「输入框」', 'input_text'],
  ['输入「hello」', 'input_text'],
  ['等待 3 秒', 'wait'],
  ['上滑', 'swipe'],
  ['下滑', 'swipe'],
  ['返回', 'swipe_to_back'],
  ['验证「播放完成」', 'assert_component_exist'],
];
for (const [step, api] of CONTRACT_SAMPLES) {
  const s = generateCaseScript(LIB, { caseNo: 'C-AI-001', name: 'x', steps: [step] });
  const body = s.slice(s.indexOf('def process'), s.indexOf('def teardown'));
  const unmapped = body.includes('未映射步骤');
  check(!unmapped && body.includes(api), `${step.padEnd(20, ' ')} → ${api}`, unmapped ? '[未映射]' : !body.includes(api) ? '[API 不匹配]' : '');
}

// ---------- 2. 控件引用 guardrail ----------
console.log('\n— 控件引用校验（guardrail）—');
const draft = (name, steps, pagePath) => ({ name, source: 'AI 生成', precondition: '', steps, expected: 'e', pagePath });
const run = (rows, map) => validateDraftsAgainstPages(rows, new Map(Object.entries(map)));

let v = run([draft('命中', ['点击「播放按钮」'], 'p')], { p: { controls: ['播放按钮', '停止'] } });
check(v.kept.length === 1 && v.dropped.length === 0, '控件存在 → 保留');

v = run([draft('臆造', ['点击「不存在的按钮」'], 'p')], { p: { controls: ['播放按钮'] } });
check(v.kept.length === 0 && v.dropped.length === 1, '臆造控件 → 丢弃');

v = run([draft('验证豁免', ['验证「播放完成」'], 'p')], { p: { controls: ['播放按钮'] } });
check(v.kept.length === 1, '验证/输出文本豁免 → 保留（日志文本不要求是控件）');

v = run([draft('子串', ['点击「播放」'], 'p')], { p: { controls: ['播放按钮'] } });
check(v.kept.length === 1, '子串匹配（播放 vs 播放按钮）→ 保留');

v = run([draft('短串', ['点击「2」'], 'p')], { p: { controls: ['1'] } });
check(v.kept.length === 0, '单字符控件不误放行 → 丢弃');

v = run([draft('无页面上下文', ['点击「任意」'], undefined)], {});
check(v.kept.length === 1, '无 pagePath（非遍历来源）→ 跳过校验保留');

v = run([draft('输入到', ['输入「abc」到「用户名框」'], 'p')], { p: { controls: ['用户名框'] } });
check(v.kept.length === 1, '二段式输入引用控件存在 → 保留');

// ---------- 3. 执行端 dry-run（需在线设备，无设备自动跳过） ----------
console.log('\n— 执行端 dry-run（契约句式真机判定）—');
let serial = '';
try {
  serial = (await listTargets())[0] ?? '';
} catch { /* 无 hdc */ }
if (!serial) {
  console.log('SKIP  未检测到在线设备，跳过（接上设备/模拟器后重跑可覆盖此项）');
} else {
  const texts = [...new Set(parseNodes(await uiDump(serial)).map((n) => (n.text || n.desc || '').trim()).filter(Boolean))];
  // 选一个干净的短文本作为真实存在的控件（过滤合并文本与超长文本）
  const real = texts.find((t) => t.length >= 2 && t.length <= 8 && !/[,，;；\n]/.test(t));
  if (!real) {
    console.log(`SKIP  设备 ${serial} 界面无可用控件文本，跳过`);
  } else {
    const r = await dryRunCase('CONTRACT-001', '契约自检', [`验证「${real}」`, '验证「绝不存在控件XYZ123」'], serial, { perStepTimeoutMs: 12000 });
    check(r.steps[0]?.status === 'passed', `验证「${real}」（真实存在）→ 通过`, `实际：${r.steps[0]?.log ?? '—'}`);
    check(r.steps[1]?.status === 'failed', '验证臆造控件 → 失败（不误报通过）', `实际：${r.steps[1]?.log ?? '—'}`);
    check((r.steps[1]?.visibleControls?.length ?? 0) > 0, '失败时抓取到界面可见控件（回灌证据）');
  }
}

console.log(fail === 0 ? '\n全部自检通过' : `\n${fail} 项自检失败`);
process.exit(fail === 0 ? 0 : 1);
