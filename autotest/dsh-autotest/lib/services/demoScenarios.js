// 场景级覆盖度（Demo 场景 × Demo 代码）—— 把 ohos-demo-coverage-analyzer / ohos-demo-scenario-generator
// 两个技能的产物变成平台里可查、可算、可入库的一等公民。
//
// 为什么要单独一层，而不是并进 coverageMatrix：
//   coverageMatrix 回答的是「**接口**有没有 demo/用例」（行 = 导出符号），
//   它回答的是「**场景**有没有被 demo 覆盖」（行 = 场景 P01/N07…），
//   两者分母不同、结论也可能互相矛盾 —— 例如 json-schema 的 P11（规则增删）在接口维度"有调用点"，
//   但流程一步都没执行，接口维度看不出来，场景维度一眼可见。
//
// 设计纪律（与项目其它层一致）：
//   1. **md 是唯一事实来源**：场景清单 `{库}Demo场景.md` 与分析结论 `{库}Demo场景覆盖率报告.md`
//      都是人可读可改的文本；DB 表只是索引/快照，随时可由 md 重建（不双写）。
//   2. **纯规则层**：解析与统计都是纯函数，可离线自检（scripts/verify-demo-scenarios.mjs）。
//   3. **不猜**：解析器遇到不认识的结构就产出 warning（而不是静默给 0 或默认值）；
//      交叉核对不上时报出来（场景/结论必须一一对应）。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { workspaceDir } from './gitRepo.js';
export const STATUS_LABEL = {
    covered: '完全覆盖', partial: '部分覆盖', uncovered: '未覆盖',
};
// ---------- 1. 纯解析：场景清单 ----------
const STATUS_FROM_MARK = {
    '✅': 'covered', '🔶': 'partial', '❌': 'uncovered',
};
/** 状态列 → 枚举。认不出返回 null（调用方必须报 warning，不许默认）。 */
export function parseStatus(mark) {
    const t = String(mark ?? '').trim();
    if (STATUS_FROM_MARK[t])
        return STATUS_FROM_MARK[t];
    // 容忍 "✅ 完全覆盖" / "partial" 这类写法
    if (/完全覆盖|covered$/i.test(t) && !/未|not/i.test(t))
        return 'covered';
    if (/部分覆盖|partial/i.test(t))
        return 'partial';
    if (/未覆盖|not_covered|uncovered/i.test(t))
        return 'uncovered';
    return null;
}
/** `2/2 (100%)` / `0/4 (0%)` → {covered:2,total:2}；解析失败返回 null。 */
export function parseRatio(cell) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(cell ?? ''));
    if (!m)
        return null;
    return { covered: Number(m[1]), total: Number(m[2]) };
}
/** 把 markdown 表格行拆成单元格（去掉首尾空管道，保留单元格内的 `|` 转义场景由调用方处理）。 */
export function splitRow(line) {
    const t = String(line).trim();
    if (!t.startsWith('|'))
        return [];
    const parts = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
    return parts.map((p) => p.trim());
}
function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}
/** 从 `#### P01 名字` 这类标题里取编号与名字。 */
export function parseScenarioHeading(text) {
    const m = /^#{2,6}\s*([PN]\d{1,3})\s*[.、·:：]?\s*(.+?)\s*$/.exec(String(text ?? '').trim());
    if (!m)
        return null;
    return { no: m[1], name: m[2].replace(/[（(]\s*$/, '').trim() };
}
/** 从一句功能点里取 `对应接口：`xxx()`、`yyy`` 中的所有反引号片段，规整成接口名。 */
export function extractInterfaces(line) {
    const out = [];
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(String(line ?? '')))) {
        const raw = m[1];
        // 去掉调用括号与参数：`Validator.validate(instance, schema)` → Validator.validate
        let name = raw.replace(/\(.*$/s, '').trim();
        name = name.replace(/\s+/g, '');
        if (!name)
            continue;
        // 只保留像接口名的：含字母，且不是纯中文说明
        if (!/[A-Za-z]/.test(name))
            continue;
        out.push(name);
    }
    return out;
}
/** 只有一个反引号片段的「接口名归一」：`new Validator()` → Validator；`Validator.validate()` → Validator.validate。 */
export function normalizeApi(raw) {
    let s = String(raw ?? '').trim();
    // 注意顺序：extractInterfaces 里已经做过 `\s+` 折叠，所以这里要容忍 `newValidator` 这种形态，
    // 只在后面紧跟大写字母时才认定它是构造调用前缀（避免误伤 newXxx 这类真实符号名）。
    s = s.replace(/^new\s*(?=[A-Z])/, '');
    s = s.replace(/\(.*$/s, '');
    s = s.replace(/\s+/g, '');
    // `Validator.prototype.customFormats.<name>` → Validator.prototype.customFormats
    s = s.replace(/\.<[^>]*>$/, '');
    // `Options.rewrite` → rewrite？保留原样更可追溯，这里不动
    return s;
}
export function parseScenarioList(md) {
    const warnings = [];
    const lines = String(md ?? '').split(/\r?\n/);
    // ---- 功能模块映射表 ----
    const moduleMap = [];
    const noRe = /\b([PN]\d{1,3})\b/g;
    const collectNos = (cell) => {
        const out = [];
        let m;
        while ((m = noRe.exec(cell)))
            out.push(m[1]);
        noRe.lastIndex = 0;
        return out;
    };
    let inModuleTable = false;
    for (const line of lines) {
        if (/^#{2,6}\s*功能模块映射/.test(line)) {
            inModuleTable = true;
            continue;
        }
        if (inModuleTable && /^#{2,6}\s/.test(line)) {
            inModuleTable = false;
        }
        if (!inModuleTable)
            continue;
        const cells = splitRow(line);
        if (cells.length < 4 || isSeparatorRow(cells))
            continue;
        if (/^模块$/.test(cells[0]))
            continue;
        moduleMap.push({
            module: cells[0],
            apis: extractInterfaces(cells[1]).map(normalizeApi),
            positive: collectNos(cells[2]),
            negative: collectNos(cells[3]),
        });
    }
    if (moduleMap.length === 0)
        warnings.push('场景清单里没有解析到「功能模块映射」表（模块统计会为空）');
    // ---- 场景块 ----
    const scenarios = [];
    // 映射表是**多对多**的（同一个场景可能同时列在多个模块行下），所以它不能单独决定归属。
    // 归属以场景块里的 `**模块**：X` 行为准；没有该行时才退回映射表，且多命中必须告警（不许静默选一个）。
    const moduleHits = new Map();
    for (const m of moduleMap) {
        for (const no of [...m.positive, ...m.negative]) {
            const list = moduleHits.get(no) ?? [];
            if (!list.includes(m.module))
                list.push(m.module);
            moduleHits.set(no, list);
        }
    }
    let cur = null;
    let curKindFromText = null;
    let curModuleExplicit = false;
    let inApis = false;
    const push = () => {
        if (!cur)
            return;
        if (!curKindFromText)
            warnings.push(`场景 ${cur.no} 缺少「场景类型」行，按编号前缀推断：${cur.kind === 'negative' ? '反向' : '正向'}`);
        if (cur.interfaces.length === 0)
            warnings.push(`场景 ${cur.no} 的「场景涉及的功能点」里没有解析到接口（接口覆盖率会算不出来）`);
        const hits = moduleHits.get(cur.no) ?? [];
        if (curModuleExplicit) {
            if (hits.length > 0 && !hits.includes(cur.module)) {
                warnings.push(`场景 ${cur.no} 的「模块」声明（${cur.module}）与功能模块映射表（${hits.join('/')}）不一致`);
            }
        }
        else if (hits.length === 0) {
            warnings.push(`场景 ${cur.no} 没有模块归属：建议在场景块里加一行 \`**模块**：<模块名>\`（映射表里也没有它）`);
        }
        else {
            if (hits.length > 1) {
                warnings.push(`场景 ${cur.no} 在功能模块映射表里出现在多个模块（${hits.join('/')}），已按最后一个归入「${hits[hits.length - 1]}」；建议在场景块里显式写 \`**模块**：\``);
            }
            cur.module = hits[hits.length - 1];
        }
        scenarios.push(cur);
    };
    for (const line of lines) {
        const head = parseScenarioHeading(line);
        if (head) {
            push();
            const hits = moduleHits.get(head.no) ?? [];
            cur = {
                no: head.no, name: head.name,
                kind: head.no.startsWith('N') ? 'negative' : 'positive',
                module: hits.length > 0 ? hits[hits.length - 1] : '', interfaces: [],
            };
            curKindFromText = null;
            curModuleExplicit = false;
            inApis = false;
            continue;
        }
        if (!cur)
            continue;
        const typeMatch = /^\*\*场景类型\*\*\s*[:：]\s*(\S+)/.exec(line.trim());
        if (typeMatch) {
            curKindFromText = /反向|negative/i.test(typeMatch[1]) ? 'negative' : 'positive';
            cur.kind = curKindFromText;
            continue;
        }
        const moduleMatch = /^\*\*模块\*\*\s*[:：]\s*(.+?)\s*$/.exec(line.trim());
        if (moduleMatch) {
            cur.module = moduleMatch[1];
            curModuleExplicit = true;
            continue;
        }
        if (/^\*\*场景涉及的功能点\*\*/.test(line.trim())) {
            inApis = true;
            continue;
        }
        if (inApis) {
            if (/^\*\*|^#{2,6}\s/.test(line.trim())) {
                inApis = false;
                continue;
            }
            if (/^[-*]\s/.test(line.trim()) && /对应接口/.test(line)) {
                for (const api of extractInterfaces(line).map(normalizeApi)) {
                    if (!cur.interfaces.includes(api))
                        cur.interfaces.push(api);
                }
            }
        }
    }
    push();
    if (scenarios.length === 0)
        warnings.push('场景清单里没有解析到任何 `#### P01 ...` 形式的场景标题');
    const seen = new Set();
    for (const s of scenarios) {
        if (seen.has(s.no))
            warnings.push(`场景编号重复：${s.no}`);
        seen.add(s.no);
    }
    return { scenarios, moduleMap, warnings };
}
// ---------- 2. 纯解析：覆盖率报告 ----------
export function parseCoverageReport(md) {
    const warnings = [];
    const lines = String(md ?? '').split(/\r?\n/);
    const judgements = [];
    const interfaces = [];
    let mode = 'none';
    let baselineNote = null;
    for (const line of lines) {
        if (/^#{2,6}\s*(正向场景覆盖|反向场景覆盖)/.test(line)) {
            mode = 'scenario';
            continue;
        }
        if (/^#{2,6}\s*接口维度逐条核对/.test(line)) {
            mode = 'interface';
            continue;
        }
        if (/^#{2,6}\s/.test(line) && mode !== 'none') {
            // 场景覆盖表结束后进入别的章节；接口表只在它自己那节里认
            if (mode === 'interface')
                mode = 'none';
        }
        if (/^\s*>\s*基线 Demo/.test(line) || /\*\*基线 Demo（用户仓库/.test(line))
            baselineNote = line.trim();
        const cells = splitRow(line);
        if (cells.length < 3 || isSeparatorRow(cells))
            continue;
        if (mode === 'scenario') {
            const no = /^([PN]\d{1,3})$/.exec(cells[0]);
            if (!no)
                continue;
            const status = parseStatus(cells[2]);
            if (!status) {
                warnings.push(`覆盖率报告里场景 ${cells[0]} 的覆盖状态列无法识别：${cells[2]}`);
                continue;
            }
            const ratio = parseRatio(cells[3] ?? '');
            if (!ratio)
                warnings.push(`场景 ${cells[0]} 的接口覆盖率列无法解析：${cells[3] ?? ''}`);
            judgements.push({
                no: cells[0], name: cells[1] ?? '', status,
                apiCovered: ratio?.covered ?? 0, apiTotal: ratio?.total ?? 0,
                evidence: cells[4] ?? '', gap: cells[5] ?? '',
            });
            continue;
        }
        if (mode === 'interface') {
            const apiCell = cells[0] ?? '';
            if (/^(接口|选项)/.test(apiCell) || /接口 \/ 选项/.test(apiCell))
                continue;
            const api = extractInterfaces(apiCell).map(normalizeApi)[0] ?? normalizeApi(apiCell);
            if (!api || !/[A-Za-z]/.test(api))
                continue;
            const verdictCell = (cells[1] ?? '').trim();
            const verdict = verdictCell.startsWith('✅') ? 'executed'
                : verdictCell.startsWith('❌') ? 'missing' : verdictCell.startsWith('⚠') ? 'conditional' : 'conditional';
            if (!verdictCell.startsWith('✅') && !verdictCell.startsWith('❌') && !verdictCell.startsWith('⚠')) {
                warnings.push(`接口逐条核对里 ${api} 的判定列无法识别：${verdictCell}`);
            }
            interfaces.push({ api, verdict, evidence: cells[2] ?? '' });
        }
    }
    if (judgements.length === 0)
        warnings.push('覆盖率报告里没有解析到「场景覆盖详情」表（无法得到任何场景结论）');
    if (interfaces.length === 0)
        warnings.push('覆盖率报告里没有解析到「接口维度逐条核对」表（接口维度数字会为空）');
    return { judgements, interfaces, warnings, baselineNote };
}
// ---------- 3. 纯计算：合并 + 自洽核对 + 统计 ----------
/**
 * 合并场景清单与覆盖率报告。
 * 交叉核对（任何一条都进 warnings，不静默）：
 *   - 场景清单有、报告没有结论 → 缺结论
 *   - 报告有结论、清单里没有该场景 → 结论悬空
 *   - 名称不一致 → 报出来（两边可能有一处过期）
 *   - ✅ 但接口覆盖率 < 100% / ❌ 但接口覆盖率 > 0 → 状态与证据不一致，需要 gap 解释
 */
export function mergeScenarioCoverage(scenarioMd, reportMd) {
    const list = parseScenarioList(scenarioMd);
    const rep = parseCoverageReport(reportMd);
    const warnings = [...list.warnings, ...rep.warnings];
    const byNo = new Map(rep.judgements.map((j) => [j.no, j]));
    const rows = [];
    const notes = [];
    for (const s of list.scenarios) {
        const j = byNo.get(s.no);
        if (!j) {
            warnings.push(`场景 ${s.no}（${s.name}）在覆盖率报告里没有结论`);
            rows.push({ ...s, status: 'uncovered', apiCovered: 0, apiTotal: s.interfaces.length, evidence: '', gap: '覆盖率报告缺少该场景的结论行', note: '' });
            continue;
        }
        const note = [];
        if (s.name && j.name && !j.name.includes(s.name.slice(0, 4)) && !s.name.includes(j.name.slice(0, 4))) {
            warnings.push(`场景 ${s.no} 的名称在清单与报告里不一致：清单「${s.name}」/ 报告「${j.name}」`);
            note.push('名称不一致');
        }
        if (j.status === 'covered' && j.apiTotal > 0 && j.apiCovered < j.apiTotal) {
            warnings.push(`场景 ${s.no} 判为完全覆盖但接口覆盖率只有 ${j.apiCovered}/${j.apiTotal}`);
            note.push('结论=完全覆盖 与 接口覆盖率<100% 矛盾');
        }
        if (j.status === 'uncovered' && j.apiCovered > 0) {
            // "接口有调用点但整体判未覆盖"是允许的（例如代码里有调用但流程永不执行），
            // 但**必须**在差距说明里解释清楚；没解释才报警——告警只留真正待处理的。
            const explained = (j.gap ?? '').trim().length >= 8 && !/^[—\-–]+$/.test((j.gap ?? '').trim());
            if (explained) {
                note.push('结论=未覆盖 但接口列显示有调用（差距说明里已解释）');
            }
            else {
                warnings.push(`场景 ${s.no} 判为未覆盖但接口覆盖率是 ${j.apiCovered}/${j.apiTotal}，且没有差距说明来解释"有调用为什么不算覆盖"`);
                note.push('结论=未覆盖 但接口列显示有调用，缺少解释');
            }
        }
        rows.push({
            ...s,
            status: j.status,
            apiCovered: j.apiCovered,
            apiTotal: j.apiTotal || s.interfaces.length,
            evidence: j.evidence,
            gap: j.gap,
            note: note.join('；'),
        });
    }
    for (const j of rep.judgements) {
        if (!list.scenarios.some((s) => s.no === j.no)) {
            warnings.push(`覆盖率报告里的场景 ${j.no} 在场景清单里不存在（结论悬空）`);
        }
    }
    if (notes.length > 0)
        warnings.push(`共 ${notes.length} 条结论与证据不一致，已写入对应行的 note`);
    const summary = summarizeScenarioCoverage(rows, rep.interfaces, list.moduleMap);
    return { rows, summary, warnings, modules: list.moduleMap };
}
export function summarizeScenarioCoverage(rows, interfaces, modules = []) {
    const total = rows.length;
    const covered = rows.filter((r) => r.status === 'covered').length;
    const partial = rows.filter((r) => r.status === 'partial').length;
    const uncovered = rows.filter((r) => r.status === 'uncovered').length;
    const positive = rows.filter((r) => r.kind === 'positive');
    const negative = rows.filter((r) => r.kind === 'negative');
    const rate = (list) => (list.length === 0 ? 0
        : Math.round(((list.filter((r) => r.status === 'covered').length + list.filter((r) => r.status === 'partial').length * 0.5) / list.length) * 1000) / 10);
    const byModule = [];
    const moduleNames = [...new Set([...modules.map((m) => m.module), ...rows.map((r) => r.module)])].filter(Boolean);
    for (const name of moduleNames) {
        const list = rows.filter((r) => r.module === name);
        if (list.length === 0)
            continue;
        byModule.push({
            module: name, total: list.length,
            covered: list.filter((r) => r.status === 'covered').length,
            partial: list.filter((r) => r.status === 'partial').length,
            uncovered: list.filter((r) => r.status === 'uncovered').length,
            rate: rate(list),
        });
    }
    const apiExecuted = interfaces.filter((i) => i.verdict === 'executed').length;
    const apiConditional = interfaces.filter((i) => i.verdict === 'conditional').length;
    const apiMissing = interfaces.filter((i) => i.verdict === 'missing').length;
    const byStatusEvidence = {};
    for (const r of rows) {
        const key = r.evidence && r.evidence !== '—' ? '有匹配文件' : '无匹配文件';
        byStatusEvidence[key] = (byStatusEvidence[key] ?? 0) + 1;
    }
    return {
        total, covered, partial, uncovered,
        positive: positive.length, negative: negative.length,
        overall: rate(rows), positiveRate: rate(positive), negativeRate: rate(negative),
        apiExecuted, apiConditional, apiMissing,
        apiRate: interfaces.length === 0 ? 0 : Math.round(((apiExecuted + apiConditional * 0.5) / interfaces.length) * 1000) / 10,
        byModule, byStatusEvidence,
    };
}
/** 场景覆盖度 markdown（导出给人工评审 / 归档，与矩阵导出同风格）。 */
export function renderScenarioCoverageMarkdown(libName, rows, summary, warnings, sources) {
    const out = [];
    out.push(`# ${libName} · Demo 场景覆盖度`);
    out.push('');
    out.push(`- 场景清单：\`${sources.scenarioDoc}\``);
    out.push(`- 分析结论：\`${sources.reportDoc}\``);
    out.push(`- 场景总数 ${summary.total}（正向 ${summary.positive} / 反向 ${summary.negative}）`);
    out.push(`- ✅ ${summary.covered} · 🔶 ${summary.partial} · ❌ ${summary.uncovered} → 整体覆盖率 **${summary.overall}%**`);
    out.push(`- 正向 ${summary.positiveRate}% · 反向 ${summary.negativeRate}%`);
    out.push(`- 接口维度：真实执行 ${summary.apiExecuted} · 有条件/未生效 ${summary.apiConditional} · 零调用 ${summary.apiMissing} → **${summary.apiRate}%**`);
    out.push('');
    out.push('| 编号 | 场景 | 类型 | 模块 | 状态 | 接口覆盖率 | 匹配文件 | 差距说明 |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
        out.push(`| ${r.no} | ${r.name} | ${r.kind === 'negative' ? '反向' : '正向'} | ${r.module} | ${STATUS_LABEL[r.status]} | ${r.apiCovered}/${r.apiTotal} | ${r.evidence || '—'} | ${r.gap || '—'} |`);
    }
    if (summary.byModule.length > 0) {
        out.push('');
        out.push('## 模块覆盖');
        out.push('');
        out.push('| 模块 | 场景数 | ✅ | 🔶 | ❌ | 覆盖率 |');
        out.push('|---|---|---|---|---|---|');
        for (const m of summary.byModule) {
            out.push(`| ${m.module} | ${m.total} | ${m.covered} | ${m.partial} | ${m.uncovered} | ${m.rate}% |`);
        }
    }
    if (warnings.length > 0) {
        out.push('');
        out.push('## 自洽核对告警（必须处理，否则数字不可信）');
        out.push('');
        for (const w of warnings)
            out.push(`- ${w}`);
    }
    return out.join('\n') + '\n';
}
// ---------- 4. IO：与 workspace 的 md 对接 + 落库 ----------
export function scenarioDocPaths(libName) {
    const dir = path.join(workspaceDir(), 'coverage', libName.replace(/[^\w.-]/g, '_'));
    return { dir, scenarioDoc: path.join(dir, `${libName}Demo场景.md`), reportDoc: path.join(dir, `${libName}Demo场景覆盖率报告.md`) };
}
export function readScenarioDocs(libName) {
    const p = scenarioDocPaths(libName);
    const missing = [];
    let scenarioMd = '';
    let reportMd = '';
    if (fs.existsSync(p.scenarioDoc))
        scenarioMd = fs.readFileSync(p.scenarioDoc, 'utf8');
    else
        missing.push(p.scenarioDoc);
    if (fs.existsSync(p.reportDoc))
        reportMd = fs.readFileSync(p.reportDoc, 'utf8');
    else
        missing.push(p.reportDoc);
    return { scenarioMd, reportMd, missing };
}
/** 只读计算（不落库）：解析两份 md → 合并 → 统计。 */
export async function loadScenarioCoverage(libraryId) {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId);
    if (!lib)
        throw Object.assign(new Error('库不存在'), { statusCode: 404 });
    const { scenarioMd, reportMd, missing } = readScenarioDocs(lib.name);
    const paths = scenarioDocPaths(lib.name);
    const sources = { scenarioDoc: paths.scenarioDoc, reportDoc: paths.reportDoc };
    if (missing.length > 0) {
        return {
            libraryId, libraryName: lib.name, sources, missing, rows: 0,
            summary: summarizeScenarioCoverage([], [], []), warnings: [`缺少产出文档：${missing.join('；')}`], scenarios: [],
        };
    }
    const merged = mergeScenarioCoverage(scenarioMd, reportMd);
    return {
        libraryId, libraryName: lib.name, sources, missing: [], rows: merged.rows.length,
        summary: merged.summary, warnings: merged.warnings, scenarios: merged.rows,
    };
}
/** 解析 + 落库（快照；md 仍是唯一事实来源，随时可重建）。 */
export async function syncScenarioCoverage(libraryId) {
    const r = await loadScenarioCoverage(libraryId);
    if (r.missing.length > 0 || r.rows === 0)
        return r;
    const db = getDb();
    const version = (await db.prepare('SELECT current_version FROM libraries WHERE id = ?')
        .get(libraryId))?.current_version ?? '';
    const t = now();
    await db.transaction(async () => {
        await db.prepare('DELETE FROM demo_scenario_coverage WHERE library_id = ?').run(libraryId);
        for (const s of r.scenarios) {
            await db.prepare(`INSERT INTO demo_scenario_coverage
        (library_id, library_version, scenario_no, name, kind, module, status, api_covered, api_total,
         evidence, gap, note, scenario_doc, report_doc, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(libraryId, version, s.no, s.name, s.kind, s.module, s.status, s.apiCovered, s.apiTotal, s.evidence.slice(0, 500), s.gap.slice(0, 500), s.note.slice(0, 300), r.sources.scenarioDoc, r.sources.reportDoc, t, t);
        }
    });
    return r;
}
/** 读快照（列表页/首页 KPI 用；没有快照时返回空而不是报错）。 */
export async function readScenarioCoverageSnapshot(libraryId) {
    const db = getDb();
    const rows = await db.prepare(`SELECT * FROM demo_scenario_coverage WHERE library_id = ? ORDER BY scenario_no`)
        .all(libraryId);
    const mapped = rows.map((r) => ({
        no: String(r.scenario_no), name: String(r.name),
        kind: String(r.kind) === 'negative' ? 'negative' : 'positive',
        module: String(r.module ?? ''), interfaces: [],
        status: String(r.status),
        apiCovered: Number(r.api_covered ?? 0), apiTotal: Number(r.api_total ?? 0),
        evidence: String(r.evidence ?? ''), gap: String(r.gap ?? ''), note: String(r.note ?? ''),
    }));
    return {
        version: String(rows[0]?.library_version ?? ''),
        summary: summarizeScenarioCoverage(mapped, []),
        rows: mapped.length,
        updatedAt: String(rows[0]?.updated_at ?? ''),
    };
}
