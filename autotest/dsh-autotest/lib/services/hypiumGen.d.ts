export interface HypiumLib {
    name: string;
    packageName: string;
}
export interface HypiumCaseInput {
    caseNo: string;
    name: string;
    steps: string[];
}
/** 库的 Hypium 工程根目录。 */
export declare function hypiumProjectDir(libName: string): string;
/** 用例绑定脚本路径：testcases/<lib>/<caseNo>.py。 */
export declare function hypiumCaseScriptPath(libName: string, caseNo: string): string;
/** 确保工程骨架存在；提供 serial 时刷新 user_config.xml（设备可能更换）。 */
export declare function ensureHypiumProject(lib: HypiumLib, serial?: string): void;
/** 类名：Case_<caseNo 去符号>，如 C-AI-001 → Case_CAI001。 */
export declare function caseClassName(caseNo: string): string;
/** 生成单用例 Python 模块内容（模板风格：setup 杀启应用 / process 步骤 / teardown 关闭）。 */
export declare function generateCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
/** 写入（或覆盖）用例绑定脚本，返回文件路径。 */
export declare function writeCaseScript(lib: HypiumLib, c: HypiumCaseInput): string;
