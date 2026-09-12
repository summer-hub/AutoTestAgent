// P4：矩阵驱动的初版用例集 —— 适用性规则 + 数量模型 + 生成计划。
//
// 目标（设计 §6.4）：不是"每个接口都硬造四条用例"，而是**先判定适用性再决定造几条**。
// 一个没有输入的接口硬编"大数据"用例，只会制造一批跑不了、也没法断言的垃圾；
// 而一个带 3 种异常码的接口只给 1 条边界用例，则是漏测。
//
// 这一层是纯函数（无 DB/无 LLM/无设备），因为"该生成几条、为什么"必须可以离线核对，
// 否则数量报告就成了给数字背书的摆设。LLM 只负责把每条计划**写成具体用例**，
// 不参与决定"该不该有这条"。
import { getDb } from '../db/connection.js';
export const SCENARIO_LABEL = {
    happy: '正向', empty: '空值', boundary: '边界异常', bigdata: '大数据',
};
export const SCENARIO_ORDER = ['happy', 'empty', 'boundary', 'bigdata'];
const CONTAINER_TYPE = /array|\[\]|list|map|set|object|record|string|buffer|byte|json|any|unknown|esobject/i;
const NUMBERLIKE_TYPE = /number|int|float|double|long|decimal|bigint/i;
const SIZE_WORD = /(size|count|length|width|height|dimension|duration|timeout|interval|delay|number|limit|max|min|数量|大小|尺寸|时长|长度|个数)/i;
const STATEFUL_METHOD = /^(on|add|set|update|remove|delete|clear|release|reset|init|start|stop|pause|resume|open|close|bind|unbind|register|unregister|cancel)/i;
const MEDIA_WORD = /(file|image|video|audio|render|animation|draw|canvas|pixel|stream|media|content|data|list|array|json|schema)/i;
function paramText(s) {
    return s.params.map((p) => `${p.name} ${p.type} ${p.doc}`).join(' | ');
}
/**
 * 适用性判定（设计 §6.4 的确定性规则）。
 * happy 恒适用；其余三个维度必须能说出"凭什么适用"，说不出就判不适用 ——
 * 宁可少造一条，也不造一条跑不了、断言不了的用例。
 */
export function computeApplicability(s) {
    const fit = { happy: true, empty: false, boundary: false, bigdata: false };
    const reasons = {
        happy: '正向路径：全部接口必适用',
        empty: '',
        boundary: '',
        bigdata: '',
    };
    // ---- empty 空值：参数可空 / 参数类型是容器·字符串·对象 / 有 setter 类接口 ----
    const optionalParams = s.params.filter((p) => p.optional);
    const containerParams = s.params.filter((p) => CONTAINER_TYPE.test(p.type));
    const setterMethods = s.methods.filter((m) => /^(set|add|update|clear|remove|init)/i.test(m));
    const emptyWhy = [];
    if (optionalParams.length > 0)
        emptyWhy.push(`${optionalParams.length} 个可选参数（不传即空值路径：${optionalParams.map((p) => p.name).join('/')}）`);
    if (containerParams.length > 0)
        emptyWhy.push(`参数含容器/字符串/对象类型（可传空串/空数组/空对象：${containerParams.map((p) => `${p.name}:${p.type || '未标注'}`).join('/')}）`);
    if (setterMethods.length > 0)
        emptyWhy.push(`有 setter 类接口（可设空值：${setterMethods.slice(0, 4).join('/')}）`);
    if (s.kind === 'class' && s.methods.length > 0 && emptyWhy.length === 0) {
        emptyWhy.push('类方法可在未 init/未设置状态下直接调用（未初始化路径）');
    }
    fit.empty = emptyWhy.length > 0;
    reasons.empty = fit.empty ? emptyWhy.join('；') : '无参数、无容器类型参数、无 setter 类接口 → 空值场景不适用';
    // ---- boundary 边界异常：有取值范围/上限，或有状态机/回调/异步/异常语义 ----
    const throwsCount = s.throws.length;
    const stateful = s.methods.filter((m) => STATEFUL_METHOD.test(m));
    const numberParams = s.params.filter((p) => NUMBERLIKE_TYPE.test(p.type));
    const boundaryWhy = [];
    if (throwsCount > 0)
        boundaryWhy.push(`声明了 ${throwsCount} 类异常（${s.throws.map((t) => t.type || 'Error').join('/')}）`);
    if (numberParams.length > 0)
        boundaryWhy.push(`含数值型参数（有取值范围/越界空间：${numberParams.map((p) => p.name).join('/')}）`);
    if (stateful.length > 0)
        boundaryWhy.push(`有状态机/生命周期方法（可重复调用、逆序调用、释放后调用：${stateful.slice(0, 5).join('/')}）`);
    if (s.params.some((p) => /(schema|object|json)/i.test(p.type)))
        boundaryWhy.push('参数为结构体/JSON：可构造类型错误与非法结构');
    fit.boundary = boundaryWhy.length > 0;
    reasons.boundary = fit.boundary ? boundaryWhy.join('；') : '无异常声明、无数值/结构参数、无状态机方法 → 边界异常场景不适用';
    // ---- bigdata 大数据：输入含尺寸/数量/时长参数，或接口处理集合/媒体/渲染 ----
    const sizeParams = s.params.filter((p) => SIZE_WORD.test(`${p.name} ${p.doc}`) || CONTAINER_TYPE.test(p.type));
    const mediaSymbol = MEDIA_WORD.test(s.name) || s.methods.some((m) => MEDIA_WORD.test(m));
    const bigWhy = [];
    if (sizeParams.length > 0)
        bigWhy.push(`参数含尺寸/数量/内容（可放大：${sizeParams.map((p) => p.name).join('/')}）`);
    if (mediaSymbol)
        bigWhy.push(`接口名/方法名涉及集合·媒体·渲染（${[...[s.name], ...s.methods].filter((x) => MEDIA_WORD.test(x)).slice(0, 4).join('/')}）`);
    fit.bigdata = bigWhy.length > 0;
    reasons.bigdata = fit.bigdata ? bigWhy.join('；') : '无尺寸/数量参数，且接口不处理集合·媒体·渲染 → 大数据场景不适用';
    return { fit, reasons };
}
/**
 * 负向用例的**额外条数**（设计 §6.4：negExtra_* 由接口语义决定）。
 * 这里只用能拿出依据的口径，并把依据写出来：异常码几种就多几条，状态机多一条重复/逆序。
 */
export function computeNegExtra(s) {
    const reasons = [];
    const boundary = s.throws.length + (s.methods.some((m) => STATEFUL_METHOD.test(m)) ? 1 : 0);
    if (s.throws.length > 0)
        reasons.push(`每条声明异常各一条（${s.throws.map((t) => t.type || 'Error').join('/')}）`);
    if (s.methods.some((m) => STATEFUL_METHOD.test(m)))
        reasons.push('状态机多一条：重复调用 / 未初始化即调用');
    const empty = s.params.filter((p) => p.optional).length >= 2 ? 1 : 0;
    if (empty > 0)
        reasons.push('多个可选参数时补一条"全部不传"');
    return { empty, boundary, reasons };
}
/** 触发器：同一接口在 demo 里可能有多个入口页面，按入口展开（设计 §6.4 的可选项）。 */
export function computeTriggers(s) {
    const seen = new Map();
    for (const c of s.demoCalls) {
        const key = c.pagePath || '(未知页面)';
        if (seen.has(key))
            continue;
        // 真机控件里找与该符号/页面对得上的可点控件；找不到就用页面名，不编造控件
        const control = s.deviceControls.find((t) => /验证|运行|执行|开始|播放|测试|提交/.test(t)) ?? '';
        seen.set(key, { pagePath: key, control });
    }
    if (seen.size === 0)
        seen.set('', { pagePath: '', control: '' });
    return [...seen.values()];
}
function priorityOf(scenario) {
    if (scenario === 'happy')
        return 'P0';
    if (scenario === 'bigdata')
        return 'P2';
    return 'P1';
}
function inputPlanOf(s, scenario) {
    if (s.params.length === 0 && s.methods.length > 0) {
        // 类的方法才是真正可测的单元（P2 已经把方法清单单独存下来了）。
        // 这里不能说"无参数所以不用构造输入" —— 那会让 LLM 写出一条无话可说的用例。
        const methods = s.methods.slice(0, 5).join(' / ');
        return `该符号无构造参数，场景通过**方法**构造：${methods}${s.methods.length > 5 ? ` 等 ${s.methods.length} 个` : ''}（${scenarioInputHint(scenario)}）`;
    }
    if (s.params.length === 0) {
        return scenario === 'happy' ? '使用接口默认行为，不需要构造输入' : '该接口无参数，场景差异通过调用时序/调用次数体现';
    }
    const list = s.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? `:${p.type}` : ''}`);
    switch (scenario) {
        case 'happy': return `按签名给定合法值：${list.join(', ')}`;
        case 'empty': return `把可空/容器类参数置空（''、[]、{}、null 或省略可选参数）：${list.join(', ')}`;
        case 'boundary': return `构造越界/非法值：${list.join(', ')}${s.throws.length ? `，触发 ${s.throws.map((t) => t.type || 'Error').join('/')}` : ''}`;
        case 'bigdata': return `放大尺寸/数量类参数（大数组/长字符串/大对象）：${list.join(', ')}`;
        default: return list.join(', ');
    }
}
function scenarioInputHint(scenario) {
    switch (scenario) {
        case 'happy': return '按正常顺序调用一个代表性方法';
        case 'empty': return '传入空值/不传参/未初始化即调用';
        case 'boundary': return '越界值、类型错误、重复调用、逆序调用、释放后再调用';
        case 'bigdata': return '大数组/长文本/大批量调用';
        default: return '';
    }
}
function assertionPlanOf(s, scenario) {
    const ret = s.returns.type ? `返回 ${s.returns.type}` : '返回值';
    switch (scenario) {
        case 'happy': return `断言调用成功且 ${ret} 符合预期${s.returns.doc ? `（${s.returns.doc}）` : ''}；界面上出现可核对的结果文本`;
        case 'empty': return `断言空输入被正确处理（不崩溃、返回明确的无效结果或抛出声明的异常）`;
        case 'boundary': return `断言越界/非法输入给出明确错误${s.throws.length ? `（${s.throws.map((t) => t.type || 'Error').join('/')}）` : ''}，且不产生部分写入等副作用`;
        case 'bigdata': return '断言在大输入下功能仍正确，且无超时/内存异常（关注耗时与稳定性）';
        default: return '断言结果符合预期';
    }
}
/**
 * 单个符号的用例计划（设计 §6.4 的数量模型）。
 *
 *   条数 = Σ( happy 1 + empty (1 + negExtra_empty) + boundary (1 + negExtra_boundary) + bigdata 1 )
 *          × 触发器展开（额外入口只展开 happy，避免条数随页面数失控）
 */
export function planSymbolCases(s, opts = {}) {
    const maxTriggers = Math.max(1, opts.maxTriggersPerSymbol ?? 3);
    const maxCases = Math.max(1, opts.maxCasesPerSymbol ?? 12);
    const { fit, reasons } = computeApplicability(s);
    const neg = computeNegExtra(s);
    const allTriggers = computeTriggers(s);
    const triggers = allTriggers.slice(0, maxTriggers);
    const triggerNote = allTriggers.length > triggers.length
        ? `（该接口在 demo 里共 ${allTriggers.length} 个入口，本次按前 ${triggers.length} 个展开以控制条数）`
        : '';
    const out = [];
    const push = (scenario, because, triggerIndex) => {
        const trg = triggers[triggerIndex] ?? triggers[0];
        out.push({
            symbolId: s.id,
            symbolName: s.name,
            symbolKind: s.kind,
            scenario,
            priority: priorityOf(scenario),
            title: `${s.name} · ${SCENARIO_LABEL[scenario]}${triggerIndex > 0 ? `（入口 ${triggerIndex + 1}：${trg.pagePath}）` : ''}`,
            purpose: `验证 ${s.name}${s.signature ? ` ${s.signature}` : ''} 在${SCENARIO_LABEL[scenario]}场景下的行为`,
            because: because + (triggerIndex > 0 ? triggerNote : ''),
            triggerPage: trg?.pagePath ?? '',
            triggerControl: trg?.control ?? '',
            inputPlan: inputPlanOf(s, scenario),
            assertionPlan: assertionPlanOf(s, scenario),
            needsPatchHint: s.demoCalls.length > 0 ? 'likely-open' : s.testCallCount > 0 ? 'likely-needs-demo-change' : 'unknown',
        });
    };
    // happy：必做；额外入口只扩 happy
    push('happy', reasons.happy, 0);
    for (let i = 1; i < triggers.length; i++) {
        if (triggers[i].pagePath)
            push('happy', `同一接口按不同入口分别覆盖（入口 ${i + 1}）`, i);
    }
    if (fit.empty) {
        push('empty', reasons.empty, 0);
        for (let i = 0; i < neg.empty; i++)
            push('empty', `负向补充：${neg.reasons.find((r) => r.includes('全部不传')) ?? '可选参数组合'}`, 0);
    }
    if (fit.boundary) {
        push('boundary', reasons.boundary, 0);
        for (const t of s.throws)
            push('boundary', `负向补充：声明异常 ${t.type || 'Error'}${t.doc ? `（${t.doc}）` : ''} 各一条`, 0);
        if (neg.boundary > s.throws.length)
            push('boundary', '负向补充：重复调用 / 未初始化即调用（状态机）', 0);
    }
    if (fit.bigdata)
        push('bigdata', reasons.bigdata, 0);
    return out.slice(0, maxCases);
}
/**
 * 从**实际计划**汇总数量报告（纯函数，便于离线核对）。
 *
 * 这里的唯一纪律：报告里的每个数字都必须是数出来的，不能另算一遍。
 * 一开始分解表是拿 applicability 重新推的，而计划的触发器数被 maxTriggersPerSymbol 截过，
 * 于是报告写着「正向 17 条」而实际只生成 3 条 —— 报告与计划不一致比没有报告更糟，
 * 因为它会让人以为已经覆盖了 17 个入口。所以这里特意做成纯函数并单独自检。
 */
export function summarizePlans(perSymbol, plans) {
    const byScenario = { happy: 0, empty: 0, boundary: 0, bigdata: 0 };
    const byPriority = { P0: 0, P1: 0, P2: 0 };
    const byKind = {};
    for (const p of plans) {
        byScenario[p.scenario]++;
        byPriority[p.priority]++;
        byKind[p.symbolKind] = (byKind[p.symbolKind] ?? 0) + 1;
    }
    const perSymbolBreakdown = perSymbol.map((p) => {
        const mine = plans.filter((x) => x.symbolId === p.symbolId);
        const countOf = (sc) => mine.filter((x) => x.scenario === sc).length;
        return { name: p.name, happy: countOf('happy'), empty: countOf('empty'), boundary: countOf('boundary'), bigdata: countOf('bigdata') };
    });
    return { planned: plans.length, byScenario, byPriority, byKind, perSymbolBreakdown };
}
/** 用 P2/P3 已落库的事实为一个库生成计划（不调 LLM、不写 cases）。 */
export async function planLibraryCases(libraryId, opts = {}) {
    const db = getDb();
    const version = (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version ?? '';
    const symbolRows = await db.prepare('SELECT * FROM api_symbols WHERE library_id = ? AND library_version = ? ORDER BY id')
        .all(libraryId, version);
    if (symbolRows.length === 0) {
        throw Object.assign(new Error('该库还没有接口清单，请先在「接口清单」页采集，再构建覆盖矩阵。'), { statusCode: 400 });
    }
    const assets = await db.prepare(`SELECT kind, name, page_path, source_file, source_line, snippet FROM demo_assets
    WHERE library_id = ? AND library_version = ?`).all(libraryId, version);
    const matrix = await db.prepare('SELECT symbol_id, status, risk_flags, evidence_json FROM coverage_matrix WHERE library_id = ?')
        .all(libraryId);
    const matrixBySymbol = new Map(matrix.map((m) => [m.symbol_id, m]));
    const plans = [];
    const perSymbol = [];
    const skippedSymbols = [];
    for (const s of symbolRows) {
        const name = String(s.name);
        const symbolId = Number(s.id);
        const calls = assets.filter((a) => a.name === name && (a.kind === 'call' || a.kind === 'test_call'));
        const demoCalls = calls.filter((a) => a.kind === 'call').map((a) => ({
            pagePath: a.page_path, sourceFile: a.source_file, sourceLine: a.source_line, snippet: a.snippet,
        }));
        const evidence = matrixBySymbol.get(symbolId);
        const ev = evidence ? JSON.parse(evidence.evidence_json || '{}') : {};
        const kind = String(s.kind);
        // 不可测的符号不进用例生成（P3 已判定 blocked：类型没有运行时行为、废弃接口不再补）
        const matrixRow = evidence;
        if (matrixRow?.status === 'blocked') {
            skippedSymbols.push({ name, kind, reason: `覆盖矩阵判定为「不可测」：${kind === 'type' || kind === 'interface' ? '类型/接口无运行时行为' : '接口已废弃'}` });
            continue;
        }
        const input = {
            id: symbolId, name, kind, signature: String(s.signature ?? ''),
            detailLevel: String(s.detail_level ?? 'name-only'), deprecated: Number(s.deprecated ?? 0) === 1,
            params: JSON.parse(String(s.params_json || '[]')),
            returns: JSON.parse(String(s.returns_json || '{}')),
            throws: JSON.parse(String(s.throws_json || '[]')),
            methods: JSON.parse(String(s.methods_json || '[]')),
            demoCalls,
            testCallCount: calls.filter((a) => a.kind === 'test_call').length,
            deviceControls: ev.deviceControls ?? [],
            paramPoints: ev.paramPoints ?? [],
        };
        const applicability = computeApplicability(input);
        const negExtra = computeNegExtra(input);
        const triggers = computeTriggers(input).length;
        const rows = planSymbolCases(input, opts);
        plans.push(...rows);
        perSymbol.push({ symbolId, name, kind, applicability, negExtra, triggers, planned: rows.length, scenarios: [...new Set(rows.map((r) => r.scenario))] });
    }
    return {
        libraryId, version, plans, perSymbol,
        summary: {
            symbols: perSymbol.length,
            skippedSymbols,
            ...summarizePlans(perSymbol, plans),
        },
    };
}
/**
 * 显式抽样：计划条数超过预算时，**报出被裁掉多少、为什么**。
 * 绝不静默截断 —— 修复记录里同类问题（静默少几行/少几条）是明确教训。
 */
export function samplePlan(plans, budget) {
    if (budget <= 0 || plans.length <= budget) {
        return { selected: plans, skipped: [], report: `共 ${plans.length} 条，预算 ${budget <= 0 ? '不限' : budget} 条，全部纳入` };
    }
    // 按优先级保留：P0 全覆盖，其次 P1，最后 P2
    const rank = { P0: 0, P1: 1, P2: 2 };
    const sorted = [...plans].sort((a, b) => rank[a.priority] - rank[b.priority]);
    const selected = sorted.slice(0, budget);
    const skipped = sorted.slice(budget);
    const kept = new Set(selected);
    const byPrio = {};
    for (const s of skipped)
        byPrio[s.priority] = (byPrio[s.priority] ?? 0) + 1;
    return {
        selected: plans.filter((p) => kept.has(p)),
        skipped,
        report: `共 ${plans.length} 条，预算 ${budget} 条：执行 ${selected.length} 条，未执行 ${skipped.length} 条（${Object.entries(byPrio).map(([k, v]) => `${k} ${v}`).join('、')}）—— 按优先级裁剪，P0 全部保留`,
    };
}
