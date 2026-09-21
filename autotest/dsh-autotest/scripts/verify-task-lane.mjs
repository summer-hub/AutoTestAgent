// 任务 lane / 抢占锁 / 取消语义自检（临时 SQLite 库，无设备、无真实 LLM —— llm 用可 Observ 的假实现）。
//
// 钉死四件事，每条对应一个真实后果：
//   ① 同库串行、跨库并行：无串行时同库两个任务互相踩 git 工作区与用例表（旧行为）；
//   ② 抢占锁：重试接口/并发创建让同一任务跑两份 → trace 交错、结果互相覆盖（旧行为）；
//   ③ 取消（排队中）：出队即终态，不进执行器；
//   ④ 取消（运行中）/ 插件卸载：abort 贯穿 LLM 与子进程，终态不被迟到的执行结果覆盖。
// 用法：npm run build && npm run verify:task-lane
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-verify-lane-'));
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

const { enqueueTask, cancelTask, stopAllTaskLanes } = await import('../lib/services/taskLane.js');
const { runTask } = await import('../lib/services/executor.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 LLM：按 delay 耗时后返回固定文本；signal abort 立即拒绝（模拟 ctx.llm.stream 的可中断性）。 */
function makeFakeLlm({ delay = 200, text = 'not-json-at-all' } = {}) {
  const llm = async (input) => {
    // 与 makeLlm 一致：调用前已 abort 就直接失败，不进入调用
    if (input.signal?.aborted) throw new Error('aborted');
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      input.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
    return { text, provider: 'fake', model: 'fake', latencyMs: delay, attempts: 1 };
  };
  return { llm };
}

let taskSeq = 0;
async function insertTask(libraryId) {
  const t = now();
  const res = await db.prepare(
    `INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
     VALUES (?, 'write_cases', ?, ?, '', '[]', ?, 'pending', 0, ?, ?)`,
  ).run(`T-LANE-${Date.now()}-${taskSeq++}`, `lane 自检 ${taskSeq}`, libraryId, `tr-lane-${Date.now()}-${taskSeq}`, t, t);
  return Number(res.lastInsertRowid);
}

async function insertLib(name) {
  const t = now();
  const res = await db.prepare(
    `INSERT INTO libraries (name, repo_url, repo_subpath, description, created_at, updated_at) VALUES (?, '', '', '自检库', ?, ?)`,
  ).run(name, t, t);
  return Number(res.lastInsertRowid);
}

const taskRow = async (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const traceOf = async (id) => JSON.parse((await taskRow(id)).trace || '[]');
const traceAt = async (id, title) => {
  const e = (await traceOf(id)).find((x) => x.title === title);
  return e ? Date.parse(e.at.replace(' ', 'T') + 'Z') : 0;
};

// write_cases 走 llmJson：假 llm 返回非 JSON → 容错解析 + 回灌修复都失败 → 任务以 failed 终态。
// 这条路径不碰设备、不写用例表，只验证 lane/锁/取消的编排语义。

// ---------- ① 同库串行 ----------
console.log('— 同库串行 / 跨库并行 —');
{
  const libA = await insertLib('lane-lib-a');
  const libB = await insertLib('lane-lib-b');
  const { llm } = makeFakeLlm({ delay: 700 });
  const a1 = await insertTask(libA);
  const a2 = await insertTask(libA);   // 同库 → 必须排在 a1 后面
  const b1 = await insertTask(libB);   // 跨库 → 应与 a1 并行

  enqueueTask(a1, libA, llm);
  enqueueTask(a2, libA, llm);
  enqueueTask(b1, libB, llm);

  await sleep(6000); // 同库两个串行（各约 1.5s）+ 余量
  const [r1, r2, r3] = [await taskRow(a1), await taskRow(a2), await taskRow(b1)];
  check(r1.status === 'failed' && r2.status === 'failed' && r3.status === 'failed',
    '三个任务都到达终态（failed：假 llm 不返回 JSON）',
    `${r1.status}/${r2.status}/${r3.status}`);

  const startA2 = await traceAt(a2, '任务开始');
  const endA1 = await traceAt(a1, '任务失败');
  check(startA2 >= endA1, '★ 同库第二个任务在第一个终态之后才开始（串行）', `a2.start=${startA2} a1.end=${endA1}`);

  const startB1 = await traceAt(b1, '任务开始');
  const startA1 = await traceAt(a1, '任务开始');
  check(startB1 > 0 && startB1 <= endA1, '★ 跨库任务不等同库任务结束（并行）', `b1.start=${startB1} a1.end=${endA1}`);
  check(startA1 > 0 && Math.abs(startB1 - startA1) < 2000, '并行任务几乎同时开始（差距 < 2s）', `${Math.abs(startB1 - startA1)}ms`);
}

// ---------- ② 抢占锁 ----------
console.log('\n— 抢占锁（防重试/并发创建跑两份）—');
{
  const { llm } = makeFakeLlm({ delay: 50 });
  const id = await insertTask(null);
  // 手工置 running 模拟「已有实例在执行」，直接调 runTask 必须被抢占锁挡掉
  await db.prepare(`UPDATE tasks SET status='running', trace='[]', updated_at=? WHERE id=?`).run(now(), id);
  const before = (await taskRow(id)).updated_at;
  await sleep(30);
  await runTask(id, llm);
  const after = await taskRow(id);
  check(after.status === 'running' && after.updated_at === before,
    '★ status 已是 running 时 runTask 直接跳过（不重复执行、不写 trace）',
    `status=${after.status} touched=${after.updated_at !== before}`);
  check((await traceOf(id)).length === 0, '被抢占锁挡下的调用不留任何轨迹');
}

// ---------- ③ 取消（排队中） ----------
console.log('\n— 取消：排队中出队即终态 —');
{
  const lib = await insertLib('lane-lib-cancel');
  const { llm } = makeFakeLlm({ delay: 600 });
  const first = await insertTask(lib);
  const second = await insertTask(lib);   // 排在 first 后面
  enqueueTask(first, lib, llm);
  enqueueTask(second, lib, llm);
  await sleep(100);                        // first 已开跑，second 仍在队列

  const r = await cancelTask(second);
  check(r === 'cancelled', '排队中取消返回 cancelled', r);
  const row = await taskRow(second);
  check(row.status === 'cancelled', '★ 排队任务直接置 cancelled（不进执行器）', row.status);
  check((await traceOf(second)).length === 0, '排队取消的任务从未开始执行（无任何轨迹）');

  // 队头任务不受影响，正常跑到终态
  await sleep(4000);
  check((await taskRow(first)).status === 'failed', '同一 lane 的队头任务不受取消影响，正常终态', (await taskRow(first)).status);
}

// ---------- ④ 取消（运行中） ----------
console.log('\n— 取消：运行中 abort 贯穿 LLM —');
{
  const lib = await insertLib('lane-lib-running');
  const { llm } = makeFakeLlm({ delay: 3000 });
  const id = await insertTask(lib);
  enqueueTask(id, lib, llm);
  await sleep(200);                        // 已进入第一次 llm 调用

  const r = await cancelTask(id);
  check(r === 'cancelled', '运行中取消返回 cancelled', r);
  await sleep(500);                        // 等 abort 传播到执行器收尾

  const row = await taskRow(id);
  check(row.status === 'cancelled', '★ 运行中取消：终态保持 cancelled（迟到的执行结果不覆盖）', row.status);
  check(row.error === '已取消', '取消原因落库', row.error);
  const titles = (await traceOf(id)).map((e) => e.title);
  check(titles.includes('任务已取消'), '轨迹记录「任务已取消」', titles.join('/'));
}

// ---------- ⑤ 插件卸载：abort 后落 failed 收尾 ----------
console.log('\n— 插件卸载：abort 全部 lane—');
{
  const lib = await insertLib('lane-lib-dispose');
  const { llm } = makeFakeLlm({ delay: 3000 });
  const id = await insertTask(lib);
  enqueueTask(id, lib, llm);
  await sleep(200);
  stopAllTaskLanes();
  await sleep(500);

  const row = await taskRow(id);
  check(row.status === 'failed', '★ 卸载 abort 的任务落 failed 收尾（不留给 reaper 盲扫）', row.status);
  check(String(row.error).startsWith('已取消'), '错误信息标明取消原因', row.error);
}

// ---------- ⑥ 幂等与边界 ----------
console.log('\n— 边界 —');
{
  const lib = await insertLib('lane-lib-edge');
  const { llm } = makeFakeLlm({ delay: 30 });
  const id = await insertTask(lib);
  enqueueTask(id, lib, llm);
  await sleep(2000);                       // 已终态（failed）
  const r = await cancelTask(id);
  check(r === 'already_finished', '终态任务取消返回 already_finished（400 由 API 层翻译）', r);
  check((await taskRow(id)).status === 'failed', '终态不被取消改写', (await taskRow(id)).status);

  const r2 = await cancelTask(999999);
  check(r2 === 'not_found', '不存在的任务返回 not_found', r2);

  // cancelled 任务可重试（retry 先置 pending 再入队）
  const cid = await insertTask(null);
  await db.prepare(`UPDATE tasks SET status='cancelled', error='已取消', updated_at=? WHERE id=?`).run(now(), cid);
  await db.prepare(`UPDATE tasks SET status='pending', progress=0, error=NULL, updated_at=? WHERE id=?`).run(now(), cid);
  enqueueTask(cid, null, llm);
  await sleep(2000);
  check((await taskRow(cid)).status === 'failed', 'cancelled → pending → 重跑链路正常（到达终态）', (await taskRow(cid)).status);
}

stopAllTaskLanes();
console.log(`\n${fail === 0 ? '全部自检通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
