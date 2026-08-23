/** 从 hypium 风格脚本中抽取可执行步骤（best-effort，映射到 hdc 步骤原语）。 */
export declare function parseScriptSteps(script: string): string[];
/** 读取用例绑定的脚本文件（不存在或读取失败返回 null）。 */
export declare function readBoundScript(libName: string, caseNo: string): string | null;
