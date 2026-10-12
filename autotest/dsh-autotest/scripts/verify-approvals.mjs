// 危险操作审批自检（verify:approvals）：进程内起真实 HTTP 服务，验证 P0-4 全链路。
// 不连 MySQL、不调 LLM、不碰真实 git（llm 传桩；审批闸门在 git 执行前拦截）。
// 用法：npm run build && npm run verify:approvals
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-approvals-'));
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

const { makeApiHandler } = await import('../lib/api/http.js');
const { autoApproveEnabled, requireApproval, decideApproval, listApprovals, pendingApprovalCount, ApprovalPendingError } = await import('../lib/services/approvals.js');
const { createApiKey } = await import('../lib/services/auth.js');
const { setSetting } = await import('../lib/services/settings.js');
const { getDb, ensureReady, now } = await import('../lib/db/connection.js');

const stubLlm = async () => { throw new Error('自检桩：不应真正调用 LLM'); };
const handler = makeApiHandler(stubLlm);
const server = http.createServer((req, res) => { void handler(req, res); });
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/api/autotest`;

function raw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        res.on('error', () => {});
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
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
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

await ensureReady();

// ---------- 阶段 0：默认兼容（autoApprove=true，危险操作直行） ----------
check(autoApproveEnabled() === true, '默认 exec.autoApprove=true（既有行为零感知）');
const lib = await raw('POST', '/libraries', { body: { name: 'approval-test-lib', description: '审批自检' } });
const libId = Number(lib.json?.id ?? 0);
check(lib.status === 200 && libId > 0, '创建测试库', `id=${libId}`);
const compatDel = await raw('DELETE', `/libraries/${libId}?force=1`);
check(compatDel.status === 200, 'autoApprove=true：删库直行（兼容模式）', `status=${compatDel.status}`);
check((await listApprovals()).length === 0, '兼容模式不产生审批记录');

// ---------- 阶段 1：关闭 autoApprove → 危险操作入队 ----------
setSetting('exec.autoApprove', false);
check(autoApproveEnabled() === false, 'exec.autoApprove=false 生效');

// 造用例（库已被兼容模式删掉，重建一个）
const lib2 = await raw('POST', '/libraries', { body: { name: 'approval-test-lib-2' } });
const lib2Id = Number(lib2.json?.id ?? 0);
const case1 = await raw('POST', '/cases', { body: { libraryId: lib2Id, caseNo: 'AP-001', name: '审批用例一', steps: ['打开应用'] } });
const case1Id = Number(case1.json?.id ?? 0);
check(case1.status === 200 && case1Id > 0, '创建测试用例', `id=${case1Id}`);

// 删除用例 → 409 待批
const del1 = await raw('DELETE', `/cases/${case1Id}`);
check(del1.status === 409 && del1.text.includes('人工审批'), '删用例 → 409 待审批', `status=${del1.status}`);
const pending1 = await raw('GET', '/approvals?status=pending');
const item1 = (pending1.json?.items ?? []).find((i) => i.target === `case:${case1Id}:delete`);
check(!!item1 && item1.kind === 'case.delete', '审批列表出现该条（kind=case.delete）', JSON.stringify(item1?.target));
check(pending1.json?.pending === 1, '待批计数 = 1', `pending=${pending1.json?.pending}`);

// 幂等：重复删除不建新单
const del1b = await raw('DELETE', `/cases/${case1Id}`);
check(del1b.status === 409, '重复删除仍 409（幂等复用同一条）', `status=${del1b.status}`);
check((await pendingApprovalCount()) === 1, '待批计数仍为 1（未堆单）');

// ---------- 阶段 2：删除任务闸门（直接 SQL 造任务行） ----------
const t = now();
const taskIns = await getDb().prepare(
  `INSERT INTO tasks (task_no, type, title, library_id, input, trace, status, created_at, updated_at)
   VALUES (?, 'optimize_case', '审批自检任务', ?, '1', '', 'pending', ?, ?)`,
).run('T-APPROVAL-TEST', lib2Id, t, t);
const taskId = Number(taskIns.lastInsertRowid);
const delTask = await raw('DELETE', `/tasks/${taskId}`);
check(delTask.status === 409 && delTask.text.includes('人工审批'), '删任务 → 409 待审批', `status=${delTask.status}`);
const taskItem = (await listApprovals('pending')).find((i) => i.kind === 'task.delete');
check(!!taskItem, '审批列表出现 task.delete');

// ---------- 阶段 3：单元语义 —— requireApproval 令牌机制 ----------
// autoApprove 关：首次抛 pending
let threw = false;
try { await requireApproval('repo.pull', 'library:999:repo.pull', { name: 'unit' }, 'test'); } catch (e) { threw = e instanceof ApprovalPendingError; }
check(threw, 'requireApproval：无令牌 → 抛 ApprovalPendingError');
const unitItem = (await listApprovals('pending')).find((i) => i.kind === 'repo.pull' && i.target === 'library:999:repo.pull');
check(!!unitItem, 'unit 审批记录已建单');
// 批准 → 消费
await decideApproval(unitItem.id, 'approve', 'tester');
const r1 = await requireApproval('repo.pull', 'library:999:repo.pull');
check(r1 === 'approved', '批准后重试 → 消费令牌放行');
// 一次性：再调又抛
let threw2 = false;
try { await requireApproval('repo.pull', 'library:999:repo.pull'); } catch (e) { threw2 = e instanceof ApprovalPendingError; }
check(threw2, '令牌一次性：再次调用重新待批');
// 终态守卫：重复决策 → 409
let guard = false;
try { await decideApproval(unitItem.id, 'approve', 'tester'); } catch (e) { guard = Number(e?.statusCode) === 409; }
check(guard, '终态守卫：已决策的审批不能重复决策（409）');

// ---------- 阶段 4：拒绝路径 ----------
const case2 = await raw('POST', '/cases', { body: { libraryId: lib2Id, caseNo: 'AP-002', name: '审批用例二', steps: ['打开应用'] } });
const case2Id = Number(case2.json?.id ?? 0);
const del2 = await raw('DELETE', `/cases/${case2Id}`);
check(del2.status === 409, '删用例二 → 409');
const item2 = (await listApprovals('pending')).find((i) => i.target === `case:${case2Id}:delete`);
await decideApproval(item2.id, 'reject', 'tester', '理由：自检拒绝路径');
const del2b = await raw('DELETE', `/cases/${case2Id}`);
check(del2b.status === 409, '拒绝后重试仍被拦截（409）');

// ---------- 阶段 5：批准 → 重试 → 真删（端到端） ----------
await decideApproval(item1.id, 'approve', 'tester');
const del1c = await raw('DELETE', `/cases/${case1Id}`);
check(del1c.status === 200, '批准后重试删除 → 200 真删', `status=${del1c.status}`);
const gone = await raw('GET', `/cases/${case1Id}`);
check(gone.status === 404, '用例确实已删除（404）');

// ---------- 阶段 6：角色门禁（auth 开启） ----------
// 先造数（此刻 auth 还关着，直连即 admin），再开认证测 Key 门禁——顺序反了会 401 造不出数
const case3 = await raw('POST', '/cases', { body: { libraryId: lib2Id, caseNo: 'AP-003', name: '审批用例三', steps: ['打开应用'] } });
const case3Id = Number(case3.json?.id ?? 0);
check(case3.status === 200 && case3Id > 0, 'auth 关闭前造数（直连即 admin）', `id=${case3Id}`);
setSetting('auth.enabled', true);
setSetting('auth.allowLocalBypass', false);
const viewer = await createApiKey({ name: 'a-viewer', role: 'viewer' });
const operator = await createApiKey({ name: 'a-operator', role: 'operator' });
const noKey = await raw('DELETE', `/cases/${case3Id}`);
check(noKey.status === 401, 'auth 开启：无 Key 删用例 → 401', `status=${noKey.status}`);
const vDel = await raw('DELETE', `/cases/${case3Id}`, { headers: bearer(viewer.key) });
check(vDel.status === 403, 'viewer 删用例 → 403（写操作限 operator）', `status=${vDel.status}`);
const oDel = await raw('DELETE', `/cases/${case3Id}`, { headers: bearer(operator.key) });
check(oDel.status === 409 && oDel.text.includes('人工审批'), 'operator 删用例 → 409 待批（闸门在鉴权后）', `status=${oDel.status}`);
const item3 = (await listApprovals('pending')).find((i) => i.target === `case:${case3Id}:delete`);
const vDecide = await raw('POST', `/approvals/${item3.id}/decide`, { headers: bearer(viewer.key), body: { decision: 'approve' } });
check(vDecide.status === 403, 'viewer 审批 → 403（决策限 operator）', `status=${vDecide.status}`);
const oDecide = await raw('POST', `/approvals/${item3.id}/decide`, { headers: bearer(operator.key), body: { decision: 'approve', reason: '自检批准' } });
check(oDecide.status === 200, 'operator 审批 → 200', `status=${oDecide.status}`);
const vList = await raw('GET', '/approvals', { headers: bearer(viewer.key) });
check(vList.status === 200, 'viewer 可看审批列表（只读）', `status=${vList.status}`);
const oDel2 = await raw('DELETE', `/cases/${case3Id}`, { headers: bearer(operator.key) });
check(oDel2.status === 200, '批准后 operator 重试删除 → 200 真删', `status=${oDel2.status}`);

// ---------- 汇总 ----------
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
server.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
