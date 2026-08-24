// 缓存层（M7）：
//  - 默认内存 LRU（TTL 由 data.cacheTtlSeconds 配置）；
//  - 配置 data.redisUrl 后自动切换 Redis（ioredis），Redis 不可用时回退内存；
//  - 写路径通过 cacheDel(prefix) 失效，保证最终一致。
import { getSetting } from './settings.js';
const lru = new Map();
const LRU_MAX = 5000;
let redisClient = null;
let redisResolved = false;
async function redis() {
    if (redisResolved)
        return redisClient;
    redisResolved = true;
    // 开关 data.redisCache 生效：关闭时即使配了 URL 也走内存 LRU
    const enabled = getSetting('data.redisCache', false);
    const url = getSetting('data.redisUrl', '');
    if (!enabled || !url)
        return null;
    try {
        const { default: Redis } = await import('ioredis');
        const RedisCtor = Redis;
        const client = new RedisCtor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
        await client.connect();
        redisClient = client;
        console.log('[dsh-autotest] Redis 缓存已连接');
    }
    catch (e) {
        console.warn('[dsh-autotest] Redis 不可用，回退内存 LRU：', e.message);
    }
    return redisClient;
}
function ttlMs() {
    return getSetting('data.cacheTtlSeconds', 30) * 1000;
}
export async function cacheGet(key) {
    const r = await redis();
    if (r) {
        try {
            const raw = await r.get(`autotest:${key}`);
            return raw ? JSON.parse(raw) : undefined;
        }
        catch {
            return undefined;
        }
    }
    const e = lru.get(key);
    if (!e)
        return undefined;
    if (e.expiresAt < Date.now()) {
        lru.delete(key);
        return undefined;
    }
    lru.delete(key);
    lru.set(key, e);
    return e.value;
}
export async function cacheSet(key, value, ttlOverrideMs) {
    const ttl = ttlOverrideMs ?? ttlMs();
    const r = await redis();
    if (r) {
        try {
            await r.set(`autotest:${key}`, JSON.stringify(value), 'PX', ttl);
        }
        catch { /* Redis 失败不阻塞 */ }
        return;
    }
    if (lru.size >= LRU_MAX) {
        const oldest = lru.keys().next().value;
        if (oldest !== undefined)
            lru.delete(oldest);
    }
    lru.set(key, { value, expiresAt: Date.now() + ttl });
}
/** 按前缀失效（写路径调用，如 cacheDel('cases') 清掉所有 cases:* 键）。 */
export async function cacheDel(prefix) {
    const r = await redis();
    if (r) {
        try {
            const keys = await r.keys(`autotest:${prefix}*`);
            if (keys.length > 0)
                await r.del(...keys);
        }
        catch { /* 忽略 */ }
        return;
    }
    for (const k of [...lru.keys()]) {
        if (k.startsWith(prefix))
            lru.delete(k);
    }
}
