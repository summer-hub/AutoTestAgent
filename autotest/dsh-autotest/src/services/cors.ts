// A3 前后端分离部署（设计 §13.3）：跨源白名单。
//
// 背景：assertSameOrigin 同源闸门（http.ts）默认拒绝一切跨源浏览器请求（防 CSRF/Drive-by）。
// 分离部署拓扑 B/C 里前端与 API 不同源，需要一个**显式、逐条列出**的白名单放行机制，
// 而不是用 AUTOTEST_ALLOW_CROSS_ORIGIN=1 一刀切关闭闸门（那会放进任意来源）。
//
// 纪律（设计 §13.3）：
//   - 永不回显 `*`：Access-Control-Allow-Origin 逐条回显命中白名单的 Origin（凭据安全）；
//   - 白名单条目必须是完整 origin（scheme://host[:port]），逗号分隔，大小写不敏感、容忍尾部 '/'；
//   - 未列出的跨源 Origin 一律 403（HTTP 与 WS 握手同语义）；
//   - 旧开关 AUTOTEST_ALLOW_CROSS_ORIGIN=1 保留（完全放开，向后兼容既有部署），新部署用白名单。
import type { IncomingMessage } from 'node:http';

/** 解析 AUTOTEST_CORS_ORIGINS → 规范化 origin 列表（去空白/空项，小写，去尾部斜杠）。 */
export function corsOrigins(): string[] {
  const raw = String(process.env.AUTOTEST_CORS_ORIGINS ?? '');
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter((s) => s !== '');
}

/** origin 是否命中白名单（规范化后精确匹配；不做前后缀通配，杜绝 `*` 语义）。 */
export function isOriginAllowed(origin: string): boolean {
  const norm = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (!norm) return false;
  return corsOrigins().includes(norm);
}

/** 旧开关：AUTOTEST_ALLOW_CROSS_ORIGIN=1 完全放开同源闸门（保留给既有部署；新部署用白名单）。 */
export function crossOriginFullyOpen(): boolean {
  return String(process.env.AUTOTEST_ALLOW_CROSS_ORIGIN || '') === '1';
}

/** origin 的 host[:port] 是否与请求 Host 头一致（同源判定；解析失败按不同源处理）。 */
export function isSameHostOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === String(host ?? '').trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 请求来源是否放行（HTTP 断言与 WS 握手共用）。
 * 规则：无 Origin（服务端/CLI）→ 放行；旧开关 → 放行；白名单命中 → 放行；同源（Origin host == Host）→ 放行；
 * 其余（跨源且未列白名单）→ 拒绝 403。
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin ? String(req.headers.origin) : '';
  if (!origin) return true;
  if (crossOriginFullyOpen()) return true;
  if (isOriginAllowed(origin)) return true;
  return isSameHostOrigin(origin, String(req.headers.host ?? ''));
}

/**
 * 命中白名单的请求应附加的 CORS 响应头。
 * 回显具体 Origin（永不 `*`）；令牌走 Authorization 头（非 Cookie），无需 Allow-Credentials。
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
