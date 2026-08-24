export interface RepoResult {
    action: 'clone' | 'pull';
    dir: string;
    branch: string;
    commit: string;
    changedFiles: string[];
    changedCount: number;
    version: string;
    summary: string;
}
export interface RepoLib {
    id: number;
    name: string;
    repo_url: string;
    current_version: string;
    last_commit: string;
}
export interface RepoInspect {
    dir: string;
    bundleName: string;
    abilityName: string;
    pages: string[];
    entryDemo: string;
}
/** 工作区根目录（app.workspace 配置；未配置时落到插件进程 cwd/workspace）。 */
export declare function workspaceDir(): string;
/** 解析已克隆仓库工程：bundleName / mainAbility / 页面列表 / 入口页代码（供 AI 设计真实 UI 用例）。 */
export declare function inspectRepo(lib: {
    name: string;
}): RepoInspect;
/** 最近一次同步以来的仓库变更文件列表（用于用例更新上下文）。 */
export declare function recentChanges(lib: RepoLib): string[];
/** 仓库本地目录（工作区 repos/<name>）。 */
export declare function repoDirFor(name: string): string;
/** 自动化脚本落盘目录（工作区 scripts/<name>）。 */
export declare function scriptsDirFor(name: string): string;
/** 按仓库地址解析三方库：已存在（repo_url 匹配）则复用，否则自动创建。 */
export declare function ensureLibraryByRepoUrl(url: string): Promise<RepoLib>;
/** 解析仓库包名/主 Ability（app.json5 / module.json5）并回填 libraries 表。 */
export declare function refreshPackageInfo(lib: {
    id: number;
    name: string;
}): Promise<{
    packageName: string;
    mainAbility: string;
}>;
/** 拉取仓库：目录不存在则 clone，否则 pull；返回提交、分支、变更文件与版本。 */
export declare function pullRepo(lib: RepoLib): Promise<RepoResult>;
/** 更新仓库 = 拉取 + 变更文件明细。 */
export declare function updateRepo(lib: RepoLib): Promise<RepoResult>;
