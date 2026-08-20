export declare const SETTING_DEFAULTS: Record<string, unknown>;
export type SettingValue = string | number | boolean | null;
/** 读取配置（未设置/解析失败回默认值）。 */
export declare function getSetting<T>(key: string, fallback?: T): T;
/** 批量读取配置（返回全部已知键）。 */
export declare function getAllSettings(): Array<{
    key: string;
    value: SettingValue;
    updatedAt: string | null;
}>;
/** 写入配置（JSON 序列化存储）。 */
export declare function setSetting(key: string, value: SettingValue): void;
