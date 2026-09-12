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

export interface NodeBounds {
  x1: number; y1: number; x2: number; y2: number;
}

/**
 * UI 节点。
 * HarmonyOS 的 `uitest dumpLayout` 原生就带全套交互标志（clickable / longClickable /
 * scrollable / checkable / checked / enabled / selected / visible）与稳定标识（id / key /
 * accessibilityId / hierarchy）。旧版只读 text/description/bounds/type，把这些全丢了，
 * 直接导致「图标按钮整类丢失」与「靠文本猜可点击性」。这里全部保留。
 */
export interface UiNode {
  /** 稳定标识：HarmonyOS 取 id > key > accessibilityId（常为空，用 fallbackKey 兜底） */
  id: string;
  /** 运行时 key（同一 id 的多个实例靠它区分） */
  key: string;
  text: string;
  desc: string;
  hint: string;
  x: number;
  y: number;
  /** 控件类型（HarmonyOS: Text/Button/Scroll/Row…；Android: class 名） */
  type?: string;
  /** 节点归属窗口的 bundleName（用于过滤系统状态栏/桌面） */
  bundle?: string;
  /** 完整 bounds（左上/右下），用于越界检测与可视化 */
  bounds?: NodeBounds;
  /** 节点所属页面路由（dumpLayout 的 pagePath） */
  pagePath: string;
  /** 窗口 ID（多窗口/弹窗场景用于区分） */
  windowId: string;
  /** 层级路径（dumpLayout 的 hierarchy），用于结构指纹 */
  hierarchy: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  enabled: boolean;
  visible: boolean;
}

/** dumpLayout 的布尔字段是字符串 "true"/"false"，也可能是空串（根节点）或真布尔。 */
function toBool(v: unknown, fallback = false): boolean {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return fallback;
}

/** 解析 bounds："[0,124][1260,2720]" → {x1,y1,x2,y2}；非法返回 null。 */
export function parseBounds(raw: unknown): NodeBounds | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(raw ?? ''));
  if (!m) return null;
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) };
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

export interface ParseNodesOpts {
  /** 命中这些 bundleName 的窗口子树整体跳过（状态栏时钟/网速/电量等系统控件） */
  skipBundles?: ReadonlySet<string>;
}

export interface ParsedDump {
  nodes: UiNode[];
  /** 是否成功解析（false = 格式不认识/解析失败，调用方必须与"空页面"区分开） */
  parsed: boolean;
  /** 解析失败原因（供告警与覆盖率报告） */
  reason?: string;
  /** 识别到的格式 */
  format: 'harmony-json' | 'android-xml' | 'unknown';
}

/**
 * 解析 UI dump（HarmonyOS dumpLayout JSON 或 Android uiautomator XML）。
 * 与旧版的区别：
 *  - 不再要求「有文本」——无文本但可交互的节点（图标按钮）同样返回；
 *  - 保留全部交互标志与稳定标识；
 *  - 解析失败**显式回报**，不再静默返回空数组（旧版无法区分"空页面"与"解析失败"）。
 */
export function parseDump(dump: string, opts?: ParseNodesOpts): ParsedDump {
  const raw = String(dump ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { nodes: [], parsed: false, reason: 'dump 内容为空', format: 'unknown' };

  // ---------- HarmonyOS：uitest dumpLayout JSON 树 ----------
  if (raw.startsWith('{')) {
    const nodes: UiNode[] = [];
    const skip = opts?.skipBundles;
    const walk = (node: unknown, parentBundle: string, parentPage: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { attributes?: Record<string, unknown>; children?: unknown[] };
      const a = n.attributes ?? {};
      const curBundle = String(a.bundleName ?? '').trim() || parentBundle;
      const curPage = String(a.pagePath ?? '').trim() || parentPage;
      // 系统窗口（桌面/状态栏/场景板）→ 整棵子树丢弃
      if (skip && curBundle && skip.has(curBundle)) return;
      const bounds = parseBounds(a.bounds);
      if (bounds) {
        const text = String(a.text ?? '');
        const desc = String(a.description ?? '');
        nodes.push({
          id: String(a.id ?? '').trim(),
          key: String(a.key ?? '').trim(),
          text,
          desc,
          hint: String(a.hint ?? '').trim(),
          x: Math.round((bounds.x1 + bounds.x2) / 2),
          y: Math.round((bounds.y1 + bounds.y2) / 2),
          type: String(a.type ?? '').trim() || undefined,
          bundle: curBundle || undefined,
          bounds,
          pagePath: curPage,
          windowId: String(a.hostWindowId ?? '').trim(),
          hierarchy: String(a.hierarchy ?? '').trim(),
          clickable: toBool(a.clickable),
          longClickable: toBool(a.longClickable),
          scrollable: toBool(a.scrollable),
          checkable: toBool(a.checkable),
          checked: toBool(a.checked),
          selected: toBool(a.selected),
          enabled: toBool(a.enabled, true),          // 缺省视为可用（根节点不带该字段）
          visible: toBool(a.visible, true),
        });
      }
      for (const child of n.children ?? []) walk(child, curBundle, curPage);
    };
    try {
      walk(JSON.parse(raw), '', '');
      if (nodes.length === 0) return { nodes, parsed: false, reason: 'JSON 解析成功但没有任何带 bounds 的节点', format: 'harmony-json' };
      return { nodes, parsed: true, format: 'harmony-json' };
    } catch (e) {
      return { nodes: [], parsed: false, reason: `JSON 解析失败：${(e as Error).message}`, format: 'harmony-json' };
    }
  }

  // ---------- Android / OpenHarmony：uiautomator XML ----------
  // 逐属性提取，不依赖属性出现顺序（旧版正则强制 text→content-desc→bounds→class 的固定词序，
  // 标准 dump 的 class 在 bounds 之前，导致恒 0 命中）。
  if (raw.startsWith('<')) {
    const nodes: UiNode[] = [];
    const nodeRe = /<node\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(raw))) {
      const attrs: Record<string, string> = {};
      for (const am of m[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[am[1]] = am[2];
      const bounds = parseBounds(attrs.bounds);
      if (!bounds) continue;
      const cls = attrs.class ?? '';
      const clickable = toBool(attrs.clickable);
      const longClickable = toBool(attrs['long-clickable']);
      const scrollable = toBool(attrs.scrollable);
      const checkable = toBool(attrs['checkable']);
      nodes.push({
        id: (attrs['resource-id'] ?? '').trim(),
        key: '',
        text: attrs.text ?? '',
        desc: attrs['content-desc'] ?? '',
        hint: '',
        x: Math.round((bounds.x1 + bounds.x2) / 2),
        y: Math.round((bounds.y1 + bounds.y2) / 2),
        type: cls || undefined,
        bounds,
        pagePath: '',
        windowId: '',
        hierarchy: cls,
        clickable,
        longClickable,
        scrollable,
        checkable,
        checked: toBool(attrs.checked),
        selected: toBool(attrs.selected),
        enabled: toBool(attrs.enabled, true),
        visible: attrs.visible === undefined ? true : toBool(attrs.visible, true),
      });
    }
    if (nodes.length === 0) return { nodes, parsed: false, reason: 'XML 中未解析出任何带 bounds 的 node', format: 'android-xml' };
    return { nodes, parsed: true, format: 'android-xml' };
  }

  return { nodes: [], parsed: false, reason: `无法识别的 dump 格式（首字符 ${JSON.stringify(raw.slice(0, 1))}）`, format: 'unknown' };
}

/**
 * 兼容旧签名：只取节点数组。
 * ⚠️ 需要区分"解析失败"与"空页面"时请直接用 `parseDump()`。
 */
export function parseNodes(dump: string, opts?: ParseNodesOpts): UiNode[] {
  return parseDump(dump, opts).nodes;
}

export function findKeyword(nodes: UiNode[], keyword: string): UiNode | undefined {
  const k = keyword.toLowerCase().trim();
  // 空关键词必须直接返回：否则 `includes('')` 恒为真，会把第一个节点当成命中
  // （历史缺陷：「点击「、」」这类步骤被标点清洗成空串后，点到的是页面第一个控件）
  if (!k) return undefined;
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

export async function inputText(serial: string, text: string): Promise<string> {
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

/**
 * 抓取设备最近 N 行 hilog（失败诊断用）。
 * dry-run 的日志类断言失败时，模型需要看到「设备日志里实际有什么」才能判断是断言写错
 * 还是功能真没生效——只给一句「未匹配到」等于没给证据。
 */
export async function tailHilog(serial: string, lines = 12): Promise<string[]> {
  try {
    const { stdout } = await runHdc(['-t', serial, 'shell', 'hilog', '-x'], 20000);
    const all = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return all.slice(-Math.max(1, Math.min(60, lines)));
  } catch {
    return [];
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
  // 必须剥离「」引号：生成端 STEP_CONTRACT 要求步骤写成「点击「X」」，而界面文本本身不带引号，
  // 不剥离会让关键词变成「「X」」，导致所有点击/验证步骤恒失败（dry-run 全军覆没）。
  return desc
    .replace(/^(点击|单击|选择|选中|确认|打开|启动|切换|滚动|长按|勾选|取消|删除|验证|检查|断言|校验)[:：\s]*/, '')
    .replace(/[「」“"'，,。.！!？?；;、]/g, ' ')
    .replace(/^(?:按钮|选项|列表项|弹窗|输入框|下拉菜单|返回按钮|开关)/, '')
    .replace(/\s+/g, ' ')
    .trim()
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

/** 归一化库名用于模糊匹配：'json-schema' → 'jsonschema'。 */
function fuzzyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 从 `bm dump -n <bundle>` 输出里解析入口 Ability。
 * 真机实测（ALN-AL00）：该输出**没有** mainElementName 字段，只有 abilities 数组，
 * 里面第一个 "name" 就是入口 Ability（如 EntryAbility）。优先 mainElementName 以兼容有该字段的版本。
 */
export function parseMainAbility(dump: string): string {
  const direct = /"mainElementName"\s*:\s*"([^"]+)"/.exec(dump)?.[1];
  if (direct) return direct;
  const block = /"abilities"\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(dump)?.[1] ?? '';
  const names = [...block.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return names.find((n) => /^entry/i.test(n)) ?? names[0] ?? '';
}

/**
 * 查入口 Ability。**必须显式带 -a 启动**：真机上 `aa start -b <bundle>`（隐式启动）
 * 对很多 demo 直接返回 10103101「Failed to find a matching application for implicit launch」，
 * 应用根本没起来 —— 遍历却会照常跑完并给出一份看着正常的报告（真机上正是这么骗过验收的）。
 */
export async function resolveMainAbility(serial: string, bundle: string): Promise<string> {
  try {
    return parseMainAbility(await execShell(serial, ['bm', 'dump', '-n', bundle]));
  } catch {
    return '';
  }
}

/** 系统/预置包名前缀：不参与"库 → 应用"的模糊匹配。 */
const SYSTEM_BUNDLE_PREFIXES = ['com.ohos.', 'com.huawei.systemui', 'com.android.', 'com.huawei.hmos.settings'];

/** 是否是系统/桌面类包（这类 bundle 出现了就说明被测应用没在前台）。 */
export function isSystemBundle(bundle: string): boolean {
  const b = bundle.toLowerCase();
  return b === 'com.ohos.sceneboard' || SYSTEM_BUNDLE_PREFIXES.some((p) => b.startsWith(p));
}

/**
 * 按库名在设备已安装应用里模糊匹配候选 bundleName，并回填入口 Ability。
 * 用途：库没拉过仓库时 package_name 为空，真机遍历 `aa start` 会失败 → 这里帮人自动认出来。
 * 两条命令都走 argv 数组，无注入面。
 */
export async function guessBundleFor(serial: string, libName: string): Promise<Array<{ bundleName: string; mainAbility: string }>> {
  const key = fuzzyKey(libName);
  if (!key) return [];
  let out = '';
  try {
    out = await execShell(serial, ['bm', 'dump', '-a']);
  } catch {
    return [];
  }
  const bundles = [...new Set(out.split(/\r?\n/)
    .map((s) => s.replace(/^[\s\t*]+/, '').trim())
    .filter((s) => /^[A-Za-z][\w.]*$/.test(s) && s.includes('.'))
    .filter((s) => !isSystemBundle(s)))];
  const matched = bundles.filter((b) => {
    const bk = fuzzyKey(b);
    const tail = bk.split('.').pop() ?? '';
    return bk.includes(key) || (tail.length >= 3 && key.includes(tail));
  });
  const list: Array<{ bundleName: string; mainAbility: string }> = [];
  for (const bundleName of matched.slice(0, 10)) {
    let mainAbility = '';
    try {
      const dump = await execShell(serial, ['bm', 'dump', '-n', bundleName]);
      mainAbility = parseMainAbility(dump);
    } catch { /* 单个取不到不影响其它候选 */ }
    list.push({ bundleName, mainAbility });
  }
  return list;
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
      // 二段式「输入「内容」到「控件」」：先定位目标控件聚焦，再输入内容
      const two = d.match(/^(?:输入|键入|填写)\s*[「"](.+?)[」"]\s*(?:到|至|进入|在)\s*[「"](.+?)[」"]/);
      if (two) {
        const content = two[1]?.trim() ?? '';
        const target = two[2]?.trim() ?? '';
        if (!content) return fail(`无法解析输入内容：${d}`);
        const node = target ? findKeyword(parseNodes(await uiDump(serial)), target) : undefined;
        if (node) await tap(serial, node.x, node.y);
        const out = await inputText(serial, content);
        return pass(`输入「${content}」到「${target}」${node ? `@(${node.x},${node.y})` : '（未定位到目标控件，直接输入）'}：${out}`);
      }
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

/** 单步执行（带超时）。导出供 dryRun 逐步执行 —— 需在失败点抓取界面证据时不能用整批 executeCaseSteps。 */
export async function runStepWithTimeout(serial: string, desc: string, timeoutMs: number): Promise<{ ok: boolean; log: string; durationMs: number }> {
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
