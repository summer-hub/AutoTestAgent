/** 检测本机 Python 命令（python → python3）。 */
export declare function detectPython(): Promise<string | null>;
export interface HypiumRunResult {
    status: 'passed' | 'failed';
    log: string;
    reportDir?: string;
}
/** 运行单个 Hypium 模块并解析结果 XML（result/<module>.xml）。 */
export declare function runHypiumModule(pythonCmd: string, projDir: string, moduleStem: string, timeoutMs: number): Promise<HypiumRunResult>;
