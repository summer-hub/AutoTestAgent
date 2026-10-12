export type SkillTrust = 'verified' | 'tampered' | 'unlocked' | 'missing';
export interface SkillLockStatus {
    name: string;
    status: SkillTrust;
    expectedDigest: string;
    actualDigest: string;
    changedFiles: string[];
}
export interface SkillLockReport {
    /** skills 目录绝对路径；未部署（插件安装形态且未随包）为 null */
    root: string | null;
    lockFile: string | null;
    /** skills.lockEnforce 设置值 */
    enforce: boolean;
    checked: number;
    verified: number;
    tampered: string[];
    unlocked: string[];
    missing: string[];
    skills: SkillLockStatus[];
}
/** skills 目录解析（覆盖部署形态，见文件头）。 */
export declare function skillsRoot(): string | null;
/** 全量校验（启动时打一次摘要；GET /skills 按需查）。 */
export declare function verifySkillLock(): SkillLockReport;
/** enforce 模式下判定技能是否可信任（verified 才放行）。 */
export declare function isSkillTrusted(name: string): boolean;
/** 启动摘要（两个入口各调一次；不静默）。 */
export declare function logSkillLockSummary(): void;
