// P2：三方库「接口面」提取 —— 把库对外暴露的符号变成可枚举、可定位、可核对的事实。
//
// 为什么必须先做这一步：后面的覆盖矩阵、四类场景用例、可测性判定全都要回答
// "这个接口测没测" —— 没有一份**完整的符号清单**当分母，覆盖率就是不可证伪的。
//
// 真机仓库的现实（json-schema 实测，决定了这里的实现顺序）：
//   - 入口在 `library/oh-package.json5` 的 `main` 字段里，值是 `index.ts`（不是设计稿假设的 Index.ets）；
//   - `library/index.ts` 是个**纯 re-export 桶**：`export { Validator, ... } from './src/main/js/jsonschema'`，
//     还分 `export {...}`（值）与 `export type {...}`（类型）两段；
//   - 被指向的文件是 **7680 行的打包产物**（CommonJS 拼装 + 末尾 `export { origincode_5 as SchemaError, ... }`），
//     定义是 `var Validator = function Validator() {...}` / `Validator.prototype.addError = function(...)` 这种形态；
//   - 编译产物（.d.ets / index.d.ts）在仓库里**不存在**（build/ 被 gitignore），只有构建后才有。
//
// 所以提取策略是"按可靠性降序、命中即用"，并且**每一步都要能在结果里看出依据**：
//   1. oh-package.json5 的 main/types → 入口文件（权威：库自己声明的对外入口）
//   2. 逐层解析 export / export type / export * / export {a as B} from（含多行、别名）
//   3. 在每个文件里按名字找定义体，取签名/参数/JSDoc（找不到就诚实记录，不编造）
//   4. JS 兼容：exports.X = / module.exports.X = 也当导出
//
// 纯函数为主：不读 DB、不碰设备、不调 LLM，因此可以离线自检。
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
/** 正则起始之前允许出现的"表达式位置"字符。 */
const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);
/**
 * 扫描源码，标出哪些位置是真正的代码。
 *
 * 这件事必须自己做对，因为后面所有提取都建立在"不把注释/字符串里的东西当代码"之上。
 * 真实仓库里踩过的坑：正则字面量（`/[^+/0-9A-Za-z-_]/g` 的字符类里就有 `/`）与
 * 字符串里的引号会让朴素扫描器错位，**错位之后整个文件后半段会被当成字符串清空**，
 * 提取结果静默变少且看不出原因。所以这里按状态机处理：注释 / 字符串 / 模板串 / 正则（含字符类）。
 */
export function scanSource(source) {
    const n = source.length;
    const isCode = new Array(n).fill(true);
    const commentFree = source.split('');
    const blankAt = (arr, from, to) => {
        for (let k = from; k < to && k < n; k++)
            if (arr[k] !== '\n' && arr[k] !== '\r')
                arr[k] = ' ';
    };
    const mark = (from, to) => {
        for (let k = from; k < to && k < n; k++)
            isCode[k] = false;
    };
    // 上一个"有意义的代码字符"，用于判断 `/` 是正则还是除号
    let prevChar = '';
    let prevWord = '';
    const noteCode = (ch) => {
        if (/\s/.test(ch))
            return;
        if (/[\w$]/.test(ch)) {
            prevWord += ch;
        }
        else {
            prevWord = '';
            prevChar = ch;
        }
        if (!/[\w$]/.test(ch))
            prevChar = ch;
    };
    let i = 0;
    while (i < n) {
        const c = source[i];
        const c2 = source[i + 1];
        // 行注释
        if (c === '/' && c2 === '/') {
            let j = i;
            while (j < n && source[j] !== '\n')
                j++;
            blankAt(commentFree, i, j);
            mark(i, j);
            i = j;
            continue;
        }
        // 块注释
        if (c === '/' && c2 === '*') {
            let j = source.indexOf('*/', i + 2);
            j = j < 0 ? n : j + 2;
            blankAt(commentFree, i, j);
            mark(i, j);
            i = j;
            continue;
        }
        // 字符串
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n) {
                if (source[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (source[j] === c || source[j] === '\n') {
                    j++;
                    break;
                }
                j++;
            }
            mark(i, j);
            i = j;
            prevChar = c;
            prevWord = '';
            continue;
        }
        // 模板串（内部 ${} 也整体当字符串：少认几个符号，但不会认错）
        if (c === '`') {
            let j = i + 1;
            while (j < n) {
                if (source[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (source[j] === '`') {
                    j++;
                    break;
                }
                j++;
            }
            mark(i, j);
            i = j;
            prevChar = '`';
            prevWord = '';
            continue;
        }
        // 正则字面量 vs 除号
        if (c === '/') {
            const atExprStart = prevChar === '' || REGEX_PREV_CHARS.has(prevChar) || REGEX_PREV_WORDS.has(prevWord);
            if (atExprStart) {
                let j = i + 1;
                let inClass = false;
                while (j < n) {
                    const d = source[j];
                    if (d === '\\') {
                        j += 2;
                        continue;
                    }
                    if (d === '\n')
                        break; // 未闭合：当普通字符处理，避免吞掉整个文件
                    if (d === '[')
                        inClass = true;
                    else if (d === ']')
                        inClass = false;
                    else if (d === '/' && !inClass) {
                        j++;
                        break;
                    }
                    j++;
                }
                mark(i, j);
                i = j;
                prevChar = '/';
                prevWord = '';
                continue;
            }
        }
        noteCode(c);
        i++;
    }
    const codeOnly = commentFree.slice();
    for (let k = 0; k < n; k++)
        if (!isCode[k] && codeOnly[k] !== '\n' && codeOnly[k] !== '\r')
            codeOnly[k] = ' ';
    return { isCode, commentFree: commentFree.join(''), codeOnly: codeOnly.join('') };
}
/**
 * 去注释与字符串内容，返回等长掩码文本（用于"找声明/关键字"类匹配）。
 * 与旧实现的区别：正则字面量会整体被清空，不再因为字符类里的 `/` 或引号而错位。
 */
export function maskCommentsAndStrings(source) {
    return scanSource(source).codeOnly;
}
/** 逐行偏移表：把字符下标换算成 1-based 行号。 */
export function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source[i] === '\n')
            starts.push(i + 1);
    return starts;
}
export function lineAt(starts, offset) {
    let lo = 0, hi = starts.length - 1, ans = 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= offset) {
            ans = mid + 1;
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }
    return ans;
}
/** 解析 JSON5 风格的清单文件（去注释、容忍尾逗号、容忍单引号与无引号键）。 */
export function parseJson5Like(text) {
    // 用扫描器的 commentFree（注释清空、字符串原文保留）——清单里的值必须是原文
    let s = scanSource(text).commentFree;
    s = s.replace(/,\s*([}\]])/g, '$1');
    s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    s = s.replace(/'/g, '"');
    try {
        return JSON.parse(s);
    }
    catch {
        return {};
    }
}
// ---------- 1. 入口解析 ----------
const ENTRY_FALLBACKS = [
    'Index.ets', 'index.ets', 'Index.ts', 'index.ts',
    'src/main/ets/index.ets', 'src/main/ets/Index.ets',
    'src/main/ets/index.ts', 'src/main/ets/Index.ts',
    'src/index.ets', 'src/index.ts', 'index.js', 'Index.js',
];
/** 库模块目录候选：库根下常见的几种布局。 */
export function findModuleDirs(libDir) {
    const out = [];
    for (const rel of ['library', 'src/main/ets', 'har', 'hsp', '']) {
        const dir = rel ? path.join(libDir, rel) : libDir;
        if (fs.existsSync(path.join(dir, 'oh-package.json5')) || fs.existsSync(path.join(dir, 'oh-package.json')))
            out.push(dir);
    }
    // 没有清单的也留着兜底，但排在最后
    const last = libDir;
    if (!out.includes(last))
        out.push(last);
    return out;
}
/** 读模块清单（oh-package.json5 优先）。 */
export function readModuleManifest(moduleDir) {
    for (const f of ['oh-package.json5', 'oh-package.json']) {
        const p = path.join(moduleDir, f);
        if (fs.existsSync(p)) {
            try {
                return parseJson5Like(fs.readFileSync(p, 'utf8'));
            }
            catch { /* 落到下一个候选 */ }
        }
    }
    return {};
}
/** 解析入口文件：清单的 main/types 优先，其次常见文件名。返回相对库根的路径。 */
export function resolveEntryFile(libDir) {
    for (const moduleDir of findModuleDirs(libDir)) {
        const manifest = readModuleManifest(moduleDir);
        const packageName = String(manifest.name ?? '').trim();
        const moduleVersion = String(manifest.version ?? '').trim();
        for (const key of ['types', 'main']) {
            const decl = String(manifest[key] ?? '').trim();
            if (!decl)
                continue;
            const abs = resolveFileLike(path.resolve(moduleDir, decl));
            if (abs)
                return { entryAbs: abs, entryRel: relOf(libDir, abs), moduleDir, packageName, moduleVersion, via: `oh-package.json5:${key}=${decl}` };
        }
        for (const rel of ENTRY_FALLBACKS) {
            const abs = path.join(moduleDir, rel);
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                return { entryAbs: abs, entryRel: relOf(libDir, abs), moduleDir, packageName, moduleVersion, via: `约定文件名 ${rel}` };
            }
        }
    }
    return null;
}
/** 把"可能少了扩展名"的路径补成真实文件（x → x.ts / x.ets / x/index.ts …）。 */
export function resolveFileLike(abs) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile())
        return abs;
    for (const ext of ['.ets', '.ts', '.js', '.d.ts', '.d.ets', '.json5', '.json']) {
        if (fs.existsSync(abs + ext))
            return abs + ext;
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        for (const name of ['index.ets', 'Index.ets', 'index.ts', 'Index.ts', 'index.js']) {
            const p = path.join(abs, name);
            if (fs.existsSync(p))
                return p;
        }
    }
    return null;
}
/** 解析相对模块说明符到实际文件；非相对（`@ohos/x`）返回 null。 */
export function resolveRelativeSpec(fromFile, spec) {
    if (!spec.startsWith('.') && !spec.startsWith('/'))
        return null;
    const base = spec.startsWith('/') ? spec : path.resolve(path.dirname(fromFile), spec);
    return resolveFileLike(base);
}
function relOf(root, abs) {
    return path.relative(root, abs).replace(/\\/g, '/');
}
/**
 * 解析一个文件里的全部导出。
 * 覆盖真实仓库里出现的形态：多行 `export {...} from`、`export type {...} from`、
 * `export { a as B }`、`export * from`、`export default`、以及 JS 的 `exports.X =`。
 */
export function parseExports(source, fileAbs) {
    const scan = scanSource(source);
    // 关键：导出语句要在**保留字符串原文**的文本上匹配（模块说明符得读出来），
    // 但匹配起点必须落在真代码上（否则会命中字符串/注释里长得像 export 的内容）。
    const text = scan.commentFree;
    const isCodeAt = (idx) => scan.isCode[idx] === true;
    const starts = lineIndex(source);
    const out = [];
    const stars = [];
    const defaults = [];
    // export [type] { ... } [from '...']
    const re = /export\s+(type\s+)?\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
    for (const m of text.matchAll(re)) {
        if (!isCodeAt(m.index ?? 0))
            continue;
        const typeOnly = !!m[1];
        const spec = m[3] ?? '';
        const line = lineAt(starts, m.index ?? 0);
        for (const raw of m[2].split(',')) {
            const item = raw.trim();
            if (!item)
                continue;
            const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(item);
            const name = asMatch ? asMatch[2] : item;
            const localName = asMatch ? asMatch[1] : item;
            if (!/^[\w$]+$/.test(name))
                continue;
            out.push({ name, localName, typeOnly, spec, line });
        }
    }
    // export * from '...'
    for (const m of text.matchAll(/export\s+\*\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g)) {
        if (!isCodeAt(m.index ?? 0))
            continue;
        stars.push({ spec: m[1], line: lineAt(starts, m.index ?? 0) });
    }
    // export default
    for (const m of text.matchAll(/export\s+default\b/g)) {
        if (!isCodeAt(m.index ?? 0))
            continue;
        defaults.push(lineAt(starts, m.index ?? 0));
    }
    // export class/function/const/…
    const masked = scan.codeOnly;
    const declRe = /export\s+(?:declare\s+)?(abstract\s+)?(class|function|const|let|var|interface|type|enum)\s+([\w$]+)/g;
    for (const m of masked.matchAll(declRe)) {
        const kind = m[2];
        const name = m[3];
        if (kind === 'type') {
            // `export type X = ...` 是类型别名；`export type {..}` 已在上面处理
            out.push({ name, localName: name, typeOnly: true, spec: '', line: lineAt(starts, m.index ?? 0) });
        }
        else {
            out.push({ name, localName: name, typeOnly: kind === 'interface', spec: '', line: lineAt(starts, m.index ?? 0) });
        }
    }
    // JS：exports.X = / module.exports.X =
    for (const m of masked.matchAll(/(?:^|[\s;{}])(?:module\.)?exports\.([\w$]+)\s*=/g)) {
        out.push({ name: m[1], localName: m[1], typeOnly: false, spec: '', line: lineAt(starts, m.index ?? 0) });
    }
    return { exports: dedupeExports(out), stars, defaults };
}
function dedupeExports(list) {
    const seen = new Map();
    for (const e of list) {
        const key = `${e.name}|${e.typeOnly ? 't' : 'v'}`;
        if (!seen.has(key))
            seen.set(key, e);
    }
    return [...seen.values()];
}
const EMPTY_DEF = {
    found: false, kind: 'unknown', signature: '', params: [], returns: { type: '', doc: '' },
    throws: [], sinceVersion: '', deprecated: false, line: 0, methods: [],
};
/** 取某个偏移处紧邻上方的 JSDoc 块。 */
export function jsdocBefore(source, offset) {
    const head = source.slice(0, offset);
    const end = head.replace(/\s+$/, '');
    if (!end.endsWith('*/'))
        return { text: '', startLine: 0 };
    const start = end.lastIndexOf('/**');
    if (start < 0)
        return { text: '', startLine: 0 };
    return { text: end.slice(start), startLine: lineAt(lineIndex(source), start) };
}
/** 解析 JSDoc 里的 @param / @returns / @throws / @since / @deprecated。 */
export function parseJsdoc(text) {
    const params = {};
    const throws = [];
    let returns = { type: '', doc: '' };
    let since = '';
    let deprecated = false;
    if (!text)
        return { params, returns, throws, since, deprecated, summary: '' };
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*\/?\*+\s?/, '').replace(/\*\/\s*$/, '').trim());
    const summary = [];
    for (const l of lines) {
        const p = /^@param\s+(?:\{([^}]*)\}\s*)?(\[?[\w$.]+\]?)\s*(?:-\s*)?(.*)$/.exec(l);
        if (p) {
            const rawName = p[2];
            // [name] 或 [name=默认值] 在 JSDoc 里表示可选（JS 源码里没有 `?` 可依据，只能看这里）
            const optional = rawName.startsWith('[');
            const name = rawName.replace(/^\[|\]$/g, '').split('=')[0].trim();
            if (name)
                params[name] = { type: (p[1] ?? '').trim(), doc: p[3].trim(), optional };
            continue;
        }
        const r = /^@returns?\s*(?:\{([^}]*)\}\s*)?(.*)$/.exec(l);
        if (r) {
            returns = { type: (r[1] ?? '').trim(), doc: r[2].trim() };
            continue;
        }
        const t = /^@throws?\s*(?:\{([^}]*)\}\s*)?(.*)$/.exec(l);
        if (t) {
            throws.push({ type: (t[1] ?? '').trim(), doc: t[2] ?? '' });
            continue;
        }
        const s = /^@since\s+(.*)$/.exec(l);
        if (s) {
            since = s[1].trim();
            continue;
        }
        if (/^@deprecated\b/.test(l)) {
            deprecated = true;
            continue;
        }
        if (/^@/.test(l))
            continue;
        if (l)
            summary.push(l);
    }
    return { params, returns, throws, since, deprecated, summary: summary.join(' ').trim() };
}
/**
 * 把形如 `(a: string, b?: number = 3)` 的参数表拆成结构化参数。
 * 类型/可选性优先取签名里的（TS 有真类型），签名里没有就用 JSDoc 的
 * —— 打包后的 JS 里类型信息**只存在于 JSDoc**，不合并的话参数全是光秃秃的名字。
 */
export function parseParamList(raw, docs = {}) {
    const inner = raw.trim().replace(/^\(/, '').replace(/\)$/, '').trim();
    if (!inner)
        return [];
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        const next = inner[i + 1];
        const prev = inner[i - 1] ?? '';
        // `=>` 是箭头，不是大于号：按括号深度处理会把 depth 减成负数，
        // 此后所有逗号都不再算分隔符 —— 于是 `cb: (a: number) => void, o: {…}` 会被合并成一个参数
        // （真机上回调类参数很常见，合并后接口签名直接失真且看不出来）。
        if (ch === '=' && next === '>') {
            cur += '=>';
            i++;
            continue;
        }
        if (ch === '<' && /[\w$>\]]/.test(prev))
            depth++; // 泛型起始（Map<string, number>）
        else if (ch === '>' && depth > 0)
            depth--; // 泛型结束；`>` 不会把 depth 减成负数
        else if ('([{'.includes(ch))
            depth++;
        else if (')]}'.includes(ch))
            depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            parts.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim())
        parts.push(cur);
    return parts.map((p) => {
        const seg = p.trim();
        // `{a, b}: Type` 解构参数：整体当名字，类型取冒号后
        const m = /^(.*?)(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(seg) ?? [];
        const rawName = (m[1] ?? seg).trim();
        const optionalInSig = /\?\s*$/.test(rawName);
        const name = rawName.replace(/\?\s*$/, '').replace(/^\.\.\./, '').trim();
        const doc = docs[name];
        return {
            name,
            type: (m[2] ?? '').trim() || doc?.type || '',
            optional: optionalInSig || doc?.optional === true,
            defaultValue: (m[3] ?? '').trim(),
            doc: doc?.doc ?? '',
        };
    }).filter((p) => p.name);
}
/**
 * 按名字在文件里找定义体。
 * 依次尝试：class/interface/enum/type 声明 → function 声明 → 变量赋值函数/类 → 原型方法集合 → 任意赋值。
 * 找不到就返回 found=false（**不编造签名**）。
 */
export function extractDefinition(source, name) {
    const masked = maskCommentsAndStrings(source);
    const starts = lineIndex(source);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const finish = (idx, kind, signature, paramsRaw, retType) => {
        const js = parseJsdoc(jsdocBefore(source, idx).text);
        return {
            found: true,
            kind,
            signature: signature.trim(),
            params: parseParamList(paramsRaw, js.params),
            // 签名里没有返回类型时（JS 打包产物）用 JSDoc 的
            returns: { type: retType.trim() || js.returns.type, doc: js.returns.doc },
            throws: js.throws,
            sinceVersion: js.since,
            deprecated: js.deprecated,
            line: lineAt(starts, idx),
            methods: collectMethods(masked, name),
        };
    };
    // `const/let/var X = …` 放在 `function X(` 之前判断：
    // 打包产物里常见 `var Validator = function Validator() {}`，若先匹配 `function X(`，
    // 会把它当成"名为 Validator 的普通函数"，丢掉"这是个类（有原型方法）"这个关键事实。
    let m = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*`).exec(masked);
    if (m) {
        const after = masked.slice(m.index);
        if (/^\s*(?:const|let|var)\s+[\w$]+\s*=\s*class\b/.test(after)) {
            const head = source.slice(m.index, Math.min(source.length, m.index + 400));
            return finish(m.index, 'class', head.split('{')[0].replace(/\s+/g, ' ').trim(), '', '');
        }
        const arrow = after.indexOf('=>');
        const fnIdx = after.indexOf('function');
        if (arrow >= 0 && (fnIdx < 0 || arrow < fnIdx)) {
            const parenIdx = after.indexOf('(');
            if (parenIdx >= 0 && parenIdx < arrow) {
                const { paramsRaw, retType, sig } = readSignature(source, m.index + parenIdx);
                return finish(m.index, 'function', sig || `${name} = (${paramsRaw}) =>`, paramsRaw, retType);
            }
        }
        if (fnIdx >= 0 && fnIdx < 40) {
            const absFn = m.index + fnIdx;
            const parenIdx = masked.indexOf('(', absFn);
            const { paramsRaw, retType, sig } = readSignature(source, parenIdx);
            // 有原型方法 → 这是"类"，判成 function 会让人以为它是个普通函数
            const methods = collectMethods(masked, name);
            if (methods.length > 0) {
                const d = finish(m.index, 'class', `new ${name}${paramsRaw}`, paramsRaw, retType);
                return { ...d, signature: `new ${name}${paramsRaw.replace(/\s+/g, ' ')}` };
            }
            return finish(m.index, 'function', sig, paramsRaw, retType);
        }
        // 普通常量/对象字面量赋值
        const head = source.slice(m.index, Math.min(source.length, m.index + 200));
        const sig = head.split(/;\s*\n/)[0].split('\n')[0].replace(/\s+/g, ' ').trim();
        return finish(m.index, 'const', sig, '', '');
    }
    // class / interface / enum / type X =
    m = new RegExp(`\\b(class|interface|enum)\\s+${esc}\\b`).exec(masked);
    if (m) {
        const kind = m[1] === 'class' ? 'class' : m[1] === 'interface' ? 'interface' : 'enum';
        const head = source.slice(m.index, Math.min(source.length, m.index + 400));
        const sig = head.split('{')[0].replace(/\s+/g, ' ').trim();
        return finish(m.index, kind, sig, '', '');
    }
    m = new RegExp(`\\btype\\s+${esc}\\s*=`).exec(masked);
    if (m) {
        const head = source.slice(m.index, Math.min(source.length, m.index + 400));
        const sig = head.split(/;|\n\n/)[0].replace(/\s+/g, ' ').trim();
        return finish(m.index, 'type', sig, '', '');
    }
    // function X(...)  或  function X(...): T
    m = new RegExp(`\\bfunction\\s+${esc}\\s*(?:<[^>]*>)?\\s*\\(`).exec(masked);
    if (m) {
        const { paramsRaw, retType, sig } = readSignature(source, m.index + m[0].length - 1);
        return finish(m.index, 'function', sig, paramsRaw, retType);
    }
    // 原型方法集合（打包产物常见）：X.prototype.foo = function(...)
    const proto = new RegExp(`\\b${esc}\\.prototype\\.([\\w$]+)\\s*=\\s*function\\b`).exec(masked);
    if (proto) {
        return {
            found: true,
            kind: 'class',
            signature: `${name}（打包产物：原型方法）`,
            params: [],
            returns: { type: '', doc: '' },
            throws: [],
            sinceVersion: '',
            deprecated: false,
            line: lineAt(starts, proto.index),
            methods: collectMethods(masked, name),
        };
    }
    // 别名引用：var origincode_5 = origincode.SchemaError;
    const alias = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*([\\w$.]+)\\s*;`).exec(masked);
    if (alias) {
        const target = alias[1];
        const last = target.split('.').pop() ?? '';
        if (last && last !== name) {
            const inner = extractDefinition(source, last);
            if (inner.found)
                return { ...inner, signature: inner.signature || target };
        }
        return { ...EMPTY_DEF, found: true, kind: 'unknown', signature: `${name} = ${target}`, line: lineAt(starts, alias.index), methods: [] };
    }
    return { ...EMPTY_DEF, line: 0 };
}
/** 读取从 `(` 开始的参数表与返回类型。 */
function readSignature(source, parenIdx) {
    if (parenIdx < 0)
        return { paramsRaw: '', retType: '', sig: '' };
    let depth = 0;
    let end = parenIdx;
    for (let i = parenIdx; i < source.length && i < parenIdx + 4000; i++) {
        const ch = source[i];
        if (ch === '(')
            depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    const paramsRaw = source.slice(parenIdx, end + 1);
    let retType = '';
    const tail = source.slice(end + 1, end + 400);
    const rt = /^\s*:\s*([^\n{;=]+)/.exec(tail);
    if (rt)
        retType = rt[1].trim();
    const sig = (source.slice(parenIdx, end + 1) + (retType ? `: ${retType}` : '')).replace(/\s+/g, ' ').trim();
    return { paramsRaw, retType, sig };
}
/** 类的方法清单（原型方法与 class 体内的方法声明）。 */
function collectMethods(masked, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = new Set();
    for (const m of masked.matchAll(new RegExp(`\\b${esc}\\.prototype\\.([\\w$]+)\\s*=`, 'g')))
        out.add(m[1]);
    return [...out];
}
/** 从入口文件出发逐层收集导出符号（含相对路径引用链与 export *）。 */
export function collectSymbolsFromEntry(libDir, entryAbs, opts = {}) {
    const maxFiles = opts.maxFiles ?? 60;
    const symbols = [];
    const problems = [];
    const visited = new Set();
    const seen = new Map();
    const queue = [{ file: entryAbs, via: '入口', depth: 0 }];
    while (queue.length > 0 && visited.size < maxFiles) {
        const { file: cur, via, depth } = queue.shift();
        if (visited.has(cur))
            continue;
        visited.add(cur);
        let source = '';
        try {
            source = fs.readFileSync(cur, 'utf8');
        }
        catch {
            problems.push(`读不到文件：${relOf(libDir, cur)}`);
            continue;
        }
        const { exports, stars } = parseExports(source, cur);
        for (const e of exports) {
            // `export {a} from './x'` 优先去目标文件解析（真实定义在那里），本文件内导出就地解析
            const target = e.spec ? resolveRelativeSpec(cur, e.spec) : cur;
            if (e.spec && !target) {
                // 必须区分两种"解析不到"：相对路径找不到文件是**真问题**（符号会丢），
                // 指向外部包（@ohos/*）是正常情况（不是本库的接口面）。混为一谈会让真问题被淹没。
                if (e.spec.startsWith('.'))
                    problems.push(`${relOf(libDir, cur)}:${e.line} 的 re-export 目标「${e.spec}」无法解析到文件（该符号会丢失）`);
                else
                    problems.push(`${relOf(libDir, cur)}:${e.line} 的说明符「${e.spec}」不是相对路径，按外部依赖跳过`);
                continue;
            }
            const detail = extractDefinition(target ? fs.readFileSync(target, 'utf8') : source, e.localName);
            // 找不到定义体时，位置回落到**导出语句所在文件的那一行**（而不是目标文件的某一行），
            // 否则人按 source_file:source_line 去核对会看到一个对不上的位置
            const defFile = target ? relOf(libDir, target) : relOf(libDir, cur);
            const relFile = detail.found ? defFile : relOf(libDir, cur);
            const key = `${e.name}|${e.typeOnly ? 'type' : valueKind(detail.kind)}`;
            if (seen.has(key))
                continue;
            const sym = {
                name: e.name,
                // `export type {...}` 是**权威的类型导出声明**：即使同名运行时对象碰巧存在，
                // 也不能把类型导出的种类写成 class/const（json-schema 的 SchemaContext 就踩到过）。
                kind: e.typeOnly ? 'type' : detail.kind !== 'unknown' ? detail.kind : 'unknown',
                signature: detail.found ? detail.signature || e.name : `${relOf(libDir, cur)} 导出（未定位到定义体）`,
                params: detail.params,
                returns: detail.returns,
                throws: detail.throws,
                sinceVersion: detail.sinceVersion,
                deprecated: detail.deprecated,
                sourceFile: relFile,
                sourceLine: detail.found && detail.line > 0 ? detail.line : e.line,
                // 类型导出不携带运行时方法：同名运行时对象的方法不属于这个类型符号
                methods: e.typeOnly ? [] : detail.methods,
                detailLevel: detail.params.length > 0 ? 'full' : detail.found ? 'name-only' : 'name-only',
                docRefs: [],
                via: via + (e.spec ? ` → ${e.spec}` : ''),
            };
            if (!detail.found)
                problems.push(`${e.name}：只在 ${relOf(libDir, cur)}:${e.line} 找到导出声明，未在 ${relFile} 定位到定义体（签名不可信）`);
            else if (detail.methods.length > 1 && sym.kind === 'class')
                sym.signature = `${sym.signature} · 方法 ${detail.methods.length} 个（${detail.methods.slice(0, 6).join('/')}${detail.methods.length > 6 ? '…' : ''}）`;
            seen.set(key, sym);
            symbols.push(sym);
            void depth;
        }
        for (const s of stars) {
            const target = resolveRelativeSpec(cur, s.spec);
            if (!target) {
                problems.push(`${relOf(libDir, cur)}:${s.line} export * from「${s.spec}」无法解析到文件`);
                continue;
            }
            queue.push({ file: target, via: `${via} → export * ${s.spec}`, depth: depth + 1 });
        }
        // 同文件内 `export {a} from './x'` 的目标文件也可能有别的导出，但语义上只取列出的名字，不入队
    }
    return { symbols, problems, filesScanned: visited.size };
}
function valueKind(kind) {
    return kind === 'unknown' ? 'unknown' : kind;
}
// ---------- 5. demo 资产 ----------
/** 读页面路由清单（main_pages.json），拿到"真机可达的路由"而不是文件名猜测。 */
export function readPageRoutes(entryModuleDir) {
    const candidates = [
        path.join(entryModuleDir, 'src/main/resources/base/profile/main_pages.json'),
        path.join(entryModuleDir, 'resources/base/profile/main_pages.json'),
    ];
    for (const c of candidates) {
        if (!fs.existsSync(c))
            continue;
        try {
            const j = JSON.parse(fs.readFileSync(c, 'utf8'));
            if (Array.isArray(j.src))
                return j.src;
        }
        catch { /* 落到下一个候选 */ }
    }
    return [];
}
function walkFiles(dir, exts, out = [], depth = 0) {
    if (depth > 8 || !fs.existsSync(dir))
        return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (['node_modules', 'build', '.git', 'oh_modules', '.hvigor'].includes(e.name))
                continue;
            walkFiles(p, exts, out, depth + 1);
        }
        else if (exts.some((x) => e.name.endsWith(x)))
            out.push(p);
    }
    return out;
}
/** 一段源码属于真机 demo（src/main）还是 Hypium 单元测试（src/ohosTest）——两者不能混为一谈。 */
export function sourceScope(file) {
    const p = file.replace(/\\/g, '/');
    if (p.includes('/src/ohosTest/') || p.includes('/src/test/') || /\.test\.[jt]s$/.test(p))
        return 'test';
    return 'main';
}
/**
 * 采集 demo 资产：页面（路由来自 main_pages.json）+ 库调用点（文件:行 + 可改性）。
 *
 * 可改性判定（P5 依据，静态可得的部分）：
 *   - `param`：调用/参数出现在 `@State x: string = \`…\`` 这类**数据字面量**里 → 改数据即可覆盖不同场景
 *   - `code`：出现在函数体/UI 属性等真实代码里 → 要覆盖新场景得改代码
 *   - `none`：只出现在 import 或纯展示文案里 → 不构成可注入点
 */
export function collectDemoAssets(libDir, entryModuleDir) {
    const assets = [];
    const problems = [];
    const entryDir = entryModuleDir && fs.existsSync(entryModuleDir) ? entryModuleDir : null;
    if (!entryDir)
        return { assets, problems: ['未找到 demo 模块目录（entry/），demo 资产采集跳过'] };
    const routes = readPageRoutes(entryDir);
    const etsFiles = walkFiles(path.join(entryDir, 'src/main/ets'), ['.ets', '.ts']);
    const pageFiles = walkFiles(path.join(entryDir, 'src/main/ets/pages'), ['.ets']);
    const routeOf = new Map();
    for (const r of routes)
        routeOf.set(r.replace(/^pages\//, '').replace(/\.ets$/, '').toLowerCase(), r);
    for (const f of pageFiles) {
        const base = path.basename(f).replace(/\.ets$/, '');
        const source = fs.readFileSync(f, 'utf8');
        const structLine = (() => {
            const m = /\bstruct\s+([\w$]+)/.exec(maskCommentsAndStrings(source));
            return m ? lineAt(lineIndex(source), m.index ?? 0) : 1;
        })();
        assets.push({
            kind: 'page',
            name: base,
            pagePath: routeOf.get(base.toLowerCase()) ?? `pages/${base}`,
            sourceFile: relOf(libDir, f),
            sourceLine: structLine,
            snippet: (new RegExp(`[\\s\\S]{0,80}struct\\s+${base}[\\s\\S]{0,40}`).exec(source)?.[0] ?? '').trim().slice(0, 200),
            mutability: 'code',
        });
    }
    if (pageFiles.length === 0)
        problems.push('demo 的 pages 目录下没有 .ets 页面');
    // 逐文件找出「@State 字面量」与「函数体」里的代码区间，用于判断可改性
    for (const f of etsFiles) {
        const source = fs.readFileSync(f, 'utf8');
        const masked = maskCommentsAndStrings(source);
        const starts = lineIndex(source);
        const pageBase = path.basename(f).replace(/\.ets$/, '');
        const pagePath = routeOf.get(pageBase.toLowerCase()) ?? `pages/${pageBase}`;
        // @State x: string = `…`  这类模板字面量整体登记为 param 资产
        const stateRe = /@(?:State|Prop|Link)\s+([\w$]+)\s*:\s*[\w<>[\]|]*\s*=\s*`([\s\S]*?)`/g;
        for (const m of source.matchAll(stateRe)) {
            const line = lineAt(starts, m.index ?? 0);
            assets.push({
                kind: 'param',
                name: m[1],
                pagePath,
                sourceFile: relOf(libDir, f),
                sourceLine: line,
                snippet: m[2].trim().slice(0, 400),
                mutability: 'param',
            });
        }
        // 关键 UI 控件（可点/可输入）登记为 control，供 P3 把接口映射到真机控件
        const ctrlRe = /^\s*(Button|TextInput|Toggle|Checkbox|Slider|Select|Search|Radio)\s*\(/gm;
        for (const m of masked.matchAll(ctrlRe)) {
            const line = lineAt(starts, m.index ?? 0);
            assets.push({
                kind: 'control',
                name: `${m[1]}@${line}`,
                pagePath,
                sourceFile: relOf(libDir, f),
                sourceLine: line,
                snippet: source.split(/\r?\n/)[line - 1]?.trim().slice(0, 200) ?? '',
                mutability: 'code',
            });
        }
    }
    return { assets, problems };
}
/**
 * demo 里对库的调用点：找到 import 了本库包名的文件，再定位每个符号的使用行。
 * 这一步是 P3 覆盖矩阵"这个接口在 demo 里被用到了吗"的直接答案。
 *
 * ⚠️ 假覆盖是本项目最不能犯的错（P6 硬门槛：假通过 0），所以这里做了三层过滤，
 * 每一条都是真机上验过的坑：
 *   ① 只认**从本库 import 进来的名字**：页面自己也可能有同名成员，光看名字会把
 *      demo 自己的 `validate()` 方法算成库接口被调用；
 *   ② 排除成员访问（`v.validate(...)`、`this.validate()`）：那是接收者对象的方法，
 *      不是导出的自由函数 —— 把它算到 `validate` 头上就是张冠李戴；
 *   ③ 排除**定义形态**（`validate() {`、`function validate(`）：那是声明不是调用。
 */
export function collectCallSites(libDir, demoDir, packageName, symbols) {
    const assets = [];
    const problems = [];
    if (!demoDir || !fs.existsSync(demoDir))
        return { assets, problems: ['未找到 demo 目录，调用点采集跳过'] };
    const symbolNames = new Set(symbols.map((s) => s.name));
    /** 类型/接口类符号：使用处多为类型标注，不构成可注入的行为点 */
    const typeOnlyNames = new Set(symbols.filter((s) => s.kind === 'type' || s.kind === 'interface').map((s) => s.name));
    const files = walkFiles(demoDir, ['.ets', '.ts']);
    const entryDir = findDemoModuleDir(demoDir);
    const routes = entryDir ? readPageRoutes(entryDir) : [];
    const routeOf = new Map(routes.map((r) => [r.replace(/^pages\//, '').toLowerCase(), r]));
    for (const f of files) {
        const source = fs.readFileSync(f, 'utf8');
        const scan = scanSource(source);
        // 匹配符号名用 codeOnly（字符串内容被清空）：
        // 真机 demo 的页面里普遍有 `@State message0: string = "…v.validate(instance, schema)"` 这种
        // **展示用样例代码字符串**，它长得像调用但不是调用。若按"文本里出现过符号名"算覆盖，
        // 会得出"该接口已被 demo 覆盖"的结论，而真机上根本不会执行到 —— 这正是本项目
        // 明令禁止的假通过（P6 硬门槛：假通过 0）。真调用只认代码位置。
        const masked = scan.codeOnly;
        // 但 import 判断必须用 commentFree：包名本身就是个字符串，在 codeOnly 里已被清空，
        // 用它判断会一个文件都匹配不到（调用点全丢）。
        const imported = importedNames(scan.commentFree, packageName);
        if (imported.size === 0)
            continue;
        const starts = lineIndex(source);
        const lines = source.split(/\r?\n/);
        const pageBase = path.basename(f).replace(/\.(ets|ts)$/, '');
        const scope = sourceScope(f);
        // 单元测试不是真机可达页面：pagePath 留空并把 kind 标成 test_call，
        // 让 P3 只能把它当"另有单元测试证据"，不能当"demo 页面已覆盖"
        const pagePath = scope === 'test' ? '' : (routeOf.get(pageBase.toLowerCase()) ?? `pages/${pageBase}`);
        const names = [...symbolNames].filter((n) => imported.has(n));
        for (const name of names) {
            const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            for (const m of masked.matchAll(re)) {
                const idx = m.index ?? 0;
                const line = lineAt(starts, idx);
                const text = (lines[line - 1] ?? '').trim();
                if (/^\s*import\b/.test(text) || /from\s*['"]/.test(text))
                    continue; // ① 导入行
                if (/[.?]\s*$/.test(masked.slice(Math.max(0, idx - 2), idx)))
                    continue; // ② 成员访问 x.name / x?.name
                if (/\bfunction\s*$/.test(masked.slice(Math.max(0, idx - 12), idx)))
                    continue; // ③ function name(…)
                if (new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${name}\\s*\\(`).test(text))
                    continue; // ③ 本页自己的同名方法定义
                assets.push({
                    kind: scope === 'test' ? 'test_call' : 'call',
                    name,
                    pagePath,
                    sourceFile: relOf(libDir, f),
                    sourceLine: line,
                    snippet: text.slice(0, 300),
                    // 类型/接口符号的"使用处"通常是类型标注（`let x: Schema = {...}`）：
                    // 标注本身改不出新场景，所以记为 none —— 真要覆盖得改旁边那个字面量，
                    // 那是 param 资产的事。不让 P3 把"标注里出现过"当成"该接口已在真机覆盖"。
                    mutability: typeOnlyNames.has(name) ? 'none' : 'code',
                });
            }
        }
    }
    const deviceCalls = assets.filter((a) => a.kind === 'call').length;
    const testCalls = assets.filter((a) => a.kind === 'test_call').length;
    if (deviceCalls === 0)
        problems.push(`demo（src/main）里没有找到对库「${packageName}」的真实调用点（只有 import 引用）`);
    if (testCalls > 0)
        problems.push(`另有 ${testCalls} 处调用来自 Hypium 单元测试（src/ohosTest），已单独标为 test_call，不计入真机 demo 覆盖`);
    return { assets, problems };
}
/** 从 import 语句里取出本库导入的绑定名（`import {A, B as C} from '<pkg>'`）。 */
export function importedNames(source, packageName) {
    const out = new Set();
    if (!packageName)
        return out;
    const esc = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of source.matchAll(new RegExp(`import\\s+([\\s\\S]*?)\\s*from\\s*['"]${esc}['"]`, 'g'))) {
        const clause = m[1].trim();
        const braces = /\{([\s\S]*)\}/.exec(clause);
        if (braces) {
            for (const raw of braces[1].split(',')) {
                const item = raw.trim();
                if (!item)
                    continue;
                const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(item);
                out.add(asMatch ? asMatch[2] : item);
            }
        }
        const def = /^([\w$]+)\s*(?:,|$)/.exec(clause);
        if (def && !clause.startsWith('{'))
            out.add(def[1]); // 默认导入
    }
    return out;
}
/** demo 模块目录：优先含 entry 名单询的目录。 */
export function findDemoModuleDir(libDir) {
    const candidates = ['entry', 'app', 'demo', 'sample', 'example', 'Entry'];
    for (const c of candidates) {
        const p = path.join(libDir, c);
        if (fs.existsSync(path.join(p, 'src/main/ets')))
            return p;
    }
    for (const e of fs.readdirSync(libDir, { withFileTypes: true })) {
        if (!e.isDirectory())
            continue;
        const p = path.join(libDir, e.name);
        if (fs.existsSync(path.join(p, 'src/main/ets')))
            return p;
    }
    return null;
}
// ---------- 6. 编排 + 文档渲染 ----------
/** 完整提取：入口解析 → 符号收集 → demo 资产 → 调用点。 */
export function extractLibraryApi(libDir) {
    const problems = [];
    const entry = resolveEntryFile(libDir);
    if (!entry) {
        return { entryFile: '', packageName: '', moduleVersion: '', symbols: [], demoAssets: [], problems: ['未找到库入口：库根下没有 library/ 或带 oh-package.json5 的模块目录'], filesScanned: 0 };
    }
    if (!/^@?[\w./-]+$/.test(entry.packageName))
        problems.push(`模块清单里的 name 不可用（${entry.packageName || '空'}），demo 调用点匹配会受影响`);
    const { symbols, problems: symProblems, filesScanned } = collectSymbolsFromEntry(libDir, entry.entryAbs);
    problems.push(...symProblems);
    const demoModule = findDemoModuleDir(libDir);
    const { assets: demoAssets, problems: demoProblems } = collectDemoAssets(libDir, demoModule);
    problems.push(...demoProblems);
    const { assets: callSites, problems: callProblems } = collectCallSites(libDir, path.join(libDir, 'entry'), entry.packageName, symbols);
    problems.push(...callProblems);
    // 去重：同一 (kind, name, file, line) 只留一条
    const seen = new Set();
    const merged = [...demoAssets, ...callSites].filter((a) => {
        const k = `${a.kind}|${a.name}|${a.sourceFile}|${a.sourceLine}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
    return { entryFile: entry.entryRel, packageName: entry.packageName, moduleVersion: entry.moduleVersion, symbols, demoAssets: merged, problems, filesScanned };
}
/**
 * 把提取结果写进 api_symbols / demo_assets。
 *
 * 幂等策略：同一 (library_id, library_version) 先删后插。
 * 理由：重新采集同一版本时，**上一次采到的、这次采不到的符号必须消失** ——
 * 若只 upsert，改了入口或删了导出后旧符号会永远留在表里，覆盖矩阵的分母就永久失真。
 * 换成新版本时旧版本的行保留（唯一键含 library_version），便于对比版本间接口面变化。
 */
export async function persistExtraction(libraryId, version, result) {
    const db = getDb();
    const t = now();
    const ver = version || 'unknown';
    let removedStale = 0;
    await db.transaction(async () => {
        const old = await db.prepare('SELECT COUNT(*) AS n FROM api_symbols WHERE library_id = ? AND library_version = ?')
            .get(libraryId, ver);
        removedStale = old?.n ?? 0;
        await db.prepare('DELETE FROM api_symbols WHERE library_id = ? AND library_version = ?').run(libraryId, ver);
        await db.prepare('DELETE FROM demo_assets WHERE library_id = ? AND library_version = ?').run(libraryId, ver);
        for (const s of result.symbols) {
            await db.prepare(`INSERT INTO api_symbols
        (library_id, library_version, name, kind, signature, params_json, returns_json, throws_json,
         since_version, deprecated, source_file, source_line, methods_json, doc_refs, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(libraryId, ver, s.name, s.kind, s.signature, JSON.stringify(s.params), JSON.stringify(s.returns), JSON.stringify(s.throws), s.sinceVersion, s.deprecated ? 1 : 0, s.sourceFile, s.sourceLine, JSON.stringify(s.methods), JSON.stringify(s.docRefs), t, t);
        }
        for (const a of result.demoAssets) {
            await db.prepare(`INSERT INTO demo_assets
        (library_id, library_version, kind, name, page_path, source_file, source_line, snippet, mutability, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(libraryId, ver, a.kind, a.name, a.pagePath, a.sourceFile, a.sourceLine, a.snippet, a.mutability, t);
        }
    });
    return { version: ver, symbols: result.symbols.length, demoAssets: result.demoAssets.length, removedStale };
}
/** 读取已入库的接口清单，并带上"demo 用没用"的直接答案（P3 覆盖矩阵的输入）。 */
export async function loadStoredSymbols(libraryId, version) {
    const db = getDb();
    const ver = version || (await db.prepare('SELECT library_version FROM api_symbols WHERE library_id = ? ORDER BY id DESC LIMIT 1')
        .get(libraryId))?.library_version || '';
    if (!ver)
        return { version: '', symbols: [] };
    const rows = await db.prepare(`SELECT * FROM api_symbols WHERE library_id = ? AND library_version = ? ORDER BY id`)
        .all(libraryId, ver);
    const calls = await db.prepare(`SELECT name, kind, page_path FROM demo_assets
    WHERE library_id = ? AND library_version = ? AND kind IN ('call','test_call')`)
        .all(libraryId, ver);
    const byName = new Map();
    for (const c of calls) {
        const e = byName.get(c.name) ?? { demo: 0, test: 0, pages: new Set() };
        if (c.kind === 'call') {
            e.demo++;
            if (c.page_path)
                e.pages.add(c.page_path);
        }
        else
            e.test++;
        byName.set(c.name, e);
    }
    return {
        version: ver,
        symbols: rows.map((r) => {
            const stat = byName.get(String(r.name));
            return {
                id: Number(r.id),
                libraryVersion: String(r.library_version),
                name: String(r.name),
                kind: String(r.kind),
                signature: String(r.signature),
                params: JSON.parse(String(r.params_json || '[]')),
                returns: JSON.parse(String(r.returns_json || '{}')),
                throws: JSON.parse(String(r.throws_json || '[]')),
                sinceVersion: String(r.since_version ?? ''),
                deprecated: Number(r.deprecated ?? 0) === 1,
                sourceFile: String(r.source_file ?? ''),
                sourceLine: Number(r.source_line ?? 0),
                methods: JSON.parse(String(r.methods_json || '[]')),
                detailLevel: JSON.parse(String(r.params_json || '[]')).length > 0 ? 'full' : 'name-only',
                docRefs: JSON.parse(String(r.doc_refs || '[]')),
                via: '',
                demoCallCount: stat?.demo ?? 0,
                testCallCount: stat?.test ?? 0,
                pages: [...(stat?.pages ?? [])],
            };
        }),
    };
}
/**
 * P2 完整流程：库目录 → 提取 → 落库 → 写《接口清单.md》。
 * 库目录由 gitRepo.repoDirFor 决定（单体仓子目录库只看自己那一层）。
 */
export async function runApiExtraction(lib) {
    const { repoDirFor, workspaceDir } = await import('./gitRepo.js');
    const libDir = repoDirFor(lib);
    if (!fs.existsSync(libDir)) {
        return {
            ok: false, reason: `本地没有该库的代码：${libDir}。请先在库管理页执行「拉取仓库代码」。`,
            entryFile: '', packageName: '', symbols: 0, demoAssets: 0, callSites: 0, testCallSites: 0, problems: [], docFile: '', version: '',
        };
    }
    const result = extractLibraryApi(libDir);
    // 版本唯一键：优先**库自己声明的版本**（入口 oh-package.json5 的 version，权威）；
    // 库里缓存的 current_version 可能是旧的（单体仓的 git tag 还会串到别的样本上），只作兜底。
    const version = result.moduleVersion
        || (String(lib.current_version || '').trim() && lib.current_version !== 'v0.0.0' ? String(lib.current_version) : '')
        || String(lib.last_commit || '').slice(0, 8) || 'unknown';
    const persisted = await persistExtraction(lib.id, version, result);
    // 顺手纠正 libraries.current_version：清单里的版本才是这个库的真实版本
    if (result.moduleVersion && result.moduleVersion !== String(lib.current_version ?? '')) {
        const { getDb, now } = await import('../db/connection.js');
        await getDb().prepare('UPDATE libraries SET current_version = ?, updated_at = ? WHERE id = ?')
            .run(result.moduleVersion, now(), lib.id);
    }
    const docDir = path.join(workspaceDir(), 'api', lib.name.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(docDir, { recursive: true });
    const docFile = path.join(docDir, '接口清单.md');
    fs.writeFileSync(docFile, renderApiDoc(lib, result, version), 'utf8');
    return {
        ok: true,
        entryFile: result.entryFile, packageName: result.packageName,
        symbols: persisted.symbols, demoAssets: persisted.demoAssets,
        callSites: result.demoAssets.filter((a) => a.kind === 'call').length,
        testCallSites: result.demoAssets.filter((a) => a.kind === 'test_call').length,
        problems: result.problems, docFile, version,
    };
}
/** 渲染人可读的《接口清单.md》。 */
export function renderApiDoc(lib, result, version = '') {
    const L = [];
    L.push(`# ${lib.name} · 接口清单`);
    L.push('');
    L.push(`> 由 P2 接口面提取自动生成，请勿手工编辑（改动请重新采集）。`);
    L.push('');
    L.push(`- 库包名：\`${result.packageName || lib.packageName || '—'}\``);
    L.push(`- 入口文件：\`${result.entryFile || '—'}\``);
    if (version)
        L.push(`- 采集版本：\`${version}\``);
    L.push(`- 导出符号：**${result.symbols.length}** 个 · 扫描文件 ${result.filesScanned} 个 · demo 资产 ${result.demoAssets.length} 条`);
    L.push(`- 采集时间：${new Date().toISOString()}`);
    L.push('');
    const kinds = new Map();
    for (const s of result.symbols)
        kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    L.push(`按类型：${[...kinds].map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
    L.push('');
    L.push('## 导出符号');
    L.push('');
    L.push('| # | 名称 | 类型 | 签名 | 参数 | 声明位置 | 签名可信度 |');
    L.push('|---|---|---|---|---|---|---|');
    result.symbols.forEach((s, i) => {
        const params = s.params.length
            ? s.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`).join(', ')
            : '—';
        L.push(`| ${i + 1} | \`${s.name}\` | ${s.kind} | \`${s.signature.replace(/\|/g, '\\|').slice(0, 120)}\` | ${params.replace(/\|/g, '\\|')} | \`${s.sourceFile}:${s.sourceLine}\` | ${s.detailLevel} |`);
    });
    L.push('');
    if (result.problems.length) {
        L.push('## 采集过程中的问题（需要人看一眼）');
        L.push('');
        for (const p of result.problems)
            L.push(`- ${p}`);
        L.push('');
    }
    L.push('## demo 资产');
    L.push('');
    L.push('> `call` 是 demo（src/main）里的真实调用点，`test_call` 是 Hypium 单元测试里的调用点 —— 两者不可混同：');
    L.push('> 单元测试跑通不代表真机上覆盖到了。');
    L.push('');
    L.push('| 类型 | 名称 | 页面 | 位置 | 可改性 | 片段 |');
    L.push('|---|---|---|---|---|---|');
    for (const a of result.demoAssets.slice(0, 600)) {
        L.push(`| ${a.kind} | \`${a.name}\` | ${a.pagePath || '—'} | \`${a.sourceFile}:${a.sourceLine}\` | ${a.mutability} | ${a.snippet.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)} |`);
    }
    L.push('');
    // 一句话给出"哪些接口 demo 没用到"，这是 P3 覆盖矩阵最关心的答案
    const called = new Set(result.demoAssets.filter((a) => a.kind === 'call').map((a) => a.name));
    const testOnly = new Set(result.demoAssets.filter((a) => a.kind === 'test_call').map((a) => a.name));
    const never = result.symbols.filter((s) => !called.has(s.name) && !testOnly.has(s.name)).map((s) => s.name);
    L.push('## 覆盖速览（真机 demo 视角）');
    L.push('');
    L.push(`- demo 真实调用的符号：${[...called].sort().map((n) => `\`${n}\``).join('、') || '（无）'}`);
    L.push(`- 仅单元测试调用（真机 demo 未用）：${[...testOnly].filter((n) => !called.has(n)).sort().map((n) => `\`${n}\``).join('、') || '（无）'}`);
    L.push(`- 完全没有被调用：${never.map((n) => `\`${n}\``).join('、') || '（无）'}`);
    L.push('');
    return L.join('\n');
}
