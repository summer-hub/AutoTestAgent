---
id: arch-layering
title: 分层顺序（db → services → api）
description: 下层不准静态引用上层；改 db/ 或 services/ 前必读
tags: ["architecture", "layering", "db", "services", "api"]
priority: 90
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/db/**", "dsh-autotest/src/services/**", "dsh-autotest/src/api/**"]
  touches: ["architecture", "layering", "db", "services", "api"]
timestamp: 2026-10-13T00:00:00Z
---

# 分层顺序

`dsh-autotest/src` 内部分三层：`db/`（连接/ schema / 门面）→ `services/`（业务）→
`api/`（HTTP 路由）。入口文件（`index.ts` / `standalone.ts` / `static.ts`）可跨层组合。

## 规则

- `db/` 不准静态 import `services/` 或 `api/`；`services/` 不准静态 import `api/`；
- 已登记例外：`db/repository.ts → services/settings.js`（分表路由读 shardCount；
  `getSetting` 是同步内存读，不构成初始化循环）。新例外必须写进
  `architecture-policy.yaml` 的 `layering.exceptions` 并同步审计脚本（双边防漂移）；
- 打破循环依赖用**动态 import**（`db/connection.ts` 的 `await import('../services/settings.js')`
  是范例）——它同时是分层的合法逃生阀；
- 验证：`npm run verify:architecture`。
