import { DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts, type ResourceKind, type ResourceOrigin } from './contract.js';
export interface ResourceRow {
    id: number;
    resourceId: string;
    kind: ResourceKind;
    origin: ResourceOrigin;
    scopeKind: string;
    scopeKey: string;
    libraryId: number | null;
    generator: string;
    filePath: string;
    fileSha256: string;
    fileSize: number;
    validated: boolean;
    validProblems: string[];
    intent: string;
    reuseCount: number;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface RegisterInput {
    resourceId: string;
    kind: ResourceKind;
    origin: ResourceOrigin;
    /** 资源内容（合成资源直接给文本；仓库检出的由调用方读文件后传入） */
    content?: string;
    /** 或直接给文件路径（仓库检出） */
    filePath?: string;
    scopeKind?: 'global' | 'library_kind' | 'library';
    scopeKey?: string;
    libraryId?: number | null;
    generator?: string;
    intent?: string;
    /** 证书类资源的过期时间（ISO 或 yyyy-mm-dd） */
    expiresAt?: string | null;
}
/**
 * 登记一个资源。幂等：同 resource_id 已存在则更新（内容变了会记新版本），不新建行。
 */
export declare function registerResource(input: RegisterInput): Promise<{
    ok: boolean;
    id: number;
    problems: string[];
    versionBumped: boolean;
}>;
/** 把某类别的全部合成资源登记一遍（幂等；预设驱动）。 */
export declare function registerSyntheticForKind(kind: 'animation' | 'storage' | 'network' | 'codec' | 'ui_component'): Promise<{
    registered: number;
    problems: number;
    ids: string[];
}>;
/** 资源清单（可按类型/作用域过滤）。 */
export declare function listResources(opts?: {
    kind?: ResourceKind;
    scopeKey?: string;
    libraryId?: number;
}): Promise<ResourceRow[]>;
/** 记录一次复用（执行时调用；复用次数是"资源是否真有价值"的度量）。 */
export declare function bumpReuse(resourceId: string): Promise<void>;
/** 检出临期与临近期的证书资源（运维价值：避免某天测试突然全失败）。 */
export declare function expiringCerts(withinDays?: number): Promise<ResourceRow[]>;
/** 证书构造规格导出（供 gen-ca 脚本与上层使用）。 */
export { DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts };
/** 资源根目录（合成资源落盘处；随包目录之外，属工作区）。 */
export declare function resourceStoreRoot(): Promise<string>;
