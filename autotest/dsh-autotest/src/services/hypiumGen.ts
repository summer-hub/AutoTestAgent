// Hypium（Python + xdevice）脚本生成 —— 对齐 HypiumProjectTemplate：
//  - 工程骨架：workspace/hypium/<lib>/（config/user_config.xml + main.py + run.bat/sh）
//  - 每条用例一个独立模块：testcases/<lib>/<caseNo>.py，类名 Case_<safe>；
//    main.py 的 run -l <模块名> 即可单用例执行
//  - 中文步骤确定性映射为 driver 调用（点击/输入/滑动/等待/验证/打开），不经过 LLM、不臆造控件
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './gitRepo.js';

export interface HypiumLib {
  name: string;
  packageName: string; // bundleName；未知时传库名（执行前可被重新生成覆盖）
}

export interface HypiumCaseInput {
  caseNo: string;
  name: string;
  steps: string[];
  /** P6/P8：机器可校验判据 —— 每条都必须落到脚本断言上（否则脚本"通过"判定不了任何事） */
  oracles?: Array<Record<string, unknown>>;
}

/** 步骤无法映射到 Hypium 调用时抛出：**不再生成注释行**，让生成失败并回报。 */
export class UnmappedStepError extends Error {
  constructor(public readonly stepIndex: number, public readonly step: string) {
    super(`第 ${stepIndex + 1} 步无法映射到 Hypium 调用：「${step.slice(0, 60)}」。请改成契约句式（打开应用 / 点击「X」/ 输入「X」到「Y」/ 等待 N 秒 / 上滑 / 返回 / 验证「X」），或补充映射规则。`);
    this.name = 'UnmappedStepError';
  }
}

/** 脚本里一个断言都没有时抛出：拒绝绑定的依据（修 R12：断言为空的"通过"就是假通过）。 */
export class NoAssertionError extends Error {
  constructor(caseNo: string) {
    super(`用例 ${caseNo} 生成的脚本没有任何断言：拒绝绑定（断言为空的脚本跑通了也说明不了任何事）`);
    this.name = 'NoAssertionError';
  }
}

const safe = (s: string): string => s.replace(/[^\w.-]/g, '_');

/** 库的 Hypium 工程根目录。 */
export function hypiumProjectDir(libName: string): string {
  return path.join(workspaceDir(), 'hypium', safe(libName));
}

/** 用例绑定脚本路径：testcases/<lib>/<caseNo>.py。 */
export function hypiumCaseScriptPath(libName: string, caseNo: string): string {
  const s = safe(libName);
  return path.join(hypiumProjectDir(libName), 'testcases', s, `${safe(caseNo)}.py`);
}

function userConfigXml(serial: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<user_config>',
    '    <environment>',
    '        <device type="usb-hdc">',
    `            <sn>${serial}</sn>`,
    '        </device>',
    '    </environment>',
    '    <testcases>',
    '        <dir></dir>',
    '    </testcases>',
    '    <loglevel>DEBUG</loglevel>',
    '    <devicelog>ON</devicelog>',
    '</user_config>',
    '',
  ].join('\n');
}

function mainPy(): string {
  // moduleLabel 在每次单用例执行前由执行器重写占位符 __AUTOTEST_MODULE__
  return [
    '# -*- coding: utf-8 -*-',
    'import sys',
    'from xdevice.__main__ import main_process',
    '',
    'if __name__ == "__main__":',
    '  module = "PLACEHOLDER"',
    '  if len(sys.argv) > 1:',
    '    module = sys.argv[1]',
    '  main_process(f"run -l {module} -ta agent_mode:bin;screenshot:true")',
    '',
  ].join('\n');
}

/** 确保工程骨架存在；提供 serial 时刷新 user_config.xml（设备可能更换）。 */
export function ensureHypiumProject(lib: HypiumLib, serial?: string): void {
  const base = hypiumProjectDir(lib.name);
  const s = safe(lib.name);
  fs.mkdirSync(path.join(base, 'testcases', s), { recursive: true });
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  if (serial) fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml(serial), 'utf8');
  else if (!fs.existsSync(path.join(base, 'config', 'user_config.xml'))) {
    fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml('UNKNOWN'), 'utf8');
  }
  if (!fs.existsSync(path.join(base, 'main.py'))) fs.writeFileSync(path.join(base, 'main.py'), mainPy(), 'utf8');
  if (!fs.existsSync(path.join(base, 'run.bat'))) {
    fs.writeFileSync(path.join(base, 'run.bat'), '@echo off\ncd /d %~dp0\npython main.py\npause\n', 'utf8');
  }
  if (!fs.existsSync(path.join(base, 'run.sh'))) {
    fs.writeFileSync(path.join(base, 'run.sh'), '#!/bin/bash\ncd "$(dirname "$0")"\npython3 main.py "$@"\n', 'utf8');
  }
}

// ---------- 中文步骤 → driver 调用 ----------

function pickKw(desc: string): string {
  return desc
    .replace(/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|长按|勾选|取消|删除|验证|检查|断言|校验)[:：\s]*/, '')
    .replace(/^[控件]+\s*[:：]\s*/, '')          // 剔除「控件：」等标签前缀（dump 里静态标签与值分离时的合并残留）
    .replace(/[「」“”"'，,。.！!？?；;、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 20) ?? '';
}

/** 控件文本净化：剔除标签前缀、压缩空白 —— BY.text 必须与界面可见文本完全一致。 */
function cleanLabel(label: string): string {
  return label
    .replace(/^控件\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function py(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 单条步骤 → python 行。
 *
 * **无法识别时返回 null**（由调用方抛出 UnmappedStepError），不再退化成一个注释行 ——
 * 注释行会让脚本"看起来正常"地跑完并且"通过"，而那正是假通过（R12）。
 */
function stepToPython(step: string, pkg?: string): string[] | null {
  const d = step.trim();
  if (!d) return [];
  // 「打开应用」/「启动应用」：setup 只执行一次，用例中途需要回到首页时依赖此句式 → 显式重启应用
  if (pkg && /^(?:打开|启动)\s*(?:应用|app)?$/i.test(d)) {
    return [
      `        self.driver.start_app(package_name="${py(pkg)}")`,
      '        self.driver.wait(3)',
    ];
  }
  const mSec = d.match(/^等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*秒?$/);
  if (mSec) return [`        self.driver.wait(${Math.max(1, Math.round(parseFloat(mSec[1])))})`];
  const mMin = d.match(/^等待\s*(?:约)?\s*(\d+)\s*分钟$/);
  if (mMin) return [`        self.driver.wait(${Math.min(120, parseInt(mMin[1]) * 60)})`];
  if (/^等待/.test(d)) return ['        self.driver.wait(2)'];
  if (/^(返回|退出|回退)/.test(d)) return ['        self.driver.swipe_to_back()'];
  if (/^滑动|^向上滑|^上滑/.test(d)) return ['        self.driver.swipe(UiParam.UP, distance=60)'];
  if (/^下滑|^向下滑/.test(d)) return ['        self.driver.swipe(UiParam.DOWN, distance=60)'];
  // 二段式输入句式（与生成端 STEP_CONTRACT 契约对齐）：输入「内容」到「控件」
  const inputTo = d.match(/^(?:输入|键入|填写)[:：]?\s*「(.+?)」(?:到|至|进入|在)\s*「(.+?)」/);
  if (inputTo) {
    return [
      `        self.driver.input_text(BY.text("${py(cleanLabel(inputTo[2]).slice(0, 24))}"), "${py(inputTo[1].slice(0, 40))}")`,
      '        self.driver.wait(1)',
    ];
  }
  const input = d.match(/^(?:输入|键入|填写)[:：]?\s*[「"]?(.+?)[」"]?$/);
  if (input && !input[1].includes('框')) {
    const kw = cleanLabel(pickKw(d.replace(/^(?:输入|键入|填写)/, '点击'))) || '输入框';
    return [
      `        self.driver.input_text(BY.text("${py(kw)}"), "${py(input[1].slice(0, 40))}")`,
      '        self.driver.wait(1)',
    ];
  }
  const verify = d.match(/^(?:验证|检查|断言|校验)[:：]?\s*[「"]?(.+?)[」"]?$/) || d.match(/^验证(?:页面.*?包含|界面.*?出现)?[「"]?(.+?)[」"]?$/);
  if (verify) {
    const kw = cleanLabel(verify[1]).slice(0, 24);
    // 走 oracle 支持模块的 assert_control_text（基于**已核实**的 Hypium API：
    // driver.wait_for_component + BY.text，失败抛 TestAssertionError）。
    // ⚠️ 旧代码这里生成 self.driver.assert_component_exist(...) —— 该方法在 hypium 包里
    // 根本不存在（对 site-packages/hypium 全包搜索无此定义），脚本跑到验证步骤会 AttributeError。
    return [
      `        # 断言：预期控件必须真实存在（不存在则该用例失败）`,
      `        assert_control_text(self.driver, "${py(kw)}")`,
      `        Step('已断言「${py(kw)}」存在')`,
    ];
  }
  const open = d.match(/^(?:打开|启动)(?:应用)?[「:]?\s*(.+?)[」]?$/);
  if (open) return [`        Step('打开 ${py(open[1].slice(0, 24))}')`, '        self.driver.wait(1)'];
  const click = d.match(/^(?:点击|单击|选择|选中|确认|切换|勾选|滚动到)[:：]?\s*[「"]?(.+?)[」"]?$/);
  if (click) {
    const kw = cleanLabel(click[1]).slice(0, 24);
    return [
      `        self.driver.touch(BY.text("${py(kw)}"))`,
      '        self.driver.wait(1)',
    ];
  }
  return null;
}

/** oracle 支持模块文件名（放在 Hypium 工程根目录，脚本按需 import）。 */
export const ORACLE_SUPPORT_MODULE = 'autotest_oracle';

/**
 * oracle → 断言的落地。
 *
 * `script_assert` 直接内联成 Python 断言（它本来就是断言表达式）；
 * 其余六种统一走支持模块的辅助函数 —— 好处是**只有一个地方需要按 Hypium 版本适配**，
 * 而且支持模块里未实现的类型**一律抛错**，绝不静默通过（静默通过就是假通过）。
 */
export function oracleToPython(o: Record<string, unknown>, caseNoHint = ''): string[] {
  const q = (v: unknown): string => py(String(v ?? ''));
  switch (String(o.type ?? '')) {
    case 'script_assert': {
      const expr = String(o.expr ?? '').trim();
      if (!expr) return [`        raise AssertionError("oracle 缺少断言表达式")`];
      return [`        assert (${expr}), "oracle(script_assert): ${q(expr.slice(0, 60))}"`];
    }
    case 'control_text':
      return [`        assert_control_text(self.driver, "${q(o.control)}", expect="${q(o.expect ?? 'appear')}")`];
    case 'text_value':
      return [`        assert_text_value(self.driver, "${q(o.control)}", op="${q(o.op ?? 'contains')}", value="${q(o.value)}")`];
    case 'state_flag':
      return [`        assert_state_flag(self.driver, "${q(o.control)}", expected=${o.state === true ? 'True' : 'False'})`];
    case 'hilog_keyword':
      return [`        assert_hilog_keyword(self.driver, "${q(o.keyword ?? o.value)}")`];
    case 'no_crash':
      return [`        assert_no_crash(self.driver)`];
    case 'screenshot_diff':
      return [`        assert_screenshot_diff(self.driver, threshold=${Number(o.threshold ?? 0.05)}, name="${q(caseNoHint)}")`];
    default:
      return [`        raise AssertionError("未知 oracle 类型：${q(o.type)}")`];
  }
}

/**
 * oracle 支持模块内容：所有判据的唯一适配点。
 *
 * 这里的每个调用都**对着本机实际安装的 hypium 包核实过**（site-packages/hypium）：
 *   - driver.wait_for_component(by, timeout) → 控件对象或 None
 *   - driver.wait_for_component_disappear(by, timeout)
 *   - driver.get_component_property(comp|by, "text"|"checked"|…)   ← 属性名白名单见其 docstring
 *   - driver.current_app() → (package, page)
 *   - driver.shell(cmd, timeout) → 设备端 shell 输出（读 hilog 用）
 *   - driver.capture_screen(save_path, in_pc=True) → 截图落盘路径
 *   - UiComponent.getText() / isChecked()
 *   - devicetest.core.exception.TestAssertionError ← 框架认的断言异常（_exec_func 会判为失败）
 * 失败的断言一律抛 TestAssertionError：**绝不静默通过**（静默通过就是假通过）。
 *
 * ⚠️ 曾经的错误：旧生成器用的是 `driver.assert_component_exist(...)` —— 该方法在 hypium 包里
 * 根本不存在，脚本跑到验证步骤会 AttributeError。所以这里只用上面这些核实过的 API。
 */
export function oracleSupportModuleSource(): string {
  return [
    '# coding: utf-8',
    '"""',
    'AutoTest 生成的判据（oracle）断言支持模块。每条用例的"可机器校验判据"都落到这里。',
    '',
    '本文件里用到的 API 均已对着本机安装的 hypium 包核实：',
    '  wait_for_component / wait_for_component_disappear / get_component_property',
    '  current_app / shell / capture_screen / BY.text',
    '失败一律抛 TestAssertionError（devicetest 框架会判为用例失败），绝不静默通过。',
    '"""',
    'import os',
    'import re',
    '',
    'from devicetest.core.exception import TestAssertionError',
    'from hypium import BY',
    '',
    'DEFAULT_TIMEOUT = 5.0',
    '# 截图基线目录：首次运行会把当前截图存为基线，并要求人工确认后才算通过',
    'BASELINE_DIR = os.environ.get(',
    '    "AUTOTEST_BASELINE_DIR",',
    '    os.path.join(os.path.dirname(os.path.abspath(__file__)), "baselines"),',
    ')',
    '',
    '',
    'def _require_component(driver, control, timeout=DEFAULT_TIMEOUT):',
    '    """找到控件或直接失败（找不到控件 = 判据无法成立，不能当成通过）。"""',
    '    component = driver.wait_for_component(BY.text(control), timeout=timeout)',
    '    if component is None:',
    '        raise TestAssertionError(',
    '            "未找到控件「%s」（等待 %.1fs 超时）：判据无法校验" % (control, timeout)',
    '        )',
    '    return component',
    '',
    '',
    'def assert_control_text(driver, control, expect="appear", timeout=DEFAULT_TIMEOUT):',
    '    """界面出现/消失指定控件文本。"""',
    '    if expect == "disappear":',
    '        driver.wait_for_component_disappear(BY.text(control), timeout=timeout)',
    '        if driver.wait_for_component(BY.text(control), timeout=0.5) is not None:',
    '            raise TestAssertionError("控件「%s」未按要求消失" % control)',
    '        return',
    '    _require_component(driver, control, timeout)',
    '',
    '',
    'def assert_text_value(driver, control, op="contains", value="", timeout=DEFAULT_TIMEOUT):',
    '    """指定控件文本等于/包含/匹配某值。"""',
    '    component = _require_component(driver, control, timeout)',
    '    actual = str(driver.get_component_property(component, "text") or "")',
    '    if op == "equals":',
    '        ok = actual == value',
    '    elif op == "matches":',
    '        ok = bool(re.search(value, actual))',
    '    else:',
    '        ok = value in actual',
    '    if not ok:',
    '        raise TestAssertionError(',
    '            "控件「%s」文本不符合预期：实际 %r，期望 %s %r" % (control, actual, op, value)',
    '        )',
    '',
    '',
    'def assert_state_flag(driver, control, expected=True, timeout=DEFAULT_TIMEOUT):',
    '    """控件勾选/开关状态（checked）符合预期。"""',
    '    component = _require_component(driver, control, timeout)',
    '    actual = driver.get_component_property(component, "checked")',
    '    if bool(actual) is not bool(expected):',
    '        raise TestAssertionError(',
    '            "控件「%s」勾选状态不符：实际 %r，期望 %r" % (control, actual, expected)',
    '        )',
    '',
    '',
    'def assert_hilog_keyword(driver, keyword, timeout=60):',
    '    """hilog 中出现指定关键字（含错误码）。"""',
    '    logs = driver.shell("hilog -x", timeout=timeout)',
    '    if keyword not in logs:',
    '        raise TestAssertionError(',
    '            "hilog 中未出现关键字 %r（已读取日志 %d 字节）" % (keyword, len(logs))',
    '        )',
    '',
    '',
    'def assert_no_crash(driver, package_name=None, timeout=60):',
    '    """执行期间无崩溃：被测应用仍在前台，且日志里没有该应用的 E 级错误。"""',
    '    pkg, _page = driver.current_app()',
    '    if pkg is None:',
    '        raise TestAssertionError("读取当前前台应用失败：无法判定是否崩溃")',
    '    if package_name and pkg != package_name:',
    '        raise TestAssertionError(',
    '            "应用已不在前台（当前 %s，期望 %s）：疑似崩溃或被中断" % (pkg, package_name)',
    '        )',
    '    logs = driver.shell("hilog -x", timeout=timeout)',
    '    # hilog 行格式：日期 时间 进程号 线程号 级别 标签: 内容；只看被测应用相关的 E 级行',
    '    hits = [',
    '        line for line in logs.splitlines()',
    '        if re.search(r"\\sE\\s", line) and (not package_name or package_name in line)',
    '    ]',
    '    if hits:',
    '        raise TestAssertionError("日志中出现 E 级错误 %d 条，例如：%s" % (len(hits), hits[0][:200]))',
    '',
    '',
    'def assert_screenshot_diff(driver, threshold=0.05, name=""):',
    '    """截图像素差异在阈值内（与基线对比）。',
    '',
    '    首次运行没有基线时会**保存基线并判定失败**（而不是当作通过）：',
    '    静默通过等于把没测的东西报成测过了。人工确认基线正确后重跑即可。',
    '    """',
    '    try:',
    '        from PIL import Image, ImageChops',
    '    except ImportError:',
    '        raise TestAssertionError("缺少 Pillow，无法做截图对比：请 pip install pillow")',
    '',
    '    os.makedirs(BASELINE_DIR, exist_ok=True)',
    '    tag = name or "case"',
    '    baseline = os.path.join(BASELINE_DIR, "%s.png" % tag)',
    '    current = os.path.join(BASELINE_DIR, "%s.current.png" % tag)',
    '    driver.capture_screen(current, in_pc=True)',
    '    if not os.path.exists(baseline):',
    '        os.replace(current, baseline)',
    '        raise TestAssertionError(',
    '            "首次运行：已把当前截图存为基线 %s，请人工确认后重跑（基线未确认前不算通过）" % baseline',
    '        )',
    '    base_img = Image.open(baseline).convert("RGB")',
    '    cur_img = Image.open(current).convert("RGB")',
    '    if base_img.size != cur_img.size:',
    '        raise TestAssertionError(',
    '            "截图尺寸不一致：基线 %s，当前 %s" % (base_img.size, cur_img.size)',
    '        )',
    '    diff = ImageChops.difference(base_img, cur_img)',
    '    pixels = base_img.size[0] * base_img.size[1]',
    '    changed = sum(1 for px in diff.getdata() if px != (0, 0, 0))',
    '    ratio = changed / float(pixels or 1)',
    '    if ratio > threshold:',
    '        raise TestAssertionError(',
    '            "截图差异 %.2f%% 超过阈值 %.2f%%（基线 %s）" % (ratio * 100, threshold * 100, baseline)',
    '        )',
    '',
  ].join('\n');
}
/** 类名：Case_<caseNo 去符号>，如 C-AI-001 → Case_CAI001。 */
export function caseClassName(caseNo: string): string {
  return `Case_${caseNo.replace(/[^\w]/g, '').slice(0, 28)}`;
}

/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export function generateCaseScript(
  lib: HypiumLib,
  c: HypiumCaseInput,
): string {
  const cls = caseClassName(c.caseNo);
  const pkg = py(lib.packageName || lib.name);
  const body: string[] = [];
  for (let i = 0; i < c.steps.length; i++) {
    const lines = stepToPython(c.steps[i], pkg);
    // 未映射即失败：不再产出注释行让脚本"看起来正常"
    if (lines === null) throw new UnmappedStepError(i, c.steps[i]);
    body.push(`        Step('${i + 1}. ${py(c.steps[i].slice(0, 50))}')`);
    body.push(...lines);
    body.push('');
  }
  if (c.steps.length === 0) body.push("        self.driver.wait(2)");

  // P6/P8：oracle → 断言（没有 oracle 的用例不会有断言，随后被空脚本拦截拒绝绑定）
  const oracles = Array.isArray(c.oracles) ? c.oracles : [];
  const oracleLines: string[] = [];
  // 验证步骤与 oracle 都走 oracle 支持模块的 assert_control_text —— 统一一个适配点
  const needsSupport = oracles.length > 0 || c.steps.some((s) => /^\s*(验证|断言|检查|校验)/.test(s));
  if (oracles.length > 0) {
    body.push("        Step('可机器校验判据（oracle）')");
    for (const o of oracles) {
      body.push(...oracleToPython(o, c.caseNo));
      body.push(`        Step('已校验判据：${py(String(o.type ?? ''))}')`);
    }
  }
  if (needsSupport) {
    const fns = new Set<string>();
    if (c.steps.some((s) => /^\s*(验证|断言|检查|校验)/.test(s))) fns.add('assert_control_text');
    for (const o of oracles) {
      const t = String(o.type ?? '');
      const map: Record<string, string> = {
        control_text: 'assert_control_text', text_value: 'assert_text_value', state_flag: 'assert_state_flag',
        hilog_keyword: 'assert_hilog_keyword', no_crash: 'assert_no_crash', screenshot_diff: 'assert_screenshot_diff',
      };
      if (map[t]) fns.add(map[t]);
    }
    oracleLines.push(`from ${ORACLE_SUPPORT_MODULE} import (`);
    for (const fn of [...fns]) oracleLines.push(`    ${fn},`);
    oracleLines.push(')');
  }

  return [
    '# !/usr/bin/env python',
    '# coding: utf-8',
    '"""',
    '#!!================================================================',
    `# AutoTest 生成 · Hypium 用例脚本`,
    `# 用例：${c.caseNo} ${c.name}`,
    `# 三方库：${lib.name}（${pkg}）`,
    `# 可机器校验判据：${oracles.length} 条`,
    `# 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    '#!!================================================================',
    '"""',
    '',
    'from devicetest.core.test_case import TestCase, Step',
    'from hypium import *',
    'from hypium.model import UiParam',
    ...oracleLines,
    '',
    '',
    `class ${cls}(TestCase):`,
    '    def __init__(self, controllers):',
    '        self.TAG = self.__class__.__name__',
    '        TestCase.__init__(self, self.TAG, controllers)',
    '        self.driver = UiDriver(self.device1)',
    '',
    '    def setup(self):',
    `        Step('杀掉${py(lib.name)}应用')`,
    `        self.driver.stop_app("${pkg}")`,
    `        Step('启动${py(lib.name)}应用')`,
    `        self.driver.start_app(package_name="${pkg}")`,
    '        self.driver.wait(3)',
    '',
    '    def process(self):',
    ...body,
    '    def teardown(self):',
    `        self.driver.stop_app("${pkg}")`,
    '',
    '',
  ].join('\n');
}

/**
 * 校验脚本至少含一个断言 —— 空脚本一律拒绝绑定（修 R12）。
 * 判据：脚本里出现 assert_* 函数名、Python `assert` 语句，或 Hypium 的断言方法。
 */
export function scriptHasAssertion(script: string): boolean {
  return /^\s*assert\s+\S/m.test(script)
    || /\bassert_[a-z_]+\s*\(/.test(script)
    || /\.assert[A-Za-z_]*\s*\(/.test(script);
}

/** 写入（或覆盖）用例绑定脚本，返回文件路径。未映射步骤与空脚本都会抛错（不落盘）。 */
export function writeCaseScript(lib: HypiumLib, c: HypiumCaseInput): string {
  const script = generateCaseScript(lib, c);
  if (!scriptHasAssertion(script)) throw new NoAssertionError(c.caseNo);
  ensureHypiumProject(lib);
  const file = hypiumCaseScriptPath(lib.name, c.caseNo);
  fs.writeFileSync(file, script, 'utf8');
  // 同步 oracle 支持模块（脚本 import 它；缺失会导致用例整体报错，宁早不宁晚）
  const support = path.join(hypiumProjectDir(lib.name), `${ORACLE_SUPPORT_MODULE}.py`);
  if (!fs.existsSync(support)) fs.writeFileSync(support, oracleSupportModuleSource(), 'utf8');
  return file;
}
