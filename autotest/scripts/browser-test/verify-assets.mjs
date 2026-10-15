// 资产页（R8 Phase 2a）DOM 断言：4 个 Tab 都能用，且三个新 Tab 真的拿到了数据。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9232;
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

  await session.send('Page.navigate', { url: `${BASE}/#assets` });
  await sleep(3200);

  // 1. 4 个 Tab
  const tabs = JSON.parse(await evalJs(`JSON.stringify({
    tabs: [...document.querySelectorAll('.ws-tab')].map(t => t.textContent.trim()),
    active: document.querySelector('.ws-tab.active')?.textContent?.trim() ?? '',
    title: document.querySelector('.page-title')?.textContent ?? '',
  })`));
  check(tabs.title === '资产', '资产页标题正确', tabs.title);
  check(tabs.tabs.length === 4, '4 个 Tab', JSON.stringify(tabs.tabs));
  check(tabs.active?.includes('知识'), '默认激活「知识」', String(tabs.active));

  // 2. 知识 Tab（嵌入现有知识页）
  const kn = JSON.parse(await evalJs(`JSON.stringify({
    len: (document.body.innerText || '').length,
    hasContent: document.body.innerText.includes('知识') || document.body.innerText.includes('条目'),
  })`));
  check(kn.len > 200, '知识 Tab 有内容（嵌入现有页）', `${kn.len} 字符`);

  // 3. 预设方案 Tab
  await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('预设'))?.click()`);
  await sleep(1800);
  const pr = JSON.parse(await evalJs(`JSON.stringify({
    cards: document.querySelectorAll('.card').length,
    text: [...document.querySelectorAll('.card')].map(c => c.textContent).join(' '),
  })`));
  check(pr.cards > 0, '★ 预设方案 Tab 渲染出卡片', `${pr.cards} 张`);
  check(/animation|network|storage|codec/.test(pr.text), '★ 预设类别数据到位（API 真的通了）', pr.text.slice(0, 80));

  // 4. 脚本资产 Tab
  await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('脚本资产'))?.click()`);
  await sleep(1800);
  const sc = JSON.parse(await evalJs(`JSON.stringify({
    rows: document.querySelectorAll('table tbody tr').length,
    text: document.querySelector('table tbody')?.textContent ?? '',
  })`));
  check(sc.rows > 0, '★ 脚本资产 Tab 有表格行', `${sc.rows} 行`);
  check(/ohpm_install|build_hap|hdc_install/.test(sc.text), '★ 14 个脚本资产数据到位', sc.text.slice(0, 100));

  // 5. 测试资源 Tab
  await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('测试资源'))?.click()`);
  await sleep(1800);
  const rs = JSON.parse(await evalJs(`JSON.stringify({
    hasEmpty: document.body.innerText.includes('还没有登记的资源'),
    hasBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('合成')),
    rows: document.querySelectorAll('table tbody tr').length,
  })`));
  check(rs.hasBtn, '★ 测试资源 Tab 有「合成资源」按钮（补上了入口）');
  check(rs.hasEmpty || rs.rows > 0, '测试资源 Tab 有空态或数据', `rows=${rs.rows}`);

  // 6. 点合成 → 应有资源出现
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('合成 animation'))?.click()`);
  await sleep(3000);
  const after = JSON.parse(await evalJs(`JSON.stringify({
    rows: document.querySelectorAll('table tbody tr').length,
    text: document.querySelector('table tbody')?.textContent ?? '',
  })`));
  check(after.rows > 0, '★ 点击合成后资源真的登记出来', `${after.rows} 行`);
  check(/animation_json|lottie/.test(after.text), '合成出动画资源', after.text.slice(0, 80));

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
