export interface HypiumLib {
    name: string;
    packageName: string;
}
export interface HypiumCaseInput {
    caseNo: string;
    name: string;
    steps: string[];
    /** P6/P8：机器可校验判据 —— 每条都必须落到脚本断言上（否则脚本"通过"判定不了任何事） */
    oracles?: Array<Record<string, unknown>>;
}
/** 步骤无法映射到 Hypium 调用时抛出：**不再生成注释行**，让生成失败并回报。 */
export declare class UnmappedStepError extends Error {
    readonly stepIndex: number;
    readonly step: string;
    constructor(stepIndex: number, step: string);
}
/** 脚本里一个断言都没有时抛出：拒绝绑定的依据（修 R12：断言为空的"通过"就是假通过）。 */
export declare class NoAssertionError extends Error {
    constructor(caseNo: string);
}
/** 库名 → 目录名/模块前缀（`json-schema` → `json_schema`）。 */
export declare function hypiumLibSlug(libName: string): string;
/** 用例编号 → 模块后缀（`C-JS-001` → `C_JS_001`）。 */
export declare function hypiumCaseSlug(caseNo: string): string;
/**
 * 模块名 = 文件名 = Python 类名 = `-l` 参数 = 报告里的模块名。
 * 形如 `json_schema_C_JS_001`：满足模板的 `<lib>_<Case>` 可读性，又与平台用例编号强对应 ——
 * 改用例标题不会改文件名，重跑/绑定/报告都不受影响。
 */
export declare function hypiumCaseModule(libName: string, caseNo: string): string;
/**
 * **共享** Hypium 工程根目录（单工程 + 库命名空间）。
 * 参数保留是为了不破坏既有调用方，但已不再参与路径计算 —— 各库只体现在 `testcases/<lib>/` 里。
 */
export declare function hypiumProjectDir(_libName?: string): string;
/** 用例的库目录：<工程根>/testcases/<lib>。 */
export declare function hypiumLibDir(libName: string): string;
/** 用例脚本路径：testcases/<lib>/<lib>_<caseNo>.py。 */
export declare function hypiumCaseScriptPath(libName: string, caseNo: string): string;
/** 用例的 xdevice 驱动配置路径：与脚本同名同目录，只是扩展名不同（成对生成，缺一不可）。 */
export declare function hypiumCaseJsonPath(libName: string, caseNo: string): string;
/** 共享工具目录（骨架，生成器只补缺不覆盖）。 */
export declare function hypiumAwDir(): string;
/** 截图基线目录：框架产出的 zip 与判据用的 png 共用这一个目录（避免两套基线各说各话）。 */
export declare function hypiumBaselineDir(): string;
/**
 * 旧布局迁移：`workspace/hypium/<lib>/`（每库一个工程）→ `workspace/hypium/testcases/<lib>/`（单工程多库）。
 *
 * 为什么要显式迁移而不是"放着不管"：路径变了之后旧脚本会变成"找不到文件"，
 * 绑定状态被判 broken，人会以为脚本丢了。这里把用例文件搬过来，并清理旧工程里**由我们生成的**
 * 骨架文件（main.py / run.* / config / .gitignore / autotest_oracle.py）。
 * 只动这几个已知名字，其他文件一律保留并让整个目录留着 —— 宁可留下看不懂的东西，也不删用户的东西。
 */
export declare function migrateLegacyHypiumLayouts(): {
    libs: string[];
    files: number;
};
/**
 * 确保**共享工程骨架**存在（幂等；骨架文件只补缺、绝不覆盖）。
 *
 * 为什么只补缺：main.py / aw/ / config 是团队共有资产，手写的改动（比如机构特有的等待函数）
 * 被生成器覆盖掉是灾难性的。生成器只拥有 `testcases/<lib>/` 下的文件。
 */
export declare function ensureHypiumProject(lib: HypiumLib, serial?: string): void;
/** oracle 支持模块文件名（放在 Hypium 工程根目录，脚本按需 import）。 */
export declare const ORACLE_SUPPORT_MODULE = "autotest_oracle";
/**
 * oracle → 断言的落地。
 *
 * `script_assert` 直接内联成 Python 断言（它本来就是断言表达式）；
 * 其余六种统一走支持模块的辅助函数 —— 好处是**只有一个地方需要按 Hypium 版本适配**，
 * 而且支持模块里未实现的类型**一律抛错**，绝不静默通过（静默通过就是假通过）。
 */
export declare function oracleToPython(o: Record<string, unknown>, caseNoHint?: string, packageName?: string): string[];
/**
 * oracle 支持模块内容：所有判据的唯一适配点。
 *
 * 这里的每个调用都**对着本机实际安装的 hypium 包核实过**（site-packages/hypium）：
 *   - driver.wait_for_component(by, timeout) → 控件对象或 None
 *   - driver.wait_for_component_disappear(by, timeout)
 *   - driver.get_component_property(comp|by, "text"|"checked"|…)   ← 属性名白名单见其 docstring
 *   - driver.current_app() → (package, page)
 *   - driver.shell(cmd, timeout) → 设备端 shell 输出（读 hilog 用）
 *   - driver.capture_screen(save_path, in_pc=True) → 截图落盘路径
 *   - UiComponent.getText() / isChecked()
 *   - devicetest.core.exception.TestAssertionError ← 框架认的断言异常（_exec_func 会判为失败）
 * 失败的断言一律抛 TestAssertionError：**绝不静默通过**（静默通过就是假通过）。
 *
 * ⚠️ 曾经的错误：旧生成器用的是 `driver.assert_component_exist(...)` —— 该方法在 hypium 包里
 * 根本不存在，脚本跑到验证步骤会 AttributeError。所以这里只用上面这些核实过的 API。
 */
export declare function oracleSupportModuleSource(): string;
/**
 * Python 类名 = 模块名 = 文件名 = `-l` 参数。
 * xdevice 用 `run -l <模块名>` 加载用例，而模块里的 TestCase 类名必须与之一致 ——
 * 所以这里不再自己拼 `Case_xxx`，一律走 hypiumCaseModule()，保证四方一致。
 */
export declare function caseClassName(libName: string, caseNo: string): string;
/**
 * 用例的 xdevice 驱动配置内容（与脚本成对落盘）。
 * 模板里每个用例都有这份 json：`driver.py_file` 里的路径是**相对 testcases/** 的。
 */
export declare function caseJsonContent(lib: HypiumLib, c: HypiumCaseInput): string;
/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export declare function generateCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
/**
 * 校验脚本至少含一个断言 —— 空脚本一律拒绝绑定（修 R12）。
 * 判据：脚本里出现 assert_* 函数名、Python `assert` 语句，或 Hypium 的断言方法。
 */
export declare function scriptHasAssertion(script: string): boolean;
/**
 * 写入（或覆盖）用例绑定脚本**与配对的 xdevice 驱动配置**，返回脚本路径。
 * 未映射步骤与空脚本都会抛错（不落盘）。
 *
 * 成对写入的原因：注册表里只有 .py 而没有同名 .json 时，xdevice 不知道该怎么驱动这个模块
 * （模板里每个用例都是成对的），少一个就等于"用例看起来存在但跑不起来"。
 */
export declare function writeCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
