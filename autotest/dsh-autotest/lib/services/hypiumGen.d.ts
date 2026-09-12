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
/** 库的 Hypium 工程根目录。 */
export declare function hypiumProjectDir(libName: string): string;
/** 用例绑定脚本路径：testcases/<lib>/<caseNo>.py。 */
export declare function hypiumCaseScriptPath(libName: string, caseNo: string): string;
/** 确保工程骨架存在；提供 serial 时刷新 user_config.xml（设备可能更换）。 */
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
export declare function oracleToPython(o: Record<string, unknown>, caseNoHint?: string): string[];
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
/** 类名：Case_<caseNo 去符号>，如 C-AI-001 → Case_CAI001。 */
export declare function caseClassName(caseNo: string): string;
/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export declare function generateCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
/**
 * 校验脚本至少含一个断言 —— 空脚本一律拒绝绑定（修 R12）。
 * 判据：脚本里出现 assert_* 函数名、Python `assert` 语句，或 Hypium 的断言方法。
 */
export declare function scriptHasAssertion(script: string): boolean;
/** 写入（或覆盖）用例绑定脚本，返回文件路径。未映射步骤与空脚本都会抛错（不落盘）。 */
export declare function writeCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
