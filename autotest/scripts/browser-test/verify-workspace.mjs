// 库工作区（R8 Phase 1）DOM 断言：验证新主轴入口真的可用。
//
// 为什么值得单独跑：这是信息架构重构的第一步（双轨期），要证明
// "左列表选库 + 右 Tab" 这个新模式真的能跑通、且老页面没被带坏。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9229;
const BASE = process.argv[2] ?? 'http://127.0.0.1:3280';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const chrome = await launchChrome(PORT);
try {
  const session = await connectFirstPage(PORT);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const evalJs = (expr) => session.evalJs(expr);

  await session.send('Page.navigate', { url: `${BASE}/#workspace` });
  await sleep(3000);

  // ---------- 1. 工作区骨架 ----------
  console.log('— 工作区骨架 —');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      ws: !!document.querySelector('.ws'),
      list: document.querySelectorAll('.ws-item').length,
      hasHead: !!document.querySelector('.ws-head'),
      tabs: [...document.querySelectorAll('.ws-tab')].map(t => t.textContent.trim()),
      activeTab: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? null,
    })`));
    check(s.ws, '库工作区已渲染（.ws 布局）');
    check(s.list > 0, '左列表有库', `${s.list} 个`);
    check(s.hasHead, '右侧头部已渲染');
    check(s.tabs.length === 4, '4 个 Tab', JSON.stringify(s.tabs));
    check(s.activeTab?.includes('概览'), '默认激活「概览」Tab', String(s.activeTab));
  }

  // ---------- 2. 默认选中第一个库 ----------
  console.log('\n— 默认选中与概览数据 —');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      title: document.querySelector('.ws-title')?.textContent ?? '',
      activeItem: document.querySelector('.ws-item.active .ws-item-name')?.textContent ?? '',
      cards: document.querySelectorAll('.ws-body .card').length,
      hasEnvCard: document.body.innerText.includes('环境'),
    })`));
    check(s.title.length > 0, '有选中库（标题非空）', s.title);
    check(s.activeItem === s.title, '左列表高亮与右标题一致（选中态同步）', `${s.activeItem} vs ${s.title}`);
    check(s.cards >= 3, '概览渲染至少 3 张卡', `${s.cards} 张`);
  }

  // ---------- 3. 点击切换库 ----------
  console.log('\n— 点击切换库 —');
  {
    const before = await evalJs(`document.querySelector('.ws-title')?.textContent ?? ''`);
    // 点列表中第二个库
    await evalJs(`document.querySelectorAll('.ws-item')[1].click()`);
    await sleep(1200);
    const after = await evalJs(`document.querySelector('.ws-title')?.textContent ?? ''`);
    const activeItem = await evalJs(`document.querySelector('.ws-item.active .ws-item-name')?.textContent ?? ''`);
    check(before !== after, '★ 点击列表切换了库', `${before} → ${after}`);
    check(activeItem === after, '切换后高亮跟随', `${activeItem} vs ${after}`);
    // 概览卡应随新库刷新（环境/用例数可能不同）
    const cards = await evalJs(`document.querySelectorAll('.ws-body .card').length`);
    check(cards >= 3, '切换后概览数据重新加载', `${cards} 张`);
  }

  // ---------- 4. Tab 切换 ----------
  console.log('\n— Tab 切换（概览/环境/用例/问题）—');
  {
    // 环境 Tab
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('环境'))?.click()`);
    await sleep(1500);
    const env = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      bodyText: (document.querySelector('.ws-body')?.textContent ?? '').slice(0, 200),
    })`));
    check(env.active?.includes('环境'), '切到「环境」Tab', String(env.active));
    check(env.bodyText.includes('环境画像') || env.bodyText.includes('还没有环境画像'),
      '环境 Tab 内容正确（画像或空态）', env.bodyText.slice(0, 60));

    // 用例 Tab
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('用例'))?.click()`);
    await sleep(1500);
    const cs = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      rows: document.querySelectorAll('.ws-body table tbody tr').length,
      bodyText: (document.querySelector('.ws-body')?.textContent ?? '').slice(0, 120),
    })`));
    check(cs.active?.includes('用例'), '切到「用例」Tab', String(cs.active));
    check(cs.rows > 0 || cs.bodyText.includes('还没有用例'), '用例 Tab 有数据或空态', `rows=${cs.rows}`);

    // 问题 Tab
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('问题'))?.click()`);
    await sleep(1500);
    const is = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      bodyText: (document.querySelector('.ws-body')?.textContent ?? '').slice(0, 120),
    })`));
    check(is.active?.includes('问题'), '切到「问题」Tab', String(is.active));
    check(is.bodyText.includes('问题') || is.bodyText.includes('没有待处理'),
      '问题 Tab 内容正确', is.bodyText.slice(0, 60));
  }

  // ---------- 5. 双轨期：深度操作回老页面的链接 ----------
  console.log('\n— 双轨期跳转链接（老页面保留）—');
  {
    const links = JSON.parse(await evalJs(`JSON.stringify(
      [...document.querySelectorAll('.ws-tabs a')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
    )`));
    check(links.length >= 4, '有跳老页面的链接', JSON.stringify(links.map(l => l.href)));
    check(links.every((l) => l.href?.startsWith('#')), '链接是 hash 深链接（不破路由）', JSON.stringify(links.map(l => l.href)));
    // 点一个应真的跳到老页面
    await evalJs(`[...document.querySelectorAll('.ws-tabs a')][0].click()`);
    await sleep(1200);
    const hash = await evalJs(`location.hash`);
    check(hash.length > 1, '★ 点击链接跳到老页面', hash);
  }

  // ---------- 6. 搜索过滤 ----------
  console.log('\n— 左列表搜索 —');
  {
    await session.send('Page.navigate', { url: `${BASE}/#workspace` });
    await sleep(2600);
    const before = await evalJs(`document.querySelectorAll('.ws-item').length`);
    await evalJs(`(() => { const i = document.querySelector('.ws-list-h input'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, 'lottie'); i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(1500);
    const after = await evalJs(`document.querySelectorAll('.ws-item').length`);
    check(after < before, '★ 搜索过滤生效', `${before} → ${after}`);
    const names = await evalJs(`[...document.querySelectorAll('.ws-item-name')].map(e => e.textContent).join(',')`);
    check(names.toLowerCase().includes('lottie'), '过滤结果匹配关键词', names.slice(0, 80));
  }

  // ---------- 7. 分页加载（关键：348 个库必须都能加载到）----------
  console.log('\n— 分页加载（加载更多 → 全部 348 个库可达）—');
  {
    // 清空搜索，回到全量第 1 页
    await evalJs(`(() => { const i = document.querySelector('.ws-list-h input'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, ''); i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await sleep(2200);
    const first = JSON.parse(await evalJs(`JSON.stringify({
      count: document.querySelectorAll('.ws-item').length,
      hasBtn: !!document.querySelector('.ws-list-body .btn'),
      hint: document.querySelector('.ws-list-h .muted')?.textContent ?? '',
    })`));
    check(first.count === 100, '第 1 页加载 100 个（服务端 pageSize 上限）', `count=${first.count}`);
    check(first.hasBtn, '★ 有「加载更多」按钮（不是只能看前 100 个）');
    check(first.hint.includes('348'), '提示显示总数 348', first.hint);

    // 点加载更多 → 应到 200
    await evalJs(`document.querySelector('.ws-list-body .btn').click()`);
    await sleep(2200);
    const second = await evalJs(`document.querySelectorAll('.ws-item').length`);
    check(second === 200, '★ 点击后加载到 200', `count=${second}`);

    // 再点 → 300
    await evalJs(`document.querySelector('.ws-list-body .btn')?.click()`);
    await sleep(2200);
    const third = await evalJs(`document.querySelectorAll('.ws-item').length`);
    check(third === 300, '再点击加载到 300', `count=${third}`);

    // 再点 → 348 且按钮消失（全部加载完）
    await evalJs(`document.querySelector('.ws-list-body .btn')?.click()`);
    await sleep(2200);
    const last = JSON.parse(await evalJs(`JSON.stringify({
      count: document.querySelectorAll('.ws-item').length,
      hasBtn: !!document.querySelector('.ws-list-body .btn'),
      hint: document.querySelector('.ws-list-h .muted')?.textContent ?? '',
    })`));
    check(last.count === 348, '★ 最终加载全部 348 个库（"所有库都能看到"成立）', `count=${last.count}`);
    check(!last.hasBtn, '★ 全部加载完后按钮消失（不会无限点）');
    check(last.hint.includes('348'), '提示显示已全部加载', last.hint);
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
