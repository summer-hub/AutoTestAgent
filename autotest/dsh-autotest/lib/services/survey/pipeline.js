import { getDb, now } from '../../db/connection.js';
import { repoDirFor } from '../gitRepo.js';
import { scanRepo } from './scan.js';
import { buildLibraryFacts, presetKindFor } from './facts.js';
/** 批次号（可读 + 唯一）。 */
function batchNo() {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `SV-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
}
/** 选出一批待采集的库。 */
async function selectLibraries(opts) {
    const db = getDb();
    if (opts.scope === 'ids' && opts.ids && opts.ids.length > 0) {
        const rows = [];
        for (const id of opts.ids) {
            const r = await db.prepare('SELECT id, name, repo_url, repo_subpath, last_commit FROM libraries WHERE id = ?').get(id);
            if (r)
                rows.push(r);
        }
        return rows;
    }
    // all：只采 active 的库（删除/停用的不值得扫）
    const rows = await db.prepare("SELECT id, name, repo_url, repo_subpath, last_commit FROM libraries WHERE status = 'active' ORDER BY id").all();
    let list = rows;
    if (opts.scope === 'kinds' && opts.kinds && opts.kinds.length > 0) {
        // 按已采集的类别过滤（未采集的库不在任何类别里，需先跑一轮 all）
        const factRows = await db.prepare('SELECT library_id, kind FROM library_facts').all();
        const kindOf = new Map(factRows.map((f) => [Number(f.library_id), f.kind]));
        list = list.filter((l) => {
            const k = kindOf.get(l.id);
            return k !== undefined && opts.kinds.includes(k);
        });
    }
    return list;
}
/** 单库采集（批次与手动单跑共用）。返回是否成功与是否需要 LLM。 */
export async function surveyLibrary(libraryId, opts = {}) {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name, repo_url, repo_subpath, last_commit FROM libraries WHERE id = ?')
        .get(libraryId);
    if (!lib)
        return { ok: false, skipped: false, needsLlm: false, failureKind: 'unknown', failureWhat: '库不存在' };
    const startedAt = Date.now();
    //  upsert 采集记录为 running（断点续跑的单位）
    await db.prepare(`INSERT INTO library_survey_runs (library_id, status, last_commit, duration_ms, failure_kind, failure_what, needs_llm, llm_reason, created_at, updated_at)
    VALUES (?, 'running', ?, 0, '', '', 0, '', ?, ?)
    ON CONFLICT(library_id) DO UPDATE SET status='running', last_commit=?, duration_ms=0, failure_kind='', failure_what='', needs_llm=0, llm_reason='', updated_at=?`)
        .run(libraryId, lib.last_commit ?? '', now(), now(), lib.last_commit ?? '', now());
    const dir = repoDirFor(lib);
    const r = scanRepo(dir, lib.name);
    if (!r.ok || !r.scan) {
        await db.prepare(`UPDATE library_survey_runs SET status='failed', failure_kind=?, failure_what=?, duration_ms=?, updated_at=? WHERE library_id=?`)
            .run('repo_missing', (r.reason ?? '扫描失败').slice(0, 480), Date.now() - startedAt, now(), libraryId);
        return { ok: false, skipped: false, needsLlm: false, failureKind: 'repo_missing', failureWhat: r.reason ?? '扫描失败' };
    }
    const facts = buildLibraryFacts(r.scan);
    await saveFacts(libraryId, lib.last_commit ?? '', facts);
    // L1 预设匹配：有 preset 就生成 env_profiles 草稿（draft，待人工确认）
    let needsLlm = facts.needsLlm.length > 0;
    if (opts.createProfiles !== false) {
        const presetKind = presetKindFor(facts.kind);
        if (presetKind) {
            const created = await createProfileFromPreset(libraryId, lib.name, presetKind, facts);
            if (!created.ok && created.reason)
                needsLlm = true;
        }
    }
    const status = needsLlm ? 'needs_llm' : 'done';
    await db.prepare(`UPDATE library_survey_runs SET status=?, needs_llm=?, llm_reason=?, duration_ms=?, updated_at=? WHERE library_id=?`)
        .run(status, needsLlm ? 1 : 0, facts.needsLlm.join('；').slice(0, 480), Date.now() - startedAt, now(), libraryId);
    return { ok: true, skipped: false, needsLlm, failureKind: '', failureWhat: '', kind: facts.kind };
}
/** 事实落库（upsert：一个库一份最新事实）。 */
async function saveFacts(libraryId, commit, f) {
    const t = now();
    await getDb().prepare(`INSERT INTO library_facts
    (library_id, last_commit, kind, kind_reason, confidence, build_target, has_submodules, has_binary, binary_kinds, has_demo, entry_file, readme_chars, facts_json, resource_candidates_json, readme_intel_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_id) DO UPDATE SET last_commit=?, kind=?, kind_reason=?, confidence=?, build_target=?,
      has_submodules=?, has_binary=?, binary_kinds=?, has_demo=?, entry_file=?, readme_chars=?,
      facts_json=?, resource_candidates_json=?, readme_intel_json=?, updated_at=?`)
        .run(libraryId, commit, f.kind, f.kindReason, f.confidence, f.buildTarget, f.hasSubmodules ? 1 : 0, f.hasBinary ? 1 : 0, f.binaryKinds.join(','), f.hasDemo ? 1 : 0, f.entryFile, f.readmeChars, JSON.stringify(f.facts), JSON.stringify(f.resourceCandidates), JSON.stringify(f.readmeIntel), t, t, commit, f.kind, f.kindReason, f.confidence, f.buildTarget, f.hasSubmodules ? 1 : 0, f.hasBinary ? 1 : 0, f.binaryKinds.join(','), f.hasDemo ? 1 : 0, f.entryFile, f.readmeChars, JSON.stringify(f.facts), JSON.stringify(f.resourceCandidates), JSON.stringify(f.readmeIntel), t);
}
/**
 * 跑一批采集。
 *
 * 并发实现用「固定 worker 池 + 共享队列」而不是 Promise.all 分批：
 * 348 个库里单个库的耗时差异极大（空目录 vs 几千文件），固定池能让
 * 快库不闲着、慢库不堵住整批。
 */
export async function runSurveyBatch(opts = {}) {
    const startedAt = Date.now();
    const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4));
    const db = getDb();
    const t = now();
    const ins = await db.prepare(`INSERT INTO library_survey_batches
    (batch_no, scope, library_ids, total, done, failed, skipped, needs_llm, status, concurrency, started_at, created_at, updated_at)
    VALUES (?, ?, '[]', 0, 0, 0, 0, 0, 'running', ?, ?, ?, ?)`)
        .run(batchNo(), opts.scope ?? 'all', concurrency, t, t, t);
    const batchId = Number(ins.lastInsertRowid);
    const libs = await selectLibraries(opts);
    await db.prepare('UPDATE library_survey_batches SET total=?, library_ids=?, updated_at=? WHERE id=?')
        .run(libs.length, JSON.stringify(libs.map((l) => l.id)), now(), batchId);
    let done = 0, failed = 0, skipped = 0, needsLlm = 0;
    const byKind = {};
    let cursor = 0;
    const worker = async () => {
        while (true) {
            if (opts.signal?.aborted)
                return;
            const i = cursor++;
            if (i >= libs.length)
                return;
            const lib = libs[i];
            try {
                // 断点续跑：已 done/needs_llm 且 commit 未变 → 跳过
                if (opts.resume !== false) {
                    const prev = await db.prepare('SELECT status, last_commit FROM library_survey_runs WHERE library_id = ?')
                        .get(lib.id);
                    if (prev && ['done', 'needs_llm'].includes(prev.status) && prev.last_commit === (lib.last_commit ?? '')) {
                        skipped++;
                        if (prev.status === 'needs_llm')
                            needsLlm++;
                        await bumpBatch(batchId, { skipped });
                        continue;
                    }
                }
                const r = await surveyLibrary(lib.id, { createProfiles: opts.createProfiles, signal: opts.signal });
                if (!r.ok) {
                    failed++;
                    await bumpBatch(batchId, { failed });
                    continue;
                }
                done++;
                if (r.kind)
                    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
                if (r.needsLlm) {
                    needsLlm++;
                    await bumpBatch(batchId, { needsLlm });
                }
                await bumpBatch(batchId, { done });
            }
            catch (e) {
                // 单库异常绝不外抛：隔离失败，只记该库
                failed++;
                try {
                    await db.prepare(`UPDATE library_survey_runs SET status='failed', failure_kind='unknown', failure_what=?, duration_ms=0, updated_at=? WHERE library_id=?`)
                        .run(String(e.message).slice(0, 480), now(), lib.id);
                }
                catch { /* 记录失败也不能影响批次 */ }
                await bumpBatch(batchId, { failed });
            }
        }
    };
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, libs.length); i++)
        workers.push(worker());
    await Promise.all(workers);
    const cancelled = opts.signal?.aborted === true;
    await db.prepare(`UPDATE library_survey_batches
    SET done=?, failed=?, skipped=?, needs_llm=?, status=?, finished_at=?, error=?, updated_at=? WHERE id=?`)
        .run(done, failed, skipped, needsLlm, cancelled ? 'cancelled' : 'passed', now(), cancelled ? '批次已取消' : '', now(), batchId);
    return { batchId, batchNo: '', total: libs.length, done, failed, skipped, needsLlm, byKind, durationMs: Date.now() - startedAt };
}
/** 批次进度自增（每一步都落库，前端可实时看到；不是跑完才一次性写）。 */
async function bumpBatch(batchId, delta) {
    const sets = [];
    const args = [];
    if (delta.done) {
        sets.push('done = done + ?');
        args.push(delta.done);
    }
    if (delta.failed) {
        sets.push('failed = failed + ?');
        args.push(delta.failed);
    }
    if (delta.skipped) {
        sets.push('skipped = skipped + ?');
        args.push(delta.skipped);
    }
    if (delta.needsLlm) {
        sets.push('needs_llm = needs_llm + ?');
        args.push(delta.needsLlm);
    }
    if (sets.length === 0)
        return;
    sets.push('updated_at = ?');
    args.push(now(), batchId);
    await getDb().prepare(`UPDATE library_survey_batches SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}
/** 批次概况（前端「全量分析」页与验收指标共用）。 */
export async function surveyStats() {
    const db = getDb();
    const batches = await db.prepare('SELECT * FROM library_survey_batches ORDER BY id DESC LIMIT 20').all();
    // 按类别统计需 join：kind 在 library_facts 上，needs_llm 在 library_survey_runs 上。
    // 曾直接 SUM(library_facts.needs_llm) → SQLite 报 "no such column"（自检当场抓住）。
    // LEFT JOIN：未采集过的库也计 0，不会因为缺 run 记录而丢一类。
    const kindRows = await db.prepare(`
    SELECT f.kind AS kind, COUNT(*) AS n,
           SUM(CASE WHEN r.needs_llm = 1 THEN 1 ELSE 0 END) AS llm
    FROM library_facts f LEFT JOIN library_survey_runs r ON r.library_id = f.library_id
    GROUP BY f.kind ORDER BY n DESC`)
        .all();
    const libCount = (await db.prepare('SELECT COUNT(*) AS n FROM libraries').get())?.n ?? 0;
    const surveyed = (await db.prepare('SELECT COUNT(*) AS n FROM library_facts').get())?.n ?? 0;
    const needsLlm = (await db.prepare('SELECT COUNT(*) AS n FROM library_survey_runs WHERE status = ?').get('needs_llm'))?.n ?? 0;
    const failed = (await db.prepare('SELECT COUNT(*) AS n FROM library_survey_runs WHERE status = ?').get('failed'))?.n ?? 0;
    const presetsMatched = (await db.prepare('SELECT COUNT(*) AS n FROM env_profiles WHERE source = ?').get('preset'))?.n ?? 0;
    return {
        batches,
        byKind: kindRows.map((r) => ({ kind: r.kind, count: Number(r.n), needsLlm: Number(r.llm ?? 0) })),
        totals: { libraries: Number(libCount), surveyed: Number(surveyed), needsLlm: Number(needsLlm), failed: Number(failed), presetsMatched: Number(presetsMatched) },
    };
}
/**
 * L1 预设匹配 → env_profiles 草稿。
 * 幂等：同库同 preset 类别已有画像则不重复建（库名唯一键兜底）。
 */
async function createProfileFromPreset(libraryId, libraryName, kind, facts) {
    const { loadPreset, presetStepsToProfileSteps, presetComponentsFor } = await import('./presets.js');
    const preset = loadPreset(kind);
    if (!preset)
        return { ok: false, reason: `无 ${kind} 类别预设（需人工补充 presets/${kind}/）` };
    const db = getDb();
    const name = `${kind}-default`;
    const existing = await db.prepare('SELECT id FROM env_profiles WHERE library_id = ? AND name = ?').get(libraryId, name);
    if (existing)
        return { ok: true };
    const t = now();
    try {
        await db.prepare(`INSERT INTO env_profiles
      (library_id, name, status, preset_kind, toolchain_json, components_json, source, confidence, knowledge_refs, confirmed_by, confirmed_at, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, 'preset', ?, '[]', '', NULL, ?, ?)`)
            .run(libraryId, name, kind, JSON.stringify(preset.toolchain), JSON.stringify(presetComponentsFor(preset, facts)), Math.max(40, Math.min(90, facts.confidence)), t, t);
        const profileId = Number((await db.prepare('SELECT id FROM env_profiles WHERE library_id = ? AND name = ?').get(libraryId, name))?.id ?? 0);
        if (!profileId)
            return { ok: false, reason: '画像创建后未取到 id' };
        let seq = 0;
        for (const s of presetStepsToProfileSteps(preset, facts)) {
            seq++;
            await db.prepare(`INSERT INTO env_profile_steps (profile_id, seq, script_id, params_json, required, skip_if, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?)`)
                .run(profileId, seq, s.scriptId, JSON.stringify(s.params), s.required ? 1 : 0, t);
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, reason: `画像创建失败：${e.message}` };
    }
}
/** 供自检复用：把 facts 直接写库（不依赖仓库扫描）。 */
export async function saveFactsForTest(libraryId, commit, f) {
    await saveFacts(libraryId, commit, f);
}
/** 导出内部工具（自检与 preset 匹配用）。 */
export { createProfileFromPreset };
