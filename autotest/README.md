# AutoTest 平台 — 鸿蒙三方库自动化测试

基于 **DeepSeek Harness 插件系统二次开发**：业务以 Cordis 插件（`dsh-autotest`）形式加载进 DSH profile，复用 `ctx.llm`（模型配置/流式调用）、`ctx.webServer`（HTTP 路由 + 静态资源）；前端已插件化为 **DSH client 插件**（侧边栏入口 + 主区 iframe 嵌入）。独立版（`server/` + `web/` 独立构建）已退役删除。

## 架构（插件化单轨）

```
┌─ DeepSeek Harness 环境（profile）─────────────────────────────┐
│  dsh --profile <name>                                         │
│   ├─ dsh-base          （核心：llm / settings / session …）   │
│   ├─ dsh-host-webserver（ctx.webServer，HTTP 路由）           │
│   └─ dsh-autotest ★    （本平台业务插件）                     │
│       ├─ 自动建表 + 种子（真实示例库，开箱即用）              │
│       ├─ /api/autotest/*  业务 API（mini router 挂 webServer）│
│       ├─ /autotest-web/*  嵌入版前端静态资源（lib/web）       │
│       ├─ ctx.llm          AI 任务（模型配置全部来自 DSH 设置）│
│       └─ node-cron        定时执行计划调度                    │
│  ┌─ client 插件（DSH GUI 浏览器侧，dsh.client → lib/client.js）│
│  │   └─ 侧边栏「AutoTest 平台」入口 + 主区 iframe 嵌入前端    │
└────────────────────────────────────────────────────────────────┘
```

## 插件快速开始（DSH 环境）

```bash
# 1. 构建嵌入版前端（产物 → dsh-autotest/lib/web）
cd web && npm run build:embed

# 2. 构建插件（服务端 tsc + client 包 lib/client.js）
cd dsh-autotest && npm install && npm run build

# 3. 测试 profile（已创建于 ~/.dsh/profiles/autotest-test，端口 3290）
dsh --profile autotest-test          # 验证：curl http://localhost:3290/api/autotest/health

# 4. 接入生产 web profile（GUI 重启后生效）：
#    - ~/.dsh/profiles/web/package.json 的 dependencies 加：
#      "dsh-autotest": "link:D:/code/HarmonyProject/20260604/AutoTestAgent/autotest/dsh-autotest"
#    - dsh.profile.bundles 数组加 "dsh-autotest"
#    - cd ~/.dsh/profiles/web && pnpm install && 重启 dsh web
#    - 此后 GUI 自带 /api/autotest/* 业务 API + /autotest-web/* 嵌入前端 +
#      侧边栏「AutoTest 平台」入口（client 插件经 /plugins/dsh-autotest/client.js 下发）；
#      AI 任务直接用 DSH 设置的模型
```

## 从 GitHub 迁移到新 DSH 环境

仓库已提交 `dsh-autotest/lib/` 构建产物（服务端编译 + client 包 + 嵌入版前端），新机器无需本地构建即可直接安装：

```bash
# 1. 一键安装（等价于在 profile 目录执行 pnpm add）
dsh plugin --profile web add github:summer-hub/AutoTestAgent#path:/autotest/dsh-autotest

# 2. 注册 bundle：~/.dsh/profiles/web/package.json 的
#    dsh.profile.bundles 数组加 "dsh-autotest"

# 3. 放行原生依赖构建：~/.dsh/profiles/web/pnpm-workspace.yaml 追加
#    onlyBuiltDependencies: [better-sqlite3]
#    （或 cd ~/.dsh/profiles/web && pnpm approve-builds 交互勾选）

# 4. 安装并重启 DSH
dsh plugin --profile web install
```

> 跨平台坑：`better-sqlite3` 是原生模块，node_modules 不能跨机器/跨系统拷贝，到新机器一律重新安装。要求 Node ≥ 20。
>
> 国内网络访问 GitHub 需要代理时：`git config --global http.proxy http://127.0.0.1:7890`。

### hdc 真机实测清单（连接鸿蒙设备后验证）

```bash
hdc list targets                    # 1. 确认设备被识别（输出 serial，而非 [Empty]）
curl -X POST http://localhost:3080/api/autotest/devices/scan   # 2. 设备页「识别设备」，应新增真机 serial（来源 hdc）
```

3. 设备页确认设备显示「在线」（型号/系统版本来自 `hdc shell param get`）
4. 系统配置 → 设备与执行：`device.appAbilities` 配置「打开应用」的 app→ability 映射，如 `{"时钟":"com.huawei.hmos.smartclock/.MainAbility"}`
5. 用例绑定脚本后，执行计划选该设备创建「立即执行」，观察 executions 轨迹：
   - 计划按用例绑定的 Hypium 模块真机执行：`<装了 hypium 的 python> main.py <module>` → 解析 `reports/latest/result/<module>.xml` 判定通过/失败
     - ⚠️ **必须用装了 hypium 的解释器**：本机 `python` 是 3.13（**没有 hypium**），hypium 6.1.0.210 只装在 `D:\Programs\Python\Python310`，故应执行 `py -3.10 main.py <module>`；也可用 `AUTOTEST_PYTHON` 指定解释器。用错解释器的表现是 `ModuleNotFoundError: No module named 'hypium'`
     - 判据支持模块（`autotest_oracle.py`）会自动写到脚本同目录；它只用**已核实存在**的 Hypium API（`wait_for_component` / `BY.text` / `get_component_property` / `current_app` / `shell` / `capture_screen`），失败一律抛 `TestAssertionError`，绝不静默通过
   - 脚本内的控件定位与动作由 Hypium（`BY.text` / `driver`）在设备侧完成；生成脚本前用「真机遍历生成用例」可拿到真实控件清单
6. 前置条件缺失时应如实失败并写明原因（未检测到 hdc / 无在线设备 / 未检测到 Python / 用例未绑定脚本）

> 无设备时执行计划会**直接置为失败**并写明原因，不再回退模拟；`AUTOTEST_HDC` 环境变量可指定 hdc 路径。

### 方式二：GitHub Release 单文件安装（适合"只装不开发"的环境）

```bash
cd autotest && npm run build:plugin        # 先构建（嵌入版前端 + 服务端 + client）
cd dsh-autotest && npm pack                # 产出 dsh-autotest-<version>.tgz
```

把 tarball 传到 GitHub Release，profile 直接写 URL（和你现在 `dsh-at-file` 的装法一样）：

```jsonc
// ~/.dsh/profiles/<name>/package.json
// 版本号与 dsh-autotest/package.json 的 version 保持一致（CI 会校验 tag 与版本一致）
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.58/dsh-autotest-0.1.58.tgz"
```

仓库已配好 GitHub Actions（打 `v*` tag 自动构建并发布 Release + tarball）。发布前会跑类型检查、三套自检、`lib/` 产物一致性与 tag/版本一致性校验：

```bash
# 先改 dsh-autotest/package.json 的 version，并 npm run build:plugin 提交产物，再打 tag
git tag v0.1.58 && git push origin v0.1.58
```

## 目录结构

```
autotest/
├── dsh-autotest/           # ★ DSH 服务端插件（Cordis）
│   └── src/
│       ├── index.ts        # apply(ctx)：建表种子 / webServer 注册 / 调度器 / 启动清理
│       ├── static.ts       # /autotest-web/* 静态资源 handler（嵌入版前端）
│       ├── client/         # DSH client 插件（侧边栏入口 + iframe 嵌入，DOM 注入）
│       ├── api/http.ts     # mini router + 全部业务 API（库/用例/模型/Prompt/任务/计划/设备）
│       ├── db/             # schema.ts / schema-sqlite.ts / connection.ts / seed.ts（自动初始化）
│       ├── db/repository.ts# 分表路由层（library_id % shardCount，当前仍返回单表）
│       └── services/       # llmHarness / executor / planExecutor / scheduler / analyzer / reaper / secrets / cache
│   ├── scripts/build-client.mjs        # esbuild → lib/client.js（__ModuleLoader__ 信封）
│   ├── scripts/verify-data-integrity.mjs  # 数据层自检（事务/归档/种子/脱敏/运行态）
│   ├── scripts/verify-api-guard.mjs       # API 门禁自检（同源/体积/入参/缓存/信封）
│   ├── scripts/verify-step-contract.mjs   # 生成端句式 ↔ 执行端映射契约
│   ├── scripts/stress.mjs             # 压测（冷/热缓存对比，QPS/p50/p95/p99）
│   └── lib/web/            # 嵌入版前端静态产物（由 web npm run build:embed 生成）
├── web/                    # 前端 React 18 + Vite + TS（DSH 深色风格，嵌入 DSH 主区）
│   └── src/
│       ├── api.ts          # API 客户端（类型安全；列表信封兼容新旧后端形状）
│       ├── App.tsx         # 布局 + hash 路由（VITE_EMBED=1 时用嵌入紧凑布局）
│       └── pages/          # Home / Cases / Tasks / Plans / Analysis / Attribution / Debug / Devices / Prompts / Scripts / Settings
├── shared/                 # 前后端共享领域类型
└── preview/                # 高保真交互原型（index.html）+ 预览图（shots/ + 总览.html）
```

## 数据库设计（M1 已落地，MySQL 兼容）

| 表 | 说明 | 高并发设计 |
|---|---|---|
| `libraries` | 三方库（种子注册真实示例库，其余按需拉取） | 状态索引 |
| `cases` | 用例主表 | 生产 MySQL 规划按 `library_id % 16` 分表；**当前 `caseTableFor()` 仍返回单表 `cases`**，路由层已预留但未启用 |
| `case_versions` | 单条用例粒度版本历史（快照式） | 每次更新插入新版本 + 主表 `current_version+1`，**版本号单调递增，回滚也产生新版本**，时间线完整可审计 |
| `tasks` | AI 任务（对话/预置卡片） | 状态/库索引 |
| `plans` | 执行计划（立即/定时/单独/批量/全量） | |
| `executions` / `executions_archive` | 执行记录（调试轨迹 + AI 思考）；归档表列必须与主表一一对应 | 每日 03:00 归档 6 个月前记录 |
| `devices` | 设备（真机识别 + 历史设备） | |
| `prompts` | Prompt 模板 | |
| `settings` | 系统配置（键值 JSON，敏感项出参脱敏） | |
| `analyses` | 分析/归因结果 | kind+granularity 索引 |
| `agent_events` | 链路追踪事件（LLM 调用 / 遍历 op / dry-run 步） | 追加式，按 task/kind 索引 |

Redis 缓存与连接池已落地；分表路由层存在但未启用（当前 SQLite 起步，`repository.ts` 是切换点）。

## 里程碑状态

- ✅ **M0** monorepo 脚手架（web + shared + 插件）
- ✅ **M1** 数据库 Schema + 种子（真实示例库 + 内置 Prompt/模型/配置）
- ✅ **M2** 后端 API：用例 CRUD + **版本自动递增 + 回滚 + 版本历史**（已验证）
- ✅ **M3** 前端框架 + DSH 风格布局 + 首页 + 用例库页（真实数据联调）
- ✅ **M4** 任务管理（对话 + 预置卡片，AI 真实执行）+ Prompt 管理 + 模型连通性测试
- ✅ **M5** 执行计划（立即/定时 cron/单独/批量/全量 + 执行记录与 AI 思考 + node-cron 调度）+ 设备管理 + 调试会话（轨迹/思考/追问）
- ✅ **M6a** Excel 导入导出（/cases/export 导出 xlsx / /cases/import 解析入库 + Cases 页按钮）
- ✅ **M6b** 数据分析 + 归因分析（GitCode PR 拉取 + AI 分析，真实功能；示例库 lottie_turbo）
- ✅ **M7** 缓存（LRU + Redis 可选）/ 连接池 / 分表路由层（预留）/ 压测脚本（开发期单机 SQLite 实测：冷 1754 QPS → 热 3077 QPS）
- ✅ **M8** 真实执行链路：hdc 真机识别 + 真实 git 拉取/更新（clone/pull + 变更解析）+ 脚本落盘与目录浏览
- ✅ **M9** 脚本执行链路（Hypium 模块真机执行 + xdevice 结果解析）+ 失败策略（continue / retry_twice / abort_library）+ 用例版本对比 / 分页组件
- ✅ **M10** 稳固性轮次（见 `docs/修复记录-2026-09-12.md`）：SQLite 事务隔离、归档列漂移、密钥出参脱敏、请求安全闸门、分页信封、计划生命周期与 reaper、`lib/` 与 CI 门禁

## 核心业务语义

- **版本迭代（单条用例粒度）**：每次更新自动递增版本号（V1→V2→V3…，无上限）；回滚恢复目标快照并产生新版本记录；`case_versions` 存全量快照，支持任意时间点审计。
- **来源分类**：新需求引入 / 老库存量 / 问题单跟踪 / AI 生成（由生成任务与 Excel 导入决定，不再预设比例）。
- **大模型可自定义**：设置 → 模型 支持添加任意 OpenAI 兼容端点（DeepSeek/OpenAI/Ollama/自定义），连通性测试真实调用；任务执行自动走默认模型（未配 Key 时失败并提示，配置后一键重试）。
- **执行计划**：五种类型（立即/定时/单独/批量/全量），定时用 node-cron 注册（删除计划会同步注销定时任务）；同一计划**同一时刻只会执行一份**（原子占位 + 重入保护），执行体异常也必定落到终态，不会永久停在 running；失败用例可进入调试会话查看与追问；无在线真机时直接失败并写明原因（**没有模拟回退**）。
- **仓库同步**：`pull_repo` / `update_repo` 走真实 git CLI（工作区 `app.workspace/repos/<lib>`，记录 `last_commit` 做变更文件解析，版本取 `git describe --tags`）；脚本落盘到 `app.workspace/hypium/<lib>/testcases/<lib>/<caseNo>.py`（Python/Hypium），UI 可浏览/预览/编辑。
- **脚本执行与失败策略**：执行计划按用例绑定的 Hypium 模块真机执行（`<装了 hypium 的 python> main.py <module>` → 解析 `reports/latest/result/<module>.xml`；本机应使用 `py -3.10`，见上文注意事项）；计划失败策略 `fail_policy`：`continue`（默认）/ `retry_twice`（失败自动重试 2 次）/ `abort_library`（整库失败中止，后续用例跳过）。
- **Excel 导入导出**：Cases 页「⬇ 导出 Excel / ⬆ 导入 Excel」；导出生成 xlsx（用例编号/名称/来源/前置/步骤/预期/状态/版本），导入解析后批量入库并生成 V1 版本快照（支持中文表头与英文键、步骤换行/JSON/分号分隔）。
- **数据分析**：Analysis 页「拉取并分析 PR / 用例更新分析」——从 GitCode API 拉取仓库真实 PR（含变更文件），AI 产出更新点/影响范围/建议用例更新/风险，写入 analyses 表；示例库 `lottie_turbo`（CPF-ApplicationTPC/lottie_turbo）已内置真实仓库地址，可直接体验。
- **归因分析**：Attribution 页自由勾选失败执行（支持跨库，整库失败会整库纳入）——基于失败执行记录与 AI 思考过程，AI 产出结论/根因/证据/建议。
- **LLM 稳健性**：`ctx.llm` 选定模型后最多重试 3 次（**不跨模型切换**，行为确定性优先）；输出 JSON 做围栏剥离/换行/尾逗号容错，解析失败会把错误回灌模型修复一次；驱动分片生成的解析错误保存在**调用局部变量**里（并发分片之间不会互相污染）；LLM 不可用时降级为规则分析（source=fallback）。
- **系统配置**：Settings 页读写 settings 表的配置键（工作区/单任务用例上限/LLM 温度与超时/计划抽样/Redis 与缓存 TTL/遍历参数/MySQL 连接串），保存立即生效。**敏感键（MySQL/Redis 连接串）出参只回传打码值**，且掩码原样回传会被识别为"不改动"，不会覆盖真实凭据。
- **缓存与连接池**：内存 LRU（配置 `data.redisUrl` + `data.redisCache` 后自动切 Redis），写路径在**写库成功之后**按前缀失效（含单条用例键）；MySQL 连接池；`repository.ts` 的 `library_id % 16` 分表路由层**已预留但未启用**（`caseTableFor()` 恒返回 `cases`），压测脚本 `node scripts/stress.mjs` 用于冷/热缓存对比。
- **前端插件化（步骤 2）**：`dsh-autotest` 增加 client 半边（`dsh.client.platform: web` + `./client` 导出），浏览器侧 DOM 注入侧边栏入口 + 主区 iframe（挂 `/autotest-web/`）。**嵌入布局为「左侧导航 + 右侧内容」**：左侧 176px 导航按分组竖排 11 个入口（可手动收起为 56px 图标轨道，状态记在 localStorage；窗口窄于 560px 时自动收起并隐藏折叠按钮），右侧顶部是「分组 / 当前页」面包屑、下方是页面详情。模型管理直接复用 DSH 设置（设置 → 模型）。

## 自检（提交前 / CI 门禁）

三套自检都**不连 MySQL、不调 LLM**；无设备时真机相关分组自动跳过。CI 在打包发布前强制运行。

```bash
cd autotest
npm run typecheck     # web + 插件类型检查
npm run verify:all    # 构建 + 下面三套
```

| 命令 | 覆盖内容 |
|---|---|
| `npm run verify:data` | 事务隔离与串行（SQLite 单连接并发）、归档表列对齐并真跑一次归档、种子不写死工作区、密钥脱敏与防回写、残留 running 清理与计划重入保护、`llmJson` 并发隔离 |
| `npm run verify:api` | 进程内起真实 HTTP 服务挂业务 handler：同源闸门（Origin/Sec-Fetch-Site）、Content-Type 白名单、请求体体积上限、坏 JSON 拒绝、出参脱敏、模型端点协议/元数据地址校验、`limit` 钳制、用例 `steps` 入参校验、读写缓存一致性、列表信封 `nextCursor` |
| `node scripts/verify-step-contract.mjs` | 步骤句式 → Hypium 调用映射、控件引用 guardrail、执行端 dry-run 真机判定（无设备自动跳过） |

改动生成端句式或执行端映射后，务必跑 `verify:contract`：两端脱节会让脚本退化成注释，或让 dry-run 产生系统性假失败。

## 环境

Node ≥ 20 · 开发期 SQLite（`dsh-autotest/data/autotest.sqlite3`，自动建表 + 种子）；生产 MySQL 8 + Redis（切换点：`db.mysqlUrl` 配置项 + `repository.ts` 分表路由层，分表本身尚未启用）。真实执行依赖系统 git CLI 与在线真机（hdc + Python/xdevice）；两者缺失时计划直接失败并写明原因，**不会回退模拟**。
