// 待办工作台（R8 Phase 5）DOM 断言：验证首页从"统计堆砌"变为"待办驱动"。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9238;
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
  await sleep(3200);

  // 1. 标题与定位
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      title: document.querySelector('.page-title')?.textContent ?? '',
      desc: document.querySelector('.page-desc')?.textContent ?? '',
    })`));
    check(s.title === '待办工作台', '★ 首页标题改为「待办工作台」', s.title);
    check(s.desc.includes('该做什么') || s.desc.includes('待办'), '副标题说明这是待办驱动', s.desc);
  }

  // 2. 待办卡片（每项都是可点链接，带数量与理由）
  {
    const s = JSON.parse(await evalJs(`JSON.stringify({
      todoCards: [...document.querySelectorAll('a.card')].map(a => ({
        text: (a.textContent ?? '').slice(0, 80),
        href: a.getAttribute('href'),
        hasBorderLeft: (a.style.borderLeft || '').length > 0,
      })),
      kpiCards: document.querySelectorAll('.kpi').length,
    })`));
    check(s.todoCards.length > 0, '★ 有待办卡片（不是空页）', `${s.todoCards.length} 项`);
    check(s.todoCards.every((c) => c.href?.startsWith('#')), '★ 每项都是 hash 跳转链接', JSON.stringify(s.todoCards.map((c) => c.href)));
    check(s.todoCards.every((c) => c.hasBorderLeft), '每项有严重度色条（视觉分层）');
    check(s.kpiCards === 4, '★ 统计 KPI 降为副栏（4 张）', `${s.kpiCards} 张`);
  }

  // 3. 点击待办跳到库工作区
  {
    const first = await evalJs(`document.querySelector('a.card')?.getAttribute('href') ?? ''`);
    await evalJs(`document.querySelector('a.card')?.click()`);
    await sleep(2200);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      hash: location.hash,
      inWorkspace: !!document.querySelector('.ws'),
    })`));
    check(first.startsWith('#workspace') || first.startsWith('#assets') || first.startsWith('#execution'),
      '待办跳转目标是四个新区之一', first);
    check(s.inWorkspace, '★ 点击待办跳到库工作区（不停留在首页）', `hash=${s.hash}`);
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
