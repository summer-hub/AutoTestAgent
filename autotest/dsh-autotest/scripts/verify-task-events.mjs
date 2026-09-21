// 任务轨迹事件流自检（临时 SQLite 库，无设备、无真实 LLM）。
//
// 钉死四件事，每条对应一个真实后果：
//   ① seq 每任务从 1 递增、跨任务互不干扰：编号串库会让前端 afterSeq 增量读错乱；
//   ② ★ 并发追加不丢不重：旧 traceTask 是 SELECT→JSON.parse→push→UPDATE，
//      20 条并发追加会互相覆盖，最终只剩几条（轨迹静默丢失）；
//   ③ tasks.trace 只是快照：快照与事件流必须逐条一致，否则视图和事实对不上；
//   ④ 快照可重建 + afterSeq 增量读：trace 列损坏/丢失不再是数据事故，SSE 也只用拉增量。
// 用法：npm run build && npm run verify:task-events
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-verify-events-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —\n`);

const { appendTrace, readTaskEvents, rebuildTraceSnapshot } = await import('../lib/services/taskEvents.js');

let taskSeq = 0;
async function insertTask() {
  const t = now();
  const res = await db.prepare(
    `INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
     VALUES (?, 'write_cases', ?, NULL, '', '[]', ?, 'pending', 0, ?, ?)`,
  ).run(`T-EV-${Date.now()}-${taskSeq++}`, `事件流自检 ${taskSeq}`, `tr-ev-${taskSeq}`, t, t);
  return Number(res.lastInsertRowid);
}

const taskRow = async (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
// 与 http.ts 的 safeJsonArray 同语义：trace 列损坏时按空数组兜底，不抛错
const snapshotOf = async (id) => {
  try {
    const parsed = JSON.parse((await taskRow(id)).trace || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

// ---------- ① seq 分配与跨任务隔离 ----------
console.log('— seq 分配 / 跨任务隔离 —');
{
  const a = await insertTask();
  const b = await insertTask();
  for (let i = 1; i <= 3; i++) await appendTrace(a, `A${i}`, `详情${i}`);
  for (let i = 1; i <= 2; i++) await appendTrace(b, `B${i}`);

  const ra = await readTaskEvents(a);
  const rb = await readTaskEvents(b);
  check(ra.map((e) => e.seq).join(',') === '1,2,3', '任务 A 的 seq 从 1 连续递增', ra.map((e) => e.seq).join(','));
  check(rb.map((e) => e.seq).join(',') === '1,2', '★ 任务 B 独立从 1 开始（不继承 A 的编号）', rb.map((e) => e.seq).join(','));
  check(ra[0].title === 'A1' && ra[0].detail === '详情1' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ra[0].at),
    '事件的 title/detail/at 原样落库', `${ra[0].title}/${ra[0].detail}/${ra[0].at}`);
  check(ra.every((e) => e.type === 'trace'), '事件类型为 trace', ra.map((e) => e.type).join(','));
}

// ---------- ② 并发追加不丢不重（核心） ----------
console.log('\n— 并发追加不丢不重 —');
{
  const id = await insertTask();
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendTrace(id, `并发 ${i}`, `d${i}`)));

  const events = await readTaskEvents(id);
  const seqs = events.map((e) => e.seq);
  check(events.length === 20, '★ 20 条并发追加后事件流恰好 20 条（旧读改写会互相覆盖丢失）', `实际 ${events.length}`);
  check(new Set(seqs).size === 20, 'seq 无重复（唯一键没被撞）', `${new Set(seqs).size} 个不同值`);
  check(seqs.every((s, i) => s === i + 1), 'seq 恰好是 1..20 无缺口', seqs.join(','));
  const snap = await snapshotOf(id);
  check(snap.length === 20, '快照同样是 20 条（快照没被并发写丢）', `实际 ${snap.length}`);
  const titles = new Set(events.map((e) => e.title));
  check(titles.size === 20, '20 个标题全在（无一条被静默覆盖）', `${titles.size} 个`);
}

// ---------- ③ 快照与事件流一致 ----------
console.log('\n— 快照镜像事件流 —');
{
  const id = await insertTask();
  await appendTrace(id, '任务开始', 'x（write_cases）');
  await appendTrace(id, 'dry-run 通过 · C001', '日志…'.repeat(50));
  const events = await readTaskEvents(id);
  const snap = await snapshotOf(id);
  const same = events.length === snap.length && events.every((e, i) =>
    snap[i].seq === e.seq && snap[i].at === e.at && snap[i].title === e.title && snap[i].detail === e.detail);
  check(same, '★ tasks.trace 与事件流逐条一致（seq/at/title/detail）', `${snap.length} vs ${events.length}`);
}

// ---------- ④ 增量读（afterSeq） ----------
console.log('\n— afterSeq 增量读 —');
{
  const id = await insertTask();
  for (let i = 1; i <= 5; i++) await appendTrace(id, `E${i}`);
  const tail = await readTaskEvents(id, { afterSeq: 3 });
  check(tail.map((e) => e.seq).join(',') === '4,5', 'afterSeq=3 只返回 4、5 两条', tail.map((e) => e.seq).join(','));
  check((await readTaskEvents(id, { afterSeq: 0 })).length === 5, 'afterSeq=0 返回全量', '5');
  check((await readTaskEvents(id, { afterSeq: 99 })).length === 0, 'afterSeq 超过末尾返回空（不是全表）', '0');
  const capped = await readTaskEvents(id, { limit: 2 });
  check(capped.length === 2 && capped[0].seq === 1, 'limit=2 夹紧到前 2 条', capped.map((e) => e.seq).join(','));
  const negative = await readTaskEvents(id, { limit: -1 });
  check(negative.length === 1 && negative[0].seq === 1,
    '★ limit=-1 被夹到 1，不会变成"无限制"（SQLite LIMIT -1 陷阱）', `${negative.length} 条`);
  check((await readTaskEvents(999999)).length === 0, '不存在的任务读事件返回空数组', '0');
}

// ---------- ⑤ 快照可重建 ----------
console.log('\n— 快照可重建（trace 列只是缓存）—');
{
  const id = await insertTask();
  await appendTrace(id, '第一', 'a');
  await appendTrace(id, '第二', 'b');
  await db.prepare(`UPDATE tasks SET trace='[]' WHERE id=?`).run(id);
  check((await snapshotOf(id)).length === 0, '快照已被破坏成空数组', '0');
  const n = await rebuildTraceSnapshot(id);
  const snap = await snapshotOf(id);
  check(n === 2 && snap.length === 2 && snap[1].title === '第二', '★ 从事件流完整重建快照', `${n} 条 / ${snap.map((s) => s.title).join(',')}`);

  await db.prepare(`UPDATE tasks SET trace='not-json-at-all' WHERE id=?`).run(id);
  check((await snapshotOf(id)).length === 0, '损坏成非 JSON 时按空数组兜底（不抛错）', 'safeJsonArray 语义');
  check((await rebuildTraceSnapshot(id)) === 2, '非 JSON 快照也能重建', '2');
}

// ---------- ⑥ 终态后仍能追加（取消现场必须可见） ----------
console.log('\n— 终态后追加 —');
{
  const id = await insertTask();
  await appendTrace(id, '任务开始', 'x');
  await db.prepare(`UPDATE tasks SET status='cancelled', error='已取消' WHERE id=?`).run(id);
  await appendTrace(id, '任务已取消', '用户取消');
  const row = await taskRow(id);
  check(row.status === 'cancelled', '追加轨迹不改任务状态', row.status);
  const snap = await snapshotOf(id);
  check(snap.length === 2 && snap[1].title === '任务已取消', '★ 取消的迟到轨迹照样落进快照（trace 视图看得到取消现场）', snap.map((s) => s.title).join('/'));
}

console.log(`\n${fail === 0 ? '全部自检通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
