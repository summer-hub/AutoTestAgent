import { type SheetProblem } from './librarySheet.js';
/** 定位随包表（不存在返回 null，调用方据此降级为"无种子"）。 */
export declare function bundledSheet(): {
    path: string;
    sha256: string;
} | null;
export interface CatalogRunResult {
    status: 'imported' | 'unchanged' | 'missing';
    /** 实际使用的那份表（数据目录里的路径优先，随包种子回填后也是它） */
    file: string;
    source: 'bundled' | 'data-dir' | 'configured';
    sha256: string;
    total: number;
    added: number;
    updated: number;
    unchanged: number;
    dbOnly: number;
    problems: SheetProblem[];
    /** 导入了但有问题行时的提示（启动日志用） */
    note: string;
}
/**
 * 启动 bootstrap：确保目录表已进业务库。**永不抛异常**——启动路径上任何失败都只能是告警。
 *
 * 幂等：同一份表（sha256 相同）且 diff 无变化时不写库、不留导入记录。
 */
export declare function ensureLibraryCatalog(): Promise<CatalogRunResult>;
export interface CatalogStatus {
    bundled: {
        exists: boolean;
        path: string;
        sha256: string;
    } | null;
    /** 数据目录里实际在用的那份表 */
    active: {
        file: string;
        exists: boolean;
        configured: string;
    };
    latest: {
        at: string;
        source: string;
        sha256: string;
        total: number;
        added: number;
        updated: number;
        unchanged: number;
        dbOnly: number;
        problems: number;
    } | null;
    problems: SheetProblem[];
    db: {
        libraries: number;
        profiled: number;
        unprofiled: number;
    };
}
/**
 * 供前端/agent 查询的目录状态。`profiled` 在 R0 恒为 0（env_profiles 表 R1 才建），
 * 这里做成**表不存在时自动降级为 0**——R1 加上表后这个接口无需改代码就会亮。
 */
export declare function catalogStatus(): Promise<CatalogStatus>;
