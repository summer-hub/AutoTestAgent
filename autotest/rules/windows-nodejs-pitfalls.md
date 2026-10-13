---
id: windows-nodejs-pitfalls
title: Windows / Node 踩坑清单（本仓库真实事故）
description: 写构建脚本、spawn、import、哈希、解压前必读
tags: ["windows", "nodejs", "build", "spawn", "import", "hash"]
priority: 89
load_bearing: true
inject_when:
  paths: ["**/scripts/**", "**/*.mjs", "dsh-autotest/scripts/**", "agent-tools/scripts/**", "desktop/scripts/**"]
  touches: ["windows", "build", "spawn", "import", "hash", "esbuild", "tar", "path"]
timestamp: 2026-10-13T00:00:00Z
---

# Windows / Node 踩坑清单

全部来自本仓库真实事故，不是臆测：

- **双 shebang**：源文件写 `#!/usr/bin/env node` + esbuild `banner` 又加一个 →
  产物第 2 行的 shebang 触发 `SyntaxError`。shebang 只能有一个出处（banner）；
- **`spawnSync` 冻结父进程事件循环**：子进程向父进程内的 HTTP 服务发请求时
  无人应答，必然超时。自检/编排场景一律用异步 `spawn` + Promise；
- **Windows 绝对路径喂动态 `import()`**：报 `ERR_UNSUPPORTED_ESM_URL_SCHEME
  (protocol 'd:')`。必须 `pathToFileURL(p).href` 转换；
- **哈希排序**：`localeCompare`（区域感知）与码元序（默认 sort）对
  `SKILL.md` vs `scripts/...` 这类大小写混合路径顺序不同 → digest 对不上。
  生成器与校验器必须同一种排序（本仓库用码元序）；
- **tar 不认 zip**：node 官方发行包是 zip，用 PowerShell `Expand-Archive`；
  bsdtar 的 `-C D:\...` 会把盘符当 `host:path` 远程语法；
- **NTFS 上 POSIX mode 是摆设**：`writeFileSync({mode})` 被忽略成继承 ACL，
  敏感文件要 `icacls /inheritance:r /grant:r <user>:(F)` 收敛。
