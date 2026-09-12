/** 优先使用「装了 hypium 的解释器」，其次再退回普通 python。 */
export interface PythonProbe {
    /** 命令（可含参数，如 `py -3.10`）以空格分隔 */
    parts: string[];
    /** 展示用命令名 */
    cmd: string;
    version: string;
    hasHypium: boolean;
}
/** 探测本机可用的解释器清单（按优先级，含 hypium 可用性）。 */
export declare function probePythons(): Promise<PythonProbe[]>;
/**
 * 检测可用于执行 Hypium 脚本的 Python 命令。
 *
 * **优先返回装了 hypium 的解释器**；若一个都没有，则返回 null（调用方据此如实失败）。
 * 不返回"能跑但没有 hypium"的解释器——那只会让脚本跑到 `import hypium` 才炸，
 * 报错信息还指向脚本而不是环境（用户看到的是 ModuleNotFoundError，难以定位）。
 */
export declare function detectPython(): Promise<string | null>;
/** 探测结果的**人类可读**说明：用于失败时写清"到底缺什么"，而不是笼统一句"未检测到 Python"。 */
export declare function describePythonProbe(found: PythonProbe[]): string;
export interface HypiumRunResult {
    status: 'passed' | 'failed';
    log: string;
    reportDir?: string;
}
/** 运行单个 Hypium 模块并解析结果 XML（result/<module>.xml）。 */
export declare function runHypiumModule(pythonCmd: string, projDir: string, moduleStem: string, timeoutMs: number): Promise<HypiumRunResult>;
