/** 解析 AUTOTEST_CORS_ORIGINS → 规范化 origin 列表（去空白/空项，小写，去尾部斜杠）。 */
export function corsOrigins() {
    const raw = String(process.env.AUTOTEST_CORS_ORIGINS ?? '');
    return raw
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
        .filter((s) => s !== '');
}
/** origin 是否命中白名单（规范化后精确匹配；不做前后缀通配，杜绝 `*` 语义）。 */
export function isOriginAllowed(origin) {
    const norm = origin.trim().replace(/\/+$/, '').toLowerCase();
    if (!norm)
        return false;
    return corsOrigins().includes(norm);
}
/** 旧开关：AUTOTEST_ALLOW_CROSS_ORIGIN=1 完全放开同源闸门（保留给既有部署；新部署用白名单）。 */
export function crossOriginFullyOpen() {
    return String(process.env.AUTOTEST_ALLOW_CROSS_ORIGIN || '') === '1';
}
/** origin 的 host[:port] 是否与请求 Host 头一致（同源判定；解析失败按不同源处理）。 */
export function isSameHostOrigin(origin, host) {
    try {
        return new URL(origin).host.toLowerCase() === String(host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
/**
 * 请求来源是否放行（HTTP 断言与 WS 握手共用）。
 * 规则：无 Origin（服务端/CLI）→ 放行；旧开关 → 放行；白名单命中 → 放行；同源（Origin host == Host）→ 放行；
 * 其余（跨源且未列白名单）→ 拒绝 403。
 */
export function originAllowed(req) {
    const origin = req.headers.origin ? String(req.headers.origin) : '';
    if (!origin)
        return true;
    if (crossOriginFullyOpen())
        return true;
    if (isOriginAllowed(origin))
        return true;
    return isSameHostOrigin(origin, String(req.headers.host ?? ''));
}
/**
 * 命中白名单的请求应附加的 CORS 响应头。
 * 回显具体 Origin（永不 `*`）；令牌走 Authorization 头（非 Cookie），无需 Allow-Credentials。
 */
export function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
    };
}
