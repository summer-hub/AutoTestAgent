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
/** 工作区根目录（app.workspace 配置；未配置时落到插件进程 cwd/workspace）。 */
export declare function workspaceDir(): string;
/** 拉取仓库：目录不存在则 clone，否则 pull；返回提交、分支、变更文件与版本。 */
export declare function pullRepo(lib: RepoLib): Promise<RepoResult>;
/** 更新仓库 = 拉取 + 变更文件明细。 */
export declare function updateRepo(lib: RepoLib): Promise<RepoResult>;
