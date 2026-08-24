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
/** 启动时全量加载（ensureReady 调用）。 */
export declare function loadSettings(): Promise<void>;
/** 写入配置：同步更新内存，异步写库。 */
export declare function setSetting(key: string, value: SettingValue): void;
