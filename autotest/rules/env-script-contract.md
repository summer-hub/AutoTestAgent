---
id: env-script-contract
title: 环境脚本契约纪律（envkit 新增/改脚本前必读）
description: 改 assets/env/ 或 services/envkit/ 前必读：契约七项、失败分类、产物校验、跨平台成对
tags: ["envkit", "script", "contract", "environment", "failure", "cross-platform"]
priority: 84
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/services/envkit/**", "dsh-autotest/assets/env/**", "dsh-autotest/scripts/verify-envkit.mjs"]
  touches: ["envkit", "script", "contract", "environment", "failure", "build", "hdc", "ohpm"]
timestamp: 2026-10-14T00:00:00Z
---

# 环境脚本契约纪律

`assets/env/<entry>.{ps1,sh}` 是脚本本体，`src/services/envkit/builtin.ts` 是它的**契约**。
平台侧只认契约，不认某个脚本的实现细节——所以改脚本必须先想清楚契约。

## 规则

1. **契约七项必须齐全**：`inputs` / `outputs` / `applies_when` / `failure_taxonomy` /
   `idempotent` / `timeout_sec` / `approval`。缺一项 `validateContract` 会直接拦下
   （自检 `verify:envkit` 覆盖）。
2. **声明了 `timeout_sec` 就必须把 `timeout` 纳入 `failure_taxonomy`**，否则超时会被归成
   `unknown`，人不知道该修什么。同理，归类结果不在契约声明内时 `inTaxonomy=false`，
   这是在提醒你该扩码表，不是 bug。
3. **产物必须声明且必须真存在**：构建类脚本要声明 `*Path` 输出，runner 会真的 `stat`。
   "命令退出码 0 但产物没有"是 `artifact_not_found`，**判失败不判成功**——这是最能
   骗过人的一类失败。
4. **跨平台必须成对**：改 `.ps1` 就要同步改 `.sh`，行为逐条对齐（同样的参数名、同样的
   退出码、同样的产物判据）。只改一侧会造成"Windows 能跑、Linux 静默失败"。
5. **退出码只用这四个**：0 成功 / 1 业务失败 / 2 工具缺失 / 3 超时 / 4 取消。
   不要自造退出码语义——`normalizeExitCode` 会把它们归一掉，自造的等于白写。
6. **参数按数组传给 spawn，绝不 shell 拼接**：`runScriptStep` 已经这么做了，
   不要在脚本里再 `eval` 或拼命令字符串（与 `git-repo-path-safety` 同源）。
7. **不要在脚本里做人肉失败分类**：把原始错误原样打到 stdout/stderr，
   归类交给 `failure.ts` 的信号表。脚本里写死"这是网络问题"会和平台侧规则重复且容易不一致。
8. **入口路径不得含 `..`**：`entry` 是 `assets/env/` 下的相对路径，含 `..` 一律拒绝
   （防目录穿越，契约校验已拦）。
9. **新增脚本要同步三处**：`assets/env/` 本体 → `builtin.ts` 契约 → `verify-envkit.mjs`
   断言。漏了自检，契约腐坏了没人知道。
10. **指纹会变就要接受重跑**：`fingerprintOf` 把工具链、步骤、参数、commit 都算进哈希。
    改了这些本就该重跑，不要为了"少跑一次"把它们从指纹里摘掉。

## 失败分类码表在哪扩

`src/services/envkit/failure.ts` 的 `SIGNALS` 数组。加新类别时：
先加 `FAILURE_KINDS`，再加信号正则，**信号顺序即优先级**——
工具缺失必须在最前，否则 `command not found` 会被后面的编译错误规则吃掉。
