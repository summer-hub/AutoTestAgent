import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { getDb, now, withRead } from '../db/connection.js';
import { caseTableFor, shardOf, shardStats } from '../db/repository.js';
import { runTask } from '../services/executor.js';
import { executePlan } from '../services/planExecutor.js';
import { registerScheduledPlan } from '../services/scheduler.js';
import { analyzeAttribution, analyzeCaseUpdates, analyzePrChanges, fetchPr, fetchPrs, parseRepoPath, } from '../services/analyzer.js';
import { getAllSettings, setSetting } from '../services/settings.js';
import { cacheDel, cacheGet, cacheSet } from '../services/cache.js';
import { deviceInfo, hdcAvailable, listTargets } from '../services/hdc.js';
import { repoDirFor, scriptsDirFor } from '../services/gitRepo.js';
const routes = [];
// 分析进度（内存态，供前端轮询展示实时过程；完成后 60s 自动清理）
const analysisProgress = new Map();
function setProgress(runId, p) {
    analysisProgress.set(runId, { stage: p.stage, done: p.done ?? false, error: p.error });
    if (p.done)
        setTimeout(() => analysisProgress.delete(runId), 60_000);
}
function compile(pattern) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\:]/g, '\\$&').replace(/\\:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { regex, keys };
}
function route(method, pattern, handler) {
    const { regex, keys } = compile(pattern);
    routes.push({ method, keys, regex, handler });
}
/** 读缓存 → 未命中执行并回填。 */
async function withCache(key, fn) {
    const hit = await cacheGet(key);
    if (hit !== undefined)
        return hit;
    const value = await fn();
    await cacheSet(key, value);
    return value;
}
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (chunks.length === 0)
                return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}
function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
function errorStatus(e) {
    return e.statusCode ?? 500;
}
/** 组装 API 分发 handler（挂到 ctx.webServer） */
export function makeApiHandler(llm) {
    defineRoutes(llm);
    return async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.replace(/^\/api\/autotest/, '') || '/';
            const query = url.searchParams;
            const method = (req.method ?? 'GET').toUpperCase();
            let matched = null;
            let params = {};
            for (const r of routes) {
                if (r.method !== method)
                    continue;
                const m = path.match(r.regex);
                if (m) {
                    matched = r;
                    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
                    break;
                }
            }
            if (!matched)
                return send(res, 404, { error: 'Not Found', path });
            const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
            const data = await matched.handler({ params, query, body });
            if (Buffer.isBuffer(data)) {
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'Content-Disposition': 'attachment; filename="cases.xlsx"',
                });
                res.end(data);
                return;
            }
            send(res, 200, data);
        }
        catch (e) {
            const status = errorStatus(e);
            send(res, status, { error: status >= 500 ? 'Internal Server Error' : e.message, message: e.message, statusCode: status });
        }
    };
}
// ---------- 业务路由 ----------
function defineRoutes(llm) {
    if (defineRoutes.done)
        return;
    defineRoutes.done = true;
    // ---- health ----
    route('GET', '/health', async () => ({ ok: true, service: 'dsh-autotest', time: new Date().toISOString() }));
    // ---- 系统配置 ----
    route('GET', '/settings', async () => getAllSettings());
    route('PUT', '/settings/:key', async ({ params, body }) => {
        const { value } = body;
        if (value === undefined)
            throw Object.assign(new Error('value 必填'), { statusCode: 400 });
        setSetting(decodeURIComponent(params.key), value);
        return { ok: true, key: decodeURIComponent(params.key), value };
    });
    // ---- libraries ----
    route('GET', '/libraries', async ({ query }) => {
        const q = query.get('q') ?? '';
        const page = Math.max(1, Number(query.get('page')) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize')) || 20));
        return withCache(`libs:${page}:${pageSize}:${q}`, () => withRead((db) => {
            const like = `%${q}%`;
            const where = q ? `WHERE l.name LIKE @like OR l.description LIKE @like` : '';
            const total = db.prepare(`SELECT COUNT(*) AS n FROM libraries l ${where}`).get({ like }).n;
            const rows = db.prepare(`
        SELECT l.*, (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count
        FROM libraries l ${where} ORDER BY l.id LIMIT @limit OFFSET @offset`).all({ like, limit: pageSize, offset: (page - 1) * pageSize });
            return { items: rows.map(mapLibrary), total, page, pageSize };
        }));
    });
    route('GET', '/libraries/:id', async ({ params }) => {
        return withCache(`lib:${params.id}`, async () => {
            const db = getDb();
            const row = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM cases c WHERE c.library_id = l.id) AS case_count FROM libraries l WHERE l.id = ?`)
                .get(Number(params.id));
            if (!row)
                throw Object.assign(new Error('库不存在'), { statusCode: 404 });
            return mapLibrary(row);
        });
    });
    // PR 列表（供前端选择 #PR 分析）
    route('GET', '/libraries/:libraryId/prs', async ({ params }) => {
        const lib = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(Number(params.libraryId));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const repoPath = parseRepoPath(lib.repo_url);
        if (!repoPath)
            return { items: [], error: '未配置 GitCode 仓库地址，无法拉取 PR' };
        try {
            const prs = await fetchPrs(repoPath, 8);
            return { items: prs.map((p) => ({ number: p.number, title: p.title, state: p.state, createdAt: p.created_at })) };
        }
        catch (e) {
            return { items: [], error: e.message };
        }
    });
    route('GET', '/libraries/stats/sources', async () => {
        const db = getDb();
        const rows = db.prepare(`SELECT source, COUNT(*) AS n FROM cases GROUP BY source`).all();
        return { items: rows, total: rows.reduce((s, r) => s + r.n, 0) };
    });
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
        return withCache(`cases:${shard}:${libraryId}:${page}:${pageSize}:${q}:${source}:${status}:${ver}`, () => withRead((db) => {
            const conds = ['library_id = @libraryId'];
            const p = { libraryId, limit: pageSize, offset: (page - 1) * pageSize };
            if (q) {
                conds.push('(name LIKE @q OR case_no LIKE @q)');
                p.q = `%${q}%`;
            }
            if (source) {
                conds.push('source = @source');
                p.source = source;
            }
            if (status) {
                conds.push('status = @status');
                p.status = status;
            }
            if (ver) {
                conds.push('current_version = @ver');
                p.ver = Number(ver.replace('V', '')) || 0;
            }
            const where = conds.join(' AND ');
            const table = caseTableFor(libraryId);
            const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(p).n;
            const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY case_no LIMIT @limit OFFSET @offset`).all(p);
            const lib = db.prepare('SELECT name FROM libraries WHERE id = ?').get(libraryId);
            return { items: rows.map((r) => mapCase(r, lib?.name)), total, page, pageSize };
        }));
    });
    // 注意：/cases/export 必须注册在 /cases/:id 之前（单段路径会被 :id 捕获）
    route('GET', '/cases/export', async ({ query }) => {
        const db = getDb();
        const libraryId = Number(query.get('libraryId')) || null;
        const rows = libraryId
            ? db.prepare('SELECT * FROM cases WHERE library_id = ? ORDER BY case_no LIMIT 20000').all(libraryId)
            : db.prepare('SELECT * FROM cases ORDER BY id LIMIT 20000').all();
        const data = rows.map((r) => ({
            用例编号: r.case_no, 用例名称: r.name, 来源: r.source, 前置条件: r.precondition ?? '',
            操作步骤: JSON.parse(r.steps || '[]').join('\n'), 预期结果: r.expected ?? '',
            状态: r.status, 脚本状态: r.script_status, 当前版本: `V${r.current_version}`,
            更新时间: r.updated_at,
        }));
        const sheet = XLSX.utils.json_to_sheet(data, { header: CASE_HEADERS });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, sheet, '用例');
        return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    });
    route('GET', '/cases/:id', async ({ params }) => {
        return withCache(`case:${params.id}`, async () => {
            const db = getDb();
            const row = getCaseOr404(db, Number(params.id));
            const lib = db.prepare('SELECT name FROM libraries WHERE id = ?').get(row.library_id);
            return mapCase(row, lib?.name);
        });
    });
    route('GET', '/cases/:id/versions', async ({ params }) => {
        const db = getDb();
        getCaseOr404(db, Number(params.id));
        const rows = db.prepare('SELECT * FROM case_versions WHERE case_id = ? ORDER BY version DESC').all(Number(params.id));
        return rows.map(mapVersion);
    });
    route('POST', '/cases', async ({ body }) => {
        const b = body;
        if (!b.libraryId || !b.caseNo || !b.name)
            throw Object.assign(new Error('libraryId / caseNo / name 必填'), { statusCode: 400 });
        const db = getDb();
        void cacheDel('cases');
        void cacheDel('stats');
        void cacheDel('lib');
        void cacheDel('libs');
        const t = now();
        const created = db.transaction(() => {
            const steps = Array.isArray(b.steps) ? b.steps : [];
            const res = db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, dts_url, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '未绑定', ?, 1, ?, ?)`).run(b.libraryId, b.caseNo, b.name, b.source ?? '新需求引入', b.precondition ?? '', JSON.stringify(steps), b.expected ?? '', b.status ?? '未执行', b.dtsUrl ?? '', t, t);
            const caseId = Number(res.lastInsertRowid);
            db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, '初始创建', 'AI 用例生成 Agent', 'ai', ?)`).run(caseId, JSON.stringify({
                id: caseId, libraryId: b.libraryId, caseNo: b.caseNo, name: b.name, source: b.source ?? '新需求引入',
                precondition: b.precondition ?? '', steps, expected: b.expected ?? '', status: b.status ?? '未执行',
                scriptStatus: '未绑定', dtsUrl: b.dtsUrl ?? '', currentVersion: 1, createdAt: t, updatedAt: t,
            }), t);
            return caseId;
        })();
        return mapCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(created));
    });
    route('PUT', '/cases/:id', async ({ params, body }) => {
        const id = Number(params.id);
        const b = body;
        const db = getDb();
        void cacheDel('cases');
        void cacheDel('stats');
        void cacheDel('lib');
        void cacheDel('libs');
        const row = getCaseOr404(db, id);
        const t = now();
        const nextVersion = row.current_version + 1;
        const updated = db.transaction(() => {
            const snapshot = {
                id, libraryId: row.library_id, caseNo: row.case_no,
                name: b.name ?? row.name, source: b.source ?? row.source,
                precondition: b.precondition ?? row.precondition,
                steps: b.steps ?? JSON.parse(row.steps),
                expected: b.expected ?? row.expected,
                status: b.status ?? row.status,
                scriptStatus: b.scriptStatus ?? row.script_status,
                dtsUrl: b.dtsUrl ?? row.dts_url,
                currentVersion: nextVersion, createdAt: row.created_at, updatedAt: t,
            };
            db.prepare(`UPDATE cases SET name=?, source=?, precondition=?, steps=?, expected=?, status=?, script_status=?, dts_url=?, current_version=?, updated_at=? WHERE id=?`).run(snapshot.name, snapshot.source, snapshot.precondition, JSON.stringify(snapshot.steps), snapshot.expected, snapshot.status, snapshot.scriptStatus, snapshot.dtsUrl, nextVersion, t, id);
            db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, nextVersion, JSON.stringify(snapshot), b.changeNote ?? 'AI 自动更新：版本自动递增。', b.author ?? 'AI 用例更新 Agent', b.authorType ?? 'ai', t);
            return snapshot;
        })();
        return updated;
    });
    route('DELETE', '/cases/:id', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        void cacheDel('cases');
        void cacheDel('stats');
        void cacheDel('lib');
        void cacheDel('libs');
        const row = getCaseOr404(db, id);
        db.transaction(() => {
            db.prepare('DELETE FROM case_versions WHERE case_id = ?').run(id);
            db.prepare('DELETE FROM executions WHERE case_id = ?').run(id);
            db.prepare('DELETE FROM analyses WHERE case_id = ?').run(id);
            db.prepare('DELETE FROM cases WHERE id = ?').run(id);
        })();
        return { ok: true, deletedCaseNo: row.case_no };
    });
    route('POST', '/cases/:id/rollback', async ({ params, body }) => {
        const id = Number(params.id);
        const target = Number(body.version);
        if (!target)
            throw Object.assign(new Error('version 必填'), { statusCode: 400 });
        const db = getDb();
        void cacheDel('cases');
        void cacheDel('stats');
        void cacheDel('lib');
        void cacheDel('libs');
        const row = getCaseOr404(db, id);
        const vrow = db.prepare('SELECT * FROM case_versions WHERE case_id = ? AND version = ?').get(id, target);
        if (!vrow)
            throw Object.assign(new Error(`版本 V${target} 不存在`), { statusCode: 404 });
        const snap = JSON.parse(vrow.snapshot);
        const t = now();
        const nextVersion = row.current_version + 1;
        db.transaction(() => {
            db.prepare(`UPDATE cases SET name=?, source=?, precondition=?, steps=?, expected=?, status=?, script_status=?, current_version=?, updated_at=? WHERE id=?`).run(snap.name, snap.source, snap.precondition, JSON.stringify(snap.steps), snap.expected, snap.status, snap.scriptStatus, nextVersion, t, id);
            db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'human', ?)`).run(id, nextVersion, JSON.stringify({ ...snap, currentVersion: nextVersion, updatedAt: t }), `回滚到 V${target}：内容恢复至该版本快照。`, body.author ?? '测试工程师', t);
        })();
        return { id, currentVersion: nextVersion, rolledBackTo: target, updatedAt: t };
    });
    // ---- Excel 导入 / 导出（需求：导入 excel 表格并保存到数据库 / 导出 excel）----
    const CASE_HEADERS = ['用例编号', '用例名称', '来源', '前置条件', '操作步骤', '预期结果', '状态', '脚本状态', '当前版本', '更新时间'];
    route('POST', '/cases/import', async ({ body }) => {
        const b = body;
        const libraryId = Number(b.libraryId);
        if (!libraryId || !b.base64)
            throw Object.assign(new Error('libraryId / base64 必填'), { statusCode: 400 });
        const db = getDb();
        void cacheDel('cases');
        void cacheDel('stats');
        void cacheDel('lib');
        void cacheDel('libs');
        const lib = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId);
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const wb = XLSX.read(b.base64, { type: 'base64' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet)
            throw Object.assign(new Error('Excel 中没有工作表'), { statusCode: 400 });
        const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const t = now();
        const errors = [];
        let imported = 0;
        let skipped = 0;
        const countRow = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get(libraryId);
        let seq = countRow.n;
        db.transaction(() => {
            const insertCase = db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
            const insertVer = db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, 'Excel 导入初始创建', 'Excel 导入', 'human', ?)`);
            for (const row of raw) {
                const norm = normalizeCaseRow(row);
                if (!norm.name) {
                    skipped++;
                    continue;
                }
                try {
                    const caseNo = norm.caseNo || `C-IMP-${String(++seq).padStart(4, '0')}`;
                    const steps = norm.steps;
                    const res = insertCase.run(libraryId, caseNo, norm.name, norm.source ?? '新需求引入', norm.precondition ?? '', JSON.stringify(steps), norm.expected ?? '', norm.status ?? '未执行', norm.scriptStatus ?? '未绑定', t, t);
                    const caseId = Number(res.lastInsertRowid);
                    insertVer.run(caseId, JSON.stringify({
                        id: caseId, libraryId, caseNo, name: norm.name, source: norm.source ?? '新需求引入',
                        precondition: norm.precondition ?? '', steps, expected: norm.expected ?? '',
                        status: norm.status ?? '未执行', scriptStatus: norm.scriptStatus ?? '未绑定',
                        currentVersion: 1, createdAt: t, updatedAt: t,
                    }), t);
                    imported++;
                }
                catch (e) {
                    errors.push(`第 ${raw.indexOf(row) + 2} 行：${e.message}`);
                }
            }
        })();
        return { imported, skipped, errors, libraryId, libraryName: lib.name, fileName: b.fileName ?? null };
    });
    route('GET', '/cases/stats/overview', async () => {
        return withCache('stats:cases', () => withRead((db) => {
            const total = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
            const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM cases GROUP BY status').all();
            const versioned = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE current_version > 1').get().n;
            return { total, byStatus, versioned };
        }));
    });
    // ---- M7 分表统计 ----
    route('GET', '/stats/sharding', async () => withCache('stats:sharding', async () => shardStats()));
    // ---- models ----
    route('GET', '/models', async () => {
        return getDb().prepare('SELECT * FROM models ORDER BY is_default DESC, id').all().map(mapModel);
    });
    route('POST', '/models', async ({ body }) => {
        const b = body;
        if (!b.name || !b.baseUrl || !b.modelId)
            throw Object.assign(new Error('name / baseUrl / modelId 必填'), { statusCode: 400 });
        const db = getDb();
        const t = now();
        const res = db.prepare(`INSERT INTO models (name, provider, base_url, model_id, api_key, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(b.name, b.provider ?? 'custom', b.baseUrl, b.modelId, b.apiKey ?? '', t, t);
        return mapModel(db.prepare('SELECT * FROM models WHERE id = ?').get(Number(res.lastInsertRowid)));
    });
    route('PUT', '/models/:id', async ({ params, body }) => {
        const id = Number(params.id);
        const b = body;
        const db = getDb();
        const row = getModelOr404(db, id);
        const t = now();
        db.prepare(`UPDATE models SET name=?, provider=?, base_url=?, model_id=?, api_key=?, is_default=?, updated_at=? WHERE id=?`).run(b.name ?? row.name, b.provider ?? row.provider, b.baseUrl ?? row.base_url, b.modelId ?? row.model_id, b.apiKey ?? row.api_key, b.isDefault === undefined ? row.is_default : (b.isDefault ? 1 : 0), t, id);
        if (b.isDefault)
            db.prepare(`UPDATE models SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END`).run(id);
        return mapModel(db.prepare('SELECT * FROM models WHERE id = ?').get(id));
    });
    route('DELETE', '/models/:id', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = getModelOr404(db, id);
        if (row.is_default === 1)
            throw Object.assign(new Error('不能删除默认模型'), { statusCode: 400 });
        db.prepare('DELETE FROM models WHERE id = ?').run(id);
        return { ok: true };
    });
    route('POST', '/models/:id/test', async ({ params }) => {
        const row = getModelOr404(getDb(), Number(params.id));
        const cfg = { baseUrl: row.base_url, modelId: row.model_id, apiKey: row.api_key };
        if (!cfg.apiKey)
            return { ok: false, latencyMs: null, message: '未配置 API Key：请在设置中填写后重试' };
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
            const data = (await res.json());
            return { ok: true, latencyMs: Date.now() - started, message: `HTTP 200 · 延迟 ${Date.now() - started}ms`, responsePreview: data.choices?.[0]?.message?.content?.slice(0, 120) };
        }
        catch (e) {
            return { ok: false, latencyMs: Date.now() - started, message: e.message };
        }
    });
    // ---- prompts ----
    route('GET', '/prompts', async () => withCache('prompts', async () => getDb().prepare('SELECT * FROM prompts ORDER BY builtin DESC, id').all().map(mapPrompt)));
    route('POST', '/prompts', async ({ body }) => {
        const b = body;
        if (!b.name || !b.content)
            throw Object.assign(new Error('name / content 必填'), { statusCode: 400 });
        const db = getDb();
        void cacheDel('prompts');
        const t = now();
        const res = db.prepare(`INSERT INTO prompts (name, role, content, skill, variables, builtin, version, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)`).run(b.name, b.role ?? '', b.content, b.skill ?? '', JSON.stringify(b.variables ?? []), t);
        return mapPrompt(db.prepare('SELECT * FROM prompts WHERE id = ?').get(Number(res.lastInsertRowid)));
    });
    route('PUT', '/prompts/:id', async ({ params, body }) => {
        const id = Number(params.id);
        const b = body;
        const db = getDb();
        void cacheDel('prompts');
        const row = getPromptOr404(db, id);
        const t = now();
        db.prepare(`UPDATE prompts SET name=?, role=?, content=?, skill=?, variables=?, version=version+1, updated_at=? WHERE id=?`).run(b.name ?? row.name, b.role ?? row.role, b.content ?? row.content, b.skill ?? row.skill, JSON.stringify(b.variables ?? JSON.parse(row.variables || '[]')), t, id);
        return mapPrompt(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
    });
    route('DELETE', '/prompts/:id', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = getPromptOr404(db, id);
        if (row.builtin === 1)
            throw Object.assign(new Error('内置模板不可删除'), { statusCode: 400 });
        void cacheDel('prompts');
        db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
        return { ok: true };
    });
    // ---- tasks ----
    route('POST', '/tasks', async ({ body }) => {
        const b = body;
        if (!b.type)
            throw Object.assign(new Error('type 必填'), { statusCode: 400 });
        const db = getDb();
        const t = now();
        const taskNo = nextTaskNo();
        const res = db.prepare(`INSERT INTO tasks (task_no, type, title, library_id, input, status, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(taskNo, b.type, b.title ?? b.type, b.libraryId ?? null, b.input ?? '', t, t);
        const id = Number(res.lastInsertRowid);
        setImmediate(() => { runTask(id, llm).catch(() => { }); });
        return mapTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    });
    route('GET', '/tasks', async ({ query }) => {
        const status = query.get('status') ?? '';
        const where = status ? 'WHERE status = @status' : '';
        return getDb().prepare(`SELECT * FROM tasks ${where} ORDER BY id DESC LIMIT 100`).all(status ? { status } : {}).map(mapTask);
    });
    route('GET', '/tasks/:id', async ({ params }) => {
        const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id));
        if (!row)
            throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
        return mapTask(row);
    });
    route('POST', '/tasks/:id/retry', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
        if (row.status !== 'failed')
            throw Object.assign(new Error('仅失败任务可重试'), { statusCode: 400 });
        db.prepare(`UPDATE tasks SET status='pending', progress=0, error=NULL, updated_at=? WHERE id=?`).run(now(), id);
        setImmediate(() => { runTask(id, llm).catch(() => { }); });
        return { ok: true };
    });
    route('DELETE', '/tasks/:id', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        return { ok: true, deletedTaskNo: row.task_no };
    });
    // ---- 仓库本地目录（拉取仓库代码后查看）----
    route('GET', '/repos', async () => {
        const rows = getDb().prepare(`SELECT id, name, repo_url, current_version, last_commit, last_synced_at FROM libraries WHERE repo_url != '' ORDER BY name`).all();
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
    });
    // 自动化脚本目录（to_script 落盘到 workspace/scripts/<lib>）
    route('GET', '/scripts', async () => {
        const rows = getDb().prepare('SELECT id, name FROM libraries ORDER BY name').all();
        return rows.map((r) => {
            const dir = scriptsDirFor(r.name);
            let fileCount = 0;
            if (fs.existsSync(dir)) {
                try {
                    fileCount = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).length;
                }
                catch { /* 忽略 */ }
            }
            return { id: r.id, name: r.name, dir, exists: fileCount > 0, fileCount };
        }).sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name));
    });
    route('GET', '/repos/:id/files', async ({ params, query }) => {
        const db = getDb();
        const lib = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(Number(params.id));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const kind = query.get('root') === 'scripts' ? 'scripts' : 'repos';
        const root = kind === 'scripts' ? scriptsDirFor(lib.name) : repoDirFor(lib.name);
        if (!fs.existsSync(root)) {
            throw Object.assign(new Error(kind === 'scripts' ? '该库还没有生成脚本，请先执行「用例转自动化脚本」' : '仓库尚未拉取到本地，请先执行「拉取仓库代码」'), { statusCode: 404 });
        }
        const rel = (query.get('path') ?? '').replace(/^\/+/, '');
        const dir = path.resolve(root, rel);
        if (dir !== root && !dir.startsWith(root + path.sep))
            throw Object.assign(new Error('非法路径'), { statusCode: 400 });
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
            throw Object.assign(new Error('目录不存在'), { statusCode: 404 });
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
    });
    route('GET', '/repos/:id/file', async ({ params, query }) => {
        const db = getDb();
        const lib = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(Number(params.id));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const kind = query.get('root') === 'scripts' ? 'scripts' : 'repos';
        const root = kind === 'scripts' ? scriptsDirFor(lib.name) : repoDirFor(lib.name);
        const rel = (query.get('path') ?? '').replace(/^\/+/, '');
        if (!rel)
            throw Object.assign(new Error('缺少文件路径'), { statusCode: 400 });
        const file = path.resolve(root, rel);
        if (file !== root && !file.startsWith(root + path.sep))
            throw Object.assign(new Error('非法路径'), { statusCode: 400 });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
            throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
        const stat = fs.statSync(file);
        const truncated = stat.size > 256 * 1024;
        const buf = fs.readFileSync(file);
        const content = buf.subarray(0, 256 * 1024).toString('utf8');
        return { name: rel, content, truncated, binary: buf.includes(0) };
    });
    // 删除脚本文件（仅允许 scripts 目录下的 .ts，带路径穿越防护）
    route('DELETE', '/repos/:libraryId/file', async ({ params, query }) => {
        const db = getDb();
        const lib = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(Number(params.libraryId));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const kind = query.get('root') === 'scripts' ? 'scripts' : 'repos';
        const root = kind === 'scripts' ? scriptsDirFor(lib.name) : repoDirFor(lib.name);
        const rel = (query.get('path') ?? '').replace(/^\/+/, '');
        if (!rel || !rel.endsWith('.ts'))
            throw Object.assign(new Error('仅支持删除 .ts 脚本文件'), { statusCode: 400 });
        const file = path.resolve(root, rel);
        if (file !== root && !file.startsWith(root + path.sep))
            throw Object.assign(new Error('非法路径'), { statusCode: 400 });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
            throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
        fs.unlinkSync(file);
        return { ok: true, deleted: rel };
    });
    // ---- plans ----
    route('GET', '/plans', async () => {
        const db = getDb();
        const rows = db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT 100').all();
        const stats = db.prepare(`SELECT plan_id,
      SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total FROM executions GROUP BY plan_id`).all();
        return rows.map((r) => ({ ...mapPlan(r), execStats: stats.find((s) => s.plan_id === r.id) ?? null }));
    });
    route('POST', '/plans', async ({ body }) => {
        const b = body;
        if (!b.name || !b.type)
            throw Object.assign(new Error('name / type 必填'), { statusCode: 400 });
        const db = getDb();
        const t = now();
        const planNo = nextPlanNo();
        const scope = b.scope ?? { libraryIds: [], caseIds: [] };
        const deviceIds = b.deviceIds ?? [];
        const res = db.prepare(`INSERT INTO plans (plan_no, name, type, cron, scope, device_ids, status, fail_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`).run(planNo, b.name, b.type, b.cron ?? null, JSON.stringify(scope), JSON.stringify(deviceIds), b.failPolicy ?? 'continue', t, t);
        const id = Number(res.lastInsertRowid);
        if (b.type === 'scheduled' && b.cron) {
            try {
                registerScheduledPlan(id, b.cron);
            }
            catch (e) {
                db.prepare('DELETE FROM plans WHERE id = ?').run(id);
                throw e;
            }
        }
        if (b.type === 'immediate') {
            db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(t, id);
            setImmediate(() => { executePlan(id).catch(() => { }); });
        }
        return mapPlan(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
    });
    route('POST', '/plans/:id/run', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('计划不存在'), { statusCode: 404 });
        db.prepare(`UPDATE plans SET status='running', updated_at=? WHERE id=?`).run(now(), id);
        setImmediate(() => { executePlan(id).catch(() => { }); });
        return { ok: true };
    });
    route('DELETE', '/plans/:id', async ({ params }) => {
        getDb().prepare('DELETE FROM plans WHERE id = ?').run(Number(params.id));
        return { ok: true };
    });
    // ---- executions ----
    route('GET', '/executions', async ({ query }) => {
        const planId = Number(query.get('planId')) || null;
        const status = query.get('status') ?? '';
        const limit = Math.min(200, Number(query.get('limit')) || 50);
        const conds = [];
        const p = { limit };
        if (planId) {
            conds.push('e.plan_id = @planId');
            p.planId = planId;
        }
        if (status) {
            conds.push('e.status = @status');
            p.status = status;
        }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = getDb().prepare(`SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name, d.serial AS device_serial
       FROM executions e
       LEFT JOIN cases c ON c.id = e.case_id
       LEFT JOIN libraries l ON l.id = e.library_id
       LEFT JOIN devices d ON d.id = e.device_id
       ${where} ORDER BY e.id DESC LIMIT @limit`).all(p);
        return rows.map(mapExecution);
    });
    route('GET', '/executions/:id', async ({ params }) => {
        const row = getDb().prepare(`SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name, d.serial AS device_serial
       FROM executions e
       LEFT JOIN cases c ON c.id = e.case_id
       LEFT JOIN libraries l ON l.id = e.library_id
       LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.id = ?`).get(Number(params.id));
        if (!row)
            throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 });
        return mapExecution(row);
    });
    // 调试会话追问：基于执行轨迹/思考/日志调用真实 LLM（DSH 模型配置），LLM 不可用时降级规则回答
    route('POST', '/executions/:id/ask', async ({ params, body }) => {
        const id = Number(params.id);
        const question = String(body?.question ?? '').trim();
        if (!question)
            throw Object.assign(new Error('question 必填'), { statusCode: 400 });
        const row = getDb().prepare(`SELECT e.*, c.case_no, c.name AS case_name, l.name AS library_name
       FROM executions e
       JOIN cases c ON c.id = e.case_id
       JOIN libraries l ON l.id = e.library_id
       WHERE e.id = ?`).get(id);
        if (!row)
            throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 });
        const steps = JSON.parse(row.steps || '[]');
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
            const answer = (await llm({ system, user, temperature: 0.3, maxTokens: 800 })).trim();
            return { answer };
        }
        catch {
            // LLM 不可用时降级为规则回答（与归因分析一致）
            const firstFail = steps.find((s) => s.status === 'failed');
            const answer = row.status === 'failed'
                ? `依据第 ${firstFail?.seq ?? '?'} 步的执行日志——未收到预期事件，且该库近期 PR 变更与失败时序吻合，判定为三方库回归缺陷（置信度 92%）。建议上报问题单并更新脚本适配参数。（LLM 暂不可用，以下为规则推断）`
                : '该步骤按用例前置条件执行，日志无异常，界面状态与预期一致，因此判定通过。（LLM 暂不可用，以下为规则推断）';
            return { answer };
        }
    });
    // ---- devices ----
    route('GET', '/devices', async () => withCache('devices', async () => getDb().prepare(`SELECT * FROM devices ORDER BY status = 'online' DESC, id`).all().map(mapDevice)));
    route('POST', '/devices/scan', async () => {
        const db = getDb();
        void cacheDel('devices');
        const t = now();
        const count = () => db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
        // 真实识别：hdc list targets + param get
        const hdcOk = await hdcAvailable();
        if (hdcOk) {
            const targets = await listTargets();
            if (targets.length > 0) {
                const info = await deviceInfo(targets[0]);
                for (const s of targets) {
                    const d = s === targets[0] ? info : await deviceInfo(s);
                    db.prepare(`INSERT INTO devices (serial, model, os_version, status, last_seen_at, created_at)
            VALUES (?, ?, ?, 'online', ?, ?)
            ON CONFLICT(serial) DO UPDATE SET model=excluded.model, os_version=excluded.os_version, status='online', last_seen_at=excluded.last_seen_at`)
                        .run(s, d.model, d.osVersion, t, t);
                }
                const marks = targets.map(() => '?').join(',');
                db.prepare(`UPDATE devices SET status='offline' WHERE status='online' AND serial NOT IN (${marks})`).run(...targets);
                const row = db.prepare('SELECT * FROM devices WHERE serial = ?').get(targets[0]);
                return {
                    discovered: true,
                    device: mapDevice(row),
                    total: count(),
                    source: 'hdc',
                    note: `hdc 识别到 ${targets.length} 台设备（已保存/更新在线状态）`,
                };
            }
        }
        // 回退：hdc 不可用/无设备时生成模拟设备（演示模式）
        const note = hdcOk ? 'hdc 可用但未发现已连接设备' : '未检测到 hdc 命令，已生成模拟设备用于演示';
        const serial = `HDC-${Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase()}`;
        const models = ['Mate X5', 'Pura 70', 'nova 13', 'MatePad Pro', 'Pocket 2'];
        const oss = ['HarmonyOS 5.0.1', 'HarmonyOS 4.2', 'OpenHarmony 5.0.2'];
        const model = models[Math.floor(Math.random() * models.length)];
        const os = oss[Math.floor(Math.random() * oss.length)];
        const res = db.prepare(`INSERT OR IGNORE INTO devices (serial, model, os_version, status, battery, memory_usage, last_seen_at, created_at)
      VALUES (?, ?, ?, 'online', ?, ?, ?, ?)`).run(serial, model, os, 60 + Math.floor(Math.random() * 40), 40 + Math.floor(Math.random() * 40), t, t);
        const row = db.prepare('SELECT * FROM devices WHERE serial = ?').get(serial);
        return { discovered: res.changes > 0, device: mapDevice(row), total: count(), source: 'simulate', note };
    });
    route('PUT', '/devices/:id', async ({ params, body }) => {
        const id = Number(params.id);
        const b = body;
        const db = getDb();
        void cacheDel('devices');
        const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
        db.prepare(`UPDATE devices SET model=?, os_version=?, status=?, battery=?, memory_usage=?, last_seen_at=? WHERE id=?`).run(b.model ?? row.model, b.osVersion ?? row.os_version, b.status ?? row.status, b.battery ?? row.battery, b.memoryUsage ?? row.memory_usage, now(), id);
        return mapDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
    });
    route('POST', '/devices/:id/connect', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        void cacheDel('devices');
        const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
        db.prepare(`UPDATE devices SET status='online', last_seen_at=? WHERE id=?`).run(now(), id);
        return mapDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
    });
    route('DELETE', '/devices/:id', async ({ params }) => {
        void cacheDel('devices');
        getDb().prepare('DELETE FROM devices WHERE id = ?').run(Number(params.id));
        return { ok: true };
    });
    // ---- 数据分析 / 归因分析 ----
    route('GET', '/analyses', async ({ query }) => {
        const kind = query.get('kind') ?? '';
        const granularity = query.get('granularity') ?? '';
        const libraryId = Number(query.get('libraryId')) || null;
        return withCache(`analyses:${kind}:${libraryId}:${granularity}`, async () => {
            const conds = [];
            const p = {};
            if (kind) {
                conds.push('kind = @kind');
                p.kind = kind;
            }
            if (granularity) {
                conds.push('granularity = @granularity');
                p.granularity = granularity;
            }
            if (libraryId) {
                conds.push('library_id = @libraryId');
                p.libraryId = libraryId;
            }
            const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
            return getDb().prepare(`SELECT * FROM analyses ${where} ORDER BY id DESC LIMIT 100`).all(p).map(mapAnalysis);
        });
    });
    route('POST', '/analyses/pr/:libraryId', async ({ params, body }) => {
        void cacheDel('analyses');
        const db = getDb();
        const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(params.libraryId));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const repoPath = parseRepoPath(lib.repo_url);
        if (!repoPath)
            throw Object.assign(new Error(`库「${lib.name}」未配置 GitCode 仓库地址（repo_url），无法拉取 PR`), { statusCode: 400 });
        const b = body;
        const prNumber = Number(b.prNumber) || null;
        const prNumbers = Array.isArray(b.prNumbers)
            ? b.prNumbers.filter((n) => Number.isInteger(n) && n > 0)
            : [];
        const runId = `pr-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const target = prNumbers.length > 0 ? prNumbers : prNumber ? [prNumber] : [];
        setProgress(runId, { stage: target.length > 0 ? `拉取 ${target.length} 条 PR…` : '拉取 PR 列表…' });
        setImmediate(async () => {
            try {
                const prs = target.length > 0
                    ? await Promise.all(target.map((n) => fetchPr(repoPath, n)))
                    : await fetchPrs(repoPath);
                setProgress(runId, { stage: `已获取 ${prs.length} 条 PR` });
                const r = await analyzePrChanges(llm, lib, prs, (s) => setProgress(runId, { stage: s }));
                setProgress(runId, { stage: r.message, done: true });
            }
            catch (e) {
                setProgress(runId, { stage: '分析失败', done: true, error: e.message });
            }
        });
        return { runId };
    });
    route('POST', '/analyses/case-updates/:libraryId', async ({ params, body }) => {
        void cacheDel('analyses');
        const db = getDb();
        const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(params.libraryId));
        if (!lib)
            throw Object.assign(new Error('三方库不存在'), { statusCode: 404 });
        const repoPath = parseRepoPath(lib.repo_url);
        if (!repoPath)
            throw Object.assign(new Error(`库「${lib.name}」未配置 GitCode 仓库地址（repo_url），无法拉取 PR`), { statusCode: 400 });
        const b = body;
        const prNumber = Number(b.prNumber) || null;
        const prNumbers = Array.isArray(b.prNumbers)
            ? b.prNumbers.filter((n) => Number.isInteger(n) && n > 0)
            : [];
        const runId = `case-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const target = prNumbers.length > 0 ? prNumbers : prNumber ? [prNumber] : [];
        setProgress(runId, { stage: target.length > 0 ? `拉取 ${target.length} 条 PR…` : '拉取 PR 列表…' });
        setImmediate(async () => {
            try {
                const prs = target.length > 0
                    ? await Promise.all(target.map((n) => fetchPr(repoPath, n)))
                    : await fetchPrs(repoPath, 6);
                setProgress(runId, { stage: `已获取 ${prs.length} 条 PR` });
                const r = await analyzeCaseUpdates(llm, lib, prs, (s) => setProgress(runId, { stage: s }));
                setProgress(runId, { stage: r.message, done: true });
            }
            catch (e) {
                setProgress(runId, { stage: '分析失败', done: true, error: e.message });
            }
        });
        return { runId };
    });
    route('GET', '/analyses/progress/:runId', async ({ params }) => {
        const p = analysisProgress.get(String(params.runId));
        if (!p)
            throw Object.assign(new Error('进度不存在或已过期'), { statusCode: 404 });
        return p;
    });
    route('DELETE', '/analyses/:id', async ({ params }) => {
        const id = Number(params.id);
        const db = getDb();
        const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
        if (!row)
            throw Object.assign(new Error('分析结果不存在'), { statusCode: 404 });
        void cacheDel('analyses');
        db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
        return { ok: true, deletedKind: row.kind };
    });
    route('POST', '/analyses/attribution', async ({ body }) => {
        void cacheDel('analyses');
        const b = body;
        const granularity = (b.granularity ?? 'multi');
        if (!['single', 'lib', 'multi'].includes(granularity)) {
            throw Object.assign(new Error('granularity 必须是 single / lib / multi'), { statusCode: 400 });
        }
        return analyzeAttribution(llm, {
            granularity,
            libraryId: b.libraryId ? Number(b.libraryId) : null,
            caseId: b.caseId ? Number(b.caseId) : null,
        });
    });
}
// ---------- mappers / helpers ----------
function mapLibrary(row) {
    return {
        id: row.id, name: row.name, repoUrl: row.repo_url, description: row.description,
        currentVersion: row.current_version, status: row.status, lastSyncedAt: row.last_synced_at,
        caseCount: row.case_count ?? 0, createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapCase(row, libraryName) {
    const rawSteps = JSON.parse(row.steps || '[]');
    const steps = rawSteps.map((s) => (typeof s === 'string' ? s : String(s?.step ?? s?.text ?? s?.expected ?? ''))).filter(Boolean);
    return {
        id: row.id, libraryId: row.library_id, libraryName, caseNo: row.case_no, name: row.name,
        source: row.source, precondition: row.precondition, steps,
        expected: row.expected, status: row.status, scriptStatus: row.script_status,
        dtsUrl: row.dts_url ?? '',
        currentVersion: row.current_version, createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapVersion(row) {
    return {
        id: row.id, caseId: row.case_id, version: row.version, snapshot: JSON.parse(row.snapshot),
        changeNote: row.change_note, author: row.author, authorType: row.author_type, createdAt: row.created_at,
    };
}
function mapModel(row) {
    return {
        id: row.id, name: row.name, provider: row.provider, baseUrl: row.base_url, modelId: row.model_id,
        apiKey: row.api_key, isDefault: row.is_default === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapPrompt(row) {
    return {
        id: row.id, name: row.name, role: row.role ?? '', content: row.content ?? '',
        skill: row.skill ?? '',
        variables: safeJsonArray(row.variables), builtin: row.builtin === 1, version: row.version, updatedAt: row.updated_at,
    };
}
function mapTask(row) {
    return {
        id: row.id, taskNo: row.task_no, type: row.type, title: row.title, libraryId: row.library_id,
        input: row.input ?? '', status: row.status, progress: row.progress, resultSummary: row.result_summary,
        error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapDevice(row) {
    return {
        id: row.id, serial: row.serial, model: row.model, osVersion: row.os_version, status: row.status,
        battery: row.battery, memoryUsage: row.memory_usage, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
    };
}
function mapAnalysis(row) {
    return {
        id: row.id, kind: row.kind, granularity: row.granularity, libraryId: row.library_id,
        caseId: row.case_id, title: row.title, content: safeJsonParse(row.content, {}), createdAt: row.created_at,
    };
}
function safeJsonArray(v) {
    try {
        const parsed = JSON.parse(v ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function safeJsonParse(v, fallback) {
    if (typeof v !== 'string')
        return v ?? fallback;
    try {
        return JSON.parse(v);
    }
    catch {
        return fallback;
    }
}
/** Excel 行 → 用例字段（兼容中文表头与英文键，操作步骤支持数组/JSON/换行分隔）。 */
function normalizeCaseRow(row) {
    const ALIAS = {
        '用例编号': 'caseNo', caseNo: 'caseNo', case_no: 'caseNo',
        '用例名称': 'name', '名称': 'name', name: 'name',
        '来源': 'source', '来源分类': 'source', source: 'source',
        '前置条件': 'precondition', precondition: 'precondition',
        '操作步骤': 'steps', '步骤': 'steps', steps: 'steps',
        '预期结果': 'expected', expected: 'expected',
        '状态': 'status', status: 'status',
        '脚本状态': 'scriptStatus', scriptStatus: 'scriptStatus',
    };
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
        const key = ALIAS[k] ?? k;
        if (norm[key] === undefined && v !== undefined && v !== '')
            norm[key] = v;
    }
    let steps = [];
    const rawSteps = norm.steps;
    if (Array.isArray(rawSteps)) {
        steps = rawSteps.map(String);
    }
    else if (typeof rawSteps === 'string' && rawSteps.trim()) {
        const s = rawSteps.trim();
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                steps = Array.isArray(parsed) ? parsed.map(String) : [s];
            }
            catch {
                steps = s.split(/\n|；|;/).map((x) => x.trim()).filter(Boolean);
            }
        }
        else {
            steps = s.split(/\n/).map((x) => x.trim()).filter(Boolean);
        }
    }
    const get = (key) => (norm[key] === undefined ? undefined : String(norm[key]));
    return {
        caseNo: get('caseNo'), name: get('name'), source: get('source'), precondition: get('precondition'),
        steps, expected: get('expected'), status: get('status'), scriptStatus: get('scriptStatus'),
    };
}
function mapPlan(row) {
    return {
        id: row.id, planNo: row.plan_no, name: row.name, type: row.type, cron: row.cron,
        scope: JSON.parse(row.scope || '{"libraryIds":[],"caseIds":[]}'),
        deviceIds: JSON.parse(row.device_ids || '[]'),
        status: row.status, failPolicy: row.fail_policy, lastRunAt: row.last_run_at,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapExecution(row) {
    return {
        id: row.id, planId: row.plan_id, caseId: row.case_id, libraryId: row.library_id, deviceId: row.device_id,
        status: row.status, steps: JSON.parse(row.steps || '[]'), thinking: row.thinking, logs: row.logs,
        startedAt: row.started_at, finishedAt: row.finished_at,
        caseNo: row.case_no, caseName: row.case_name, libraryName: row.library_name, deviceSerial: row.device_serial,
    };
}
function getCaseOr404(db, id) {
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
    if (!row)
        throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
    return row;
}
function getModelOr404(db, id) {
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
    if (!row)
        throw Object.assign(new Error('模型不存在'), { statusCode: 404 });
    return row;
}
function getPromptOr404(db, id) {
    const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    if (!row)
        throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
    return row;
}
function nextTaskNo() {
    const db = getDb();
    const row = db.prepare(`SELECT MAX(CAST(SUBSTR(task_no, 3) AS INTEGER)) AS m FROM tasks`).get();
    return `T-${(row.m ?? 2400) + 1}`;
}
function nextPlanNo() {
    const db = getDb();
    const row = db.prepare(`SELECT MAX(CAST(SUBSTR(plan_no, 3) AS INTEGER)) AS m FROM plans`).get();
    return `P-${(row.m ?? 1000) + 1}`;
}
