// 标签栏（tags-view）DOM 断言：用真实 Chrome 验证多标签导航真的能用。
//
// 为什么值得单独跑一遍：单元/类型检查只能证明"代码能编译"，证明不了
// 标签栏真的渲染出来、点了真的切页、关了真的有下一个激活——这些是用户可感知的行为。
// 项目里已有 17 页遍历（ui-walk）但不断言标签栏本身，这里补上。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9226;
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

  // 清掉历史标签，从干净状态开始（localStorage 是跨会话持久的）
  await session.send('Page.navigate', { url: `${BASE}/#home` });
  await sleep(2500);
  await evalJs(`localStorage.removeItem('autotest.openTabs')`);
  await session.send('Page.reload');
  await sleep(2500);

  // ---------- 1. 初始态：只有首页一个标签，且激活 ----------
  console.log('— 初始态（只有首页，不可关）—');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      bar: !!document.querySelector('.tabbar'),
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      homeClose: !!document.querySelector('[data-tab="home"] .tab-close'),
    })`));
    check(s.bar, '标签栏已渲染');
    check(JSON.stringify(s.tabs) === JSON.stringify(['home']), '初始只有一个首页标签', JSON.stringify(s.tabs));
    check(s.active === 'home', '首页为激活态', String(s.active));
    check(!s.homeClose, '★ 首页无关闭钮（关掉首页会进入不可用状态）');
  }

  // ---------- 2. 点侧边栏 → 新标签出现且激活 ----------
  console.log('\n— 打开多个页面形成多个标签 —');
  {
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('库管理'))?.click()`);
    await sleep(700);
    const s1 = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
    })`));
    check(s1.tabs.includes('libraries'), '点「库管理」后出现 libraries 标签', JSON.stringify(s1.tabs));
    check(s1.active === 'libraries', 'libraries 为激活态', String(s1.active));

    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('用例'))?.click()`);
    await sleep(700);
    const s2 = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      hash: location.hash,
    })`));
    check(s2.tabs.length === 3, '共 3 个标签', JSON.stringify(s2.tabs));
    check(s2.active === 'cases', 'cases 为激活态', String(s2.active));
    check(s2.hash.includes('cases'), 'hash 与激活页一致（单一事实源）', s2.hash);
  }

  // ---------- 3. 点标签切换（不新增标签）----------
  console.log('\n— 点击标签切换页面 —');
  {
    await evalJs(`document.querySelector('[data-tab="libraries"]').click()`);
    await sleep(700);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      hash: location.hash,
      contentHasLib: document.body.innerText.includes('库管理'),
    })`));
    check(s.active === 'libraries', '点击标签后激活态切换', String(s.active));
    check(s.tabs.length === 3, '切换不新增标签', JSON.stringify(s.tabs));
    check(s.hash.includes('libraries'), 'hash 同步', s.hash);
    check(s.contentHasLib, '内容区切到库管理页');
  }

  // ---------- 4. 关闭非激活标签 → 不影响当前页 ----------
  console.log('\n— 关闭标签 —');
  {
    // 当前激活 libraries，关闭 cases（非激活）
    await evalJs(`document.querySelector('[data-tab="cases"] .tab-close').click()`);
    await sleep(700);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
    })`));
    check(!s.tabs.includes('cases'), '关闭非激活标签成功', JSON.stringify(s.tabs));
    check(s.active === 'libraries', '★ 关闭非激活标签不影响当前激活页', String(s.active));
  }

  // ---------- 5. 关闭激活标签 → 激活权移交邻居 ----------
  console.log('\n— 关闭激活标签（激活权移交）—');
  {
    // 现在 tabs = [home, libraries]，激活 libraries；关闭它
    await evalJs(`document.querySelector('[data-tab="libraries"] .tab-close').click()`);
    await sleep(800);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      hash: location.hash,
    })`));
    check(!s.tabs.includes('libraries'), '关闭激活标签成功', JSON.stringify(s.tabs));
    check(s.active === 'home', '★ 激活权移交给左侧邻居（内容区不空白）', String(s.active));
    check(s.hash.replace('#','') === s.active, 'hash 与激活页一致', s.hash);
  }

  // ---------- 6. 关闭其他 / 关闭全部 ----------
  console.log('\n— 关闭其他 / 关闭全部 —');
  {
    // 重新打开两个页
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('环境准备'))?.click()`);
    await sleep(600);
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('全量分析'))?.click()`);
    await sleep(600);
    const before = JSON.parse(await evalJs(`JSON.stringify({ tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab) })`));
    check(before.tabs.length >= 3, '已打开多个标签', JSON.stringify(before.tabs));

    // 关闭其他（保留当前激活的 survey）
    await evalJs(`[...document.querySelectorAll('.tabbar-actions .tab-act')][1].click()`);
    await sleep(700);
    const afterOthers = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
    })`));
    check(afterOthers.tabs.length === 1 && afterOthers.tabs[0] === 'survey',
      '关闭其他 → 只剩激活页', JSON.stringify(afterOthers.tabs));

    // 关闭全部 → 回首页
    await evalJs(`[...document.querySelectorAll('.tabbar-actions .tab-act')][2].click()`);
    await sleep(800);
    const afterAll = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      hash: location.hash,
    })`));
    check(afterAll.tabs.length === 1 && afterAll.tabs[0] === 'home',
      '★ 关闭全部 → 只留首页（不是一个不留）', JSON.stringify(afterAll.tabs));
    check(afterAll.active === 'home', '关闭全部后激活首页', String(afterAll.active));
  }

  // ---------- 7. 刷新后恢复（持久化）----------
  console.log('\n— 刷新后恢复标签（持久化）—');
  {
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('知识库'))?.click()`);
    await sleep(600);
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('问题归因'))?.click()`);
    await sleep(600);
    const before = JSON.parse(await evalJs(`JSON.stringify({ tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab) })`));
    check(before.tabs.includes('knowledge') && before.tabs.includes('issues'),
      '刷新前已打开知识库+问题归因', JSON.stringify(before.tabs));

    await session.send('Page.reload');
    await sleep(2800);
    const after = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
      hash: location.hash,
    })`));
    check(after.tabs.includes('knowledge') && after.tabs.includes('issues'),
      '★ 刷新后标签恢复', JSON.stringify(after.tabs));
    check(after.active === 'issues', '刷新后激活页仍是 hash 指向的页', String(after.active));
    check(after.tabs.includes(after.active), '★ 激活页一定在标签里（无矛盾态）');
  }

  // ---------- 8. 刷新当前页（remount）----------
  console.log('\n— 刷新当前页按钮 —');
  {
    const r = await evalJs(`(() => {
      const btn = document.querySelectorAll('.tabbar-actions .tab-act')[0];
      const before = document.querySelector('.page-title')?.textContent ?? '';
      btn.click();
      return JSON.stringify({ clicked: true, before });
    })()`);
    const parsed = JSON.parse(r);
    check(parsed.clicked, '刷新按钮可点击（不报错）', parsed.before);
    await sleep(600);
    const stillOk = JSON.parse(await evalJs(`JSON.stringify({
      bar: !!document.querySelector('.tabbar'),
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
    })`));
    check(stillOk.bar && stillOk.tabs.includes(stillOk.active),
      '★ 刷新后标签栏与激活态完好（remount 没把界面搞坏）', JSON.stringify(stillOk.tabs));
  }

  // ---------- 9. 深链接直达（hash 有效页）----------
  console.log('\n— 深链接直达非首页 —');
  {
    await session.send('Page.navigate', { url: `${BASE}/#coverage` });
    await sleep(2600);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      active: document.querySelector('.tab.active')?.dataset.tab ?? null,
    })`));
    check(s.active === 'coverage', '深链接 #coverage 激活对应页', String(s.active));
    check(s.tabs.includes('coverage'), '深链接页进入标签', JSON.stringify(s.tabs));
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
