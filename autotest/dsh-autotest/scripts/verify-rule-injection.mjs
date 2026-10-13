// 规则注入自检（verify:rule-injection，B3-2）——离线可跑：
//  ① 索引一致：gen-rules-index --check 通过（rules/ 与 _index.yaml 不漂移）；
//  ② 路径命中：paths=['dsh-autotest/src/db/connection.ts'] → 命中 db-transaction-isolation /
//     arch-layering / arch-dsh-decoupling，且注入文本含规则正文；
//  ③ 主题命中：touches=['transaction'] → 命中 db-transaction-isolation；
//  ④ 预算截断：budgetChars=600 → 出现摘要注入（truncated 非空），总量不超预算；
//  ⑤ 无命中：paths=['README.md'] → matched 为空；
//  ⑥ agent-tools 端到端：进程内起真实 HTTP 服务，spawn dist/cli.mjs rules.inject →
//     envelope ok 且 data.text 含规则 id、data.matched 非空（服务端路由 + CLI 双通）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const autotestRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'); // …/autotest
const dshRoot = path.join(autotestRoot, 'dsh-autotest');
const distCli = path.join(autotestRoot, 'agent-tools', 'dist', 'cli.mjs');

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const asUrl = (p) => pathToFileURL(p).href;

// ⚠️ 临时数据目录：绝不碰用户真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ruleinject-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
process.env.AUTOTEST_WORKSPACE = path.join(tmpDir, 'workspace');
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

const { injectRules, loadRules, rulesRoot } = await import(asUrl(path.join(dshRoot, 'lib', 'services', 'rules.js')));
const { makeApiHandler } = await import(asUrl(path.join(dshRoot, 'lib', 'api', 'http.js')));
const { ensureReady } = await import(asUrl(path.join(dshRoot, 'lib', 'db', 'connection.js')));

// ---------- ① 索引一致 ----------
{
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(autotestRoot, 'scripts', 'gen-rules-index.mjs'), '--check'], { cwd: autotestRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  check(r.code === 0, '索引一致：gen-rules-index --check 通过', r.out.trim().split('\n').pop() ?? '');
}

// ---------- 规则库基础面 ----------
{
  const root = rulesRoot();
  check(root !== null, 'rulesRoot 解析到 rules/ 目录', String(root));
  const rules = loadRules();
  check(rules.length >= 10, `规则库规模 ≥10 条`, `实际 ${rules.length}`);
  const ids = rules.map((r) => r.id);
  check(ids.includes('db-transaction-isolation') && ids.includes('windows-nodejs-pitfalls'), '关键规则在位（事务隔离 / Windows 踩坑）');
}

// ---------- ② 路径命中 ----------
{
  const r = injectRules({ paths: ['dsh-autotest/src/db/connection.ts'] });
  const ids = r.matched.map((m) => m.id);
  check(ids.includes('db-transaction-isolation'), '路径命中：db-transaction-isolation', ids.join(','));
  check(ids.includes('arch-layering') && ids.includes('arch-dsh-decoupling'), '路径命中：arch-layering + arch-dsh-decoupling（src/** 与 db/**）');
  check(r.text.includes('## [db-transaction-isolation]'), '注入文本含规则标题块');
  check(r.matched.every((m) => m.injected === 'full'), '默认预算下全部全文注入');
}

// ---------- ③ 主题命中 ----------
{
  const r = injectRules({ touches: ['transaction'] });
  check(r.matched.some((m) => m.id === 'db-transaction-isolation'), '主题命中：touches=[transaction] → db-transaction-isolation');
}

// ---------- ④ 预算截断 ----------
{
  const r = injectRules({ paths: ['dsh-autotest/src/db/connection.ts'], budgetChars: 600 });
  check(r.truncated.length > 0 || r.dropped.length > 0, '小预算触发截断/丢弃', `truncated=${r.truncated.length} dropped=${r.dropped.length}`);
  check(r.totalChars <= 600, '注入总量不超预算', `${r.totalChars} ≤ 600`);
  check(r.matched.some((m) => m.injected === 'summary'), '存在摘要注入条目');
  // load_bearing 优先：第一条命中应是 load_bearing 且尽量全文
  check(r.matched.length > 0 && r.matched[0].loadBearing, '预算内 load_bearing 优先');
}

// ---------- ⑤ 无命中 ----------
{
  const r = injectRules({ paths: ['README.md'], touches: ['nonexistent-tag'] });
  check(r.matched.length === 0 && r.text === '', '无命中：matched 空、text 空');
}

// ---------- ⑥ agent-tools 端到端（进程内服务 + CLI） ----------
if (!fs.existsSync(distCli)) {
  check(false, 'agent-tools dist/cli.mjs 存在', '缺失——请先 npm run build:agent-tools');
} else {
  const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
  const handler = makeApiHandler(stubLlm);
  const server = http.createServer((req, res) => { void handler(req, res); });
  server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}/api/autotest`;
  console.log(`— 自检服务：${BASE} —`);
  await ensureReady();

  // 服务端路由直测
  {
    const res = await fetch(`${BASE}/rules/inject?paths=dsh-autotest/src/db/connection.ts`);
    const json = await res.json().catch(() => null);
    check(res.status === 200 && Array.isArray(json?.matched) && json.matched.some((m) => m.id === 'db-transaction-isolation'),
      '服务端路由：GET /rules/inject 命中', `status=${res.status} matched=${json?.matched?.length ?? 0}`);
  }
  // CLI 端到端（异步 spawn——sync 会冻结父进程事件循环导致请求无人应答）
  {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [distCli, 'rules.inject', '--paths', 'dsh-autotest/src/db/connection.ts', '--base', BASE], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    let env = null;
    try { env = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { /* ignore */ }
    check(r.code === 0 && env?.ok === true, 'CLI：rules.inject → exit 0 + envelope ok', `exit=${r.code}`);
    check(typeof env?.data?.text === 'string' && env.data.text.includes('[db-transaction-isolation]'), 'CLI：envelope.data.text 含规则正文');
    check(Array.isArray(env?.data?.matched) && env.data.matched.length > 0, 'CLI：envelope.data.matched 非空', `${env?.data?.matched?.length ?? 0} 条`);
  }

  server.close();
}

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
