/** 通用掩码：只保留末 4 位用于识别（短值整串打码）。 */
export declare function maskSecret(value: unknown): string;
/**
 * URL 型凭据掩码：保留可读的 scheme/user/host/port/db，只把口令段打码。
 * 例：mysql://root:s3cret@127.0.0.1:3306/autotest → mysql://root:••••@127.0.0.1:3306/autotest
 */
export declare function maskUrlPassword(value: unknown): string;
/** 是否为掩码值（说明它是脱敏后的回显，不是真实凭据）。 */
export declare function isMaskedSecret(value: unknown): boolean;
/**
 * 解析客户端回传的凭据字段：
 *  - undefined / null → 保持原值（字段缺省）
 *  - 掩码值          → 保持原值（脱敏回显被原样回传）
 *  - ''             → 显式清空
 *  - 其它           → 采用新值
 */
export declare function resolveSecretInput(incoming: unknown, current: string): string;
