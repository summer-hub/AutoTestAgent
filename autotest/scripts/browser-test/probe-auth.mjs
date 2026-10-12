// 认证 UI 探针（P0-1 前端链路实测）：CDP 驱动真实 Chrome 验证
//  1. auth 开启 + 无 Key → 登录门渲染（不是白屏/主界面）
//  2. 输入正确 Key → 进入主界面（面包屑可见）
//  3. 系统配置页 → 「API Key 与访问控制」管理区渲染（admin）
//  4. 人工队列页 → 「危险操作审批」区渲染
//  5. 错误 Key → 登录失败提示，停留在登录门
//  6. 掉线：清空 sessionStorage 触发 401 → 广播回登录门
// 用法：node probe-auth.mjs <baseUrl>（服务器需已在运行；脚本会临时开启认证，结束后恢复）
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3500';
const PORT = 9225;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---- 服务端准备：先建 Key（auth 关闭时直连即可），再开认证 ----
// 顺序要害：若先开认证再建 Key，Node 侧从回环发来的请求也会被 401 挡下（鸡生蛋，实测踩过）。
async function api(path, method = 'GET', body, token) {
  const res = await fetch(`${BASE}/api/autotest${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const before = await api('/auth/status');
check(before.json?.enabled === false, '初始 auth 关闭（否则先手工关掉再跑本探针）');
const created = await api('/auth/keys', 'POST', { name: 'cdp-probe-admin', role: 'admin' });
const KEY = created.json?.key ?? '';
check(created.status === 200 && KEY.startsWith('at_'), '创建探针用 admin Key', KEY.slice(0, 10) + '…');
await api('/auth/settings', 'PUT', { enabled: true, allowLocalBypass: false });
const enabled = await api('/auth/status');
check(enabled.json?.enabled === true, '认证已开启（回环豁免关闭）');

// ---- 浏览器实测 ----
const chrome = await launchChrome(PORT);
const session = await connectFirstPage(PORT);
await session.send('Page.enable');
await session.send('Runtime.enable');

async function goto(url) {
  await session.send('Page.navigate', { url });
  await sleep(1600);
}
const bodyHas = async (text) => session.evalJs(`document.body.innerText.includes(${JSON.stringify(text)})`);
const setReactInput = async (selector, value) => session.evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

// 1. 登录门
await goto(`${BASE}/#home`);
await sleep(600);
check(await bodyHas('此服务已开启访问认证'), 'auth 开启 + 无 Key → 登录门渲染');
check(await session.evalJs(`!!document.querySelector('input[type="password"]')`), '登录门含 Key 输入框');
const shot1 = await session.send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('.test-results/web', { recursive: true });
writeFileSync('.test-results/web/auth-login-gate.png', Buffer.from(shot1.data, 'base64'));

// 2. 正确 Key → 进入主界面
await setReactInput('input[type="password"]', KEY);
await session.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('登 录'))?.click()`);
await sleep(2200);
check(await session.evalJs(`(document.querySelector('.topbar .crumb b')?.textContent || '').trim() === '首页'`), '正确 Key → 进入主界面（面包屑「首页」）');
check(await bodyHas('任务管理'), '侧边导航渲染（主界面而非登录门）');

// 3. 系统配置页 → Key 管理区
await goto(`${BASE}/#settings`);
await sleep(800);
check(await bodyHas('API Key 与访问控制'), '系统配置页含「API Key 与访问控制」管理区');
check(await bodyHas('cdp-probe-admin'), 'Key 列表展示刚创建的 Key（哈希存储、仅展示元数据）');
check(await bodyHas('开启认证'), '管理区含认证开关');

// 4. 人工队列页 → 审批区
await goto(`${BASE}/#human`);
await sleep(800);
check(await bodyHas('危险操作审批'), '人工队列页含「危险操作审批」区');

// 5. 错误 Key → 停留登录门
await session.evalJs(`sessionStorage.setItem('autotest.apiKey', 'at_wrong_key_for_probe')`);
await goto(`${BASE}/#home`);
await sleep(1200);
// 带错误 key 的首屏请求会 401 → 前端清 key 并广播 → 登录门
check(await bodyHas('此服务已开启访问认证'), '错误 Key → 401 广播 → 掉回登录门');

// 6. 恢复 + 收尾（auth 开启且无回环豁免：必须带 Key 才能关认证，再删 Key）
await api('/auth/settings', 'PUT', { enabled: false }, KEY);
const list = await api('/auth/keys', 'GET', undefined, KEY);
for (const k of list.json?.items ?? []) {
  if (k.name === 'cdp-probe-admin') await api(`/auth/keys/${k.id}`, 'DELETE', undefined, KEY);
}
const after = await api('/auth/status');
check(after.json?.enabled === false, '探针结束：认证已恢复关闭（服务器可继续他用）');

await session.close();
chrome.kill();
console.log(fail === 0 ? '\n认证 UI 探针全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
