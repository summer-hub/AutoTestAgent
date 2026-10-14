export declare const RESOURCE_KINDS: readonly ["animation_json", "ca_cert", "server_fixture", "db_fixture", "image", "media", "config"];
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export declare const RESOURCE_KIND_LABEL: Record<ResourceKind, string>;
/** 资源来源。repo_scan = 仓库自带；canonical = 上游官方样本；synthesized = 程序合成。 */
export declare const RESOURCE_ORIGINS: readonly ["repo_scan", "canonical", "synthesized"];
export type ResourceOrigin = (typeof RESOURCE_ORIGINS)[number];
export interface SchemaProblem {
    path: string;
    reason: string;
}
/**
 * 校验动画 JSON 是否符合 bodymovin 基本 schema。
 *
 * 为什么必须校验：合成的动画 json 是"给库解析的输入"，schema 不对就不是
 * "边界场景"而是"无效输入"——测出来的失败毫无意义（库只是拒绝了一个根本不是
 * lottie 的文件）。校验让"畸形资源"与"合法但边界"区分开。
 *
 * 校验最小集：v / fr / ip / op / w / h / layers 七个必备键，数值范围合理，
 * layers 是数组。故意**不**校验 layers 内部结构——那是库的实现细节，
 * 平台只保证"这是一个合法的 lottie 容器"。
 */
export declare function validateAnimationJson(obj: unknown): SchemaProblem[];
export type SyntheticAnimation = 'lottie-minimal' | 'lottie-empty-layers' | 'lottie-huge-layers' | 'lottie-nested-precomp' | 'lottie-malformed' | 'lottie-bad-encoding';
/**
 * 合成动画资源。返回**文本内容**（不是对象）——因为 malformed / bad-encoding
 * 天生就不是合法 JSON，用对象表达不了。
 *
 * 每个变体对应一类测试意图（这是"怎么测试"的答案）：
 *   minimal        → 基本解析链路通不通
 *   empty-layers   → 空值场景（合法但无内容）
 *   huge-layers    → 大数据场景（性能与内存）
 *   nested-precomp → 递归解析（嵌套预合成）
 *   malformed      → 畸形 JSON（必须走 error 回调）
 *   bad-encoding   → 编码错误（UTF-8 BOM / 非法字节）
 */
export declare function synthesizeAnimation(kind: SyntheticAnimation): {
    text: string;
    valid: boolean;
    intent: string;
};
/** 合成资源的内容哈希（sha256 前 32 位，与 envkit 指纹同规格）。 */
export declare function contentHash(text: string): string;
/**
 * CA 证书构造的**规格**（不是实现）。
 *
 * 为什么只给规格：证书生成要调 openssl，而 openssl 的调用方式（参数、输出格式）
 * 属于脚本层（assets/env/gen-ca.{ps1,sh}）。这里只规定"构造出来的东西长什么样"，
 * 供上层校验产物是否合格。
 */
export interface CaSpec {
    cn: string;
    /** 使用者服务器名（SAN），如 localhost、127.0.0.1 */
    san: string[];
    days: number;
    /** 是否生成服务端证书（否则只出 CA） */
    withServerCert: boolean;
}
export declare const DEFAULT_CA_SPEC: CaSpec;
/** 证书有效期临期阈值（天）：低于此值应提醒更新，否则测试会突然全失败。 */
export declare const CA_EXPIRY_WARN_DAYS = 30;
/** 证书产物清单（生成后按此校验）。 */
export declare function caExpectedArtifacts(spec?: CaSpec): string[];
export interface DbFixtureSpec {
    table: string;
    columns: string[];
    rows: number;
    /** corrupt 变体会写出损坏文件 */
    corrupt?: boolean;
}
/** 生成 SQLite fixture 的 SQL 文本（由脚本层落盘执行）。 */
export declare function synthesizeDbSql(spec: DbFixtureSpec): string;
export interface ServerFixtureSpec {
    status: number;
    /** 响应体（JSON 字符串） */
    body: string;
    /** 延迟毫秒（验证超时分支） */
    delayMs?: number;
    /**  Content-Type */
    contentType?: string;
}
/** mock server 的响应规格（脚本层据此起本地服务）。 */
export declare const DEFAULT_SERVER_FIXTURES: ServerFixtureSpec[];
