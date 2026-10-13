---
id: agent-tools-spec-contract
title: agent 接口层契约（命令规格单一事实源）
description: 改 agent-tools/commands/ 或平台路由前必读
tags: ["agent-tools", "cli", "mcp", "contract", "spec"]
priority: 86
load_bearing: true
inject_when:
  paths: ["agent-tools/**", "dsh-autotest/src/api/**"]
  touches: ["agent-tools", "cli", "mcp", "contract", "spec", "route"]
timestamp: 2026-10-13T00:00:00Z
---

# agent 接口层契约

`agent-tools/src/commands/index.ts` 的命令规格是 CLI / MCP / help 树的**单一
事实源**。加命令 = 加一条数据，不改代码。

## 规则

- 每条规格的 `method + path` 必须在 `dsh-autotest/src/api/http.ts` 真实路由
  表中存在——`verify:agent-tools` 漂移检测会抓（API 演进后规格腐烂）；
- **嵌套 body 用 `bodyPaths`**：服务端读嵌套结构时（如 `plans.create` 的
  `scope.libraryIds`），平铺会**静默丢参**——必须显式映射；
- `string-array` 参数由 `buildRequest` 按规格类型 coercion（CLI 传字符串，
  MCP 传数组，幂等）；
- 二进制响应（xlsx 导出）标 `binary: true`：CLI 落盘 `--out`，MCP 回 base64；
- `/health` 按设计 `authOpen`（LB 探活免鉴权）——测 401 必须用非 authOpen
  端点，否则会误判"认证没生效"；
- 角色标注与服务端 RBAC 对齐（GET=viewer、写=operator、敏感组=admin）；
- 产物（dist/cli.mjs、mcp-server.mjs、specs.mjs）提交入库，clone 即可跑。
