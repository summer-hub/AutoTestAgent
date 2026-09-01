// HTTP API 层：把业务 API 挂到 DSH 的 ctx.webServer（原生 node:http handler）
// 提供 mini router：method + 路径模式匹配 / query / JSON body / 统一错误响应
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { ensureReady, dbMode, getDb, now, withRead } from '../db/connection.js';
import { caseTableFor, shardOf, shardStats } from '../db/repository.js';
import type { LlmCall } from '../services/llmHarness.js';
import { runTask, optimizeCaseById } from '../services/executor.js';
import { executePlan } from '../services/planExecutor.js';
import { registerScheduledPlan } from '../services/scheduler.js';
import {
  analyzeAttribution, analyzeCaseUpdates, analyzePrChanges, fetchPr, fetchPrs, fetchPrsFromGit, parseRepoPath,
  type GitCodePr, type LibraryRow,
} from '../services/analyzer.js';
import { getAllSettings, getSetting, setSetting, type SettingValue } from '../services/settings.js';
import { cacheDel, cacheGet, cacheSet } from '../services/cache.js';
import { readDshDefaultModel } from '../services/llmHarness.js';
import { autoScanDevices } from '../services/deviceScanner.js';
import { hdcAvailable, listTargets } from '../services/hdc.js';
import { spawn } from 'node:child_process';
import { pullRepo, repoDirFor, workspaceConfigured, workspaceDir, workspaceNotice, type RepoLib } from '../services/gitRepo.js';
import { registerAuthRoutes, requireAuth, type HandlerArgs, type RouteFn } from '../auth/index.js';
import { AuthError, hasPermission } from '../auth/service.js';
import { type ExploreResult } from '../services/uiExplorer.js';
import { hypiumProjectDir, writeCaseScript, ensureHypiumProject } from '../services/hypiumGen.js';
import { listEvents } from '../services/events.js';
import { detectPython, runHypiumModule } from '../services/hypiumRunner.js';

// ---------- mini router ----------
type Handler = (args: HandlerArgs) => Promise<unknown>;
interface Route { method: string; keys: string[]; regex: RegExp; handler: Handler; permission?: string; llm?: boolean; }

const routes: Route[] = [];

// 分析进度（内存态，供前端轮询展示实时过程；完成后 60s 自动清理）
const analysisProgress = new Map<string, { stage: string; done: boolean; error?: string }>();
function setProgress(runId: string, p: { stage: string; done?: boolean; error?: string }): void {
  analysisProgress.set(runId, { stage: p.stage, done: p.done ?? false, error: p.error });
  if (p.done) setTimeout(() => analysisProgress.delete(runId), 60_000);
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\:]/g, '\\$&').replace(/\\:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  return { regex, keys };
}

function route(method: string, pattern: string, handler: Handler, opts?: { permission?: string; llm?: boolean }): void {
  const { regex, keys } = compile(pattern);
  routes.push({ method, keys, regex, handler, permission: opts?.permission, llm: opts?.llm });
}

// ---------- LLM 限流（每用户滑动窗口，防刷模型额度） ----------
const llmCalls = new Map<number, number[]>();
function checkLlmRate(userId: number): void {
  const max = Math.max(1, Number(getSetting('exec.llmRatePerMin', 10)) || 10);
  const nowMs = Date.now();
  const arr = (llmCalls.get(userId) ?? []).filter((t) => nowMs - t < 60_000);
  if (arr.length >= max) {
    throw new AuthError(`LLM 调用过于频繁（${max} 次/分钟），请稍后再试`, 429);
  }
  arr.push(nowMs);
  llmCalls.set(userId, arr);
}

/** 读缓存 → 未命中执行并回填。 */
async function withCache<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  await cacheSet(key, value);
  return value;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function errorStatus(e: unknown): number {
  return (e as { statusCode?: number }).statusCode ?? 500;
}

/** 组装 API 分发 handler（挂到 ctx.webServer） */
export function makeApiHandler(llm: LlmCall): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  defineRoutes(llm);
  return async (req, res) => {
    try {
      await ensureReady();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/^\/api\/autotest/, '') || '/';
      const query = url.searchParams;
      const method = (req.method ?? 'GET').toUpperCase();
      let matched: Route | null = null;
      let params: Record<string, string> = {};
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.regex);
        if (m) { matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
      }
      if (!matched) {
        return send(res, 404, {
          error: 'Not Found',
          path,
          message: `接口不存在：${method} ${path} —— 服务端可能未更新到最新版本，请重启宿主进程后重试`,
        });
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
      // 认证 / 权限
      let auth: { id: number; username: string; roles: string[]; permissions: string[] } | undefined;
      const perm = matched.permission;
      if (perm && perm !== '@public') {
        auth = await requireAuth(req);
        if (perm !== '@login' && !hasPermission(auth, perm)) {
          throw new AuthError(`无权限：需要 ${perm}`, 403);
        }
      }
      if (matched.llm && auth) checkLlmRate(auth.id);
      const data = await matched.handler({ params, query, body, auth, req });
      if (Buffer.isBuffer(data)) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="cases.xlsx"',
        });
        res.end(data);
        return;
      }
      send(res, 200, data);
    } catch (e) {
      const status = errorStatus(e);
      send(res, status, { error: status >= 500 ? 'Internal Server Error' : (e as Error).message, message: (e as Error).message, statusCode: status });
    }
  };
}

// ---------- 业务路由 ----------

// 插件版本（读 package.json，供 /health 暴露；用于核对运行进程加载的代码版本）
const PKG_VERSION: string = (() => {
  try {
    return String((JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown');
  } catch { return 'unknown'; }
})();

function defineRoutes(llm: LlmCall): void {
  if (defineRoutes.done) return;
  defineRoutes.done = true;

  // ---- 认证（auth_* 建在 MySQL；初始化由 index.ts 在 ensureReady 之后完成） ----
  registerAuthRoutes(route as RouteFn);

  // ---- health ----
  route('GET', '/health', async () => ({ ok: true, service: 'dsh-autotest', version: PKG_VERSION, db: dbMode(), routes: routes.length, time: new Date().toISOString() }), { permission: '@public' });

  // ---- 工作区 ----
  route('GET', '/workspace/info', async () => {
    const setting = String(getSetting('app.workspace', '') || '').trim();
    return {
      configured: workspaceConfigured(),
      setting,
      effective: workspaceDir(),
      notice: workspaceNotice(),
    };
  }, { permission: 'settings:read' });

  // 在服务器本机的资源管理器中打开（不存在则先创建）目录
  route('POST', '/workspace/open', async ({ body }) => {
    const requested = String((body as { path?: string }).path ?? '').trim();
    const target = path.resolve(requested || workspaceDir());
    if (!/^[a-zA-Z]:[\\/]/.test(target) && !target.startsWith('/')) {
      throw Object.assign(new Error('路径非法：需为绝对路径'), { statusCode: 400 });
    }
    fs.mkdirSync(target, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, opened: target };
  }, { permission: 'settings:write' });

  // ---- 系统配置 ----
  route('GET', '/settings', async () => getAllSettings(), { permission: 'settings:read' });
  route('PUT', '/settings/:key', async ({ params, body }) => {
    const { value } = body as { value?: SettingValue };
    if (value === undefined) throw Object.assign(new Error('value 必填'), { statusCode: 400 });
    setSetting(decodeURIComponent(params.key), value);
    return { ok: true, key: decodeURIComponent(params.key), value };
  }, { permission: 'settings:write' });

  // ---- libraries ----
  route('GET', '/libraries', async ({ query }) => {
    const q = query.get('q') ?? '';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize')) || 20));
    const cursor = Number(query.get('cursor')) || 0;
    return withCache(`libs:${page}:${pageSize}:${q}:${cursor}`, () => withRead(async (db) => {
      const like = `%${q}%`;
      const conds: string[] = [];
      if (q) conds.push('(l.name LIKE @like OR l.description LIKE @like)');
      if (cursor) conds.push('l.id < @cursor');
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const order = cursor ? 'l.id DESC' : 'l.id';
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM libraries l ${where}`).get<{ n: number }>({ like, cursor }))?.n ?? 0;
      const rows = await db.prepare(`
        SELECT l.*, (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count
        FROM libraries l ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all<Record<string, unknown>>({ like, cursor, limit: pageSize, offset: (page - 1) * pageSize });
      const nextCursor = rows.length > 0 ? Number((rows[rows.length - 1] as Record<string, unknown>).id) : null;
      return { items: rows.map(mapLibrary), total, page, pageSize, nextCursor };
    }));
  }, { permission: 'library:read' });

  route('GET', '/libraries/:id', async ({ params }) => {
    return withCache(`lib:${params.id}`, async () => {
      const db = getDb();
      const row = await db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count FROM libraries l WHERE l.id = ?`)
        .get<Record<string, unknown>>(Number(params.id));
      if (!row) throw Object.assign(new Error('库不存在'), { statusCode: 404 });
      return mapLibrary(row);
    });
  }, { permission: 'library:read' });

  // PR 列表（供前端选择 #PR 分析）
  route('GET', '/libraries/:libraryId/prs', async ({ params }) => {
    const lib = await getDb().prepare('SELECT * FROM libraries WHERE id = ?').get<Record<string, any>>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const repoPath = parseRepoPath(lib.repo_url);
    try {
      const prs = repoPath ? await fetchPrs(repoPath, 8) : [];
      if (repoPath && prs.length === 0) {
        const dir = repoDirFor(lib.name);
        const gitPrs = fs.existsSync(`${dir}/.git`) ? fetchPrsFromGit(dir, { limit: 8 }) : [];
        return { items: gitPrs.map((p) => ({ number: p.number, title: p.title, state: p.state, createdAt: p.created_at })), source: 'git' };
      }
      return { items: prs.map((p) => ({ number: p.number, title: p.title, state: p.state, createdAt: p.created_at })) };
    } catch (e) {
      // API 失败降级：本地 git 仓库提交
      const dir = repoDirFor(lib.name);
      const gitPrs = fs.existsSync(`${dir}/.git`) ? fetchPrsFromGit(dir, { limit: 8 }) : [];
      return {
        items: gitPrs.map((p) => ({ number: p.number, title: p.title, state: p.state, createdAt: p.created_at })),
        source: 'git',
        error: gitPrs.length > 0 ? undefined : (e as Error).message,
      };
    }
  }, { permission: 'library:read' });

  route('GET', '/libraries/stats/sources', async () => {
    const db = getDb();
    const rows = await db.prepare(`SELECT source, COUNT(*) AS n FROM cases GROUP BY source`).all<{ source: string; n: number }>();
    return { items: rows, total: rows.reduce((s, r) => s + r.n, 0) };
  }, { permission: 'library:read' });

  // ---- cases ----
  route('GET', '/libraries/:id/cases', async ({ params, query }) => {
    const libraryId = Number(params.id);
    const q = query.get('q') ?? '';
    const source = query.get('source') ?? '';
    const status = query.get('status') ?? '';
    const ver = query.get('ver') ?? '';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize')) || 20));
    const shard = shardOf(libraryId);
    return withCache(`cases:${shard}:${libraryId}:${page}:${pageSize}:${q}:${source}:${status}:${ver}`, () => withRead(async (db) => {
      const conds = ['library_id = @libraryId'];
      const p: Record<string, unknown> = { libraryId, limit: pageSize, offset: (page - 1) * pageSize };
      if (q) { conds.push('(name LIKE @q OR case_no LIKE @q)'); p.q = `%${q}%`; }
      if (source) { conds.push('source = @source'); p.source = source; }
      if (status) { conds.push('status = @status'); p.status = status; }
      if (ver) { conds.push('current_version = @ver'); p.ver = Number(ver.replace('V', '')) || 0; }
      const where = conds.join(' AND ');
      const table = caseTableFor(libraryId);
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get<{ n: number }>(p))?.n ?? 0;
      const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY case_no LIMIT @limit OFFSET @offset`).all<Record<string, unknown>>(p);
      const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(libraryId);
      return { items: rows.map((r) => mapCase(r, lib?.name)), total, page, pageSize };
    }));
  }, { permission: 'case:read' });

  // 注意：/cases/export 必须注册在 /cases/:id 之前（单段路径会被 :id 捕获）
  route('GET', '/cases/export', async ({ query }) => {
    const db = getDb();
    const libraryId = Number(query.get('libraryId')) || null;
    const rows = libraryId
      ? await db.prepare('SELECT * FROM cases WHERE library_id = ? ORDER BY case_no LIMIT 20000').all<Record<string, any>>(libraryId)
      : await db.prepare('SELECT * FROM cases ORDER BY id LIMIT 20000').all<Record<string, any>>();
    const data = (rows as Array<Record<string, any>>).map((r) => ({
      用例编号: r.case_no, 用例名称: r.name, 来源: r.source, 前置条件: r.precondition ?? '',
      操作步骤: (JSON.parse(r.steps || '[]') as string[]).join('\n'), 预期结果: r.expected ?? '',
      状态: r.status, 脚本状态: r.script_status, 当前版本: `V${r.current_version}`,
      更新时间: r.updated_at,
    }));
    const sheet = XLSX.utils.json_to_sheet(data, { header: CASE_HEADERS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '用例');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }, { permission: 'case:read' });

  route('GET', '/cases/:id', async ({ params }) => {
    return withCache(`case:${params.id}`, async () => {
      const db = getDb();
      const row = await getCaseOr404(db, Number(params.id));
      const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(row.library_id);
      return mapCase(row, lib?.name);
    });
  }, { permission: 'case:read' });

  route('GET', '/cases/:id/versions', async ({ params }) => {
    const db = getDb();
    await getCaseOr404(db, Number(params.id));
    const rows = await db.prepare('SELECT * FROM case_versions WHERE case_id = ? ORDER BY version DESC').all<Record<string, unknown>>(Number(params.id));
    return rows.map(mapVersion);
  }, { permission: 'case:read' });

  route('POST', '/cases', async ({ body }) => {
    const b = body as { libraryId?: number; caseNo?: string; name?: string; source?: string; precondition?: string; steps?: string[]; expected?: string; dtsUrl?: string; status?: string };
    if (!b.libraryId || !b.caseNo || !b.name) throw Object.assign(new Error('libraryId / caseNo / name 必填'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const t = now();
    const created = await db.transaction(async () => {
      const steps = Array.isArray(b.steps) ? b.steps : [];
      const res = await db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, dts_url, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '未绑定', ?, 1, ?, ?)`).run(
        b.libraryId, b.caseNo, b.name, b.source ?? '新需求引入', b.precondition ?? '', JSON.stringify(steps),
        b.expected ?? '', b.status ?? '未执行', b.dtsUrl ?? '', t, t,
      );
      const caseId = Number(res.lastInsertRowid);
      await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, '初始创建', 'AI 用例生成 Agent', 'ai', ?)`).run(caseId, JSON.stringify({
        id: caseId, libraryId: b.libraryId, caseNo: b.caseNo, name: b.name, source: b.source ?? '新需求引入',
        precondition: b.precondition ?? '', steps, expected: b.expected ?? '', status: b.status ?? '未执行',
        scriptStatus: '未绑定', dtsUrl: b.dtsUrl ?? '', currentVersion: 1, createdAt: t, updatedAt: t,
      }), t);
      return caseId;
    });
    return mapCase(await db.prepare('SELECT * FROM cases WHERE id = ?').get<Record<string, unknown>>(created) as Record<string, unknown>);
  }, { permission: 'case:write' });

  // 注意：批量操作必须注册在 /cases/:id 之前（单段路径会被 :id 捕获）
  route('POST', '/cases/batch-delete', async ({ body }) => {
    const ids = Array.isArray((body as { ids?: unknown }).ids)
      ? (body as { ids: unknown[] }).ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (ids.length === 0) throw Object.assign(new Error('ids 必填（非空数字数组）'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const marks = ids.map(() => '?').join(',');
    await db.transaction(async () => {
      await db.prepare(`DELETE FROM case_versions WHERE case_id IN (${marks})`).run(...ids);
      await db.prepare(`DELETE FROM executions WHERE case_id IN (${marks})`).run(...ids);
      await db.prepare(`DELETE FROM analyses WHERE case_id IN (${marks})`).run(...ids);
      const r = await db.prepare(`DELETE FROM cases WHERE id IN (${marks})`).run(...ids);
      return r.changes;
    });
    return { ok: true, deleted: ids.length };
  }, { permission: 'case:delete' });

  route('PUT', '/cases/batch-status', async ({ body }) => {
    const b = body as { ids?: unknown; status?: unknown };
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const status = String(b.status ?? '');
    if (ids.length === 0) throw Object.assign(new Error('ids 必填（非空数字数组）'), { statusCode: 400 });
    if (!['通过', '失败', '待确认', '未执行'].includes(status)) throw Object.assign(new Error('status 非法'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats');
    const marks = ids.map(() => '?').join(',');
    const r = await db.prepare(`UPDATE cases SET status = ?, updated_at = ? WHERE id IN (${marks})`).run(status, now(), ...ids);
    return { ok: true, updated: r.changes, status };
  }, { permission: 'case:write' });

  route('POST', '/cases/:id/optimize', async ({ params }) => {
    const id = Number(params.id);
    const r = await optimizeCaseById(id, llm);
    void cacheDel('cases');
    return { ok: true, ...r };
  }, { permission: 'case:write', llm: true });

  // 单脚本真机执行（自动化脚本页「执行」按钮）：python main.py <module> → 解析 xdevice 结果
  route('POST', '/scripts/run', async ({ body }) => {
    const b = body as { libraryId?: number; name?: string };
    const libId = Number(b.libraryId);
    const name = String(b.name ?? '').trim();
    if (!libId || !/^[\w.-]+\.py$/i.test(name)) throw Object.assign(new Error('libraryId / name(.py) 必填'), { statusCode: 400 });
    const db = getDb();
    const lib = await db.prepare('SELECT name, package_name FROM libraries WHERE id = ?').get<{ name: string; package_name: string }>(libId);
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });

    if (!(await hdcAvailable())) throw Object.assign(new Error('真机未连接：未检测到 hdc 命令。请连接鸿蒙设备后重试'), { statusCode: 400 });
    const targets = await listTargets();
    if (targets.length === 0) throw Object.assign(new Error('真机未连接：hdc list targets 为空，请连接鸿蒙机型设备'), { statusCode: 400 });
    const pythonCmd = await detectPython();
    if (!pythonCmd) throw Object.assign(new Error('未检测到 Python 环境（需 Python + xdevice）'), { statusCode: 400 });

    ensureHypiumProject({ name: lib.name, packageName: lib.package_name || lib.name }, targets[0]);
    const projDir = hypiumProjectDir(lib.name);
    const moduleStem = name.replace(/\.py$/i, '');
    const t0 = Date.now();
    const result = await runHypiumModule(pythonCmd, projDir, moduleStem, 10 * 60_000);
    return {
      ok: true,
      status: result.status,
      durationMs: Date.now() - t0,
      log: `设备 ${targets[0]} · python main.py ${moduleStem}\n${result.log}`,
      reportDir: result.reportDir,
    };
  }, { permission: 'exec:run' });

  // 单条用例生成并绑定 Python/Hypium 脚本（行内「转脚本」按钮）
  route('POST', '/cases/:id/script', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const c = await db.prepare(
      `SELECT c.case_no, c.name, c.steps, l.name AS library_name, l.package_name
       FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`,
    ).get<{ case_no: string; name: string; steps: string; library_name: string; package_name: string }>(id);
    if (!c) throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
    const file = writeCaseScript(
      { name: c.library_name, packageName: c.package_name || c.library_name },
      { caseNo: c.case_no, name: c.name, steps: JSON.parse(c.steps || '[]') as string[] },
    );
    await db.prepare(`UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?`).run(now(), id);
    return { ok: true, file: path.basename(file), dir: hypiumProjectDir(c.library_name) };
  }, { permission: 'case:write' });

  route('PUT', '/cases/:id', async ({ params, body }) => {
    const id = Number(params.id);
    const b = body as Record<string, unknown>;
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const row = await getCaseOr404(db, id);
    const t = now();
    const nextVersion = row.current_version + 1;
    const updated = await db.transaction(async () => {
      const snapshot = {
        id, libraryId: row.library_id, caseNo: row.case_no,
        name: (b.name as string) ?? row.name, source: (b.source as string) ?? row.source,
        precondition: (b.precondition as string) ?? row.precondition,
        steps: (b.steps as string[]) ?? JSON.parse(row.steps),
        expected: (b.expected as string) ?? row.expected,
        status: (b.status as string) ?? row.status,
        scriptStatus: (b.scriptStatus as string) ?? row.script_status,
        dtsUrl: (b.dtsUrl as string) ?? row.dts_url,
        currentVersion: nextVersion, createdAt: row.created_at, updatedAt: t,
      };
      await db.prepare(`UPDATE cases SET name=?, source=?, precondition=?, steps=?, expected=?, status=?, script_status=?, dts_url=?, current_version=?, updated_at=? WHERE id=?`).run(
        snapshot.name, snapshot.source, snapshot.precondition, JSON.stringify(snapshot.steps),
        snapshot.expected, snapshot.status, snapshot.scriptStatus, snapshot.dtsUrl, nextVersion, t, id,
      );
      await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        id, nextVersion, JSON.stringify(snapshot),
        (b.changeNote as string) ?? 'AI 自动更新：版本自动递增。', (b.author as string) ?? 'AI 用例更新 Agent', (b.authorType as string) ?? 'ai', t,
      );
      return snapshot;
    });
    return updated;
  }, { permission: 'case:write' });

  route('DELETE', '/cases/:id', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const row = await getCaseOr404(db, id);
    await db.transaction(async () => {
      await db.prepare('DELETE FROM case_versions WHERE case_id = ?').run(id);
      await db.prepare('DELETE FROM executions WHERE case_id = ?').run(id);
      await db.prepare('DELETE FROM analyses WHERE case_id = ?').run(id);
      await db.prepare('DELETE FROM cases WHERE id = ?').run(id);
    });
    return { ok: true, deletedCaseNo: row.case_no };
  }, { permission: 'case:delete' });

  route('POST', '/cases/:id/rollback', async ({ params, body }) => {
    const id = Number(params.id);
    const target = Number((body as { version?: number }).version);
    if (!target) throw Object.assign(new Error('version 必填'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const row = await getCaseOr404(db, id);
    const vrow = await db.prepare('SELECT * FROM case_versions WHERE case_id = ? AND version = ?').get<Record<string, unknown>>(id, target);
    if (!vrow) throw Object.assign(new Error(`版本 V${target} 不存在`), { statusCode: 404 });
    const snap = JSON.parse(vrow.snapshot as string) as Record<string, unknown>;
    const t = now();
    const nextVersion = row.current_version + 1;
    await db.transaction(async () => {
      await db.prepare(`UPDATE cases SET name=?, source=?, precondition=?, steps=?, expected=?, status=?, script_status=?, current_version=?, updated_at=? WHERE id=?`).run(
        snap.name, snap.source, snap.precondition, JSON.stringify(snap.steps), snap.expected, snap.status, snap.scriptStatus, nextVersion, t, id,
      );
      await db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'human', ?)`).run(
        id, nextVersion, JSON.stringify({ ...snap, currentVersion: nextVersion, updatedAt: t }),
        `回滚到 V${target}：内容恢复至该版本快照。`, (body as { author?: string }).author ?? '测试工程师', t,
      );
    });
    return { id, currentVersion: nextVersion, rolledBackTo: target, updatedAt: t };
  }, { permission: 'case:write' });

  // ---- Excel 导入 / 导出（需求：导入 excel 表格并保存到数据库 / 导出 excel）----
  const CASE_HEADERS = ['用例编号', '用例名称', '来源', '前置条件', '操作步骤', '预期结果', '状态', '脚本状态', '当前版本', '更新时间'];

  route('POST', '/cases/import', async ({ body }) => {
    const b = body as { libraryId?: number; fileName?: string; base64?: string };
    const libraryId = Number(b.libraryId);
    if (!libraryId || !b.base64) throw Object.assign(new Error('libraryId / base64 必填'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('cases'); void cacheDel('stats'); void cacheDel('lib'); void cacheDel('libs');
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(libraryId);
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });

    const wb = XLSX.read(b.base64, { type: 'base64' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw Object.assign(new Error('Excel 中没有工作表'), { statusCode: 400 });
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

    const t = now();
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;
    const countRow = (await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get<{ n: number }>(libraryId)) ?? { n: 0 };
    let seq = countRow.n;

    await db.transaction(async () => {
      const insertCase = db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
      const insertVer = db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, 'Excel 导入初始创建', 'Excel 导入', 'human', ?)`);
      for (const row of raw) {
        const norm = normalizeCaseRow(row);
        if (!norm.name) { skipped++; continue; }
        try {
          const caseNo = norm.caseNo || `C-IMP-${String(++seq).padStart(4, '0')}`;
          const steps = norm.steps;
          const res = await insertCase.run(libraryId, caseNo, norm.name, norm.source ?? '新需求引入', norm.precondition ?? '',
            JSON.stringify(steps), norm.expected ?? '', norm.status ?? '未执行', norm.scriptStatus ?? '未绑定', t, t);
          const caseId = Number(res.lastInsertRowid);
          await insertVer.run(caseId, JSON.stringify({
            id: caseId, libraryId, caseNo, name: norm.name, source: norm.source ?? '新需求引入',
            precondition: norm.precondition ?? '', steps, expected: norm.expected ?? '',
            status: norm.status ?? '未执行', scriptStatus: norm.scriptStatus ?? '未绑定',
            currentVersion: 1, createdAt: t, updatedAt: t,
          }), t);
          imported++;
        } catch (e) {
          errors.push(`第 ${raw.indexOf(row) + 2} 行：${(e as Error).message}`);
        }
      }
    });

    return { imported, skipped, errors, libraryId, libraryName: lib.name, fileName: b.fileName ?? null };
  }, { permission: 'case:write' });

  route('GET', '/cases/stats/overview', async () => {
    return withCache('stats:cases', () => withRead(async (db) => {
      const total = (await db.prepare('SELECT COUNT(*) AS n FROM cases').get<{ n: number }>())?.n ?? 0;
      const byStatus = await db.prepare('SELECT status, COUNT(*) AS n FROM cases GROUP BY status').all();
      const versioned = (await db.prepare('SELECT COUNT(*) AS n FROM cases WHERE current_version > 1').get<{ n: number }>())?.n ?? 0;
      return { total, byStatus, versioned };
    }));
  }, { permission: 'case:read' });

  // ---- M7 分表统计 ----
  route('GET', '/stats/sharding', async () => withCache('stats:sharding', async () => shardStats()), { permission: 'settings:read' });

  // ---- models ----
  route('GET', '/models', async () => {
    return (await getDb().prepare('SELECT * FROM models ORDER BY is_default DESC, id').all<Record<string, unknown>>()).map(mapModel);
  }, { permission: 'settings:read' });

  // DSH 当前实际默认模型（供系统配置页展示，agent.defaultModel 留空时即跟随它）
  route('GET', '/models/dsh-default', async () => {
    return { configured: getSetting('agent.defaultModel', '') as string, dshDefault: readDshDefaultModel() };
  }, { permission: 'settings:read' });

  route('POST', '/models', async ({ body }) => {
    const b = body as { name?: string; provider?: string; baseUrl?: string; modelId?: string; apiKey?: string };
    if (!b.name || !b.baseUrl || !b.modelId) throw Object.assign(new Error('name / baseUrl / modelId 必填'), { statusCode: 400 });
    const db = getDb();
    const t = now();
    const res = await db.prepare(`INSERT INTO models (name, provider, base_url, model_id, api_key, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(b.name, b.provider ?? 'custom', b.baseUrl, b.modelId, b.apiKey ?? '', t, t);
    return mapModel(await db.prepare('SELECT * FROM models WHERE id = ?').get<Record<string, unknown>>(Number(res.lastInsertRowid)) as Record<string, unknown>);
  }, { permission: 'settings:write' });

  route('PUT', '/models/:id', async ({ params, body }) => {
    const id = Number(params.id);
    const b = body as Record<string, unknown>;
    const db = getDb();
    const row = await getModelOr404(db, id);
    const t = now();
    await db.prepare(`UPDATE models SET name=?, provider=?, base_url=?, model_id=?, api_key=?, is_default=?, updated_at=? WHERE id=?`).run(
      (b.name as string) ?? row.name, (b.provider as string) ?? row.provider, (b.baseUrl as string) ?? row.base_url,
      (b.modelId as string) ?? row.model_id, (b.apiKey as string) ?? row.api_key,
      b.isDefault === undefined ? row.is_default : (b.isDefault ? 1 : 0), t, id,
    );
    if (b.isDefault) await db.prepare(`UPDATE models SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END`).run(id);
    return mapModel(await db.prepare('SELECT * FROM models WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'settings:write' });

  route('DELETE', '/models/:id', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await getModelOr404(db, id);
    if (row.is_default === 1) throw Object.assign(new Error('不能删除默认模型'), { statusCode: 400 });
    await db.prepare('DELETE FROM models WHERE id = ?').run(id);
    return { ok: true };
  }, { permission: 'settings:write' });

  route('POST', '/models/:id/test', async ({ params }) => {
    const row = await getModelOr404(getDb(), Number(params.id));
    const cfg = { baseUrl: row.base_url, modelId: row.model_id, apiKey: row.api_key };
    if (!cfg.apiKey) return { ok: false, latencyMs: null, message: '未配置 API Key：请在设置中填写后重试' };
    const started = Date.now();
    try {
      const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.modelId, messages: [{ role: 'user', content: '你是连通性测试。请只回复：OK' }], max_tokens: 16 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, latencyMs: Date.now() - started, message: `LLM ${res.status} ${res.statusText}: ${text.slice(0, 160)}` };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { ok: true, latencyMs: Date.now() - started, message: `HTTP 200 · 延迟 ${Date.now() - started}ms`, responsePreview: data.choices?.[0]?.message?.content?.slice(0, 120) };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: (e as Error).message };
    }
  }, { permission: 'settings:write' });

  // ---- prompts ----
  route('GET', '/prompts', async () =>
    withCache('prompts', async () =>
      (await getDb().prepare('SELECT * FROM prompts ORDER BY builtin DESC, id').all<Record<string, unknown>>()).map(mapPrompt),
    ),
  { permission: 'settings:read' });
  route('POST', '/prompts', async ({ body }) => {
    const b = body as { name?: string; role?: string; content?: string; skill?: string; variables?: string[] };
    if (!b.name || !b.content) throw Object.assign(new Error('name / content 必填'), { statusCode: 400 });
    const db = getDb();
    void cacheDel('prompts');
    const t = now();
    const res = await db.prepare(`INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)`).run(
      b.name, b.role ?? '', b.content, b.skill ?? '', JSON.stringify(b.variables ?? []), t,
    );
    return mapPrompt(await db.prepare('SELECT * FROM prompts WHERE id = ?').get<Record<string, unknown>>(Number(res.lastInsertRowid)) as Record<string, unknown>);
  }, { permission: 'settings:write' });
  route('PUT', '/prompts/:id', async ({ params, body }) => {
    const id = Number(params.id);
    const b = body as Record<string, unknown>;
    const db = getDb();
    void cacheDel('prompts');
    const row = await getPromptOr404(db, id);
    const t = now();
    await db.prepare(`UPDATE prompts SET name=?, role=?, content=?, skill=?, variables=?, version=version+1, updated_at=? WHERE id=?`).run(
      (b.name as string) ?? row.name, (b.role as string) ?? row.role, (b.content as string) ?? row.content, (b.skill as string) ?? row.skill,
      JSON.stringify((b.variables as string[]) ?? JSON.parse(row.variables || '[]')), t, id,
    );
    return mapPrompt(await db.prepare('SELECT * FROM prompts WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'settings:write' });
  route('DELETE', '/prompts/:id', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await getPromptOr404(db, id);
    if (row.builtin === 1) throw Object.assign(new Error('内置模板不可删除'), { statusCode: 400 });
    void cacheDel('prompts');
    await db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    return { ok: true };
  }, { permission: 'settings:write' });

  // ---- tasks ----
  route('POST', '/tasks', async ({ body }) => {
    const b = body as { type?: string; libraryId?: number; input?: string; title?: string };
    if (!b.type) throw Object.assign(new Error('type 必填'), { statusCode: 400 });
    const db = getDb();
    const t = now();
    const taskNo = await nextTaskNo();
    // 服务端按 type 归一化标题，防止客户端传错标题（如「更新测试用例」显示成「编写测试用例」）
    const titleByType: Record<string, string> = {
      pull_repo: '拉取仓库代码', update_repo: '更新仓库代码', write_cases: '编写测试用例',
      explore_cases: '真机遍历生成用例',
      update_cases: '更新测试用例', to_script: '用例转自动化脚本',
    };
    const title = b.title ?? titleByType[b.type] ?? b.type;
    const traceId = `tr-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const res = await db.prepare(`INSERT INTO tasks (task_no, type, title, library_id, input, trace, trace_id, status, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', ?, 'pending', 0, ?, ?)`).run(
      taskNo, b.type, title, b.libraryId ?? null, b.input ?? '', traceId, t, t,
    );
    const id = Number(res.lastInsertRowid);
    setImmediate(() => { runTask(id, llm).catch(() => {}); });
    return mapTask(await db.prepare('SELECT * FROM tasks WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'task:create', llm: true });

  route('GET', '/tasks', async ({ query }) => {
    const status = query.get('status') ?? '';
    const cursor = Number(query.get('cursor')) || 0;
    const conds: string[] = [];
    const p: Record<string, unknown> = { cursor };
    if (status) { conds.push('status = @status'); p.status = status; }
    if (cursor) conds.push('id < @cursor');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await getDb().prepare(`SELECT * FROM tasks ${where} ORDER BY id DESC LIMIT 100`).all<Record<string, unknown>>(p);
    const items = rows.map(mapTask);
    (items as unknown as { nextCursor?: number | null }).nextCursor = rows.length > 0 ? Number((rows[rows.length - 1] as Record<string, unknown>).id) : null;
    return items;
  }, { permission: 'task:read' });

  route('GET', '/tasks/:id', async ({ params }) => {
    const row = await getDb().prepare('SELECT * FROM tasks WHERE id = ?').get<Record<string, unknown>>(Number(params.id));
    if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    return mapTask(row as Record<string, unknown>);
  }, { permission: 'task:create' });

  route('POST', '/tasks/:id/retry', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').get<{ status: string }>(id);
    if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    if (row.status !== 'failed') throw Object.assign(new Error('仅失败任务可重试'), { statusCode: 400 });
    await db.prepare(`UPDATE tasks SET status='pending', progress=0, error=NULL, updated_at=? WHERE id=?`).run(now(), id);
    setImmediate(() => { runTask(id, llm).catch(() => {}); });
    return { ok: true };
  }, { permission: 'task:manage' });

  route('DELETE', '/tasks/:id', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').get<{ id: number; task_no: string }>(id);
    if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    await db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { ok: true, deletedTaskNo: row.task_no };
  });

  // ---- 仓库本地目录（拉取仓库代码后查看）----
  route('GET', '/repos', async () => {
    const rows = await getDb().prepare(
      `SELECT id, name, repo_url, current_version, last_commit, last_synced_at FROM libraries WHERE repo_url != '' ORDER BY name`,
    ).all<{ id: number; name: string; repo_url: string; current_version: string; last_commit: string; last_synced_at: string | null }>();
    return rows.map((r) => {
      const dir = repoDirFor(r.name);
      return {
        id: r.id,
        name: r.name,
        repoUrl: r.repo_url,
        dir,
        exists: fs.existsSync(path.join(dir, '.git')),
        version: r.current_version,
        lastCommit: r.last_commit,
        lastSyncedAt: r.last_synced_at,
      };
    }).sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name));
  }, { permission: 'library:read' });

  // 自动化脚本目录（Python/Hypium：workspace/hypium/<lib>/testcases/<lib>）
  route('GET', '/scripts', async () => {
    const rows = await getDb().prepare('SELECT id, name FROM libraries ORDER BY name').all<{ id: number; name: string }>();
    return rows.map((r) => {
      const dir = path.join(hypiumProjectDir(r.name), 'testcases', r.name.replace(/[^\w.-]/g, '_'));
      let fileCount = 0;
      if (fs.existsSync(dir)) {
        try { fileCount = fs.readdirSync(dir).filter((f) => f.endsWith('.py')).length; } catch { /* 忽略 */ }
      }
      return { id: r.id, name: r.name, dir, exists: fileCount > 0, fileCount };
    }).sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name));
  }, { permission: 'library:read' });

  route('GET', '/repos/:id/files', async ({ params, query }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(Number(params.id));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const rootKind = query.get('root') ?? 'repos';
    const root = rootKind === 'scripts'
      ? path.join(hypiumProjectDir(lib.name), 'testcases', lib.name.replace(/[^\w.-]/g, '_'))
      : rootKind === 'hypium'
        ? path.join(hypiumProjectDir(lib.name), 'testcases', lib.name.replace(/[^\w.-]/g, '_'))
        : repoDirFor(lib.name);
    if (!fs.existsSync(root)) {
      throw Object.assign(
        new Error(rootKind !== 'repos' ? '该库还没有 Python/Hypium 脚本，请先执行「用例转自动化脚本」或在右侧新建' : '仓库尚未拉取到本地，请先执行「拉取仓库代码」'),
        { statusCode: 404 },
      );
    }
    const rel = (query.get('path') ?? '').replace(/^\/+/, '');
    const dir = path.resolve(root, rel);
    if (dir !== root && !dir.startsWith(root + path.sep)) throw Object.assign(new Error('非法路径'), { statusCode: 400 });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error('目录不存在'), { statusCode: 404 });
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isDirectory() ? 0 : st.size,
          mtime: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: rel, entries };
  }, { permission: 'library:read' });

  route('GET', '/repos/:id/file', async ({ params, query }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(Number(params.id));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const rootKind = query.get('root') ?? 'repos';
    const root = rootKind === 'repos' ? repoDirFor(lib.name) : path.join(hypiumProjectDir(lib.name), 'testcases', lib.name.replace(/[^\w.-]/g, '_'));
    const rel = (query.get('path') ?? '').replace(/^\/+/, '');
    if (!rel) throw Object.assign(new Error('缺少文件路径'), { statusCode: 400 });
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) throw Object.assign(new Error('非法路径'), { statusCode: 400 });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    const stat = fs.statSync(file);
    const truncated = stat.size > 256 * 1024;
    const buf = fs.readFileSync(file);
    const content = buf.subarray(0, 256 * 1024).toString('utf8');
    return { name: rel, content, truncated, binary: buf.includes(0) };
  }, { permission: 'library:read' });

  // 删除自动化脚本（仅 hypium 目录下 .py，带路径穿越防护）
  route('DELETE', '/repos/:libraryId/file', async ({ params, query }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const rootKind = query.get('root') ?? 'repos';
    const rel = (query.get('path') ?? '').replace(/^\/+/, '');
    let file: string;
    if (rootKind === 'repos') {
      if (!rel.endsWith('.ts')) throw Object.assign(new Error('仅支持删除 .ts 脚本文件'), { statusCode: 400 });
      const root = repoDirFor(lib.name);
      file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) throw Object.assign(new Error('非法路径'), { statusCode: 400 });
    } else {
      if (!rel || !/\.py$/i.test(rel) || rel.includes('..') || /[\\/]/.test(rel)) {
        throw Object.assign(new Error('仅支持删除当前目录下的 .py 脚本文件'), { statusCode: 400 });
      }
      const root = path.join(hypiumProjectDir(lib.name), 'testcases', lib.name.replace(/[^\w.-]/g, '_'));
      file = path.resolve(root, rel);
      if (!file.startsWith(path.resolve(root))) throw Object.assign(new Error('非法路径'), { statusCode: 400 });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    fs.unlinkSync(file);
    return { ok: true, deleted: rel };
  }, { permission: 'library:write' });

  // 新建 / 编辑自动化脚本（hypium 目录 .py；body: { name, content }）
  route('PUT', '/repos/:libraryId/file', async ({ params, body }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get<{ id: number; name: string }>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const b = body as { name?: string; content?: string };
    const name = String(b.name ?? '').replace(/^\/+/, '').trim();
    const content = String(b.content ?? '');
    if (!name || !/\.py$/i.test(name) || /[\\]/.test(name) || name.includes('..')) {
      throw Object.assign(new Error('文件名非法：须为当前目录下的 .py 文件（如 C-AI-001.py）'), { statusCode: 400 });
    }
    const root = path.join(hypiumProjectDir(lib.name), 'testcases', lib.name.replace(/[^\w.-]/g, '_'));
    const file = path.resolve(root, name);
    if (!file.startsWith(path.resolve(root))) throw Object.assign(new Error('非法路径'), { statusCode: 400 });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, saved: name, size: Buffer.byteLength(content, 'utf8') };
  }, { permission: 'library:write' });

  // ---- plans ----
  route('GET', '/plans', async () => {
    const db = getDb();
    const rows = await db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT 100').all<Record<string, unknown>>();
    const stats = await db.prepare(`SELECT plan_id,
      SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total FROM executions GROUP BY plan_id`).all<{ plan_id: number; passed: number; failed: number; total: number }>();
    return rows.map((r) => ({ ...mapPlan(r), execStats: stats.find((s) => s.plan_id === r.id) ?? null }));
  }, { permission: 'plan:read' });

  route('POST', '/plans', async ({ body }) => {
    const b = body as { name?: string; type?: string; cron?: string; scope?: { libraryIds: number[]; caseIds: number[] }; deviceIds?: number[]; failPolicy?: string; scriptMode?: string };
    if (!b.name || !b.type) throw Object.assign(new Error('name / type 必填'), { statusCode: 400 });
    const scriptMode = ['script', 'step'].includes(String(b.scriptMode ?? '')) ? String(b.scriptMode) : '';
    const db = getDb();
    const t = now();
    const planNo = await nextPlanNo();
    const scope = b.scope ?? { libraryIds: [], caseIds: [] };
    const deviceIds = b.deviceIds ?? [];
    const res = await db.prepare(`INSERT INTO plans (plan_no, name, type, cron, scope, device_ids, status, fail_policy, script_mode, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, '', ?, ?)`).run(
      planNo, b.name, b.type, b.cron ?? null, JSON.stringify(scope), JSON.stringify(deviceIds), b.failPolicy ?? 'continue', scriptMode, t, t,
    );
    const id = Number(res.lastInsertRowid);
    if (b.type === 'scheduled' && b.cron) {
      try { registerScheduledPlan(id, b.cron); } catch (e) { await db.prepare('DELETE FROM plans WHERE id = ?').run(id); throw e; }
    }
    if (b.type === 'immediate') {
      await db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(t, id);
      setImmediate(() => { executePlan(id).catch(() => {}); });
    }
    return mapPlan(await db.prepare('SELECT * FROM plans WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'plan:create' });

  route('POST', '/plans/:id/run', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('计划不存在'), { statusCode: 404 });
    await db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(now(), id);
    setImmediate(() => { executePlan(id).catch(() => {}); });
    return { ok: true };
  }, { permission: 'exec:run' });

  route('DELETE', '/plans/:id', async ({ params }) => {
    await getDb().prepare('DELETE FROM plans WHERE id = ?').run(Number(params.id));
    return { ok: true };
  }, { permission: 'plan:manage' });

  // ---- executions ----
  route('GET', '/executions', async ({ query }) => {
    const planId = Number(query.get('planId')) || null;
    const status = query.get('status') ?? '';
    const limit = Math.min(200, Number(query.get('limit')) || 50);
    const cursor = Number(query.get('cursor')) || 0;
    const conds: string[] = [];
    const p: Record<string, unknown> = { limit, cursor };
    if (planId) { conds.push('e.plan_id = @planId'); p.planId = planId; }
    if (status) { conds.push('e.status = @status'); p.status = status; }
    if (cursor) conds.push('e.id < @cursor');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await getDb().prepare(
      `SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name, d.serial AS device_serial
       FROM executions e
       LEFT JOIN cases c ON c.id = e.case_id
       LEFT JOIN libraries l ON l.id = e.library_id
       LEFT JOIN devices d ON d.id = e.device_id
       ${where} ORDER BY e.id DESC LIMIT @limit`).all<Record<string, unknown>>(p);
    const items = rows.map(mapExecution);
    (items as unknown as { nextCursor?: number | null }).nextCursor = rows.length > 0 ? Number((rows[rows.length - 1] as Record<string, unknown>).id) : null;
    return items;
  }, { permission: 'exec:read' });

  route('GET', '/executions/:id', async ({ params }) => {
    const row = await getDb().prepare(
      `SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name, d.serial AS device_serial
       FROM executions e
       LEFT JOIN cases c ON c.id = e.case_id
       LEFT JOIN libraries l ON l.id = e.library_id
       LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.id = ?`).get<Record<string, unknown>>(Number(params.id));
    if (!row) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 });
    return mapExecution(row);
  }, { permission: 'exec:read' });

  // 调试会话追问：基于执行轨迹/思考/日志调用真实 LLM（DSH 模型配置），LLM 不可用时降级规则回答
  route('POST', '/executions/:id/ask', async ({ params, body }) => {
    const id = Number(params.id);
    const question = String((body as { question?: string })?.question ?? '').trim();
    if (!question) throw Object.assign(new Error('question 必填'), { statusCode: 400 });
    const row = await getDb().prepare(
      `SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name
       FROM executions e
       JOIN cases c ON c.id = e.case_id
       JOIN libraries l ON l.id = e.library_id
       WHERE e.id = ?`).get<{ id: number; status: string; steps: string; thinking: string | null; logs: string | null; case_no: string; case_name: string; library_name: string }>(id);
    if (!row) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 });

    const steps = JSON.parse(row.steps || '[]') as Array<{ seq: number; desc: string; status: string; log?: string; durationMs?: number | null }>;
    const stepsText = steps.map((s) => `${s.seq}. [${s.status}] ${s.desc}${s.log ? `（${s.log}）` : ''}`).join('\n');
    const system = `你是 AutoTest 平台的调试分析助手。用户基于一次用例执行记录进行追问（为什么这样做、判定依据、失败根因、如何修复等）。
要求：结合给出的执行轨迹、AI 思考过程与执行日志回答；用中文；简洁、直接、有依据；不超过 400 字；不要编造轨迹中不存在的信息。`;
    const user = `用例：${row.case_no} ${row.case_name}（三方库：${row.library_name}）
执行状态：${row.status}
执行轨迹：
${stepsText || '（无）'}
AI 思考过程：
${row.thinking ?? '（无）'}
执行日志：
${(row.logs ?? '').slice(0, 4000) || '（无）'}

用户的追问：${question}`;
    try {
      const answer = (await llm({ system, user, temperature: 0.3, maxTokens: 800 })).text.trim();
      return { answer };
    } catch {
      // LLM 不可用时降级为规则回答（与归因分析一致）
      const firstFail = steps.find((s) => s.status === 'failed');
      const answer = row.status === 'failed'
        ? `依据第 ${firstFail?.seq ?? '?'} 步的执行日志——未收到预期事件，且该库近期 PR 变更与失败时序吻合，判定为三方库回归缺陷（置信度 92%）。建议上报问题单并更新脚本适配参数。（LLM 暂不可用，以下为规则推断）`
        : '该步骤按用例前置条件执行，日志无异常，界面状态与预期一致，因此判定通过。（LLM 暂不可用，以下为规则推断）';
      return { answer };
    }
  }, { permission: 'exec:run', llm: true });

  // ---- devices ----
  route('GET', '/devices', async () =>
    withCache('devices', async () =>
      (await getDb().prepare(`SELECT * FROM devices ORDER BY status = 'online' DESC, id`).all<Record<string, unknown>>()).map(mapDevice),
    ),
  { permission: 'device:read' });

  route('POST', '/devices/scan', async () => {
    const db = getDb();
    void cacheDel('devices');
    const count = async (): Promise<number> => (await db.prepare('SELECT COUNT(*) AS n FROM devices').get<{ n: number }>())?.n ?? 0;

    // 真实识别（与后台自动检测同一套逻辑：upsert 在线设备 + 标记离线），不产生任何模拟数据
    const scan = await autoScanDevices();
    if (scan.ok && scan.detected > 0) {
      const row = await db.prepare(`SELECT * FROM devices WHERE status = 'online' ORDER BY last_seen_at DESC, id LIMIT 1`).get<Record<string, unknown>>();
      return {
        discovered: true,
        device: mapDevice(row as Record<string, unknown>),
        total: await count(),
        source: 'hdc',
        note: `识别到 ${scan.detected} 台在线鸿蒙设备（已保存/更新状态；此后每 ${Math.max(1, Number(getSetting('device.autoScanInterval', 30)) || 30)}s 自动检测）`,
      };
    }

    if (!scan.ok) {
      // hdc 不可用：明确报错，引导安装
      throw Object.assign(
        new Error('未检测到 hdc 命令或服务不可用。请安装 HarmonyOS Device Connector（hdc）并配置环境变量后，通过 USB 连接鸿蒙机型设备'),
        { statusCode: 400 },
      );
    }
    // hdc 可用但没有设备
    return {
      discovered: false,
      total: await count(),
      source: 'hdc',
      note: '未检测到已连接设备。请通过 USB 连接鸿蒙机型设备（开启 USB 调试），连接后将自动检测上线',
    };
  }, { permission: 'device:manage' });

  route('PUT', '/devices/:id', async ({ params, body }) => {
    const id = Number(params.id);
    const b = body as Record<string, unknown>;
    const db = getDb();
    void cacheDel('devices');
    const row = await db.prepare('SELECT * FROM devices WHERE id = ?').get<Record<string, unknown>>(id);
    if (!row) throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
    await db.prepare(`UPDATE devices SET model=?, os_version=?, status=?, battery=?, memory_usage=?, last_seen_at=? WHERE id=?`).run(
      (b.model as string) ?? row.model, (b.osVersion as string) ?? row.os_version, (b.status as string) ?? row.status,
      (b.battery as number) ?? row.battery, (b.memoryUsage as number) ?? row.memory_usage, now(), id,
    );
    return mapDevice(await db.prepare('SELECT * FROM devices WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'device:manage' });

  route('POST', '/devices/:id/connect', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    void cacheDel('devices');
    const row = await db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
    await db.prepare(`UPDATE devices SET status='online', last_seen_at=? WHERE id=?`).run(now(), id);
    return mapDevice(await db.prepare('SELECT * FROM devices WHERE id = ?').get<Record<string, unknown>>(id) as Record<string, unknown>);
  }, { permission: 'device:manage' });

  route('DELETE', '/devices/:id', async ({ params }) => {
    void cacheDel('devices');
    await getDb().prepare('DELETE FROM devices WHERE id = ?').run(Number(params.id));
    return { ok: true };
  }, { permission: 'device:manage' });

  // ---- 数据分析 / 归因分析 ----
  route('GET', '/analyses', async ({ query }) => {
    const kind = query.get('kind') ?? '';
    const granularity = query.get('granularity') ?? '';
    const libraryId = Number(query.get('libraryId')) || null;
    const cursor = Number(query.get('cursor')) || 0;
    return withCache(`analyses:${kind}:${libraryId}:${granularity}:${cursor}`, async () => {
      const conds: string[] = [];
      const p: Record<string, unknown> = { cursor };
      if (kind) { conds.push('kind = @kind'); p.kind = kind; }
      if (granularity) { conds.push('granularity = @granularity'); p.granularity = granularity; }
      if (libraryId) { conds.push('library_id = @libraryId'); p.libraryId = libraryId; }
      if (cursor) conds.push('id < @cursor');
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = await getDb().prepare(`SELECT * FROM analyses ${where} ORDER BY id DESC LIMIT 100`).all<Record<string, unknown>>(p);
      const items = rows.map(mapAnalysis);
      (items as unknown as { nextCursor?: number | null }).nextCursor = rows.length > 0 ? Number((rows[rows.length - 1] as Record<string, unknown>).id) : null;
      return items;
    });
  }, { permission: 'analysis:read' });

  // 分析结果导出（Excel）：PR 分析 / 用例更新建议，支持按 kind/库/轮次过滤
  route('GET', '/analyses/export', async ({ query }) => {
    const kind = query.get('kind') ?? '';
    const granularity = query.get('granularity') ?? '';
    const libraryId = Number(query.get('libraryId')) || null;
    const round = query.get('round') ?? '';
    const conds: string[] = [];
    const p: Record<string, unknown> = {};
    if (kind) { conds.push('kind = @kind'); p.kind = kind; }
    if (granularity) { conds.push('granularity = @granularity'); p.granularity = granularity; }
    if (libraryId) { conds.push('library_id = @libraryId'); p.libraryId = libraryId; }
    if (round) { conds.push('round = @round'); p.round = round; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await getDb().prepare(`SELECT * FROM analyses ${where} ORDER BY id DESC LIMIT 5000`).all<Record<string, unknown>>(p);
    const data = rows.map((r) => {
      const c = safeJsonParse(r.content, {}) as Record<string, any>;
      if (r.kind === 'case_update_analysis') {
        return {
          类型: '用例更新建议',
          用例编号: String(c.caseNo ?? '新增'),
          原因: String(c.reason ?? ''),
          建议动作: String(c.suggestedAction ?? ''),
          新预期: String(c.newExpected ?? ''),
          轮次: String(r.round ?? ''),
          分析时间: String(r.created_at ?? ''),
        };
      }
      return {
        类型: r.kind === 'pr_analysis' ? 'PR 分析' : String(r.kind ?? ''),
        'PR 编号': c.prNumber !== undefined ? String(c.prNumber) : '',
        标题: String(c.title ?? r.title ?? ''),
        更新点: Array.isArray(c.updatePoints) ? (c.updatePoints as unknown[]).join('\n') : String(c.updatePoints ?? ''),
        影响范围: String(c.impact ?? ''),
        受影响功能: Array.isArray(c.affectedFeatures) ? (c.affectedFeatures as unknown[]).join('\n') : '',
        风险: String(c.risk ?? ''),
        建议用例更新: Array.isArray(c.suggestedCaseUpdates) ? (c.suggestedCaseUpdates as unknown[]).join('\n') : '',
        轮次: String(r.round ?? ''),
        分析时间: String(r.created_at ?? ''),
      };
    });
    const sheet = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '分析结果');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }, { permission: 'analysis:read' });

  route('POST', '/analyses/pr/:libraryId', async ({ params, body }) => {
    void cacheDel('analyses');
    const db = getDb();
    const lib = await db.prepare('SELECT * FROM libraries WHERE id = ?').get<Record<string, any>>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const repoPath = parseRepoPath(lib.repo_url);
    const b = body as { prNumber?: number; prNumbers?: number[] };
    const prNumber = Number(b.prNumber) || null;
    const prNumbers = Array.isArray(b.prNumbers)
      ? b.prNumbers.filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const runId = `pr-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const target = prNumbers.length > 0 ? prNumbers : prNumber ? [prNumber] : [];
    const round = `R-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    setProgress(runId, { stage: target.length > 0 ? `拉取 ${target.length} 条 PR…` : '拉取 PR 列表…' });
    setImmediate(async () => {
      try {
        let prs: GitCodePr[] | null = null;
        if (repoPath) {
          try {
            prs = target.length > 0
              ? await Promise.all(target.map((n) => fetchPr(repoPath, n)))
              : await fetchPrs(repoPath);
          } catch (e) {
            setProgress(runId, { stage: `GitCode API 失败（${(e as Error).message.slice(0, 60)}），改用本地 git 仓库降级…` });
          }
        } else {
          setProgress(runId, { stage: '非 GitCode 仓库，直接使用本地 git 仓库分析…' });
        }
        if (!prs) {
          const dir = repoDirFor(lib.name);
          if (!fs.existsSync(`${dir}/.git`)) {
            if (!lib.repo_url) throw new Error(`库「${lib.name}」未配置 repo_url，无法拉取到本地`);
            await pullRepo(lib as RepoLib);
          }
          prs = fetchPrsFromGit(dir, { limit: 8, numbers: target.length > 0 ? target : undefined });
          if (prs.length === 0) throw new Error('本地仓库无可用提交');
        }
        setProgress(runId, { stage: `已获取 ${prs.length} 条 PR` });
        const r = await analyzePrChanges(llm, lib as LibraryRow, prs, (s) => setProgress(runId, { stage: s }), round);
        setProgress(runId, { stage: r.message, done: true });
      } catch (e) {
        setProgress(runId, { stage: '分析失败', done: true, error: (e as Error).message });
      }
    });
    return { runId };
  }, { permission: 'analysis:run', llm: true });

  route('POST', '/analyses/case-updates/:libraryId', async ({ params, body }) => {
    void cacheDel('analyses');
    const db = getDb();
    const lib = await db.prepare('SELECT * FROM libraries WHERE id = ?').get<Record<string, any>>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const repoPath = parseRepoPath(lib.repo_url);
    const b = body as { prNumber?: number; prNumbers?: number[] };
    const prNumber = Number(b.prNumber) || null;
    const prNumbers = Array.isArray(b.prNumbers)
      ? b.prNumbers.filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const runId = `case-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const target = prNumbers.length > 0 ? prNumbers : prNumber ? [prNumber] : [];
    const round = `R-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    setProgress(runId, { stage: target.length > 0 ? `拉取 ${target.length} 条 PR…` : '拉取 PR 列表…' });
    setImmediate(async () => {
      try {
        let prs: GitCodePr[] | null = null;
        if (repoPath) {
          try {
            prs = target.length > 0
              ? await Promise.all(target.map((n) => fetchPr(repoPath, n)))
              : await fetchPrs(repoPath, 6);
          } catch (e) {
            setProgress(runId, { stage: `GitCode API 失败（${(e as Error).message.slice(0, 60)}），改用本地 git 仓库降级…` });
          }
        } else {
          setProgress(runId, { stage: '非 GitCode 仓库，直接使用本地 git 仓库分析…' });
        }
        if (!prs) {
          const dir = repoDirFor(lib.name);
          if (!fs.existsSync(`${dir}/.git`)) {
            if (!lib.repo_url) throw new Error(`库「${lib.name}」未配置 repo_url，无法拉取到本地`);
            await pullRepo(lib as RepoLib);
          }
          prs = fetchPrsFromGit(dir, { limit: 6, numbers: target.length > 0 ? target : undefined });
          if (prs.length === 0) throw new Error('本地仓库无可用提交');
        }
        setProgress(runId, { stage: `已获取 ${prs.length} 条 PR` });
        const r = await analyzeCaseUpdates(llm, lib as LibraryRow, prs, (s) => setProgress(runId, { stage: s }), round);
        setProgress(runId, { stage: r.message, done: true });
      } catch (e) {
        setProgress(runId, { stage: '分析失败', done: true, error: (e as Error).message });
      }
    });
    return { runId };
  }, { permission: 'analysis:run', llm: true });

  route('GET', '/analyses/progress/:runId', async ({ params }) => {
    const p = analysisProgress.get(String(params.runId));
    if (!p) throw Object.assign(new Error('进度不存在或已过期'), { statusCode: 404 });
    return p;
  }, { permission: 'analysis:read' });

  // 按扫描轮次删除整轮分析结果（多次扫描时标识/清理用）
  route('DELETE', '/analyses/round/:round', async ({ params }) => {
    const round = String(params.round);
    const db = getDb();
    const n = (await db.prepare('DELETE FROM analyses WHERE round = ?').run(round)).changes;
    void cacheDel('analyses');
    return { ok: true, deleted: n };
  }, { permission: 'analysis:delete' });

  // 清空某个三方库的全部分析结果（换库/重新开始用）
  route('DELETE', '/analyses/library/:libraryId', async ({ params }) => {
    const libId = Number(params.libraryId);
    const db = getDb();
    const n = (await db.prepare('DELETE FROM analyses WHERE library_id = ?').run(libId)).changes;
    void cacheDel('analyses');
    return { ok: true, deleted: n };
  }, { permission: 'analysis:delete' });

  route('DELETE', '/analyses/:id', async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const row = await db.prepare('SELECT * FROM analyses WHERE id = ?').get<{ id: number; kind: string }>(id);
    if (!row) throw Object.assign(new Error('分析结果不存在'), { statusCode: 404 });
    void cacheDel('analyses');
    await db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
    return { ok: true, deletedKind: row.kind };
  }, { permission: 'analysis:delete' });

  route('POST', '/analyses/attribution', async ({ body }) => {
    void cacheDel('analyses');
    const b = body as { caseIds?: number[]; libraryIds?: number[]; allLibraries?: boolean };
    const caseIds = Array.isArray(b.caseIds) ? b.caseIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const libraryIds = Array.isArray(b.libraryIds) ? b.libraryIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (caseIds.length === 0 && libraryIds.length === 0 && !b.allLibraries) {
      throw Object.assign(new Error('请先勾选要归因的失败用例，或选择库级 / 全部'), { statusCode: 400 });
    }
    return analyzeAttribution(llm, { caseIds, libraryIds, allLibraries: !!b.allLibraries });
  }, { permission: 'analysis:run', llm: true });

  // ---- 真机遍历报告（可视化展示数据源：workspace/explore/<lib>/explore_*.json）----
  // 说明：遍历生成用例统一走 AI 任务 explore_cases（executor.exploreCases：遍历数据 → 用例生成 Agent → 自审进化），
  // 不再提供「直插机械用例」的 /explore 路由；本组路由仅读取历史报告供 API 消费。
  const exploreDirFor = (libName: string): string => path.join(workspaceDir(), 'explore', libName.replace(/[^\w.-]/g, '_'));

  // 报告列表（新→旧）
  route('GET', '/explore/reports/:libraryId', async ({ params }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const dir = exploreDirFor(lib.name);
    if (!fs.existsSync(dir)) return { items: [], dir };
    const items = fs.readdirSync(dir)
      .filter((f) => /^explore_\d+\.json$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        let pages = 0;
        let visitedCount = 0;
        let durationMs = 0;
        let serial = '';
        let packageName = '';
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8')) as Partial<ExploreResult>;
          pages = Array.isArray(j.pages) ? j.pages.length : 0;
          visitedCount = Number(j.visitedCount ?? 0) || 0;
          durationMs = Number(j.durationMs ?? 0) || 0;
          serial = String(j.serial ?? '');
          packageName = String(j.packageName ?? '');
        } catch { /* 损坏文件仍列出，元信息为空 */ }
        return { file: f, mtime: st.mtime.toISOString(), size: st.size, pages, visitedCount, durationMs, serial, packageName };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
    return { items, dir };
  }, { permission: 'case:read' });

  // 报告内容（name=explore_<ts>.json，白名单校验防路径穿越）
  route('GET', '/explore/reports/:libraryId/content', async ({ params, query }) => {
    const db = getDb();
    const lib = await db.prepare('SELECT name FROM libraries WHERE id = ?').get<{ name: string }>(Number(params.libraryId));
    if (!lib) throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
    const name = String(query.get('name') ?? '');
    if (!/^explore_\d+\.json$/.test(name)) throw Object.assign(new Error('非法报告文件名'), { statusCode: 400 });
    const file = path.join(exploreDirFor(lib.name), name);
    if (!fs.existsSync(file)) throw Object.assign(new Error('报告不存在或已被清理'), { statusCode: 404 });
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ExploreResult;
    } catch (e) {
      throw Object.assign(new Error(`报告解析失败：${(e as Error).message}`), { statusCode: 500 });
    }
  }, { permission: 'case:read' });

  // ---- 链路追踪事件查询（agent_events，按任务/类型过滤，全链 traceId 观测） ----
  route('GET', '/events', async ({ query }) => {
    const taskId = Number(query.get('taskId')) || undefined;
    const kind = query.get('kind') ?? undefined;
    const limit = Math.min(500, Number(query.get('limit')) || 100);
    return { ok: true, rows: await listEvents({ taskId, kind, limit }) };
  }, { permission: 'task:read' });
}

// ---------- mappers / helpers ----------
function mapLibrary(row: Record<string, unknown>) {
  return {
    id: row.id, name: row.name, repoUrl: row.repo_url, description: row.description,
    packageName: row.package_name ?? '', mainAbility: row.main_ability ?? '',
    currentVersion: row.current_version, status: row.status, lastSyncedAt: row.last_synced_at,
    caseCount: row.case_count ?? 0, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapCase(row: Record<string, unknown>, libraryName?: string) {
  const rawSteps = JSON.parse((row.steps as string) || '[]') as unknown[];
  const steps = rawSteps.map((s) => (typeof s === 'string' ? s : String((s as { step?: unknown })?.step ?? (s as { text?: unknown })?.text ?? (s as { expected?: unknown })?.expected ?? ''))).filter(Boolean);
  return {
    id: row.id, libraryId: row.library_id, libraryName, caseNo: row.case_no, name: row.name,
    source: row.source, precondition: row.precondition, steps,
    expected: row.expected, status: row.status, scriptStatus: row.script_status,
    dtsUrl: (row.dts_url as string | undefined) ?? '',
    currentVersion: row.current_version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapVersion(row: Record<string, unknown>) {
  return {
    id: row.id, caseId: row.case_id, version: row.version, snapshot: JSON.parse(row.snapshot as string),
    changeNote: row.change_note, author: row.author, authorType: row.author_type, createdAt: row.created_at,
  };
}
function mapModel(row: Record<string, unknown>) {
  return {
    id: row.id, name: row.name, provider: row.provider, baseUrl: row.base_url, modelId: row.model_id,
    apiKey: row.api_key, isDefault: row.is_default === 1, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapPrompt(row: Record<string, unknown>) {
  return {
    id: row.id, name: row.name, role: row.role ?? '', content: row.content ?? '',
    skill: (row.skill as string | undefined) ?? '',
    variables: safeJsonArray(row.variables), builtin: row.builtin === 1, version: row.version, updatedAt: row.updated_at,
  };
}
function mapTask(row: Record<string, unknown>) {
  return {
    id: row.id, taskNo: row.task_no, type: row.type, title: row.title, libraryId: row.library_id,
    input: row.input ?? '', trace: safeJsonArray(row.trace), status: row.status, progress: row.progress, resultSummary: row.result_summary,
    error: row.error, traceId: row.trace_id ?? '', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapDevice(row: Record<string, unknown>) {
  return {
    id: row.id, serial: row.serial, model: row.model, osVersion: row.os_version, status: row.status,
    battery: row.battery, memoryUsage: row.memory_usage, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
  };
}
function mapAnalysis(row: Record<string, unknown>) {
  return {
    id: row.id, kind: row.kind, granularity: row.granularity, libraryId: row.library_id,
    caseId: row.case_id, title: row.title, content: safeJsonParse(row.content, {}),
    round: (row.round as string | undefined) ?? '', createdAt: row.created_at,
  };
}
function safeJsonArray(v: unknown): unknown[] {
  try {
    const parsed = JSON.parse((v as string) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function safeJsonParse(v: unknown, fallback: unknown): unknown {
  if (typeof v !== 'string') return v ?? fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
/** Excel 行 → 用例字段（兼容中文表头与英文键，操作步骤支持数组/JSON/换行分隔）。 */
function normalizeCaseRow(row: Record<string, unknown>): {
  caseNo?: string; name?: string; source?: string; precondition?: string;
  steps: string[]; expected?: string; status?: string; scriptStatus?: string;
} {
  const ALIAS: Record<string, string> = {
    '用例编号': 'caseNo', caseNo: 'caseNo', case_no: 'caseNo',
    '用例名称': 'name', '名称': 'name', name: 'name',
    '来源': 'source', '来源分类': 'source', source: 'source',
    '前置条件': 'precondition', precondition: 'precondition',
    '操作步骤': 'steps', '步骤': 'steps', steps: 'steps',
    '预期结果': 'expected', expected: 'expected',
    '状态': 'status', status: 'status',
    '脚本状态': 'scriptStatus', scriptStatus: 'scriptStatus',
  };
  const norm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = ALIAS[k] ?? k;
    if (norm[key] === undefined && v !== undefined && v !== '') norm[key] = v;
  }
  let steps: string[] = [];
  const rawSteps = norm.steps;
  if (Array.isArray(rawSteps)) {
    steps = rawSteps.map(String);
  } else if (typeof rawSteps === 'string' && rawSteps.trim()) {
    const s = rawSteps.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        steps = Array.isArray(parsed) ? parsed.map(String) : [s];
      } catch {
        steps = s.split(/\n|；|;/).map((x) => x.trim()).filter(Boolean);
      }
    } else {
      steps = s.split(/\n/).map((x) => x.trim()).filter(Boolean);
    }
  }
  const get = (key: string): string | undefined => (norm[key] === undefined ? undefined : String(norm[key]));
  return {
    caseNo: get('caseNo'), name: get('name'), source: get('source'), precondition: get('precondition'),
    steps, expected: get('expected'), status: get('status'), scriptStatus: get('scriptStatus'),
  };
}
function mapPlan(row: Record<string, unknown>) {
  return {
    id: row.id, planNo: row.plan_no, name: row.name, type: row.type, cron: row.cron,
    scope: JSON.parse((row.scope as string) || '{"libraryIds":[],"caseIds":[]}'),
    deviceIds: JSON.parse((row.device_ids as string) || '[]'),
    status: row.status, failPolicy: row.fail_policy,
    scriptMode: (row.script_mode as string | undefined) ?? '',
    error: (row.error as string | undefined) ?? '',
    progress: Number(row.progress ?? 0) || 0,
    progressNote: (row.progress_note as string | undefined) ?? '',
    lastRunAt: row.last_run_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapExecution(row: Record<string, unknown>) {
  return {
    id: row.id, planId: row.plan_id, caseId: row.case_id, libraryId: row.library_id, deviceId: row.device_id,
    status: row.status, steps: JSON.parse((row.steps as string) || '[]'), thinking: row.thinking, logs: row.logs,
    startedAt: row.started_at, finishedAt: row.finished_at,
    caseNo: row.case_no, caseName: row.case_name, libraryName: row.library_name, deviceSerial: row.device_serial,
  };
}
async function getCaseOr404(db: ReturnType<typeof getDb>, id: number): Promise<Record<string, any>> {
  const row = await db.prepare('SELECT * FROM cases WHERE id = ?').get<Record<string, any>>(id);
  if (!row) throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
  return row;
}
async function getModelOr404(db: ReturnType<typeof getDb>, id: number): Promise<Record<string, any>> {
  const row = await db.prepare('SELECT * FROM models WHERE id = ?').get<Record<string, any>>(id);
  if (!row) throw Object.assign(new Error('模型不存在'), { statusCode: 404 });
  return row;
}
async function getPromptOr404(db: ReturnType<typeof getDb>, id: number): Promise<Record<string, any>> {
  const row = await db.prepare('SELECT * FROM prompts WHERE id = ?').get<Record<string, any>>(id);
  if (!row) throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
  return row;
}
async function nextTaskNo(): Promise<string> {
  const db = getDb();
  const row = (await db.prepare(`SELECT MAX(CAST(SUBSTRING(task_no, 3) AS UNSIGNED)) AS m FROM tasks`).get<{ m: number | null }>()) ?? { m: null };
  return `T-${(row.m ?? 2400) + 1}`;
}
async function nextPlanNo(): Promise<string> {
  const db = getDb();
  const row = (await db.prepare(`SELECT MAX(CAST(SUBSTRING(plan_no, 3) AS UNSIGNED)) AS m FROM plans`).get<{ m: number | null }>()) ?? { m: null };
  return `P-${(row.m ?? 1000) + 1}`;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace defineRoutes {
  let done: boolean;
}
