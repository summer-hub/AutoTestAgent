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
    logPath: string;
    /** 输出末尾若干行（给人快速看，不必开日志文件） */
    tail: string[];
    /** 参数回显（审计用：跑的时候到底传了什么） */
    command: string;
}
/** 把参数按契约顺序转成命令行 argv（数组传递，不经 shell 拼接）。 */
export declare function buildArgv(contract: ScriptContract, params: Record<string, unknown>): string[];
/** 执行单个脚本步骤。永不抛异常——失败也是结果（带 failureKind）。 */
export declare function runScriptStep(input: RunStepInput): Promise<RunStepResult>;
