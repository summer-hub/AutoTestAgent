// 真机 UI 遍历引擎：启动 demo → BFS 遍历页面 Layout → 收集控件/动画 → 生成用例数据
//  - 动画适配：检测 bounds 超出屏幕的大控件/动画区域，自动滑动直到完整可见
//  - 状态栏过滤：系统窗口（时钟/网速/电量）按 bundleName 子树整体丢弃 + 动态高度阈值兜底
//  - 参数配置：深度/页数/每页控件数等默认走系统配置（explore.*），调用方可覆盖
//  - 输出：页面清单（路径/控件/动画/滑动次数），供自动生成用例与 Hypium 脚本
import fs from 'node:fs';
import path from 'node:path';
import { dumpMeta, execShell, findKeyword, keyBack, launchArgs, listTargets, parseNodes, screenSize, tap, uiDump } from './hdc.js';
import { workspaceDir } from './gitRepo.js';
import { getSetting } from './settings.js';

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
  swipes: number;            // 为看到完整内容滑动的次数（越界动画适配）
  scrolls?: number;          // 上下滚动探索的屏数（发现首屏外可交互控件）
  animation?: { x: number; y: number; w: number; h: number };
  note: string;
}

export interface ExploredOp {
  at: string;      // HH:mm:ss.SSS
  action: string;  // 动作名（启动应用/点击/上滑/边缘返回/布局采集/进入判定/收录页面…）
  detail?: string;
}

export interface ExploreResult {
  packageName: string;
  serial: string;
  pages: ExploredPage[];
  visitedCount: number;
  durationMs: number;
  /** 真机操作轨迹（每次设备/判定动作一条，供 UI 回溯查询） */
  ops: ExploredOp[];
}

export interface ExploreOpts {
  maxPages?: number;
  maxDepth?: number;
  controlsPerPage?: number;
  maxSwipePerPage?: number;
  launchAbility?: string;
  statusBarFilter?: boolean; // 不传时读系统配置 explore.statusBarFilter
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawNode { text: string; desc: string; x: number; y: number; bundle?: string; bounds?: { x1: number; y1: number; x2: number; y2: number } }

/** 状态栏/系统窗口默认 bundle 清单（场景板时钟、系统 UI 网速/电量等）。 */
const DEFAULT_SYSTEM_BUNDLES = [
  'com.ohos.sceneboard',
  'com.huawei.systemui',
  'com.ohos.systemui',
  'com.android.systemui',
];

/** 系统包名过滤集合 = 默认清单 + 系统配置 explore.systemBundles（逗号分隔追加）。 */
function systemSkipBundles(): Set<string> {
  const s = new Set(DEFAULT_SYSTEM_BUNDLES);
  try {
    const extra = String(getSetting('explore.systemBundles', '') ?? '');
    for (const item of extra.split(/[,;，；]/).map((x) => x.trim()).filter(Boolean)) s.add(item);
  } catch { /* 配置异常时只用默认清单 */ }
  return s;
}

/** 数值参数：调用方覆盖 > 系统配置 > 内置默认，并夹紧到合法区间。 */
function numOpt(value: number | undefined, key: string, def: number, min: number, max: number): number {
  const n = Number(value ?? getSetting(key, def));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 控件真实尺寸（bounds 可用时），可视化按真实布局绘制。 */
function toControl(n: RawNode): ExploredControl {
  return {
    text: n.text,
    desc: n.desc,
    x: n.x,
    y: n.y,
    w: n.bounds ? Math.max(1, n.bounds.x2 - n.bounds.x1) : 40,
    h: n.bounds ? Math.max(1, n.bounds.y2 - n.bounds.y1) : 40,
  };
}

/** 页面签名：控件文本集合排序拼接（去重用）。 */
function pageSignature(nodes: RawNode[]): string {
  return [...new Set(nodes.map((n) => (n.text || n.desc).trim()).filter(Boolean))].sort().join('|');
}

/** 检测「超出屏幕」的大控件/动画区域（bounds 任一边越出屏幕即视为未完整可见）。 */
function detectOutOfScreen(nodes: RawNode[], sw: number, sh: number): RawNode | undefined {
  const tol = 2; // 贴边渲染的 1~2px 误差不算越界
  return nodes.find((n) => {
    if (!n.bounds) return n.x > sw || n.y > sh;
    return n.bounds.x1 < -tol || n.bounds.y1 < -tol || n.bounds.x2 > sw + tol || n.bounds.y2 > sh + tol;
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
  // 参数优先级：调用方覆盖 > 系统配置（explore.*）> 内置默认
  const maxPages = numOpt(opts.maxPages, 'explore.maxPages', 40, 1, 200);
  const maxDepth = numOpt(opts.maxDepth, 'explore.maxDepth', 2, 1, 6);
  const controlsPerPage = numOpt(opts.controlsPerPage, 'explore.controlsPerPage', 12, 1, 50);
  const maxSwipePerPage = numOpt(opts.maxSwipePerPage, 'explore.maxSwipePerPage', 5, 0, 20);
  // 状态栏彻底过滤：bundleName 子树丢弃 + 屏幕高度比例阈值兜底
  const statusBarFilter = opts.statusBarFilter ?? Boolean(getSetting('explore.statusBarFilter', true));
  const skipBundles = statusBarFilter ? systemSkipBundles() : undefined;
  const parseOpts = skipBundles ? { skipBundles } : undefined;

  const visited = new Set<string>();
  const visitedPaths = new Set<string>();
  const pages: ExploredPage[] = [];

  // ---- 操作轨迹记录器：每个真机动作/判定都留痕，随报告落盘供 UI 查询 ----
  const ops: ExploredOp[] = [];
  const op = (action: string, detail?: string): void => {
    ops.push({ at: new Date().toISOString().slice(11, 23), action, detail });
    if (ops.length > 1500) ops.splice(0, ops.length - 1500);
  };
  const restartApp = async (): Promise<void> => {
    op('强杀应用', packageName);
    try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 忽略 */ }
    op('启动应用', `${ability}（等待 3s）`);
    await execShell(serial, launchArgs(ability));
    await sleep(3000);
  };

  // 确保从首页开始：先杀应用再启动（aa start 只切前台，不重置页面）
  const ability = opts.launchAbility || packageName;
  await restartApp();

  const dumpCurrent = async (): Promise<{ nodes: RawNode[]; screen: { w: number; h: number }; sw: number; meta: ReturnType<typeof dumpMeta> }> => {
    let xml = await uiDump(serial);
    const screen = screenSize(xml);
    let sw = 0;
    // 若不在目标应用（回到桌面/系统页），重新启动应用
    for (let i = 0; i < 2; i++) {
      const meta = dumpMeta(xml);
      if (!meta.bundleName || meta.bundleName === packageName) break;
      op('应用不在前台，重新拉起', meta.bundleName || 'unknown');
      await execShell(serial, launchArgs(ability));
      await sleep(2200);
      xml = await uiDump(serial);
    }
    // 动画/内容越界 → 滑动直到完整可见
    for (let i = 0; i < maxSwipePerPage; i++) {
      const nodes = parseNodes(xml, parseOpts);
      const out = detectOutOfScreen(nodes, screen.w, screen.h);
      if (!out) break;
      op('上滑适配越界内容', `第 ${sw + 1} 次`);
      await swipePage(serial, 'up');
      xml = await uiDump(serial);
      sw++;
    }
    return { nodes: parseNodes(xml, parseOpts), screen, sw, meta: dumpMeta(xml) };
  };

  /**
   * 路径重放时查找控件：当前屏找不到则向下翻屏重试（目标可能在首屏之下）。
   * 找到 → 页面停留在命中位置（坐标可直接点击）；未找到 → 滑回原位再返回 undefined。
   */
  const findNodeScrollable = async (step: string, maxSwipes = 2): Promise<RawNode | undefined> => {
    let xml = await uiDump(serial);
    let node = findKeyword(parseNodes(xml, parseOpts), step);
    let sw = 0;
    while (!node && sw < maxSwipes) {
      await swipePage(serial, 'up');
      sw++;
      xml = await uiDump(serial);
      node = findKeyword(parseNodes(xml, parseOpts), step);
    }
    if (!node && sw > 0) {
      for (let i = 0; i < sw; i++) await swipePage(serial, 'down');
    }
    return node;
  };

  // 状态栏动态阈值：按屏幕高度取比例（高分屏状态栏更高），兜底过滤时钟等系统文本
  const home = await dumpCurrent();
  const statusBarY = Math.max(60, Math.round(home.screen.h * 0.045));
  visited.add(pageSignature(home.nodes));
  if (home.meta.pagePath) visitedPaths.add(home.meta.pagePath);
  pages.push({
    path: ['首页'],
    controls: home.nodes.filter((n) => n.y > statusBarY).slice(0, controlsPerPage).map(toControl),
    screen: home.screen,
    swipes: home.sw,
    note: '首页',
  });

  // 单页控件清单上限（多视口汇总后的存量，供 Agent 看到整页全部按钮/文本）
  const FULL_CONTROLS_CAP = 60;
  // 单页点击覆盖上限：要求覆盖界面上全部可交互按钮（100 为安全上限，防异常页面死循环）
  const CLICK_CAP = 100;

  // BFS 队列：{ path, depth }；只记录从首页可达的页面
  const queue: Array<{ path: string[]; depth: number }> = [{ path: ['首页'], depth: 0 }];
  let guard = 0;

  while (queue.length > 0 && pages.length < maxPages && guard < Math.max(60, maxPages * 4)) {
    guard++;
    const cur = queue.shift()!;
    const isLeaf = cur.depth >= maxDepth; // 叶子页只做全量采集，不再点击扩展
    op('重启回目标页', `${cur.path.join('→')}（深度 ${cur.depth}${isLeaf ? ' · 叶子仅采集' : ''}）`);
    try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 忽略 */ }
    await execShell(serial, launchArgs(ability));
    await sleep(3000);
    // 重放点击序列（目标控件可能在首屏之下，支持翻屏查找）
    for (const step of cur.path.filter((s) => s !== '首页')) {
      const node = await findNodeScrollable(step);
      if (!node) break;
      op('点击（路径重放）', `「${step.slice(0, 24)}」 @(${node.x},${node.y})`);
      await tap(serial, node.x, node.y);
      await sleep(1200);
    }

    // 非目标应用页面（桌面/系统）→ 跳过本轮
    const xml = await uiDump(serial);
    const meta = dumpMeta(xml);
    if (meta.bundleName && meta.bundleName !== packageName) continue;
    const curPagePath = meta.pagePath;

    /**
     * 视口步进遍历：逐屏「采集控件清单 + 点击新候选」。
     * 坐标只在当前视口有效，因此点击与采集同步推进：处理完一屏再上滑到下一屏，
     * 全部结束后滑回顶部。首屏下的回调日志区/按钮因此都能被看到、被点到。
     */
    const seenLabels = new Set<string>();
    const clickedLabels = new Set<string>();
    const inventory: RawNode[] = [];
    let clicked = 0;
    let vp = 0; // 已完成的下翻次数

    const replayToCur = async (): Promise<void> => {
      op('重启并重放路径', `回到 ${cur.path.join('→')} 视口${vp}`);
      try { await execShell(serial, ['aa', 'force-stop', packageName]); } catch { /* 忽略 */ }
      await execShell(serial, launchArgs(ability));
      await sleep(2500);
      for (const step of cur.path.filter((s) => s !== '首页')) {
        const node = await findNodeScrollable(step);
        if (!node) break;
        op('点击（重放）', `「${step.slice(0, 24)}」 @(${node.x},${node.y})`);
        await tap(serial, node.x, node.y);
        await sleep(1000);
      }
      for (let i = 0; i < vp; i++) { await swipePage(serial, 'up'); await sleep(300); } // 回到当前视口
    };

    viewportLoop:
    while (vp <= maxSwipePerPage) {
      const xmlVp = await uiDump(serial);
      const scrVp = screenSize(xmlVp);
      const yMinVp = Math.max(60, Math.round(scrVp.h * 0.045));
      const nodesVp = parseNodes(xmlVp, parseOpts)
        .filter((n) => n.y > yMinVp)
        .filter((n) => (n.text || n.desc).trim())
        .filter((n) => !/^(返回|back|上一页|关闭|取消)/i.test((n.text || n.desc).trim()));
      let fresh = 0;
      for (const n of nodesVp) {
        const label = (n.text || n.desc).trim().slice(0, 24);
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          inventory.push(n);
          fresh++;
        }
      }
      // 点击本视口的新候选（叶子页跳过点击，仅采集）
      if (!isLeaf) {
        for (const c of nodesVp) {
          const label = (c.text || c.desc).trim().slice(0, 24);
          if (clickedLabels.has(label)) continue;
          if (clicked >= CLICK_CAP || pages.length >= maxPages) break viewportLoop;
          clickedLabels.add(label);
          clicked++;
          const nextPath = [...cur.path, label];
          await tap(serial, c.x, c.y);
          await sleep(1500);
          const sub = await dumpCurrent();
          const sig = pageSignature(sub.nodes);
          const pathKey = sub.meta.pagePath || sig;
          const bundleOk = !sub.meta.bundleName || sub.meta.bundleName === packageName;
          const entered = !visited.has(sig) && !visitedPaths.has(pathKey) && sub.nodes.length > 0 && bundleOk;
          op('进入判定', `点击「${label}」→ ${entered ? '进入新页面' : bundleOk ? '未进入（无导航/已访问）' : '离开目标应用'} · pagePath=${sub.meta.pagePath || '—'}`);
          console.log(`[explore] ${cur.path.join('→')} 点击「${label}」(视口${vp}) → entered=${entered} pagePath=${sub.meta.pagePath} bundle=${sub.meta.bundleName} nodes=${sub.nodes.length}`);
          if (entered) {
            visited.add(sig);
            visitedPaths.add(pathKey);
            const anim = detectOutOfScreen(sub.nodes, sub.screen.w, sub.screen.h);
            pages.push({
              path: nextPath,
              controls: sub.nodes.filter((n) => n.y > Math.max(60, Math.round(sub.screen.h * 0.045))).slice(0, FULL_CONTROLS_CAP).map(toControl),
              screen: sub.screen,
              swipes: sub.sw,
              animation: anim ? { x: anim.x, y: anim.y, w: anim.bounds ? Math.max(1, anim.bounds.x2 - anim.bounds.x1) : 40, h: anim.bounds ? Math.max(1, anim.bounds.y2 - anim.bounds.y1) : 40 } : undefined,
              note: anim ? '检测到越界动画/内容，已自动滑动适配' : '页面正常',
            });
            queue.push({ path: nextPath, depth: cur.depth + 1 });
            op('收录页面', `${nextPath.join(' → ')} · 控件 ${pages[pages.length - 1]?.controls.length ?? 0} 个${sub.sw ? ` · 适配滑动 ${sub.sw}` : ''}`);
            // 返回列表页（边缘返回手势），滚动位置保持 → 本视口剩余候选坐标仍有效
            op('边缘返回手势');
            await keyBack(serial);
            await sleep(1000);
          } else if (sub.meta.pagePath !== curPagePath) {
            // 页面变了但已访问 → 重启并重放路径回当前页 + 当前视口
            await replayToCur();
          }
        }
      }
      if (fresh === 0) break; // 本屏无新内容 → 已到底/不可滚动
      op('上滑翻屏', `视口${vp} → ${vp + 1}（本屏新增 ${fresh} 个控件）`);
      await swipePage(serial, 'up');
      vp++;
    }
    // 滑回顶部，下一轮从已知位置开始
    if (vp > 0) op('下滑回顶', `${vp} 屏 · 本页累计控件清单 ${Math.min(inventory.length, FULL_CONTROLS_CAP)} 条`);
    for (let i = 0; i < vp; i++) await swipePage(serial, 'down');

    // 完整控件清单回填本页记录（含首屏下内容），Agent / 用例预期据此覆盖全部按钮与回调输出
    const selfPage = pages.find((p) => p.path.length === cur.path.length && p.path.every((s, i) => s === cur.path[i]));
    if (selfPage && inventory.length > 0) {
      selfPage.controls = inventory.slice(0, FULL_CONTROLS_CAP).map(toControl);
      if (vp > 0) {
        selfPage.scrolls = vp;
        selfPage.note += `${selfPage.note ? '；' : ''}滚动探索 ${vp} 屏 · 控件清单含首屏下内容`;
      }
    }
    if (isLeaf) continue;
  }

  return {
    packageName,
    serial,
    pages,
    visitedCount: visited.size,
    durationMs: Date.now() - t0,
    ops,
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
