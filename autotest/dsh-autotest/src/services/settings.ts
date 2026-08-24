// 系统配置服务：settings 表（MySQL，key-value JSON）+ 默认值
//  - 启动时 loadSettings() 全量加载进内存缓存，业务读取保持同步
//  - setSetting 同步更新内存 + 异步写库
import { mysqlPool, now } from '../db/connection.js';

export const SETTING_DEFAULTS: Record<string, unknown> = {
  'app.workspace': 'D:\\autotest\\workspace',
  'agent.defaultModel': '',
  'agent.maxCasesPerTask': 20,
  'exec.llmTemperature': 0.4,
  'exec.llmTimeoutMs': 180000,
  'exec.llmRatePerMin': 10,        // 每用户每分钟 LLM 调用上限（任务/分析/追问）
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
  'exec.schedulerEnabled': true,   // 多节点部署时仅主节点开启调度器（防定时计划/统计预热重复执行）
  // ---- 多用户 / 服务器化 ----
  'db.mysqlUrl': '',
  'auth.jwtSecret': '',
  'auth.bootstrapPassword': '',
  'auth.inviteOnly': true,
  'auth.accessTtlSec': 3600,
  'auth.refreshTtlDays': 7,
};

export type SettingValue = string | number | boolean | null;

interface CacheEntry { value: string; updatedAt: string | null }

let cache: Map<string, CacheEntry> | null = null;

function parseValue<T>(raw: string, fallback?: T, key?: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 历史坏数据（如单反斜杠路径写入后 JSON 解析失败）：按原始字符串读取
    let v = raw.trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return (v as unknown) as T;
  }
}

/** 读取配置（未设置/解析失败回默认值）。 */
export function getSetting<T>(key: string, fallback?: T): T {
  const entry = cache?.get(key);
  if (entry) return parseValue<T>(entry.value, fallback, key);
  return fallback ?? (SETTING_DEFAULTS[key] as T);
}

/** 批量读取配置（返回全部已知键）。 */
export function getAllSettings(): Array<{ key: string; value: SettingValue; updatedAt: string | null }> {
  return Object.keys(SETTING_DEFAULTS).map((key) => {
    const entry = cache?.get(key);
    if (!entry) return { key, value: SETTING_DEFAULTS[key] as SettingValue, updatedAt: null };
    return { key, value: parseValue<SettingValue>(entry.value, SETTING_DEFAULTS[key] as SettingValue), updatedAt: entry.updatedAt };
  });
}

/** 启动时全量加载（ensureReady 调用）。 */
export async function loadSettings(): Promise<void> {
  try {
    const [rows] = await mysqlPool().query('SELECT `key`, value, updated_at FROM settings') as [
      Array<{ key: string; value: string; updated_at: string | null }>, unknown,
    ];
    cache = new Map(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updated_at }]));
  } catch (e) {
    console.warn('[dsh-autotest] settings 加载失败，使用默认值：', (e as Error).message);
    cache = new Map();
  }
}

/** 写入配置：同步更新内存，异步写库。 */
export function setSetting(key: string, value: SettingValue): void {
  const json = JSON.stringify(value);
  if (cache) {
    cache.set(key, { value: json, updatedAt: now() });
  } else {
    cache = new Map([[key, { value: json, updatedAt: now() }]]);
  }
  void mysqlPool().query(
    `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [key, json, now()],
  ).catch((e) => console.warn('[dsh-autotest] 设置写入失败：', (e as Error).message));
}
