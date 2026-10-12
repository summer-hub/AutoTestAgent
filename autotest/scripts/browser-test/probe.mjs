// 探针：定位 Page.navigate 是否静默失败（errorText 未检查的嫌疑）
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9224;
const URL = process.argv[2] ?? 'http://127.0.0.1:3500/';

const chrome = await launchChrome(PORT);
const session = await connectFirstPage(PORT);
await session.send('Page.enable');
await session.send('Network.enable');
await session.send('Runtime.enable');

session.on('Network.responseReceived', (p) => console.log('  [net]', p.response?.status, String(p.response?.url).slice(0, 90)));
session.on('Network.loadingFailed', (p) => console.log('  [net-fail]', p.errorText));
session.on('Runtime.exceptionThrown', (p) => console.log('  [exc]', p.exceptionDetails?.text));

console.log('== /json/list targets:');
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const t of list) console.log(`  ${t.type} ${t.url}`);

console.log(`== Page.navigate → ${URL}`);
const nav = await session.send('Page.navigate', { url: URL });
console.log('  navigate result:', JSON.stringify(nav));

await sleep(3000);

console.log('== 页面状态:');
const state = await session.evalJs(`JSON.stringify({
  href: location.href, title: document.title,
  rootLen: document.getElementById('root')?.innerHTML.length ?? -1,
  bodyText: (document.body.innerText || '').slice(0, 120),
})`);
console.log(' ', state);

console.log('== targets after nav:');
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const t of list2) console.log(`  ${t.type} ${t.url}`);

await session.close();
chrome.kill();
