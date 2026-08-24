# AutoTest 平台 — 鸿蒙三方库自动化测试

基于 **DeepSeek Harness 插件系统二次开发**：业务以 Cordis 插件（`dsh-autotest`）形式加载进 DSH profile，复用 `ctx.llm`（模型配置/流式调用）、`ctx.webServer`（HTTP 路由 + 静态资源）；前端已插件化为 **DSH client 插件**（侧边栏入口 + 主区 iframe 嵌入）。独立版（`server/` + `web/` 独立构建）已退役删除。

## 架构（插件化单轨）

```
┌─ DeepSeek Harness 环境（profile）─────────────────────────────┐
│  dsh --profile <name>                                         │
│   ├─ dsh-base          （核心：llm / settings / session …）   │
│   ├─ dsh-host-webserver（ctx.webServer，HTTP 路由）           │
│   └─ dsh-autotest ★    （本平台业务插件）                     │
│       ├─ 自动建表 + 种子（400 库 / 4.5 万用例，开箱即用）     │
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
5. 执行计划选该设备创建「立即执行」，观察 executions 轨迹：
   - 点击/输入/滑动/等待/验证类步骤应真实执行（HarmonyOS：`uitest dumpLayout` 定位 + `uinput` 输入；Android/OpenHarmony：`uiautomator` + `input`，自动探测）
   - 打开应用类步骤走 `aa start -a <ability>`
6. 失败步骤应如实标记 failed 并在日志中给出原因（控件未找到 / 断言失败 / 命令异常）

> 无设备时执行计划自动回退模拟（日志标注），不影响演示；`AUTOTEST_HDC` 环境变量可指定 hdc 路径。

### 方式二：GitHub Release 单文件安装（适合"只装不开发"的环境）

```bash
cd autotest/dsh-autotest && npm pack      # 产出 dsh-autotest-0.1.26.tgz
```

把 tarball 传到 GitHub Release，profile 直接写 URL（和你现在 `dsh-at-file` 的装法一样）：

```jsonc
// ~/.dsh/profiles/<name>/package.json
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.26/dsh-autotest-0.1.26.tgz"
```

仓库已配好 GitHub Actions（打 `v*` tag 自动构建并发布 Release + tarball）：

```bash
git tag v0.1.26 && git push origin v0.1.26
```

## 目录结构

```
autotest/
├── dsh-autotest/           # ★ DSH 服务端插件（Cordis）
│   └── src/
│       ├── index.ts        # apply(ctx)：建表种子 / webServer 注册 / 调度器
│       ├── static.ts       # /autotest-web/* 静态资源 handler（嵌入版前端）
│       ├── client/         # DSH client 插件（侧边栏入口 + iframe 嵌入，DOM 注入）
│       ├── api/http.ts     # mini router + 全部业务 API（库/用例/模型/Prompt/任务/计划/设备）
│       ├── db/             # schema.ts / connection.ts / seed.ts（自动初始化）
│       ├── db/repository.ts# 分表路由（M7，library_id % shardCount）
│       └── services/       # llmHarness / executor / planExecutor / scheduler / analyzer / settings / cache
│   ├── scripts/build-client.mjs  # esbuild → lib/client.js（__ModuleLoader__ 信封）
│   ├── scripts/stress.mjs  # M7 压测（冷/热缓存对比，QPS/p50/p95/p99）
│   └── lib/web/            # 嵌入版前端静态产物（由 web npm run build:embed 生成）
├── web/                    # 前端 React 18 + Vite + TS（DSH 深色风格；双模式）
│   └── src/
│       ├── api.ts          # API 客户端（类型安全，VITE_API_BASE 可切换 /api vs /api/autotest）
│       ├── App.tsx         # 布局 + hash 路由（VITE_EMBED=1 时用嵌入紧凑布局）
│       └── pages/          # Home / Cases / Tasks / Plans / Debug / Devices / Prompts
├── shared/                 # 前后端共享领域类型
└── preview/                # 高保真交互原型（index.html）+ 预览图（shots/ + 总览.html）
```

## 数据库设计（M1 已落地，MySQL 兼容）

| 表 | 说明 | 高并发设计 |
|---|---|---|
| `libraries` | 三方库（400） | 状态索引 |
| `cases` | 用例主表（4.5 万+） | 生产 MySQL 按 `library_id % 16` 分表，repository 层路由 |
| `case_versions` | 单条用例粒度版本历史（快照式） | 每次更新插入新版本 + 主表 `current_version+1`，**版本号单调递增，回滚也产生新版本**，时间线完整可审计 |
| `tasks` | AI 任务（对话/预置卡片） | 状态/库索引 |
| `plans` | 执行计划（立即/定时/单独/批量/全量） | |
| `executions` | 执行记录（调试轨迹 + AI 思考） | |
| `devices` | 设备（单/多设备、历史设备） | |
| `prompts` | Prompt 模板 | |
| `settings` | 系统配置（键值 JSON） | |
| `analyses` | 分析/归因结果 | kind+granularity 索引 |

Redis 缓存、连接池、分表为 M7 高并发里程碑（当前 SQLite 起步，repository 层已预留切换点）。

## 里程碑状态

- ✅ **M0** monorepo 脚手架（server + web + shared）
- ✅ **M1** 数据库 Schema + 种子（400 库 / 45,700 用例 / 70,852 版本记录）
- ✅ **M2** 后端 API：库 CRUD + 用例 CRUD + **版本自动递增 + 回滚 + 版本历史**（已验证）
- ✅ **M3** 前端框架 + DSH 风格布局 + 首页 + 用例库页（真实数据联调）
- ✅ **M4** 任务管理（对话 + 预置卡片，AI 真实执行）+ Prompt 管理 + **设置中自定义添加大模型**（CRUD + 真实连通性测试 + 代理支持）
- ✅ **M5** 执行计划（立即/定时 cron/单独/批量/全量 + 执行引擎生成轨迹与思考 + node-cron 调度）+ 设备管理（扫描识别/历史设备）+ 调试会话（轨迹/思考/追问）
- ✅ **M6a** Excel 导入导出（插件 API：/cases/export 导出 xlsx / /cases/import 解析入库 + Cases 页按钮）
- ✅ **M6b** 数据分析 + 归因分析（GitCode PR 拉取 + AI 分析，真实功能；示例库 lottie_turbo）
- ✅ **M7** 缓存（LRU + Redis 可选）/ 读连接池 / 分表路由 / 压测脚本（冷 1754 QPS → 热 3077 QPS）
- ✅ **M8** 真实执行链路：hdc 真机识别与 UI 自动化执行（uiautomator/input，无设备自动回退模拟）+ 真实 git 拉取/更新（clone/pull + 变更解析）+ to_script 脚本落盘与目录浏览
- ✅ **M9** 脚本执行链路（绑定脚本解析动作步骤执行）+ 失败策略（continue / retry_twice / abort_library）+ 用例版本对比 / 分页组件

## 核心业务语义

- **版本迭代（单条用例粒度）**：每次更新自动递增版本号（V1→V2→V3…，无上限）；回滚恢复目标快照并产生新版本记录；`case_versions` 存全量快照，支持任意时间点审计。
- **来源分类**：新需求引入 / 老库存量 / 问题单跟踪 / AI 生成（种子按 35/30/20/15 分布）。
- **大模型可自定义**：设置 → 模型 支持添加任意 OpenAI 兼容端点（DeepSeek/OpenAI/Ollama/自定义），连通性测试真实调用；任务执行自动走默认模型（未配 Key 时失败并提示，配置后一键重试）。
- **执行计划**：五种类型（立即/定时/单独/批量/全量），定时用 node-cron 注册；执行引擎生成 executions（逐步轨迹 + AI 思考），失败用例可进入调试会话查看与追问；执行模式 `device.execEngine`：`hdc`（默认，真机 uiautomator/input 实测，无设备自动回退模拟）或 `simulate`；全量执行按抽样限制规模。
- **仓库同步**：`pull_repo` / `update_repo` 走真实 git CLI（工作区 `app.workspace/repos/<lib>`，记录 `last_commit` 做变更文件解析，版本取 `git describe --tags`）；`to_script` 生成的脚本落盘到 `app.workspace/scripts/<lib>/<caseNo>.ts`，UI 可浏览/预览。
- **脚本执行与失败策略**：`exec.scriptMode=script`（默认）时，绑定脚本的用例按脚本解析出的动作步骤执行；计划失败策略 `fail_policy`：`continue`（默认）/ `retry_twice`（失败自动重试 2 次）/ `abort_library`（整库失败中止，后续用例跳过）。
- **Excel 导入导出**：Cases 页「⬇ 导出 Excel / ⬆ 导入 Excel」；导出生成 xlsx（用例编号/名称/来源/前置/步骤/预期/状态/版本），导入解析后批量入库并生成 V1 版本快照（支持中文表头与英文键、步骤换行/JSON/分号分隔）。
- **数据分析**：Analysis 页「拉取并分析 PR / 用例更新分析」——从 GitCode API 拉取仓库真实 PR（含变更文件），AI 产出更新点/影响范围/建议用例更新/风险，写入 analyses 表；示例库 `lottie_turbo`（CPF-ApplicationTPC/lottie_turbo）已内置真实仓库地址，可直接体验。
- **归因分析**：Attribution 页三粒度（单用例/单库/多库）——基于失败执行记录与 AI 思考过程，AI 产出结论/根因/证据/建议。
- **LLM 稳健性**：`ctx.llm` 调用自动重试（多模型 × 多次），输出 JSON 做截断/换行/尾逗号容错；LLM 不可用时降级为规则分析（source=fallback），配置 DSH 模型后自动升级为 AI 分析。
- **系统配置**：Settings 页（系统配置）读写 settings 表 14 个配置键（工作区/单任务用例上限/LLM 温度与超时/执行计划抽样/Redis 与缓存 TTL/分表数/执行引擎），保存立即生效——执行引擎、分析器、缓存层全部从配置读取，不再硬编码。
- **M7 高并发**：缓存层（内存 LRU，配置 data.redisUrl 后自动切 Redis + 写路径失效）+ 读连接池（4 只读连接轮询，withRead）+ 分表路由（library_id % 16，shardStats 验证均匀）+ 压测脚本（`node scripts/stress.mjs`，冷/热缓存对比）。
- **前端插件化（步骤 2）**：`dsh-autotest` 增加 client 半边（`dsh.client.platform: web` + `./client` 导出），浏览器侧 DOM 注入侧边栏入口 + 主区 iframe（挂 `/autotest-web/`）；嵌入模式隐藏独立侧边栏/设置弹窗，模型管理直接复用 DSH 设置（设置 → 模型）。独立版前端因此可退役。

## 环境

Node ≥ 20 · 开发期 SQLite（`dsh-autotest/data/autotest.db`，自动建表 + 种子）；生产 MySQL 8 分表 + Redis（M7 已具备切换点：分表路由层 + Redis 适配器）。真实执行依赖系统 git CLI（必选）与 hdc（可选，未装/无设备时自动回退模拟）。
