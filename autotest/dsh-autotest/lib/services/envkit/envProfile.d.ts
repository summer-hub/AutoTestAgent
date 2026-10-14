import { transaction } from '../../db/connection.js';
export interface EnvProfile {
    id: number;
    libraryId: number;
    name: string;
    status: string;
    presetKind: string;
    toolchain: Record<string, unknown>;
    components: Record<string, unknown>;
    source: string;
    confidence: number;
}
export interface ProfileStep {
    seq: number;
    scriptId: string;
    params: Record<string, unknown>;
    required: boolean;
    skipIf: string;
}
/** 环境准备运行的步骤结果（落库形态）。 */
export interface StepOutcome {
    seq: number;
    scriptId: string;
    status: 'passed' | 'failed' | 'skipped';
    exitCode: number;
    failureKind: string;
    failureWhat: string;
    durationMs: number;
    artifacts: Array<{
        name: string;
        path: string;
        exists: boolean;
        size: number;
        sha256: string;
    }>;
    logPath: string;
}
export interface RunProfileResult {
    runId: number;
    runNo: string;
    status: 'passed' | 'failed' | 'cancelled' | 'cached';
    cachedFrom: number | null;
    steps: StepOutcome[];
    durationMs: number;
    error: string;
}
/**
 * 计算指纹：工具链 + 步骤序列 + 参数 + 代码 commit。
 * 任一变（换了 SDK、改了参数、代码更新）都应当重跑，所以全都要进哈希。
 */
export declare function fingerprintOf(profile: EnvProfile, steps: ProfileStep[], commit?: string): string;
/** 取画像的步骤序列（按 seq 升序）。 */
export declare function loadProfileSteps(profileId: number): Promise<ProfileStep[]>;
export interface RunProfileOptions {
    profileId: number;
    /** 触发来源：manual / plan / agent / batch */
    trigger?: string;
    /** 工作目录（通常是库的仓库目录）；缺省从画像所属库推导 */
    cwd?: string;
    /** 取消信号 */
    signal?: AbortSignal;
    /** 代码 commit（进指纹；不传则不因代码变化失效） */
    commit?: string;
    /** 是否允许复用已通过的 run；默认允许 */
    allowCache?: boolean;
    /** 日志根目录 */
    logRoot?: string;
    /** 发起人（审批记录用） */
    requestedBy?: string;
}
/**
 * 执行一次环境准备。
 *
 * 流程：建 run（pending）→ 查缓存（命中即 cached 返回）→ 逐 step 执行 →
 *       写 env_run_steps → 汇总 run 终态。
 * 永不抛异常（审批待批除外，那是 409 需要调用方转达给人的）：失败也是结果。
 */
export declare function runEnvProfile(opts: RunProfileOptions): Promise<RunProfileResult>;
/** 事务导入（供自检复用，避免每个用例各写一遍 BEGIN/COMMIT）。 */
export { transaction };
