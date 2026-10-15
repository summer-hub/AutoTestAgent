// 执行页 + 配置页（R8 Phase 2b/2c）DOM 断言。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9233;
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
  const evalJs = (e) => session.evalJs(e);

  // ==================== 执行页 ====================
  console.log('— 执行页（计划/任务/设备/调试）—');
  await session.send('Page.navigate', { url: `${BASE}/#execution` });
  await sleep(3200);
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      title: document.querySelector('.page-title')?.textContent ?? '',
      tabs: [...document.querySelectorAll('.ws-tab')].map(t => t.textContent.trim()),
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      contentLen: (document.body.innerText ?? '').length,
    })`));
    check(s.title === '执行', '执行页标题正确', s.title);
    check(s.tabs.length === 4, '4 个 Tab', JSON.stringify(s.tabs));
    check(s.active?.includes('执行计划'), '默认激活「执行计划」', String(s.active));
    check(s.contentLen > 300, '执行页有内容', `${s.contentLen} 字符`);
  }
  // 切到任务 Tab
  {
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('任务'))?.click()`);
    await sleep(2000);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      hasTaskUi: document.body.innerText.includes('任务') || document.body.innerText.includes('预置卡片'),
    })`));
    check(s.active?.includes('任务'), '切到「任务」Tab', String(s.active));
    check(s.hasTaskUi, '任务 Tab 渲染出任务管理内容');
  }
  // 切到设备 Tab
  {
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('设备'))?.click()`);
    await sleep(2000);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      hasDevUi: document.body.innerText.includes('设备') || document.body.innerText.includes('hdc'),
    })`));
    check(s.active?.includes('设备'), '切到「设备」Tab', String(s.active));
    check(s.hasDevUi, '设备 Tab 渲染出设备管理内容');
  }

  // ==================== 配置页 ====================
  console.log('\n— 配置页（设置/Prompt/Agent/分析）—');
  await session.send('Page.navigate', { url: `${BASE}/#config` });
  await sleep(3200);
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      title: document.querySelector('.page-title')?.textContent ?? '',
      tabs: [...document.querySelectorAll('.ws-tab')].map(t => t.textContent.trim()),
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
    })`));
    check(s.title === '配置', '配置页标题正确', s.title);
    check(s.tabs.length === 4, '4 个 Tab', JSON.stringify(s.tabs));
    check(s.active?.includes('系统设置'), '默认激活「系统设置」', String(s.active));
  }
  // 切到 Prompt Tab
  {
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('Prompt'))?.click()`);
    await sleep(2000);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
      hasPromptUi: document.body.innerText.includes('Prompt') || document.body.innerText.includes('提示词'),
    })`));
    check(s.active?.includes('Prompt'), '切到「Prompt」Tab', String(s.active));
    check(s.hasPromptUi, 'Prompt Tab 渲染出提示词管理内容');
  }
  // 切到分析 Tab
  {
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('分析'))?.click()`);
    await sleep(2200);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
    })`));
    check(s.active?.includes('分析'), '切到「分析」Tab', String(s.active));
  }

  // ==================== 新一级导航（5 项）====================
  console.log('\n— 新一级导航（库工作区/资产/执行/配置 + 首页）—');
  {
    const s = JSON.parse(await evalJs(`JSON.stringify(
      [...document.querySelectorAll('.nav-item')].map(n => n.textContent.trim()).filter(Boolean)
    )`));
    const hasNew = ['库工作区', '资产', '执行', '配置'].every((k) => s.some((t) => t.includes(k)));
    check(hasNew, '★ 四个新一级入口都在侧边栏', JSON.stringify(s.slice(0, 8)));
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
