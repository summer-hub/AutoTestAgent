// AI 任务执行器（DSH 插件版）：AI 调用经 ctx.llm（LlmCall 注入）
// write_cases / update_cases / to_script 为真实 LLM 调用；
// pull_repo / update_repo 走真实 git CLI（clone/pull + 变更解析）。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { pullRepo, updateRepo, workspaceDir } from './gitRepo.js';
import { getSetting } from './settings.js';
import { extractJson } from './llmHarness.js';
export async function runTask(taskId, llm) {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task)
        return;
    const set = (patch) => {
        const fields = Object.entries(patch).filter(([k]) => k !== 'id');
        const sets = fields.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map(([, v]) => v), now(), taskId);
    };
    try {
        set({ status: 'running', progress: 10, error: null });
        const result = await execute(task, llm);
        set({ status: 'done', progress: 100, result_summary: result });
    }
    catch (e) {
        set({ status: 'failed', error: e.message.slice(0, 500), result_summary: null });
    }
}
async function execute(task, llm) {
    const db = getDb();
    const lib = task.library_id
        ? db.prepare('SELECT * FROM libraries WHERE id = ?').get(task.library_id)
        : undefined;
    if (!lib && task.library_id !== null && task.library_id !== undefined) {
        throw new Error(`三方库 #${task.library_id} 不存在`);
    }
    switch (task.type) {
        case 'pull_repo':
        case 'update_repo':
            return await repoTask(task, lib);
        case 'write_cases':
            return await writeCases(task, lib, llm);
        case 'update_cases':
            return await updateCases(task, lib, llm);
        case 'to_script':
            return await toScript(task, lib, llm);
        default:
            throw new Error(`未知任务类型：${task.type}`);
    }
}
async function repoTask(task, lib) {
    if (!lib)
        throw new Error('仓库拉取/更新需要绑定三方库，请选择任务目标库。');
    const [r] = await withProgress(task.id, [
        [25, async () => (task.type === 'pull_repo' ? pullRepo(lib) : updateRepo(lib))],
    ]);
    return r.summary;
}
function promptFor(role, fallback) {
    const db = getDb();
    const row = db.prepare(`SELECT content FROM prompts WHERE role = ? ORDER BY id LIMIT 1`).get(role);
    return row?.content ?? fallback;
}
async function withProgress(taskId, steps) {
    const db = getDb();
    const out = [];
    for (const [pct, fn] of steps) {
        db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(pct, now(), taskId);
        out.push(await fn());
    }
    return out;
}
async function writeCases(task, lib, llm) {
    const sys = promptFor('用例生成', `你是鸿蒙三方库测试用例生成 Agent。
基于三方库代码与仓库规则生成结构化测试用例，输出 JSON 数组，每项包含：
name(用例名称), source(来源: 新需求引入|老库存量|问题单跟踪|AI 生成), precondition(前置条件),
steps(操作步骤数组), expected(预期结果), status(默认 未执行), scriptStatus(默认 未绑定)。
只输出 JSON，不要任何解释。`);
    const user = `三方库：${lib.name}
库版本：${lib.current_version}
库简介：${lib.description}
任务要求：${task.input || '为上述三方库生成 5 条覆盖正向/边界/异常场景的测试用例。'}`;
    const [parsed] = await withProgress(task.id, [
        [35, async () => extractJson(await llm({ system: sys, user }))],
    ]);
    const rows = Array.isArray(parsed) ? parsed : [];
    if (rows.length === 0)
        throw new Error('AI 未返回有效用例（JSON 解析失败）');
    const db = getDb();
    const t = now();
    const inserted = db.transaction(() => {
        let n = 0;
        const count = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE library_id = ?').get(lib.id);
        const maxCases = getSetting('agent.maxCasesPerTask', 20);
        for (const r of rows.slice(0, maxCases)) {
            const caseNo = `C-AI-${String(count.n + ++n).padStart(3, '0')}`;
            const steps = r.steps ?? ['步骤待细化'];
            const res = db.prepare(`INSERT INTO cases (library_id, case_no, name, source, precondition, steps, expected, status, script_status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '待确认', '未绑定', 1, ?, ?)`).run(lib.id, caseNo, r.name, r.source ?? 'AI 生成', r.precondition ?? '', JSON.stringify(steps), r.expected ?? '', t, t);
            const caseId = Number(res.lastInsertRowid);
            db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, 1, ?, 'AI 生成初始创建', 'AI 用例生成 Agent', 'ai', ?)`).run(caseId, JSON.stringify({
                id: caseId, libraryId: lib.id, caseNo, name: r.name, source: r.source ?? 'AI 生成',
                precondition: r.precondition ?? '', steps, expected: r.expected ?? '',
                status: '待确认', scriptStatus: '未绑定', currentVersion: 1, createdAt: t, updatedAt: t,
            }), t);
        }
        return n;
    })();
    return `AI 已生成 ${rows.length} 条用例，入库 ${inserted} 条（V1，状态：待确认）。`;
}
async function updateCases(task, lib, llm) {
    const db = getDb();
    const samples = db.prepare(`SELECT case_no, name FROM cases WHERE library_id = ? ORDER BY id LIMIT 10`).all(lib.id);
    const sys = promptFor('用例更新', `你是鸿蒙三方库测试用例更新 Agent。
根据三方库版本变更，迭代更新给定用例，输出 JSON 数组，每项包含：
caseNo(原用例编号), name(新名称), expected(更新后的预期), changeNote(更新点说明)。
只输出 JSON。`);
    const user = `三方库：${lib.name}（${lib.current_version}）
现有用例：${JSON.stringify(samples)}
任务要求：${task.input || '根据最新版本变更更新上述用例（版本自动递增）。'}`;
    const [updates] = await withProgress(task.id, [
        [40, async () => extractJson(await llm({ system: sys, user }))],
    ]);
    const t = now();
    let updated = 0;
    db.transaction(() => {
        for (const u of (Array.isArray(updates) ? updates : [])) {
            const row = db.prepare('SELECT * FROM cases WHERE case_no = ? AND library_id = ?').get(u.caseNo, lib.id);
            if (!row)
                continue;
            const next = row.current_version + 1;
            const snapshot = {
                id: row.id, libraryId: lib.id, caseNo: u.caseNo, name: u.name ?? row.name,
                source: '问题单跟踪', precondition: '', steps: JSON.parse(row.steps),
                expected: u.expected ?? row.expected, status: '待确认', scriptStatus: '未绑定',
                currentVersion: next, createdAt: t, updatedAt: t,
            };
            db.prepare(`UPDATE cases SET name=?, expected=?, current_version=?, updated_at=? WHERE id=?`).run(snapshot.name, snapshot.expected, next, t, row.id);
            db.prepare(`INSERT INTO case_versions (case_id, version, snapshot, change_note, author, author_type, created_at)
        VALUES (?, ?, ?, ?, 'AI 用例更新 Agent', 'ai', ?)`).run(row.id, next, JSON.stringify(snapshot), u.changeNote ?? 'AI 自动更新：版本自动递增。', t);
            updated++;
        }
    })();
    return `AI 已更新 ${updated} 条用例（版本自动递增，时间线完整）。`;
}
async function toScript(task, lib, llm) {
    const db = getDb();
    const cases = db.prepare(`SELECT case_no, name, steps FROM cases WHERE library_id = ? AND script_status = '未绑定' ORDER BY id LIMIT 10`).all(lib.id);
    if (cases.length === 0)
        return '没有未绑定脚本的用例，无需转换。';
    const sys = `你是鸿蒙 UI 自动化脚本生成 Agent（OpenHarmony）。
将测试用例转换为 TypeScript 自动化脚本骨架（基于 @ohos/hypium 或 UI 测试框架风格），
输出 JSON 数组，每项：{ caseNo, script }。script 为可直接使用的代码文本。只输出 JSON。`;
    const user = `三方库：${lib.name}
用例：${JSON.stringify(cases.map((c) => ({ ...c, steps: JSON.parse(c.steps) })))}`;
    const [scripts] = await withProgress(task.id, [
        [45, async () => extractJson(await llm({ system: sys, user }))],
    ]);
    const t = now();
    const dir = path.join(workspaceDir(), 'scripts', lib.name.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    let bound = 0;
    const files = [];
    db.transaction(() => {
        for (const s of (Array.isArray(scripts) ? scripts : [])) {
            const row = db.prepare('SELECT id, name FROM cases WHERE case_no = ? AND library_id = ?').get(s.caseNo, lib.id);
            if (!row)
                continue;
            db.prepare(`UPDATE cases SET script_status = '已绑定', updated_at = ? WHERE id = ?`).run(t, row.id);
            const file = path.join(dir, `${s.caseNo}.ts`);
            fs.writeFileSync(file, `// ${s.caseNo} — ${row.name}（${lib.name}）自动化脚本\n// 生成时间：${t} · AI 生成\n\n${s.script}\n`);
            files.push(file);
            bound++;
        }
    })();
    return `AI 已生成 ${bound} 个自动化脚本并落盘到：${dir}\n文件：${files.map((f) => path.basename(f)).join(', ') || '—'}`;
}
