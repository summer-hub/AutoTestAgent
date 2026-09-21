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
    /** 库在仓库内的子目录（单体仓专用）；仓库根库为空串 */
    repo_subpath?: string;
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
/**
 * 工作区根目录，优先级：`AUTOTEST_WORKSPACE` 环境变量 > 系统配置 `app.workspace` > 启动目录下的 workspace。
 *
 * 环境变量优先是给**自检与 CI** 用的（与 `AUTOTEST_DATA_DIR` 同一套约定）：
 * 自检必须能在临时目录里跑，绝不能碰使用者真实工作区里的仓库与知识库。
 */
export declare function workspaceDir(): string;
/** 工作区是否已在系统配置中显式设置。 */
export declare function workspaceConfigured(): boolean;
/** 未配置工作区（或配置来自旧种子默认值）时的提示语；正常配置返回 null。 */
export declare function workspaceNotice(): string | null;
/** 运行中对账：仓库目录被删除时清空库的同步状态（首页/用例页不再残留过期信息）。 */
export declare function reconcileRepos(): Promise<number>;
/**
 * 启动数据迁移：把历史库行里自带 `/tree/<分支>/<子目录>` 的仓库地址拆成
 * 「仓库根 URL + repo_subpath」两列。
 *
 * 不做这一步，单体仓子目录库（三方库表里占 171/269）会一直踩两个坑：
 * `inspectRepo` 只看仓库根 → 包名永远解析不到；克隆按库名落到 `repos/<库名>` → 同仓各存一份。
 * 只改写"确实能拆出子目录"的行，其余不动。
 */
export declare function migrateRepoSubpaths(): Promise<number>;
/** 在「可取消的 git 操作」上下文里执行 fn（任务 lane 取消时中断 clone/pull 等子进程）。 */
export declare function withGitSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T>;
/**
 * 从仓库 URL 切出「仓库根 URL」与「库在仓库内的子目录」。
 *
 * 三方库表里大量出现单体仓子目录地址（`.../openharmony_tpc_samples/tree/master/json-schema`）。
 * 必须把这两件事拆开，否则：
 *   - 仓库会按**库名**克隆，168 个同仓的库各存一份 591MB（≈97GB）；
 *   - `inspectRepo` 只看仓库根，子目录库永远解析不到 bundleName（实测 json-schema 包名一直为空）；
 *   - 用单体仓根目录当"库目录"，接口提取会把 250 个样本的导出符号混成同一个库的接口面。
 */
export declare function splitRepoUrl(url: string): {
    repoUrl: string;
    subpath: string;
    branch: string;
};
/**
 * 子目录安全归一化：先解一层 URL 编码，再去掉盘符/前导分隔符，并逐段剔除 `..`。
 *
 * 这里是**目录穿越的防线**：库目录 = 仓库根 + 本函数结果，一旦 `..` 漏过去就能读写工作区外的文件。
 * 先解码是必要的：地址里可能写成 `..%2F..%2Fsecret`，若不解码就变成一个看似普通的目录名，
 * 而同一路径从「URL」与从「显式字段」进来会得到两个不同的库目录（同一子目录被克隆两次）。
 */
export declare function normalizeSubpath(sub: string): string;
/** 仓库检出目录：按**仓库名**共享（同仓的多个库只有一份克隆）。 */
export declare function repoRootDir(repoUrl: string): string;
/** 库目录 = 仓库根 + 库子目录；未配仓库地址时退回按库名定位（历史行为）。 */
export declare function repoDirFor(lib: {
    name: string;
    repo_url?: string;
    repo_subpath?: string;
}): string;
/**
 * 定位仓库检出目录，并顺手纠正历史命名。
 *
 * 旧版把单体仓按**库名**克隆到 `repos/json-schema`（内容其实是整个 openharmony_tpc_samples）。
 * 这里若确认"某个按库名命名的目录就是本库的仓库"，就改名到规范的 `repos/<owner>_<repo>`，
 * 让同仓的库直接复用（同卷改名是瞬时的，不复制数据）；改名失败则就地使用，不回退成重新克隆。
 *
 * 「就是本库的仓库」有两条判据，任一成立即可：
 *   ① 本地 remote 与目标地址一致；
 *   ② 本地 HEAD 与库表记录的 last_commit 一致 —— 这条是为**仓库换了组织/地址但内容没变**准备的
 *      （三方库测试表把地址从 `openharmony-tpc/x` 改成了 `CPF-ApplicationTPC/x`，其实是同一个仓库）。
 *      没有它，一次普通同步就会对着同一份代码再克隆 591MB。
 */
export declare function resolveRepoRootDir(repoUrl: string, legacyNames?: string[], expectedCommit?: string): string;
/** 保留旧签名（只给库名）时的便捷包装：库行里没有 repo_url 时用它。 */
export declare function repoRootForLib(lib: RepoLib | {
    name: string;
    repo_url?: string;
    repo_subpath?: string;
    last_commit?: string;
}): string;
/**
 * 解析已克隆仓库工程：bundleName / mainAbility / 页面列表 / 入口页代码（供 AI 设计真实 UI 用例）。
 * 用 `repoRootForLib` 而不是直接的规范路径：它会顺带把历史命名的克隆目录改名认领过来
 * （否则刚同步过地址的库会「解析不到包名」，因为代码其实在旧目录里）。
 */
export declare function inspectRepo(lib: {
    name: string;
    repo_url?: string;
    repo_subpath?: string;
    last_commit?: string;
}): RepoInspect;
/** 最近一次同步以来的仓库变更文件列表（用于用例更新上下文）。 */
export declare function recentChanges(lib: RepoLib): string[];
/** 自动化脚本落盘目录（工作区 scripts/<name>）。 */
export declare function scriptsDirFor(name: string): string;
/**
 * 仓库 URL 规范化：剥离网页浏览路径段，得到可 clone 的仓库根地址。
 *  - `https://host/owner/repo/tree/master/subdir` → `https://host/owner/repo.git`
 *  - `https://host/owner/repo/blob/master/file.md` → `https://host/owner/repo.git`
 *  - 仅对 gitcode/github/gitee/gitlab 等平台补 `.git`（ssh/本地路径不补）
 */
export declare function normalizeRepoUrl(url: string): string;
/** 按仓库地址解析三方库：已存在（repo_url 匹配）则复用，否则自动创建。 */
export declare function ensureLibraryByRepoUrl(url: string): Promise<RepoLib>;
/** 解析仓库包名/主 Ability（app.json5 / module.json5）并回填 libraries 表。 */
export declare function refreshPackageInfo(lib: {
    id: number;
    name: string;
    repo_url?: string;
    repo_subpath?: string;
}): Promise<{
    packageName: string;
    mainAbility: string;
}>;
/** 拉取仓库：目录不存在则 clone，否则 pull；返回提交、分支、变更文件与版本。 */
export declare function pullRepo(lib: RepoLib): Promise<RepoResult>;
/** 更新仓库 = 拉取 + 变更文件明细。 */
export declare function updateRepo(lib: RepoLib): Promise<RepoResult>;
