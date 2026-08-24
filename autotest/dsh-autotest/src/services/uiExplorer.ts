// 真机 UI 遍历引擎：启动 demo → BFS 遍历页面 Layout → 收集控件/动画 → 生成用例数据
//  - 动画适配：检测 bounds 超出屏幕的大控件/动画区域，自动滑动直到完整可见
//  - 输出：页面清单（路径/控件/动画/滑动次数），供自动生成用例与 Hypium 脚本
import fs from 'node:fs';
import path from 'node:path';
import { dumpMeta, execShell, findKeyword, keyBack, launchArgs, listTargets, parseNodes, screenSize, tap, uiDump } from './hdc.js';
import { workspaceDir } from './gitRepo.js';

export interface ExploredControl {
  text: string;
  desc: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExploredPage {
  path: string[];            // 从首页到达该页的点击文本序列
  controls: ExploredControl[];
  screen: { w: number; h: number };
  swipes: number;            // 为看到完整内容滑动的次数
  animation?: { x: number; y: number; w: number; h: number };
  note: string;
}

export interface ExploreResult {
  packageName: string;
  serial: string;
  pages: ExploredPage[];
  visitedCount: number;
  durationMs: number;
}

export interface ExploreOpts {
  maxPages?: number;
  maxDepth?: number;
  controlsPerPage?: number;
  maxSwipePerPage?: number;
  launchAbility?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawNode { text: string; desc: string; x: number; y: number }

/** 页面签名：控件文本集合排序拼接（去重用）。 */
function pageSignature(nodes: RawNode[]): string {
  return [...new Set(nodes.map((n) => (n.text || n.desc).trim()).filter(Boolean))].sort().join('|');
}

/** 检测「超出屏幕」的大控件/动画区域（bounds 越界或占据屏幕比例过大）。 */
function detectOutOfScreen(nodes: RawNode[], sw: number, sh: number): RawNode | undefined {
  return nodes.find((n) => {
    const big = n.x > 0 && n.y > 0 && (n.x > sw || n.y > sh); // bounds 起点越界
    return big;
  });
}

async function swipePage(serial: string, dir: 'up' | 'down'): Promise<void> {
  const xml = await uiDump(serial);
  const { w, h } = screenSize(xml);
  const cx = Math.round(w / 2);
  const cy = Math.round(h * 0.72);
  const dy = Math.round(h * 0.55);
  const fromY = dir === 'up' ? cy : Math.round(h * 0.28);
  const toY = dir === 'up' ? Math.max(0, cy - dy) : Math.min(h, fromY + dy);
  if (dir === 'up') {
    await execShell(serial, ['uinput', '-T', '-m', String(cx), String(fromY), String(cx), String(toY), '400']);
  } else {
    await execShell(serial, ['uinput', '-T', '-m', String(cx), String(fromY), String(cx), String(toY), '400']);
  }
  await sleep(800);
}

/**
 * BFS 遍历：从首页出发，逐个点击可交互控件进入子页面，keyBack 返回；去重页面签名。
 * 每页若存在越界控件/动画区域，自动向上滑动直到完整可见（maxSwipePerPage 次）。
 */
export async function exploreApp(
  serial: string,
  packageName: string,
  opts: ExploreOpts = {},
): Promise<ExploreResult> {
  const t0 = Date.now();
  const maxPages = opts.maxPages ?? 20;
  const maxDepth = opts.maxDepth ?? 2;
  const controlsPerPage = opts.controlsPerPage ?? 12;
  const maxSwipePerPage = opts.maxSwipePerPage ?? 5;

  const visited = new Set<string>();
  const visitedPaths = new Set<string>();
  const pages: ExploredPage[] = [];

  // 确保从首页开始：先杀应用再启动（aa start 只切前台，不重置页面）
  const ability = opts.launchAbility || packageName;
  try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 应用未运行 */ }
  await execShell(serial, launchArgs(ability));
  await sleep(3000);

  const dumpCurrent = async (): Promise<{ nodes: RawNode[]; screen: { w: number; h: number }; sw: number; meta: ReturnType<typeof dumpMeta> }> => {
    let xml = await uiDump(serial);
    const screen = screenSize(xml);
    let sw = 0;
    // 若不在目标应用（回到桌面/系统页），重新启动应用
    for (let i = 0; i < 2; i++) {
      const meta = dumpMeta(xml);
      if (!meta.bundleName || meta.bundleName === packageName) break;
      await execShell(serial, launchArgs(ability));
      await sleep(2200);
      xml = await uiDump(serial);
    }
    // 动画/内容越界 → 滑动直到完整可见
    for (let i = 0; i < maxSwipePerPage; i++) {
      const nodes = parseNodes(xml);
      const out = detectOutOfScreen(nodes, screen.w, screen.h);
      if (!out) break;
      await swipePage(serial, 'up');
      xml = await uiDump(serial);
      sw++;
    }
    return { nodes: parseNodes(xml), screen, sw, meta: dumpMeta(xml) };
  };

  const home = await dumpCurrent();
  visited.add(pageSignature(home.nodes));
  if (home.meta.pagePath) visitedPaths.add(home.meta.pagePath);
  pages.push({
    path: ['首页'],
    controls: home.nodes.slice(0, controlsPerPage).map((n) => ({ ...n, w: 40, h: 40 })),
    screen: home.screen,
    swipes: home.sw,
    note: '首页',
  });

  // BFS 队列：{ path, depth }；只记录从首页可达的页面
  const queue: Array<{ path: string[]; depth: number }> = [{ path: ['首页'], depth: 0 }];
  let guard = 0;

  while (queue.length > 0 && pages.length < maxPages && guard < 60) {
    guard++;
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    // 回到当前路径所在页面：杀应用重启后重放点击序列
    try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 忽略 */ }
    await execShell(serial, launchArgs(ability));
    await sleep(3000);
    let xml = await uiDump(serial);
    let screen = screenSize(xml);
    for (const step of cur.path.filter((s) => s !== '首页')) {
      const nodes = parseNodes(xml);
      const node = findKeyword(nodes, step);
      if (!node) break;
      await tap(serial, node.x, node.y);
      await sleep(1200);
      xml = await uiDump(serial);
      screen = screenSize(xml);
    }

    const nodes = parseNodes(xml);
    // 非目标应用页面（桌面/系统）→ 跳过本轮
    const meta = dumpMeta(xml);
    if (meta.bundleName && meta.bundleName !== packageName) continue;
    const curPagePath = meta.pagePath;
    // 当前页的可交互控件（有文本/描述），排除返回/导航类
    const clickable = nodes
      .filter((n) => n.y > 130)   // 排除系统状态栏（时钟/网速/电量）
      .filter((n) => (n.text || n.desc).trim())
      .filter((n) => !/^(返回|back|上一页|关闭|取消)/i.test((n.text || n.desc).trim()))
      .slice(0, controlsPerPage);

    for (const c of clickable) {
      if (pages.length >= maxPages) break;
      const label = (c.text || c.desc).trim().slice(0, 24);
      const nextPath = [...cur.path, label];
      // 点击进入子页面
      await tap(serial, c.x, c.y);
      await sleep(1500);
      const sub = await dumpCurrent();
      const sig = pageSignature(sub.nodes);
      const pathKey = sub.meta.pagePath || sig;
      const bundleOk = !sub.meta.bundleName || sub.meta.bundleName === packageName;
      const entered = !visited.has(sig) && !visitedPaths.has(pathKey) && sub.nodes.length > 0 && bundleOk;
      console.log(`[explore] ${cur.path.join('→')} 点击「${label}」→ entered=${entered} pagePath=${sub.meta.pagePath} bundle=${sub.meta.bundleName} nodes=${sub.nodes.length}`);
      if (entered) {
        visited.add(sig);
        visitedPaths.add(pathKey);
        const anim = detectOutOfScreen(sub.nodes, sub.screen.w, sub.screen.h);
        pages.push({
          path: nextPath,
          controls: sub.nodes.slice(0, controlsPerPage).map((n) => ({ ...n, w: 40, h: 40 })),
          screen: sub.screen,
          swipes: sub.sw,
          animation: anim ? { x: anim.x, y: anim.y, w: 40, h: 40 } : undefined,
          note: anim ? '检测到越界动画/内容，已自动滑动适配' : '页面正常',
        });
        queue.push({ path: nextPath, depth: cur.depth + 1 });
        // 返回上一页（HarmonyOS 边缘返回手势）
        await keyBack(serial);
        await sleep(1000);
        xml = await uiDump(serial);
        screen = screenSize(xml);
      } else {
        // 页面未变（点击无导航）→ 直接继续；页面变了但已访问 → 重置回当前路径页
        if (sub.meta.pagePath !== curPagePath) {
          try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 忽略 */ }
          await execShell(serial, launchArgs(ability));
          await sleep(2500);
          xml = await uiDump(serial);
          screen = screenSize(xml);
          for (const step of cur.path.filter((s) => s !== '首页')) {
            const ns = parseNodes(xml);
            const node = findKeyword(ns, step);
            if (!node) break;
            await tap(serial, node.x, node.y);
            await sleep(1000);
            xml = await uiDump(serial);
            screen = screenSize(xml);
          }
        }
      }
    }
  }

  return {
    packageName,
    serial,
    pages,
    visitedCount: visited.size,
    durationMs: Date.now() - t0,
  };
}

/** 保存遍历报告（JSON）到 workspace/explore/<lib>/。 */
export function saveExploreReport(libName: string, result: ExploreResult): string {
  const dir = path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `explore_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

/** 校验设备在线。 */
export async function ensureDeviceOnline(serial: string): Promise<boolean> {
  try {
    const targets = await listTargets();
    return targets.includes(serial);
  } catch {
    return false;
  }
}
