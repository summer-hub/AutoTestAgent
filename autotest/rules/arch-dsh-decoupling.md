---
id: arch-dsh-decoupling
title: DSH 解耦纪律（独立版/桌面端的前提）
description: 白名单外零 @deepseek-ai import；改 services/ 或新增文件时必读
tags: ["architecture", "dsh", "decoupling", "standalone"]
priority: 95
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/**", "dsh-autotest/scripts/**"]
  touches: ["architecture", "dsh", "import", "standalone", "desktop"]
timestamp: 2026-10-13T00:00:00Z
---

# DSH 解耦纪律

平台三条链路（DSH 插件 / 独立服务器 / 桌面端）共用 `dsh-autotest/src`。
独立版与桌面端**不安装 DSH**，因此除白名单外零 `@deepseek-ai/*` import。

## 白名单（仅这三个位置允许）

- `dsh-autotest/src/index.ts` —— DSH 插件入口（Cordis apply）
- `dsh-autotest/src/client/**` —— DSH GUI 浏览器侧插件（不随独立版分发）
- `dsh-autotest/src/services/llmHarness.ts` —— `ctx.llm` 适配层（DSH 专属）

## 规则

- 新服务/工具放 `services/`，**禁止** import `@deepseek-ai/*`；需要 LLM 时经
  `LlmCall` 类型（`llmCore.ts`）注入，由入口二选一：`makeLlm(ctx)`（DSH）或
  `makeDirectLlm()`（独立版直连 models 表）。
- 跨模块共享能力放 `llmCore.ts` / `metrics.ts` 这类双入口共用模块。
- 验证：`npm run verify:architecture` 会全量扫描，违规直接 FAIL。
