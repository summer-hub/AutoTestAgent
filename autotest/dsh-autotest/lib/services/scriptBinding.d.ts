export type BindingStatus = 'fresh' | 'stale' | 'manual' | 'broken';
export declare const BINDING_LABEL: Record<BindingStatus, string>;
export declare const BINDING_COLOR: Record<BindingStatus, string>;
/** 脚本内容哈希（判断"人为改过"）。 */
export declare function hashScript(content: string): string;
/**
 * 状态判定（纯函数，可离线单测）。
 *
 * 优先级是刻意的：**文件丢了/没断言 > 人工改过 > 用例升版 > 最新**。
 * 把 manual 排在 stale 之前，是因为"人为改过"意味着脚本已经不是生成的产物了，
 * 这时候提示"可能过期"会误导人直接点重新生成、把手改的内容覆盖掉。
 */
export declare function computeBindingStatus(input: {
    caseVersion: number;
    boundVersion: number;
    fileExists: boolean;
    hasAssertion: boolean;
    currentHash: string;
    boundHash: string;
    confirmedVersion?: number | null;
}): {
    status: BindingStatus;
    reason: string;
};
export interface BindingRow {
    caseId: number;
    caseNo: string;
    caseName: string;
    caseVersion: number;
    libraryId: number;
    libraryName: string;
    scriptPath: string;
    scriptHash: string;
    moduleStem: string;
    status: BindingStatus;
    statusReason: string;
    lastRunStatus: string;
    lastRunAt: string | null;
    confirmedAt: string | null;
    updatedAt: string;
    fileExists: boolean;
}
/** 读出某库全部绑定并**在每个条目上重新判定状态**（状态是算出来的，不是存在库里的快照）。 */
export declare function listBindings(libraryId: number): Promise<BindingRow[]>;
/** 全库重算状态并落库（前端列表直接读 status 列时可省一次计算；判定逻辑仍以 judge 为准）。 */
export declare function refreshBindingStatuses(libraryId: number): Promise<{
    total: number;
    byStatus: Record<string, number>;
}>;
export interface BindResult {
    ok: boolean;
    binding?: BindingRow;
    reason?: string;
    unmappedStep?: {
        index: number;
        step: string;
    };
}
/**
 * 生成（或重新生成）脚本并写入绑定。
 *
 * 三种失败都必须**明确回报而不是留一个旧绑定**：
 *   - 步骤无法映射 → UnmappedStepError（不再产出注释行）
 *   - 脚本无断言 → NoAssertionError（拒绝绑定）
 *   - 用例没人手脚本工程 → 由 writeCaseScript 抛错
 */
export declare function bindCaseScript(caseId: number, opts?: {
    force?: boolean;
}): Promise<BindResult>;
/** 三个动作之一：保留脚本并标记已确认（之后不再提示过期，直到用例再次升版）。 */
export declare function confirmBinding(caseId: number): Promise<{
    ok: boolean;
    binding?: BindingRow;
}>;
/** 三个动作之三：解除绑定（删除绑定记录与脚本文件）。 */
export declare function unbindCaseScript(caseId: number, opts?: {
    removeFile?: boolean;
}): Promise<{
    ok: boolean;
    removedFile: string;
}>;
/** 执行结果回写（用于 flaky 识别与"脚本到底跑没跑过"）。 */
export declare function recordScriptRun(caseId: number, status: string): Promise<void>;
/**
 * 用例升版时联动：把该用例绑定标为 stale（若脚本没被人工改过）。
 * 由用例更新路径调用，保证"用例改了 → 脚本立刻被标可能过期"。
 */
export declare function markBindingStaleOnCaseBump(caseId: number, newVersion: number): Promise<void>;
/** Hypium 工程里脚本所在目录（前端展示/打开用）。 */
export declare function scriptDirFor(libName: string): string;
