// UI 遍历判定规则的契约自检（离线：无设备、无 LLM、无 DB）
//
// 覆盖 P1 的核心修复点：
//   1. 候选判定不再依赖"有文本" —— 无文本图标按钮必须被找到（旧实现整类丢失）
//   2. 去重键含坐标桶 —— 同屏同名控件各算一个（旧实现只留第一个）
//   3. 整屏容器不点（点了等于点空白，白耗预算）
//   4. 控件分类正确（不同类别走不同交互序列）
//   5. 页面指纹不含坐标（连续动画页不会每帧判成新页面），且能区分勾选/选中状态
//   6. 预算耗尽可解释（页数/时长/单页点击），深度不再是硬闸
//   7. 解析失败可区分于空页面（旧实现静默返回 []）
//   8. 空关键词不再命中第一个节点
//
// 用法：npm run build && npm run verify:explorer
import { parseDump, findKeyword, isSystemBundle } from '../lib/services/hdc.js';
import {
  isInteractive, isClickCandidate, nodeIdentity, dedupKey, classifyControl, nodeLabel,
  nodeFingerprint, pageSignature, budgetCheck, CoverageTracker, coverageHealth,
} from '../lib/services/uiModel.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

/** 构造一个 dumpLayout 风格的最小 dump。 */
function dump(nodes) {
  return JSON.stringify({
    attributes: { type: 'root', bounds: '[0,0][1260,2720]', clickable: 'false', enabled: 'true', visible: 'true' },
    children: nodes.map((n) => ({
      attributes: {
        type: n.type ?? 'Button',
        text: n.text ?? '',
        description: n.desc ?? '',
        id: n.id ?? '',
        key: n.key ?? '',
        hierarchy: n.hierarchy ?? '',
        bounds: n.bounds ?? '[0,0][100,100]',
        clickable: String(n.clickable ?? false),
        longClickable: String(n.longClickable ?? false),
        scrollable: String(n.scrollable ?? false),
        checkable: String(n.checkable ?? false),
        checked: String(n.checked ?? false),
        selected: String(n.selected ?? false),
        enabled: String(n.enabled ?? true),
        visible: String(n.visible ?? true),
        bundleName: 'com.demo.app',
        pagePath: 'pages/Index',
        hostWindowId: '15',
      },
      children: [],
    })),
  });
}

/**
 * 取子节点（跳过根容器）。
 * ⚠️ 根节点也带 bounds，因此 parseDump 会把它一并返回；直接取 [0] 拿到的是根容器而不是控件。
 */
const kids = (parsed) => parsed.nodes.filter((n) => n.type !== 'root');

// ---------- 1. 无文本控件必须被找到 ----------
console.log('— 候选判定（旧实现按文本筛选，恰好丢掉真实控件）—');
{
  const raw = dump([
    { type: 'Text', text: '标题文字', clickable: false },
    { type: 'Button', id: 'btn_play', clickable: true },                 // 图标按钮：无文本
    { type: 'Image', id: 'icon_setting', clickable: true },              // 图片按钮：无文本
    { type: 'Text', text: '这是一段说明', clickable: false },
  ]);
  const parsed = parseDump(raw);
  const nodes = kids(parsed);
  check(parsed.parsed && nodes.length === 4, '解析出全部带 bounds 的控件节点（不再要求有文本）', `nodes=${nodes.length}`);
  const oldWay = nodes.filter((n) => (n.text || n.desc).trim());
  const newWay = nodes.filter((n) => isClickCandidate(n, { w: 1260, h: 2720 }));
  check(oldWay.length === 2 && oldWay.every((n) => !n.clickable), '旧判据只剩纯展示文本（全是不可点击的）', `旧=${oldWay.length}`);
  check(newWay.length === 2, '新判据找到 2 个真实可点控件', `新=${newWay.length}`);
  check(newWay.every((n) => !n.text && !n.desc), '这两个控件恰恰都是无文本的（旧实现 100% 漏掉）');
  check(newWay.map(nodeLabel).join(',') === '[Button#btn_play],[Image#icon_setting]', '无文本控件有可读标签', newWay.map(nodeLabel).join(','));
}

// ---------- 2. 去重键 ----------
console.log('\n— 去重键（旧实现只按文本前 24 字，同屏同名只留一个）—');
{
  const raw = dump([
    { type: 'Button', text: '确定', clickable: true, bounds: '[100,300][300,400]' },
    { type: 'Button', text: '确定', clickable: true, bounds: '[700,300][900,400]' },
    { type: 'Button', text: '确定', clickable: true, bounds: '[100,300][300,400]' },   // 与第一个完全同位 → 应去重
  ]);
  const nodes = kids(parseDump(raw));
  const keys = new Set(nodes.map((n) => dedupKey(n, 0)));
  check(keys.size === 2, '同屏两个位置的「确定」各算一个，完全同位的第三次去重', `去重后=${keys.size}`);
  const oldKeys = new Set(nodes.map((n) => n.text.slice(0, 24)));
  check(oldKeys.size === 1, '旧判据把它们全合并成 1 个（这就是"同名控件只采到第一个"）', `旧=${oldKeys.size}`);
}

// ---------- 3. 整屏容器不点 ----------
console.log('\n— 整屏容器过滤 —');
{
  const raw = dump([
    { type: 'WindowScene', id: 'scene', clickable: true, bounds: '[0,0][1260,2720]' },   // 整屏
    { type: 'Button', id: 'ok', clickable: true, bounds: '[500,1200][760,1320]' },
  ]);
  const nodes = kids(parseDump(raw));
  const cands = nodes.filter((n) => isClickCandidate(n, { w: 1260, h: 2720 }));
  check(cands.length === 1 && cands[0].id === 'ok', '整屏容器被排除，只留真实按钮');
}

// ---------- 4. 控件分类 ----------
console.log('\n— 控件分类（决定交互序列）—');
{
  const cases = [
    [{ type: 'TextInput', clickable: true }, 'input'],
    [{ type: 'Select', clickable: true }, 'dropdown'],
    [{ type: 'Checkbox', checkable: true }, 'checkbox'],
    [{ type: 'Toggle', checkable: true }, 'switch'],
    [{ type: 'Scroll', scrollable: true }, 'scroll'],
    [{ type: 'Text', text: '可点的文字', clickable: true }, 'button'],
    [{ type: 'Text', text: '纯展示' }, 'text'],
  ];
  for (const [spec, want] of cases) {
    const node = kids(parseDump(dump([spec])))[0];
    const got = classifyControl(node);
    check(got === want, `${spec.type}${spec.checkable ? '(checkable)' : ''} → ${want}`, got === want ? '' : `实际=${got}`);
  }
}

// ---------- 5. 页面指纹 ----------
console.log('\n— 页面指纹（动画页不抖动 / 状态可区分）—');
{
  const frameA = kids(parseDump(dump([
    { type: 'Button', id: 'play', clickable: true, bounds: '[100,100][300,200]' },
    { type: 'Image', id: 'anim', bounds: '[0,300][1260,900]' },
  ])));
  const frameB = kids(parseDump(dump([
    { type: 'Button', id: 'play', clickable: true, bounds: '[104,103][304,203]' },  // 动画导致小幅坐标漂移
    { type: 'Image', id: 'anim', bounds: '[0,306][1260,906]' },
  ])));
  check(pageSignature(frameA) === pageSignature(frameB), '小幅坐标漂移不改变页面签名（连续动画页不再每帧当新页）');

  const moved = kids(parseDump(dump([
    { type: 'Button', id: 'play', clickable: true, bounds: '[600,1500][800,1600]' },  // 跨分桶的大幅位移
    { type: 'Image', id: 'anim', bounds: '[0,300][1260,900]' },
  ])));
  check(pageSignature(frameA, true) !== pageSignature(moved, true), '开启 includeLayout 时对布局敏感（保留旧行为可选）');

  const unchecked = kids(parseDump(dump([{ type: 'Checkbox', id: 'c1', checkable: true, checked: false, clickable: true }])));
  const checked = kids(parseDump(dump([{ type: 'Checkbox', id: 'c1', checkable: true, checked: true, clickable: true }])));
  check(nodeFingerprint(unchecked[0]) !== nodeFingerprint(checked[0]), '勾选前后指纹不同（同一控件的两种状态可各自成页）');
}

// ---------- 6. 预算 ----------
console.log('\n— 预算（取代 maxDepth 硬闸）—');
{
  const b = { maxPages: 10, maxMinutes: 5, maxClicksPerPage: 20, maxSwipePerPage: 5 };
  const at = (s) => budgetCheck(s, b);
  check(!at({ pages: 3, clicksOnPage: 5, steps: 30, elapsedMs: 60_000 }).exhausted, '正常推进不触发');
  check(at({ pages: 10, clicksOnPage: 5, steps: 30, elapsedMs: 1000 }).reason === 'pages', '页数耗尽 → pages');
  check(at({ pages: 1, clicksOnPage: 5, steps: 30, elapsedMs: 5 * 60_000 }).reason === 'time', '时长耗尽 → time');
  check(at({ pages: 1, clicksOnPage: 20, steps: 30, elapsedMs: 1000 }).reason === 'clicksPerPage', '单页点击耗尽 → clicksPerPage');
}

// ---------- 7. 解析失败可区分 ----------
console.log('\n— 解析结果可区分（旧实现静默返回空数组）—');
{
  const ok = parseDump(dump([{ type: 'Button', text: 'x', clickable: true }]));
  const broken = parseDump('{"attributes":');
  const unknown = parseDump('garbage-not-a-dump');
  const noBounds = parseDump(JSON.stringify({ attributes: { type: 'root', clickable: 'false' }, children: [{ attributes: { type: 'Button', text: '无bounds' }, children: [] }] }));
  check(ok.parsed === true && kids(ok).length === 1, '正常 dump → parsed=true 且控件数正确', `kids=${kids(ok).length}`);
  check(broken.parsed === false && Boolean(broken.reason), '截断 JSON → parsed=false 且带原因', (broken.reason ?? '').slice(0, 40));
  check(unknown.parsed === false && unknown.format === 'unknown', '无法识别的格式 → format=unknown', unknown.reason ?? '');
  check(noBounds.parsed === false, '没有可解析 bounds → parsed=false（旧实现返回空数组，无法与空页面区分）', noBounds.reason ?? '');
}

// ---------- 8. Android XML 解析（旧正则强制属性顺序，恒 0 命中）----------
console.log('\n— Android/OpenHarmony XML（旧正则要求 class 在 bounds 之后）—');
{
  // 标准 uiautomator dump 的属性顺序：class 在 bounds 之前、content-desc 在 class 之后
  const xml = `<hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
  <node index="1" text="开始播放" resource-id="com.demo:id/play" class="android.widget.Button" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][400,300]" />
</node>
</hierarchy>`;
  const { nodes, parsed } = parseDump(xml);
  check(parsed === true && nodes.length === 2, '标准 uiautomator XML 能解析出节点（旧正则此处恒 0）', `nodes=${nodes.length}`);
  const btn = nodes.find((n) => n.text === '开始播放');
  check(Boolean(btn) && btn.clickable === true && btn.id === 'com.demo:id/play', '读出 clickable 与 resource-id');
}

// ---------- 9. 空关键词 ----------
console.log('\n— 空关键词（历史缺陷：includes("") 恒真 → 点到第一个控件）—');
{
  const nodes = kids(parseDump(dump([
    { type: 'Button', text: '第一个', clickable: true },
    { type: 'Button', text: '第二个', clickable: true },
  ])));
  check(findKeyword(nodes, '') === undefined, '空关键词返回 undefined（不再误命中）');
  check(findKeyword(nodes, '   ') === undefined, '纯空白关键词同样返回 undefined');
  check(findKeyword(nodes, '第二')?.text === '第二个', '正常关键词仍能命中');
}

// ---------- 10. 覆盖率报告 ----------
console.log('\n— 覆盖率报告 —');
{
  const t = new CoverageTracker({ maxPages: 40, maxMinutes: 20, maxClicksPerPage: 100, maxSwipePerPage: 5 });
  const nodes = kids(parseDump(dump([
    { type: 'Button', id: 'a', clickable: true },
    { type: 'Button', id: 'b', clickable: true },
    { type: 'Text', text: '说明' },
  ])));
  t.seeNodes(nodes);
  t.step();
  t.markClicked(nodes[0]);
  t.markCollected(nodes[0]);
  t.skip('x', 'notInteractive');
  t.skip('y', 'duplicate');
  t.skip('z', 'duplicate');
  t.noteUnparsed('模拟解析失败');
  const r = t.report({ pages: 2, durationMs: 1234, stopReason: 'pages' });
  check(r.interactive.discovered === 2, '发现的交互控件数正确（不含纯展示）', `discovered=${r.interactive.discovered}`);
  check(r.interactive.clicked === 1 && r.interactive.collected === 1, '点击/收录计数正确');
  check(r.skipped.duplicate === 2 && r.skipped.notInteractive === 1, '跳过原因可分别计数', JSON.stringify(r.skipped));
  check(r.unparsedDumps === 1 && r.unparsedReasons.length === 1, '解析失败被记录');
  const h = coverageHealth(r);
  check(!h.ok && h.warnings.length >= 1, '报告体检能标记不可信（有解析失败）', h.warnings[0] ?? '');

  // 页面很多但一个可交互控件都没发现 → 必须告警（对应真实的"界面没起来/格式变了"）
  const t2 = new CoverageTracker({ maxPages: 40, maxMinutes: 20, maxClicksPerPage: 100, maxSwipePerPage: 5 });
  t2.seeNodes(kids(parseDump(dump([{ type: 'Text', text: '只有文字' }]))));
  const h2 = coverageHealth(t2.report({ pages: 3, durationMs: 100, stopReason: 'pages' }));
  check(!h2.ok && h2.warnings.some((w) => w.includes('没有发现任何可交互控件')), '零可交互控件时报告标为不可信', h2.warnings[0] ?? '');
}

// ---------- 11. 系统包名判定（bundle 识别防护） ----------
console.log('\n— 系统/预置包名判定（防止把桌面当成目标应用）—');
{
  // 历史缺陷：包名为空时用库名当 bundle，启动失败停在桌面，
  // 遍历又把 launcher 的 bundleName 采纳为目标应用 → 全部节点按「非目标」过滤 → 0 页 0 控件
  const sys = ['com.ohos.sceneboard', 'com.ohos.settings', 'com.huawei.systemui', 'com.android.systemui'];
  for (const b of sys) check(isSystemBundle(b) === true, `系统包被识别：${b}`);
  for (const b of ['com.openharmony.jsonschemavalidator', 'com.example.demo', 'ohos.samples.lottie']) {
    check(isSystemBundle(b) === false, `业务包不误判：${b}`);
  }
  check(isSystemBundle('') === false && isSystemBundle('notabundle') === false, '空串/非法包名不误判为系统包');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
