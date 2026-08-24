// Hypium 自动化脚本生成（参考 HypiumProjectTemplate 模板）
//  - 基于真机遍历结果（ExploredPage）生成 Python 测试脚本
//  - setup：杀应用/启动应用；process：按页面路径 driver.touch(BY.text) 进入 + 验证
//  - 同时生成 config/user_config.xml 与 main.py，可在模板目录直接运行
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './gitRepo.js';
function suiteName(libName) {
    return libName.replace(/[^\w]/g, '').toLowerCase() + '_Explore';
}
function esc(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function buildTestMethods(pages) {
    const methods = [];
    for (const page of pages) {
        const rawName = page.path[page.path.length - 1] ?? '首页';
        const safeName = (rawName.replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 24)) || 'Home';
        const pathLabel = esc(page.path.join(' → '));
        const tapLines = [];
        for (const s of page.path) {
            if (s === '首页')
                continue;
            tapLines.push(`        self.driver.touch(BY.text("${esc(s)}"))`);
            tapLines.push('        self.driver.wait(1)');
        }
        const verifyLines = [];
        for (const c of page.controls.slice(0, 5)) {
            const kw = (c.text || c.desc).trim().slice(0, 20);
            if (kw)
                verifyLines.push(`        self.driver.find_component(BY.text("${esc(kw)}"))`);
        }
        methods.push(`    def test_${safeName}(self):\n` +
            `        Step('1. 按路径进入：${pathLabel}')\n` +
            (tapLines.length > 0 ? tapLines.join('\n') + '\n' : '        self.driver.wait(1)\n') +
            `        Step('2. 验证页面控件与动画')\n` +
            '        self.driver.wait(2)\n' +
            (verifyLines.length > 0 ? verifyLines.join('\n') + '\n' : '') +
            `        self.driver.screenshot("${safeName}")\n`);
    }
    return methods.join('\n');
}
/** 生成单个测试套件 Python 脚本。 */
export function generateHypiumScript(lib, pages) {
    const suite = suiteName(lib.name);
    const methods = buildTestMethods(pages);
    const lines = [];
    lines.push('# !/usr/bin/env python');
    lines.push('# coding: utf-8');
    lines.push('"""');
    lines.push('#!!================================================================');
    lines.push(`# AutoTest 生成 · Hypium 测试脚本（真机遍历驱动）`);
    lines.push(`# 三方库：${lib.name}（${lib.packageName}）`);
    lines.push(`# 页面数：${pages.length}`);
    lines.push('#==================================================================');
    lines.push('"""');
    lines.push('');
    lines.push('from devicetest.core.test_case import TestCase, Step');
    lines.push('from hypium import *');
    lines.push('');
    lines.push('');
    lines.push(`class ${suite}(TestCase):`);
    lines.push('    def __init__(self, controllers):');
    lines.push('        self.TAG = self.__class__.__name__');
    lines.push('        TestCase.__init__(self, self.TAG, controllers)');
    lines.push('        self.driver = UiDriver(self.device1)');
    lines.push('');
    lines.push('    def setup(self):');
    lines.push(`        Step('1. 杀掉${lib.name}应用')`);
    lines.push(`        self.driver.stop_app("${esc(lib.packageName)}")`);
    lines.push(`        Step('2. 启动${lib.name}应用')`);
    lines.push(`        self.driver.start_app(package_name="${esc(lib.packageName)}")`);
    lines.push("        Step('3. 等待首页加载')");
    lines.push('        self.driver.wait(3)');
    lines.push('');
    lines.push(methods);
    lines.push('    def teardown(self):');
    lines.push(`        self.driver.stop_app("${esc(lib.packageName)}")`);
    lines.push('');
    return lines.join('\n');
}
/** 生成 user_config.xml（设备 SN）。 */
function userConfig(serial) {
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
/** 生成 main.py（运行指定 suite）。 */
function mainPy(suite) {
    return [
        'from xdevice.__main__ import main_process',
        '',
        'if __name__ == "__main__":',
        `  main_process("run -l ${suite} -ta agent_mode:bin;screenshot:true")`,
        '',
    ].join('\n');
}
/** 落盘完整 Hypium 工程到 workspace/hypium/<lib>/。 */
export function writeHypiumProject(lib, pages, serial) {
    const suite = suiteName(lib.name);
    const safe = lib.name.replace(/[^\w.-]/g, '_');
    const base = path.join(workspaceDir(), 'hypium', safe);
    const testDir = path.join(base, 'testcases', safe);
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(base, 'config'), { recursive: true });
    const scriptFile = path.join(testDir, `${suite}.py`);
    fs.writeFileSync(scriptFile, generateHypiumScript(lib, pages), 'utf8');
    fs.writeFileSync(path.join(base, 'config', 'user_config.xml'), userConfig(serial), 'utf8');
    fs.writeFileSync(path.join(base, 'main.py'), mainPy(suite), 'utf8');
    fs.writeFileSync(path.join(base, 'run.bat'), '@echo off\ncd /d %~dp0\npython main.py\npause\n', 'utf8');
    fs.writeFileSync(path.join(base, 'run.sh'), '#!/bin/bash\ncd "$(dirname "$0")"\npython3 main.py\n', 'utf8');
    return { dir: base, suite, scriptFile };
}
