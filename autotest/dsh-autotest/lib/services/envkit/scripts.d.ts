import { type ScriptContract, type ContractProblem } from './contract.js';
export interface ScriptRow {
    id: string;
    summary: string;
    version: string;
    contract: ScriptContract;
    contractJson: string;
    entryJson: string;
    sha256: string;
    approval: string;
    enabled: boolean;
    builtin: boolean;
    updatedAt: string;
}
/** 全量脚本（内置 + DB 覆盖合并，DB 优先）。 */
export declare function listScripts(): Promise<ScriptRow[]>;
/** 取单个脚本（DB 覆盖优先，否则内置）。 */
export declare function getScript(id: string): Promise<ScriptRow | null>;
/** 把内置脚本播种进 DB（幂等：INSERT IGNORE，人改过的行不动）。 */
export declare function seedBuiltinScripts(): Promise<{
    inserted: number;
    total: number;
}>;
export interface ScriptValidationReport {
    total: number;
    valid: number;
    problems: Array<{
        id: string;
        problems: ContractProblem[];
    }>;
}
/** 校验全部脚本的契约（供自检与「脚本库」页展示）。 */
export declare function validateAllScripts(): Promise<ScriptValidationReport>;
/** 契约漂移检测：DB 里的 sha256 与当前契约算出来的是否一致（升级后契约变了会被抓到）。 */
export declare function detectContractDrift(): Promise<Array<{
    id: string;
    stored: string;
    current: string;
}>>;
