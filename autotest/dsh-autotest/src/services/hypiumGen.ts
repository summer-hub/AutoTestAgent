// Hypium（Python + xdevice）脚本生成 —— 对齐 HypiumProjectTemplate：
//  - **单工程 + 库命名空间**：所有库共用一个工程根 `workspace/hypium/`，骨架（main.py / aw/ / config /
//    resource/）只维护一份；每条用例一个模块 `testcases/<lib>/<lib>_<caseNo>.py`，**并配对一份
//    `<lib>_<caseNo>.json`**（xdevice 驱动配置，driver.py_file 指向脚本）。
//    为什么不是"每库一个工程"：多库场景下骨架会复制 N 份，改一个交互 bug 要去改 N 处，
//    aw/ 里的共享工具也会漂移成 N 个版本 —— 见 skills/ohos-case-to-hypium 的解耦纪律。
//  - 文件名 / Python 类名 / xdevice 的 `-l <模块>` / 报告里的模块名**四者必须完全一致**，
//    所以统一由 hypiumCaseModule() 生成，不允许各处自己拼。
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

/** 库名 → 目录名/模块前缀（`json-schema` → `json_schema`）。 */
export function hypiumLibSlug(libName: string): string {
  const s = safe(String(libName).trim()).replace(/[.-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const t = s || 'lib';
  return /^\d/.test(t) ? `lib_${t}` : t;
}

/** 用例编号 → 模块后缀（`C-JS-001` → `C_JS_001`）。 */
export function hypiumCaseSlug(caseNo: string): string {
  const s = safe(String(caseNo).trim()).replace(/[.-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const t = s || 'case';
  return /^\d/.test(t) ? `C_${t}` : t;
}

/**
 * 模块名 = 文件名 = Python 类名 = `-l` 参数 = 报告里的模块名。
 * 形如 `json_schema_C_JS_001`：满足模板的 `<lib>_<Case>` 可读性，又与平台用例编号强对应 ——
 * 改用例标题不会改文件名，重跑/绑定/报告都不受影响。
 */
export function hypiumCaseModule(libName: string, caseNo: string): string {
  return `${hypiumLibSlug(libName)}_${hypiumCaseSlug(caseNo)}`;
}

/**
 * **共享** Hypium 工程根目录（单工程 + 库命名空间）。
 * 参数保留是为了不破坏既有调用方，但已不再参与路径计算 —— 各库只体现在 `testcases/<lib>/` 里。
 */
export function hypiumProjectDir(_libName?: string): string {
  return path.join(workspaceDir(), 'hypium');
}

/** 用例的库目录：<工程根>/testcases/<lib>。 */
export function hypiumLibDir(libName: string): string {
  return path.join(hypiumProjectDir(), 'testcases', hypiumLibSlug(libName));
}

/** 用例脚本路径：testcases/<lib>/<lib>_<caseNo>.py。 */
export function hypiumCaseScriptPath(libName: string, caseNo: string): string {
  return path.join(hypiumLibDir(libName), `${hypiumCaseModule(libName, caseNo)}.py`);
}

/** 用例的 xdevice 驱动配置路径：与脚本同名同目录，只是扩展名不同（成对生成，缺一不可）。 */
export function hypiumCaseJsonPath(libName: string, caseNo: string): string {
  return path.join(hypiumLibDir(libName), `${hypiumCaseModule(libName, caseNo)}.json`);
}

/** 共享工具目录（骨架，生成器只补缺不覆盖）。 */
export function hypiumAwDir(): string {
  return path.join(hypiumProjectDir(), 'aw');
}

/** 截图基线目录：框架产出的 zip 与判据用的 png 共用这一个目录（避免两套基线各说各话）。 */
export function hypiumBaselineDir(): string {
  return path.join(hypiumProjectDir(), 'resource', 'baseline');
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
  // 模块名来自 argv：一条命令跑一个用例，执行器不必再改写本文件
  return [
    '# -*- coding: utf-8 -*-',
    '# 单工程多库：module 形如 <lib>_<caseNo>（对应 testcases/<lib>/<lib>_<caseNo>.py）',
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

/** aw/Utils.py：模板自带的共享工具（原实现保留）。 */
const AW_UTILS = [
  'from hypium import UiDriver',
  '',
  '',
  'def get_app_version_code(driver: UiDriver, bundle: str) -> int:',
  "    info = driver.shell('bm dump -n {} |grep versionCode'.format(bundle))",
  "    if 'versionCode' not in info:",
  '        return 0',
  '    token = info.splitlines()[-1]',
  "    code_str = token.replace('\"versionCode\":', '').replace(',', '').strip()",
  '    return int(code_str)',
  '',
].join('\n');

const PROJECT_GITIGNORE = ['/.idea/', '/config/', '/reports/', '__pycache__/', '*.pyc', 'reports/', 'tmp_hypium/', ''].join('\n');

/**
 * 旧布局迁移：`workspace/hypium/<lib>/`（每库一个工程）→ `workspace/hypium/testcases/<lib>/`（单工程多库）。
 *
 * 为什么要显式迁移而不是"放着不管"：路径变了之后旧脚本会变成"找不到文件"，
 * 绑定状态被判 broken，人会以为脚本丢了。这里把用例文件搬过来，并清理旧工程里**由我们生成的**
 * 骨架文件（main.py / run.* / config / .gitignore / autotest_oracle.py）。
 * 只动这几个已知名字，其他文件一律保留并让整个目录留着 —— 宁可留下看不懂的东西，也不删用户的东西。
 */
export function migrateLegacyHypiumLayouts(): { libs: string[]; files: number } {
  const root = hypiumProjectDir();
  const libs: string[] = [];
  let files = 0;
  if (!fs.existsSync(root)) return { libs, files };
  const skeleton = new Set(['main.py', 'run.bat', 'run.sh', '.gitignore', 'autotest_oracle.py']);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'testcases' || entry.name === 'aw' || entry.name === 'config' || entry.name === 'resource') continue;
    const legacyRoot = path.join(root, entry.name);
    // 判定为旧工程根：有 main.py 且其下还有 testcases/
    if (!fs.existsSync(path.join(legacyRoot, 'main.py'))) continue;
    const legacyCases = path.join(legacyRoot, 'testcases');
    if (!fs.existsSync(legacyCases)) continue;

    const moveDir = (from: string, to: string): void => {
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, f.name);
        const dst = path.join(to, f.name);
        if (f.isDirectory()) { moveDir(src, dst); continue; }
        if (!fs.existsSync(dst)) { fs.renameSync(src, dst); files++; }
      }
    };
    for (const libDir of fs.readdirSync(legacyCases, { withFileTypes: true })) {
      if (!libDir.isDirectory()) continue;
      moveDir(path.join(legacyCases, libDir.name), path.join(root, 'testcases', libDir.name));
    }
    // 清理旧骨架（只删已知文件名），然后**只删空目录** —— 目录里还有人手写的东西就整个留着。
    // 第一版这里直接 rmSync(recursive) 把整个旧工程删掉，连同事写的 README 一起没了：
    // 搬走脚本是我们要做的，删别人的东西不是。
    for (const f of fs.readdirSync(legacyRoot)) {
      if (skeleton.has(f)) { try { fs.rmSync(path.join(legacyRoot, f), { force: true }); } catch { /* 忽略 */ } }
    }
    removeEmptyDirs(legacyRoot);
    libs.push(entry.name);
  }
  return { libs, files };
}

/** 递归删除**空**目录（遇到有内容的目录就停手）。 */
function removeEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) removeEmptyDirs(path.join(dir, f.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* 忽略 */ }
}

/**
 * 确保**共享工程骨架**存在（幂等；骨架文件只补缺、绝不覆盖）。
 *
 * 为什么只补缺：main.py / aw/ / config 是团队共有资产，手写的改动（比如机构特有的等待函数）
 * 被生成器覆盖掉是灾难性的。生成器只拥有 `testcases/<lib>/` 下的文件。
 */
export function ensureHypiumProject(lib: HypiumLib, serial?: string): void {
  // 顺带做一次旧布局迁移（幂等：没有旧工程时几乎零开销）
  try { migrateLegacyHypiumLayouts(); } catch { /* 迁移失败不阻断生成 */ }
  const base = hypiumProjectDir();
  fs.mkdirSync(hypiumLibDir(lib.name), { recursive: true });
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.mkdirSync(hypiumAwDir(), { recursive: true });
  fs.mkdirSync(hypiumBaselineDir(), { recursive: true });
  fs.mkdirSync(path.join(base, 'resource', 'images'), { recursive: true });

  if (serial) fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml(serial), 'utf8');
  else if (!fs.existsSync(path.join(base, 'config', 'user_config.xml'))) {
    fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml('UNKNOWN'), 'utf8');
  }
  const onlyIfMissing: Array<[string, string]> = [
    ['main.py', mainPy()],
    ['run.bat', '@echo off\ncd /d %~dp0\npython main.py %*\npause\n'],
    ['run.sh', '#!/bin/bash\ncd "$(dirname "$0")"\npython3 main.py "$@"\n'],
    ['.gitignore', PROJECT_GITIGNORE],
    [path.join('aw', '__init__.py'), ''],
    [path.join('aw', 'Utils.py'), AW_UTILS],
  ];
  for (const [rel, content] of onlyIfMissing) {
    const p = path.join(base, rel);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    }
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
export function oracleToPython(o: Record<string, unknown>, caseNoHint = '', packageName = ''): string[] {
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
      // 必须带上 package_name：不限定应用的整机日志里永远有 E 级行（系统进程/历史日志），
      // 那样会把三天前的 light_sensor 报错当成"本用例崩溃" —— 实测踩过。
      return [`        assert_no_crash(self.driver, package_name="${q(packageName)}")`];
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
    'AutoTest 生成的判据（oracle）断言支持模块 —— 每条用例的"可机器校验判据"都落到这里。',
    '',
    '⚠️ 本文件由生成器维护：**不要手改**（下次生成会覆盖）。需要定制请另建 aw/your_own.py，',
    '   或直接改生成器（src/services/hypiumGen.ts 的 oracleSupportModuleSource）。',
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
    '    # 本模块位于 <工程根>/aw/，基线统一放 <工程根>/resource/baseline/',
    '    # （与 xdevice 自己产出的 <case>.zip 基线同目录，避免同一工程里出现两套基线）',
    '    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resource", "baseline"),',
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
    '# ---------- 日志相关的公共设施（只统计"本次执行期间、本应用进程"的日志） ----------',
    '',
    '# 用例开始时间（设备侧时钟）。设备日志缓冲区里有几天前的历史日志，',
    '# 不按时间窗过滤就会把历史错误当成本次的问题 —— 这是最容易被忽略的假阳性来源。',
    '_RUN_START = None',
    '',
    '',
    'def _device_now(driver):',
    '    """读设备侧当前时间（与 hilog 时间戳同源，避免主机/设备时钟偏差）。"""',
    '    try:',
    '        out = driver.shell("date +\'%m-%d %H:%M:%S\'", timeout=10)',
    '    except Exception:',
    '        return ""',
    '    return (out or "").strip().splitlines()[-1].strip() if (out or "").strip() else ""',
    '',
    '',
    'def _run_start(driver):',
    '    """本次执行的时间起点（缓存一次）。"""',
    '    global _RUN_START',
    '    if _RUN_START is None:',
    '        _RUN_START = _device_now(driver)',
    '    return _RUN_START',
    '',
    '',
    'def _app_pid(driver, package_name):',
    '    """被测应用进程号；取不到说明进程可能已退出。"""',
    '    try:',
    '        out = driver.shell("pidof %s" % package_name, timeout=10)',
    '    except Exception:',
    '        return ""',
    '    text = (out or "").strip()',
    '    if not text:',
    '        return ""',
    '    return text.splitlines()[-1].split()[0].strip()',
    '',
    '',
    'def _line_after(line, start):',
    '    """hilog 行形如 "09-20 23:04:12.552 ..."，判断是否在 start 之后。"""',
    '    if not start:',
    '        return True          # 拿不到设备时间就只能不过滤（但下面还有 PID 限定兜底）',
    '    return line[:17].strip() >= start',
    '',
    '',
    'def _line_matches_pid(line, pid):',
    '    """按 PID 列精确匹配。',
    '',
    '    hilog 行格式：`09-20 23:04:12.552  1011  1011 E I04301/tag: msg`',
    '    即 [0]=日期 [1]=时间 [2]=进程号 [3]=线程号 [4]=级别 —— PID 在级别**之前**，',
    '    别写成正则去级别后面找（第一版就写错了，等于不过滤）。',
    '    """',
    '    parts = line.split()',
    '    if len(parts) < 5:',
    '        return False',
    '    return parts[2] == pid and parts[4] == "E"',
    '',
    '',
    'def _read_run_log(driver, timeout=60, level=""):',
    '    """只取本次执行期间的日志行（level 传 "E" 时只取错误级，日志量小一个数量级）。"""',
    '    start = _run_start(driver)',
    '    cmd = "hilog -x -L %s" % level if level else "hilog -x"',
    '    try:',
    '        logs = driver.shell(cmd, timeout=timeout)',
    '    except Exception as e:',
    '        raise TestAssertionError("读取 hilog 失败（%s）：无法判定" % e)',
    '    lines = [ln for ln in (logs or "").splitlines() if _line_after(ln, start)]',
    '    return "\\n".join(lines)',
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
    '    """hilog 中出现指定关键字（含错误码）。',
    '',
    '    只看**本次用例执行期间**的日志：设备日志缓冲区里躺着几天前的历史，',
    '    不过滤时间窗的话，一个历史关键字就能让判据"成立"——那是假通过。',
    '    """',
    '    logs = _read_run_log(driver, timeout)',
    '    if keyword not in logs:',
    '        raise TestAssertionError(',
    '            "hilog 中未出现关键字 %r（本次执行期间读取 %d 字节）" % (keyword, len(logs))',
    '        )',
    '',
    '',
    'def assert_no_crash(driver, package_name, timeout=60):',
    '    """执行期间无崩溃：被测应用仍在前台，且本次执行期间没有该应用进程的 E 级日志。',
    '',
    '    ⚠️ 必须传 package_name。实测教训：不限定应用的实现会把整机历史日志（例如三天前',
    '    light_sensor 的系统报错）算成"本用例崩溃"，于是真机上**每个用例都必然失败**。',
    '    这里三重限定：应用在前台 + 按 PID 只认本应用进程 + 只认本次执行时间窗内的行。',
    '    """',
    '    if not package_name:',
    '        raise TestAssertionError(',
    '            "assert_no_crash 缺少 package_name：不限定应用的日志里全是系统噪音，"',
    '            "会把历史 E 级日志误判成崩溃（无法据此判定）"',
    '        )',
    '    pkg, _page = driver.current_app()',
    '    if pkg is None:',
    '        raise TestAssertionError("读取当前前台应用失败：无法判定是否崩溃")',
    '    if pkg != package_name:',
    '        raise TestAssertionError(',
    '            "应用已不在前台（当前 %s，期望 %s）：疑似崩溃或被中断" % (pkg, package_name)',
    '        )',
    '    pid = _app_pid(driver, package_name)',
    '    if not pid:',
    '        raise TestAssertionError(',
    '            "取不到 %s 的进程号：应用可能已经退出（疑似崩溃），无法判定" % package_name',
    '        )',
    '    logs = _read_run_log(driver, timeout=timeout, level="E")',
    '    hits = [line for line in logs.splitlines() if _line_matches_pid(line, pid)]',
    '    if hits:',
    '        raise TestAssertionError(',
    '            "本次执行期间应用日志出现 E 级错误 %d 条，例如：%s" % (len(hits), hits[0][:200])',
    '        )',
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
/**
 * Python 类名 = 模块名 = 文件名 = `-l` 参数。
 * xdevice 用 `run -l <模块名>` 加载用例，而模块里的 TestCase 类名必须与之一致 ——
 * 所以这里不再自己拼 `Case_xxx`，一律走 hypiumCaseModule()，保证四方一致。
 */
export function caseClassName(libName: string, caseNo: string): string {
  return hypiumCaseModule(libName, caseNo);
}

/**
 * 用例的 xdevice 驱动配置内容（与脚本成对落盘）。
 * 模板里每个用例都有这份 json：`driver.py_file` 里的路径是**相对 testcases/** 的。
 */
export function caseJsonContent(lib: HypiumLib, c: HypiumCaseInput): string {
  return JSON.stringify({
    description: `${lib.name} ${c.caseNo} ${c.name}`.slice(0, 120),
    environment: [{ type: 'device', label: 'phone' }],
    driver: {
      type: 'DeviceTest',
      py_file: [`${hypiumLibSlug(lib.name)}/${hypiumCaseModule(lib.name, c.caseNo)}.py`],
    },
  }, null, 2) + '\n';
}

/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export function generateCaseScript(
  lib: HypiumLib,
  c: HypiumCaseInput,
): string {
  const cls = caseClassName(lib.name, c.caseNo);
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
      body.push(...oracleToPython(o, c.caseNo, pkg));
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
    oracleLines.push(`from aw.${ORACLE_SUPPORT_MODULE} import (`);
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

/**
 * 写入（或覆盖）用例绑定脚本**与配对的 xdevice 驱动配置**，返回脚本路径。
 * 未映射步骤与空脚本都会抛错（不落盘）。
 *
 * 成对写入的原因：注册表里只有 .py 而没有同名 .json 时，xdevice 不知道该怎么驱动这个模块
 * （模板里每个用例都是成对的），少一个就等于"用例看起来存在但跑不起来"。
 */
export function writeCaseScript(lib: HypiumLib, c: HypiumCaseInput): string {
  const script = generateCaseScript(lib, c);
  if (!scriptHasAssertion(script)) throw new NoAssertionError(c.caseNo);
  ensureHypiumProject(lib);
  const file = hypiumCaseScriptPath(lib.name, c.caseNo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script, 'utf8');
  fs.writeFileSync(hypiumCaseJsonPath(lib.name, c.caseNo), caseJsonContent(lib, c), 'utf8');
  // 同步判据断言模块到共享 aw/ 包。
  // **每次覆盖**：这个文件是生成物（不是团队手写的骨架），不覆盖的话"修好的断言"
  // 永远进不了已存在的工程 —— 200+ 个库时就是"每个库各有一套旧断言"。
  // 要定制请写到自己的 aw/xxx.py，或改生成器；文件头已写明这一点。
  const support = path.join(hypiumAwDir(), `${ORACLE_SUPPORT_MODULE}.py`);
  fs.writeFileSync(support, oracleSupportModuleSource(), 'utf8');
  return file;
}
