export declare const SETTING_DEFAULTS: Record<string, unknown>;
export type SettingValue = string | number | boolean | null;
/** 读取配置（未设置/解析失败回默认值）。 */
export declare function getSetting<T>(key: string, fallback?: T): T;
/**
 * 敏感配置键：接口出参必须脱敏（内部读取仍用 getSetting 拿真实值）。
 * 'url' = 只给口令段打码，保留 host/db 可读性；'plain' = 整串打码只留末 4 位。
 */
export declare const SECRET_SETTING_KEYS: Record<string, 'url' | 'plain'>;
/** 出参脱敏：按键类型打码，非敏感键原样返回。 */
export declare function maskSettingValue(key: string, value: SettingValue): SettingValue;
/** 批量读取配置（返回全部已知键；敏感键已脱敏）。 */
export declare function getAllSettings(): Array<{
    key: string;
    value: SettingValue;
    updatedAt: string | null;
}>;
/** 启动时全量加载（ensureReady 调用）。注意：key 是 MySQL 保留字，别名必须避开。 */
export declare function loadSettings(): Promise<void>;
/** 写入配置：同步更新内存，异步写库（MySQL/SQLite 双方言 upsert）。 */
export declare function setSetting(key: string, value: SettingValue): void;
