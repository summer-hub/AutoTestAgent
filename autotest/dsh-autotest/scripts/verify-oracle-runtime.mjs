// 判据支持模块的运行期自检（真机无关，但**需要装了 hypium 的 Python**）。
//
// 为什么必须有这一层：白名单/文本匹配只是"看起来对"，真正会翻车的是
//   driver.assert_component_exist(...)  —— 该 API 在 hypium 包里根本不存在（AttributeError）
//   driver.capture_screen(p, in_pc=True, timeout=...) —— capture_screen 没有 timeout 形参（TypeError）
// 这两类错误 grep 不出来，只有把模块 import 进来、用假 driver 真跑一遍才发现。
//
// 环境提示：本机 PATH 上的 python 是 3.13（**没有 hypium**），hypium 6.1.0.210 装在
// D:\Programs\Python\Python310。所以这里会主动去找「装了 hypium 的解释器」，
// 可用 AUTOTEST_PYTHON 指定。找不到就 SKIP（不误报失败）。
//
// 用法：npm run build && npm run verify:oracle-runtime
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { oracleSupportModuleSource, generateCaseScript, caseClassName } from '../lib/services/hypiumGen.js';
import { probePythons, detectPython, describePythonProbe } from '../lib/services/hypiumRunner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---------- 1. 找一个装了 hypium 的 Python ----------
console.log('— 解释器探测（hypium 只装在部分解释器里）—');
const candidates = [
  process.env.AUTOTEST_PYTHON,
  'python', 'python3', 'py -3.10', 'py -3',
  'D:\\Programs\\Python\\Python310\\python.exe',
  'C:\\Programs\\Python\\Python310\\python.exe',
  `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python310\\python.exe`,
].filter(Boolean);

function probe(spec) {
  const [cmd, ...pre] = spec.split(' ');
  const r = spawnSync(cmd, [...pre, '-c', 'import hypium,sys;print(hypium.__version__)'], { encoding: 'utf8', timeout: 60000 });
  if (r.status === 0) return { spec, version: (r.stdout || '').trim() };
  return null;
}

let py = null;
for (const c of candidates) {
  const hit = probe(c);
  if (hit) { py = hit; break; }
  if (c === process.env.AUTOTEST_PYTHON || c === 'python') {
    // 记录"PATH 上的 python 没有 hypium"这一事实，便于排障
    const r = spawnSync(c.split(' ')[0], ['-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) console.log(`      注意：${c} 是 python ${(r.stdout || '').trim()}，但**没有 hypium**（生成脚本要用装了 hypium 的解释器跑）`);
  }
}
if (!py) {
  console.log('SKIP  找不到装了 hypium 的 Python：设置 AUTOTEST_PYTHON 指向它后重跑可覆盖此项');
  console.log('\n（跳过运行期校验，其余自检不受影响）');
  process.exit(0);
}
console.log(`      使用解释器：${py.spec}（hypium ${py.version}）`);

// 产品自身的解释器探测必须与上面找到的一致：它决定执行计划能不能跑起来。
// （本机陷阱：PATH 上的 python 3.13 没有 hypium，若直接拿它执行，脚本会在
//   `import hypium` 才炸，报错指向脚本而不是环境。）
{
  const found = await probePythons();
  const usable = found.filter((p) => p.hasHypium);
  check(usable.length >= 1, '产品探测能识别出装了 hypium 的解释器', usable.map((p) => `${p.cmd}=${p.version}`).join(', ') || '一个都没有');
  const detected = await detectPython();
  check(!!detected, 'detectPython() 返回可用解释器（供执行计划使用）', detected || describePythonProbe(found).slice(0, 160));
  // 关键反例：detectPython 绝不能返回"能跑但没 hypium"的解释器
  const bad = found.find((p) => !p.hasHypium);
  if (bad) check(detected !== bad.cmd, `不会选中没有 hypium 的解释器 ${bad.cmd}`, `选中=${detected}`);
}

// ---------- 2. 生成支持模块 + 一条覆盖全部句式的用例脚本 ----------
// 目录结构照真工程：<root>/aw/autotest_oracle.py（判据断言模块归位 aw/ 包）
// 与 <root>/testcases/<lib>/<lib>_<caseNo>.py（脚本 import aw.xxx，所以必须放在包里跑）
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-oracle-'));
const awDir = path.join(work, 'aw');
fs.mkdirSync(awDir, { recursive: true });
fs.writeFileSync(path.join(awDir, '__init__.py'), '', 'utf8');
const modPath = path.join(awDir, 'autotest_oracle.py');
fs.writeFileSync(modPath, oracleSupportModuleSource(), 'utf8');

const caseDir = path.join(work, 'testcases', 'json_schema');
fs.mkdirSync(caseDir, { recursive: true });
const caseModule = caseClassName('json-schema', 'C-AI-001');
const casePath = path.join(caseDir, `${caseModule}.py`);
const caseSrc = generateCaseScript(
  { name: 'json-schema', packageName: 'com.openharmony.jsonschemavalidator' },
  {
    caseNo: 'C-AI-001', name: '校验通过',
    steps: ['打开应用', '点击「校验」', '输入「abc」到「输入框」', '上滑', '下滑', '返回', '等待 2 秒', '验证「校验通过」'],
    oracles: [
      { type: 'control_text', control: '校验通过' },
      { type: 'text_value', control: '实际结果：', op: 'contains', value: 'true' },
      { type: 'state_flag', control: '开关', state: true },
      { type: 'hilog_keyword', keyword: 'jsonschema' },
      { type: 'no_crash' },
      { type: 'screenshot_diff', threshold: 0.05 },
    ],
  },
);
fs.writeFileSync(casePath, caseSrc, 'utf8');
check(caseModule === 'json_schema_C_AI_001', '模块名 = <lib>_<caseNo>', caseModule);
check(caseSrc.includes(`class ${caseModule}(TestCase):`), '类名与模块名一致（xdevice -l 才能加载）');
check(caseSrc.includes('from aw.autotest_oracle import ('), '脚本从 aw/ 包 import 判据断言模块');

// 先做语法编译：连语法都过不去就不必谈运行了
const [pyCmd, ...pyPre] = py.spec.split(' ');
const compile = spawnSync(pyCmd, [...pyPre, '-m', 'py_compile', modPath], { encoding: 'utf8' });
check(compile.status === 0, '生成的判据支持模块能被 Python 编译（语法正确）', (compile.stderr || '').trim().slice(0, 200));
const compileCase = spawnSync(pyCmd, [...pyPre, '-m', 'py_compile', casePath], { encoding: 'utf8' });
check(compileCase.status === 0, '生成的用例脚本能被 Python 编译（语法正确）', (compileCase.stderr || '').trim().slice(0, 200));

// 再 import 并逐个真跑：这一步才能抓住"方法/参数名不存在"
const harness = path.join(here, 'hypium-oracle-harness.py');
const run = spawnSync(pyCmd, [...pyPre, harness, modPath, work], { encoding: 'utf8', timeout: 300000 });
let report = null;
try { report = JSON.parse(run.stdout || '{}'); } catch { /* 下面统一报错 */ }
if (!report) {
  check(false, '运行期夹具正常返回 JSON', `stdout=${(run.stdout || '').slice(0, 200)} stderr=${(run.stderr || '').slice(0, 400)}`);
} else {
  for (const e of report.errors ?? []) check(false, '夹具内部异常', e.slice(0, 400));
  const checks = report.checks ?? [];
  console.log(`\n— 判据支持模块运行期行为（${checks.length} 项，假 driver 真调用）—`);
  for (const c of checks) check(c.ok, c.name, c.ok ? '' : c.detail);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(fail === 0 ? '\n全部自检通过' : `\n自检失败：${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
