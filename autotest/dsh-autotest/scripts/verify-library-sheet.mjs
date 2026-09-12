// 三方库测试表（xlsx）解析与同步计划的离线自检（无设备、无 LLM、无 DB）。
//
// 为什么值得单独一套：表是**人**维护的，脏数据是常态（空行、重名、缺 URL、多一行合计）。
// 解析要"要么读对、要么带行号报出来"，绝不能静默少几行 —— 269 行的表少一行没人会发现。
// 同步计划则是落库前的最后一道闸：判错就会把 269 个库写错，或者把 Agent 补的包名冲掉。
//
// 用法：npm run build && npm run verify:sheet
import { findHeader, parseLibrarySheet, diffLibrarySheet } from '../lib/services/librarySheet.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const MONO = 'https://gitcode.com/CPF-ApplicationTPC/openharmony_tpc_samples';

// ---------- 1. 表头定位 ----------
console.log('— 表头定位（列序/标题行都不能读死）—');
{
  const h1 = findHeader([['三方库名称', 'URL'], ['a', 'u']]);
  check(h1?.row === 1 && h1.nameCol === 0 && h1.urlCol === 1, '标准表头：第 1 行 A/B', JSON.stringify(h1));

  const h2 = findHeader([['三方库清单', ''], ['序号', 'URL', '三方库名称'], ['1', 'u', 'a']]);
  check(h2?.row === 2 && h2.nameCol === 2 && h2.urlCol === 1, '有标题行 + 列序调换也能定位', JSON.stringify(h2));

  const h3 = findHeader([['名称', '仓库地址'], ['a', 'u']]);
  check(h3?.row === 1 && h3.nameCol === 0 && h3.urlCol === 1, '别名表头（名称/仓库地址）可识别', JSON.stringify(h3));

  const h4 = findHeader([['随便', '写点', '东西'], ['a', 'b', 'c']]);
  check(h4 === null, '找不到表头时返回 null（调用方退回默认排布）');
  const p4 = parseLibrarySheet([['随便', '写点'], ['a', 'https://gitcode.com/o/r']]);
  check(p4.entries.length === 1 && p4.entries[0].name === 'a', '无表头时按"首行表头 + 前两列"兜底');
}

// ---------- 2. 解析与脏行报告 ----------
console.log('\n— 解析与脏行报告（每一行都要有交代）—');
{
  const rows = [
    ['三方库名称', 'URL'],
    ['adler-32', `${MONO}/tree/master/Adler32Demo`],
    ['aki', 'https://gitcode.com/CPF-ApplicationTPC/aki'],
    ['', `${MONO}/tree/master/ohos_adaptivecards`],          // 缺库名（真实数据第 270 行就是这样）
    ['cbor-js', `${MONO}/tree/master/cborjsDemo`],
    ['cborjsDemo', `${MONO}/tree/master/cborjsDemo`],          // 与上面同 URL（真实数据也确实如此）
    ['dupname', 'https://gitcode.com/o/r1'],
    ['dupname', 'https://gitcode.com/o/r2'],                   // 重名
    ['nourl', ''],                                             // 缺 URL
    ['ftp-lib', 'ftp://example.com/x'],                        // 非 http(s)
    ['', ''],                                                  // 纯空行 → 忽略
    ['x'.repeat(200), 'https://gitcode.com/o/long'],           // 库名过长
    ['合计', ''],                                              // 人加的小计行 → 应被报出来
  ];
  const r = parseLibrarySheet(rows);
  // 有效库：adler-32 / aki / cbor-js / cborjsDemo / dupname(第一次出现) = 5 条
  check(r.entries.length === 5, '只解析出 5 个有效库', `entries=${r.entries.length}`);
  check(r.entries[0].name === 'adler-32' && r.entries[0].repoSubpath === 'Adler32Demo',
    '/tree/<分支>/<子目录> 拆出子目录', JSON.stringify(r.entries[0]));
  check(r.entries[1].name === 'aki' && r.entries[1].repoSubpath === '',
    '仓库根地址：子目录为空', JSON.stringify(r.entries[1]));
  check(r.entries[2].name === 'cbor-js' && r.entries[3].name === 'cborjsDemo',
    '不同库名指向同一 URL 时都保留（一个 demo 可覆盖多个库）');

  // xlsx 行号 = 数组下标 + 1（第 1 行是表头）
  const byRow = (n) => r.problems.find((p) => p.row === n);
  check(byRow(4)?.reason.includes('缺少库名'), '第 4 行缺库名 → 报出行号', byRow(4)?.reason);
  check(byRow(8)?.reason.includes('库名重复'), '第 8 行重名 → 报出并与第 7 行关联', byRow(8)?.reason);
  check(byRow(9)?.reason.includes('缺少仓库地址'), '第 9 行缺 URL → 报出', byRow(9)?.reason);
  check(byRow(10)?.reason.includes('不是 http'), '第 10 行非 http(s) 地址 → 报出', byRow(10)?.reason);
  check(byRow(12)?.reason.includes('过长'), '第 12 行库名超长 → 报出', byRow(12)?.reason);
  check(byRow(13)?.reason.includes('缺少仓库地址'), '人加的「合计」行也会被报出来（而不是静默吞掉）', byRow(13)?.reason);
  check(!r.problems.some((p) => p.row === 11), '纯空行不产生噪音问题');
  check(r.problems.length === 6, '问题恰好 6 条', `problems=${r.problems.length}`);
  check(r.entries.every((e) => e.row > 1), '每条记录带原始 xlsx 行号（供人回表里核对）');
}

// ---------- 3. 同步计划 ----------
console.log('\n— 同步计划（新增/更新/无变化/仅库中存在）—');
{
  const entries = [
    { row: 2, name: 'brand-new', repoUrl: 'https://gitcode.com/o/new.git', repoSubpath: '' },
    { row: 3, name: 'url-changed', repoUrl: 'https://gitcode.com/o/newurl.git', repoSubpath: 'sub' },
    { row: 4, name: 'same', repoUrl: 'https://gitcode.com/o/same.git', repoSubpath: 'sub' },
    // 历史行：库里存的是带 /tree/... 的原始地址，而且子目录列是空的（拆分迁移之前建的库）
    { row: 5, name: 'legacy-tree-url', repoUrl: 'https://gitcode.com/o/same.git', repoSubpath: 'sub' },
  ];
  const existing = [
    { id: 7, name: 'legacy-tree-url', repo_url: 'https://gitcode.com/o/same/tree/master/sub', repo_subpath: '', package_name: 'com.a.b', case_count: 3 },
    { id: 8, name: 'url-changed', repo_url: 'https://gitcode.com/o/oldurl.git', repo_subpath: '', package_name: 'com.c.d', case_count: 0 },
    { id: 9, name: 'same', repo_url: 'https://gitcode.com/o/same.git', repo_subpath: 'sub', package_name: 'com.e.f', case_count: 0 },
    { id: 10, name: 'db-only-lib', repo_url: 'https://gitcode.com/o/dbonly.git', repo_subpath: '', package_name: 'com.g.h', case_count: 5 },
  ];
  const plan = diffLibrarySheet(entries, existing);

  check(plan.added.length === 1 && plan.added[0].name === 'brand-new', '新库进 added', JSON.stringify(plan.added));
  check(plan.updated.length === 2 && plan.updated.some((u) => u.name === 'url-changed'),
    '地址变化的库进 updated', JSON.stringify(plan.updated.map((u) => u.name)));
  check(plan.updated.find((u) => u.name === 'url-changed')?.from.repoUrl === 'https://gitcode.com/o/oldurl.git'
    && plan.updated.find((u) => u.name === 'url-changed')?.to.repoSubpath === 'sub',
    'updated 带旧值→新值（供人核对）');
  // 历史行：地址归一化后虽然相等，但子目录列还是空的 → 必须判为需要更新（正是子目录迁移该补的值）
  const legacy = plan.updated.find((u) => u.name === 'legacy-tree-url');
  check(!!legacy && legacy.from.repoSubpath === '' && legacy.to.repoSubpath === 'sub',
    '历史 /tree/ 地址那行：地址相同但子目录为空 → 判为需要补写（不遗漏迁移）', JSON.stringify(legacy));
  check(plan.unchanged.length === 1 && plan.unchanged[0].name === 'same', '完全一致的库进 unchanged',
    JSON.stringify(plan.unchanged.map((u) => u.name)));
  check(plan.dbOnly.length === 1 && plan.dbOnly[0].name === 'db-only-lib',
    '表里没有但库里有 → dbOnly（只报告，绝不自动删）', JSON.stringify(plan.dbOnly.map((d) => d.name)));
  check(plan.dbOnly[0]?.caseCount === 5, 'dbOnly 带用例数（让人知道删掉会丢什么）');

  // 最关键的行为保证：计划里只出现「人维护的两列」，包名/入口 Ability 根本不在写入面上
  check(plan.added.every((a) => Object.keys(a).join() === 'name,repoUrl,repoSubpath,row'), 'added 只带库名与仓库两列');
  check(plan.updated.every((u) => Object.keys(u.to).join() === 'repoUrl,repoSubpath'), 'updated 只改「人维护的两列」');
  check(!JSON.stringify(plan.updated.map((u) => u.to)).includes('packageName'),
    '计划里不出现 packageName（Agent 字段不参与同步）');

  // 幂等：把本次更新的结果当作新状态再 diff 一次，必须全部变成 unchanged。
  // 否则每次同步都会重写一遍 269 行，updated 列表也永远不收敛，人就没法用它判断"表到底改了什么"。
  const after = existing.map((l) => {
    const u = plan.updated.find((x) => x.id === l.id);
    return u ? { ...l, repo_url: u.to.repoUrl, repo_subpath: u.to.repoSubpath } : l;
  });
  const again = diffLibrarySheet(entries, [...after, { id: 11, name: 'brand-new', repo_url: 'https://gitcode.com/o/new.git', repo_subpath: '', package_name: '', case_count: 0 }]);
  check(again.added.length === 0 && again.updated.length === 0 && again.unchanged.length === 4,
    '同步一次后再同步：0 新增 0 更新（幂等，可反复点）',
    `added=${again.added.length} updated=${again.updated.length} unchanged=${again.unchanged.length}`);

  const same = diffLibrarySheet(entries, existing);
  check(JSON.stringify(same) === JSON.stringify(plan), '同一输入两次 diff 结果完全一致（预览与执行必然对齐）');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
