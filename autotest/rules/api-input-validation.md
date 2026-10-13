---
id: api-input-validation
title: API 入参校验纪律（http.ts 路由层）
description: 新增/修改业务路由前必读：钳制、Content-Type、体积、坏 JSON
tags: ["api", "validation", "http", "input"]
priority: 85
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/api/**"]
  touches: ["api", "validation", "http", "input", "route"]
timestamp: 2026-10-13T00:00:00Z
---

# API 入参校验纪律

新增或修改 `dsh-autotest/src/api/http.ts` 路由时：

- **整数参数必须钳制**（`clampInt`，上下限都要给）：缺省值要先判空再回落
  （`Number(null)` 是 0，不判空会被夹成下限）；只设上限时 `?limit=-1` 在
  SQLite 下会整表返回；
- **坏 JSON 明确拒绝**（400）：不能静默变成 `{}` 继续写库；
- **Content-Type 白名单**：仅接受 `application/json`（阻断跨站表单式简单请求）；
- **请求体上限 2MB**（`readBody`）：超限继续读完再回 413，立刻 destroy 会让
  客户端看到 ECONNRESET 拿不到错误原因；
- 用例 `steps` 等数组入参走服务端归一化（`normalizeStepsInput`），不接受裸字符串；
- 新增写操作评估是否危险（删除/执行类）：是则标记 `dangerous`，CLI 侧会出现
  `--confirm`，审批模式下入人工队列。
