// Hypium 脚本运行器：python main.py <module> 单用例真机执行 + xdevice 结果解析
// 供 执行计划(planExecutor) 与 自动化脚本页单脚本执行(/scripts/run) 共用
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 优先使用「装了 hypium 的解释器」，其次再退回普通 python。 */
export interface PythonProbe {
  /** 命令（可含参数，如 `py -3.10`）以空格分隔 */
  parts: string[];
  /** 展示用命令名 */
  cmd: string;
  version: string;
  hasHypium: boolean;
}

/**
 * 候选解释器（按优先级）：
 *   1. `AUTOTEST_PYTHON`（显式指定，最高优先级，可写 `py -3.10` 这类带参数形式）
 *   2. PATH 上的 python / python3
 *   3. Windows 的 py 启动器（py -3.10 / py -3 / py）
 * 全局安装的 hypium 常常只装在某个具体版本里（本机：python=3.13 没有 hypium，
 * hypium 6.1.0.210 只在 Python310），所以**必须探测 hypium 而不是只看 python 是否存在**。
 */
function pythonCandidates(): string[][] {
  const out: string[][] = [];
  const explicit = (process.env.AUTOTEST_PYTHON || '').trim();
  if (explicit) out.push(explicit.split(/\s+/));
  out.push(['python'], ['python3']);
  if (process.platform === 'win32') out.push(['py', '-3.10'], ['py', '-3'], ['py']);
  return out;
}

/** 探测一个解释器：能否运行、版本、是否装了 hypium。 */
async function probePython(parts: string[]): Promise<PythonProbe | null> {
  const cmd = parts.join(' ');
  try {
    const [head, ...rest] = parts;
    // 同时拿到版本与 hypium 可用性（一次调用，避免多次启动解释器）
    const { stdout } = await execFileAsync(
      head,
      [...rest, '-c', 'import sys;v=sys.version.split()[0]\ntry:\n import hypium\nexcept Exception:\n print(v+"|NO")\nelse:\n print(v+"|OK")'],
      { timeout: 20000 },
    );
    const line = (stdout || '').trim().split(/\r?\n/).pop() || '';
    const [version, flag] = line.split('|');
    if (!version) return null;
    return { parts, cmd, version, hasHypium: flag === 'OK' };
  } catch {
    return null;
  }
}

/** 探测本机可用的解释器清单（按优先级，含 hypium 可用性）。 */
export async function probePythons(): Promise<PythonProbe[]> {
  const seen = new Set<string>();
  const found: PythonProbe[] = [];
  for (const parts of pythonCandidates()) {
    const key = parts.map((p) => p.toLowerCase()).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const p = await probePython(parts);
    if (p) found.push(p);
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
export async function detectPython(): Promise<string | null> {
  const found = await probePythons();
  const ok = found.find((p) => p.hasHypium);
  return ok ? ok.cmd : null;
}

/** 探测结果的**人类可读**说明：用于失败时写清"到底缺什么"，而不是笼统一句"未检测到 Python"。 */
export function describePythonProbe(found: PythonProbe[]): string {
  if (found.length === 0) {
    return '未检测到任何 Python 解释器（试过 python / python3 / py）。Hypium 脚本执行需要 Python + hypium，请安装后重试，或用 AUTOTEST_PYTHON 指定解释器路径。';
  }
  const list = found.map((p) => `${p.cmd}（Python ${p.version}，${p.hasHypium ? '有 hypium' : '无 hypium'}）`).join('；');
  return `检测到 Python 但都没有安装 hypium：${list}。hypium 通常只装在某个具体版本里（例如本机仅有 D:\\Programs\\Python\\Python310）。请在该解释器里 \`pip install hypium\`，或用 AUTOTEST_PYTHON 指向它（如 AUTOTEST_PYTHON="py -3.10"）。`;
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
    // pythonCmd 可能带参数（如 `py -3.10`），必须拆开传，不能整串当可执行文件
    const [head, ...pre] = pythonCmd.split(/\s+/).filter(Boolean);
    const r = await execFileAsync(head, [...pre, 'main.py', moduleStem], { cwd: projDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    stdout = (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    stdout = (err.stdout || '') + (err.stderr || '') + `\n[process] ${err.message ?? ''}`;
  }

  // 定位本次新生成的报告目录（只认本次新增，避免把上一次的结果当成本次 —— 这是最隐蔽的假通过）
  let latest = '';
  if (fs.existsSync(reportsDir)) {
    const fresh = fs.readdirSync(reportsDir).filter((d) => !knownReports.has(d));
    latest = (fresh.length > 0 ? fresh : fs.readdirSync(reportsDir)).sort().pop() ?? '';
  }
  const reportDir = path.join(reportsDir, latest);
  return parseHypiumReport(reportDir, moduleStem, stdout);
}

/** XML 实体的反向解码（报告里的 message 是转义过的，含 &#10; 换行与 &gt; 等）。 */
function decodeXmlText(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 解析 Hypium 运行报告。
 *
 * ⚠️ 真实布局与早期假设不同（实测 xdevice 6.0.7.210）：
 *   真：`reports/<时间戳>/summary_report.xml`（还有 details/、log/、result/）
 *   旧假设：`reports/latest/result/<module>.xml` —— **不存在**，于是所有执行都被报成
 *   "未找到结果报告"，真正的失败原因（比如设备锁屏导致启动失败）被埋在日志里看不见。
 * 这里两种布局都认，并且**把失败原因原文提出来**。
 */
export function parseHypiumReport(reportDir: string, moduleStem: string, stdout: string): HypiumRunResult {
  const attrOf = (xml: string, k: string): string => new RegExp(`${k}="([^"]*)"`).exec(xml)?.[1] ?? '';
  // 1) 找结果文件：summary_report.xml 优先，其次 result/<module>.xml，再退到任意 result/*.xml
  const candidates = [
    path.join(reportDir, 'summary_report.xml'),
    path.join(reportDir, 'result', `${moduleStem}.xml`),
    path.join(reportDir, 'result', 'summary_report.xml'),
  ];
  let resultXml = candidates.find((p) => fs.existsSync(p)) ?? '';
  if (!resultXml) {
    const resultDir = path.join(reportDir, 'result');
    if (fs.existsSync(resultDir)) {
      const any = fs.readdirSync(resultDir).filter((f) => f.endsWith('.xml')).sort()[0];
      if (any) resultXml = path.join(resultDir, any);
    }
  }
  if (!resultXml) {
    return {
      status: 'failed',
      log: `未找到结果报告（目录 ${reportDir}）；可能是 hypium/xdevice 未真正执行，输出尾部：${stdout.slice(-400)}`,
      reportDir,
    };
  }

  const xml = fs.readFileSync(resultXml, 'utf8');
  // 2) 该模块的用例条目（summary_report.xml 里每个模块一条）
  //    必须**精确匹配**：找不到就是"四方一致性"破了，绝不能拿别的模块条目顶替 ——
  //    那等于用别的用例的结果冒充这一条（最隐蔽的假通过之一）。
  const testcases = [...xml.matchAll(/<testcase\b[^>]*>/g)].map((m) => m[0]);
  const mine = testcases.find((t) => attrOf(t, 'classname') === moduleStem || attrOf(t, 'name') === moduleStem) ?? '';
  const message = decodeXmlText(mine ? attrOf(mine, 'message') : attrOf(xml, 'message')).trim();
  const failures = Number(attrOf(xml, 'failures') || 0) + Number(attrOf(xml, 'errors') || 0);
  const tests = attrOf(xml, 'tests') || String(testcases.length || '?');
  const time = mine ? attrOf(mine, 'time') : attrOf(xml, 'time');

  // 3) 模块名对不上：四方一致性破了（文件名 / 类名 / -l 任意一处不一致都会这样）
  if (testcases.length > 0 && !mine) {
    const names = testcases.map((t) => attrOf(t, 'classname') || attrOf(t, 'name')).filter(Boolean);
    return {
      status: 'failed',
      log: `报告里没有模块 ${moduleStem}（报告里是：${names.join(', ') || '无'}）—— 检查文件名 / Python 类名 / -l 参数是否一致（四方一致性）；报告见 ${path.basename(resultXml)}`,
      reportDir,
    };
  }
  // 4) 环境不可用 / 失败 / 通过
  if (attrOf(xml, 'unavailable') === '1') {
    return { status: 'failed', log: `环境不可用：${message || '设备条件不满足'}`, reportDir };
  }
  const moduleResult = mine ? attrOf(mine, 'result') : '';
  if (failures > 0 || moduleResult === 'false') {
    return {
      status: 'failed',
      log: `Hypium 执行失败（failures/errors=${failures}）${message ? `：${message.slice(0, 400)}` : ''}${stdout.length > 0 ? `；输出尾部：${stdout.slice(-200)}` : ''}`,
      reportDir,
    };
  }
  return { status: 'passed', log: `Hypium 通过（${tests} tests, ${time || '0'}s）`, reportDir };
}
