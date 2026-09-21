// 系统配置服务：settings 表（MySQL，key-value JSON）+ 默认值
//  - 启动时 loadSettings() 全量加载进内存缓存，业务读取保持同步
//  - setSetting 同步更新内存 + 异步写库
import { dbMode, getDb, now } from '../db/connection.js';
import { maskSecret, maskUrlPassword } from './secrets.js';
export const SETTING_DEFAULTS = {
    'app.workspace': '', // 工作区路径：留空 = 启动目录下的 workspace（使用时会提示去配置）
    'agent.defaultModel': '',
    'agent.maxCasesPerTask': 20,
    'agent.caseReviewRounds': 2, // 用例生成自审进化轮次上限（0=关闭自审）
    'agent.genPagesPerShard': 2, // 用例生成分片大小（每次 LLM 调用处理的页面数，1-6；越小越不易输出截断）
    'agent.genShardConcurrency': 3, // 分片生成并发数（限流内并行，1-4）
    'agent.dryRunEnabled': true, // 生成后是否在设备上 dry-run 并把失败证据回灌优化（执行器为真）
    'agent.dryRunMaxCases': 5, // 单次任务最多 dry-run 的用例数（真机执行慢，需限流）
    'agent.dryRunPerStepTimeoutMs': 15000,
    'agent.dryRunFailStreakStop': 2, // 连续失败多少步后停止该用例（界面已偏离，后续证据不可信）
    'agent.maxTokensPerTask': 300000, // 单任务 token 成本闸门（tokens_in+out 累计，0=不限制）
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
    'device.appAbilities': '{}',
    'device.autoScanInterval': 30, // 设备自动检测间隔（秒），0=关闭；启动时立即检测一次
    'explore.maxDepth': 8, // 真机 UI 遍历：BFS 深度安全上限（真正的限流交给下面的预算项）
    'explore.maxPages': 40, // 真机 UI 遍历：最多收录页面数
    'explore.controlsPerPage': 60, // 真机 UI 遍历：每页控件清单上限（对所有页面统一生效）
    'explore.maxSwipePerPage': 5, // 真机 UI 遍历：单页为看全内容最多滑动次数
    'explore.maxMinutes': 20, // 真机 UI 遍历：单次遍历时长上限（分钟），到点即停并给出原因
    'explore.maxClicksPerPage': 100, // 真机 UI 遍历：单页点击上限（防异常页面把预算耗在一页）
    'explore.signatureIncludesLayout': false, // 页面签名是否含布局坐标（默认否：连续动画页每帧坐标都变）
    'explore.statusBarFilter': true, // 真机 UI 遍历：过滤状态栏/系统窗口控件（时钟等）
    'explore.systemBundles': 'com.ohos.sceneboard,com.huawei.systemui,com.ohos.systemui,com.android.systemui',
    'exec.schedulerEnabled': true, // 多节点部署时仅主节点开启调度器（防定时计划/统计预热重复执行）
    // ---- 三方库测试表（人维护的 xlsx，库管理页「从表同步」用它作为库清单来源）----
    'libraries.xlsxPath': '', // 留空 = <数据目录>/三方库测试表.xlsx；相对路径按数据目录解析
    // ---- 服务器化 ----
    'db.mysqlUrl': '',
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
/**
 * 敏感配置键：接口出参必须脱敏（内部读取仍用 getSetting 拿真实值）。
 * 'url' = 只给口令段打码，保留 host/db 可读性；'plain' = 整串打码只留末 4 位。
 */
export const SECRET_SETTING_KEYS = {
    'db.mysqlUrl': 'url',
    'data.redisUrl': 'url',
};
/** 出参脱敏：按键类型打码，非敏感键原样返回。 */
export function maskSettingValue(key, value) {
    const kind = SECRET_SETTING_KEYS[key];
    if (!kind || value === null || value === undefined)
        return value;
    const raw = String(value);
    if (!raw)
        return value;
    return kind === 'url' ? maskUrlPassword(raw) : maskSecret(raw);
}
/** 批量读取配置（返回全部已知键；敏感键已脱敏）。 */
export function getAllSettings() {
    return Object.keys(SETTING_DEFAULTS).map((key) => {
        const entry = cache?.get(key);
        if (!entry)
            return { key, value: SETTING_DEFAULTS[key], updatedAt: null };
        const value = parseValue(entry.value, SETTING_DEFAULTS[key]);
        return { key, value: maskSettingValue(key, value), updatedAt: entry.updatedAt };
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
