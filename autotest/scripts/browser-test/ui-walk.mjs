// UI 全量遍历测试器：对 AutoTest 前端（17 个 hash 路由页面）逐页验证
//   - 渲染非空白、无 ErrorBoundary 回退（「页面出了点问题」）
//   - 顶栏后端徽标显示版本号（证明 API 连通；「连接中」= API 不通）
//   - 每页截图 + 控制台错误 / 未捕获异常 / 4xx-5xx / 加载失败收集（按页归属）
//   - 关键内容断言（库列表含种子库、设置页含工作区项）
//   - 收尾交互：打开「自定义模型」设置弹窗
//
// 用法：
//   node ui-walk.mjs --base http://127.0.0.1:3280 --out <目录> [--launch 9222 | --connect 9223]
//   --launch：本脚本启动 headless Chrome（web 端测试用）
//   --connect：连接已在调试端口上的浏览器（桌面端 WebView2 测试用，不启新 Chrome）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const BASE = argOf('--base', 'http://127.0.0.1:3280');
const OUT = argOf('--out', '.test-results/ui-walk');
const LAUNCH_PORT = args.includes('--launch') ? Number(argOf('--launch', '9222')) : null;
const CONNECT_PORT = args.includes('--connect') ? Number(argOf('--connect', '9223')) : null;

// 页面清单（key = hash，title = 顶栏面包屑应有标题，来自 App.tsx 的 TITLES）
const PAGES = [
  { key: 'home', title: '首页' },
  { key: 'tasks', title: '任务管理' },
  { key: 'libraries', title: '库管理', mustContain: 'lottie_turbo' },
  { key: 'api', title: '接口清单' },
  { key: 'coverage', title: '覆盖矩阵' },
  { key: 'human', title: '人工队列' },
  { key: 'knowledge', title: '知识库' },
  { key: 'cases', title: '测试用例' },
  { key: 'scripts', title: '自动化脚本' },
  { key: 'plans', title: '执行计划' },
  { key: 'analysis', title: '数据分析' },
  { key: 'attribution', title: '归因分析' },
  { key: 'debug', title: '调试会话' },
  { key: 'devices', title: '设备管理' },
  { key: 'prompts', title: 'Prompt 管理' },
  { key: 'agents', title: 'Agent 绑定' },
  { key: 'settings', title: '系统配置', mustContain: '工作区' },
];

mkdirSync(OUT, { recursive: true });

// 已知且合理的失败（API 契约内的空态信号，不算缺陷）：
// 全新工作区下某库还没生成过 Hypium 脚本时，GET /repos/:id/files?root=scripts
// 按契约返回 404（文案引导用户先「用例转自动化脚本」），前端正常降级渲染。
const EXPECTED_NET = [
  { pattern: /\/repos\/\d+\/files\?.*root=scripts/, status: 404, note: '空态契约：该库尚无 Hypium 脚本' },
];
function isExpectedNet(f) {
  return EXPECTED_NET.some((e) => e.status === f.status && e.pattern.test(f.url));
}
const consoleErrors = [];   // { page, text }
const exceptions = [];      // { page, text }
const netFailures = [];     // { page, url, status|error }
const snap = () => ({ ce: consoleErrors.length, ex: exceptions.length, nf: netFailures.length });

function argToString(a) {
  if (a?.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
  if (a?.preview?.properties) return a.preview.properties.map((p) => `${p.name}=${p.value ?? p.description ?? ''}`).join(' ');
  return a?.description ?? '';
}

async function main() {
  let chrome = null;
  let session;
  if (CONNECT_PORT) {
    console.log(`[walk] 连接已在调试端口 ${CONNECT_PORT} 上的浏览器（桌面端 WebView2 模式）…`);
    session = await connectFirstPage(CONNECT_PORT);
  } else {
    console.log(`[walk] 启动 headless Chrome（调试端口 ${LAUNCH_PORT ?? 9222}）…`);
    chrome = await launchChrome(LAUNCH_PORT ?? 9222);
    session = await connectFirstPage(LAUNCH_PORT ?? 9222);
  }

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');

  session.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      consoleErrors.push({ page: currentPage, text: (p.args ?? []).map(argToString).join(' ').slice(0, 300) });
    }
  });
  session.on('Runtime.exceptionThrown', (p) => {
    exceptions.push({ page: currentPage, text: (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300) });
  });
  session.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error' && p.entry?.source !== 'network') {
      consoleErrors.push({ page: currentPage, text: `[${p.entry.source}] ${String(p.entry.text ?? '').slice(0, 250)}` });
    }
  });
  session.on('Network.responseReceived', (p) => {
    const status = p.response?.status ?? 0;
    if (status >= 400) netFailures.push({ page: currentPage, url: String(p.response.url).slice(0, 160), status });
  });
  session.on('Network.loadingFailed', (p) => {
    netFailures.push({ page: currentPage, url: `(failed) ${p.errorText ?? 'unknown'}`, status: 0 });
  });

  // ---------- 首屏加载 ----------
  console.log(`[walk] 打开 ${BASE} …`);
  const loaded = new Promise((resolve) => {
    const t = setTimeout(resolve, 12_000);
    session.on('Page.loadEventFired', () => { clearTimeout(t); resolve(); });
  });
  const nav = await session.send('Page.navigate', { url: BASE });
  // navigate 可能"成功返回"但实际没加载（errorText / isDownload）——必须显式检查，
  // 否则后面 17 页全是 about:blank 的空跑（踩过：gzip 分支 MIME 错 → 主页被当下载）。
  if (nav.errorText || nav.isDownload) {
    throw new Error(`页面加载失败：${BASE}（errorText=${nav.errorText ?? '无'}, isDownload=${nav.isDownload ?? false}）`);
  }
  await loaded;
  await sleep(1200); // SPA 挂载 + 首屏 API

  const results = [];
  const expectedNotes = []; // 契约内空态失败（不算缺陷，仅记录）
  let currentPage = '(boot)';
  // ---------- 逐页遍历 ----------
  for (const pg of PAGES) {
    currentPage = pg.key;
    const before = snap();
    await session.evalJs(`location.hash = '${pg.key}'`);

    // 轮询面包屑标题（SPA 完成切换的标志）
    let crumb = '';
    const crumbDeadline = Date.now() + 6000;
    while (Date.now() < crumbDeadline) {
      crumb = String(await session.evalJs(`document.querySelector('.topbar .crumb b')?.textContent || ''`)).trim();
      if (crumb === pg.title) break;
      await sleep(200);
    }
    await sleep(900); // 等页面自身的数据请求

    const state = await session.evalJs(`(() => {
      const root = document.getElementById('root');
      const pill = document.querySelector('.tb-pill')?.textContent || '';
      const text = document.body.innerText || '';
      return {
        htmlLen: root ? root.innerHTML.length : 0,
        textLen: text.length,
        pill: pill.trim(),
        boundary: text.includes('页面出了点问题'),
        navItems: document.querySelectorAll('.nav-item').length,
        title: document.title,
      };
    })()`);

    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = join(OUT, `${pg.key}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const after = snap();
    const problems = [];
    if (crumb !== pg.title) problems.push(`面包屑未切换到「${pg.title}」（实际：「${crumb || '空'}」）`);
    if (state.boundary) problems.push('ErrorBoundary 回退（页面渲染崩溃）');
    if (state.htmlLen < 500) problems.push(`渲染内容过少（root HTML ${state.htmlLen} 字符）`);
    if (!/v\d/.test(state.pill)) problems.push(`后端徽标异常：「${state.pill || '空'}」（期望含版本号）`);
    if (pg.mustContain && !String(await session.evalJs(`document.body.innerText.includes(${JSON.stringify(pg.mustContain)})`))) {
      problems.push(`页面缺少关键内容「${pg.mustContain}」`);
    }
    const pageConsole = consoleErrors.slice(before.ce);
    const pageExceptions = exceptions.slice(before.ex);
    const pageNetRaw = netFailures.slice(before.nf);
    const pageNet = pageNetRaw.filter((f) => !isExpectedNet(f)); // 真缺陷
    const pageExpected = pageNetRaw.filter((f) => isExpectedNet(f)); // 契约内空态
    if (pageExceptions.length) problems.push(`${pageExceptions.length} 个未捕获异常`);
    if (pageConsole.length) problems.push(`${pageConsole.length} 条 console.error`);
    if (pageNet.length) problems.push(`${pageNet.length} 个网络失败`);
    if (pageExpected.length) expectedNotes.push(`${pg.key}: ${pageExpected.map((f) => `${f.status} ${f.url}`).join('; ')}（${EXPECTED_NET[0].note}）`);

    results.push({
      page: pg.key, title: pg.title, ok: problems.length === 0, problems,
      state: { htmlLen: state.htmlLen, pill: state.pill, navItems: state.navItems },
      shot: basename(shotPath),
      console: pageConsole, exceptions: pageExceptions, network: pageNet,
    });
    console.log(`[walk] ${problems.length === 0 ? '✅' : '❌'} #${pg.key.padEnd(12)} crumb=${crumb || '(空)'} pill=${state.pill} html=${state.htmlLen}${problems.length ? ' → ' + problems.join('；') : ''}`);
  }

  // ---------- 收尾交互：自定义模型设置弹窗 ----------
  currentPage = '(modal:custom-model)';
  const modalRes = { ok: false, note: '' };
  try {
    const clicked = await session.evalJs(`(() => { const el = document.querySelector('.set-trigger'); if (!el) return false; el.click(); return true; })()`);
    await sleep(700);
    const modalState = await session.evalJs(`(() => {
      const text = document.body.innerText || '';
      return { hasModelText: text.includes('模型'), modalOpen: !!document.querySelector('[class*="modal" i], [role="dialog"]') };
    })()`);
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'modal-custom-model.png'), Buffer.from(shot.data, 'base64'));
    modalRes.ok = Boolean(clicked && modalState.hasModelText);
    modalRes.note = `clicked=${clicked} 含「模型」文案=${modalState.hasModelText}`;
    await session.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
  } catch (e) {
    modalRes.note = `弹窗测试异常：${e?.message ?? String(e)}`;
  }
  console.log(`[walk] ${modalRes.ok ? '✅' : '⚠️'} 设置弹窗（自定义模型）：${modalRes.note}`);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const report = {
    base: BASE, mode: CONNECT_PORT ? `desktop-webview(cdp:${CONNECT_PORT})` : `headless-chrome(cdp:${LAUNCH_PORT ?? 9222})`,
    time: new Date().toISOString(),
    summary: { total: results.length, passed, failed, consoleErrors: consoleErrors.length, exceptions: exceptions.length, netFailures: netFailures.length },
    expectedEmptyState: expectedNotes,
    modal: modalRes,
    results,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`\n==== 遍历汇总 ====`);
  console.log(`页面：${passed}/${results.length} 通过${failed ? `，${failed} 个失败` : ''}`);
  console.log(`全局事件：console.error ${consoleErrors.length} · 未捕获异常 ${exceptions.length} · 网络失败 ${netFailures.length}`);
  if (consoleErrors.length) {
    console.log(`\n-- console.error 明细 --`);
    for (const e of consoleErrors) console.log(`  [${e.page}] ${e.text}`);
  }
  if (exceptions.length) {
    console.log(`\n-- 未捕获异常明细 --`);
    for (const e of exceptions) console.log(`  [${e.page}] ${e.text}`);
  }
  if (netFailures.length) {
    const real = netFailures.filter((n) => !isExpectedNet(n));
    const expected = netFailures.filter((n) => isExpectedNet(n));
    if (real.length) {
      console.log(`\n-- 网络失败明细（真缺陷）--`);
      for (const n of real) console.log(`  [${n.page}] ${n.status || n.url} ${n.url}`);
    }
    if (expected.length) {
      console.log(`\n-- 网络失败（契约内空态，非缺陷）--`);
      for (const n of expected) console.log(`  [${n.page}] ${n.status} ${n.url}`);
    }
  }
  console.log(`\n截图与报告：${OUT}`);

  await session.close();
  if (chrome) chrome.kill();
  process.exit(failed > 0 || exceptions.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[walk] 测试执行失败：', e);
  process.exit(2);
});
