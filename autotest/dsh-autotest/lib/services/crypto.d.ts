/** 主密钥文件是否已完成访问收敛（POSIX 0600 / Windows icacls）。诊断与自检用。 */
export declare function masterKeyHardened(): boolean;
/** 取主密钥（进程内缓存一次）。 */
export declare function masterKey(): Buffer;
/** 主密钥指纹（诊断用：多节点间比对可快速发现 key 不一致导致的解密失败）。 */
export declare function masterKeyFingerprint(): string;
/** 是否为本模块的密文格式。 */
export declare function isEncrypted(value: unknown): boolean;
/**
 * 加密；空值原样返回（不加密空串，省得解密端特判）。
 * 已是密文（enc:v1: 前缀）时原样返回——保证"掩码回传→保持原值"的旧值不会被二次加密。
 */
export declare function encryptSecret(plain: unknown): string;
/**
 * 解密；非本模块密文（旧明文 / 空值）原样返回——懒迁移的关键：
 * 老数据不阻塞启动，下次写该键时自然转为密文。
 * 解密失败（key 不匹配 / 数据损坏）告警并原样返回：读取路径不硬失败，
 * 让上层照常工作或暴露可诊断的错误，而不是整个服务起不来。
 */
export declare function decryptSecret(payload: unknown): string;
/** 写库前的统一入口：敏感键新值加密、掩码/原密文不动。 */
export declare function sealSecretInput(incoming: unknown, current: string): string;
