import type { IncomingMessage } from 'node:http';
/** 解析 AUTOTEST_CORS_ORIGINS → 规范化 origin 列表（去空白/空项，小写，去尾部斜杠）。 */
export declare function corsOrigins(): string[];
/** origin 是否命中白名单（规范化后精确匹配；不做前后缀通配，杜绝 `*` 语义）。 */
export declare function isOriginAllowed(origin: string): boolean;
/** 旧开关：AUTOTEST_ALLOW_CROSS_ORIGIN=1 完全放开同源闸门（保留给既有部署；新部署用白名单）。 */
export declare function crossOriginFullyOpen(): boolean;
/** origin 的 host[:port] 是否与请求 Host 头一致（同源判定；解析失败按不同源处理）。 */
export declare function isSameHostOrigin(origin: string, host: string): boolean;
/**
 * 请求来源是否放行（HTTP 断言与 WS 握手共用）。
 * 规则：无 Origin（服务端/CLI）→ 放行；旧开关 → 放行；白名单命中 → 放行；同源（Origin host == Host）→ 放行；
 * 其余（跨源且未列白名单）→ 拒绝 403。
 */
export declare function originAllowed(req: IncomingMessage): boolean;
/**
 * 命中白名单的请求应附加的 CORS 响应头。
 * 回显具体 Origin（永不 `*`）；令牌走 Authorization 头（非 Cookie），无需 Allow-Credentials。
 */
export declare function corsHeaders(origin: string): Record<string, string>;
