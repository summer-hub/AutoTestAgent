// 系统配置服务：settings 表（MySQL，key-value JSON）+ 默认值
//  - 启动时 loadSettings() 全量加载进内存缓存，业务读取保持同步
//  - setSetting 同步更新内存 + 异步写库
import { dbMode, getDb, now } from '../db/connection.js';

export const SETTING_DEFAULTS: Record<string, unknown> = {
  'app.workspace': 'D:\\autotest\\workspace',
  'agent.defaultModel': '',
  'agent.maxCasesPerTask': 20,
  'agent.caseReviewRounds': 2,     // 用例生成自审进化轮次上限（0=关闭自审）
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
  'device.autoScanInterval': 30,   // 设备自动检测间隔（秒），0=关闭；启动时立即检测一次
  'explore.maxDepth': 2,             // 真机 UI 遍历：BFS 最大深度
  'explore.maxPages': 20,            // 真机 UI 遍历：最多收录页面数
  'explore.controlsPerPage': 12,     // 真机 UI 遍历：每页最多收集控件数
  'explore.maxSwipePerPage': 5,      // 真机 UI 遍历：单页为看全内容最多滑动次数
  'explore.statusBarFilter': true,   // 真机 UI 遍历：过滤状态栏/系统窗口控件（时钟等）
  'explore.systemBundles': 'com.ohos.sceneboard,com.huawei.systemui,com.ohos.systemui,com.android.systemui',
  'exec.scriptMode': 'script',
  'exec.schedulerEnabled': true,   // 多节点部署时仅主节点开启调度器（防定时计划/统计预热重复执行）
  // ---- 多用户 / 服务器化 ----
  'db.mysqlUrl': '',
  'auth.jwtSecret': '',
  'auth.bootstrapPassword': '',
  'auth.inviteOnly': true,
  'auth.accessTtlSec': 604800,   // 登录有效期 7 天（免频繁掉线）
  'auth.refreshTtlDays': 30,
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

/** 启动时全量加载（ensureReady 调用）。注意：key 是 MySQL 保留字，别名必须避开。 */
export async function loadSettings(): Promise<void> {
  try {
    const rows = await getDb().prepare('SELECT `key` AS k, value, updated_at FROM settings').all<{ k: string; value: string; updated_at: string | null }>();
    cache = new Map(rows.map((r) => [r.k, { value: r.value, updatedAt: r.updated_at }]));
  } catch (e) {
    console.warn('[dsh-autotest] settings 加载失败，使用默认值：', (e as Error).message);
    cache = new Map();
  }
}

/** 写入配置：同步更新内存，异步写库（MySQL/SQLite 双方言 upsert）。 */
export function setSetting(key: string, value: SettingValue): void {
  const json = JSON.stringify(value);
  if (cache) {
    cache.set(key, { value: json, updatedAt: now() });
  } else {
    cache = new Map([[key, { value: json, updatedAt: now() }]]);
  }
  const upsert = dbMode() === 'sqlite'
    ? `INSERT INTO settings ("key", value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    : `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`;
  void getDb().prepare(upsert).run(key, json, now())
    .catch((e) => console.warn('[dsh-autotest] 设置写入失败：', (e as Error).message));
}
