// LLM 层治理自检（临时 SQLite 库，无真实 LLM —— ctx.llm 用可观测的假实现；Redis 用内存假 RESP 服务）。
//
// 对应架构评审 #5「LLM 层：重试不换模型、限流是进程内存、无 token 预算」三项，各钉死一个真实后果：
//   ① 重试跨模型：3 次全打在 preferred 上，fallback 候选列表形同虚设（换一个可用模型就能救回来的调用被拖死）；
//   ② 首选打头 + 候选去重顺序稳定：设置默认模型/DSH 默认模型时不能 duplicate，否则第 2 次就绕回自己白试；
//   ③ 候选不足 3 个绕回首选：单模型部署下行为必须与改造前一致（同模型重试 3 次）；
//   ④ 取消不重试：任务 lane 的 AbortSignal 触发后立即收手，不再换模型重试烧额度；
//   ⑤ token 记账：agent_events 是成本账本，成功/失败埋点都要带 tokens（失败漏记会低估花费）；
//   ⑥ token 预算：单任务烧到上限必须中止后续模型调用，而不是继续烧；
//   ⑦ 限流全局化：Redis 可用时 INCR 落在共享存储上，两个节点共享同一个计数（进程内数组等于没限）。
// 用法：npm run build && npm run verify:llm-fallback
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-verify-llm-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;
// 隔离 DSH_HOME：readDshDefaultModel 读 $DSH_HOME/settings.yaml，
// 不隔离的话首选会被本机真实默认模型影响，轮转顺序断言不稳定
fs.mkdirSync(path.join(tmpDir, 'dsh-home'), { recursive: true });
process.env.DSH_HOME = path.join(tmpDir, 'dsh-home');

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { ensureReady, getDb, now } = await import('../lib/db/connection.js');
await ensureReady();
const db = getDb();
console.log(`— 临时库：${path.join(tmpDir, 'autotest.sqlite3')} —\n`);

const { makeLlm } = await import('../lib/services/llmHarness.js');
const { setSetting } = await import('../lib/services/settings.js');
const { taskTokenUsage, ensureTaskTokenBudget } = await import('../lib/services/tokenBudget.js');
const { checkLlmRate, resetLlmRateForTest } = await import('../lib/services/llmLimit.js');
const { installLlmTracing } = await import('../lib/services/events.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (x) => `${x.provider}:${x.model}`;

/**
 * 假 ctx.llm：记录每次尝试的 provider/model，按需让指定模型失败。
 * fail 的模型先吐 usage 再报错 —— 让失败路径也累积 token，用来验证失败埋点补记 tokens。
 */
function makeCtx({ models = ['p1:m1'], fail = [], hang = [] } = {}) {
  const calls = [];
  const failSet = new Set(fail);
  const hangSet = new Set(hang);
  const stream = async function* (opts) {
    const k = `${opts.provider}:${opts.model}`;
    calls.push(k);
    if (opts.signal?.aborted) throw new Error('aborted');
    if (hangSet.has(k)) {
      // 模拟长耗时调用：abort 时立即拒绝（真实 ctx.llm.stream 的可中断性）
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
      return;
    }
    if (failSet.has(k)) {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `模型 ${k} 不可用` } } };
      return;
    }
    yield { type: 'text-delta', text: `回复来自 ${k}` };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return {
    ctx: { llm: { listProviders: () => [{ id: 'p1' }], listModels: async () => models.map((m) => ({ id: m.split(':')[1] })), stream } },
    calls,
  };
}

let taskSeq = 0;
async function insertTask() {
  const t = now();
  const res = await db.prepare(
    `INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
     VALUES (?, 'write_cases', ?, NULL, '', '[]', ?, 'pending', 0, ?, ?)`,
  ).run(`T-LLM-${Date.now()}-${taskSeq++}`, `llm 自检 ${taskSeq}`, `tr-llm-${taskSeq}`, t, t);
  return Number(res.lastInsertRowid);
}

async function insertUsage(taskId, tokensIn, tokensOut) {
  await db.prepare(
    `INSERT INTO agent_events (task_id, kind, status, provider, model, tokens_in, tokens_out, created_at)
     VALUES (?, 'llm_call', 'ok', 'p1', 'm1', ?, ?, ?)`,
  ).run(taskId, tokensIn, tokensOut, now());
}

const lastEvent = async (taskId) => db.prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY id DESC').get(taskId);

// ---------- ① 重试跨模型 ----------
console.log('— 重试轮转：首选打头，跨模型切换 —');
{
  // 3 个候选全部失败 → 3 次必须分别落在 3 个模型上（旧实现 3 次全打 m1）
  const { ctx, calls } = makeCtx({ models: ['p1:m1', 'p1:m2', 'p1:m3'], fail: ['p1:m1', 'p1:m2', 'p1:m3'] });
  const llm = makeLlm(ctx);
  let err = null;
  await llm({ user: 'x' }).catch((e) => { err = e; });
  check(calls.length === 3 && calls.join(',') === 'p1:m1,p1:m2,p1:m3', '3 个候选依次尝试（不再 3 次全打同一个）', calls.join(','));
  check(err && ['p1:m1', 'p1:m2', 'p1:m3'].every((k) => err.message.includes(k)), '失败信息列出全部尝试过的模型', err?.message);

  // 首选失败、第二个成功 → 返回的 provider/model 必须是当次命中的模型
  const two = makeCtx({ models: ['p1:m1', 'p1:m2'], fail: ['p1:m1'] });
  const llm2 = makeLlm(two.ctx);
  const res = await llm2({ user: 'x' });
  check(two.calls.join(',') === 'p1:m1,p1:m2', '首个失败后切到下一个候选', two.calls.join(','));
  check(res.provider === 'p1' && res.model === 'm2' && res.attempts === 2, '返回值记录当次命中的模型', `${res.provider}/${res.model} attempts=${res.attempts}`);
  check(res.text.includes('p1:m2'), '返回的是命中模型的输出', res.text);
}

// ---------- ② 首选与去重顺序 ----------
console.log('— 首选选择 / 候选顺序 —');
{
  // 系统配置默认模型 m3 → 首选 m3，其余候选按列表顺序跟上，且不重复出现 m3
  setSetting('agent.defaultModel', 'm3');
  const { ctx, calls } = makeCtx({ models: ['p1:m1', 'p1:m2', 'p1:m3'], fail: ['p1:m1', 'p1:m2', 'p1:m3'] });
  await makeLlm(ctx)({ user: 'x' }).catch(() => { /* 全失败也要看顺序 */ });
  check(calls.join(',') === 'p1:m3,p1:m1,p1:m2', '默认模型打头，其余按列表顺序且不重复', calls.join(','));
  setSetting('agent.defaultModel', '');

  // DSH 默认模型（settings.yaml）也要能当首选：该分支曾 new 出对象字面量，
  // 若按引用去重会把首选漏掉、顺序错乱
  fs.writeFileSync(path.join(process.env.DSH_HOME, 'settings.yaml'), 'agent-default-model:\n  provider: p1\n  model: m2\n');
  const dsh = makeCtx({ models: ['p1:m1', 'p1:m2', 'p1:m3'], fail: ['p1:m1', 'p1:m2', 'p1:m3'] });
  await makeLlm(dsh.ctx)({ user: 'x' }).catch(() => { /* 同上 */ });
  check(dsh.calls.join(',') === 'p1:m2,p1:m1,p1:m3', 'DSH 默认模型打头（对象字面量也不能重复计数）', dsh.calls.join(','));
  fs.rmSync(path.join(process.env.DSH_HOME, 'settings.yaml'));
}

// ---------- ③ 候选不足 3 个绕回首选 ----------
console.log('— 候选不足时绕回首选（退化行为）—');
{
  const one = makeCtx({ models: ['p1:m1'], fail: ['p1:m1'] });
  await makeLlm(one.ctx)({ user: 'x' }).catch(() => { /* 单模型全失败 */ });
  check(one.calls.join(',') === 'p1:m1,p1:m1,p1:m1', '单候选：同模型重试 3 次（与改造前一致）', one.calls.join(','));

  const two = makeCtx({ models: ['p1:m1', 'p1:m2'], fail: ['p1:m1', 'p1:m2'] });
  await makeLlm(two.ctx)({ user: 'x' }).catch(() => { /* 两候选全失败 */ });
  check(two.calls.join(',') === 'p1:m1,p1:m2,p1:m1', '两候选：第 3 次绕回首选', two.calls.join(','));
}

// ---------- ④ 取消不重试 ----------
console.log('— 取消信号：不重试 —');
{
  // 已取消：第一次就抛，不进入换模型重试
  const pre = makeCtx({ models: ['p1:m1', 'p1:m2'] });
  const ac = new AbortController();
  ac.abort();
  let err = null;
  await makeLlm(pre.ctx)({ user: 'x', signal: ac.signal }).catch((e) => { err = e; });
  check(pre.calls.length === 1 && !!err, '调用前已取消：只试 1 次', `${pre.calls.length} 次`);

  // 运行中取消：长耗时模型被 abort，也立即收手
  const live = makeCtx({ models: ['p1:m1', 'p1:m2'], hang: ['p1:m1'] });
  const ac2 = new AbortController();
  const p = makeLlm(live.ctx)({ user: 'x', signal: ac2.signal });
  await sleep(30);
  ac2.abort();
  let err2 = null;
  await p.catch((e) => { err2 = e; });
  check(live.calls.length === 1 && !!err2, '运行中取消：不换模型重试', `${live.calls.length} 次 / ${err2?.message}`);
}

// ---------- ⑤ token 记账 ----------
console.log('— token 记账（agent_events）—');
installLlmTracing(); // 埋点钩子：makeLlm 的每次调用都会写 agent_events
{
  const taskId = await insertTask();
  const ok = makeCtx({ models: ['p1:m1'] });
  await makeLlm(ok.ctx)({ user: 'hi', meta: { taskId, kind: 'write_cases' } });
  await sleep(40); // 埋点是 fire-and-forget 写库
  const ev = await lastEvent(taskId);
  check(ev && ev.status === 'ok' && Number(ev.tokens_in) === 10 && Number(ev.tokens_out) === 20, '成功埋点带 tokens', ev ? `${ev.status} in=${ev.tokens_in} out=${ev.tokens_out}` : '无事件');

  const bad = makeCtx({ models: ['p1:m1'], fail: ['p1:m1'] });
  await makeLlm(bad.ctx)({ user: 'hi', meta: { taskId, kind: 'write_cases' } }).catch(() => { /* 全失败 */ });
  await sleep(40);
  const ev2 = await lastEvent(taskId);
  check(ev2 && ev2.status === 'error' && Number(ev2.tokens_in) === 30 && Number(ev2.tokens_out) === 60,
    '失败埋点也记 tokens（否则低估花费）', ev2 ? `${ev2.status} in=${ev2.tokens_in} out=${ev2.tokens_out}` : '无事件');

  const usage = await taskTokenUsage(taskId);
  check(usage.total === 120, '按任务汇总 token（成功 30 + 失败 3 次 90）', `in=${usage.tokensIn} out=${usage.tokensOut} total=${usage.total}`);
}

// ---------- ⑥ token 预算 ----------
console.log('— 单任务 token 预算 —');
{
  const taskId = await insertTask();
  await insertUsage(taskId, 60, 60);

  setSetting('agent.maxTokensPerTask', 100);
  const over = makeCtx({ models: ['p1:m1', 'p1:m2'] });
  let err = null;
  await makeLlm(over.ctx)({ user: 'hi', meta: { taskId } }).catch((e) => { err = e; });
  check(over.calls.length === 0, '超预算：一次模型调用都不发出', `${over.calls.length} 次`);
  check(err && err.message.includes('token 预算已用尽') && err.message.includes('120'), '报错写明已用/上限', err?.message);

  setSetting('agent.maxTokensPerTask', 0);
  const off = makeCtx({ models: ['p1:m1'] });
  const res = await makeLlm(off.ctx)({ user: 'hi', meta: { taskId } });
  check(off.calls.length === 1 && !!res.text, '预算 0 = 不限制', `${off.calls.length} 次`);

  // 不带 taskId 的调用（分析/追问等非任务入口）不设闸门
  const noTask = makeCtx({ models: ['p1:m1'] });
  const res2 = await makeLlm(noTask.ctx)({ user: 'hi' });
  check(noTask.calls.length === 1 && !!res2.text, '非任务入口不设闸门');

  // 按任务隔离：别把没花预算的任务一起卡死
  const other = await insertTask();
  const iso = makeCtx({ models: ['p1:m1'] });
  await makeLlm(iso.ctx)({ user: 'hi', meta: { taskId: other } });
  check(iso.calls.length === 1, '预算按 task 隔离');

  setSetting('agent.maxTokensPerTask', 100);
  check(await ensureTaskTokenBudget(other) === undefined, 'ensureTaskTokenBudget 未超限时放行');
  let isoErr = null;
  await ensureTaskTokenBudget(taskId).catch((e) => { isoErr = e; });
  check(!!isoErr && isoErr.message.includes('预算已用尽'), 'ensureTaskTokenBudget 超限抛错');
  setSetting('agent.maxTokensPerTask', 300000);
  const usage = await taskTokenUsage(taskId);
  check(usage.total > 0, '汇总口径仍可用', `total=${usage.total}`);
}

// ---------- ⑦ 限流：进程内回退 ----------
// ⚠️ 必须在 Redis 相关测试之前跑：cache.redis() 的解析结果只会算一次（redisResolved 闩锁），
// 一旦解析过就固定用那个客户端，后面改设置也换不回来。
console.log('— 限流（Redis 不可用 → 进程内滑动窗口）—');
{
  setSetting('exec.llmRatePerMin', 3);
  resetLlmRateForTest();
  let blocked = null;
  for (let i = 1; i <= 3; i++) await checkLlmRate();
  await checkLlmRate().catch((e) => { blocked = e; });
  check(!!blocked && blocked.statusCode === 429, '第 4 次调用被限（429）', blocked?.message);
  check(blocked && blocked.message.includes('3 次/分钟'), '错误信息带上限', blocked?.message);

  setSetting('exec.llmRatePerMin', 1);
  resetLlmRateForTest();
  let blocked2 = null;
  await checkLlmRate();
  await checkLlmRate().catch((e) => { blocked2 = e; });
  check(!!blocked2, '上限改小立即生效', blocked2?.message);
  setSetting('exec.llmRatePerMin', 10);
}

// ---------- ⑦ 限流：Redis 全局（两个进程共享计数） ----------
// 用子进程跑：既绕开 redisResolved 闩锁，也天然模拟"两个节点各有一个进程内数组"的旧局面。
console.log('— 限流（Redis 可用 → 两个"节点"共享计数）—');
{
  const redisLog = [];
  const counters = new Map();
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) break;
        buf = parsed.rest;
        const cmd = parsed.args.map((a) => String(a));
        redisLog.push(cmd.join(' '));
        const name = cmd[0].toLowerCase();
        if (name === 'incr') {
          const k = cmd[1];
          counters.set(k, (counters.get(k) ?? 0) + 1);
          sock.write(`:${counters.get(k)}\r\n`);
        } else if (name === 'pexpire') {
          sock.write(':1\r\n');
        } else if (name === 'info') {
          const payload = '# Server\r\nredis_version:7.0.0\r\n# Persistence\r\nloading:0\r\n';
          sock.write(`$${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
        } else {
          sock.write('+OK\r\n');
        }
      }
    });
    sock.on('error', () => { /* 连接重置不影响断言 */ });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const libHref = (rel) => pathToFileURL(path.resolve(here, '..', 'lib', rel)).href;
  const modPath = libHref('services/llmLimit.js');
  const connHref = libHref('db/connection.js');
  const settingsHref = libHref('services/settings.js');

  const childSrc = `
    const { ensureReady } = await import(${JSON.stringify(connHref)});
    const { setSetting } = await import(${JSON.stringify(settingsHref)});
    const { checkLlmRate, resetLlmRateForTest } = await import(${JSON.stringify(modPath)});
    process.on('message', async (m) => {
      let reply;
      try {
        await ensureReady();
        setSetting('exec.llmRatePerMin', m.max);
        resetLlmRateForTest();
        setSetting('data.redisCache', true);
        setSetting('data.redisUrl', 'redis://127.0.0.1:${port}');
        for (let i = 0; i < m.times; i++) await checkLlmRate();
        reply = { ok: true };
      } catch (e) {
        reply = { ok: false, error: String(e?.message || e), statusCode: e?.statusCode ?? null };
      }
      process.send(reply);
      setTimeout(() => process.exit(0), 100);
    });
  `;
  const runChild = (msg) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSrc], {
      env: { ...process.env, AUTOTEST_DB_MODE: 'sqlite', AUTOTEST_DATA_DIR: tmpDir },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let out = null;
    child.on('message', (m) => { out = m; });
    child.on('close', () => resolve(out ?? { ok: false, error: '子进程无响应' }));
    child.send(msg);
  });

  // 上限 2 次/分钟：节点 A 先打 2 次全过（计数 1、2）；
  // 节点 B 再打 2 次 —— 进程内数组语义下 B 有自己的数组，2 次都会通过；
  // 只有计数落在共享存储上，B 的第 1 次（计数 3）就该被 429 挡住。
  const a = await runChild({ max: 2, times: 2 });
  const b = await runChild({ max: 2, times: 2 });
  check(a.ok === true, '节点 A：前半窗 2 次通过', JSON.stringify(a));
  check(b.ok === false && b.statusCode === 429, '节点 B：被 A 的计数挡住（共享计数生效）', JSON.stringify(b));

  const incrs = redisLog.filter((l) => l.toLowerCase().startsWith('incr '));
  const keys = incrs.map((l) => l.split(' ')[1]);
  check(incrs.length === 3, '3 次调用都走了 Redis INCR（不是进程内计数）', `${incrs.length} 次`);
  check(keys.every((k) => /^autotest:llmrl:\d+$/.test(k)), '计数键按分钟分桶并带 autotest: 前缀', keys[0] ?? '无');
  // 同一分钟内两个节点必然打在同一个键上；跨分钟边界时最多两个键，其中一个至少 3 次
  const maxBucket = Math.max(0, ...[...counters.values()]);
  check(maxBucket >= 3, '同一个键累计了跨节点的 3 次计数', `最大桶=${maxBucket}`);
  const expires = redisLog.filter((l) => l.toLowerCase().startsWith('pexpire '));
  check(expires.length >= 1, '新建键会设 TTL（否则窗口键永不过期，限流项被永久卡死）', `${expires.length} 次`);

  server.close();
}

/** 从缓冲区解析一条 RESP 命令；不足一条返回 null。 */
function parseCommand(buf) {
  let i = 0;
  if (buf[i] !== 0x2a) return null; // '*'
  const lineEnd = buf.indexOf('\r\n', i);
  if (lineEnd < 0) return null;
  const count = Number(buf.toString('utf8', i + 1, lineEnd));
  i = lineEnd + 2;
  const args = [];
  for (let n = 0; n < count; n++) {
    if (buf[i] !== 0x24) return null; // '$'
    const lenEnd = buf.indexOf('\r\n', i);
    if (lenEnd < 0) return null;
    const len = Number(buf.toString('utf8', i + 1, lenEnd));
    const start = lenEnd + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.toString('utf8', start, start + len));
    i = start + len + 2;
  }
  return { args, rest: buf.subarray(i) };
}

// ---------- 汇总 ----------
const count = (await db.prepare('SELECT COUNT(*) AS c FROM agent_events').get()).c;
console.log(`\nagent_events 行数：${count}`);
console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
