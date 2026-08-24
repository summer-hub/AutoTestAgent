// 真实设备执行引擎（hdc / UI 自动化）：
//  - 设备识别：hdc list targets + shell param get（型号 / 系统版本）
//  - 用例步骤执行：UI 层级定位（HarmonyOS uitest dumpLayout JSON / Android·OpenHarmony uiautomator XML）
//    → 触摸输入（HarmonyOS uinput / Android input）+ aa start + keyevent
//  - 环境无 hdc 或未连接设备时由调用方回退模拟执行
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getSetting } from './settings.js';
import { workspaceDir } from './gitRepo.js';

const execFileAsync = promisify(execFile);
const HDC = process.env.AUTOTEST_HDC || 'hdc';
const DUMP_PATH = '/data/local/tmp/autotest_ui.xml';

type DumpMode = 'harmony' | 'android';
let dumpMode: DumpMode | null = null;

interface HdcOut {
  stdout: string;
  stderr: string;
}

async function runHdc(args: string[], timeoutMs = 15000): Promise<HdcOut> {
  try {
    const { stdout, stderr } = await execFileAsync(HDC, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
      windowsHide: true,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const err = e as { code?: number | string; message?: string };
    throw new Error(`hdc ${args[0] ?? ''} 执行失败：${err.message ?? err.code ?? '未知错误'}`);
  }
}

export async function hdcAvailable(): Promise<boolean> {
  try {
    await runHdc(['version'], 8000);
    return true;
  } catch {
    return false;
  }
}

export async function listTargets(): Promise<string[]> {
  const { stdout } = await runHdc(['list', 'targets']);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '[Empty]');
}

export async function deviceInfo(serial: string): Promise<{ model: string; osVersion: string }> {
  const get = async (key: string): Promise<string> => {
    try {
      const { stdout } = await runHdc(['-t', serial, 'shell', 'param', 'get', key], 10000);
      return stdout.replace(/^\[Fail\].*|FAILED.*$/m, '').trim();
    } catch {
      return '';
    }
  };
  const model = await get('const.product.model');
  const osVersion = await get('const.product.software.version');
  return { model: model || 'HarmonyOS Device', osVersion };
}

export interface RealStep {
  seq: number;
  desc: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  log: string;
}

export interface CaseRun {
  steps: RealStep[];
  logs: string[];
  passed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 应用名 → ability 映射（可选配置 device.appAbilities，JSON：{"时钟":"com.xx/.MainAbility"}） */
function appAbility(keyword: string): string {
  try {
    const raw = String(getSetting('device.appAbilities', '{}') || '{}');
    const map = JSON.parse(raw) as Record<string, string>;
    return map[keyword] || '';
  } catch {
    return '';
  }
}

async function detectDumpMode(serial: string): Promise<DumpMode> {
  if (dumpMode) return dumpMode;
  try {
    await runHdc(['-t', serial, 'shell', 'uitest', 'dumpLayout', '-p', DUMP_PATH], 20000);
    dumpMode = 'harmony';
  } catch {
    dumpMode = 'android';
  }
  return dumpMode;
}

export async function uiDump(serial: string): Promise<string> {
  const mode = await detectDumpMode(serial);
  if (mode === 'harmony') {
    await runHdc(['-t', serial, 'shell', 'uitest', 'dumpLayout', '-p', DUMP_PATH], 20000);
  } else {
    await runHdc(['-t', serial, 'shell', 'uiautomator', 'dump', DUMP_PATH], 20000);
  }
  const { stdout } = await runHdc(['-t', serial, 'shell', 'cat', DUMP_PATH], 20000);
  return stdout;
}

interface UiNode {
  text: string;
  desc: string;
  x: number;
  y: number;
}

export interface DumpMeta {
  bundleName: string;
  pagePath: string;
}

/** 从 dump XML/JSON 解析当前页面归属（bundleName / pagePath），用于过滤非目标应用页面。 */
export function dumpMeta(xml: string): DumpMeta {
  const t = xml.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { attributes?: Record<string, string>; children?: Array<{ attributes?: Record<string, string> }> };
      const root = j.attributes ?? {};
      const first = j.children?.[0]?.attributes ?? {};
      return {
        bundleName: String(root.bundleName ?? first.bundleName ?? ''),
        pagePath: String(first.pagePath ?? root.pagePath ?? ''),
      };
    } catch {
      return { bundleName: '', pagePath: '' };
    }
  }
  return { bundleName: '', pagePath: '' };
}

export function parseNodes(dump: string): UiNode[] {
  const nodes: UiNode[] = [];
  const text = dump.trim();
  // HarmonyOS：uitest dumpLayout 输出 JSON 树
  if (text.startsWith('{')) {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { attributes?: Record<string, unknown>; children?: unknown[] };
      const a = n.attributes ?? {};
      const label = String(a.text ?? '');
      const desc = String(a.description ?? '');
      if (label || desc) {
        const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(a.bounds ?? ''));
        if (m) {
          nodes.push({
            text: label,
            desc,
            x: Math.round((Number(m[1]) + Number(m[3])) / 2),
            y: Math.round((Number(m[2]) + Number(m[4])) / 2),
          });
        }
      }
      for (const child of n.children ?? []) walk(child);
    };
    try {
      walk(JSON.parse(text));
      return nodes;
    } catch {
      return [];
    }
  }
  // Android / OpenHarmony：uiautomator XML
  const re = /<node[^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, text, desc, x1, y1, x2, y2] = m;
    if (!text && !desc) continue;
    nodes.push({
      text,
      desc,
      x: Math.round((Number(x1) + Number(x2)) / 2),
      y: Math.round((Number(y1) + Number(y2)) / 2),
    });
  }
  return nodes;
}

export function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined {
  const k = keyword.toLowerCase();
  return nodes.find((n) => n.text.toLowerCase().includes(k) || n.desc.toLowerCase().includes(k));
}

export function screenSize(xml: string): { w: number; h: number } {
  const m = xml.match(/bounds["=:]*\s*\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return { w: 720, h: 1280 };
  const w = Number(m[3]);
  const h = Number(m[4]);
  return w > 0 && h > 0 ? { w, h } : { w: 720, h: 1280 };
}

export async function tap(serial: string, x: number, y: number): Promise<string> {
  const mode = await detectDumpMode(serial);
  return mode === 'harmony'
    ? execShell(serial, ['uinput', '-T', '-c', String(x), String(y)])
    : execShell(serial, ['input', 'tap', String(x), String(y)]);
}

async function swipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<string> {
  const mode = await detectDumpMode(serial);
  return mode === 'harmony'
    ? execShell(serial, ['uinput', '-T', '-m', String(x1), String(y1), String(x2), String(y2), String(ms)])
    : execShell(serial, ['input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);
}

async function inputText(serial: string, text: string): Promise<string> {
  const mode = await detectDumpMode(serial);
  return mode === 'harmony'
    ? execShell(serial, ['uinput', '-K', '-t', text])
    : execShell(serial, ['input', 'text', text.replace(/\s+/g, '%s')]);
}

async function longPress(serial: string, x: number, y: number): Promise<string> {
  const mode = await detectDumpMode(serial);
  if (mode === 'harmony') {
    await execShell(serial, ['uinput', '-T', '-d', String(x), String(y)]);
    await sleep(900);
    return execShell(serial, ['uinput', '-T', '-u', String(x), String(y)]);
  }
  return execShell(serial, ['input', 'swipe', String(x), String(y), String(x), String(y), '900']);
}

export async function keyBack(serial: string): Promise<string> {
  const mode = await detectDumpMode(serial);
  if (mode === 'harmony') {
    // HarmonyOS 返回手势：屏幕左缘向右滑（uinput keycode 在此设备上无效）
    return execShell(serial, ['uinput', '-T', '-m', '30', '1350', '420', '1350', '300']);
  }
  return execShell(serial, ['input', 'keyevent', '4']);
}

/** 失败诊断截图：设备截图 → recv 到本地 workspace/screenshots。 */
async function captureScreen(serial: string, localPath: string): Promise<string> {
  const mode = await detectDumpMode(serial);
  // HarmonyOS snapshot_display 只接受 .jpeg 后缀；Android screencap 输出 png
  const remote = mode === 'harmony'
    ? '/data/local/tmp/autotest_screen.jpeg'
    : '/data/local/tmp/autotest_screen.png';
  const ext = mode === 'harmony' ? '.jpeg' : '.png';
  try {
    if (mode === 'harmony') {
      await runHdc(['-t', serial, 'shell', 'snapshot_display', '-f', remote], 15000);
    } else {
      await runHdc(['-t', serial, 'shell', 'screencap', '-p', remote], 15000);
    }
    const recvPath = localPath.replace(/\.png$/, ext);
    await runHdc(['-t', serial, 'file', 'recv', remote, recvPath], 20000);
    return fs.existsSync(recvPath) ? recvPath : `截图文件未生成：${recvPath}`;
  } catch (e) {
    return `截图失败：${(e as Error).message}`;
  }
}

/** 验证 hilog 日志中出现关键字（用例预期结果里写明应打印的日志）。 */
async function verifyHilog(serial: string, keyword: string): Promise<{ ok: boolean; log: string }> {
  try {
    const { stdout } = await runHdc(['-t', serial, 'shell', 'hilog', '-x'], 20000);
    const hit = stdout.split(/\r?\n/).find((l) => l.toLowerCase().includes(keyword.toLowerCase()));
    return hit
      ? { ok: true, log: `hilog 匹配「${keyword}」：${hit.slice(0, 140)}` }
      : { ok: false, log: `hilog 中未出现「${keyword}」（已检查最近日志）` };
  } catch (e) {
    return { ok: false, log: `hilog 抓取失败：${(e as Error).message}` };
  }
}

function pickKeyword(desc: string): string {
  return desc
    .replace(/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|长按|勾选|取消|删除|验证|检查|断言|校验)[:：\s]*/, '')
    .replace(/[，。！？、,.!?；;]$/, '')
    .replace(/^(?:按钮|选项|列表项|弹窗|输入框|下拉菜单|返回按钮|开关)/, '')
    .slice(0, 12)
    .trim();
}

export async function execShell(serial: string, shellArgs: string[]): Promise<string> {
  const { stdout, stderr } = await runHdc(['-t', serial, 'shell', ...shellArgs], 15000);
  return (stdout + '\n' + stderr).trim() || 'ok';
}

/** aa start 参数：支持 bundle/ability、bundle、ability 三种写法。 */
export function launchArgs(launch: string): string[] {
  const s = launch.trim();
  if (s.includes('/')) {
    const [b, a] = s.split('/');
    return ['aa', 'start', '-b', b.trim(), '-a', a.trim()];
  }
  if (s.includes('.')) return ['aa', 'start', '-b', s];
  return ['aa', 'start', '-a', s];
}

async function runStep(serial: string, desc: string): Promise<{ ok: boolean; log: string; durationMs: number }> {
  const t0 = Date.now();
  const fail = (log: string) => ({ ok: false, log, durationMs: Date.now() - t0 });
  const pass = (log: string) => ({ ok: true, log, durationMs: Date.now() - t0 });
  const d = desc.trim();

  try {
    const mMin = d.match(/等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*分钟/);
    const mSec = d.match(/等待\s*(?:约)?\s*(\d+(?:\.\d+)?)\s*秒/);
    if (mMin) {
      const s = Math.min(parseFloat(mMin[1]) * 60, 120);
      await sleep(s * 1000);
      return pass(`等待 ${s}s（${mMin[1]} 分钟）`);
    }
    if (mSec) {
      const s = Math.min(parseFloat(mSec[1]), 120);
      await sleep(s * 1000);
      return pass(`等待 ${s}s`);
    }
    if (/等待/.test(d)) {
      await sleep(3000);
      return pass('等待 3s（通用等待）');
    }
    if (/^(返回|退出|回退)/.test(d)) {
      const out = await keyBack(serial);
      return pass(`keyevent BACK：${out}`);
    }
    if (/^(输入|键入|填写)/.test(d)) {
      const text = d.replace(/^(输入|键入|填写)[:：\s]*/, '').replace(/[「」“”"'，,。.]/g, ' ').trim();
      if (!text) return fail(`无法解析输入内容：${d}`);
      const out = await inputText(serial, text);
      return pass(`input text「${text}」：${out}`);
    }
    if (/滑/.test(d)) {
      const xml = await uiDump(serial);
      const { w, h } = screenSize(xml);
      const cx = Math.round(w / 2);
      const cy = Math.round(h / 2);
      const dy = Math.round(h * 0.6);
      const dx = Math.round(w * 0.5);
      let tx = cx;
      let ty = cy;
      if (/向上|上滑|上拉/.test(d)) ty = Math.max(0, cy - dy);
      else if (/向下|下滑|下拉/.test(d)) ty = Math.min(h, cy + dy);
      else if (/向左|左滑/.test(d)) tx = Math.max(0, cx - dx);
      else if (/向右|右滑/.test(d)) tx = Math.min(w, cx + dx);
      else return fail(`无法解析滑动方向：${d}`);
      const out = await swipe(serial, cx, cy, tx, ty, 400);
      return pass(`swipe（${w}x${h} 屏幕）：${out}`);
    }
    if (/长按/.test(d)) {
      const kw = pickKeyword(d);
      const xml = await uiDump(serial);
      const node = findKeyword(parseNodes(xml), kw);
      if (!node) return fail(`界面未找到「${kw}」`);
      await longPress(serial, node.x, node.y);
      return pass(`长按「${kw}」@(${node.x},${node.y})`);
    }
    if (/^(验证|检查|断言|校验)/.test(d)) {
      // 验证日志包含 xxx —— 用 hilog 匹配（预期结果里写明日志时）
      const logMatch = d.match(/日志[^，。]*?(?:包含|出现|打印|输出)\s*[:：]?\s*(.+)/);
      if (logMatch) {
        const kw = logMatch[1].replace(/[「」“”"'，,。.]/g, ' ').trim();
        if (kw) {
          const r = await verifyHilog(serial, kw);
          return r.ok ? pass(r.log) : fail(r.log);
        }
      }
      const kw = pickKeyword(d);
      const xml = await uiDump(serial);
      const node = findKeyword(parseNodes(xml), kw);
      return node ? pass(`验证通过：界面存在「${kw}」`) : fail(`验证失败：界面未出现「${kw}」`);
    }
    if (/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|勾选|取消|删除)/.test(d)) {
      const kw = pickKeyword(d);
      const xml = await uiDump(serial);
      const node = findKeyword(parseNodes(xml), kw);
      if (node) {
        await tap(serial, node.x, node.y);
        return pass(`已点击「${kw}」@(${node.x},${node.y})`);
      }
      if (/^(打开|启动)/.test(d)) {
        const ability = appAbility(kw);
        if (ability) {
          const out = await execShell(serial, launchArgs(ability));
          return pass(`aa start ${ability}：${out}`);
        }
        try {
          const out = await execShell(serial, launchArgs(kw));
          return pass(`aa start ${kw}：${out}`);
        } catch (e) {
          return fail(`界面未找到「${kw}」且 aa start 失败：${(e as Error).message}`);
        }
      }
      return fail(`界面未找到「${kw}」`);
    }
    const kw = pickKeyword(d);
    const xml = await uiDump(serial);
    const node = findKeyword(parseNodes(xml), kw);
    if (!node) return fail(`无法识别的步骤，且界面未找到「${kw}」：${d}`);
    await tap(serial, node.x, node.y);
    return pass(`已执行「${kw}」@(${node.x},${node.y})`);
  } catch (e) {
    return fail(`执行异常：${(e as Error).message}`);
  }
}

async function runStepWithTimeout(serial: string, desc: string, timeoutMs: number): Promise<{ ok: boolean; log: string; durationMs: number }> {
  return Promise.race([
    runStep(serial, desc),
    sleep(timeoutMs).then(() => ({ ok: false, log: `步骤超时（>${Math.round(timeoutMs / 1000)}s）`, durationMs: timeoutMs })),
  ]);
}

/** 在真实设备上按顺序执行用例步骤（hdc / uiautomator / input）。 */
export async function executeCaseSteps(
  steps: string[],
  serial: string,
  opts: {
    perStepTimeoutMs?: number;
    launch?: string;              // 执行前先 aa start 的应用（bundle 或 ability）
    screenshotDir?: string;       // 失败步骤截图保存目录（默认 workspace/screenshots）
  } = {},
): Promise<CaseRun> {
  const perStep = opts.perStepTimeoutMs ?? 30000;
  const logs: string[] = [`[hdc] 设备 ${serial} · 真实执行开始（${steps.length} 步）`];
  const results: RealStep[] = [];
  let passed = true;
  const shotDir = opts.screenshotDir || path.join(workspaceDir(), 'screenshots');
  // 执行前拉起应用（可选）
  if (opts.launch) {
    logs.push(`[hdc] 启动应用：${opts.launch}`);
    try {
      const out = await execShell(serial, ['aa', 'start', '-a', opts.launch]);
      logs.push(`[hdc] aa start -a ${opts.launch}：${out}`);
      await sleep(2000);
    } catch (e) {
      logs.push(`[hdc] 启动应用失败（继续执行步骤）：${(e as Error).message}`);
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const desc = steps[i] ?? `步骤 ${i + 1}`;
    const r = await runStepWithTimeout(serial, desc, perStep);
    results.push({ seq: i + 1, desc, status: r.ok ? 'passed' : 'failed', durationMs: r.durationMs, log: r.log });
    logs.push(`[${String(i + 1).padStart(2, '0')}] ${desc} → ${r.ok ? '通过' : '失败'}：${r.log}`);
    if (!r.ok) {
      // 失败诊断截图（不影响主流程）
      try {
        fs.mkdirSync(shotDir, { recursive: true });
        const shot = await captureScreen(serial, path.join(shotDir, `${Date.now()}_step${String(i + 1).padStart(2, '0')}.png`));
        logs.push(`[截图] ${shot}`);
      } catch { /* 截图失败不阻断 */ }
      passed = false;
    }
  }
  logs.push(`[hdc] 执行结束：${passed ? '全部通过' : '存在失败步骤'}`);
  return { steps: results, logs, passed };
}
