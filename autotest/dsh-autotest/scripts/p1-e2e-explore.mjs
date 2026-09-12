// P1 端到端验收：对已安装的 json-schema demo 真机跑一次完整遍历，输出覆盖率报告。
// 用法：node scripts/p1-e2e-explore.mjs [maxPages] [bundle]
//   bundle 传错（例如库名本身）时，用于验证「不把桌面当目标应用」的防护确实生效。
import fs from 'node:fs';

const MAX_PAGES = Number(process.argv[2] || 12);
const BUNDLE = process.argv[3] || 'com.openharmony.jsonschemavalidator';
const LIB_NAME = 'json-schema';

const { ensureReady } = await import('../lib/db/connection.js');
const { listTargets } = await import('../lib/services/hdc.js');
const { exploreApp, saveExploreReport, ensureDeviceOnline } = await import('../lib/services/uiExplorer.js');

await ensureReady();   // 载入 settings（工作区路径等）

const targets = await listTargets();
const serial = targets[0];
if (!serial) { console.error('没有在线设备'); process.exit(1); }
if (!(await ensureDeviceOnline(serial))) { console.error(`设备 ${serial} 不在线`); process.exit(1); }

console.log(`=== P1 端到端遍历 ===`);
console.log(`设备: ${serial}`);
console.log(`应用: ${BUNDLE}`);
console.log(`预算: maxPages=${MAX_PAGES} maxMinutes=6 maxClicksPerPage=30 maxSwipePerPage=4\n`);

const t0 = Date.now();
const result = await exploreApp(serial, BUNDLE, {
  maxPages: MAX_PAGES,
  maxMinutes: 6,
  maxClicksPerPage: 30,
  maxSwipePerPage: 4,
});

const saved = saveExploreReport(LIB_NAME, result);
const c = result.coverage;

console.log(`\n================ 覆盖率报告 ================`);
console.log(`  页面收录        ${c.pages}`);
console.log(`  动作步数        ${c.steps}`);
console.log(`  耗时            ${Math.round(c.durationMs / 1000)}s`);
console.log(`  见过节点(累计)   ${c.nodesSeen}`);
console.log(`  交互控件 发现    ${c.interactive.discovered}`);
console.log(`          点击    ${c.interactive.clicked}`);
console.log(`          收录    ${c.interactive.collected}`);
console.log(`  dump 解析失败    ${c.unparsedDumps}${c.unparsedReasons.length ? ' · ' + c.unparsedReasons[0].slice(0, 60) : ''}`);
console.log(`  停止原因        ${c.stopReason}`);
console.log(`  未处理原因分布   ${JSON.stringify(c.skipped)}`);
if (result.warnings?.length) {
  console.log(`\n================ 遍历告警（结果不可信）================`);
  for (const w of result.warnings) console.log(`  ! ${w}`);
}

console.log(`\n================ 页面与控件 ================`);
for (const p of result.pages) {
  const kinds = {};
  for (const ctl of p.controls) kinds[ctl.kind] = (kinds[ctl.kind] || 0) + 1;
  const clickable = p.controls.filter((x) => x.clickable || x.longClickable || x.checkable).length;
  console.log(`  [${p.path.join(' → ')}]`);
  console.log(`     控件 ${p.controls.length}（可交互 ${clickable}）· 类别 ${JSON.stringify(kinds)}${p.scrolls ? ` · 滚动 ${p.scrolls} 屏` : ''}${p.animation ? ' · 检测到越界动画' : ''}`);
}
console.log(`\n报告已保存: ${saved}`);
console.log(`操作轨迹 ${result.ops.length} 条，最后 8 条：`);
for (const o of result.ops.slice(-8)) console.log(`   ${o.at} ${o.action}${o.detail ? ' · ' + o.detail.slice(0, 90) : ''}`);
console.log(`\n总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
