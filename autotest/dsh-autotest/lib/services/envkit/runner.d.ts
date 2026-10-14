import { type ScriptContract } from './contract.js';
/** 脚本资产的根目录（随包分发；构建时由 scripts/build-assets.mjs 复制进 lib/assets/env/）。 */
export declare function envScriptsRoot(): string;
/** 按 OS 选入口文件：契约 entry 不含后缀，这里补 .ps1 / .sh。 */
export declare function resolveEntry(contract: ScriptContract): {
    file: string;
    exists: boolean;
    shell: string[];
};
export interface RunStepInput {
    contract: ScriptContract;
    /** 已按契约解析并填充默认值的参数 */
    params: Record<string, unknown>;
    /** 工作目录（通常是库的仓库目录） */
    cwd: string;
    /** 取消信号（任务 lane / 批次取消时触发） */
    signal?: AbortSignal;
    /** 日志目录（不存在则创建）；不传则不落盘（自检里用） */
    logDir?: string;
    /** 超时毫秒（缺省用契约的 timeout_sec） */
    timeoutMs?: number;
}
export interface ArtifactInfo {
    name: string;
    path: string;
    exists: boolean;
    size: number;
    sha256: string;
}
export interface RunStepResult {
    ok: boolean;
    exitCode: number;
    failureKind: string;
    failureWhat: string;
    matched?: string;
    inTaxonomy: boolean;
    durationMs: number;
    artifacts: ArtifactInfo[];
    /**
     * 脚本声明的**标量输出**（从 stdout 的 `KEY=value` 行解析）。
     * 这是步骤间串联的桥梁：build_hap 输出 HAP_PATH=/x/y.hap，
     * 后续 hdc_install 的 hapPath 参数就能写 {{hapPath}} 引用它。
     * 键已归一成小驼峰（HAP_PATH → hapPath），与契约的入参名对齐。
     */
    outputs: Record<string, string>;
    logPath: string;
    /** 输出末尾若干行（给人快速看，不必开日志文件） */
    tail: string[];
    /** 参数回显（审计用：跑的时候到底传了什么） */
    command: string;
}
/**
 * 把参数按契约顺序转成命令行 argv（数组传递，不经 shell 拼接）。
 *
 * ⚠️ 跨平台参数前缀是**实测踩过的坑**：Windows PowerShell 5.1 只认 `-paramName`
 * （单横杠、大小写不敏感），**不认** `--param-name`；而 bash 只认 `--param-name`。
 * 统一发 `--kebab-case` 会让所有 .ps1 脚本参数绑定失败、以退出码 1 结束，
 * 进而被误归类成"业务失败但未归类"——根因在错误信息里看不出来。
 * 所以这里按入口类型分流：ps1 用 `-name`，sh 用 `--kebab-name`。
 */
export declare function buildArgv(contract: ScriptContract, params: Record<string, unknown>, opts?: {
    powershell?: boolean;
}): string[];
/**
 * 从脚本输出里解析 `KEY=value` 行（步骤间串联的桥梁）。
 *
 * 约定（各 env 脚本统一遵守）：关键产物用 `UPPER_SNAKE=值` 的形式打到 stdout，
 * 例如 build_hap 打 `HAP_PATH=/x/y.hap`、build_manifest 打 `BUNDLE_NAME=com.x`。
 * 这里把它们归一成小驼峰（HAP_PATH → hapPath），与契约入参名对齐，
 * 后续步骤的参数就能写 `{{hapPath}}` 引用。
 *
 * 只认"整行都是 KEY=value"的行，避免把日志里的 `error=xxx` 也当输出。
 */
export declare function parseScalarOutputs(tail: string[]): Record<string, string>;
/** 执行单个脚本步骤。永不抛异常——失败也是结果（带 failureKind）。 */
export declare function runScriptStep(input: RunStepInput): Promise<RunStepResult>;
