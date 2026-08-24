// 系统配置服务：settings 表（key-value JSON）+ 默认值；业务参数全部从这里读取。
// 前端「系统配置」页读写这些键，改完即生效（读取时实时取最新值）。
import { getDb, now } from '../db/connection.js';

export const SETTING_DEFAULTS: Record<string, unknown> = {
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

export type SettingValue = string | number | boolean | null;

/** 读取配置（未设置/解析失败回默认值）。 */
export function getSetting<T>(key: string, fallback?: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback ?? (SETTING_DEFAULTS[key] as T);
  try {
    const parsed = JSON.parse(row.value);
    return parsed as T;
  } catch {
    // 历史坏数据（如单反斜杠路径写入后 JSON 解析失败）：按原始字符串读取，避免静默回退默认值
    let raw = String(row.value).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    return (raw as unknown) as T;
  }
}

/** 批量读取配置（返回全部已知键）。 */
export function getAllSettings(): Array<{ key: string; value: SettingValue; updatedAt: string | null }> {
  const rows = getDb().prepare('SELECT key, value, updated_at FROM settings').all() as Array<{ key: string; value: string; updated_at: string }>;
  const map = new Map(rows.map((r) => [r.key, r]));
  return Object.keys(SETTING_DEFAULTS).map((key) => {
    const row = map.get(key);
    if (!row) return { key, value: SETTING_DEFAULTS[key] as SettingValue, updatedAt: null };
    let value: SettingValue = SETTING_DEFAULTS[key] as SettingValue;
    try { value = JSON.parse(row.value) as SettingValue; } catch { /* 保留默认 */ }
    return { key, value, updatedAt: row.updated_at };
  });
}

/** 写入配置（JSON 序列化存储）。 */
export function setSetting(key: string, value: SettingValue): void {
  getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), now());
}
