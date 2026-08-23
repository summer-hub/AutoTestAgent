// 绑定脚本执行链路：把 AI 生成的 hypium 风格 TS 脚本解析为设备可执行的步骤，
// 交由 hdc 执行引擎逐条执行（真实设备）；无脚本或解析不出步骤时回退用例步骤。
import fs from 'node:fs';
import path from 'node:path';
import { scriptsDirFor } from './gitRepo.js';
/** 从 hypium 风格脚本中抽取可执行步骤（best-effort，映射到 hdc 步骤原语）。 */
export function parseScriptSteps(script) {
    const steps = [];
    for (const raw of script.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))
            continue;
        if (/\.click\(\s*\)|\.tap\(\s*\)/.test(line)) {
            const text = line.match(/(?:by\.text|by\.id|text|Text)\(\s*['"]([^'"]+)['"]\s*\)/) ?? line.match(/['"]([^'"]+)['"]/);
            if (text) {
                steps.push(`点击 ${text[1]}`);
                continue;
            }
        }
        if (/inputText|input_text|sendKeys|\.input\(/.test(line)) {
            const input = line.match(/\(\s*['"]([^'"]+)['"]\s*\)/);
            if (input) {
                steps.push(`输入 ${input[1]}`);
                continue;
            }
        }
        if (/\.swipe\(|\.drag\(|swipe\s*\(/.test(line)) {
            steps.push('滑动');
            continue;
        }
        if (/(?:delay|sleep|wait|setTimeout)\(\s*(\d+)/i.test(line)) {
            const ms = Number(line.match(/(?:delay|sleep|wait|setTimeout)\(\s*(\d+)/i)?.[1] ?? 0);
            steps.push(`等待 ${Math.max(1, Math.round(ms / 1000))} 秒`);
            continue;
        }
        if (/expect\(|assert|isExist\(|isDisplayed\(|assertEqual|assertTrue/.test(line)) {
            const target = line.match(/['"]([^'"]+)['"]/);
            steps.push(target ? `验证 ${target[1]}` : '验证界面状态');
            continue;
        }
        if (/startAbility|openApp|launchApp|startApp/.test(line)) {
            const target = line.match(/['"]([^'"]+)['"]/);
            steps.push(target ? `打开 ${target[1]}` : '打开应用');
            continue;
        }
    }
    return steps.slice(0, 30);
}
/** 读取用例绑定的脚本文件（不存在或读取失败返回 null）。 */
export function readBoundScript(libName, caseNo) {
    const file = path.join(scriptsDirFor(libName), `${caseNo}.ts`);
    if (!fs.existsSync(file))
        return null;
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
