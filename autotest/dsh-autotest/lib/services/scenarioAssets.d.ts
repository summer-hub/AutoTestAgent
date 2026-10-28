export type AssetKind = 'onebox_link' | 'demo_page' | 'fixture' | 'config' | 'mixed';
export type ScenarioKind = 'happy' | 'empty' | 'boundary' | 'bigdata' | 'general';
export declare const ASSET_KINDS: AssetKind[];
export declare const SCENARIO_KINDS: ScenarioKind[];
/** 本地文件资产（有 rel_dir + files）；onebox_link 只存链接与指导。 */
export declare const LOCAL_KINDS: AssetKind[];
export interface ScenarioAssetRow {
    id: number;
    asset_no: string;
    library_id: number;
    title: string;
    kind: string;
    scenario_kind: string;
    uri: string;
    rel_dir: string;
    entry_hint: string;
    config_guide_md: string;
    compat_json: string;
    status: string;
    version: string;
    sha256: string;
    validation_json: string;
    validated_at: string | null;
    created_by: string;
    created_at: string;
    updated_at: string;
}
export interface ScenarioAssetFileRow {
    id: number;
    asset_id: number;
    rel_path: string;
    sha256: string;
    size: number;
    role: string;
    created_at: string;
}
export declare function nextAssetNo(): Promise<string>;
export declare function nextSetNo(): Promise<string>;
/** 场景资产根目录：<workspace>/scenario-assets。 */
export declare function assetsRootDir(): string;
/**
 * 相对路径安全校验（设计 §10.6 注）：逐段拒绝 `..`、绝对路径、盘符、空段、.git；
 * 保留字 manifest.json / README.md（根级生成文件）不允许用户文件占用。
 */
export declare function safeRelPath(input: string): string;
interface ManifestCompat {
    minVersion?: string;
    maxVersion?: string;
    commit?: string;
}
export interface CreateAssetInput {
    libraryId: number;
    title: string;
    kind: AssetKind;
    scenarioKind?: ScenarioKind;
    uri?: string;
    entryHint?: string;
    configGuideMd?: string;
    compat?: ManifestCompat;
    createdBy?: string;
}
export declare function createAsset(input: CreateAssetInput): Promise<ScenarioAssetRow>;
export interface ListAssetsOpts {
    libraryId?: number;
    kind?: string;
    status?: string;
    scenarioKind?: string;
    q?: string;
}
export declare function listAssets(opts?: ListAssetsOpts): Promise<Array<ScenarioAssetRow & {
    library_name: string;
    file_count: number;
    case_count: number;
}>>;
export declare function getAssetDetail(id: number): Promise<{
    asset: ScenarioAssetRow & {
        library_name: string;
    };
    files: ScenarioAssetFileRow[];
    versions: Array<{
        id: number;
        version: string;
        sha256: string;
        note: string;
        created_at: string;
    }>;
    cases: Array<{
        case_id: number;
        case_no: string;
        name: string;
        role: string;
    }>;
    requirements: Array<{
        requirement_id: number;
        requirement_no: string;
        title: string;
    }>;
    runRefs: Array<{
        run_item_id: number;
        run_no: string;
        asset_id: number;
        version: string;
        apply_status: string;
        created_at: string;
    }>;
}>;
export interface UpdateAssetInput {
    title?: string;
    scenarioKind?: ScenarioKind;
    uri?: string;
    entryHint?: string;
    configGuideMd?: string;
    compat?: ManifestCompat;
}
export declare function updateAsset(id: number, input: UpdateAssetInput): Promise<ScenarioAssetRow>;
export interface AssetFileInput {
    path: string;
    contentBase64: string;
    role?: string;
}
export interface WriteFilesResult {
    asset: ScenarioAssetRow;
    written: Array<{
        path: string;
        sha256: string;
        size: number;
        role: string;
    }>;
    version: string;
    totalBytes: number;
}
/**
 * 写入/覆盖一批文件（base64），每次写入版本 +1 并落版本史（sha256 可查，设计 §15.5）。
 * 上传后 status 从 validated 回退 draft（内容变了，旧校验结论不再可信）。
 */
export declare function writeAssetFiles(id: number, files: AssetFileInput[], opts?: {
    note?: string;
    createdBy?: string;
}): Promise<WriteFilesResult>;
export declare function listAssetFiles(id: number): Promise<ScenarioAssetFileRow[]>;
export interface ValidateResult {
    ok: boolean;
    level: string;
    problems: string[];
    checks: Array<{
        name: string;
        ok: boolean;
        detail?: string;
    }>;
}
/**
 * 静态校验（设计 §8.5 第 1 级）：目录/manifest/README 存在、逐文件 sha256 与磁盘一致、manifest 与 DB 清单一致、大小限制。
 * compile/device 级暂未支持（返回 400），真机校验待 B4 执行器接入。
 */
export declare function validateAsset(id: number, level?: string): Promise<ValidateResult>;
export declare function linkCases(id: number, caseIds: number[], role?: string): Promise<{
    linked: number;
}>;
export declare function linkRequirements(id: number, requirementIds: number[]): Promise<{
    linked: number;
}>;
export declare function deprecateAsset(id: number): Promise<ScenarioAssetRow>;
/** 删除仅限 draft/deprecated 且无关联（用例/运行引用）—— 有关联必须走下架（保历史可追溯）。 */
export declare function removeAsset(id: number): Promise<{
    removed: boolean;
    dirRemoved: boolean;
}>;
export interface ApplyManifest {
    schemaVersion: 1;
    applied: boolean;
    mode: 'recorded';
    note: string;
    assetNo: string;
    version: string;
    sha256: string;
    uri: string;
    entryHint: string;
    configGuideMd: string;
    files: Array<{
        path: string;
        sha256: string;
        size: number;
        role: string;
    }>;
    recordedAt: string;
}
/** 手工"应用到运行"（§10.6 /apply）：当前为登记制 —— 写 run_item_assets（幂等）。 */
export declare function applyAssetToRunItem(assetId: number, runItemId: number): Promise<{
    assetNo: string;
    version: string;
    applyStatus: string;
}>;
export interface ResourceSetRow {
    id: number;
    set_no: string;
    library_id: number;
    name: string;
    manifest_json: string;
    created_at: string;
    updated_at: string;
}
/**
 * 运行开始时为某库 run item 收集关联场景资产（§8.7 资源集合）：
 *  - 按"资产关联的用例 ∈ 本次运行用例集"筛选，同库、未下架；
 *  - 建 test_resource_sets + items（版本/sha 快照）；
 *  - 写 run_item_assets（apply_status='recorded'，登记制）；
 *  - 回填 test_run_items.resource_set_id / test_runs.resource_set_id。
 * 无关联资产返回 null（大多数运行没有场景资产，不产生空资源集）。
 */
export declare function recordRunItemAssets(runId: number, runItemId: number, libraryId: number, caseIds: number[], runNo: string): Promise<{
    setId: number;
    setNo: string;
    assetCount: number;
} | null>;
export declare function getResourceSet(id: number): Promise<{
    set: ResourceSetRow;
    items: Array<{
        id: number;
        kind: string;
        ref_id: number;
        version: string;
        role: string;
        sha256: string;
        created_at: string;
    }>;
}>;
/** stored（不压缩）zip 打包：服务端零依赖，条目数有限（≤100 文件），体积换简单性。 */
export declare function buildZipStored(entries: Array<{
    name: string;
    data: Buffer;
}>): Buffer;
/** 打包资产为 zip（文件 + manifest.json + README.md），供下载路由。 */
export declare function buildAssetZip(id: number): Promise<Buffer>;
/**
 * 把资产文件复制到目标目录（不改基线，§8.4 copy 语义）。
 * 逐文件校验 sha256 后复制；任何缺失/漂移直接抛错 —— 调用方必须把失败显式标记为"资源未应用"。
 */
export declare function applyAssetToDir(assetId: number, destDir: string): Promise<{
    assetNo: string;
    version: string;
    sha256: string;
    copied: Array<{
        path: string;
        sha256: string;
    }>;
}>;
export {};
