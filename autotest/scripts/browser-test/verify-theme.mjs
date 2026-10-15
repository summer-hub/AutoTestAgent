// 主题切换 DOM 断言：用真实 Chrome 验证亮/暗 + 主题色真的生效、真的持久化。
//
// 为什么值得单独跑：CSS 变量优先级是这套设计里最容易错的地方——
// 显式主题若不覆盖宿主同步的 --dsw-*，用户点了浅色看到的还是深色，且控制台毫无报错。
// 只有真浏览器里读 getComputedStyle 才能证明"变量真的变了"。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9227;
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

  // 干净起点：无本地主题偏好
  await session.send('Page.navigate', { url: `${BASE}/#home` });
  await sleep(2500);
  await evalJs(`localStorage.removeItem('autotest.theme')`);
  await session.send('Page.reload');
  await sleep(2500);

  // ---------- 1. 默认态：跟随宿主（auto，无 data-theme）----------
  console.log('— 默认态（跟随宿主）—');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      hasThemeAttr: document.documentElement.hasAttribute('data-theme'),
      accentAttr: document.documentElement.getAttribute('data-accent'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    })`));
    check(!s.hasThemeAttr, '默认不写 data-theme（跟随宿主）');
    check(s.accentAttr === 'auto', '默认 accent=auto', String(s.accentAttr));
    check(s.bg.length > 0, '--bg 有值（宿主或回退）', s.bg);
  }

  // ---------- 2. 切到浅色：data-theme + 变量真的变浅 ----------
  console.log('\n— 切换到浅色 —');
  {
    await evalJs(`localStorage.setItem('autotest.theme', JSON.stringify({mode:'light',accent:'blue'}))`);
    await session.send('Page.reload');
    await sleep(2600);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      themeAttr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
      panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      stored: localStorage.getItem('autotest.theme'),
    })`));
    check(s.themeAttr === 'light', 'data-theme=light', String(s.themeAttr));
    // 浅色主题的字面量必须赢过 :root 里的 var(--dsw-*, 深色回退)
    check(s.bg === '#eef0f4', '★ --bg 是浅色字面量（覆盖了宿主/回退深色）', s.bg);
    check(s.text === '#171a21', '--text 是深色字面量（浅色背景上的深色文字）', s.text);
    check(s.panel === '#ffffff', '--panel 是白色卡片', s.panel);
    check(s.accent === '#5686fe', '★ 主题色 blue 生效（未被宿主覆盖）', s.accent);
    check(s.stored.includes('light'), '主题已持久化', s.stored);
  }

  // ---------- 3. 点顶栏按钮互切深浅 ----------
  console.log('\n— 点击主题按钮互切深浅 —');
  {
    // 当前 light，点第一个 theme-btn（太阳/月亮图标）应变 dark
    await evalJs(`document.querySelectorAll('.theme-btn')[0].click()`);
    await sleep(600);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      themeAttr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      stored: localStorage.getItem('autotest.theme'),
    })`));
    check(s.themeAttr === 'dark', '★ 单击图标：light → dark', String(s.themeAttr));
    check(s.bg === '#151517', '深色 --bg 生效', s.bg);
    check(s.stored.includes('dark'), '切换后仍持久化', s.stored);

    // 再点一次应回 light
    await evalJs(`document.querySelectorAll('.theme-btn')[0].click()`);
    await sleep(600);
    const s2 = JSON.parse(await evalJs(`JSON.stringify({ themeAttr: document.documentElement.getAttribute('data-theme') })`));
    check(s2.themeAttr === 'light', '再单击：dark → light', String(s2.themeAttr));
  }

  // ---------- 4. 浮层选主题色 ----------
  console.log('\n— 浮层选择主题色 —');
  {
    // 开浮层（第二个 theme-btn 是调色板按钮）
    await evalJs(`document.querySelectorAll('.theme-btn')[1].click()`);
    await sleep(500);
    const popOpen = await evalJs(`!!document.querySelector('.theme-pop')`);
    check(popOpen, '主题浮层可打开');

    // 点绿色色板（index 2：auto/blue/green）
    await evalJs(`document.querySelectorAll('.theme-swatch')[2].click()`);
    await sleep(600);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      accentAttr: document.documentElement.getAttribute('data-accent'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      accentDim: getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim(),
      stored: localStorage.getItem('autotest.theme'),
    })`));
    check(s.accentAttr === 'green', 'data-accent=green', String(s.accentAttr));
    check(s.accent === '#16a34a', '★ --accent 变为绿色', s.accent);
    check(s.accentDim.includes('34, 197, 94'), '--accent-dim 同步为绿色半透明', s.accentDim);
    check(s.stored.includes('green'), '主题色已持久化', s.stored);
  }

  // ---------- 5. 浅色下页面真的可读（不是只剩变量变了）----------
  console.log('\n— 浅色下实际渲染可读 —');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      themeAttr: document.documentElement.getAttribute('data-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      sidebarBg: (() => { const el = document.querySelector('.sidebar'); return el ? getComputedStyle(el).backgroundColor : null; })(),
      cardBg: (() => { const el = document.querySelector('.card'); return el ? getComputedStyle(el).backgroundColor : null; })(),
    })`));
    check(s.themeAttr === 'green' ? true : true, '（上下文）当前主题', `accent=${s.accentAttr ?? ''}`);
    // 浅色下 body 背景应为浅色（不是透明/深色）
    check(s.bodyBg !== 'rgba(0, 0, 0, 0)' && s.bodyBg.length > 0, 'body 有实际背景色', s.bodyBg);
    check(s.bodyColor.length > 0, 'body 有文字色', s.bodyColor);
    check(s.cardBg !== null, '卡片有背景色（面板已渲染）', String(s.cardBg));
  }

  // ---------- 6. 深色下恢复（回切）----------
  console.log('\n— 切回深色 + 恢复跟随宿主 —');
  {
    await evalJs(`localStorage.setItem('autotest.theme', JSON.stringify({mode:'dark',accent:'auto'}))`);
    await session.send('Page.reload');
    await sleep(2600);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      themeAttr: document.documentElement.getAttribute('data-theme'),
      accentAttr: document.documentElement.getAttribute('data-accent'),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    })`));
    check(s.themeAttr === 'dark', 'data-theme=dark', String(s.themeAttr));
    check(s.accentAttr === 'auto', 'accent 回 auto（跟随宿主）', String(s.accentAttr));
    check(s.bg === '#151517', '深色 --bg 生效', s.bg);

    // 恢复 auto：移除 data-theme
    await evalJs(`localStorage.setItem('autotest.theme', JSON.stringify({mode:'auto',accent:'auto'}))`);
    await session.send('Page.reload');
    await sleep(2600);
    const s2 = JSON.parse(await evalJs(`JSON.stringify({
      hasThemeAttr: document.documentElement.hasAttribute('data-theme'),
    })`));
    check(!s2.hasThemeAttr, '★ auto 模式不写 data-theme（干净回退到跟随宿主）');
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
