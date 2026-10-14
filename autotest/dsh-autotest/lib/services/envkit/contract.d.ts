/** 失败分类（failure_taxonomy 的取值域）。归类决定"人该做什么"，不是给人看的一行错误。 */
export declare const FAILURE_KINDS: readonly ["network", "permission", "toolchain_missing", "sdk_version_conflict", "compile_error", "missing_dep", "device_offline", "artifact_not_found", "timeout", "cancelled", "unknown"];
export type FailureKind = (typeof FAILURE_KINDS)[number];
/** 退出码归一化：脚本各自定义退出码，平台只认这四个。 */
export declare const EXIT_CODES: {
    readonly OK: 0;
    readonly BIZ_FAILED: 1;
    readonly ENV_MISSING: 2;
    readonly TIMEOUT: 3;
    readonly CANCELLED: 4;
};
/** 工具链探测：这些命令不存在 → ENV_MISSING，不该往 compile_error 里归。 */
export declare const TOOLCHAIN_BINS: string[];
export type ParamType = 'string' | 'path' | 'number' | 'boolean' | 'enum';
export interface ParamSpec {
    name: string;
    type: ParamType;
    required?: boolean;
    default?: string | number | boolean;
    /** enum 取值域 */
    values?: string[];
    description?: string;
}
export interface ArtifactSpec {
    name: string;
    type: 'path' | 'string' | 'number';
    description?: string;
}
export interface AppliesWhen {
    os?: Array<'windows' | 'linux' | 'darwin'>;
    /** 最低 SDK/工具链版本（语义化，形如 "4.1"） */
    sdk_min?: string;
    library_kind?: string[];
}
export interface ScriptContract {
    id: string;
    summary: string;
    /** 相对 scripts/env/ 的入口（不含平台相关后缀，runner 按 os 选 .ps1/.sh） */
    entry: string;
    inputs: ParamSpec[];
    outputs: ArtifactSpec[];
    applies_when: AppliesWhen;
    failure_taxonomy: FailureKind[];
    idempotent: boolean;
    timeout_sec: number;
    approval: 'none' | 'operator' | 'admin';
    version: string;
}
export interface ContractProblem {
    path: string;
    reason: string;
}
/**
 * 校验契约。返回问题清单（空 = 合法）。
 *
 * 为什么要这么严：契约是 runner 的唯一依据，id 冲突会让两个脚本互相顶掉；
 * failure_taxonomy 漏了 timeout，超时就会被归成 unknown（人不知道该修什么）；
 * 输出不声明 path，产物采集就无从判断"到底该有什么文件"。
 */
export declare function validateContract(c: ScriptContract): ContractProblem[];
/** 契约内容哈希（供供应链锁与版本比对；与 skills-lock 同思路）。 */
export declare function contractFingerprint(c: ScriptContract): string;
/**
 * 按入参填充默认值并做类型校验（不执行脚本，只校验）。
 * 返回 { ok, params, problems }——params 已含默认值，可直接交给 runner。
 */
export declare function resolveParams(c: ScriptContract, given: Record<string, unknown>): {
    ok: boolean;
    params: Record<string, unknown>;
    problems: string[];
};
