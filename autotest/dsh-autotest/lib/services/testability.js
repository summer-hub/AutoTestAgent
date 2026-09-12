// P5：demo 可测性判定与改造方案（设计 §6.5，标了 ★ 的一环）。
//
// 目标：**每条用例必须先回答"现在能不能跑、不能跑要怎么改"**。
// 一条"设计得很漂亮但真机上根本触发不到"的用例，比没有用例更浪费 —— 它会被当成覆盖。
//
// 四类判定（确定性规则，可离线单测）：
//   A 开箱可测：demo 有入口控件，输入走默认值/UI 即可 → 直接生成脚本
//   B 改参数可测：demo 里有可改的字面量/常量 → 产出**参数替换补丁**（最小 diff）
//   C 需改代码：demo 没调用、或没有控件/参数入口 → 产出代码补丁草案
//   D 无法测：外部依赖、媒体人工判定、物理操作、超长时运行 → 进人工队列
//
// 两条安全纪律（踩过的坑都在这里）：
//   1. 补丁**只在独立副本上应用**（workspace/demo-patches/<lib>/<caseNo>/），绝不改用户仓库；
//   2. 应用前必须校验 `before` 与文件当前内容一致 —— 代码已经变了还硬替换，等于悄悄改坏了别人的工程。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { workspaceDir } from './gitRepo.js';
export const CLASS_LABEL = {
    A: '开箱可测', B: '改参数可测', C: '需改代码', D: '无法测',
};
// ---------- 1. D 类信号（外部依赖 / 人工判定 / 超长时） ----------
/** 需要外部依赖或人工判定的信号词。只在这些**明确**信号出现时才判 D，不做泛化猜测。 */
const EXTERNAL_SIGNALS = [
    { re: /(数据库|database|mysql|redis|sqlite|mongodb)/i, label: '需要外部数据库' },
    { re: /(服务器|server|http|https|网络请求|接口请求|api\s*地址|上传|下载文件)/i, label: '需要外部服务/网络' },
    { re: /(蓝牙|bluetooth|nfc|红外|usb|串口)/i, label: '需要外部硬件' },
    { re: /(相机|摄像头|camera|麦克风|录音|定位|gps|扫码)/i, label: '需要设备能力且常需人工配合' },
    { re: /(另一台|其他设备|配对设备|跨设备|分布式)/i, label: '需要第二台设备' },
    { re: /(人工判定|肉眼|目视|主观|听感|音质|画质)/i, label: '需要人工判定' },
    { re: /(插拔|物理|旋转机身|摇晃|遮挡|息屏)/i, label: '需要物理操作' },
];
const LONG_RUN_RE = /(连续.{0,6}(分钟|小时)|长时间|30\s*分钟|1\s*小时|压测\s*\d+\s*(分钟|小时))/;
/**
 * 是否为 D 类（无法测）。
 * 这是**唯一允许"拒测"的出口**，所以判定必须有明确信号词并写出来源，
 * 否则就成了"不想测就判 D"的后门。
 */
export function detectUntestable(c, sym) {
    const text = [c.name, c.expected, ...c.steps, sym.signature].join('\n');
    const reasons = [];
    for (const s of EXTERNAL_SIGNALS)
        if (s.re.test(text))
            reasons.push(s.label);
    if (LONG_RUN_RE.test(text))
        reasons.push('用例要求超长时运行（≥10 分钟），不适合放进常规回归');
    return { isD: reasons.length > 0, reasons };
}
// ---------- 2. 用例需要的输入 ----------
/** 从场景维度推出"这条用例需要构造什么输入"，用于判断 demo 现有入口能否满足。 */
export function requiredInputsOf(c, sym) {
    const params = sym.params.map((p) => p.name);
    switch (c.scenarioKind) {
        case 'happy':
            return params.length > 0 ? [`${params.join('/')} 的合法取值（可用 demo 现有值）`] : ['无需构造输入（走默认行为）'];
        case 'empty':
            return params.length > 0
                ? params.filter((_, i) => sym.params[i]?.optional).concat(params).slice(0, 4).map((n) => `${n} 置空（'' / [] / {} / null / 不传）`)
                : ['在未初始化/空状态下调用'];
        case 'boundary':
            return [sym.throws.length > 0
                    ? `触发声明异常 ${sym.throws.map((t) => t.type || 'Error').join('/')} 的非法输入`
                    : '越界值 / 类型错误 / 重复调用 / 逆序调用'];
        case 'bigdata':
            return ['放大量级输入（大数组 / 长字符串 / 大对象 / 长时长）'];
        default:
            return [];
    }
}
// ---------- 3. 判定 ----------
/**
 * 从用例步骤里抽出被引用的控件文本（真机句式：点击「X」/输入「X」到「Y」/验证「X」）。
 * 这是"这条用例在真机上点得到吗"的唯一直接依据。
 */
export function referencedControls(steps) {
    const out = [];
    for (const s of steps) {
        for (const m of s.matchAll(/[点击输入验证等待滑动]{0,2}「([^」]{1,40})」/g)) {
            const t = m[1].trim();
            if (t && !out.includes(t))
                out.push(t);
        }
    }
    return out;
}
export function classifyCase(c, sym, demo) {
    const evidence = [];
    const requiredInputs = sym ? requiredInputsOf(c, sym) : ['（用例未关联接口符号，按步骤内容判定）'];
    const first = demo.demoCalls[0];
    const triggerPage = first?.pagePath ?? '';
    const triggerControl = demo.deviceControls.find((t) => /验证|运行|执行|开始|播放|测试|提交|确定|应用/.test(t)) ?? demo.deviceControls[0] ?? '';
    // D：无法测（外部依赖 / 人工判定 / 超长时）—— 只认明确信号词，不做泛化猜测
    const d = detectUntestable(c, sym ?? { id: 0, name: '', kind: '', signature: '', params: [], returns: { type: '', doc: '' }, throws: [], methods: [] });
    if (d.isD) {
        evidence.push(...d.reasons.map((r) => `信号：${r}`));
        return { class: 'D', reason: `无法测：${d.reasons.join('；')}`, evidence, requiredInputs, triggerPage, triggerControl };
    }
    // 用例引用的控件 vs 真机上真实存在的控件 —— 这一步对**所有**用例都做，
    // 包括没有关联接口符号的历史用例（否则"100% 用例带判定"就只是对新建用例成立）
    const used = referencedControls(c.steps);
    const missing = used.filter((u) => !demo.deviceControls.some((k) => k === u || k.includes(u) || u.includes(k)));
    if (used.length > 0) {
        evidence.push(`用例引用控件 ${used.length} 个：${used.slice(0, 5).join(' / ')}`);
        if (missing.length > 0)
            evidence.push(`真机上未找到：${missing.join(' / ')}`);
    }
    if (!sym) {
        // 未关联接口符号：只能按"步骤里的控件在真机上是否存在"判定
        if (demo.deviceControls.length === 0) {
            evidence.push('没有该库的真机遍历控件清单');
            return { class: 'C', reason: '用例未关联接口符号，且没有真机遍历控件可核对，需要人工确认入口', evidence, requiredInputs, triggerPage, triggerControl };
        }
        if (used.length > 0 && missing.length === 0) {
            return { class: 'A', reason: '用例引用的控件在真机上全部存在，可直接执行', evidence, requiredInputs, triggerPage, triggerControl };
        }
        if (missing.length > 0) {
            return {
                class: 'C',
                reason: `用例引用的 ${missing.length} 个控件在真机上不存在（${missing.slice(0, 3).join('、')}），需要改 demo 或改用例`,
                evidence, requiredInputs, triggerPage, triggerControl,
            };
        }
        return { class: 'B', reason: '用例未引用具体控件文本，需要在 demo 里指定输入入口', evidence, requiredInputs, triggerPage, triggerControl };
    }
    // C：demo 里没有调用点 —— 没有任何入口，必须改代码
    if (demo.demoCalls.length === 0) {
        evidence.push(`demo（src/main）中没有 ${sym.name} 的调用点`);
        if (demo.testCallCount > 0)
            evidence.push(`仅单元测试调用 ${demo.testCallCount} 处（真机路径仍不可达）`);
        return {
            class: 'C',
            reason: `demo 未调用 ${sym.name}，真机上无法触发，需要新增调用入口（必要时新增控件）`,
            evidence, requiredInputs, triggerPage, triggerControl,
        };
    }
    evidence.push(`demo 调用点：${first.sourceFile}:${first.sourceLine}（页面 ${triggerPage || '未知'}）`);
    // C：有调用但该页面在真机上没有可交互控件 —— 触达不了
    if (demo.deviceControls.length === 0) {
        evidence.push('真机遍历在该页面没有找到可交互控件');
        return {
            class: 'C',
            reason: 'demo 有调用但对应页面在真机上没有可点控件，需要新增控件才能触发',
            evidence, requiredInputs, triggerPage, triggerControl,
        };
    }
    evidence.push(`真机控件：${demo.deviceControls.slice(0, 5).join(' / ')}`);
    // 用例引用了真机上不存在的控件 → 先解决入口，再谈场景
    if (missing.length > 0) {
        return {
            class: 'C',
            reason: `用例引用的控件在真机上不存在（${missing.slice(0, 3).join('、')}），需要改 demo 新增控件或改用例`,
            evidence, requiredInputs, triggerPage, triggerControl,
        };
    }
    // A：正向场景，走 demo 现有输入/默认值即可
    if (c.scenarioKind === 'happy') {
        return {
            class: 'A',
            reason: 'demo 有入口控件且正向输入可由现有值/默认值满足，可直接生成脚本',
            evidence, requiredInputs, triggerPage, triggerControl,
        };
    }
    // B：负向/大数据场景 —— 页面上有可改的字面量就能靠改参数做到
    const points = demo.paramPoints.filter((p) => !triggerPage || p.pagePath === triggerPage);
    if (points.length > 0) {
        evidence.push(`可改数据点：${points.slice(0, 4).map((p) => `${p.name}@${p.sourceFile}:${p.sourceLine}`).join(' , ')}`);
        return {
            class: 'B',
            reason: `${c.scenarioKind === 'bigdata' ? '大数据' : '负向'}场景的输入可通过修改 demo 中的字面量满足（无需改结构）`,
            evidence, requiredInputs, triggerPage, triggerControl,
        };
    }
    evidence.push('该页面上没有找到可注入的数据点（@State 等字面量）');
    return {
        class: 'C',
        reason: 'demo 有调用与控件，但页面没有可注入的数据点，需要改代码才能构造该场景的输入',
        evidence, requiredInputs, triggerPage, triggerControl,
    };
}
// ---------- 4. 补丁草案生成 ----------
/** 场景 → 把现有字面量改成什么值（B 类补丁的核心）。 */
export function scenarioValueFor(scenario, current) {
    switch (scenario) {
        case 'empty':
            return { value: current.trim().startsWith('[') ? '[]' : "''", note: '置空以覆盖空值场景' };
        case 'boundary':
            return { value: current.trim().startsWith('[') ? '[\'__invalid__\', null, 999999]' : '__invalid__', note: '构造非法值以覆盖边界异常场景' };
        case 'bigdata':
            return { value: "''.padEnd(200000, 'x')", note: '放大到 200KB 以覆盖大数据场景' };
        default:
            return { value: current, note: '正向场景无需改动' };
    }
}
/**
 * 从一行开始，取出**完整的模板字面量**（可能跨行）。
 * 真机 demo 的数据点普遍是 `@State message: string = \`多行样例代码\``，
 * 只认单行等于放弃了这一整类数据点（实测这个库 100% 的数据点都是多行）。
 */
export function extractTemplateLiteral(source, lineNo) {
    const lines = source.split(/\r?\n/);
    const startIdx = Math.max(0, lineNo - 1);
    // 从锚点行往下找第一个反引号
    let abs = 0;
    for (let i = 0; i < startIdx; i++)
        abs += lines[i].length + 1;
    const open = source.indexOf('`', abs);
    if (open < 0)
        return null;
    let i = open + 1;
    while (i < source.length) {
        if (source[i] === '\\') {
            i += 2;
            continue;
        }
        if (source[i] === '`')
            break;
        i++;
    }
    if (i >= source.length)
        return null;
    const text = source.slice(open, i + 1);
    let line = 1;
    for (let k = 0; k < open; k++)
        if (source[k] === '\n')
            line++;
    return { text, startLine: line };
}
/**
 * 生成补丁草案。
 *
 * B 类：定位页面上的数据点，把它替换成该场景需要的取值（支持**多行模板字面量**）。
 * C 类：在页面 build() 的控件后追加一个调用按钮（最小侵入，只新增不修改既有逻辑）。
 * 找不到安全锚点时**不生成补丁**，而是把位置与理由写进 reason —— 硬凑一个改不对的补丁
 * 比不生成更坏。
 */
export function draftPatch(c, sym, demo, verdict, readFile) {
    const base = {
        class: verdict.class,
        target: verdict.triggerPage || (demo.demoCalls[0]?.sourceFile ?? ''),
        reason: verdict.reason,
        edits: [],
        revert: '删除副本目录即可（原仓库未被改动）',
        verify: [
            'devecocli check arkts <改动的文件>',
            'devecocli build --module entry',
            'devecocli run --module entry --device <serial>',
        ],
        risk: '补丁只应用在独立副本上；验证后删除副本即完成回退',
    };
    if (verdict.class === 'A') {
        return { ...base, reason: `${verdict.reason}（无需补丁）` };
    }
    if (verdict.class === 'D') {
        return { ...base, reason: `${verdict.reason}（进人工接管队列，不生成补丁）` };
    }
    const point = demo.paramPoints.find((p) => !verdict.triggerPage || p.pagePath === verdict.triggerPage)
        ?? demo.paramPoints[0];
    if (verdict.class === 'B' && point) {
        const content = readFile(point.sourceFile);
        if (!content) {
            return { ...base, reason: `${verdict.reason}；但读不到文件 ${point.sourceFile}，补丁需人工编写` };
        }
        const lineNo = Math.max(1, point.sourceLine);
        const lineText = content.split(/\r?\n/)[lineNo - 1] ?? '';
        const { value, note } = scenarioValueFor(c.scenarioKind, lineText);
        // 优先整体替换模板字面量（多行也支持）；否则退回单行右侧赋值替换
        const tpl = extractTemplateLiteral(content, lineNo);
        let before = '';
        let after = '';
        if (tpl) {
            before = tpl.text;
            after = /bigdata/.test(c.scenarioKind) ? `\`\${''.padEnd(200000, 'x')}\`` : '`__AUTOTEST_' + c.scenarioKind.toUpperCase() + '__`';
        }
        else if (lineText.includes('=')) {
            before = lineText;
            after = `${lineText.slice(0, lineText.indexOf('=') + 1)} ${value}`;
        }
        else {
            return { ...base, reason: `${verdict.reason}；未能在 ${point.sourceFile}:${lineNo} 定位到可替换的字面量，补丁需人工编写`, target: point.sourceFile };
        }
        if (!before.trim() || before === after) {
            return { ...base, reason: `${verdict.reason}；该数据点内容为空，补丁需人工编写`, target: point.sourceFile };
        }
        const occurrences = content.split(before).length - 1;
        if (occurrences !== 1) {
            // 出现 0 次说明源码已变；出现多次说明替换位置不唯一（会改错地方）—— 两种都不自动打补丁
            return {
                ...base, target: point.sourceFile,
                reason: `${verdict.reason}；该字面量在文件里出现 ${occurrences} 次（需要唯一才能安全替换），补丁需人工编写`,
            };
        }
        return {
            ...base,
            target: point.sourceFile,
            edits: [{ file: point.sourceFile, line: tpl?.startLine ?? lineNo, before, after, note: `${note}；仅改这一处字面量，验证后回退即还原` }],
            impact: ['仅影响该 demo 页面的一个数据字面量', '不改变三方库本身'],
            risk: `${base.risk}；改动后请确认该页面其余场景未被连带影响`,
        };
    }
    if (verdict.class === 'C') {
        const callFile = demo.demoCalls[0]?.sourceFile;
        if (demo.demoCalls.length === 0 && !callFile) {
            // 没有任何调用点：给出"新增控件"的草案，锚点取触发页面（若无页面则只给建议）
            const page = verdict.triggerPage;
            const content = page ? readFile(`${page}.ets`) ?? readFile(page) : null;
            if (!content || !page) {
                return { ...base, reason: `${verdict.reason}；未定位到可插入的页面文件，补丁需人工编写` };
            }
            const lines = content.split(/\r?\n/);
            // 不用 findLastIndex：本工程的编译目标是 ES2021，没有这个方法
            let anchorIdx = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (/^\s*\}\s*$/.test(lines[i])) {
                    anchorIdx = i;
                    break;
                }
            }
            if (anchorIdx < 1)
                return { ...base, reason: `${verdict.reason}；未找到安全的插入锚点，补丁需人工编写`, target: page };
            return {
                ...base,
                target: page,
                edits: [{
                        file: page, line: anchorIdx + 1,
                        before: lines[anchorIdx], after: `${lines[anchorIdx]}\n        // [AutoTest] 为覆盖 ${sym.name} 接口临时新增（验证后删除副本即还原）\n        Button('验证 ${sym.name}')\n          .onClick(() => { /* TODO: 调用 ${sym.name}(${sym.params.map((p) => p.name).join(', ')}) */ })`,
                        note: `新增一个按钮触发 ${sym.name}；调用体需要人工补全参数`,
                    }],
                impact: ['仅新增一个控件，不改既有逻辑', '不改变三方库本身'],
                risk: `${base.risk}；调用体是占位实现，必须人工补全参数后再执行`,
            };
        }
        const content = callFile ? readFile(callFile) : null;
        if (!content || !callFile) {
            return { ...base, reason: `${verdict.reason}；读不到调用点文件，补丁需人工编写` };
        }
        const lines = content.split(/\r?\n/);
        const lineNo = Math.max(1, demo.demoCalls[0].sourceLine);
        const before = lines[lineNo - 1] ?? '';
        if (!before.trim())
            return { ...base, reason: `${verdict.reason}；调用点行为空，补丁需人工编写`, target: callFile };
        return {
            ...base,
            target: callFile,
            edits: [{
                    file: callFile, line: lineNo,
                    before,
                    after: `${before}\n        // [AutoTest] 为覆盖 ${sym.name} 的${c.scenarioKind}场景，需要在真机上构造对应输入`,
                    note: '已在调用点处标注需要构造的输入；具体改动需人工确认',
                }],
            impact: ['仅在调用点添加标记', '不改变既有逻辑'],
            risk: `${base.risk}；该草案只标注位置，真正的输入构造需要人工完成`,
        };
    }
    return base;
}
/** 判断目标路径是否在副本目录内（防目录穿越；补丁绝不能写到副本之外）。 */
export function isInside(copyRoot, rel) {
    const abs = path.resolve(copyRoot, rel);
    const root = path.resolve(copyRoot);
    return abs === root || abs.startsWith(root + path.sep);
}
/**
 * 把补丁应用到**独立副本**。
 *
 * 关键纪律：
 *   ① 目标文件必须在副本目录内（越界一律拒绝）；
 *   ② 每处编辑的 `before` 必须在副本里**恰好出现一次**：0 次说明源码已变、多次说明位置不唯一，
 *      两种都拒绝 —— 代码变了还硬替换，等于悄悄改坏了别人的工程；
 *   ③ 写入 manifest（原始内容），保证可精确回退。
 *
 * 用「唯一子串替换」而不是按行号替换：真机 demo 的数据点普遍是多行模板字面量
 * （`@State code: string = \`多行样例\``），按行号根本替换不了这一整类。
 */
export function applyPatchToCopy(copyRoot, patch) {
    const applied = [];
    const failed = [];
    for (const e of patch.edits) {
        if (!isInside(copyRoot, e.file)) {
            failed.push({ edit: e, reason: `路径越界，拒绝写入副本之外：${e.file}` });
            continue;
        }
        const abs = path.resolve(copyRoot, e.file);
        if (!fs.existsSync(abs)) {
            failed.push({ edit: e, reason: `文件不存在：${e.file}` });
            continue;
        }
        const content = fs.readFileSync(abs, 'utf8');
        const occurrences = content.split(e.before).length - 1;
        if (occurrences === 0) {
            failed.push({ edit: e, reason: `内容与补丁记录不一致（第 ${e.line} 行已变化），拒绝应用以防改坏工程` });
            continue;
        }
        if (occurrences > 1) {
            failed.push({ edit: e, reason: `目标内容在文件中出现 ${occurrences} 次，位置不唯一，拒绝应用（避免改错地方）` });
            continue;
        }
        fs.writeFileSync(abs, content.replace(e.before, e.after), 'utf8');
        applied.push(e);
    }
    const manifestFile = path.join(copyRoot, 'autotest-patch-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({
        appliedAt: new Date().toISOString(),
        class: patch.class,
        reason: patch.reason,
        edits: applied,
        failed,
    }, null, 2), 'utf8');
    return { ok: failed.length === 0, copyDir: copyRoot, applied, failed, manifestFile };
}
/** 回退：把副本里的改动逐处还原（原仓库自始至终未被改动）。 */
export function revertCopy(copyRoot) {
    const manifestFile = path.join(copyRoot, 'autotest-patch-manifest.json');
    if (!fs.existsSync(manifestFile))
        return { ok: false, removed: [] };
    const removed = [];
    try {
        const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        for (const e of m.edits ?? []) {
            if (!isInside(copyRoot, e.file))
                continue;
            const abs = path.resolve(copyRoot, e.file);
            if (!fs.existsSync(abs))
                continue;
            const content = fs.readFileSync(abs, 'utf8');
            const occurrences = content.split(e.after).length - 1;
            if (occurrences !== 1)
                continue; // 已被人工改过，不强行还原
            fs.writeFileSync(abs, content.replace(e.after, e.before), 'utf8');
            removed.push(e.file);
        }
        fs.rmSync(manifestFile, { force: true });
    }
    catch {
        return { ok: false, removed };
    }
    return { ok: true, removed };
}
// ---------- 6. 批量判定（落库）与副本生命周期 ----------
/** 独立副本根目录（设计 §6.5 指定：workspace/demo-patches/<lib>/<caseNo>/）。 */
export function patchDirFor(libName, caseNo) {
    const safeLib = libName.replace(/[^\w.-]/g, '_');
    const safeCase = caseNo.replace(/[^\w.-]/g, '_');
    return path.join(workspaceDir(), 'demo-patches', safeLib, safeCase);
}
/** 复制 demo 到独立副本（排除构建产物与依赖目录；原仓库只读）。 */
export function makeCopy(srcDir, destDir) {
    if (!fs.existsSync(srcDir))
        return { ok: false, files: 0, reason: `源目录不存在：${srcDir}` };
    const EXCLUDE = new Set(['build', 'node_modules', 'oh_modules', '.git', '.hvigor', '.idea', 'dist']);
    let files = 0;
    const walk = (from, to, depth) => {
        if (depth > 10)
            return;
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            if (EXCLUDE.has(e.name))
                continue;
            const s = path.join(from, e.name);
            const d = path.join(to, e.name);
            if (e.isDirectory())
                walk(s, d, depth + 1);
            else if (e.isFile()) {
                fs.copyFileSync(s, d);
                files++;
            }
        }
    };
    try {
        walk(srcDir, destDir, 0);
        return { ok: true, files };
    }
    catch (e) {
        return { ok: false, files, reason: e.message };
    }
}
/**
 * 为一个库的全部用例做可测性判定并落库。
 *
 * "100% 用例带 A/B/C/D 判定"是设计验收项，所以这里**不跳过任何用例**：
 * 关联了接口符号的按符号+场景判，没关联的按"步骤引用的控件在真机上是否存在"判，
 * 两者都拿不到依据的也给出 C 并写明"需要人工确认入口"，绝不留空。
 */
export async function runTestability(libraryId) {
    const db = getDb();
    const lib = await db.prepare('SELECT id, name, repo_url, repo_subpath, last_commit FROM libraries WHERE id = ?')
        .get(libraryId);
    if (!lib)
        throw Object.assign(new Error('库不存在'), { statusCode: 404 });
    const cases = await db.prepare(`SELECT id, case_no, name, steps, expected, scenario_kind, api_symbol_id FROM cases WHERE library_id = ? ORDER BY id`)
        .all(libraryId);
    const symbols = await db.prepare('SELECT * FROM api_symbols WHERE library_id = ? ORDER BY id').all(libraryId);
    const symbolById = new Map(symbols.map((s) => [Number(s.id), s]));
    const version = (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version ?? '';
    const assets = await db.prepare(`SELECT kind, name, page_path, source_file, source_line, snippet FROM demo_assets
    WHERE library_id = ? AND library_version = ?`).all(libraryId, version);
    const matrix = await db.prepare('SELECT symbol_id, evidence_json FROM coverage_matrix WHERE library_id = ?')
        .all(libraryId);
    const evidenceBySymbol = new Map(matrix.map((m) => [m.symbol_id, JSON.parse(m.evidence_json || '{}')]));
    const { repoDirFor } = await import('./gitRepo.js');
    const libDir = repoDirFor(lib);
    const readFile = (rel) => {
        const abs = path.join(libDir, rel);
        if (!abs.startsWith(libDir))
            return null; // 防越界读取
        try {
            return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
        }
        catch {
            return null;
        }
    };
    /** 没有真机遍历证据时，退化为"该库全部遍历到的控件"（宁可宽松也不要因为缺证据判 C） */
    const { loadTraversalEvidence } = await import('./coverageMatrix.js');
    const traversal = loadTraversalEvidence(lib.name);
    const traversedControls = traversal ? traversal.allControls : [];
    // 判定用例步骤时要用**整次遍历收集到的全部控件**（含首页入口项）。
    // 只看"该符号所在页面的控件"会把用例里的首页入口点击误判成控件不存在 —— 实测踩过：
    // Simple Object Validation 明明被遍历点过（它就是首页列表项），却被判成"控件不存在"，
    // 于是可执行的用例被塞进"需改代码"。
    const allControls = [...new Set([...traversedControls, ...[...evidenceBySymbol.values()].flatMap((e) => e.deviceControls ?? [])])];
    const byClass = { A: 0, B: 0, C: 0, D: 0 };
    const humanQueue = [];
    const details = [];
    let withPatch = 0;
    const t = now();
    for (const c of cases) {
        const symRow = c.api_symbol_id ? symbolById.get(c.api_symbol_id) : undefined;
        const sym = symRow ? {
            id: Number(symRow.id), name: String(symRow.name), kind: String(symRow.kind), signature: String(symRow.signature ?? ''),
            params: JSON.parse(String(symRow.params_json || '[]')),
            returns: JSON.parse(String(symRow.returns_json || '{}')),
            throws: JSON.parse(String(symRow.throws_json || '[]')),
            methods: JSON.parse(String(symRow.methods_json || '[]')),
        } : null;
        const calls = sym ? assets.filter((a) => a.name === sym.name && (a.kind === 'call' || a.kind === 'test_call')) : [];
        const ev = sym ? evidenceBySymbol.get(sym.id) : undefined;
        // 判定"步骤里的控件在真机上是否存在"时，必须用**整次遍历收集到的全部控件**，
        // 不能只用该符号所在页面的控件：用例步骤通常先点首页入口、再点目标页按钮，
        // 只按目标页比对会把"首页入口"误判成不存在，于是可跑的用例被判成 C（要改 demo）。
        // 实测踩过：Simple Object Validation 明明被遍历点过，却被判为"控件不存在"。
        const demo = {
            demoCalls: calls.filter((a) => a.kind === 'call').map((a) => ({ pagePath: a.page_path, sourceFile: a.source_file, sourceLine: a.source_line, snippet: a.snippet })),
            deviceControls: [...new Set([...(ev?.deviceControls ?? []), ...allControls])],
            paramPoints: ev?.paramPoints ?? assets.filter((a) => a.kind === 'param').map((a) => ({ pagePath: a.page_path, name: a.name, sourceFile: a.source_file, sourceLine: a.source_line })),
            testCallCount: calls.filter((a) => a.kind === 'test_call').length,
        };
        const facts = {
            caseId: c.id, caseNo: c.case_no, name: c.name, scenarioKind: c.scenario_kind || 'happy',
            steps: (() => { try {
                return JSON.parse(c.steps || '[]');
            }
            catch {
                return [];
            } })(),
            expected: c.expected ?? '',
        };
        const verdict = classifyCase(facts, sym, demo);
        byClass[verdict.class]++;
        let patch = '';
        if (sym && (verdict.class === 'B' || verdict.class === 'C')) {
            const draft = draftPatch(facts, sym, demo, verdict, readFile);
            if (draft.edits.length > 0) {
                patch = JSON.stringify(draft);
                withPatch++;
            }
            else
                patch = JSON.stringify(draft); // 无 edits 也存下来：里面写着"为什么没有自动补丁"，人要看
        }
        await db.prepare('UPDATE cases SET testability = ?, testability_reason = ?, demo_patch_json = ?, updated_at = ? WHERE id = ?')
            .run(verdict.class, verdict.reason.slice(0, 490), patch, t, c.id);
        if (verdict.class === 'C' || verdict.class === 'D') {
            humanQueue.push({ caseNo: c.case_no, name: c.name, class: verdict.class, reason: verdict.reason });
        }
        details.push({ caseId: c.id, caseNo: c.case_no, class: verdict.class, reason: verdict.reason, hasPatch: patch !== '' });
    }
    return { libraryId, libraryName: lib.name, total: cases.length, byClass, humanQueue, withPatch, details };
}
/** 批准并应用补丁：先把 demo 复制成独立副本，再在副本上应用。**原仓库只读。** */
export async function applyCasePatch(caseId) {
    const db = getDb();
    const row = await db.prepare(`SELECT c.id, c.case_no, c.demo_patch_json, l.id AS lib_id, l.name AS lib_name, l.repo_url, l.repo_subpath
    FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`)
        .get(caseId);
    if (!row)
        throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
    if (!row.demo_patch_json)
        throw Object.assign(new Error('该用例没有补丁草案（只有 B/C 类才有）'), { statusCode: 400 });
    const patch = JSON.parse(row.demo_patch_json);
    if (patch.edits.length === 0)
        throw Object.assign(new Error(`该用例的补丁草案没有可自动应用的改动：${patch.reason}`), { statusCode: 400 });
    const { repoDirFor } = await import('./gitRepo.js');
    const libDir = repoDirFor({ name: row.lib_name, repo_url: row.repo_url, repo_subpath: row.repo_subpath });
    const copyDir = patchDirFor(row.lib_name, row.case_no);
    fs.rmSync(copyDir, { recursive: true, force: true });
    const copied = makeCopy(libDir, copyDir);
    if (!copied.ok)
        throw Object.assign(new Error(`复制 demo 失败：${copied.reason}`), { statusCode: 500 });
    const res = applyPatchToCopy(copyDir, patch);
    return { ok: res.ok, copyDir, files: copied.files, applied: res.applied, failed: res.failed };
}
/** 回退：还原副本里的改动（并可选删除副本目录）。 */
export async function revertCasePatch(caseId, removeCopy = false) {
    const db = getDb();
    const row = await db.prepare('SELECT c.case_no, l.name AS lib_name FROM cases c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?')
        .get(caseId);
    if (!row)
        throw Object.assign(new Error('用例不存在'), { statusCode: 404 });
    const copyDir = patchDirFor(row.lib_name, row.case_no);
    const res = revertCopy(copyDir);
    if (removeCopy)
        fs.rmSync(copyDir, { recursive: true, force: true });
    return { ...res, copyDir };
}
