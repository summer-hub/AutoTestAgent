/** 库类别（preset 的目录名与此一一对应）。 */
export declare const LIBRARY_KINDS: readonly ["animation", "network", "storage", "codec", "ui_component", "crypto", "unknown"];
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export declare const KIND_LABEL: Record<LibraryKind, string>;
export interface ResourceCandidate {
    /** 资源种类：动画 json / 证书 / 服务端 fixture / 数据库 fixture / 图片 / 音视频 / 配置文件 */
    kind: 'animation_json' | 'ca_cert' | 'server_fixture' | 'db_fixture' | 'image' | 'media' | 'config';
    /** 仓库内相对路径（repo_scan 来源）或合成资源的建议 id */
    ref: string;
    origin: 'repo_scan' | 'synthesized';
    /** 为什么认为它是测试资源（可核对的依据） */
    reason: string;
    sizeBytes: number;
}
export interface ReadmeIntel {
    kind: 'dependency' | 'build_cmd' | 'prerequisite' | 'known_issue' | 'sample_asset';
    /** README 里的原文片段（人可回查） */
    text: string;
    line: number;
}
/** scanRepo() 采集来的原始材料（IO 与纯函数的分界）。 */
export interface RawRepoScan {
    /** 仓库内相对路径（不含 .git / node_modules / oh_modules / build） */
    files: string[];
    /** README 原文（README.md / readme.md / README-zh.md 拼接） */
    readme: string;
    /** oh-package.json5 解析结果 */
    ohPackage: {
        name: string;
        version: string;
        dependencies: Record<string, string>;
    } | null;
    /** build-profile.json5 解析结果 */
    buildProfile: {
        modules: string[];
        bundleName: string;
        apiLevel: string;
    } | null;
    /** .gitmodules 原文（空串=无子模块） */
    gitmodules: string;
    /** 二进制产物相对路径（*.so / *.a / *.lib） */
    binaryFiles: string[];
    /** 库名（用于名称信号） */
    libraryName: string;
}
export interface LibraryFacts {
    kind: LibraryKind;
    kindReason: string;
    /** 0-100：强信号 85、强+弱叠加 95、仅弱信号 55 */
    confidence: number;
    buildTarget: 'har' | 'hap' | 'unknown';
    hasSubmodules: boolean;
    hasBinary: boolean;
    binaryKinds: string[];
    hasDemo: boolean;
    entryFile: string;
    readmeChars: number;
    facts: {
        ohpmDeps: string[];
        moduleNames: string[];
        apiLevel: string;
        fileCount: number;
        hasHvigorw: boolean;
        hasEtsPages: number;
    };
    resourceCandidates: ResourceCandidate[];
    readmeIntel: ReadmeIntel[];
    /** 需要 LLM 介入的原因（空 = 不需要，L1 预设可直接命中） */
    needsLlm: string[];
}
/** 从 README 里抽取结构化情报（依赖/构建命令/前置条件/已知问题/样本资源）。 */
export declare function extractReadmeIntel(readme: string): ReadmeIntel[];
/**
 * 判定库类别（纯函数，可逐条核对）。
 *
 * 返回 reason 是为了让"为什么判成 animation"可解释——分类结果是 preset 选择的依据，
 * 不可解释的分类等于让人盲信。
 */
export declare function classifyKind(scan: RawRepoScan): {
    kind: LibraryKind;
    reason: string;
    confidence: number;
};
/** 从原始扫描构建完整事实（纯函数）。 */
export declare function buildLibraryFacts(scan: RawRepoScan): LibraryFacts;
/** 是否有对应 preset（L1 能否直接命中）。presets 目录由 resourcekit/preset 注册表提供。 */
export declare function presetKindFor(kind: LibraryKind): LibraryKind | null;
