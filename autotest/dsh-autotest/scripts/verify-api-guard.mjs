// API 门禁自检：在进程内起一个真实 HTTP 服务挂 makeApiHandler，用真实请求验证安全闸门与输入校验。
// 不连 MySQL、不调 LLM、不需要设备（llm 传桩函数）。
// 用法：npm run build && npm run verify:api
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ⚠️ 必须指向临时目录：绝不能碰用户正在使用的 data/autotest.sqlite3
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-api-'));
process.env.AUTOTEST_DB_MODE = 'sqlite';
process.env.AUTOTEST_DATA_DIR = tmpDir;
delete process.env.AUTOTEST_MYSQL_URL;
delete process.env.AUTOTEST_ALLOW_CROSS_ORIGIN;

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const { makeApiHandler } = await import('../lib/api/http.js');
const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };

const server = http.createServer((req, res) => {
  void makeApiHandler(stubLlm)(req, res);
});
// 自检里客户端与服务端同进程：客户端提前断开时服务端 socket 会抛 ECONNRESET，兜住即可
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api/autotest`;
console.log(`— 自检服务：${BASE} —\n`);

/** 低层请求：完全控制 header（fetch 会改写部分头，测 Origin/Sec-Fetch-Site 必须用它）。 */
function raw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        // 服务端在客户端仍在发送时提前响应（如 413）会让 socket 复位，这里吞掉以免打断自检
        res.on('error', () => {});
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('socket', (s) => s.on('error', () => {}));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- 基线：服务可用 ----------
console.log('— 基线 —');
const health = await raw('GET', '/api/autotest/health');
check(health.status === 200 && health.json?.ok === true, 'GET /health 正常', `status=${health.status}`);
const notFound = await raw('GET', '/api/autotest/__nope__');
check(notFound.status === 404, '未知路由返回 404', `status=${notFound.status}`);

// ---------- Content-Type 闸门 ----------
console.log('\n— Content-Type 闸门（阻断跨站表单式简单请求） —');
const formPost = await raw('POST', '/api/autotest/devices/scan', {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1',
});
check(formPost.status === 415, 'form-urlencoded 请求被拒（415）', `status=${formPost.status}`);
const textPost = await raw('POST', '/api/autotest/devices/scan', {
  headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}',
});
check(textPost.status === 415, 'text/plain 请求被拒（415）—— 这正是 CSRF 简单请求的载体', `status=${textPost.status}`);

// ---------- 坏 JSON 不再静默变 {} ----------
console.log('\n— 请求体校验 —');
const badJson = await raw('PUT', '/api/autotest/settings/data.cacheTtlSeconds', {
  headers: { 'Content-Type': 'application/json' }, body: '{"value":30',
});
check(badJson.status === 400, '截断的 JSON 返回 400（不再按空对象继续写库）', `status=${badJson.status}`);

const tooLarge = await raw('POST', '/api/autotest/plans', {
  headers: { 'Content-Type': 'application/json' },
  body: `{"name":"${'x'.repeat(3 * 1024 * 1024)}","type":"immediate"}`,
});
check(tooLarge.status === 413, '超过 2MB 的请求体返回 413', `status=${tooLarge.status}`);

// ---------- 同源闸门 ----------
console.log('\n— 同源闸门 —');
const crossOrigin = await raw('POST', '/api/autotest/devices/scan', {
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: {},
});
check(crossOrigin.status === 403, 'Origin 与 Host 不一致 → 403', `status=${crossOrigin.status}`);

const crossSite = await raw('POST', '/api/autotest/devices/scan', {
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: {},
});
check(crossSite.status === 403, 'Sec-Fetch-Site: cross-site → 403', `status=${crossSite.status}`);

const nullOrigin = await raw('POST', '/api/autotest/devices/scan', {
  headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: {},
});
check(nullOrigin.status === 403, 'Origin: null（沙箱/跨源文件）→ 403', `status=${nullOrigin.status}`);

const sameOrigin = await raw('PUT', '/api/autotest/settings/exec.llmTemperature', {
  headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: { value: 0.5 },
});
check(sameOrigin.status === 200, '同源请求照常放行', `status=${sameOrigin.status}`);

const noOrigin = await raw('GET', '/api/autotest/models');
check(noOrigin.status === 200, '无 Origin 的服务端/CLI 调用照常放行', `status=${noOrigin.status}`);

// ---------- 出参脱敏（HTTP 层确认） ----------
console.log('\n— 出参脱敏 —');
const putSecret = await raw('PUT', '/api/autotest/settings/db.mysqlUrl', {
  headers: { 'Content-Type': 'application/json' }, body: { value: 'mysql://root:TopSecret@127.0.0.1:3306/autotest' },
});
check(putSecret.status === 200 && !putSecret.text.includes('TopSecret'), '写入敏感配置后响应不含明文口令', `body=${putSecret.text}`);
const getSettings = await raw('GET', '/api/autotest/settings');
const mysqlEntry = getSettings.json?.find?.((r) => r.key === 'db.mysqlUrl');
check(!getSettings.text.includes('TopSecret'), 'GET /settings 全量响应不含明文口令');
check(Boolean(mysqlEntry) && String(mysqlEntry.value).includes('••••'), 'GET /settings 中 db.mysqlUrl 已打码', `value=${mysqlEntry?.value}`);
// 掩码原样回传：绝不能覆盖真实口令
await raw('PUT', '/api/autotest/settings/db.mysqlUrl', {
  headers: { 'Content-Type': 'application/json' }, body: { value: String(mysqlEntry.value) },
});
const { getSetting } = await import('../lib/services/settings.js');
check(getSetting('db.mysqlUrl', '') === 'mysql://root:TopSecret@127.0.0.1:3306/autotest', '掩码原样回传未覆盖真实口令');

const models = await raw('GET', '/api/autotest/models');
check(models.status === 200 && Array.isArray(models.json), 'GET /models 正常');
check((models.json ?? []).every((m) => typeof m.hasApiKey === 'boolean'), 'GET /models 提供 hasApiKey（前端不再靠 apiKey 真假判断）');
check((models.json ?? []).every((m) => !m.apiKey || m.apiKey.includes('•')), 'GET /models 的 apiKey 只可能是掩码或空');

// ---------- 模型端点（SSRF 方向）校验 ----------
console.log('\n— 模型端点校验 —');
const badProto = await raw('POST', '/api/autotest/models', {
  headers: { 'Content-Type': 'application/json' },
  body: { name: 'x', baseUrl: 'file:///etc/passwd', modelId: 'm' },
});
check(badProto.status === 400, '非 http/https 协议的 baseUrl 被拒', `status=${badProto.status}`);
const metadata = await raw('POST', '/api/autotest/models', {
  headers: { 'Content-Type': 'application/json' },
  body: { name: 'x', baseUrl: 'http://169.254.169.254/latest', modelId: 'm' },
});
check(metadata.status === 400, '指向云元数据地址的 baseUrl 被拒', `status=${metadata.status}`);
const ollama = await raw('POST', '/api/autotest/models', {
  headers: { 'Content-Type': 'application/json' },
  body: { name: '本地 Ollama 自检', baseUrl: 'http://localhost:11434/v1', modelId: 'qwen2.5:7b' },
});
check(ollama.status === 200, '本机 ollama 端点仍可用（不误伤内置默认模型）', `status=${ollama.status}`);

// ---------- limit 下限（负数不得放开全表） ----------
console.log('\n— 查询参数钳制 —');
const negLimit = await raw('GET', '/api/autotest/executions?limit=-1');
check(negLimit.status === 200, 'limit=-1 不报错', `status=${negLimit.status}`);
// 造 3 条执行记录：limit=-1 应被夹到下限 1（旧实现下 SQLite 会返回全部 3 条）
const { getDb } = await import('../lib/db/connection.js');
const db = getDb();
for (let i = 0; i < 3; i++) {
  await db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, thinking, logs, started_at, finished_at)
    VALUES (NULL, 1, 1, NULL, 'passed', '[]', '', '', '', ?, ?)`).run('2026-01-01 00:00:00', '2026-01-01 00:00:01');
}
const clamped = await raw('GET', '/api/autotest/executions?limit=-1');
check(clamped.json?.items?.length === 1, 'limit=-1 被夹到下限（只返回 1 条，而非全表）', `rows=${clamped.json?.items?.length}`);

// ---------- 用例 steps 入参校验 ----------
console.log('\n— 用例入参校验 —');
const created = await raw('POST', '/api/autotest/cases', {
  headers: { 'Content-Type': 'application/json' },
  body: { libraryId: 1, caseNo: 'C-VERIFY-001', name: '自检用例', steps: ['打开应用', '点击「开始」'], expected: '动画播放' },
});
check(created.status === 200 && created.json?.steps?.length === 2, '新建用例（steps 数组）正常', `status=${created.status}`);
const caseId = created.json?.id;
const nonArraySteps = await raw('PUT', `/api/autotest/cases/${caseId}`, {
  headers: { 'Content-Type': 'application/json' }, body: { steps: '1. 打开应用' },
});
check(nonArraySteps.status === 400, 'steps 传字符串被拒（否则整库用例列表会 500）', `status=${nonArraySteps.status}`);
const stillOk = await raw('GET', `/api/autotest/libraries/1/cases?pageSize=50`);
check(stillOk.status === 200, '用例列表仍可读取（脏数据未入库）', `status=${stillOk.status}`);

// ---------- 用例读写缓存一致性（回归：case: 前缀失效失败） ----------
console.log('\n— 缓存一致性 —');
const first = await raw('GET', `/api/autotest/cases/${caseId}`);           // 先填充缓存
check(first.json?.name === '自检用例', '首次读取命中数据');
await raw('PUT', `/api/autotest/cases/${caseId}`, {
  headers: { 'Content-Type': 'application/json' }, body: { name: '自检用例（已改名）' },
});
const second = await raw('GET', `/api/autotest/cases/${caseId}`);
check(second.json?.name === '自检用例（已改名）', '更新后立即读到新值（缓存已失效）', `name=${second.json?.name}`);
await raw('DELETE', `/api/autotest/cases/${caseId}`);
const third = await raw('GET', `/api/autotest/cases/${caseId}`);
check(third.status === 404, '删除后立即 404（不再返回缓存里的已删用例）', `status=${third.status}`);

// ---------- 库管理（新增 / 改包名 / 删除保护） ----------
console.log('\n— 库管理 —');
const newLib = await raw('POST', '/api/autotest/libraries', {
  headers: { 'Content-Type': 'application/json' },
  body: { name: 'verify-lib-schema', repoUrl: 'https://gitcode.com/x/y.git', description: '自检用库', packageName: 'com.example.verify' },
});
check(newLib.status === 200 && newLib.json?.packageName === 'com.example.verify', 'POST /libraries 能新增库并写入包名',
  `status=${newLib.status} pkg=${newLib.json?.packageName}`);
const dupLib = await raw('POST', '/api/autotest/libraries', {
  headers: { 'Content-Type': 'application/json' }, body: { name: 'verify-lib-schema' },
});
check(dupLib.status === 409, '重名库返回 409（而不是 500 或静默成功）', `status=${dupLib.status}`);
const badPkg = await raw('POST', '/api/autotest/libraries', {
  headers: { 'Content-Type': 'application/json' }, body: { name: 'verify-lib-badpkg', packageName: 'not a bundle name' },
});
check(badPkg.status === 400, '非法包名被拒（400）并给出格式要求', `status=${badPkg.status}`);
const libId = newLib.json?.id;

// 改包名：这是本次新增功能的核心 —— 没拉过仓库的库只能靠人工把包名补上，否则真机遍历起不来
const setPkg = await raw('PUT', `/api/autotest/libraries/${libId}`, {
  headers: { 'Content-Type': 'application/json' },
  body: { packageName: 'com.openharmony.jsonschemavalidator', mainAbility: 'EntryAbility' },
});
check(setPkg.status === 200 && setPkg.json?.packageName === 'com.openharmony.jsonschemavalidator' && setPkg.json?.mainAbility === 'EntryAbility',
  'PUT /libraries/:id 能补写包名与入口 Ability', `pkg=${setPkg.json?.packageName} ability=${setPkg.json?.mainAbility}`);
const badPkgPut = await raw('PUT', `/api/autotest/libraries/${libId}`, {
  headers: { 'Content-Type': 'application/json' }, body: { packageName: '..bad..' },
});
check(badPkgPut.status === 400, '改包名同样做格式校验', `status=${badPkgPut.status}`);

// 仓库地址里的 /tree/<分支>/<子目录> 必须被拆成「仓库根 URL + 子目录」两列。
// 不拆的后果：克隆按库名各存一份单体仓（实测 591MB × 168 个子目录库 ≈ 97GB），
// 且工程解析只看仓库根 → 包名永远解析不到（json-schema 包名长期为空就是这个原因）。
const treeLib = await raw('POST', '/api/autotest/libraries', {
  headers: { 'Content-Type': 'application/json' },
  body: { name: 'verify-lib-subpath', repoUrl: 'https://gitcode.com/openharmony-tpc/openharmony_tpc_samples/tree/master/json-schema' },
});
check(treeLib.json?.repoUrl === 'https://gitcode.com/openharmony-tpc/openharmony_tpc_samples.git'
  && treeLib.json?.repoSubpath === 'json-schema',
  'POST /libraries 把 /tree/<分支>/<子目录> 地址拆成仓库根 + 子目录',
  `repoUrl=${treeLib.json?.repoUrl} subpath=${treeLib.json?.repoSubpath}`);
const subLibId = treeLib.json?.id;
const evilSub = await raw('PUT', `/api/autotest/libraries/${subLibId}`, {
  headers: { 'Content-Type': 'application/json' }, body: { repoSubpath: '../../../Windows' },
});
check(evilSub.status === 200 && !String(evilSub.json?.repoSubpath ?? '').includes('..'),
  '子目录里的 .. 被剔除（目录穿越防护）', `subpath=${evilSub.json?.repoSubpath}`);
await raw('DELETE', `/api/autotest/libraries/${subLibId}?force=1`);

// ---------- 三方库测试表（xlsx）→ 库表同步 ----------
//
// 这是本功能最关键的**行为保证**，必须在真实 HTTP + 真实 DB 上验：
//   xlsx 是人维护的（有哪些库、对应哪个仓库），db 里 Agent 维护的字段（包名/入口 Ability）
//   在同步中**一个都不能被冲掉** —— 冲掉就等于丢了真机遍历好不容易补齐的启动信息。
console.log('\n— 三方库测试表同步（xlsx → db）—');
{
  const XLSX = (await import('xlsx')).default;
  const MONO = 'https://gitcode.com/CPF-ApplicationTPC/openharmony_tpc_samples';
  const sheetFile = path.join(tmpDir, '三方库测试表.xlsx');
  const rows = [
    ['三方库名称', 'URL'],
    ['sheet-keep-pkg', `${MONO}/tree/master/keepPkg`],   // 库里已有同名的、带包名的库 → 只能改地址，不能动包名
    ['sheet-new-lib', `${MONO}/tree/master/newLib`],     // 库里没有 → 新增
    ['', `${MONO}/tree/master/noName`],                  // 缺库名 → 跳过并报告
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(wb, sheetFile);

  // 先建一个"Agent 已经补好包名"的库，且地址与表里不同（模拟人改了表里的地址）
  const keep = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'sheet-keep-pkg', repoUrl: 'https://gitcode.com/old/place.git', packageName: 'com.agent.filled', mainAbility: 'EntryAbility' },
  });
  check(keep.status === 200, '预置：带包名的库已建立', `status=${keep.status}`);

  const dry = await raw('POST', '/api/autotest/libraries/sync-sheet', {
    headers: { 'Content-Type': 'application/json' }, body: { file: sheetFile },
  });
  check(dry.status === 200 && dry.json?.applied === false, '预览（dry-run）不写库', `applied=${dry.json?.applied}`);
  check(dry.json?.counts?.added === 1 && dry.json?.counts?.updated === 1 && dry.json?.counts?.problems === 1,
    '预览给出 新增1/更新1/跳过1', JSON.stringify(dry.json?.counts));
  const beforeDry = await db.prepare('SELECT COUNT(*) AS n FROM libraries').get();
  const dryNames = (await db.prepare('SELECT name FROM libraries ORDER BY id').all()).map((r) => r.name);
  check(!dryNames.includes('sheet-new-lib'), '预览没有新增任何库（真的没写）', `libraries=${beforeDry.n} · ${dryNames.join(',')}`);

  const applied = await raw('POST', '/api/autotest/libraries/sync-sheet?apply=1', {
    headers: { 'Content-Type': 'application/json' }, body: { file: sheetFile },
  });
  check(applied.status === 200 && applied.json?.applied === true, 'apply=1 执行落库', `status=${applied.status}`);

  const newLib = await db.prepare('SELECT * FROM libraries WHERE name = ?').get('sheet-new-lib');
  check(!!newLib && newLib.repo_url === `${MONO}.git` && newLib.repo_subpath === 'newLib',
    '新增库落库且子目录已拆出', `url=${newLib?.repo_url} sub=${newLib?.repo_subpath}`);

  const kept = await db.prepare('SELECT * FROM libraries WHERE name = ?').get('sheet-keep-pkg');
  check(kept?.package_name === 'com.agent.filled' && kept?.main_ability === 'EntryAbility',
    '★ Agent 补的包名与入口 Ability 没被同步冲掉', `pkg=${kept?.package_name} ability=${kept?.main_ability}`);
  check(kept?.repo_url === `${MONO}.git` && kept?.repo_subpath === 'keepPkg',
    '人维护的地址与子目录按表更新了', `url=${kept?.repo_url} sub=${kept?.repo_subpath}`);

  const noNameRow = await db.prepare('SELECT COUNT(*) AS n FROM libraries WHERE name = ?').get('');
  check(noNameRow.n === 0, '缺库名的行没有被建成空名库');

  // 库里存在、表里没有的库绝不能被删除（删库会级联删用例与执行历史）
  await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' }, body: { name: 'db-only-keep', repoUrl: 'https://gitcode.com/o/dbonly.git' },
  });
  const second = await raw('POST', '/api/autotest/libraries/sync-sheet?apply=1', {
    headers: { 'Content-Type': 'application/json' }, body: { file: sheetFile },
  });
  check(second.json?.counts?.added === 0 && second.json?.counts?.updated === 0 && second.json?.counts?.unchanged === 2,
    '二次同步幂等：0 新增 0 更新', JSON.stringify(second.json?.counts));
  const dbOnlySurvived = await db.prepare('SELECT id, package_name FROM libraries WHERE name = ?').get('db-only-keep');
  check(!!dbOnlySurvived, '表里没有的库不会被同步删除（只在 dbOnly 里报告）');
  check(second.json?.plan?.dbOnly?.some((d) => d.name === 'db-only-keep'), 'dbOnly 列表里能看到它');

  const badFile = await raw('POST', '/api/autotest/libraries/sync-sheet', {
    headers: { 'Content-Type': 'application/json' }, body: { file: path.join(tmpDir, '不存在.xlsx') },
  });
  check(badFile.status === 400, '文件不存在 → 400 且给出可操作提示（不是 500）', `status=${badFile.status}`);
}

// 删除保护：有数据的库默认拒绝，避免误点一下丢掉整库用例与执行历史
await raw('POST', '/api/autotest/cases', {
  headers: { 'Content-Type': 'application/json' },
  body: { libraryId: libId, caseNo: 'C-DEL-001', name: '待删除用例', steps: ['打开应用'] },
});
const impact = await raw('GET', `/api/autotest/libraries/${libId}/impact`);
check(impact.status === 200 && impact.json?.cases === 1, 'GET /libraries/:id/impact 能统计关联数据', `cases=${impact.json?.cases}`);
const delGuard = await raw('DELETE', `/api/autotest/libraries/${libId}`);
check(delGuard.status === 409, '有数据的库默认拒绝删除（409 + 影响面说明）', `status=${delGuard.status}`);
const delForce = await raw('DELETE', `/api/autotest/libraries/${libId}?force=1`);
check(delForce.status === 200 && delForce.json?.ok === true, 'force=1 时级联删除成功', `status=${delForce.status}`);
const gone = await raw('GET', `/api/autotest/libraries/${libId}`);
check(gone.status === 404, '删除后库确实不存在', `status=${gone.status}`);
const orphan = await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get(libId);
check(orphan.n === 0, '级联删除了该库的用例（不留孤儿数据）', `剩余用例=${orphan.n}`);

// ---------- P2：接口面提取 ----------
//
// 自检环境里没有真实仓库克隆，所以这里验的是**失败路径与空状态**是否清晰：
// 没拉代码时必须给人可操作的提示（而不是 500），没采集过时列表要如实返回空。
console.log('\n— P2 接口面提取 —');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-api-extract', repoUrl: 'https://gitcode.com/ohos-verify/not-cloned.git' },
  });
  const id = created.json?.id;
  check(!!id, '预置：待提取的库已建立', `id=${id}`);

  const noRepo = await raw('POST', `/api/autotest/libraries/${id}/extract-api`);
  check(noRepo.status === 400 && /拉取仓库代码/.test(noRepo.json?.error ?? ''),
    '未拉取代码时提取返回 400 且提示去拉代码（不是 500）', `status=${noRepo.status} msg=${noRepo.json?.error}`);

  const empty = await raw('GET', `/api/autotest/libraries/${id}/api-symbols`);
  check(empty.status === 200 && empty.json?.version === '' && empty.json?.symbols?.length === 0,
    '未采集过的库：接口清单为空而不是报错', `status=${empty.status} version='${empty.json?.version}'`);
  check(empty.json?.counts?.total === 0 && empty.json?.counts?.unused === 0, '空状态的统计全为 0', JSON.stringify(empty.json?.counts));

  const missing = await raw('GET', '/api/autotest/libraries/999999/api-symbols');
  check(missing.status === 404, '不存在的库返回 404', `status=${missing.status}`);
  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- P7：可行性分流 + 人工队列回填闭环 ----------
console.log('\n— P7 可行性分流与人工队列 —');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-p7-lib', repoUrl: 'https://gitcode.com/ohos-verify/p7.git' },
  });
  const id = created.json?.id;
  const c1 = await raw('POST', '/api/autotest/cases', {
    headers: { 'Content-Type': 'application/json' },
    body: { libraryId: id, caseNo: 'C-P7-001', name: '需要外部数据库的用例', steps: ['打开应用', '连接数据库查询', '验证「结果」'] },
  });
  const caseId = c1.json?.id;

  const tri = await raw('POST', `/api/autotest/libraries/${id}/triage`, {
    headers: { 'Content-Type': 'application/json' }, body: {},
  });
  check(tri.status === 200 && tri.json?.total === 1, '分流能跑通并覆盖全部用例', `total=${tri.json?.total}`);
  check(tri.json?.auto + tri.json?.human === tri.json?.total, '★ 每条用例都有明确归属（auto + human = total）',
    `auto=${tri.json?.auto} human=${tri.json?.human}`);
  check(tri.json?.human === 1 && tri.json?.byBlocker?.external_dep === 1,
    '★ 含外部数据库的用例被分流到人工队列，类别为 external_dep', JSON.stringify(tri.json?.byBlocker));
  check(tri.json?.byBlocker?.oracle_missing === 1, '同时标出缺可校验断言', JSON.stringify(tri.json?.byBlocker));

  const q = await raw('GET', `/api/autotest/libraries/${id}/human-queue`);
  check(q.status === 200 && q.json?.open >= 1, '人工队列能读出待处理条目', `open=${q.json?.open}`);
  const item = q.json?.items?.[0];
  check(!!item?.reason && !!item?.question, '★ 每条都带「原因」与「需要你做什么」', `reason=${String(item?.reason).slice(0, 30)}`);
  check(item?.payload?.steps?.length > 0, '带上下文证据（步骤）');

  const empty = await raw('POST', `/api/autotest/human-queue/${item.id}/resolve`, {
    headers: { 'Content-Type': 'application/json' }, body: { resolution: '   ' },
  });
  check(empty.status === 400, '★ 空结论被拒（结论要沉淀为知识条目，空结论等于没处理）', `status=${empty.status}`);

  const resolved = await raw('POST', `/api/autotest/human-queue/${item.id}/resolve`, {
    headers: { 'Content-Type': 'application/json' },
    body: { resolution: `人工确认：改用离线用例，不依赖外部数据库。case=${caseId}` },
  });
  check(resolved.status === 200 && resolved.json?.ok === true, '回填结论成功', `status=${resolved.status}`);
  check(/已重跑分流/.test(resolved.json?.message ?? ''), '★ 回填后自动重跑分流（闭环）', resolved.json?.message);

  const after = await raw('GET', `/api/autotest/libraries/${id}/human-queue?status=open`);
  check(Array.isArray(after.json?.items), '能按状态筛选队列', `open=${after.json?.open}`);

  const bad = await raw('POST', '/api/autotest/human-queue/999999/resolve', {
    headers: { 'Content-Type': 'application/json' }, body: { resolution: 'x' },
  });
  check(bad.status === 404, '不存在的队列条目返回 404', `status=${bad.status}`);
  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- P6：质量硬门槛 ----------
console.log('\n— P6 质量度量（断言覆盖率 / 假通过）—');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-p6-lib', repoUrl: 'https://gitcode.com/ohos-verify/p6.git' },
  });
  const id = created.json?.id;

  // 用例 A：正常入库（有 oracle）—— 走 POST /cases 时 oracle 由生成端写入，这里直接验质量接口的空状态
  const empty = await raw('GET', `/api/autotest/libraries/${id}/quality`);
  check(empty.status === 200 && empty.json?.total === 0, '没有用例时质量接口返回 0 而不是报错', `status=${empty.status}`);
  check(empty.json?.gates?.oracleCoverage === true, '没有用例时断言覆盖率门槛视为达标（不误判）', JSON.stringify(empty.json?.gates));
  check(empty.json?.falsePass === 0, '没有用例时假通过为 0');

  // 没有 oracle 的用例 → 断言覆盖率不达标（这是硬门槛能被触发的证明）
  await raw('POST', '/api/autotest/cases', {
    headers: { 'Content-Type': 'application/json' },
    body: { libraryId: id, caseNo: 'C-P6-001', name: '无断言的用例', steps: ['打开应用', '点击「验证」'] },
  });
  const withCase = await raw('GET', `/api/autotest/libraries/${id}/quality`);
  check(withCase.json?.total === 1 && withCase.json?.withOracle === 0, '无 oracle 的用例不计入断言覆盖', `withOracle=${withCase.json?.withOracle}`);
  check(withCase.json?.oracleCoverage === 0 && withCase.json?.gates?.oracleCoverage === false,
    '★ 断言覆盖率未达 100% 时门槛判定为不达标（硬门槛真的会拦）', `coverage=${withCase.json?.oracleCoverage}`);
  check(withCase.json?.missingOracleCases?.length === 1, '未达标的用例被列出来（可定位到是哪几条）');
  check(withCase.json.missingOracleCases[0].reason.includes('没有任何 oracle'), '理由指向"没有 oracle"而不是笼统说"不达标"',
    withCase.json.missingOracleCases[0].reason);

  const missing = await raw('GET', '/api/autotest/libraries/999999/quality');
  check(missing.status === 404, '不存在的库返回 404', `status=${missing.status}`);
  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- P5：可测性判定与补丁评审闸门 ----------
console.log('\n— P5 可测性判定与补丁 —');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-p5-lib', repoUrl: 'https://gitcode.com/ohos-verify/p5.git' },
  });
  const id = created.json?.id;
  const caseCreated = await raw('POST', '/api/autotest/cases', {
    headers: { 'Content-Type': 'application/json' },
    body: { libraryId: id, caseNo: 'C-P5-001', name: 'P5 自检用例', steps: ['打开应用', '点击「验证」'] },
  });
  const caseId = caseCreated.json?.id;
  check(!!caseId, '预置：用例已建立', `id=${caseId}`);

  const run = await raw('POST', `/api/autotest/libraries/${id}/testability`);
  check(run.status === 200 && run.json?.total === 1, '可测性判定能跑通并覆盖全部用例', `total=${run.json?.total}`);
  check(['A', 'B', 'C', 'D'].includes(run.json?.details?.[0]?.class), '★ 每条用例都拿到 A/B/C/D 判定（设计验收项）', `class=${run.json?.details?.[0]?.class}`);
  check(typeof run.json?.details?.[0]?.reason === 'string' && run.json.details[0].reason.length > 0, '判定必须带理由（不留空）');

  const patch = await raw('GET', `/api/autotest/cases/${caseId}/patch`);
  check(patch.status === 200 && patch.json?.testability, '能读回用例的可测性判定', `testability=${patch.json?.testability}`);

  // ★ 人工评审闸门：没有显式批准不能应用
  const noApprove = await raw('POST', `/api/autotest/cases/${caseId}/patch/apply`, {
    headers: { 'Content-Type': 'application/json' }, body: {},
  });
  check(noApprove.status === 400 && /评审/.test(noApprove.json?.error ?? ''),
    '★ 未获人工批准时拒绝应用补丁（防止误点改坏工程）', `status=${noApprove.status} msg=${noApprove.json?.error}`);

  const badCase = await raw('GET', '/api/autotest/cases/999999/patch');
  check(badCase.status === 404, '不存在的用例返回 404', `status=${badCase.status}`);
  const badApply = await raw('POST', '/api/autotest/cases/999999/patch/apply', {
    headers: { 'Content-Type': 'application/json' }, body: { approved: true },
  });
  check(badApply.status === 404, '对不存在的用例应用补丁返回 404', `status=${badApply.status}`);

  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- P4：用例计划（dry-run） ----------
console.log('\n— P4 用例计划 —');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-plan-lib', repoUrl: 'https://gitcode.com/ohos-verify/plan.git' },
  });
  const id = created.json?.id;

  const noSymbols = await raw('POST', `/api/autotest/libraries/${id}/case-plan`, {
    headers: { 'Content-Type': 'application/json' }, body: {},
  });
  check(noSymbols.status === 400 && /接口清单/.test(noSymbols.json?.error ?? ''),
    '没有接口清单时用例计划返回 400 且提示先采集（不是空计划糊弄过去）', `status=${noSymbols.status} msg=${noSymbols.json?.error}`);

  const missing = await raw('POST', '/api/autotest/libraries/999999/case-plan', {
    headers: { 'Content-Type': 'application/json' }, body: {},
  });
  check(missing.status === 404, '不存在的库返回 404', `status=${missing.status}`);
  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- P3：覆盖矩阵 ----------
//
// 自检环境没有真实仓库，所以矩阵构建会因"没有接口清单"被拒；这里验的是
// **拒绝要说清下一步做什么**，以及空状态与导出保护。
console.log('\n— P3 覆盖矩阵 —');
{
  const created = await raw('POST', '/api/autotest/libraries', {
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-matrix-lib', repoUrl: 'https://gitcode.com/ohos-verify/matrix.git' },
  });
  const id = created.json?.id;

  const noSymbols = await raw('POST', `/api/autotest/libraries/${id}/coverage-matrix`);
  check(noSymbols.status === 400 && /接口清单/.test(noSymbols.json?.error ?? ''),
    '没有接口清单时构建矩阵返回 400 且提示先采集接口', `status=${noSymbols.status} msg=${noSymbols.json?.error}`);

  const emptyQuery = await raw('GET', `/api/autotest/libraries/${id}/coverage-matrix`);
  check(emptyQuery.status === 200 && emptyQuery.json?.matrix?.length === 0 && emptyQuery.json?.summary?.total === 0,
    '未构建过时查询返回空矩阵而不是报错', `status=${emptyQuery.status}`);

  const emptyExport = await raw('POST', `/api/autotest/libraries/${id}/coverage-matrix/export`, {
    headers: { 'Content-Type': 'application/json' }, body: { format: 'csv' },
  });
  check(emptyExport.status === 400, '空矩阵导出被拒（不生成空文件让人误以为有内容）', `status=${emptyExport.status}`);

  const missing = await raw('GET', '/api/autotest/libraries/999999/coverage-matrix');
  check(missing.status === 404, '不存在的库查询矩阵返回 404', `status=${missing.status}`);
  await raw('DELETE', `/api/autotest/libraries/${id}?force=1`);
}

// ---------- Prompt 模板（对应前端"新建模板必然 404"的回归） ----------
console.log('\n— Prompt 模板 —');
const newPrompt = await raw('POST', '/api/autotest/prompts', {
  headers: { 'Content-Type': 'application/json' }, body: { name: '自检模板', role: '自检', content: '你是自检。' },
});
check(newPrompt.status === 200 && newPrompt.json?.id > 0, 'POST /prompts 能新建模板', `id=${newPrompt.json?.id}`);
const bogusUpdate = await raw('PUT', '/api/autotest/prompts/0', {
  headers: { 'Content-Type': 'application/json' }, body: { name: 'x', content: 'y' },
});
check(bogusUpdate.status === 404, 'PUT /prompts/0 返回 404（前端哨兵 id=0 必须走新建分支）', `status=${bogusUpdate.status}`);
const realUpdate = await raw('PUT', `/api/autotest/prompts/${newPrompt.json?.id}`, {
  headers: { 'Content-Type': 'application/json' }, body: { name: '自检模板（改）', content: '你是自检 2。' },
});
check(realUpdate.status === 200, 'PUT /prompts/:id 正常更新', `status=${realUpdate.status}`);

// ---------- 列表信封（nextCursor 必须真的出现在 JSON 里） ----------
console.log('\n— 列表信封 —');
// 补两条执行记录，确保列表非空 —— 只有非空时才能验证游标真的被传出来
for (let i = 0; i < 2; i++) {
  await db.prepare(`INSERT INTO executions (plan_id, case_id, library_id, device_id, status, steps, trace_id, thinking, logs, started_at, finished_at)
    VALUES (NULL, 999999, 1, NULL, 'passed', '[]', '', '', '', ?, ?)`).run('2026-01-02 00:00:00', '2026-01-02 00:00:01');
}
const execEnv = await raw('GET', '/api/autotest/executions');
check(execEnv.json?.items?.length === 2 && typeof execEnv.json.nextCursor === 'number',
  '/executions 非空列表的 nextCursor 真实到达客户端（回归：以前被数组吞掉）',
  `items=${execEnv.json?.items?.length} nextCursor=${JSON.stringify(execEnv.json?.nextCursor)}`);
for (const p of ['/tasks', '/analyses']) {
  const r = await raw('GET', `/api/autotest${p}`);
  const ok = Array.isArray(r.json?.items) && Object.prototype.hasOwnProperty.call(r.json, 'nextCursor');
  check(ok, `${p} 返回 { items, nextCursor } 信封`, `items=${r.json?.items?.length}`);
}

// ---------- 清理 ----------
await new Promise((r) => server.close(r));
const { sqlite } = await import('../lib/db/sqlite.js');
sqlite().close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
