/** 需求来源（§7.1：OneBox / 手工 / 导入）。 */
export type RequirementSource = 'manual' | 'onebox' | 'import';
export declare const REQUIREMENT_SOURCES: RequirementSource[];
export declare const REQUIREMENT_STATUSES: readonly ["active", "done", "closed", "dropped"];
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];
export interface RequirementRow {
    id: number;
    requirementNo: string;
    externalId: string;
    source: string;
    title: string;
    url: string;
    primaryLibraryId: number | null;
    status: string;
    priority: string;
    acceptanceMd: string;
    owner: string;
    createdAt: string;
    updatedAt: string;
}
export interface RequirementListItem extends RequirementRow {
    caseCount: number;
    prCount: number;
    /** 关联用例上最近 N 次执行中的失败数（"最近失败数"，§11.2 列表列） */
    recentFailed: number;
    /** 关联用例执行覆盖过的基线数（distinct baseline_id） */
    baselineCount: number;
}
export interface RequirementDetail extends RequirementListItem {
    cases: Array<{
        id: number;
        caseNo: string;
        name: string;
        status: string;
        relation: string;
    }>;
    prs: Array<{
        id: number;
        number: number;
        title: string;
        state: string;
    }>;
    scenarioAssets: Array<{
        id: number;
        assetNo: string;
        title: string;
        kind: string;
    }>;
}
export declare function nextRequirementNo(): Promise<string>;
export interface CreateRequirementInput {
    title: string;
    source?: RequirementSource;
    externalId?: string;
    url?: string;
    primaryLibraryId?: number | null;
    priority?: string;
    status?: RequirementStatus;
    acceptanceMd?: string;
    owner?: string;
}
export declare function createRequirement(input: CreateRequirementInput): Promise<RequirementRow>;
export declare function getRequirement(id: number): Promise<RequirementRow | null>;
export interface UpdateRequirementInput {
    title?: string;
    status?: RequirementStatus;
    priority?: string;
    url?: string;
    externalId?: string;
    acceptanceMd?: string;
    owner?: string;
}
export declare function updateRequirement(id: number, input: UpdateRequirementInput): Promise<RequirementRow>;
export declare function listRequirements(opts?: {
    libraryId?: number;
    status?: string;
    q?: string;
    limit?: number;
}): Promise<RequirementListItem[]>;
export declare function getRequirementDetail(id: number): Promise<RequirementDetail>;
/** 关联用例（§10.2 POST /requirements/:id/cases）。同库校验：需求有主库时用例不必同库（跨库需求存在），但用例必须存在。 */
export declare function linkRequirementCases(id: number, caseIds: number[], relation?: string): Promise<{
    linked: number;
}>;
export declare function unlinkRequirementCase(id: number, caseId: number): Promise<{
    removed: number;
}>;
/** 关联 PR（§10.2 POST /requirements/:id/prs → pr_requirements）。 */
export declare function linkRequirementPrs(id: number, prIds: number[]): Promise<{
    linked: number;
}>;
