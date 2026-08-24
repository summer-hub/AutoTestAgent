// 系统配置服务：settings 表（key-value JSON）+ 默认值；业务参数全部从这里读取。
// 前端「系统配置」页读写这些键，改完即生效（读取时实时取最新值）。
import { getDb, now } from '../db/connection.js';
export const SETTING_DEFAULTS = {
    'app.workspace': 'D:\\autotest\\workspace',
    'agent.defaultModel': '',
    'agent.maxCasesPerTask': 20,
    'exec.llmTemperature': 0.4,
    'exec.llmTimeoutMs': 180000,
    'exec.planSampleFull': 60,
    'exec.planSampleBatch': 30,
    'exec.planSampleSingle': 200,
    'data.redisCache': false,
    'data.redisUrl': '',
    'data.cacheTtlSeconds': 30,
    'data.shardCount': 16,
    'device.execEngine': 'hdc',
    'device.appAbilities': '{}',
    'exec.scriptMode': 'script',
};
/** 读取配置（未设置/解析失败回默认值）。 */
export function getSetting(key, fallback) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row)
        return fallback ?? SETTING_DEFAULTS[key];
    try {
        const parsed = JSON.parse(row.value);
        return parsed;
    }
    catch {
        return fallback ?? SETTING_DEFAULTS[key];
    }
}
/** 批量读取配置（返回全部已知键）。 */
export function getAllSettings() {
    const rows = getDb().prepare('SELECT key, value, updated_at FROM settings').all();
    const map = new Map(rows.map((r) => [r.key, r]));
    return Object.keys(SETTING_DEFAULTS).map((key) => {
        const row = map.get(key);
        if (!row)
            return { key, value: SETTING_DEFAULTS[key], updatedAt: null };
        let value = SETTING_DEFAULTS[key];
        try {
            value = JSON.parse(row.value);
        }
        catch { /* 保留默认 */ }
        return { key, value, updatedAt: row.updated_at };
    });
}
/** 写入配置（JSON 序列化存储）。 */
export function setSetting(key, value) {
    getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value), now());
}
