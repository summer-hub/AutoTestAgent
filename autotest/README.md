# AutoTest 平台 — 鸿蒙三方库自动化测试

基于 **DeepSeek Harness 插件系统二次开发**：业务以 Cordis 插件（`dsh-autotest`）形式加载进 DSH profile，复用 `ctx.llm`（模型配置/流式调用）、`ctx.webServer`（HTTP 路由 + 静态资源）；前端已插件化为 **DSH client 插件**（侧边栏入口 + 主区 iframe 嵌入）。

**三条交付链路共用同一套后端源码**（`dsh-autotest/src`），按宿主不同分三个入口：

| 链路 | 入口 | 适用场景 |
|---|---|---|
| DSH 插件 | `lib/index.js`（Cordis） | 已装 DSH 的机器，模型配置复用 DSH 设置 |
| 纯 Web 独立版 | `lib/standalone.js`（node:http） | 不装 DSH，`npm start` 即用；LLM 走系统配置里的 models 表 |
| 桌面端 | `desktop/`（Tauri v2 外壳托管上面的独立服务器） | Windows 双击即用，自带 Node 运行时与数据目录 |

详细部署/运维（环境变量、集群、MySQL/Redis、托盘与排障）见 [docs/standalone-desktop.md](../docs/standalone-desktop.md)。

## 架构（三链路）

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

┌─ 纯 Web 独立版（不依赖 DSH）──────────────────────────────────┐
│  node dsh-autotest/lib/standalone.js                          │
│   ├─ /api/autotest/*  同一套业务 API（自带 node:http）         │
│   ├─ /                独立版前端 SPA（dist/web，.gz 预压缩）   │
│   ├─ llmDirect         LLM 直连 models 表（OpenAI 兼容）       │
│   └─ MySQL/SQLite + Redis 可选；AUTOTEST_WORKERS 多进程集群   │
└────────────────────────────────────────────────────────────────┘

┌─ 桌面端（Tauri v2，Windows）──────────────────────────────────┐
│  autotest-desktop.exe                                         │
│   ├─ Rust 壳：拉起随包 node + 独立服务器（随机端口）           │
│   ├─ WebView 指向 http://127.0.0.1:<port>/                    │
│   ├─ 托盘驻留 / 关闭到托盘 / 单实例 / Job Object 防孤儿进程    │
│   └─ 数据目录隔离在 %APPDATA%/com.autotest.platform            │
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
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v1.0.0-rc.1/dsh-autotest-1.0.0-rc.1.tgz"
```

仓库已配好 GitHub Actions（打 `v*` tag 自动构建并发布 Release + tarball）。发布前会跑类型检查、37 套自检、`lib/` 产物一致性与 tag/版本一致性校验：

```bash
# 先改 dsh-autotest/package.json 的 version，并 npm run build:plugin 提交产物，再打 tag
git tag v1.0.0-rc.1 && git push origin v1.0.0-rc.1
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
| `library_catalog_imports` | **R0 目录引导导入留痕**：随包三方库测试表 → 业务库的每次导入 | 只追加不更新；sha256 是幂等键，同表重复导入不写库也不刷记录 |
| `script_library` / `script_library_versions` | **R1 脚本资产库**：14 个环境脚本的契约（输入/输出/适用条件/失败分类/幂等/超时/审批）+ 版本史 | DB 覆盖优先于内置；契约指纹漂移可检出（升级后契约变了会被抓住） |
| `env_profiles` / `env_profile_steps` | **R1 环境画像**：一个库在什么工具链/依赖/步骤序列下才测得动 | 一个库可有多份画像（uk 含 name）；步骤参数用 `{{repoDir}}` 占位 |
| `env_runs` / `env_run_steps` | **R1 环境准备运行**：一次「克隆→装包」的完整执行与逐步明细 | fingerprint 命中即缓存复用（**含 failed**：环境失败在工具链不变时每次同样失败，不复用等于反复白等） |
| `library_facts` | **R2 L0 静态画像**：类别、构建目标、二进制 ABI、依赖、资源候选、README 情报 | 一个库一份最新事实（uk = library_id）；按 (kind, confidence) 索引供预设匹配 |
| `library_survey_runs` | **R2 单库采集记录**：断点续跑的单位 | 成功/待 LLM 且 commit 未变 → 跳过；**失败的仍重试**（环境失败重跑一次可能就成功） |
| `library_survey_batches` | **R2 采集批次**：进度与验收指标的可观测单位 | 进度逐步落库（不是跑完才一次性写），前端可实时看 |
| `test_resources` / `test_resource_versions` | **R2 测试资源登记**：三类来源（仓库检出/上游 canonical/程序合成） | resource_id 稳定主键（重复登记不新建行）；sha256 + 版本史 + 复用计数 + 临期检出 |
| `readme_intel` | **R2 README 情报**：构建命令/依赖/前置条件/已知问题/样本资源 | 按 (library_id, kind, status) 索引，供 L2 与人工队列消费 |

> `executions` 表另增加 `env_run_id` / `resource_set_id` 两列——一次执行必须能回答
> 「跑在哪个环境、用哪批资源」，否则回归结果不可信。归档表 `executions_archive`
> 列必须与主表一一对应（缺列会让 `INSERT..SELECT` 静默失效，自检有专项守着）。

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
- ✅ **M10** 稳固性轮次：SQLite 事务隔离、归档列漂移、密钥出参脱敏、请求安全闸门、分页信封、计划生命周期与 reaper、`lib/` 与 CI 门禁
- ✅ **架构整改**（见 `docs/架构评审-2026-09-21.md`）：任务 lane + 取消、轨迹事件溯源、数据目录迁出 `node_modules`、LLM 重试换模型 / Redis 全局限流 / 单任务 token 预算
- ✅ **R0 目录引导**（`docs/重构方案-环境与资源纵轴.md`）：`三方库测试表.xlsx` 随包分发（构建时复制进 `lib/assets/`）+ 启动 bootstrap 幂等导入；**SQLite/MySQL 业务库为唯一事实源**，xlsx 只是初始种子与人工增量入口、绝不回写；三入口（DSH 插件 / 独立 Web / 桌面端）共用同一 `dataDir()` 与同一 bootstrap，`GET /libraries/catalog` 可自证导入结果
- ✅ **R1 环境纵轴地基**：`services/envkit/`（契约层 / 失败分类 11 类 / runner / 内置脚本 / 注册表 / 画像编排）+ 5 个脚本资产（ohpm_install / build_manifest / build_har / build_hap / hdc_install，`.ps1`+`.sh` 成对）+ `script_library` 与 `env_profiles`/`env_runs` 六张表 + 审批 `env.step`/`env.run` + 10 条 `env.*` agent 规格 + web「环境准备」页
- ✅ **R2 全量库规模化**：L0→L3 四级分层（**AI 单位成本从"每库"降到"每类 + 每异常"**）；`services/survey/` L0 静态画像（零 LLM 确定性：类别判定 / 事实构建 / README 情报 / 资源候选）+ `assets/presets/` 五类预设 + 批量流水线（受控并发默认 4、断点续跑、单库失败隔离、可取消、进度逐步落库）+ `resourcekit`（三类来源登记、animation_json 六变体、schema 区分畸形与合法边界）+ web「全量分析」页
- ✅ **R3 智能增量与知识沉淀**：知识库新增 5 种 kind（env_recipe / resource_recipe / dep_fix / cert_recipe / build_fix）与 2 种 scope（toolchain / resource_kind）+ 3 个检索维度（**libraryKind 让"lottie 的动画经验"可被另一个动画库复用**）+ `injectForStage` 新增 env_prep / resource_build；L2 LLM 增量采集只跑差异库（校验闸门：scriptId 必须真实存在、参数必须过契约；不确定项入队而非把猜测当结论）；人工队列新增 env_blocked / resource_missing / toolchain_missing 三类
- ✅ **R4 构建安装闭环与端到端**：脚本资产扩至 14 个（+submodule_sync / binary_dep_fetch / smoke_check / gen_ca / mock_server_up / mock_server_stop / xts_scaffold / xts_run / xts_report）；**占位符替换与步骤输出串联**（`{{repoDir}}` 运行期替换、`build_hap` 打 `HAP_PATH` → `hdc_install` 引用）让「克隆→依赖→构建→装包→冒烟」串成一条链；R2/R3 新路由补 RBAC 角色标注
- ✅ **R0–R4 收口（G1–G4）**：L2 透传 taskId 使 token 预算闸门生效；前端接入 L2 触发与待处理清单；人工队列按「库类别 × 阻塞原因」聚合；文档补齐

## 核心业务语义

- **版本迭代（单条用例粒度）**：每次更新自动递增版本号（V1→V2→V3…，无上限）；回滚恢复目标快照并产生新版本记录；`case_versions` 存全量快照，支持任意时间点审计。
- **初版用例 ↔ 接口整合（P11）**：真机遍历产出的**初版用例**此前不与接口挂钩（`api_symbol_id` 只有矩阵驱动生成时才写），因此既进不了覆盖矩阵也不算覆盖率。P11 补上这条链：① `case_symbol_links` 多对多关联（每条关联都带**依据**与置信度：生成时指定 / 页面命中 / 名称命中 / 人工确认，弱证据只列出不计入覆盖率，人工确认**不被自动重算覆盖**）；② 矩阵的「用例」列改为取并集，初版用例也能看见，并新增**未关联用例数**指标；③ 任务「整合初版用例为正式用例」：先关联 → 把初版草稿连同**该页真机控件清单**与**关联接口的签名/参数/异常**回灌 LLM 升级为正式用例（补可机器校验判据、升版 V2 并保留初版快照、来源标 `遍历初版→正式`）→ 接口无用例的按计划补生成 → 重算覆盖率并给前后对比；④ 覆盖矩阵页新增「**矩阵图**」视图：行=接口、列=场景，绿=已有用例 / 黄=适用但缺用例 / 灰=不适用，点格子看用例与各自的关联依据。
- **来源分类**：新需求引入 / 老库存量 / 问题单跟踪 / AI 生成（由生成任务与 Excel 导入决定，不再预设比例）。
- **目录引导（R0）**：`三方库测试表.xlsx` 随包分发（构建后 `lib/assets/`），首次启动自动导入业务库；**SQLite/MySQL 业务库是唯一事实源**，xlsx 只是初始种子与人工增量入口，不被回写。导入幂等（sha256 判定）、只增不删、只写「库名/仓库地址/子目录」三列（包名等 Agent 字段绝不覆盖），表读不出只告警不阻断启动。
- **大模型可自定义**：设置 → 模型 支持添加任意 OpenAI 兼容端点（DeepSeek/OpenAI/Ollama/自定义），连通性测试真实调用；任务执行自动走默认模型（未配 Key 时失败并提示，配置后一键重试）。
- **执行计划**：五种类型（立即/定时/单独/批量/全量），定时用 node-cron 注册（删除计划会同步注销定时任务）；同一计划**同一时刻只会执行一份**（原子占位 + 重入保护），执行体异常也必定落到终态，不会永久停在 running；失败用例可进入调试会话查看与追问；无在线真机时直接失败并写明原因（**没有模拟回退**）。
- **仓库同步**：`pull_repo` / `update_repo` 走真实 git CLI（工作区 `app.workspace/repos/<lib>`，记录 `last_commit` 做变更文件解析，版本取 `git describe --tags`）；脚本落盘到 `app.workspace/hypium/<lib>/testcases/<lib>/<caseNo>.py`（Python/Hypium），UI 可浏览/预览/编辑。
- **脚本执行与失败策略**：执行计划按用例绑定的 Hypium 模块真机执行（`<装了 hypium 的 python> main.py <module>` → 解析 `reports/latest/result/<module>.xml`；本机应使用 `py -3.10`，见上文注意事项）；计划失败策略 `fail_policy`：`continue`（默认）/ `retry_twice`（失败自动重试 2 次）/ `abort_library`（整库失败中止，后续用例跳过）。
- **Excel 导入导出**：Cases 页「⬇ 导出 Excel / ⬆ 导入 Excel」；导出生成 xlsx（用例编号/名称/来源/前置/步骤/预期/状态/版本），导入解析后批量入库并生成 V1 版本快照（支持中文表头与英文键、步骤换行/JSON/分号分隔）。
- **数据分析**：Analysis 页「拉取并分析 PR / 用例更新分析」——从 GitCode API 拉取仓库真实 PR（含变更文件），AI 产出更新点/影响范围/建议用例更新/风险，写入 analyses 表；示例库 `lottie_turbo`（CPF-ApplicationTPC/lottie_turbo）已内置真实仓库地址，可直接体验。
- **归因分析**：Attribution 页自由勾选失败执行（支持跨库，整库失败会整库纳入）——基于失败执行记录与 AI 思考过程，AI 产出结论/根因/证据/建议。
- **LLM 稳健性**：`ctx.llm` 选定模型后最多重试 3 次，**失败会跨模型切换**（首选打头 → 其余候选顺次 → 不足 3 个绕回首选），不再 3 次全打在同一个模型上；任务取消信号触发时立即收手不重试；输出 JSON 做围栏剥离/换行/尾逗号容错，解析失败会把错误回灌模型修复一次；驱动分片生成的解析错误保存在**调用局部变量**里（并发分片之间不会互相污染）；LLM 不可用时降级为规则分析（source=fallback）。
- **成本与限流**：每次 LLM 调用按 `meta.taskId` 记账到 `agent_events`（成功/失败都带 tokens），单任务累计超过 `agent.maxTokensPerTask`（默认 300000，0=不限制）即中止后续模型调用；每分钟调用上限 `exec.llmRatePerMin` 在 Redis 可用时用 INCR 做**跨节点共享**的固定窗口计数（未配 Redis 退回进程内滑动窗口），计数只挂在 API 入口，任务内部的连环调用由 token 预算管。
- **系统配置**：Settings 页读写 settings 表的配置键（工作区/单任务用例上限/LLM 温度与超时/计划抽样/Redis 与缓存 TTL/遍历参数/MySQL 连接串），保存立即生效。**敏感键（MySQL/Redis 连接串）出参只回传打码值**，且掩码原样回传会被识别为"不改动"，不会覆盖真实凭据。
- **缓存与连接池**：内存 LRU（配置 `data.redisUrl` + `data.redisCache` 后自动切 Redis），写路径在**写库成功之后**按前缀失效（含单条用例键）；MySQL 连接池；`repository.ts` 的 `library_id % 16` 分表路由层**已预留但未启用**（`caseTableFor()` 恒返回 `cases`），压测脚本 `node scripts/stress.mjs` 用于冷/热缓存对比。
- **前端插件化（步骤 2）**：`dsh-autotest` 增加 client 半边（`dsh.client.platform: web` + `./client` 导出），浏览器侧 DOM 注入侧边栏入口 + 主区 iframe（挂 `/autotest-web/`）。**嵌入布局为「左侧导航 + 右侧内容」**：左侧 176px 导航按分组竖排 11 个入口（可手动收起为 56px 图标轨道，状态记在 localStorage；窗口窄于 560px 时自动收起并隐藏折叠按钮），右侧顶部是「分组 / 当前页」面包屑、下方是页面详情。模型管理直接复用 DSH 设置（设置 → 模型）。

## 自检（提交前 / CI 门禁）

37 套自检都**不连 MySQL、不调 LLM**（用临时 SQLite 库与临时工作区，不碰你的数据；LLM 层用可观测的假 `ctx.llm`，Redis 用内存假 RESP 服务）；无设备时真机相关分组自动跳过，无 hypium 时判据运行期那套自动跳过。CI 在打包发布前强制运行。

```bash
cd autotest
npm run typecheck     # web + 插件类型检查
npm run verify:all    # 构建 + 37 套自检（无设备 / 无 hypium 的项自动跳过）
```

| 命令 | 覆盖内容 |
|---|---|
| `npm run verify:data` | 事务隔离与串行（SQLite 单连接并发）、归档表列对齐并真跑一次归档、种子不写死工作区、密钥脱敏与防回写、残留 running 清理与计划重入保护、`llmJson` 并发隔离 |
| `npm run verify:data-dir` | 默认落点不含 `node_modules`、`AUTOTEST_DATA_DIR` 覆盖优先且不触发迁移、★ 旧数据一条不少、已迁过不重复搬、★ 搬不动退回旧目录、★ WAL 数据不丢 |
| `npm run verify:api` | 进程内起真实 HTTP 服务挂业务 handler：同源闸门（Origin/Sec-Fetch-Site）、Content-Type 白名单、请求体体积上限、坏 JSON 拒绝、出参脱敏、模型端点协议/元数据地址校验、`limit` 钳制、用例 `steps` 入参校验、读写缓存一致性、列表信封 `nextCursor` |
| `npm run verify:crypto` | 凭据静态加密（P0-2）：AES-256-GCM 往返（中文/连接串/长值）、旧明文透传懒迁移、空值不加密、密文幂等、主密钥文件自动生成与 ACL 收敛（Windows icacls / POSIX 0600）、settings 敏感键端到端（库内直读是密文、读回明文）、掩码语义不变、解密失败容错 |
| `npm run verify:auth` | 认证 + RBAC（P0-1）：Key 创建返回明文仅一次、库内只存 SHA-256、无 Key/错 Key → 401、viewer/operator/admin 角色矩阵（GET 放行 / 写 403 / 敏感组 403）、/health 与 /auth/status 免鉴权、回环豁免开关、禁用/过期 Key 拒绝、401 后 keep-alive 连接不污染 |
| `npm run verify:metrics` | 可观测出口（P0-3）：Counter/Histogram（累积语义、桶归属、sum/count）、HTTP 埋点按路由模式聚合（:id 不炸基数）、LLM trace hook → 调用/token 计数、/metrics Prometheus 文本格式与 admin 门禁（401/403/200）、JSON 日志模式（结构化请求行）与文本模式默认不变 |
| `npm run verify:approvals` | 危险操作审批（P0-4）：autoApprove 默认兼容（不建单）、关闭后删除类操作 409 入队、重复操作幂等复用同一条、一次性批准令牌（批准→重试放行→再调重新待批）、终态守卫、拒绝后仍拦截、批准后端到端真删、operator 决策/viewer 只读的角色门禁 |
| `npm run verify:skill-lock` | 技能供应链锁（P1-2）：锁文件与 skills/ digest 一致、单字节篡改检出且 changedFiles 指到具体文件、新增未锁定 → unlocked、删除 → missing、无锁文件全量 unlocked、enforce 开关双向语义（告警不拦截 / 拒绝加载） |
| `npm run verify:architecture` | 架构治理（P1-1）：DSH 解耦白名单外零 `@deepseek-ai` import（58 文件）、shared 仅类型（无 node 内置/无运行时导出）、web 跨包只准 shared（禁碰服务端内部）、desktop Rust 不反向引用源码目录、分层顺序（db→services→api 静态引用不准向上，登记例外除外）、YAML 与脚本白名单/例外双边防漂移 |
| `npm run verify:agent-tools` | agent 接口层（B1+B2，`agent-tools/`）：① 规格↔路由漂移——44 条命令规格的 method+path 全部命中真实路由（API 演进后规格腐烂被当场抓住），角色标注合法；② CLI 端到端（进程内真实 HTTP 服务 + spawn 构建产物）：envelope 可解析、退出码 0/2/3/4/5 分类正确、认证开启无 token→4、admin key→0、viewer 写操作→3（注意：/health 按设计免鉴权，401 用例须用非 authOpen 端点）；③ MCP 端到端（stdio JSON-RPC）：initialize serverInfo、tools/list 数量=规格数、tools/call 成功 content、未知工具/缺参 isError、通知消息不回应 |
| `npm run verify:rule-injection` | 规则注入（B3，`rules/` 11 条）：索引一致（gen-rules-index --check）、rulesRoot 解析、路径命中（db/ → 事务隔离+分层+DSH 解耦）、主题命中（touches=[transaction]）、预算截断（小预算退摘要行且 load_bearing 优先、总量不超）、无命中为空、服务端 GET /rules/inject + agent-tools CLI rules.inject 端到端 |
| `npm run verify:ws` | WS 实时通道（B4，`/api/autotest/ws`）：握手 101；ping→pong / 未知 action→error / 非法频道→error；subscribe task:<id>→subscribed→appendTrace→task_event 帧（字段完整）；global 频道双频道去重（同一事件只投一次）；退订确认；auth 开启+关豁免无 token→401 拒绝、admin token→可用；未 mask 帧→1002 关闭；连接计数与关闭握手 |
| `npm run verify:explorer` | 遍历候选判定（用 `clickable` 而非"有文本"）、去重键、控件分类、预算、覆盖率报告、无文本控件不丢 |
| `npm run verify:repo-paths` | 仓库地址拆分、子目录穿越防护、同仓共享克隆、legacy 克隆接管、子目录版本号 |
| `npm run verify:sheet` | xlsx 解析/表头识别/diff、同步幂等、**不覆盖 Agent 字段**、绝不删库 |
| `npm run verify:library-catalog` | **R0 目录引导**：随包种子定位与 sha256、首次导入真实规模、幂等（第二次 added=0 且不新增留痕）、只增不删、**不覆盖 Agent 字段**（package_name/main_ability/last_commit/version）、表读不出不阻断启动、catalogStatus 形状 |
| `npm run verify:envkit` | **R1 环境纵轴**：契约七项校验（缺一即拦）、参数解析（默认值/必填/未知参数/枚举/类型）、argv 组装（★ PowerShell 用 `-name` 而 bash 用 `--kebab-name`）、失败分类四级优先级与 11 类码表、退出码归一（null→2/超时→3/取消→4）、契约指纹稳定性与漂移、内置脚本入口存在、注册表播种幂等与 DB 覆盖、画像编排（★ 缓存复用含 failed、参数不合法拦在 spawn 前、指纹随 commit 变化） |
| `npm run verify:survey` | **R2 全量采集**：库类别判定（6 类有序规则 + 强/弱信号 + 可解释理由）、事实构建（二进制 ABI 长模式优先/子模块/构建目标/入口）、README 情报五类抽取、资源候选发现、动画 JSON schema（区分畸形与合法边界）、六种合成变体、预设五件套且步骤无悬空脚本引用、资源登记幂等/版本/复用/未知类型拒绝、批次语义（★ 单库失败隔离、断点续跑跳过成功而重试失败、强制重扫仍隔离、统计 join、可取消） |
| `npm run verify:l2` | **R3 知识库扩展 + L2 增量**：5 种新 kind 与 2 种新 scope 可 round-trip 且落盘目录正确、3 个新检索维度（libraryKind/toolchain/resourceKind）跨库召回、★ 不相关类别不召回、人工队列 3 类新阻塞的问题具体到动作；L2 用**桩 LLM**覆盖四条路径（正常解决/转去问人/坏 scriptId 被拦/空 projectDir 归一化）、画像只含真实脚本、★ taskId 透传到每次 LLM 调用的 meta（预算闸门因此生效）、幂等不重复花 token |
| `npm run verify:env-e2e` | **R4 端到端**：占位符替换（嵌套/数组递归、空变量值不替换）、标量输出解析（KEY=value→小驼峰，★ 不误吞日志里的 error=）、14 个脚本两侧齐备且契约合法、submodule_sync 无 .gitmodules 时成功跳过、★ 端到端真跑画像步骤（失败被归成具体类别而非 unknown、错误信息里不出现 {{repoDir}}、每步都有明细、二次执行命中缓存）、★ 未解析占位符拦在 spawn 之前并报出变量名 |
| `npm run verify:api-extract` | 导出链解析、定义提取（TS 与打包 JS 两种形态）、JSDoc 与参数表、三类假覆盖防护 |
| `npm run verify:coverage` | 矩阵状态判定规则表、风险标记、设备控件匹配、导出格式 |
| `npm run verify:demo-scenarios` | Demo 场景抽取、demo 资产与真假覆盖分离、场景级覆盖度渲染 |
| `npm run verify:case-plan` | 四类场景适用性、数量模型、优先级、★ 每接口 ≥1 正向、★ 报告↔计划一致、★ 抽样条数守恒 |
| `npm run verify:testability` | A/B/C/D 判定、补丁生成与应用/回退、越界路径拒绝、原仓库不被改动 |
| `npm run verify:oracle` | oracle 校验、含糊期望值拦截、★ 断言为空/恒真判为假通过、验证步骤跳过判弱通过 |
| `npm run verify:automation` | 分流规则（auto/human 与 12 类阻塞）、时长阈值、每阶段单独提问、归属明确 |
| `npm run verify:binding` | 未映射步骤即失败、空断言脚本拒绝写入、用例升版→stale、人工改过→manual 且不覆盖 |
| `npm run verify:task-lane` | 同库串行/跨库并行、抢占锁（重试与并发创建不跑两份）、排队中取消、★ 运行中取消与卸载 abort 贯穿 LLM 与子进程、终态不被迟到结果覆盖 |
| `npm run verify:task-events` | seq 每任务独立递增、★ 20 条并发追加不丢不重、快照与事件流逐条一致、afterSeq 增量读、★ `LIMIT -1` 陷阱夹紧、快照可重建、终态后追加可见 |
| `npm run verify:llm-fallback` | ★ 重试跨模型轮转（首选打头/候选去重/不足 3 个绕回）、取消不换模型重试、★ 成功与失败埋点都记 token、★ 单任务 token 预算阻断、限流进程内回退、★ Redis INCR 全局计数（两个子进程共享同一个键，第二个节点被第一个挡住） |
| `npm run verify:knowledge` | LLM wiki front-matter/检索/注入预算、生命周期、agent 阶段契约、MCP 工具 |
| `npm run verify:case-link` | **P11**：初版用例↔接口关联的依据与优先级、面包屑↔路由名对齐、★ 初版用例进入矩阵「用例」列、人工确认不被覆盖、关联幂等、未关联用例统计 |
| `npm run verify:hypium-layout` | Hypium 工程布局与命名契约（目录结构/入口模块/模块名与用例编号对齐） |
| `npm run verify:oracle-runtime` | 把判据支持模块与一条覆盖全部句式的用例脚本**真编译、真 import**，再用假 driver 真跑 24 项断言（★ 反静默通过）；同时校验解释器探测不会选中没有 hypium 的 python。**需要装了 hypium 的 Python，缺失自动跳过** |
| `node scripts/verify-step-contract.mjs` | 步骤句式 → Hypium 调用映射、生成脚本的 driver API 白名单（防"调用不存在的 API"）、控件引用 guardrail、执行端 dry-run 真机判定（无设备自动跳过） |

改动生成端句式或执行端映射后，务必跑 `verify:contract`：两端脱节会让脚本退化成注释，或让 dry-run 产生系统性假失败。

### 浏览器 UI 遍历测试（`scripts/browser-test/`，按需手动跑）

上面 31 套是**离线自检**（不起浏览器）；UI 层用另一套零依赖 CDP 工具（Node 24 原生 WebSocket 驱动真实 Chrome，`--launch` 模式）做**真实浏览器全量遍历**：

```bash
node scripts/browser-test/ui-walk.mjs --base http://127.0.0.1:3280 --out .test-results/web --launch 9222
```

对全部 17 个 hash 路由页面逐页校验：面包屑切换、渲染非空白、无 ErrorBoundary 回退、顶栏后端徽标（API 连通）、console.error / 未捕获异常 / 网络 4xx-5xx 收集（按页归属）、整页截图，并抽测设置弹窗交互；桌面端可用 `--connect` 直连 Tauri 窗口自己的 WebView2 调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`）跑同一套。报告与截图归档在 `.test-results/`（提交时只收 `REPORT.md` 与 `report.json`，截图不入库）。

这套工具抓到过 curl 测不出的真实缺陷：gzip 分支 MIME 错误（浏览器把首页当文件下载，白屏）与 `/libraries/sheet` 被 `/libraries/:id` 路由遮蔽（404）——**凡改动静态服务或路由匹配，建议跑一遍**。

## 环境

Node ≥ 20 · 开发期 SQLite（`dsh-autotest/data/autotest.sqlite3`，自动建表 + 种子）；生产 MySQL 8 + Redis（切换点：`db.mysqlUrl` 配置项 + `repository.ts` 分表路由层，分表本身尚未启用）。真实执行依赖系统 git CLI 与在线真机（hdc + Python/xdevice）；两者缺失时计划直接失败并写明原因，**不会回退模拟**。
