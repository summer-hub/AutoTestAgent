// 库工作区二级 Tab（R8 B2）DOM 断言：确认嵌入的 9 个完整功能视图真的渲染出来。
// 这是 B2 的核心验收——嵌入不是"看起来嵌了"，而是每个子 Tab 都有真实内容。
import { launchChrome, connectFirstPage, sleep } from './cdp.mjs';

const PORT = 9236;
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

  await session.send('Page.navigate', { url: `${BASE}/#workspace` });
  await sleep(3000);

  // 辅助：点主 Tab + 点子 Tab，返回子内容区文本长度
  const openSub = async (mainKw, subKw) => {
    await evalJs(`[...document.querySelectorAll('.ws-tab')].find(t => t.textContent.includes('${mainKw}'))?.click()`);
    await sleep(900);
    await evalJs(`[...document.querySelectorAll('.ws-subtab')].find(t => t.textContent.includes('${subKw}'))?.click()`);
    await sleep(2600);
    return JSON.parse(await evalJs(`JSON.stringify({
      subTabs: [...document.querySelectorAll('.ws-subtab')].map(t => t.textContent.trim()),
      activeSub: document.querySelector('.ws-subtab.active')?.textContent?.trim() ?? '',
      bodyLen: (document.querySelector('.ws-subbody')?.textContent ?? '').length,
      hasError: document.body.innerText.includes('⚠️'),
    })`));
  };

  // ============ 环境 Tab：环境画像 + 全量采集 ============
  console.log('— 环境 Tab（嵌入 Env + Survey）—');
  {
    const env = await openSub('环境', '环境画像');
    check(env.subTabs.length === 2, '环境 Tab 有 2 个子 Tab', JSON.stringify(env.subTabs));
    check(env.activeSub?.includes('环境画像'), '默认激活「环境画像」', String(env.activeSub));
    check(env.bodyLen > 100, '★ 环境画像视图嵌入了真实内容', `${env.bodyLen} 字符`);

    const survey = await openSub('环境', '全量采集');
    check(survey.activeSub?.includes('全量采集'), '切到「全量采集」', String(survey.activeSub));
    check(survey.bodyLen > 100, '★ 全量采集视图嵌入了真实内容', `${survey.bodyLen} 字符`);
  }

  // ============ 用例 Tab：用例 + 脚本 + 接口面 + 覆盖矩阵 ============
  console.log('\n— 用例 Tab（嵌入 Cases + Scripts + Api + Coverage）—');
  {
    const cases = await openSub('用例', '用例');
    check(cases.subTabs.length === 4, '用例 Tab 有 4 个子 Tab', JSON.stringify(cases.subTabs));
    check(cases.activeSub?.includes('用例'), '默认激活「用例」', String(cases.activeSub));
    check(cases.bodyLen > 100, '★ 用例视图嵌入了真实内容', `${cases.bodyLen} 字符`);

    const scripts = await openSub('用例', '脚本');
    check(scripts.activeSub?.includes('脚本'), '切到「脚本」', String(scripts.activeSub));
    check(scripts.bodyLen > 100, '★ 脚本视图嵌入了真实内容', `${scripts.bodyLen} 字符`);

    const api = await openSub('用例', '接口面');
    check(api.activeSub?.includes('接口面'), '切到「接口面」', String(api.activeSub));
    check(api.bodyLen > 100, '★ 接口面视图嵌入了真实内容', `${api.bodyLen} 字符`);

    const cov = await openSub('用例', '覆盖矩阵');
    check(cov.activeSub?.includes('覆盖矩阵'), '切到「覆盖矩阵」', String(cov.activeSub));
    check(cov.bodyLen > 100, '★ 覆盖矩阵视图嵌入了真实内容', `${cov.bodyLen} 字符`);
  }

  // ============ 问题 Tab：问题归因 + 人工队列 + 执行归因 ============
  console.log('\n— 问题 Tab（嵌入 Issues + HumanQueue + Attribution）—');
  {
    const iss = await openSub('问题', '问题归因');
    check(iss.subTabs.length === 3, '问题 Tab 有 3 个子 Tab', JSON.stringify(iss.subTabs));
    check(iss.activeSub?.includes('问题归因'), '默认激活「问题归因」', String(iss.activeSub));
    check(iss.bodyLen > 100, '★ 问题归因视图嵌入了真实内容', `${iss.bodyLen} 字符`);

    const hq = await openSub('问题', '人工队列');
    check(hq.activeSub?.includes('人工队列'), '切到「人工队列」', String(hq.activeSub));
    check(hq.bodyLen > 100, '★ 人工队列视图嵌入了真实内容', `${hq.bodyLen} 字符`);

    const at = await openSub('问题', '执行归因');
    check(at.activeSub?.includes('执行归因'), '切到「执行归因」', String(at.activeSub));
    check(at.bodyLen > 100, '★ 执行归因视图嵌入了真实内容', `${at.bodyLen} 字符`);
  }

  // ============ 旧 URL 友好跳转 ============
  console.log('\n— 旧 URL 跳转到工作区（不留白屏）—');
  {
    await session.send('Page.navigate', { url: `${BASE}/#cases` });
    await sleep(2800);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      hash: location.hash,
      inWorkspace: !!document.querySelector('.ws'),
      bodyLen: (document.body.innerText ?? '').length,
    })`));
    check(s.inWorkspace, '★ 旧链接 #cases 跳到库工作区（不是白屏）', `hash=${s.hash}`);
    check(s.bodyLen > 300, '跳转后有实际内容', `${s.bodyLen} 字符`);
  }

  await session.close();
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
