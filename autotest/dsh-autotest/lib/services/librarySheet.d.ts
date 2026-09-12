/** 表里的一行（已归一化）。 */
export interface SheetEntry {
    /** xlsx 行号（1-based，含表头），用于把问题定位回人能看到的那一行 */
    row: number;
    name: string;
    /** 归一化后的仓库根地址（去 /tree/...、补 .git）；空串=表里 URL 缺失 */
    repoUrl: string;
    /** 库在仓库内的子目录（从 /tree/<分支>/<子目录> 拆出） */
    repoSubpath: string;
}
export interface SheetProblem {
    row: number;
    name: string;
    reason: string;
}
export interface ParseResult {
    entries: SheetEntry[];
    problems: SheetProblem[];
    /** 命中的表头行号与列位置（列顺序变了也能读） */
    header: {
        row: number;
        nameCol: number;
        urlCol: number;
    } | null;
}
export interface LibrarySyncPlan {
    added: Array<{
        name: string;
        repoUrl: string;
        repoSubpath: string;
        row: number;
    }>;
    updated: Array<{
        id: number;
        name: string;
        from: {
            repoUrl: string;
            repoSubpath: string;
        };
        to: {
            repoUrl: string;
            repoSubpath: string;
        };
        row: number;
    }>;
    unchanged: Array<{
        id: number;
        name: string;
        row: number;
    }>;
    /** 库里有、表里没有 —— 只报告，不自动删除（删库会级联删用例/任务/执行历史） */
    dbOnly: Array<{
        id: number;
        name: string;
        repoUrl: string;
        repoSubpath: string;
        packageName: string;
        caseCount: number;
    }>;
    problems: SheetProblem[];
}
/**
 * 定位表头行与列。人的表会加标题行、调列序，所以按**表头名**找而不是写死 A/B，
 * 找不到表头时退回「第一行是表头、前两列分别是库名与 URL」这个最常见的排布。
 */
export declare function findHeader(rows: unknown[][]): {
    row: number;
    nameCol: number;
    urlCol: number;
} | null;
/**
 * 把表格二维数组解析成库清单。
 * 会跳过的行都进 problems（带行号），不做静默丢弃 —— 269 行里少一行必须看得见。
 */
export declare function parseLibrarySheet(rows: unknown[][]): ParseResult;
export interface ExistingLibrary {
    id: number;
    name: string;
    repo_url: string;
    repo_subpath: string;
    package_name: string;
    case_count?: number;
}
/** 计算同步计划（纯函数：给同一份表与库表，结果永远一致，便于预览与实际执行对齐）。 */
export declare function diffLibrarySheet(entries: SheetEntry[], existing: ExistingLibrary[], problems?: SheetProblem[]): LibrarySyncPlan;
/**
 * 表文件路径解析：**显式指定的路径优先且不兜底**。
 *
 * 「指定了文件但文件不在」必须报错，不能悄悄换一个文件去同步 ——
 * 否则人会以为同步的是自己刚改的那份表，实际同步的是另一个目录里的旧文件，
 * 269 个库整批写错却毫无提示（这个坑自检里已经踩到过一次）。
 */
export declare function resolveSheetPath(explicit?: string): {
    file: string;
    exists: boolean;
    tried: string[];
};
/** 读取 xlsx 并解析出库清单（不含 DB 交互）。 */
export declare function readSheet(file: string): ParseResult & {
    file: string;
};
/**
 * 同步：读表 → 与库表比对 → （可选）落库。
 * apply=false 时只返回计划（预览），不写任何数据 —— 269 行的批量写入必须先让人看过。
 */
export declare function syncLibrariesFromSheet(opts?: {
    file?: string;
    apply?: boolean;
}): Promise<{
    file: string;
    total: number;
    plan: LibrarySyncPlan;
    applied: boolean;
    header: ParseResult['header'];
}>;
/**
 * 反向导出：把「库里的事实」写成一份**新文件**，供人查看 Agent 补了什么。
 * 绝不写回人维护的那份表 —— xlsx 是人的东西，工具不去改它。
 */
export declare function exportLibrariesSheet(outFile?: string): Promise<{
    file: string;
    rows: number;
}>;
