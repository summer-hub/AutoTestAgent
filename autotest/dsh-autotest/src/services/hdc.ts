// 真实设备执行引擎（hdc / UI 自动化）：
//  - 设备识别：hdc list targets + shell param get（型号 / 系统版本）
//  - 用例步骤执行：uiautomator dump 定位控件 → input tap / swipe / text + aa start + keyevent
//  - 环境无 hdc 或未连接设备时由调用方回退模拟执行
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting } from './settings.js';

const execFileAsync = promisify(execFile);
const HDC = process.env.AUTOTEST_HDC || 'hdc';

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

async function uiDump(serial: string): Promise<string> {
  await runHdc(['-t', serial, 'shell', 'uiautomator', 'dump', '/data/local/tmp/autotest_ui.xml'], 20000);
  const { stdout } = await runHdc(['-t', serial, 'shell', 'cat', '/data/local/tmp/autotest_ui.xml'], 20000);
  return stdout;
}

interface UiNode {
  text: string;
  desc: string;
  x: number;
  y: number;
}

function parseNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const re = /<node[^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
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

function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined {
  const k = keyword.toLowerCase();
  return nodes.find((n) => n.text.toLowerCase().includes(k) || n.desc.toLowerCase().includes(k));
}

function screenSize(xml: string): { w: number; h: number } {
  const m = xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!m) return { w: 720, h: 1280 };
  const w = Number(m[3]);
  const h = Number(m[4]);
  return w > 0 && h > 0 ? { w, h } : { w: 720, h: 1280 };
}

function pickKeyword(desc: string): string {
  return desc
    .replace(/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|长按|勾选|取消|删除|验证|检查|断言|校验)[:：\s]*/, '')
    .replace(/[，。！？、,.!?；;]$/, '')
    .replace(/^(?:按钮|选项|列表项|弹窗|输入框|下拉菜单|返回按钮|开关)/, '')
    .slice(0, 12)
    .trim();
}

async function execShell(serial: string, shellArgs: string[]): Promise<string> {
  const { stdout, stderr } = await runHdc(['-t', serial, 'shell', ...shellArgs], 15000);
  return (stdout + '\n' + stderr).trim() || 'ok';
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
      const out = await execShell(serial, ['input', 'keyevent', '4']);
      return pass(`keyevent BACK：${out}`);
    }
    if (/^(输入|键入|填写)/.test(d)) {
      const text = d.replace(/^(输入|键入|填写)[:：\s]*/, '').replace(/[「」“”"'，,。.]/g, ' ').trim();
      if (!text) return fail(`无法解析输入内容：${d}`);
      const out = await execShell(serial, ['input', 'text', text.replace(/\s+/g, '%s')]);
      return pass(`input text「${text}」：${out}`);
    }
    if (/滑/.test(d)) {
      const xml = await uiDump(serial);
      const { w, h } = screenSize(xml);
      const cx = Math.round(w / 2);
      const cy = Math.round(h / 2);
      const dy = Math.round(h * 0.6);
      const dx = Math.round(w * 0.5);
      let args: string[] | null = null;
      if (/向上|上滑|上拉/.test(d)) args = ['input', 'swipe', String(cx), String(cy), String(cx), String(cy - dy), '400'];
      if (/向下|下滑|下拉/.test(d)) args = ['input', 'swipe', String(cx), String(cy), String(cx), String(cy + dy), '400'];
      if (/向左|左滑/.test(d)) args = ['input', 'swipe', String(cx), String(cy), String(cx - dx), String(cy), '400'];
      if (/向右|右滑/.test(d)) args = ['input', 'swipe', String(cx), String(cy), String(cx + dx), String(cy), '400'];
      if (!args) return fail(`无法解析滑动方向：${d}`);
      const out = await execShell(serial, args);
      return pass(`swipe（${w}x${h} 屏幕）：${out}`);
    }
    if (/长按/.test(d)) {
      const kw = pickKeyword(d);
      const xml = await uiDump(serial);
      const node = findKeyword(parseNodes(xml), kw);
      if (!node) return fail(`界面未找到「${kw}」`);
      await execShell(serial, ['input', 'swipe', String(node.x), String(node.y), String(node.x), String(node.y), '900']);
      return pass(`长按「${kw}」@(${node.x},${node.y})`);
    }
    if (/^(验证|检查|断言|校验)/.test(d)) {
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
        await execShell(serial, ['input', 'tap', String(node.x), String(node.y)]);
        return pass(`已点击「${kw}」@(${node.x},${node.y})`);
      }
      if (/^(打开|启动)/.test(d)) {
        const ability = appAbility(kw);
        if (ability) {
          const out = await execShell(serial, ['aa', 'start', '-a', ability]);
          return pass(`aa start -a ${ability}：${out}`);
        }
        try {
          const out = await execShell(serial, ['aa', 'start', '-a', kw]);
          return pass(`aa start -a ${kw}：${out}`);
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
    await execShell(serial, ['input', 'tap', String(node.x), String(node.y)]);
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
  opts: { perStepTimeoutMs?: number } = {},
): Promise<CaseRun> {
  const perStep = opts.perStepTimeoutMs ?? 30000;
  const logs: string[] = [`[hdc] 设备 ${serial} · 真实执行开始（${steps.length} 步）`];
  const results: RealStep[] = [];
  let passed = true;
  for (let i = 0; i < steps.length; i++) {
    const desc = steps[i] ?? `步骤 ${i + 1}`;
    const r = await runStepWithTimeout(serial, desc, perStep);
    results.push({ seq: i + 1, desc, status: r.ok ? 'passed' : 'failed', durationMs: r.durationMs, log: r.log });
    logs.push(`[${String(i + 1).padStart(2, '0')}] ${desc} → ${r.ok ? '通过' : '失败'}：${r.log}`);
    if (!r.ok) passed = false;
  }
  logs.push(`[hdc] 执行结束：${passed ? '全部通过' : '存在失败步骤'}`);
  return { steps: results, logs, passed };
}
