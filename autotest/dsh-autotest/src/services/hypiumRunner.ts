// Hypium 脚本运行器：python main.py <module> 单用例真机执行 + xdevice 结果解析
// 供 执行计划(planExecutor) 与 自动化脚本页单脚本执行(/scripts/run) 共用
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 检测本机 Python 命令（python → python3）。 */
export async function detectPython(): Promise<string | null> {
  for (const cmd of ['python', 'python3']) {
    try {
      await execFileAsync(cmd, ['--version'], { timeout: 8000 });
      return cmd;
    } catch { /* 下一个 */ }
  }
  return null;
}

export interface HypiumRunResult {
  status: 'passed' | 'failed';
  log: string;
  reportDir?: string;
}

/** 运行单个 Hypium 模块并解析结果 XML（result/<module>.xml）。 */
export async function runHypiumModule(
  pythonCmd: string,
  projDir: string,
  moduleStem: string,
  timeoutMs: number,
): Promise<HypiumRunResult> {
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
    const r = await execFileAsync(pythonCmd, ['main.py', moduleStem], { cwd: projDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    stdout = (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
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
  const attr = (k: string): string => new RegExp(`${k}="([^"]*)"`).exec(xml)?.[1] ?? '';
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
