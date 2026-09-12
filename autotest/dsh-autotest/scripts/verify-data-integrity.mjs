// 数据层自检：不连 MySQL、不调 LLM、不需要设备，纯 SQLite 临时库验证"数据不会丢/不会漂"。
//  1. 事务隔离：事务外的并发写入不得被事务的 ROLLBACK 一起回滚
//  2. 事务串行：两个交叠事务都能成功（不得抛 "cannot start a transaction within a transaction"）
//  3. 归档链路：executions_archive 与 executions 列必须一一对应（列漂移会让归档永久失败）
//  4. 配置键：种子不得把工作区写死为开发机绝对路径
// 用法：npm run build && npm run verify:data
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-verify-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb, transaction, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —\n`);

// 独立探针表，避免污染业务表
await db.exec(`CREATE TABLE IF NOT EXISTS tx_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL)`);
await db.exec(`DELETE FROM tx_probe`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tags = async () => (await db.prepare('SELECT tag FROM tx_probe ORDER BY id').all()).map((r) => r.tag);

// ---------- 1. 隔离性：事务外写入不被回滚 ----------
console.log('— 事务隔离 —');
const txOutcome = await transaction(async () => {
  await db.prepare('INSERT INTO tx_probe (tag) VALUES (?)').run('A-inside');
  await sleep(60);                 // 让并发请求有机会插进来（旧实现会把它的写入卷进本事务）
  await db.prepare('INSERT INTO tx_probe (tag) VALUES (?)').run('A-inside-2');
  throw new Error('boom');         // 故意失败 → 事务内两条都应被回滚
}).then(() => null, (e) => e.message);

await (async () => {
  await sleep(20);                 // 等事务先开起来
  await db.prepare('INSERT INTO tx_probe (tag) VALUES (?)').run('B-outside');
})();

const after1 = await tags();
check(txOutcome === 'boom', '事务内异常按预期抛出', `(${txOutcome})`);
check(!after1.includes('A-inside') && !after1.includes('A-inside-2'), '事务内写入被完整回滚', `rows=${JSON.stringify(after1)}`);
check(after1.includes('B-outside'), '事务外的并发写入未随事务回滚（隔离性成立）', `rows=${JSON.stringify(after1)}`);

// ---------- 2. 串行化：交叠事务不再互相打断 ----------
console.log('\n— 事务串行 —');
await db.exec(`DELETE FROM tx_probe`);
const runTx = (tag, delay) => transaction(async () => {
  await db.prepare('INSERT INTO tx_probe (tag) VALUES (?)').run(tag);
  await sleep(delay);
});
const results = await Promise.allSettled([runTx('T1', 40), runTx('T2', 5), runTx('T3', 20)]);
const rejected = results.filter((r) => r.status === 'rejected');
check(rejected.length === 0, '三个交叠事务全部成功（无嵌套 BEGIN 报错）',
  rejected.map((r) => r.reason?.message).join(' | '));
const after2 = await tags();
check(after2.length === 3, '三个事务的写入全部落库（无互相覆盖）', `rows=${JSON.stringify(after2)}`);

// ---------- 3. 归档列对齐 ----------
console.log('\n— 归档链路 —');
const cols = async (t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).map((c) => c.name);
const execCols = await cols('executions');
const archCols = await cols('executions_archive');
const missing = execCols.filter((c) => !archCols.includes(c));
check(missing.length === 0, 'executions_archive 覆盖 executions 的全部列', missing.length ? `缺失: ${missing.join(',')}` : '');

// 真跑一次归档：插一条 1 年前的执行记录，归档后应迁移成功而不是抛错
const hasTraceCol = archCols.includes('trace_id');
const marker = hasTraceCol ? 'tr-verify' : 'verify-no-trace-col';
if (hasTraceCol) {
  await db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, thinking, logs, started_at, finished_at)
    VALUES (NULL, 1, 1, NULL, 'passed', '[]', ?, '', '', ?, ?)`).run(marker, '2020-01-01 00:00:00', '2020-01-01 00:00:01');
} else {
  // 列漂移状态：仍要验证归档本身不会崩（用唯一 logs 做标记）
  await db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, thinking, logs, started_at, finished_at)
    VALUES (NULL, 1, 1, NULL, 'passed', '[]', '', '', ?, ?, ?)`).run(marker, '2020-01-01 00:00:00', '2020-01-01 00:00:01');
}
const { archiveOldExecutions } = await import('../lib/services/archive.js');
let archived = -1;
let archiveErr = '';
try { archived = await archiveOldExecutions(6); } catch (e) { archiveErr = e.message; }
check(archiveErr === '' && archived >= 1, 'archiveOldExecutions 能真正归档旧记录',
  archiveErr ? `抛错: ${archiveErr}` : `归档 ${archived} 条`);
const probeCol = hasTraceCol ? 'trace_id' : 'logs';
const archivedRow = await db.prepare(`SELECT id FROM executions_archive WHERE ${probeCol} = ?`).get(marker);
check(Boolean(archivedRow), '归档记录已落入 executions_archive');
check(!(await db.prepare(`SELECT id FROM executions WHERE ${probeCol} = ?`).get(marker)), '归档后主表已清理该记录');

// ---------- 4. 种子配置键 ----------
console.log('\n— 种子配置 —');
const ws = await db.prepare(`SELECT value FROM settings WHERE key = 'app.workspace'`).get();
check(ws === undefined, '种子不得写入 app.workspace（应由使用者在系统配置里显式设定）',
  ws ? `实际写入: ${ws.value}` : '');

// ---------- 5. 密钥脱敏（出参打码 + 入参防回写） ----------
console.log('\n— 密钥脱敏 —');
const { maskSecret, maskUrlPassword, isMaskedSecret, resolveSecretInput } = await import('../lib/services/secrets.js');
const { getAllSettings, getSetting, setSetting } = await import('../lib/services/settings.js');

const url = 'mysql://root:s3cretPwd@127.0.0.1:3306/autotest';
const maskedUrl = maskUrlPassword(url);
check(!maskedUrl.includes('s3cretPwd'), 'URL 掩码不泄漏口令', `→ ${maskedUrl}`);
check(maskedUrl.includes('127.0.0.1:3306/autotest'), 'URL 掩码保留 host/库名可读性');
const maskedKey = maskSecret('sk-abcdefghijklmnop');
check(!maskedKey.includes('abcdefghijklmnop') && maskedKey.endsWith('mnop'), '密钥掩码只留末 4 位', `→ ${maskedKey}`);
check(isMaskedSecret(maskedKey) && isMaskedSecret(maskedUrl) && !isMaskedSecret(url), '掩码识别正确');

setSetting('db.mysqlUrl', url);
// 把工作区也指到临时目录：llmJson 解析失败会落盘原始输出，避免污染仓库目录
setSetting('app.workspace', tmpDir);
const listed = getAllSettings().find((r) => r.key === 'db.mysqlUrl');
check(!String(listed.value).includes('s3cretPwd'), 'GET /settings 出参已脱敏');
check(getSetting('db.mysqlUrl', '') === url, '内部 getSetting 仍能拿到真实口令（脱敏只作用于出参）');

check(resolveSecretInput(maskedUrl, url) === url, '掩码原样回传 → 不改动真实凭据（防回写）');
check(resolveSecretInput(undefined, url) === url, '字段缺省 → 不改动真实凭据');
check(resolveSecretInput('', url) === '', '显式空串 → 允许清空');
check(resolveSecretInput('mysql://u:new@h/db', url) === 'mysql://u:new@h/db', '新值 → 正常采用');


// ---------- 6. 运行态生命周期（残留 running 清理 + 计划重入保护） ----------
console.log('\n— 运行态生命周期 —');
const { reapOnStartup, reapStaleRuns } = await import('../lib/services/reaper.js');
const { executePlan } = await import('../lib/services/planExecutor.js');
const { now: stamp } = await import('../lib/db/connection.js');

const stale = '2020-01-01 00:00:00';
await db.prepare(`INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
  VALUES ('T-STALE', 'write_cases', '残留任务', 1, '', '[]', '', 'running', 50, ?, ?)`).run(stale, stale);
await db.prepare(`INSERT INTO plans (plan_no, name, type, scope, device_ids, status, fail_policy, script_mode, error, progress, progress_note, created_at, updated_at)
  VALUES ('P-STALE', '残留计划', 'single', '{}', '[]', 'running', 'continue', '', '', 50, '', ?, ?)`).run(stale, stale);

const reaped = await reapOnStartup();
check(reaped.tasks >= 1 && reaped.plans >= 1, '启动清理把残留 running 标记为中断', JSON.stringify(reaped));
check((await db.prepare(`SELECT status FROM tasks WHERE task_no = 'T-STALE'`).get())?.status === 'failed', '残留任务落到终态 failed');
check((await db.prepare(`SELECT status FROM plans WHERE plan_no = 'P-STALE'`).get())?.status === 'failed', '残留计划落到终态 failed');

// 空闲阈值：刚刷新过 updated_at 的 running 计划不能被误清（长计划执行中途会被误杀）
const liveStamp = stamp();
await db.prepare(`INSERT INTO plans (plan_no, name, type, scope, device_ids, status, fail_policy, script_mode, error, progress, progress_note, created_at, updated_at)
  VALUES ('P-FRESH', '在跑的计划', 'single', '{}', '[]', 'running', 'continue', '', '', 50, '', ?, ?)`).run(liveStamp, liveStamp);
const idleReap = await reapStaleRuns({ maxIdleMinutes: 30 });
const fresh = await db.prepare(`SELECT id, status FROM plans WHERE plan_no = 'P-FRESH'`).get();
check(fresh?.status === 'running', '空闲阈值内仍在推进的计划不被误清', `reaped=${JSON.stringify(idleReap)}`);

// 计划重入保护：running 状态下再次触发必须直接跳过，不能跑出第二份执行
const before = (await db.prepare('SELECT COUNT(*) AS c FROM executions').get()).c;
await executePlan(fresh.id);
const after = (await db.prepare('SELECT COUNT(*) AS c FROM executions').get()).c;
check(after === before, 'running 中的计划被重复触发时跳过（不会并发跑两份）', `executions ${before} → ${after}`);
check((await db.prepare(`SELECT status FROM plans WHERE id = ?`).get(fresh.id))?.status === 'running', '跳过时未破坏原有运行态');

// 执行体异常必须落到终态：不存在的库 id → 前置校验失败应在状态上留下痕迹
const ghost = await db.prepare(`INSERT INTO plans (plan_no, name, type, scope, device_ids, status, fail_policy, script_mode, error, progress, progress_note, created_at, updated_at)
  VALUES ('P-GHOST', '异常计划', 'single', '{"libraryIds":[999999],"caseIds":[]}', '[]', 'draft', 'continue', '', '', 0, '', ?, ?)`).run(liveStamp, liveStamp);
await executePlan(Number(ghost.lastInsertRowid)).catch(() => {});
const ghostStatus = (await db.prepare(`SELECT status FROM plans WHERE id = ?`).get(Number(ghost.lastInsertRowid)))?.status;
check(ghostStatus !== 'running' && ghostStatus !== 'draft', '执行异常后计划落到终态（不会永久卡在 running）', `status=${ghostStatus}`);

// 抛出型异常（device_ids 不是合法 JSON，会在前置解析处直接 throw）也必须落到终态
const broken = await db.prepare(`INSERT INTO plans (plan_no, name, type, scope, device_ids, status, fail_policy, script_mode, error, progress, progress_note, created_at, updated_at)
  VALUES ('P-BROKEN', '脏数据计划', 'single', '{}', 'not-json', 'draft', 'continue', '', '', 0, '', ?, ?)`).run(liveStamp, liveStamp);
await executePlan(Number(broken.lastInsertRowid)).catch(() => {});
const brokenStatus = (await db.prepare(`SELECT status, error FROM plans WHERE id = ?`).get(Number(broken.lastInsertRowid)));
check(brokenStatus?.status === 'failed', '前置解析抛异常时计划仍落到 failed（不再永久 running）', `status=${brokenStatus?.status} error=${String(brokenStatus?.error).slice(0, 40)}`);

// ---------- 7. llmJson 并发隔离（回归：firstErr 曾是模块级全局变量） ----------
console.log('\n— LLM JSON 并发隔离 —');
const { llmJson } = await import('../lib/services/llmHarness.js');
const repairPrompts = [];
// 桩模型：首次调用吐坏 JSON（带自己的 id），被回灌时返回合法 JSON 并记录收到的提示
const stubLlm = async (input) => {
  const id = input.meta?.kind ?? 'unknown';
  if (input.user.includes('解析失败原因')) {
    repairPrompts.push({ id, user: input.user });
    return { text: '{"ok":true}', provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1 };
  }
  return { text: `bad-json-${id}`, provider: 'stub', model: 'stub', latencyMs: 1, attempts: 1 };
};
await Promise.all([1, 2, 3].map((n) => llmJson(stubLlm, { user: `任务 ${n}`, meta: { kind: `shard-${n}` } })));
const polluted = repairPrompts.filter((p) => !p.user.includes(`bad-json-${p.id}`));
check(repairPrompts.length === 3, '三个并发调用都走了回灌修复', `count=${repairPrompts.length}`);
check(polluted.length === 0, '每个调用的修复提示只含自己的解析错误（无跨调用污染）',
  polluted.length ? `被污染：${polluted.map((p) => p.id).join(',')}` : `ids=${repairPrompts.map((p) => p.id).join(',')}`);

// 清理
const { sqlite } = await import('../lib/db/sqlite.js');
sqlite().close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
