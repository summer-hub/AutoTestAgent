---
id: security-same-origin
title: 同源闸门纪律（防跨站写入）
description: 改 HTTP 服务/挂载方式前必读：Origin/Sec-Fetch-Site 校验与逃生阀
tags: ["security", "same-origin", "csrf", "http"]
priority: 91
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/api/**", "dsh-autotest/src/standalone.ts", "dsh-autotest/src/index.ts", "dsh-autotest/src/static.ts"]
  touches: ["security", "same-origin", "csrf", "http", "cors"]
timestamp: 2026-10-13T00:00:00Z
---

# 同源闸门纪律

平台 API 无账号体系（打开即用）时，同源闸门是防跨站写入的**主防线**
（`assertSameOrigin`，在路由匹配后、业务前执行）：

- 带 `Origin` 且与 `Host` 不一致 → 403；`Origin: null`（不透明来源）→ 403；
- `Sec-Fetch-Site: cross-site` → 403；
- 服务端 / CLI / 脚本调用不带 Origin，照常放行；
- 逃生阀：`AUTOTEST_ALLOW_CROSS_ORIGIN=1`（确有跨源需要时，需在文档注明风险）；
- WebSocket 升级端点同样适用（鉴权走 query token，见 B4 ws 模块注释）；
- 改前置代理 / 绑定 0.0.0.0 时，闸门 + 访问控制要同时评估，不能只开一个。
