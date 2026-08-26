// 系统配置服务：settings 表（MySQL，key-value JSON）+ 默认值
//  - 启动时 loadSettings() 全量加载进内存缓存，业务读取保持同步
//  - setSetting 同步更新内存 + 异步写库
import { dbMode, getDb, now } from '../db/connection.js';
export const SETTING_DEFAULTS = {
    'app.workspace': '', // 工作区路径：留空 = 启动目录下的 workspace（使用时会提示去配置）
    'agent.defaultModel': '',
    'agent.maxCasesPerTask': 20,
    'agent.caseReviewRounds': 2, // 用例生成自审进化轮次上限（0=关闭自审）
    'exec.llmTemperature': 0.4,
    'exec.llmTimeoutMs': 180000,
    'exec.llmRatePerMin': 10, // 每用户每分钟 LLM 调用上限（任务/分析/追问）
    'exec.planSampleFull': 60,
    'exec.planSampleBatch': 30,
    'exec.planSampleSingle': 200,
    'data.redisCache': false,
    'data.redisUrl': '',
    'data.cacheTtlSeconds': 30,
    'data.shardCount': 16,
    'device.execEngine': 'hdc',
    'device.appAbilities': '{}',
    'device.autoScanInterval': 30, // 设备自动检测间隔（秒），0=关闭；启动时立即检测一次
    'explore.maxDepth': 2, // 真机 UI 遍历：BFS 最大深度
    'explore.maxPages': 40, // 真机 UI 遍历：最多收录页面数（保证全按钮覆盖）
    'explore.controlsPerPage': 12, // 真机 UI 遍历：每页最多收集控件数
    'explore.maxSwipePerPage': 5, // 真机 UI 遍历：单页为看全内容最多滑动次数
    'explore.statusBarFilter': true, // 真机 UI 遍历：过滤状态栏/系统窗口控件（时钟等）
    'explore.systemBundles': 'com.ohos.sceneboard,com.huawei.systemui,com.ohos.systemui,com.android.systemui',
    'exec.scriptMode': 'script',
    'exec.schedulerEnabled': true, // 多节点部署时仅主节点开启调度器（防定时计划/统计预热重复执行）
    // ---- 多用户 / 服务器化 ----
    'db.mysqlUrl': '',
    'auth.jwtSecret': '',
    'auth.bootstrapPassword': '',
    'auth.inviteOnly': true,
    'auth.accessTtlSec': 604800, // 登录有效期 7 天（免频繁掉线）
    'auth.refreshTtlDays': 30,
};
let cache = null;
function parseValue(raw, fallback, key) {
    try {
        return JSON.parse(raw);
    }
    catch {
        // 历史坏数据（如单反斜杠路径写入后 JSON 解析失败）：按原始字符串读取
        let v = raw.trim();
        if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
            v = v.slice(1, -1);
        return v;
    }
}
/** 读取配置（未设置/解析失败回默认值）。 */
export function getSetting(key, fallback) {
    const entry = cache?.get(key);
    if (entry)
        return parseValue(entry.value, fallback, key);
    return fallback ?? SETTING_DEFAULTS[key];
}
/** 批量读取配置（返回全部已知键）。 */
export function getAllSettings() {
    return Object.keys(SETTING_DEFAULTS).map((key) => {
        const entry = cache?.get(key);
        if (!entry)
            return { key, value: SETTING_DEFAULTS[key], updatedAt: null };
        return { key, value: parseValue(entry.value, SETTING_DEFAULTS[key]), updatedAt: entry.updatedAt };
    });
}
/** 启动时全量加载（ensureReady 调用）。注意：key 是 MySQL 保留字，别名必须避开。 */
export async function loadSettings() {
    try {
        const rows = await getDb().prepare('SELECT `key` AS k, value, updated_at FROM settings').all();
        cache = new Map(rows.map((r) => [r.k, { value: r.value, updatedAt: r.updated_at }]));
    }
    catch (e) {
        console.warn('[dsh-autotest] settings 加载失败，使用默认值：', e.message);
        cache = new Map();
    }
}
/** 写入配置：同步更新内存，异步写库（MySQL/SQLite 双方言 upsert）。 */
export function setSetting(key, value) {
    const json = JSON.stringify(value);
    if (cache) {
        cache.set(key, { value: json, updatedAt: now() });
    }
    else {
        cache = new Map([[key, { value: json, updatedAt: now() }]]);
    }
    const upsert = dbMode() === 'sqlite'
        ? `INSERT INTO settings ("key", value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        : `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`;
    void getDb().prepare(upsert).run(key, json, now())
        .catch((e) => console.warn('[dsh-autotest] 设置写入失败：', e.message));
}
