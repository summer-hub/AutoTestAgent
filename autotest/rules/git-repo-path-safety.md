---
id: git-repo-path-safety
title: 仓库路径与外部命令纪律（gitRepo/hdc）
description: 改 gitRepo/hdc/executor 前必读：路径穿越、子目录解析、命令注入防护
tags: ["git", "repo", "path", "security", "hdc", "exec"]
priority: 87
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/services/gitRepo.ts", "dsh-autotest/src/services/hdc.ts", "dsh-autotest/src/services/executor.ts", "dsh-autotest/src/api/http.ts"]
  touches: ["git", "repo", "path", "hdc", "exec", "clone", "pull"]
timestamp: 2026-10-13T00:00:00Z
---

# 仓库路径与外部命令纪律

- **路径穿越防护**：任何用户可控路径片段（`rel`、`subpath`）拼绝对路径后必须
  `resolve` + `startsWith(root + sep)` 双重校验（`/repos/:id/files`、
  `/repos/:libraryId/file` 都有范例）；
- **同仓共享克隆**：`repoRootDir` 按仓库名共享（同仓多个库只有一份克隆），
  单体仓子目录库的 repoDir = 仓库根 + subpath；
- **`/tree/<分支>/<子目录>` 拆分**：`splitRepoUrl` 在入库/同步时拆成
  repo_url + repo_subpath 两列，不要在运行期反复解析；
- **外部命令**：`execFileSync`/`execFile` 必须 `windowsHide: true`（否则
  Windows 弹控制台窗口）；参数走数组形式，**禁止**字符串拼接 shell；
- 删除仓库文件只允许 hypium 目录下的 `.py`（DELETE /repos/:libraryId/file），
  且属于危险操作（审批流覆盖）。
