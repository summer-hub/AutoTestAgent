// Phase 3a 验证：一级导航只剩 5 项，且老页面深链接仍可访问（路由未破）。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9234;
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

  await session.send('Page.navigate', { url: `${BASE}/#home` });
  await sleep(3000);

  const nav = JSON.parse(await evalJs(
    `JSON.stringify([...document.querySelectorAll('.nav-item')].map(n => n.textContent.trim()).filter(Boolean))`,
  ));
  console.log('侧边栏项:', JSON.stringify(nav));
  check(nav.length === 5, '★ 一级导航只剩 5 项（首页 + 4 区）', `n=${nav.length}`);
  check(nav.every((t) => /首页|库工作区|资产|执行|配置/.test(t)), '★ 只剩四个新区', JSON.stringify(nav));

  // 深链接仍可用（老页面从导航移除，但 hash 路由必须保留）
  const cases = [['#cases', '用例'], ['#env', '环境'], ['#libraries', '库管理'], ['#issues', '问题']];
  for (const [hash, kw] of cases) {
    await session.send('Page.navigate', { url: `${BASE}/${hash}` });
    await sleep(2200);
    const ok = await evalJs(`document.body.innerText.includes('${kw}')`);
    check(ok, `★ 深链接 ${hash} 仍可访问（路由未破）`);
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
