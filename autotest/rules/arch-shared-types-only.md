---
id: arch-shared-types-only
title: shared 仅类型（前后端共享层纪律）
description: shared/src 禁止运行动时逻辑与 node: 内置模块；改 shared/ 前必读
tags: ["architecture", "shared", "types"]
priority: 88
load_bearing: true
inject_when:
  paths: ["shared/src/**", "web/src/**"]
  touches: ["architecture", "shared", "types", "contract"]
timestamp: 2026-10-13T00:00:00Z
---

# shared 仅类型

`shared/src/index.ts` 是前后端唯一共享层（web 经 workspace 包名 `shared` 引用）。

## 规则

- 只允许 `export interface` / `export type`；**禁止** `export function/class/const`
  等运行时导出，禁止 import `node:fs` 等内置模块；
- 需要前后端共用逻辑时，服务端放 `dsh-autotest/src/services/`，前端放
  `web/src/`，各实现一份——契约（类型）只有一份；
- 新增 API 的响应类型先加 shared，再写服务端路由与前端调用。
