// survey L2 层：LLM 增量采集（只跑差异库）。
//
// 为什么需要它（重构方案 §0.5.2）：L0 静态画像 + L1 预设匹配能覆盖大多数库，
// 但总有库搞不定——类别未识别、README 声明外部前置、二进制依赖要决策、该类没有预设。
// 这些库逐个问 LLM 是**应该的**（它们是真正的差异），而 348 个库全问是浪费。
//
// 四条纪律：
//   1. **只跑标记了 needs_llm 的库**：L0/L1 能搞定的绝不花 token；
//   2. **复用既有闸门**：checkLlmRate 限流 + llmJson 的 JSON 容错与跨模型重试，
//      不在这一层另造一套；
//   3. **不臆造**：LLM 只输出结构化结论，scriptId 必须在真实脚本资产表里，
//      参数必须过契约校验——否则建出来的画像跑不起来，比没有更糟；
//   4. **不确定就入队，不猜**：LLM 觉得需要人确认的，进人工队列（按类别聚合），
//      绝不把猜测当结论写进画像。
import { getDb, now } from '../../db/connection.js';
import { llmJson } from '../llmCore.js';
import { checkLlmRate } from '../llmLimit.js';
import { getScript } from '../envkit/scripts.js';
import { resolveParams } from '../envkit/contract.js';
import { LIBRARY_KINDS } from './facts.js';
/** 构造 L2Detail：把库的 (id,name) 映射成对外的 (libraryId,libraryName)。
 *  收敛成一处，避免每个 return 点各自展开时漏字段（编译错误就是这么来的）。 */
function detailOf(lib, patch) {
    return { libraryId: lib.id, libraryName: lib.name, ...patch };
}
/** 系统提示词：纪律写死，不靠模型自觉。 */
const L2_SYSTEM = [
    '你是鸿蒙三方库的"环境方案补全"Agent。输入是一个库的 L0 静态画像（客观事实）与它搞不定的原因，',
    '你要么给出可执行的环境画像，要么明确说出"需要人确认什么"。',
    '',
    '硬性纪律（违反即作废）：',
    '① 不臆造——只能依据给定的事实作答。事实里没有的信息，写进 uncertainties 问人，不要编；',
    '② scriptId 只能取给定清单里的值（清单外的一律不写）；',
    '③ 参数只填清单里声明过的参数名；',
    '④ kind 判不准就填 unknown，并说明缺什么证据；',
    '⑤ 需要人确认的每一条都要具体到动作（"该用预编译 .so 还是按 ABI 现编？"），不要"请确认一下"；',
    '⑥ 只输出 JSON，不要解释、不要围栏、不要注释。',
    '',
    '关于 projectDir：**必须填字符串 {{repoDir}}**（不要填空串、也不要填具体路径）。',
    '这是运行期占位符，环境准备执行时才替换成该库真实的仓库目录。填空串会被参数校验',
    '判为"缺少必填参数"，整份画像会被拒绝——这是实测踩过的坑。',
].join('\n');
/**
 * 跑一轮 L2 增量采集。
 *
 * 永不抛异常：单个库 LLM 失败/限流/超时都只记该库 skipped/failed，
 * 不影响同轮其他库（与 L0 批次的隔离要求一致）。
 */
export async function runL2Increment(llm, opts = {}) {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const db = getDb();
    const result = { processed: 0, resolved: 0, queued: 0, failed: 0, skipped: 0, details: [] };
    // 选库：指定 ids，或所有 needs_llm=1 的（按 id 升序，稳定可预期）
    let libs;
    const missingIds = [];
    if (opts.ids && opts.ids.length > 0) {
        libs = [];
        for (const id of opts.ids) {
            const r = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(id);
            if (r)
                libs.push(r);
            else
                missingIds.push(id);
        }
    }
    else {
        libs = await db.prepare(`SELECT l.id, l.name FROM libraries l JOIN library_survey_runs r ON r.library_id = l.id
       WHERE r.needs_llm = 1 AND r.status = 'needs_llm' ORDER BY l.id LIMIT ?`).all(limit);
    }
    // 显式指定的 id 不存在：报告出来而不是静默丢弃。
    // agent 传错 id 时，空响应会让人以为"跑过了但其实什么都没做"——
    // 这类静默失败正是平台不可信的来源。
    for (const id of missingIds) {
        result.skipped++;
        result.details.push(detailOf({ id, name: '(不存在)' }, { status: 'skipped', queued: 0, reason: '库不存在' }));
    }
    if (libs.length === 0)
        return result;
    for (const lib of libs) {
        if (opts.signal?.aborted) {
            result.skipped++;
            result.details.push(detailOf(lib, { status: 'skipped', queued: 0, reason: '批次已取消' }));
            continue;
        }
        try {
            const d = await processOne(llm, lib, opts.requestedBy ?? '', opts.taskId);
            result.processed++;
            if (d.status === 'resolved')
                result.resolved++;
            else if (d.status === 'queued')
                result.queued++;
            else if (d.status === 'failed')
                result.failed++;
            else
                result.skipped++;
            result.details.push(d);
        }
        catch (e) {
            result.failed++;
            result.details.push(detailOf(lib, { status: 'failed', queued: 0, reason: e.message }));
        }
    }
    return result;
}
/** 处理单个库：组 prompt → LLM → 校验 → 落画像/入队。 */
async function processOne(llm, lib, requestedBy, taskId) {
    const db = getDb();
    // 取 L0 事实（没有事实就不该进 L2——那是流程错误，不是 LLM 问题）
    const f = await db.prepare('SELECT * FROM library_facts WHERE library_id = ?').get(lib.id);
    if (!f) {
        return detailOf(lib, { status: 'skipped', queued: 0, reason: '该库没有 L0 画像（需先跑全量采集）' });
    }
    const run = await db.prepare('SELECT * FROM library_survey_runs WHERE library_id = ?').get(lib.id);
    // 已有 ai_draft/preset 画像的，不重复问（幂等）
    const existing = await db.prepare("SELECT id, source FROM env_profiles WHERE library_id = ? ORDER BY id DESC LIMIT 1").get(lib.id);
    if (existing && existing.source !== 'preset') {
        return detailOf(lib, { status: 'skipped', profileId: existing.id, queued: 0, reason: '已有人工/AI 画像，不重复生成' });
    }
    // 限流：与其它 LLM 调用共用配额（超限返回 429，这里记 skipped 不记 failed——
    // 限流不是库的问题，重跑就好）
    try {
        await checkLlmRate();
    }
    catch (e) {
        return detailOf(lib, { status: 'skipped', queued: 0, reason: `LLM 限流：${e.message}` });
    }
    const facts = (() => { try {
        return JSON.parse(String(f.facts_json ?? '{}'));
    }
    catch {
        return {};
    } })();
    const intel = (() => { try {
        return JSON.parse(String(f.readme_intel_json ?? '[]'));
    }
    catch {
        return [];
    } })();
    const user = [
        `## 库`, `${lib.name}`,
        `## L0 客观事实`,
        `- 类别判定：${String(f.kind)}（置信度 ${Number(f.confidence ?? 0)}）`,
        `- 判定理由：${String(f.kind_reason ?? '')}`,
        `- 构建目标：${String(f.build_target ?? '')}`,
        `- 二进制产物：${String(f.binary_kinds || '（无）')}`,
        `- 有子模块：${Number(f.has_submodules ?? 0) === 1 ? '是' : '否'}`,
        `- 有 demo：${Number(f.has_demo ?? 0) === 1 ? '是' : '否'}`,
        `- 入口文件：${String(f.entry_file || '（未定位）')}`,
        `- ohpm 依赖：${JSON.stringify(facts.ohpmDeps ?? [])}`,
        `- 模块清单：${JSON.stringify(facts.moduleNames ?? [])}`,
        `- API Level：${String(facts.apiLevel || '（未知）')}`,
        `## README 情报`, intel.length > 0 ? intel.map((i) => `- [${i.kind}] ${i.text}`).join('\n') : '（无）',
        `## L0 搞不定的原因`, String(run?.llm_reason || '（未记录）'),
        `## 可用脚本资产（scriptId 只能从这里选）`,
        '- ohpm_install（projectDir, ohpmRegistry?, offline?）',
        '- build_manifest（projectDir）',
        '- build_har（projectDir, module?, buildMode?, product?）',
        '- build_hap（projectDir, module?, buildMode?, product?）',
        '- hdc_install（hapPath, deviceSerial?, replace?）',
        `## 合法 kind 取值`, LIBRARY_KINDS.join(' / '),
        `## 合法阻塞类别（uncertainties.stage 只能从这里选）`,
        'env_blocked（环境准备受阻）/ resource_missing（缺测试资源）/ toolchain_missing（缺工具链）',
        '',
        '请输出 JSON：{ "kind": "...", "kindReason": "...", "toolchain": {...}, "steps": [{"scriptId":"...","params":{...},"required":true}], "uncertainties": [{"stage":"...","question":"..."}] }',
    ].join('\n');
    const r = await llmJson(llm, {
        system: L2_SYSTEM, user, temperature: 0.2, maxTokens: 2000,
        signal: undefined, meta: { taskId, kind: 'survey.l2' },
    });
    // ---- 校验：不臆造的最后一道闸 ----
    const problems = [];
    if (!r.data || typeof r.data !== 'object')
        problems.push('LLM 未返回对象');
    const v = r.data;
    if (v.kind && !LIBRARY_KINDS.includes(v.kind))
        problems.push(`非法 kind：${String(v.kind)}`);
    const steps = Array.isArray(v.steps) ? v.steps : [];
    if (steps.length === 0)
        problems.push('未给出任何步骤');
    // scriptId 必须在真实资产表里，参数必须过契约
    const validSteps = [];
    for (const [i, s] of steps.entries()) {
        const script = await getScript(String(s?.scriptId ?? ''));
        if (!script) {
            problems.push(`第 ${i + 1} 步 scriptId 不存在：${String(s?.scriptId)}`);
            continue;
        }
        if (!script.enabled) {
            problems.push(`第 ${i + 1} 步脚本已禁用：${script.id}`);
            continue;
        }
        // 防御性归一化：LLM 常把 projectDir 填成空串。提示词已要求填 {{repoDir}}，
        // 但不保证每个模型都听话；而空串会被判"缺少必填参数"导致整份画像被拒。
        // 这里把空/缺的 projectDir 归一成占位符——比让整份画像失败更有用，
        // 且与 preset 的占位符约定一致（见 presets.ts::presetStepsToProfileSteps）。
        const rawParams = { ...(s.params ?? {}) };
        if (!rawParams.projectDir)
            rawParams.projectDir = '{{repoDir}}';
        const resolved = resolveParams(script.contract, rawParams);
        if (!resolved.ok) {
            problems.push(`第 ${i + 1} 步（${script.id}）参数不合法：${resolved.problems.join('；')}`);
            continue;
        }
        validSteps.push({ scriptId: script.id, params: resolved.params, required: s.required !== false });
    }
    // ---- 落库 ----
    const t = now();
    let profileId = 0;
    if (problems.length === 0 && validSteps.length > 0) {
        await db.prepare(`INSERT INTO env_profiles
      (library_id, name, status, preset_kind, toolchain_json, components_json, source, confidence, knowledge_refs, confirmed_by, confirmed_at, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, '{}', 'ai_draft', 50, '[]', '', NULL, ?, ?)`)
            .run(lib.id, `${v.kind || 'unknown'}-ai`, String(v.kind ?? ''), JSON.stringify(v.toolchain ?? {}), t, t);
        profileId = Number((await db.prepare('SELECT id FROM env_profiles WHERE library_id = ? ORDER BY id DESC LIMIT 1').get(lib.id))?.id ?? 0);
        let seq = 0;
        for (const s of validSteps) {
            seq++;
            await db.prepare(`INSERT INTO env_profile_steps (profile_id, seq, script_id, params_json, required, skip_if, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?)`)
                .run(profileId, seq, s.scriptId, JSON.stringify(s.params), s.required ? 1 : 0, t);
        }
        // 类别被 LLM 补上了 → 回写 library_facts（L0 的 unknown 升级为确定类别）
        if (v.kind && v.kind !== 'unknown' && String(f.kind) === 'unknown') {
            await db.prepare('UPDATE library_facts SET kind = ?, kind_reason = ?, confidence = ?, updated_at = ? WHERE library_id = ?')
                .run(v.kind, `L2 补全：${String(v.kindReason ?? '').slice(0, 400)}`, 70, t, lib.id);
        }
    }
    // 不确定项入队（按「库 × 阻塞类别」，一类一条）
    const uncertainties = Array.isArray(v.uncertainties) ? v.uncertainties : [];
    let queued = 0;
    for (const u of uncertainties) {
        const stage = ['env_blocked', 'resource_missing', 'toolchain_missing'].includes(String(u.stage)) ? String(u.stage) : 'env_blocked';
        const question = String(u.question ?? '').trim();
        if (!question)
            continue;
        const dup = await db.prepare(`SELECT id FROM human_queue WHERE library_id = ? AND stage = ? AND status = 'open' AND case_id IS NULL ORDER BY id DESC LIMIT 1`).get(lib.id, stage);
        if (dup)
            continue; // 同类未解决的不重复堆
        await db.prepare(`INSERT INTO human_queue
      (library_id, case_id, stage, reason, question, payload_json, status, resolution, resolved_by, resolved_at, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, 'open', '', '', NULL, ?, ?)`)
            .run(lib.id, stage, `L2 增量采集待确认：${lib.name}`, question.slice(0, 490), JSON.stringify({ source: 'survey.l2', kind: v.kind, kindReason: v.kindReason, problems, toolchain: v.toolchain ?? {} }), t, t);
        queued++;
    }
    // 更新采集状态：有问题或有不确认项 → 仍是 needs_llm（否则算 done）
    const stillNeeds = problems.length > 0 || queued > 0;
    await db.prepare(`UPDATE library_survey_runs
    SET status = ?, needs_llm = ?, llm_reason = ?, updated_at = ? WHERE library_id = ?`)
        .run(stillNeeds ? 'needs_llm' : 'done', stillNeeds ? 1 : 0, stillNeeds ? [...problems, ...uncertainties.map((u) => `待确认：${String(u.question).slice(0, 120)}`)].join('；').slice(0, 480) : '', t, lib.id);
    const status = problems.length > 0 ? 'failed' : (queued > 0 ? 'queued' : 'resolved');
    return detailOf(lib, {
        status, kind: String(v.kind ?? ''), profileId: profileId || undefined, queued,
        reason: problems.length > 0 ? problems.join('；').slice(0, 300)
            : (queued > 0 ? `画像已生成，${queued} 项待人工确认` : '画像已生成'),
    });
}
