// G4：人工队列跨库聚合自检（按「库类别 × 阻塞原因」）。
//
// 为什么值得单独一套：这是"一次解决一类"的规模化前提，而它的失败模式是**静默的**——
//   · 聚合键漏了 kind → 组会无限细分，人仍然要逐个库处理；
//   · libraryCount 没按库去重 → "涉及 3 个库"实际是 1 个库的 3 条，影响面被虚报；
//   · sampleQuestion 取了最旧一条 → 人看到的是过时的动作指引；
//   · library_facts 缺失时静默丢行 → "为什么少了几条"查不出来。
// 四类问题都不报错，只会让聚合视图慢慢变得不可信。
//
// 用法：npm run build && npm run verify:queue-summary
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自检在临时数据目录里跑，绝不碰使用者真实数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-qsum-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb } = await import('../lib/db/connection.js');
const A = await import('../lib/services/automation.js');

await ensureReady();
const db = getDb();

const nowStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 建库 + L0 画像（kind 可选，不给就是 unknown）。 */
async function mkLib(name, kind) {
  const t = nowStr();
  const ins = await db.prepare(`INSERT INTO libraries (name, repo_url, description, current_version, status, created_at, updated_at)
    VALUES (?, ?, '自检用', 'v0.0.0', 'active', ?, ?)`).run(name, `https://example.invalid/${name}`, t, t);
  const id = Number(ins.lastInsertRowid);
  if (kind) {
    await db.prepare(`INSERT INTO library_facts (library_id, kind, kind_reason, confidence, build_target,
      has_submodules, has_binary, binary_kinds, has_demo, entry_file, readme_chars, facts_json,
      resource_candidates_json, readme_intel_json, created_at, updated_at)
      VALUES (?, ?, '自检', 85, 'hap', 0, 0, '', 1, '', 10, '{}', '[]', '[]', ?, ?)`)
      .run(id, kind, t, t);
  }
  return id;
}

/** 建一条人工队列条目。 */
async function mkQueue(libraryId, stage, question, status = 'open') {
  const t = nowStr();
  await db.prepare(`INSERT INTO human_queue (library_id, case_id, stage, reason, question, payload_json, status, resolution, resolved_by, resolved_at, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, '{}', ?, '', '', NULL, ?, ?)`)
    .run(libraryId, stage, `自检阻塞 ${stage}`, question, status, t, t);
}

// ---------- 1. 空队列 ----------
console.log('— 空队列（不报错、不造假组）—');
{
  const s = await A.queueSummary();
  check(s.totals.open === 0, '空队列 open=0');
  check(s.groups.length === 0, '空队列无分组', `groups=${s.groups.length}`);
  check(Object.keys(s.byStage).length === 0 && Object.keys(s.byKind).length === 0, '空队列统计为空');
}

// ---------- 2. 按 (kind, stage) 聚合 ----------
console.log('\n— 按「库类别 × 阻塞原因」聚合 —');
{
  // 3 个动画库（其中 2 个同样卡 env_blocked）、1 个网络库（resource_missing）、
  // 1 个无 L0 画像的库（应为 unknown）
  const animA = await mkLib('anim-a', 'animation');
  const animB = await mkLib('anim-b', 'animation');
  const animC = await mkLib('anim-c', 'animation');
  const netA = await mkLib('net-a', 'network');
  const noFacts = await mkLib('no-facts-lib', null);

  await mkQueue(animA, 'env_blocked', '动画库 A：该用预编译 .so 还是按 ABI 现编？');
  await mkQueue(animB, 'env_blocked', '动画库 B：同样要决策 .so 来源');
  await mkQueue(animC, 'resource_missing', '动画库 C：缺 lottie 测试 json');
  await mkQueue(netA, 'resource_missing', '网络库：需要自签 CA');
  await mkQueue(noFacts, 'toolchain_missing', '无画像库：缺 hvigorw');

  const s = await A.queueSummary();

  // 应有 4 组：(animation,env_blocked) 2 条 / (animation,resource_missing) 1 条 /
  //           (network,resource_missing) 1 条 / (unknown,toolchain_missing) 1 条
  check(s.groups.length === 4, '聚成 4 组（同类别同阻塞才合并）', `groups=${s.groups.length}`);
  check(s.totals.open === 5, 'open 总数正确', `open=${s.totals.open}`);
  check(s.totals.groups === 4, '组数统计正确', `groups=${s.totals.groups}`);
  check(s.totals.libraries === 5, '涉及库数去重后为 5', `libraries=${s.totals.libraries}`);

  // (animation, env_blocked) 应为最大组，排第一（影响面优先）
  const g0 = s.groups[0];
  check(g0.kind === 'animation' && g0.stage === 'env_blocked',
    '最大组排最前（影响面优先）', `${g0.kind}::${g0.stage}`);
  check(g0.count === 2, '该组 2 条', `count=${g0.count}`);
  check(g0.libraryCount === 2, '该组涉及 2 个库（去重）', `libraryCount=${g0.libraryCount}`);
  check(g0.libraries.length === 2, '库清单含 2 个', JSON.stringify(g0.libraries.map((l) => l.name)));
  check(g0.libraries.every((l) => l.name.startsWith('anim-')), '库名正确（不是 #id 占位）',
    g0.libraries.map((l) => l.name).join(','));

  // 无 L0 画像的库 → kind=unknown，且如实标注而不是静默丢弃
  const gUnknown = s.groups.find((g) => g.kind === 'unknown');
  check(!!gUnknown, '无画像库归入 unknown 组（不静默丢行）');
  check(gUnknown?.stage === 'toolchain_missing', 'unknown 组的阻塞类别正确');
  check(s.byKind.unknown === 1, 'byKind 统计含 unknown', JSON.stringify(s.byKind));

  // stage 标签必须来自 BLOCKER_LABEL（前端直接显示，不能是英文 key）
  for (const g of s.groups) {
    check(g.stageLabel === (A.BLOCKER_LABEL[g.stage] ?? g.stage),
      `组带中文标签：${g.stage}`, g.stageLabel);
  }

  // byStage / byKind 汇总
  check(s.byStage.env_blocked === 2 && s.byStage.resource_missing === 2 && s.byStage.toolchain_missing === 1,
    'byStage 汇总正确', JSON.stringify(s.byStage));
  check(s.byKind.animation === 3 && s.byKind.network === 1, 'byKind 汇总正确', JSON.stringify(s.byKind));

  // 排序：count 降序 → libraryCount 降序
  for (let i = 1; i < s.groups.length; i++) {
    const prev = s.groups[i - 1], cur = s.groups[i];
    const okOrder = prev.count > cur.count
      || (prev.count === cur.count && prev.libraryCount >= cur.libraryCount);
    check(okOrder, `排序单调（第 ${i} 组不违反 count↓/libraryCount↓）`,
      `${prev.count}/${prev.libraryCount} → ${cur.count}/${cur.libraryCount}`);
  }
}

// ---------- 3. sampleQuestion 取最新一条 ----------
console.log('\n— sampleQuestion 取最新一条（人看到的是当前动作指引）—');
{
  // SQL 按 id DESC 排序，第一次遇到即最新。这里连建两条，第二条 id 更大。
  // 注意：用 (animation, device_blocked) 这个**未被前面小节占用**的组合，
  // 否则会和前面的累积数据混在一起，断言就说不清是在测什么了。
  const lib = await mkLib('sample-lib', 'animation');
  await mkQueue(lib, 'device_blocked', '旧的问题描述（不该被选为代表）');
  await mkQueue(lib, 'device_blocked', '新的问题描述（应该是代表）');
  const s = await A.queueSummary();
  const g = s.groups.find((x) => x.kind === 'animation' && x.stage === 'device_blocked');
  check(!!g && g.sampleQuestion.includes('新的问题描述'),
    'sampleQuestion 取最新一条', g?.sampleQuestion);
  check(!!g && !g.sampleQuestion.includes('旧的问题描述'), '不代表旧条目');
  check(!!g && g.count === 2 && g.libraryCount === 1,
    '同库 2 条聚成 1 组、libraryCount=1（不虚报影响面）',
    `count=${g?.count} libs=${g?.libraryCount}`);
}

// ---------- 4. status 过滤与 limit ----------
console.log('\n— status 过滤 / limit / 已解决不入组 —');
{
  const lib = await mkLib('status-lib', 'storage');
  await mkQueue(lib, 'env_blocked', '待处理条目');
  await mkQueue(lib, 'env_blocked', '已解决条目', 'resolved');

  const openOnly = await A.queueSummary({ status: 'open' });
  const gOpen = openOnly.groups.find((g) => g.kind === 'storage' && g.stage === 'env_blocked');
  check(gOpen?.count === 1, '默认只统计 open（已解决不入组）', `count=${gOpen?.count}`);

  const all = await A.queueSummary({ status: 'resolved' });
  const gRes = all.groups.find((g) => g.kind === 'storage' && g.stage === 'env_blocked');
  check(gRes?.count === 1, '可切到 resolved 视角（排查用）', `count=${gRes?.count}`);
  check(all.totals.open === 1, '切视角后 open 语义仍准确', `open=${all.totals.open}`);

  // limit 生效（且不应把组数算错——limit 限制的是扫描行数）
  const limited = await A.queueSummary({ limit: 2 });
  check(limited.totals.open <= 2, 'limit 限制扫描行数', `open=${limited.totals.open}`);
  check(limited.groups.length <= limited.totals.open, '组数不超过行数');
}

// ---------- 5. 库清单上限（一组几百个库不刷屏）----------
console.log('\n— 库清单上限与 libraryCount 真实性 —');
{
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await mkLib(`many-${i}`, 'codec'));
  for (const id of ids) await mkQueue(id, 'env_blocked', `codec 库 ${id} 的 .so 决策`);
  const s = await A.queueSummary();
  const g = s.groups.find((x) => x.kind === 'codec' && x.stage === 'env_blocked');
  check(!!g, '找到 codec 组');
  check(g.count === 12, '该组 12 条', `count=${g?.count}`);
  check(g.libraryCount === 12, 'libraryCount 是真实去重值（不受清单上限影响）', `libraryCount=${g?.libraryCount}`);
  check(g.libraries.length === 8, '库清单截到 8 个（避免刷屏）', `listed=${g?.libraries.length}`);
}

// ---------- 汇总 ----------
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
