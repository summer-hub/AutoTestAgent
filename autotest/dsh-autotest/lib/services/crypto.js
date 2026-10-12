// 凭据静态加密（企业级 P0-2）：AES-256-GCM 信封加密，零第三方依赖（node:crypto）。
//
// 背景：models.api_key 与 settings 的 db.mysqlUrl / data.redisUrl 曾明文落库——
// 只有出参打码（secrets.ts）不够，拖库即泄露全部凭据。本模块把"落库"这一端加密：
//   - 出参仍走 maskSecret（行为不变）；
//   - 入参经 resolveSecretInput 防掩码回写后，由 encryptSecret 加密后写库；
//   - 读取处（内部消费）经 decryptSecret 解密；**明文值原样透传**（懒迁移旧数据，
//     下次写该键时自动转为密文）。
//
// master key 解析优先级：
//   1. AUTOTEST_MASTER_KEY 环境变量（hex 64 位 / base64 / 任意字符串取 SHA-256）
//      —— 企业部署推荐：与代码库、数据目录解耦，可走 KMS/CI secret 注入；
//   2. 数据目录 .master-key 文件（首次自动生成 32 随机字节，权限 0600）
//      —— 单机/桌面端默认：key 跟数据走，换机器拷贝数据目录时凭据不可解（设计使然，
//         跨机迁移需显式带上 AUTOTEST_MASTER_KEY，见 docs/standalone-desktop.md）。
//
// 密文格式：enc:v1:<iv-b64url>:<tag-b64url>:<ct-b64url>
//   v1 前缀为版本锚点：将来换算法/轮换 key 时按前缀分发，旧密文仍可读。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../db/sqlite.js';
const PREFIX = 'enc:v1:';
const KEY_FILE = '.master-key';
const ALGO = 'aes-256-gcm';
let cachedKey = null;
let keyHardened = false;
/**
 * 主密钥文件访问收敛。
 * POSIX：chmod 0600 真实生效；
 * Windows：NTFS 上 POSIX mode 是摆设（writeFileSync 的 mode 会被忽略成继承 ACL），
 *   必须用 icacls 断继承 + 只授予当前用户，否则同机其他用户可读主密钥 → 解密全部凭据。
 *   icacls 不可用（被裁剪的系统）时尽力而为，由 masterKeyHardened() 暴露真实状态。
 */
function hardenKeyFile(file) {
    try {
        chmodSync(file, 0o600);
    }
    catch { /* Windows 上仅能置只读位，忽略 */ }
    if (process.platform !== 'win32') {
        keyHardened = true;
        return;
    }
    try {
        const user = process.env.USERNAME ?? '';
        if (!user) {
            keyHardened = false;
            return;
        }
        execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(F)`], { windowsHide: true });
        keyHardened = true;
    }
    catch {
        keyHardened = false;
        console.warn('[crypto] icacls 加固失败（主密钥文件可能沿袭了目录 ACL）：建议将数据目录移到非共享路径，或改用 AUTOTEST_MASTER_KEY 环境变量');
    }
}
/** 主密钥文件是否已完成访问收敛（POSIX 0600 / Windows icacls）。诊断与自检用。 */
export function masterKeyHardened() {
    return keyHardened;
}
/** 解析环境变量形式的主密钥（hex / base64 / 任意串取 SHA-256）。 */
function keyFromEnv(raw) {
    const s = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s))
        return Buffer.from(s, 'hex');
    try {
        const b = Buffer.from(s, 'base64');
        if (b.length === 32)
            return b;
    }
    catch { /* 不是 base64，走哈希派生 */ }
    // 任意字符串：SHA-256 派生（可用但熵受口令强度限制，启动时告警）
    console.warn('[crypto] AUTOTEST_MASTER_KEY 不是 64 位 hex 或 32 字节 base64，已按 SHA-256 派生（建议改用随机生成的 32 字节密钥）');
    return createHash('sha256').update(s, 'utf8').digest();
}
/** 数据目录主密钥文件：不存在则生成（32 随机字节，hex 存放，权限 0600）。 */
function keyFromFile() {
    const file = join(dataDir(), KEY_FILE);
    if (existsSync(file)) {
        const hex = readFileSync(file, 'utf8').trim();
        if (/^[0-9a-fA-F]{64}$/.test(hex))
            return Buffer.from(hex, 'hex');
        console.warn('[crypto] .master-key 内容不是 64 位 hex，按 SHA-256 派生（建议删除该文件重启以重新生成）');
        return createHash('sha256').update(hex, 'utf8').digest();
    }
    const key = randomBytes(32);
    try {
        writeFileSync(file, key.toString('hex'), { mode: 0o600 });
        hardenKeyFile(file);
        console.warn(`[crypto] 已生成主密钥文件 ${file}（已收敛访问权限）。请妥善备份：丢失后库内密文将无法解密；跨机迁移数据时需一并拷贝或改用 AUTOTEST_MASTER_KEY。`);
    }
    catch (e) {
        // 数据目录不可写时退化为进程内派生 key：本次运行内加解密自洽，重启后失效——
        // 好过直接明文落库，但必须大声告警。
        console.error(`[crypto] 无法写入主密钥文件（${file}）：${e.message}。已退化为进程内临时密钥（重启后旧密文不可解，请修复数据目录权限）。`);
        return createHash('sha256').update(`autotest-ephemeral:${process.pid}:${Date.now()}`).digest();
    }
    return key;
}
/** 取主密钥（进程内缓存一次）。 */
export function masterKey() {
    if (!cachedKey) {
        const env = String(process.env.AUTOTEST_MASTER_KEY ?? '').trim();
        cachedKey = env ? keyFromEnv(env) : keyFromFile();
    }
    return cachedKey;
}
/** 主密钥指纹（诊断用：多节点间比对可快速发现 key 不一致导致的解密失败）。 */
export function masterKeyFingerprint() {
    return createHash('sha256').update(masterKey()).digest('hex').slice(0, 8);
}
/** 是否为本模块的密文格式。 */
export function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}
/**
 * 加密；空值原样返回（不加密空串，省得解密端特判）。
 * 已是密文（enc:v1: 前缀）时原样返回——保证"掩码回传→保持原值"的旧值不会被二次加密。
 */
export function encryptSecret(plain) {
    const s = String(plain ?? '');
    if (!s)
        return s;
    if (isEncrypted(s))
        return s;
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, masterKey(), iv);
    const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const b64 = (b) => b.toString('base64url');
    return `${PREFIX}${b64(iv)}:${b64(tag)}:${b64(ct)}`;
}
/**
 * 解密；非本模块密文（旧明文 / 空值）原样返回——懒迁移的关键：
 * 老数据不阻塞启动，下次写该键时自然转为密文。
 * 解密失败（key 不匹配 / 数据损坏）告警并原样返回：读取路径不硬失败，
 * 让上层照常工作或暴露可诊断的错误，而不是整个服务起不来。
 */
export function decryptSecret(payload) {
    const s = String(payload ?? '');
    if (!isEncrypted(s))
        return s;
    try {
        const parts = s.slice(PREFIX.length).split(':');
        if (parts.length !== 3)
            throw new Error('密文段数不是 3');
        const [ivB, tagB, ctB] = parts;
        const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(ivB, 'base64url'));
        decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
    }
    catch (e) {
        console.warn(`[crypto] 解密失败（主密钥指纹 ${masterKeyFingerprint()}，可能跨机迁移未带 key）：${e.message}`);
        return s;
    }
}
/** 写库前的统一入口：敏感键新值加密、掩码/原密文不动。 */
export function sealSecretInput(incoming, current) {
    // current 已是密文或明文；incoming 为掩码时上层已短路，这里只需防二次加密
    const s = String(incoming ?? '');
    if (!s || isEncrypted(s))
        return s;
    return encryptSecret(s);
}
