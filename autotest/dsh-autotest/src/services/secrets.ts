// 密钥掩码（出参脱敏 + 入参防回写）
//
// 背景：GET /settings 曾把 db.mysqlUrl（含数据库口令）明文回传，GET /models 曾把 api_key 明文回传。
// 由于本插件 API 无鉴权，任何本机进程/网页都能取走这些凭据。
//
// 但只有"打码"还不够：前端会把读到的值原样 PUT 回来，若把掩码当成新密钥写库，就会用
// "••••1234" 覆盖掉真实凭据。因此成对提供 isMaskedSecret()，写路径遇到掩码一律视为"不改动"。

const MASK = '•';

/** 通用掩码：只保留末 4 位用于识别（短值整串打码）。 */
export function maskSecret(value: unknown): string {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return MASK.repeat(8);
  return `${MASK.repeat(4)}${s.slice(-4)}`;
}

/**
 * URL 型凭据掩码：保留可读的 scheme/user/host/port/db，只把口令段打码。
 * 例：mysql://root:s3cret@127.0.0.1:3306/autotest → mysql://root:••••@127.0.0.1:3306/autotest
 */
export function maskUrlPassword(value: unknown): string {
  const s = String(value ?? '');
  if (!s) return '';
  const masked = s.replace(/:\/\/([^:@/]+):([^@/]+)@/, `://$1:${MASK}${MASK}${MASK}${MASK}@`);
  return masked === s && /:\/\/[^:@/]+@/.test(s) ? maskSecret(s) : masked;
}

/** 是否为掩码值（说明它是脱敏后的回显，不是真实凭据）。 */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.includes(MASK);
}

/**
 * 解析客户端回传的凭据字段：
 *  - undefined / null → 保持原值（字段缺省）
 *  - 掩码值          → 保持原值（脱敏回显被原样回传）
 *  - ''             → 显式清空
 *  - 其它           → 采用新值
 */
export function resolveSecretInput(incoming: unknown, current: string): string {
  if (incoming === undefined || incoming === null) return current;
  if (typeof incoming !== 'string') return current;
  if (isMaskedSecret(incoming)) return current;
  return incoming;
}
