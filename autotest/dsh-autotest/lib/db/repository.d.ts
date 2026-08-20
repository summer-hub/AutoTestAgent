export declare function shardCount(): number;
/** library_id → 分片号（确定性、均匀）。 */
export declare function shardOf(libraryId: number): number;
/** 该库用例所在表名（dev 单表；生产可返回 cases_{shard}）。 */
export declare function caseTableFor(libraryId: number): string;
/** 各分片库数/用例数统计（验证分片均匀性）。 */
export declare function shardStats(): Array<{
    shard: number;
    libraries: number;
    cases: number;
}>;
