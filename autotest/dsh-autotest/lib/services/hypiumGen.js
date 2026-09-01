// Hypium（Python + xdevice）脚本生成 —— 对齐 HypiumProjectTemplate：
//  - 工程骨架：workspace/hypium/<lib>/（config/user_config.xml + main.py + run.bat/sh）
//  - 每条用例一个独立模块：testcases/<lib>/<caseNo>.py，类名 Case_<safe>；
//    main.py 的 run -l <模块名> 即可单用例执行
//  - 中文步骤确定性映射为 driver 调用（点击/输入/滑动/等待/验证/打开），不经过 LLM、不臆造控件
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './gitRepo.js';
const safe = (s) => s.replace(/[^\w.-]/g, '_');
/** 库的 Hypium 工程根目录。 */
export function hypiumProjectDir(libName) {
    return path.join(workspaceDir(), 'hypium', safe(libName));
}
/** 用例绑定脚本路径：testcases/<lib>/<caseNo>.py。 */
export function hypiumCaseScriptPath(libName, caseNo) {
    const s = safe(libName);
    return path.join(hypiumProjectDir(libName), 'testcases', s, `${safe(caseNo)}.py`);
}
function userConfigXml(serial) {
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
function mainPy() {
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
export function ensureHypiumProject(lib, serial) {
    const base = hypiumProjectDir(lib.name);
    const s = safe(lib.name);
    fs.mkdirSync(path.join(base, 'testcases', s), { recursive: true });
    fs.mkdirSync(path.join(base, 'config'), { recursive: true });
    if (serial)
        fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml(serial), 'utf8');
    else if (!fs.existsSync(path.join(base, 'config', 'user_config.xml'))) {
        fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfigXml('UNKNOWN'), 'utf8');
    }
    if (!fs.existsSync(path.join(base, 'main.py')))
        fs.writeFileSync(path.join(base, 'main.py'), mainPy(), 'utf8');
    if (!fs.existsSync(path.join(base, 'run.bat'))) {
        fs.writeFileSync(path.join(base, 'run.bat'), '@echo off\ncd /d %~dp0\npython main.py\npause\n', 'utf8');
    }
    if (!fs.existsSync(path.join(base, 'run.sh'))) {
        fs.writeFileSync(path.join(base, 'run.sh'), '#!/bin/bash\ncd "$(dirname "$0")"\npython3 main.py "$@"\n', 'utf8');
    }
}
// ---------- 中文步骤 → driver 调用 ----------
function pickKw(desc) {
    return desc
        .replace(/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|长按|勾选|取消|删除|验证|检查|断言|校验)[:：\s]*/, '')
        .replace(/^[控件]+\s*[:：]\s*/, '') // 剔除「控件：」等标签前缀（dump 里静态标签与值分离时的合并残留）
        .replace(/[「」“”"'，,。.！!？?；;、]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)[0]
        ?.slice(0, 20) ?? '';
}
/** 控件文本净化：剔除标签前缀、压缩空白 —— BY.text 必须与界面可见文本完全一致。 */
function cleanLabel(label) {
    return label
        .replace(/^控件\s*[:：]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function py(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/** 单条步骤 → python 行（无法识别时生成注释，保证脚本语法始终合法）。 */
function stepToPython(step, pkg) {
    const d = step.trim();
    if (!d)
        return [];
    // 「打开应用」/「启动应用」：setup 只执行一次，用例中途需要回到首页时依赖此句式 → 显式重启应用
    if (pkg && /^(?:打开|启动)\s*(?:应用|app)?$/i.test(d)) {
        return [
            `        self.driver.start_app(package_name="${py(pkg)}")`,
            '        self.driver.wait(3)',
        ];
    }
    const mSec = d.match(/^等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*秒?$/);
    if (mSec)
        return [`        self.driver.wait(${Math.max(1, Math.round(parseFloat(mSec[1])))})`];
    const mMin = d.match(/^等待\s*(?:约)?\s*(\d+)\s*分钟$/);
    if (mMin)
        return [`        self.driver.wait(${Math.min(120, parseInt(mMin[1]) * 60)})`];
    if (/^等待/.test(d))
        return ['        self.driver.wait(2)'];
    if (/^(返回|退出|回退)/.test(d))
        return ['        self.driver.swipe_to_back()'];
    if (/^滑动|^向上滑|^上滑/.test(d))
        return ['        self.driver.swipe(UiParam.UP, distance=60)'];
    if (/^下滑|^向下滑/.test(d))
        return ['        self.driver.swipe(UiParam.DOWN, distance=60)'];
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
        return [
            `        # 断言：预期控件必须真实存在（不存在则该用例失败）`,
            `        self.driver.assert_component_exist(BY.text("${py(kw)}"), "预期控件未找到: ${py(kw)}")`,
            `        Step('已断言「${py(kw)}」存在')`,
        ];
    }
    const open = d.match(/^(?:打开|启动)(?:应用)?[「:]?\s*(.+?)[」]?$/);
    if (open)
        return [`        Step('打开 ${py(open[1].slice(0, 24))}')`, '        self.driver.wait(1)'];
    const click = d.match(/^(?:点击|单击|选择|选中|确认|切换|勾选|滚动到)[:：]?\s*[「"]?(.+?)[」"]?$/);
    if (click) {
        const kw = cleanLabel(click[1]).slice(0, 24);
        return [
            `        self.driver.touch(BY.text("${py(kw)}"))`,
            '        self.driver.wait(1)',
        ];
    }
    return [`        # 未映射步骤（保留原文供人工补充）: ${py(d.slice(0, 60))}`];
}
/** 类名：Case_<caseNo 去符号>，如 C-AI-001 → Case_CAI001。 */
export function caseClassName(caseNo) {
    return `Case_${caseNo.replace(/[^\w]/g, '').slice(0, 28)}`;
}
/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export function generateCaseScript(lib, c) {
    const cls = caseClassName(c.caseNo);
    const pkg = py(lib.packageName || lib.name);
    const body = [];
    for (let i = 0; i < c.steps.length; i++) {
        const lines = stepToPython(c.steps[i], pkg);
        body.push(`        Step('${i + 1}. ${py(c.steps[i].slice(0, 50))}')`);
        body.push(...lines);
        body.push('');
    }
    if (c.steps.length === 0)
        body.push("        self.driver.wait(2)");
    return [
        '# !/usr/bin/env python',
        '# coding: utf-8',
        '"""',
        '#!!================================================================',
        `# AutoTest 生成 · Hypium 用例脚本`,
        `# 用例：${c.caseNo} ${c.name}`,
        `# 三方库：${lib.name}（${pkg}）`,
        `# 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        '#!!================================================================',
        '"""',
        '',
        'from devicetest.core.test_case import TestCase, Step',
        'from hypium import *',
        'from hypium.model import UiParam',
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
/** 写入（或覆盖）用例绑定脚本，返回文件路径。 */
export function writeCaseScript(lib, c) {
    ensureHypiumProject(lib);
    const file = hypiumCaseScriptPath(lib.name, c.caseNo);
    fs.writeFileSync(file, generateCaseScript(lib, c), 'utf8');
    return file;
}
