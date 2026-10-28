// 库工作区「拉取仓库代码」入口回归：用真实 Chrome 点按钮，验证**真的建了任务并跑到终态**。
//
// 为什么值得单独跑一遍：这个入口在 R8 信息架构重构里丢过——全站只剩任务页那张
// 「只收手贴 URL、不带 libraryId」的预设卡片，用户点开某个库后找不到任何拉取动作；
// 而单体仓 171 个库共用一个仓库地址，贴 URL 还会经 ensureLibraryByRepoUrl 按 repo_url
// 匹配到**别的库行**（子目录被忽略），拉取结果记到错误的库上。
// 单元/类型检查证明不了"按钮渲染出来了、点了真的拉起代码"，这里补上。
//
// 用法（需先起服务）：node scripts/browser-test/verify-pull-entry.mjs [base]
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

  await session.send('Page.navigate', { url: `${BASE}/#libraries` });
  await sleep(3500);

  // ---------- 1. 选中一个**已克隆**的库，让后面的拉取是快路径（pull 而非 clone） ----------
  console.log('— 选中 lottie_turbo（本地已克隆，pull --ff-only 秒回）—');
  const picked = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.ws-item')];
    const hit = items.find(n => (n.querySelector('.ws-item-name')?.textContent ?? '').includes('lottie_turbo'));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  check(picked, '左列表能选中 lottie_turbo');
  await sleep(1200);

  // ---------- 2. 入口与同步状态真的渲染出来 ----------
  console.log('\n— 库工作区头部的拉取入口与同步状态—');
  const head = JSON.parse(await evalJs(`JSON.stringify({
    pullBtn: [...document.querySelectorAll('.ws-main button')].some(b => b.textContent.includes('拉取仓库代码')),
    updateBtn: [...document.querySelectorAll('.ws-main button')].some(b => b.textContent.trim().endsWith('更新')),
    tags: [...document.querySelectorAll('.ws-head .tag')].map(t => t.textContent.trim()),
    repoUrl: (document.querySelector('.ws-head .muted')?.textContent ?? '').includes('gitcode.com'),
  })`));
  check(head.pullBtn, '★ 头部有「拉取仓库代码」按钮（本 bug 的核心）');
  check(head.updateBtn, '头部有「更新」按钮');
  check(head.tags.length >= 1, '有仓库同步状态标签', head.tags.join(' | '));
  check(head.repoUrl, '头部展示该库的仓库地址');

  // ---------- 3. 点下去：真的建了任务 ----------
  // 注意：本地已克隆的库走 `git pull --ff-only` 快路径，任务可能在采样窗口内就从
  // pending 跑到 done。所以这里**快采**（200ms）抓任务号与忙态，不拿固定 sleep 赌运气；
  // 忙态只是体验细节，抓不到就按信息项报告，不作为失败。
  console.log('\n— 点击「拉取仓库代码」—');
  await evalJs(`[...document.querySelectorAll('.ws-main button')].find(b => b.textContent.includes('拉取仓库代码'))?.click()`);
  let taskNo = '';
  let busySeen = false;
  let firstMsg = '';
  for (let i = 0; i < 20; i++) {
    const o = JSON.parse(await evalJs(`JSON.stringify({
      msg: document.querySelector('.ws-main > .ok')?.textContent ?? '',
      err: document.querySelector('.ws-main > .error')?.textContent ?? '',
      busy: ([...document.querySelectorAll('.ws-main button')].find(b => b.textContent.includes('拉取'))?.disabled) ?? false,
    })`));
    if (!firstMsg) firstMsg = (o.msg || o.err).trim();
    const m = (o.msg + o.err).match(/T-\d+/);
    if (m && !taskNo) taskNo = m[0];
    if (o.busy) busySeen = true;
    // 已经到终态就不用再采了
    if (/完成：|失败|已取消/.test(o.msg + o.err)) break;
    await sleep(200);
  }
  check(/^T-\d+$/.test(taskNo), '点击后创建了 pull_repo 任务（拿到任务号）', taskNo || (firstMsg || '（无提示）').slice(0, 120));
  console.log(`${busySeen ? 'PASS' : 'INFO'}  进行中按钮忙态${busySeen ? '已捕获' : '未捕获（快路径秒回，属正常）'}`);

  // ---------- 4. 轮询到终态：结果内联展示，不要求用户跑去任务页看 ----------
  console.log('\n— 等任务跑到终态—');
  let finalMsg = '';
  let finalErr = '';
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const cur = await evalJs(`JSON.stringify({
      msg: document.querySelector('.ws-main > .ok')?.textContent ?? '',
      err: document.querySelector('.ws-main > .error')?.textContent ?? '',
    })`);
    const o = JSON.parse(cur);
    finalMsg = o.msg;
    finalErr = o.err;
    if (/完成：|失败|已取消/.test(finalMsg + finalErr)) break;
  }
  check(/完成：/.test(finalMsg), '任务跑到 done 且结果内联展示', (finalMsg || finalErr).trim().slice(0, 160));

  // ---------- 5. 终态后同步标签刷新为「已同步 @版本」 ----------
  await sleep(1200);
  const tags2 = await evalJs(`[...document.querySelectorAll('.ws-head .tag')].map(t => t.textContent.trim()).join(' | ')`);
  check(/已同步/.test(tags2), '拉取后同步状态标签刷新为「已同步」', tags2);

  // ---------- 6. 进行态按钮恢复可点 ----------
  const recovered = await evalJs(`[...document.querySelectorAll('.ws-main button')].find(b => b.textContent.includes('拉取仓库代码'))?.disabled ?? null`);
  check(recovered === false, '终态后按钮恢复可用', `disabled=${recovered}`);
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
