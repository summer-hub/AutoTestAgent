import type { LibraryFacts, LibraryKind } from './facts.js';
export interface PresetComponent {
    /** 二进制依赖（.so/.a）：含 ABI 与"预编译 or 现编"决策位 */
    binaryDeps?: Array<{
        name: string;
        abi?: string;
        artifactUrl?: string;
        buildIfMissing?: boolean;
        note?: string;
    }>;
    /** ohpm 依赖（除工程自带外的补充） */
    ohpmPackages?: Array<{
        name: string;
        version?: string;
        source?: string;
    }>;
    /** 文件配置模板（权限声明、rawfile、build-profile 片段） */
    fileConfigs?: Array<{
        path: string;
        template: string;
        vars?: Record<string, string>;
    }>;
    /** git 子模块 */
    submodules?: Array<{
        path: string;
        url?: string;
        required?: boolean;
    }>;
}
export interface PresetStep {
    scriptId: string;
    /** 参数；值里的 {{repoDir}} 在环境准备运行时替换为实际仓库目录 */
    params?: Record<string, unknown>;
    required?: boolean;
}
export interface PresetOracle {
    type: string;
    note: string;
}
export interface PresetResource {
    kind: string;
    /** 合成资源的建议 id，或上游 canonical 来源 */
    id?: string;
    origin: 'repo_scan' | 'canonical' | 'synthesized';
    note: string;
}
export interface Preset {
    kind: LibraryKind;
    label: string;
    /** 工具链要求（semver 串，供 env_profiles.toolchain 与 applies_when 用） */
    toolchain: Record<string, string>;
    components: PresetComponent;
    steps: PresetStep[];
    oracles: PresetOracle[];
    resources: PresetResource[];
    /** 已知问题入口（人写，AI 检索） */
    knownIssues?: string[];
}
/**
 * 预设根目录。
 *
 * Windows 坑（rules/windows-nodejs-pitfalls）：必须用 fileURLToPath，
 * 不能用 `new URL(import.meta.url).pathname`——后者在 Windows 返回 "/D:/..."
 * （前导斜杠），拼出的路径会变成 "D:\D:\..."（盘符翻倍）。R1 的 runner.ts 实测踩过。
 */
export declare function presetsRoot(): string;
/** 有哪些类别的预设可用（自检与「全量分析」页展示）。 */
export declare function availablePresetKinds(): LibraryKind[];
/** 读取某类别的预设（不存在返回 null；JSON 坏则抛错——坏预设必须被发现，不能静默跳过）。 */
export declare function loadPreset(kind: LibraryKind): Preset | null;
export interface ProfileStepSpec {
    scriptId: string;
    params: Record<string, unknown>;
    required: boolean;
}
/**
 * 把预设步骤转成画像步骤，并按 facts 填充差异参数。
 *
 * 关键点：`projectDir` 等运行时才知道的值用 `{{repoDir}}` 占位，
 * 由 runEnvProfile 在执行时替换——否则预设就得知道每个库 clone 到哪，
 * 而那是运行时事实，不该固化进预设。
 */
export declare function presetStepsToProfileSteps(preset: Preset, facts: LibraryFacts): ProfileStepSpec[];
/**
 * 按 facts 生成画像的 components 段。
 * 预设给骨架，facts 填实测值——这样同一类库的画像"结构相同、内容各异"。
 */
export declare function presetComponentsFor(preset: Preset, facts: LibraryFacts): PresetComponent;
