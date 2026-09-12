// Hypium 脚本运行器：python main.py <module> 单用例真机执行 + xdevice 结果解析
// 供 执行计划(planExecutor) 与 自动化脚本页单脚本执行(/scripts/run) 共用
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/**
 * 候选解释器（按优先级）：
 *   1. `AUTOTEST_PYTHON`（显式指定，最高优先级，可写 `py -3.10` 这类带参数形式）
 *   2. PATH 上的 python / python3
 *   3. Windows 的 py 启动器（py -3.10 / py -3 / py）
 * 全局安装的 hypium 常常只装在某个具体版本里（本机：python=3.13 没有 hypium，
 * hypium 6.1.0.210 只在 Python310），所以**必须探测 hypium 而不是只看 python 是否存在**。
 */
function pythonCandidates() {
    const out = [];
    const explicit = (process.env.AUTOTEST_PYTHON || '').trim();
    if (explicit)
        out.push(explicit.split(/\s+/));
    out.push(['python'], ['python3']);
    if (process.platform === 'win32')
        out.push(['py', '-3.10'], ['py', '-3'], ['py']);
    return out;
}
/** 探测一个解释器：能否运行、版本、是否装了 hypium。 */
async function probePython(parts) {
    const cmd = parts.join(' ');
    try {
        const [head, ...rest] = parts;
        // 同时拿到版本与 hypium 可用性（一次调用，避免多次启动解释器）
        const { stdout } = await execFileAsync(head, [...rest, '-c', 'import sys;v=sys.version.split()[0]\ntry:\n import hypium\nexcept Exception:\n print(v+"|NO")\nelse:\n print(v+"|OK")'], { timeout: 20000 });
        const line = (stdout || '').trim().split(/\r?\n/).pop() || '';
        const [version, flag] = line.split('|');
        if (!version)
            return null;
        return { parts, cmd, version, hasHypium: flag === 'OK' };
    }
    catch {
        return null;
    }
}
/** 探测本机可用的解释器清单（按优先级，含 hypium 可用性）。 */
export async function probePythons() {
    const seen = new Set();
    const found = [];
    for (const parts of pythonCandidates()) {
        const key = parts.map((p) => p.toLowerCase()).join(' ');
        if (seen.has(key))
            continue;
        seen.add(key);
        const p = await probePython(parts);
        if (p)
            found.push(p);
    }
    return found;
}
/**
 * 检测可用于执行 Hypium 脚本的 Python 命令。
 *
 * **优先返回装了 hypium 的解释器**；若一个都没有，则返回 null（调用方据此如实失败）。
 * 不返回"能跑但没有 hypium"的解释器——那只会让脚本跑到 `import hypium` 才炸，
 * 报错信息还指向脚本而不是环境（用户看到的是 ModuleNotFoundError，难以定位）。
 */
export async function detectPython() {
    const found = await probePythons();
    const ok = found.find((p) => p.hasHypium);
    return ok ? ok.cmd : null;
}
/** 探测结果的**人类可读**说明：用于失败时写清"到底缺什么"，而不是笼统一句"未检测到 Python"。 */
export function describePythonProbe(found) {
    if (found.length === 0) {
        return '未检测到任何 Python 解释器（试过 python / python3 / py）。Hypium 脚本执行需要 Python + hypium，请安装后重试，或用 AUTOTEST_PYTHON 指定解释器路径。';
    }
    const list = found.map((p) => `${p.cmd}（Python ${p.version}，${p.hasHypium ? '有 hypium' : '无 hypium'}）`).join('；');
    return `检测到 Python 但都没有安装 hypium：${list}。hypium 通常只装在某个具体版本里（例如本机仅有 D:\\Programs\\Python\\Python310）。请在该解释器里 \`pip install hypium\`，或用 AUTOTEST_PYTHON 指向它（如 AUTOTEST_PYTHON="py -3.10"）。`;
}
/** 运行单个 Hypium 模块并解析结果 XML（result/<module>.xml）。 */
export async function runHypiumModule(pythonCmd, projDir, moduleStem, timeoutMs) {
    const mainFile = path.join(projDir, 'main.py');
    let src = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
    if (!src.includes('sys.argv')) {
        fs.writeFileSync(mainFile, [
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
        ].join('\n'), 'utf8');
    }
    const reportsDir = path.join(projDir, 'reports');
    const knownReports = new Set(fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : []);
    let stdout = '';
    try {
        // pythonCmd 可能带参数（如 `py -3.10`），必须拆开传，不能整串当可执行文件
        const [head, ...pre] = pythonCmd.split(/\s+/).filter(Boolean);
        const r = await execFileAsync(head, [...pre, 'main.py', moduleStem], { cwd: projDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        stdout = (r.stdout || '') + (r.stderr || '');
    }
    catch (e) {
        const err = e;
        stdout = (err.stdout || '') + (err.stderr || '') + `\n[process] ${err.message ?? ''}`;
    }
    // 定位本次新生成的报告目录
    let latest = '';
    if (fs.existsSync(reportsDir)) {
        const fresh = fs.readdirSync(reportsDir).filter((d) => !knownReports.has(d));
        latest = (fresh.length > 0 ? fresh : fs.readdirSync(reportsDir)).sort().pop() ?? '';
    }
    const resultXml = path.join(reportsDir, latest, 'result', `${moduleStem}.xml`);
    if (!fs.existsSync(resultXml)) {
        return { status: 'failed', log: `未找到结果报告 ${path.relative(projDir, resultXml)}；输出尾部：${stdout.slice(-400)}` };
    }
    const xml = fs.readFileSync(resultXml, 'utf8');
    const attr = (k) => new RegExp(`${k}="([^"]*)"`).exec(xml)?.[1] ?? '';
    const failures = Number(attr('failures') || 0) + Number(attr('errors') || 0);
    const unavailable = attr('unavailable') === '1';
    const message = (attr('message') || '').replace(/&#\d+;/g, '').slice(0, 200);
    if (unavailable) {
        return { status: 'failed', log: `环境不可用：${message || '设备条件不满足'}`, reportDir: path.join(reportsDir, latest) };
    }
    if (failures > 0) {
        return { status: 'failed', log: `Hypium 执行失败（failures/errors=${failures}）${message ? `：${message}` : ''}；输出尾部：${stdout.slice(-300)}`, reportDir: path.join(reportsDir, latest) };
    }
    return {
        status: 'passed',
        log: `Hypium 通过（${attr('tests') || '?'} tests, ${attr('time') || '0'}s）`,
        reportDir: path.join(reportsDir, latest),
    };
}
