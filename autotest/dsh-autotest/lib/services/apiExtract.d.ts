export type SymbolKind = 'class' | 'function' | 'interface' | 'enum' | 'const' | 'type' | 'variable' | 'unknown';
export interface SymbolParam {
    name: string;
    type: string;
    optional: boolean;
    defaultValue: string;
    doc: string;
}
export interface ApiSymbol {
    name: string;
    kind: SymbolKind;
    /** 声明原文（拿不到完整签名时退化为名字，并由 detailLevel 说明） */
    signature: string;
    params: SymbolParam[];
    returns: {
        type: string;
        doc: string;
    };
    /** 声明的异常/错误码（源码 claim + 注释里的 @throws） */
    throws: Array<{
        type: string;
        doc: string;
    }>;
    sinceVersion: string;
    deprecated: boolean;
    /** 相对库根的文件路径 */
    sourceFile: string;
    sourceLine: number;
    /**
     * 类的方法清单。对 class 类符号来说，**方法才是真正可测的单元**
     * （`Validator` 测试的是 `v.validate(...)` / `v.addSchema(...)`），
     * 覆盖矩阵需要它，所以单独存一列而不是只塞进签名文本里。
     */
    methods: string[];
    /**
     * 说明这条记录的签名有多可信：
     *   full      —— 定位到定义体，且拿到了参数或方法（签名可用）
     *   decl-only —— 定位到定义体，但只读到一行声明（如 `var scan = {`）：名字可信、签名不完整
     *   name-only —— 没定位到定义体（如只存在于 .d.ts 的类型）：签名不可信，不要拿它生成用例
     * 这三档必须分开：把"类有 16 个方法但构造参数为空"判成 name-only，
     * 会让"签名不可信"这个风险标记在 16 个符号里误报 14 个，噪音把真问题淹没。
     */
    detailLevel: 'full' | 'decl-only' | 'name-only';
    docRefs: string[];
    /** 该符号是从哪个模块说明符解析过来的（排查用） */
    via: string;
}
export interface DemoAsset {
    /**
     * page    —— 真机可达页面（路由取自 main_pages.json）
     * control —— 页面上的可交互控件（供 P3 把接口映射到真机控件）
     * param   —— 页面的可注入数据点（@State 等字面量）
     * call    —— demo（src/main）里对库接口的真实调用点
     * test_call —— Hypium 单元测试（src/ohosTest）里对库接口的调用点
     *
     * `call` 与 `test_call` 必须分开：单元测试能跑通不等于**真机上**覆盖到了
     * （这个库的 ohosTest 里就有 19 个测试文件在调这些接口）。混在一起会把
     * "有单元测试" 当成 "demo 已覆盖"，而真机页面可能压根没调用过 —— 这正是假覆盖。
     */
    kind: 'page' | 'param' | 'control' | 'call' | 'test_call';
    name: string;
    pagePath: string;
    sourceFile: string;
    sourceLine: number;
    snippet: string;
    /** none 改不了 / param 改参数即可 / code 需要改代码 —— P5 可测性判定的静态依据 */
    mutability: 'none' | 'param' | 'code';
}
export interface ExtractResult {
    entryFile: string;
    /** 库的 npm 包名（demo 里 import 的就是它） */
    packageName: string;
    /**
     * 库自己声明的版本（入口模块 oh-package.json5 的 version）。
     * 这是接口面的权威版本：`api_symbols` 以 (库, 版本) 为唯一键，
     * 用 git tag 或 DB 缓存里的版本会把两种不同的接口面混成一条。
     * （单体仓里 `git describe --tags` 会贴到别的样本的 tag 上，实测 json-schema 被标成 ohos_minizip_1.0.5。）
     */
    moduleVersion: string;
    symbols: ApiSymbol[];
    demoAssets: DemoAsset[];
    /** 解析过程中遇到的、需要人看一眼的问题（未解析的说明符、找不到定义…） */
    problems: string[];
    filesScanned: number;
}
export interface ScanResult {
    /** isCode[i]=true 表示该位置是真正的代码（不在注释/字符串/正则字面量里） */
    isCode: boolean[];
    /** 注释被清空，字符串与正则字面量**原文保留**（提取模块说明符需要） */
    commentFree: string;
    /** 所有非代码位置都被清空（用于声明关键字匹配，避免匹配到字符串里的假代码） */
    codeOnly: string;
}
/**
 * 扫描源码，标出哪些位置是真正的代码。
 *
 * 这件事必须自己做对，因为后面所有提取都建立在"不把注释/字符串里的东西当代码"之上。
 * 真实仓库里踩过的坑：正则字面量（`/[^+/0-9A-Za-z-_]/g` 的字符类里就有 `/`）与
 * 字符串里的引号会让朴素扫描器错位，**错位之后整个文件后半段会被当成字符串清空**，
 * 提取结果静默变少且看不出原因。所以这里按状态机处理：注释 / 字符串 / 模板串 / 正则（含字符类）。
 */
export declare function scanSource(source: string): ScanResult;
/**
 * 去注释与字符串内容，返回等长掩码文本（用于"找声明/关键字"类匹配）。
 * 与旧实现的区别：正则字面量会整体被清空，不再因为字符类里的 `/` 或引号而错位。
 */
export declare function maskCommentsAndStrings(source: string): string;
/** 逐行偏移表：把字符下标换算成 1-based 行号。 */
export declare function lineIndex(source: string): number[];
export declare function lineAt(starts: number[], offset: number): number;
/** 解析 JSON5 风格的清单文件（去注释、容忍尾逗号、容忍单引号与无引号键）。 */
export declare function parseJson5Like(text: string): Record<string, unknown>;
/** 库模块目录候选：库根下常见的几种布局。 */
export declare function findModuleDirs(libDir: string): string[];
/** 读模块清单（oh-package.json5 优先）。 */
export declare function readModuleManifest(moduleDir: string): Record<string, unknown>;
/** 解析入口文件：清单的 main/types 优先，其次常见文件名。返回相对库根的路径。 */
export declare function resolveEntryFile(libDir: string): {
    entryAbs: string;
    entryRel: string;
    moduleDir: string;
    packageName: string;
    moduleVersion: string;
    via: string;
} | null;
/** 把"可能少了扩展名"的路径补成真实文件（x → x.ts / x.ets / x/index.ts …）。 */
export declare function resolveFileLike(abs: string): string | null;
/** 解析相对模块说明符到实际文件；非相对（`@ohos/x`）返回 null。 */
export declare function resolveRelativeSpec(fromFile: string, spec: string): string | null;
export interface ExportRecord {
    /** 对外名字 */
    name: string;
    /** 本文件里的原名（`export { a as B }` 的 a；无别名时同名） */
    localName: string;
    typeOnly: boolean;
    /** `from` 的模块说明符；无 from 表示本文件内导出 */
    spec: string;
    line: number;
}
/**
 * 解析一个文件里的全部导出。
 * 覆盖真实仓库里出现的形态：多行 `export {...} from`、`export type {...} from`、
 * `export { a as B }`、`export * from`、`export default`、以及 JS 的 `exports.X =`。
 */
export declare function parseExports(source: string, fileAbs: string): {
    exports: ExportRecord[];
    stars: Array<{
        spec: string;
        line: number;
    }>;
    defaults: number[];
};
export interface Definition {
    found: boolean;
    kind: SymbolKind;
    signature: string;
    params: SymbolParam[];
    returns: {
        type: string;
        doc: string;
    };
    throws: Array<{
        type: string;
        doc: string;
    }>;
    sinceVersion: string;
    deprecated: boolean;
    line: number;
    /** 方法列表（类才有） */
    methods: string[];
}
/** 取某个偏移处紧邻上方的 JSDoc 块。 */
export declare function jsdocBefore(source: string, offset: number): {
    text: string;
    startLine: number;
};
export interface JsdocInfo {
    params: Record<string, {
        type: string;
        doc: string;
        optional: boolean;
    }>;
    returns: {
        type: string;
        doc: string;
    };
    throws: Array<{
        type: string;
        doc: string;
    }>;
    since: string;
    deprecated: boolean;
    summary: string;
}
/** 解析 JSDoc 里的 @param / @returns / @throws / @since / @deprecated。 */
export declare function parseJsdoc(text: string): JsdocInfo;
/**
 * 把形如 `(a: string, b?: number = 3)` 的参数表拆成结构化参数。
 * 类型/可选性优先取签名里的（TS 有真类型），签名里没有就用 JSDoc 的
 * —— 打包后的 JS 里类型信息**只存在于 JSDoc**，不合并的话参数全是光秃秃的名字。
 */
export declare function parseParamList(raw: string, docs?: JsdocInfo['params']): SymbolParam[];
/**
 * 按名字在文件里找定义体。
 * 依次尝试：class/interface/enum/type 声明 → function 声明 → 变量赋值函数/类 → 原型方法集合 → 任意赋值。
 * 找不到就返回 found=false（**不编造签名**）。
 */
export declare function extractDefinition(source: string, name: string): Definition;
export interface CollectOptions {
    maxFiles?: number;
}
/** 从入口文件出发逐层收集导出符号（含相对路径引用链与 export *）。 */
export declare function collectSymbolsFromEntry(libDir: string, entryAbs: string, opts?: CollectOptions): {
    symbols: ApiSymbol[];
    problems: string[];
    filesScanned: number;
};
/** 读页面路由清单（main_pages.json），拿到"真机可达的路由"而不是文件名猜测。 */
export declare function readPageRoutes(entryModuleDir: string): string[];
/** 一段源码属于真机 demo（src/main）还是 Hypium 单元测试（src/ohosTest）——两者不能混为一谈。 */
export declare function sourceScope(file: string): 'main' | 'test';
/**
 * 采集 demo 资产：页面（路由来自 main_pages.json）+ 库调用点（文件:行 + 可改性）。
 *
 * 可改性判定（P5 依据，静态可得的部分）：
 *   - `param`：调用/参数出现在 `@State x: string = \`…\`` 这类**数据字面量**里 → 改数据即可覆盖不同场景
 *   - `code`：出现在函数体/UI 属性等真实代码里 → 要覆盖新场景得改代码
 *   - `none`：只出现在 import 或纯展示文案里 → 不构成可注入点
 */
export declare function collectDemoAssets(libDir: string, entryModuleDir: string | null): {
    assets: DemoAsset[];
    problems: string[];
};
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
export declare function collectCallSites(libDir: string, demoDir: string | null, packageName: string, symbols: ApiSymbol[]): {
    assets: DemoAsset[];
    problems: string[];
};
/** 从 import 语句里取出本库导入的绑定名（`import {A, B as C} from '<pkg>'`）。 */
export declare function importedNames(source: string, packageName: string): Set<string>;
/** demo 模块目录：优先含 entry 名单询的目录。 */
export declare function findDemoModuleDir(libDir: string): string | null;
/** 完整提取：入口解析 → 符号收集 → demo 资产 → 调用点。 */
export declare function extractLibraryApi(libDir: string): ExtractResult;
export interface PersistResult {
    version: string;
    symbols: number;
    demoAssets: number;
    removedStale: number;
}
/**
 * 把提取结果写进 api_symbols / demo_assets。
 *
 * 幂等策略：同一 (library_id, library_version) 先删后插。
 * 理由：重新采集同一版本时，**上一次采到的、这次采不到的符号必须消失** ——
 * 若只 upsert，改了入口或删了导出后旧符号会永远留在表里，覆盖矩阵的分母就永久失真。
 * 换成新版本时旧版本的行保留（唯一键含 library_version），便于对比版本间接口面变化。
 */
export declare function persistExtraction(libraryId: number, version: string, result: ExtractResult): Promise<PersistResult>;
export interface StoredSymbol extends ApiSymbol {
    id: number;
    libraryVersion: string;
    /** 真机 demo 里的调用点数量（0 = demo 没用到） */
    demoCallCount: number;
    /** 仅单元测试里的调用点数量 */
    testCallCount: number;
    /** demo 调用点所在页面（去重） */
    pages: string[];
}
/** 读取已入库的接口清单，并带上"demo 用没用"的直接答案（P3 覆盖矩阵的输入）。 */
export declare function loadStoredSymbols(libraryId: number, version?: string): Promise<{
    version: string;
    symbols: StoredSymbol[];
}>;
/**
 * P2 完整流程：库目录 → 提取 → 落库 → 写《接口清单.md》。
 * 库目录由 gitRepo.repoDirFor 决定（单体仓子目录库只看自己那一层）。
 */
export declare function runApiExtraction(lib: {
    id: number;
    name: string;
    repo_url?: string;
    repo_subpath?: string;
    last_commit?: string;
    current_version?: string;
}): Promise<{
    ok: boolean;
    reason?: string;
    entryFile: string;
    packageName: string;
    symbols: number;
    demoAssets: number;
    callSites: number;
    testCallSites: number;
    problems: string[];
    docFile: string;
    version: string;
}>;
/** 渲染人可读的《接口清单.md》。 */
export declare function renderApiDoc(lib: {
    name: string;
    packageName?: string;
}, result: ExtractResult, version?: string): string;
