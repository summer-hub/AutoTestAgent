---
id: security-secrets-masking
title: 凭据保护纪律（脱敏出参 + 加密落库）
description: 碰 models/settings/密钥字段前必读
tags: ["security", "secrets", "masking", "encryption"]
priority: 93
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/api/**", "dsh-autotest/src/services/settings.ts", "dsh-autotest/src/services/crypto.ts", "dsh-autotest/src/services/secrets.ts"]
  touches: ["security", "secrets", "masking", "encryption", "api-key"]
timestamp: 2026-10-13T00:00:00Z
---

# 凭据保护纪律

两层防护，缺一不可：

1. **出参脱敏**（`secrets.ts`）：`GET /settings` 的 MySQL/Redis 连接串、
   `GET /models` 的 API Key 只回掩码（`maskSecret` / `maskUrlPassword`）；
2. **落库加密**（`crypto.ts`）：AES-256-GCM 信封加密，密文格式
   `enc:v1:<iv>:<tag>:<ct>`；master key 取 `AUTOTEST_MASTER_KEY` 或数据目录
   `.master-key`（自动生成 + ACL 收敛）。

## 规则

- 前端会把读到的掩码**原样 PUT 回来**——写路径遇到掩码必须视为"不改动"
  （`isMaskedSecret` / `resolveSecretInput`），绝不能用 `••••1234` 覆盖真实凭据；
- 新增加密字段时：写路径 `sealSecretInput`，读路径 `decryptSecret`（旧明文
  透传，懒迁移不阻塞启动）；
- 解密失败只告警不崩（可能是跨机迁移未带 master key）；
- 测试/自检里造密钥后必须清理（revokeApiKey / 恢复设置）。
