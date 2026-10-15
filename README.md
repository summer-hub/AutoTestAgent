# AutoTest Agent — DeepSeek Harness 自动化测试插件

面向鸿蒙三方库的自动化测试平台，以 **DeepSeek Harness（DSH）插件** 形式交付：安装后 DSH Web 侧边栏出现「AutoTest 平台」入口，用例库、AI 任务、执行计划、设备管理开箱即用。

## 功能特性

- **用例库**：种子只注册少量真实示例库（`repo_url` 指向真实仓库），其余三方库由「拉取仓库代码」按需创建；用例由 AI 生成 / Excel 导入 / 问题单跟踪产生（不灌虚假数据），支持增删改查、版本历史与回滚、Excel 导入导出
- **AI 任务**：复用 DSH 模型配置，对话式任务 + 预置卡片，LLM 输出 JSON 容错 + 多模型重试
- **执行计划**：立即 / 定时（cron）/ 单独 / 批量 / 全量五种模式；真机执行走 Hypium（xdevice）脚本，**无在线真机时计划直接置为失败并写明原因，不会回退模拟**；支持失败策略（重试 / 整库中止）
- **设备管理**：hdc 真机识别（型号/系统版本）、历史设备维护；「打开应用」支持 `device.appAbilities` 映射
- **仓库同步**：`pull_repo` / `update_repo` 真实 git 拉取更新 + 变更文件解析，支持弹窗输入仓库地址直接拉取，内置「仓库目录 / 脚本目录」浏览服务器本地代码；`to_script` 脚本落盘
- **真实用例生成**：`write_cases` 基于已下载仓库的 bundleName / mainAbility / 页面代码设计真实 UI 用例（步骤可触发、预期写明动画与日志）；用例支持增删改、来源分类（AI 生成 / 老库存量 / 问题单跟踪）、DTS 问题单链接跳转
- **数据分析 / 归因**：从 GitCode 拉取真实 PR，AI 分析用例更新点、影响范围与风险；失败执行支持自由勾选（可跨库）归因；可指定 #PR 单独分析、实时进度动画、结果小卡片放大查看
- **前端插件化**：DSH client 插件侧边栏入口 + 主区 iframe 嵌入，复用 DSH 深色风格
- **并发与缓存**：LRU/Redis 缓存（写路径按前缀失效）、MySQL 连接池；`repository.ts` 预留了 `library_id % 16` 分表路由层，**当前仍是单表**（`caseTableFor()` 恒返回 `cases`），README 中的 QPS 数字来自开发期单机 SQLite 压测
- **agent 接口层双件套**（CLI + MCP Server）：`agent-tools/` 把平台能力包装成 AI Agent Bot 即插即用的接口——CLI（octo-cli 模式：stdout JSON envelope + stderr 确定性错误分类 + 退出码 0/2/3/4/5 + 零交互）与 MCP stdio server（initialize / tools/list / tools/call）；**44 条命令规格是单一事实源**（CLI help 树 / MCP inputSchema / 路由漂移检测三端消费），危险操作本地 `--confirm` + 服务端审批流双闸门，令牌走平台 RBAC
- **规则注入（B3）**：`rules/` 11 条开发纪律（octospec 风格 frontmatter：`inject_when.paths/touches` + `load_bearing` + `priority`）——按代码触碰路径/主题向编码 agent 注入（CLI / MCP `rules.inject` / 本地 `scripts/inject-rules.mjs`，支持 `--from-git`），预算内全文、超预算退摘要行；索引 CI 防漂移
- **WebSocket 实时通道（B4）**：`/api/autotest/ws`（token 走 query、复用 enforceAuth 鉴权含回环豁免）；task_events 追加即广播，`task:<id>`/`global` 双频道按 (taskId,seq) 去重；零依赖 RFC6455 帧编解码；Web 端 Tasks/Debug「WS 优先 + 轮询兜底」自动切换
- **可回归自检**：`npm run verify:all` 覆盖 37 套离线自检（事务隔离 / 归档列 / 密钥脱敏 / 运行态清理 / 数据目录迁出 / API 门禁 / 凭据加密 / 认证 RBAC / 指标与日志 / 遍历候选规则 / 仓库路径 / xlsx 同步 / 目录引导 / 接口面提取 / 覆盖矩阵 / demo 场景 / 用例计划 / 可测性与补丁 / oracle 与反假通过 / 分流规则 / 脚本绑定 / 任务 lane 与取消 / 危险操作审批 / 轨迹事件流 / LLM 重试换模型与 token 预算与限流 / 知识库 / 技能供应链锁 / 用例↔接口关联 / Hypium 工程布局与命名契约 / 判据运行期真跑 / 步骤句式契约 / 架构治理 / agent 接口层 / 规则注入 / WS 通道 / envkit 契约与失败分类 / 全量采集流水线 / L2 增量采集 / 环境端到端），CI 逐个接入（详见[autotest/README.md](autotest/README.md)）
- **环境与资源纵轴（R0–R4，2026-10 重构）**：把平台核心对象从「用例」扩展为「**一次可复现的测试运行**= 代码 × 环境画像 × 资源集 × 用例 × 设备」。此前约 90% 工程量在链尾（用例→矩阵→脚本→执行→归因），而链头（克隆→依赖→构建→装包→资源→环境）近乎为 0；本纵轴补齐它，**不推倒重来**（三入口 / md 唯一事实源 / RBAC / 审批 / WS / agent 接口层全部保留复用）。设计取舍与全量规模化策略见 [docs/重构方案-环境与资源纵轴.md](docs/重构方案-环境与资源纵轴.md)
- **问题归因闭环（R5）**：对**任意**用例有疑问都能发起一次完整调查——在「测试用例」页填「问题现象」→ AI 克隆工程、组装上下文（用例/oracle/页面源码/真机遍历 dump/接口签名/执行日志/README）定位根因并给出**可回查的证据** → 有真机则自测试复现（**无真机一律失败并写明原因，绝不回退模拟**）→ 人工验收（通过则沉淀为知识条目，下次同类问题可召回；驳回也留理由供反查）。与既有归因分析分工明确：那个分析**执行失败**（输入是失败轨迹），本功能分析**人的疑问**（输入是用例 + 人写的现象）。新增 `cases.symptom` 列与 `issue_tickets` 工单表、`services/issueRoot.ts`、executor `analyze_issue` 任务、`/issues*` 6 条路由（RBAC：读 viewer / 写 operator）、web「问题归因」页、agent-tools `issues.*` 6 条规格

## 安装

要求：Node ≥ 20，DSH 环境（`dsh` CLI）。

```bash
# 1. 用 dsh plugin 安装（等价于在 profile 目录执行 pnpm add）
dsh plugin --profile web add github:summer-hub/AutoTestAgent#path:/autotest/dsh-autotest
```

```jsonc
// 2. 注册 bundle：编辑 ~/.dsh/profiles/web/package.json
//    dsh.profile.bundles 数组加入 "dsh-autotest"
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "dsh-autotest"]
  }
}
```

```yaml
# 3. 放行原生依赖构建（pnpm 10 默认拦截 postinstall，better-sqlite3 必须放行）
#    编辑 ~/.dsh/profiles/web/pnpm-workspace.yaml，追加：
onlyBuiltDependencies:
  - better-sqlite3
```

```bash
# 4. 安装依赖并重启 DSH
dsh plugin --profile web install
# 重启 DSH Web 后，侧边栏出现「AutoTest 平台」入口
```

> 如果第 3 步不想手改配置，也可以执行 `cd ~/.dsh/profiles/web && pnpm approve-builds`，交互式勾选 `better-sqlite3`。
>
> 国内网络访问 GitHub 需要代理时，先给 git 配代理：`git config --global http.proxy http://127.0.0.1:7890`（按你的实际代理端口调整）。

### 新机器安装检查清单（装完看不到插件时逐条排查）

只往 `package.json` 里写依赖声明**不会**安装插件，以下步骤缺一不可（以 tar 包 URL 为例，git 方式同理）：

```powershell
# 1. 声明依赖：编辑 ~/.dsh/profiles/web/package.json 的 dependencies 加：
#    "dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v1.0.0-rc.1/dsh-autotest-1.0.0-rc.1.tgz"
#    然后必须执行安装（光写不装等于没写）：
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install

# 2. 注册 bundle：同一个 package.json 里 dsh.profile.bundles 数组加 "dsh-autotest"
#    （不加这行，DSH 根本不会加载插件）

# 3. 放行原生模块：pnpm-workspace.yaml 里加 onlyBuiltDependencies: [better-sqlite3]
#    然后重新 pnpm install（不然 better-sqlite3 没编译，插件启动即崩）

# 4. 完全重启 DSH（杀进程重来，不是刷新浏览器），再 dsh --profile web

# 5. 验证（最硬的判断标准）：health 接口返回 {"ok":true,...} 即插件已加载
Invoke-RestMethod http://localhost:3080/api/autotest/health
# 端口以你的 web profile 实际端口为准
```

常见坑：

- `node_modules/dsh-autotest` 不存在 → 没执行安装，或 URL 下载失败（国内直连 GitHub 超时需代理，或改用本地 tgz 文件）。
- 安装了但 `health` 不通 → 多半是 bundle 没注册，或 better-sqlite3 没编译（`pnpm install` 时留意 `Ignored build scripts` 警告）。
- `health` 通了但侧边栏看不到 → GUI 缓存问题：强制刷新 / 清浏览器缓存，让 DSH Web 重新加载 client 插件。
- 之前装过旧 tarball → pnpm 会缓存旧包，需 `pnpm update dsh-autotest` 或删掉 `node_modules/dsh-autotest` 重装（旧包缺 `cordis.patch.yml`，装了也起不来）。
- **接口报 404 但页面能打开** → 前端产物与后端进程版本不一致（只替换了 `lib/web`、没重启宿主）。重启 DSH 即可；新前端已兼容新旧两种列表返回，不会白屏。

也可以把 tgz 下载到本地后用 `"dsh-autotest": "file:./dsh-autotest-1.0.0-rc.1.tgz"` 或 `pnpm add ./dsh-autotest-1.0.0-rc.1.tgz`，离线环境更稳；第 2~5 步不变。

安装成功后：

- 健康检查：`GET /api/autotest/health`
- 业务 API：`/api/autotest/*`（用例 / 任务 / 计划 / 设备 / Prompt / 分析）
- 嵌入前端：`/autotest-web/*`
- AI 任务直接使用 DSH「设置 → 模型」里配置的模型

### 迁移环境 / 数据分析轮次说明

- **迁移到新机器**：插件数据（`autotest.sqlite3`，默认在 `<DSH profile>/autotest-data/`，见下）携带了三方库、用例、分析记录；启动时会自动对账——本地没有对应仓库克隆目录（`<workspace>/repos/<lib>`）的库，会清空 `last_commit` / `last_synced_at`，界面显示「未同步」，不会残留旧机器的拉取记录。仓库克隆目录不随 DB 迁移，首次「拉取仓库代码」会自动 clone。
- **多次扫描**：每次「拉取并分析 PR / 用例更新分析」都会生成一个新的扫描轮次（`round`，如 `R-<时间戳>-<随机数>`），旧轮次记录保留、按轮次分组展示，可「删除本轮」或「清空该库」。
- **换仓库互不影响**：所有分析记录按三方库（`library_id`）隔离，切换/更换仓库只影响该库自己的记录。

### 数据库上服务器（MySQL）

业务数据放服务器 MySQL（`libraries/cases/tasks/...` 业务表）；Redis 作缓存。无需账号登录，打开即用。

```powershell
# 系统配置里填好（或直接改 autotest-data/autotest.sqlite3 的 settings 表，数据目录见上一节）：
#    db.mysqlUrl   = mysql://用户:密码@127.0.0.1:3306/autotest   （库需已创建，启动自动建表）
#    data.redisUrl = redis://127.0.0.1:6379
#    data.redisCache = true
```

### 业务库迁移到 MySQL（阶段 1）

SQLite → MySQL 一次性迁移（保留原 id，行数校验，可重复执行）：

```powershell
# 前置：MySQL 已建库 autotest；settings 表里 db.mysqlUrl 已配置（或环境变量 AUTOTEST_MYSQL_URL）
cd $env:USERPROFILE\.dsh\profiles\node_modules\dsh-autotest
npx tsx scripts/migrate-sqlite-to-mysql.ts
# 源库默认取数据目录里的 autotest.sqlite3（可用 AUTOTEST_SQLITE_DB 覆盖）；
# 脚本会先做源库体检：库文件不存在或不是有效业务库时直接报错退出，不会"迁移 0 行却显示成功"
# 成功后日志逐表打印行数校验结果，并在数据目录写入 .mysql-url 连接引导文件
# 重启 DSH 即从 MySQL 读写（旧 SQLite 文件保留为备份）
```

迁移覆盖 13 张表（三方库/用例/版本/任务/计划/执行/执行归档/设备/Prompt/模型/分析/链路事件/配置），多机共享时只需共享 MySQL 数据。

### 数据目录在哪（重要）

SQLite 本地库、`.mysql-url` 连接引导、`三方库测试表.xlsx` 都落在**数据目录**里，优先级：

1. `AUTOTEST_DATA_DIR` 环境变量（自检 / CI / 想自己指定位置时用）；
2. 默认 `<DSH profile>/autotest-data/`（如 `~/.dsh/profiles/web/autotest-data/`）——**插件包外**，`pnpm install` / 升级 / 重装都不会动它。

> 早期版本把数据放在插件包内的 `node_modules/dsh-autotest/data/`，`pnpm install` 或升级会连库一起删掉。
> 现在首次启动会**自动把旧目录整体搬过来**（库里数据、xlsx、`.mysql-url` 都搬），旧目录改名成
> `data.migrated-<时间戳>` 留底，不会删。搬不动（库被别的进程占着、目标不可写）时会继续用旧目录并在日志里说明，不会拿空库启动。

想确认当前落点：启动日志会打印 `业务库就绪（SQLite 本地模式 · <路径>/autotest.sqlite3）`。

### 目录引导：349 行三方库测试表自动进库

插件**随包分发**一份 `三方库测试表.xlsx`（构建后位于 `lib/assets/`），首次启动会自动导入业务库：

- 数据目录里没有这份表时，先把随包种子**复制**一份过去（此后以数据目录里的为准）；
- 导入是**幂等**的：同一份表（按 sha256 判定）重复启动不会重复写库，也不会刷导入记录；
- 只写「库名 / 仓库地址 / 子目录」三列，**绝不覆盖**各库的包名 / 入口 Ability / 同步状态等 Agent 维护的事实；
- 库里有、表里没有的库只报告、**不删除**（删库会级联删用例与执行历史）；
- 表读不出来（文件缺失 / 解析不出任何库）只在启动日志里告警，**不会阻断插件启动**。

> 定位：xlsx 是「随包初始种子 + 人工增量入口」，**SQLite / MySQL 业务库才是唯一事实源**。
> 首次导入之后平台一律以业务库为准，这份表不再被回写。

导入结果可自证（三个端都是同一个接口）：

```powershell
Invoke-RestMethod http://localhost:3080/api/autotest/libraries/catalog
# → bundled（随包种子是否就位）/ active（数据目录里在用的那份）/ latest（最近一次导入留痕）
#   / problems（被跳过的行，带 xlsx 行号，可直接回表修正）/ db（库总数与环境画像覆盖数）
```

「库管理」页顶部也有对应的状态条（内置目录 / 已导入 / 问题行 / 环境画像覆盖）。
每次导入都会在 `library_catalog_imports` 表留一条痕（来源、文件 sha256、新增/更新/无变化/问题行数），
按 `npm run verify:library-catalog` 可离线复验上述全部边界。

## 环境与资源纵轴（R1–R4）

补齐「从克隆代码到装上包」这条链头。核心主张：**AI 的单位成本从"每库"降到"每类 + 每异常"**——
348 个库逐个问 LLM 成本不可控（约 350 万 tokens 输入），而同一类库的依赖形态、构建方式、
资源构造高度同构，逐库问是把同样的钱花 348 遍。

### 四级分层（L0 → L3）

| 层 | 做什么 | 成本 | 产物 |
|---|---|---|---|
| **L0** 静态画像 | 扫 README / `oh-package.json5` / `build-profile.json5` / 工程结构 / `.gitmodules` / 二进制产物 / 样本资源 | 零 LLM，确定性 | `library_facts`（类别、构建目标、ABI、依赖、资源候选、README 情报） |
| **L1** 预设匹配 | 按库类别套 `assets/presets/<类别>/preset.json` | 零 LLM | `env_profiles`（status=draft, source=preset） |
| **L2** LLM 增量 | **只跑 L0/L1 搞不定的差异库**（类别未识别 / README 有外部前置 / 二进制依赖要决策 / 无预设） | 花 token，受 `agent.maxTokensPerTask` 预算闸门保护 | `env_profiles`（source=ai_draft）+ 不确定项入人工队列 |
| **L3** 人工确认 | 按「库类别 × 阻塞原因」聚合，一次解决一类 | 人 | 确认后的画像 + 知识条目 |

> L0/L1 能覆盖大多数库；LLM 只做增量。全量推进按**类别分批**（先 animation 样板，再按库数量从大到小），
> 每批验收三项指标：画像完整率、预设命中率（目标 ≥ 70%）、L2 触发率（应随批次下降）。

### 脚本资产库（14 个，契约化）

平台只认**契约**不认脚本实现——契约七项（输入 / 输出 / 适用条件 / 失败分类 / 幂等 / 超时 / 审批等级）
是单一事实源，实现可按需替换。本体在 `assets/env/<entry>.{ps1,sh}`（**成对**，跨平台行为逐条对齐），
构建时由 `scripts/build-assets.mjs` 复制进 `lib/assets/env/` 并统一补 UTF-8 BOM
（PowerShell 5.1 对无 BOM 的 UTF-8 按 GBK 解析中文注释，会报指不到真因的 ParserError）。

| 脚本 | 用途 | 关键纪律 |
|---|---|---|
| `ohpm_install` | 装 ohpm 依赖 | 产物 `oh_modules` 必须真存在 |
| `build_manifest` | 读工程清单，产出 bundleName 等 | 读不到就明说，不返回猜的清单 |
| `build_har` / `build_hap` | 构建 HAR / HAP | 退出码 0 但没产物 = `artifact_not_found`，判失败 |
| `hdc_install` | 装机 | 成功判据是输出含 `Successfully install`（hdc 部分版本失败也返回 0） |
| `submodule_sync` | 同步 git 子模块 | 无 `.gitmodules` 是**正常情况**，成功跳过而非失败 |
| `binary_dep_fetch` | 取二进制依赖 | 缓存 → 下载 → 现编三源统一；ABI 白名单防目录穿越 |
| `smoke_check` | 冒烟（已装→能拉起→不崩） | 四级校验，成功判据显式 `SMOKE_OK` |
| `gen_ca` | 自签 CA + 服务端证书 | SAN 必填（现代客户端不认 CN）；幂等复用未临期证书 |
| `mock_server_up` / `mock_server_stop` | 本地 mock HTTP server | 后台常驻 + pid 文件；空 fixture 目录是失败 |
| `xts_scaffold` / `xts_run` / `xts_report` | XTS 三条 | **只做 scaffold + run + 解析，刻意不生成用例** |

失败分类共 11 类（`network` / `permission` / `toolchain_missing` / `sdk_version_conflict` /
`compile_error` / `missing_dep` / `device_offline` / `artifact_not_found` / `timeout` /
`cancelled` / `unknown`），优先级：取消 > 超时 > 退出码 > 信号文本。
归类结果不在契约声明内时 `inTaxonomy=false`——这是在提醒该扩码表，不是 bug。

### 环境画像与端到端

一次环境准备 = 建 run → 逐 step 执行 → 汇总终态。三条关键机制：

- **占位符替换**：`{{repoDir}}` 在运行期才替换（各库 clone 到哪只有那时知道）；
  `{{hapPath}}` 等由上游步骤的**标量输出**串联（`build_hap` 打 `HAP_PATH` →
  `hdc_install` 的 `hapPath` 引用它）。绝对路径不固化进画像——否则方案只对一台机器一次构建有效。
- **产物必须真存在**：runner 按契约 `type=path` 判定 + 从入参与标量输出两侧取路径后 `stat`。
- **缓存复用含失败**：环境失败在工具链不变时每次都会同样失败，不复用等于反复白等
  （R1 验收指标「二次执行耗时 < 20%」正靠这个）。

### 测试资源：三类来源，全部登记

回答"lottie 的 json 资源该怎么找、怎么测"——**绝不现场编**，否则结果不可复现、无法回归：

| 来源 | 做法 |
|---|---|
| 仓库检出 | clone 后扫 `demo/example` 等目录，按 schema 特征识别，带理由登记 |
| 上游 canonical | lottie-web / lottie-android 官方样本与 AE 导出样例，固化 URL + 版本 |
| 程序合成 | `synthesizeAnimation()` 六种变体对应六类测试意图 |

animation_json 六变体：`minimal`（基本解析链路）/ `empty-layers`（空值场景）/
`huge-layers`（大数据，200 图层）/ `nested-precomp`（递归解析）/ `malformed`（畸形 JSON）/
`bad-encoding`（编码错误）。**schema 校验区分"畸形"与"合法边界"**——畸形资源天生不合法是它的用途
（必须走 error 回调），而空 layers 是合法输入，两者不能混为一谈。资源全部带 sha256 + 版本史 +
复用计数 + 临期检出。

### 前端两个新页面

- **环境准备**（`🧰`）：脚本资产契约可见 / 环境画像 / 运行记录与逐步失败分类
- **全量分析**（`🔬`）：画像完整率 / 预设命中率 / L2 触发率 / 批次明细 / 资源清单 / L2 待处理队列

### 相关命令

```bash
npm run verify:envkit      # 契约校验 / 失败分类 / 退出码归一 / 画像编排（含缓存复用）
npm run verify:survey      # 类别判定 / 事实构建 / 预设匹配 / 资源合成 / 批次语义
npm run verify:l2          # L2 校验闸门（桩 LLM 覆盖四条路径）
npm run verify:env-e2e     # 端到端：占位符替换 + 输出串联 + 产物校验 + 失败分类
```

### 一键部署（阶段 2：Docker Compose 数据服务）

```bash
# 服务器（Windows/macOS/Linux 通用）：在 docs/deploy 下
cp .env.example .env          # 改 MYSQL_ROOT_PASSWORD
docker compose up -d          # 启动 MySQL 8 + Redis 7（只监听 127.0.0.1）
```

之后宿主机直接 `dsh --profile web` 启动插件，首次连接引导读 `data/.mysql-url`（迁移脚本自动写入）。防火墙只开放 DSH Web 端口（3080），3306/6379 不对外。

### 常见问题：DSH「Failed to load plugins」

症状：启动 DSH 后控制台/浏览器提示 `failed to import loader entry ... (@linxin666/dsh-client-ui-community-plugins): bundle script .../client.js failed to load`。

原因：`@linxin666/dsh-web-ui-all` 0.3.3 把 `dsh-client-ui-community-plugins`（纯数据源包，**没有客户端产物**）注册为客户端插件，浏览器加载其 `client.js` 时 404。上游无修复版本（迁移目标 `dsh-web-all` 依赖相同，同样有问题）。

修复（每次 `pnpm install` 后重跑一次，再完全重启 DSH）：

```powershell
powershell -ExecutionPolicy Bypass -File docs/deploy/fix-dsh-community-plugin.ps1
# 影响：仅禁用「社区插件商店」数据源挂载；AutoTest / 任务看板 / SSH 等插件不受影响
```

脚本会把 `~/.dsh/profiles/web/node_modules/@linxin666/dsh-web-ui-all/cordis.patch.yml` 中 community-plugins 的客户端注册段注释掉（自动备份 `.bak`，幂等可重复执行）。

### 加固能力（阶段 2）

- **LLM 限流**：每分钟调用上限（系统配置 `exec.llmRatePerMin`，默认 10），超限返回 429；配了 Redis（`data.redisUrl` + `data.redisCache`）时用 `INCR` 做**跨节点共享**的固定窗口计数，未配则退回进程内滑动窗口。模型连通性测试也计入。
- **token 成本闸门**：每次模型调用按任务记账到 `agent_events`（成功/失败都带 tokens），单任务累计超过 `agent.maxTokensPerTask`（默认 300000，0=不限制）即中止该任务后续模型调用；重试改为**跨模型切换**（首选 → 其余候选 → 不足 3 个绕回首选）。
- **keyset 深分页**：三方库 / 任务 / 执行 / 分析列表支持 `cursor` 参数（上一页最后 id），响应为 `{ items, nextCursor }`。
- **执行记录归档**：每日凌晨自动把 6 个月前的执行记录移入 `executions_archive`，主表保持小。
- **统计预聚合**：每分钟预热首页统计 / 分片缓存，覆盖率卡片不实时 COUNT。
- **运行态自愈**：启动时清理上次进程遗留的 running 任务 / 计划；此后每 5 分钟清理长时间不再推进的僵死状态（前端不会永久转圈）。
- **请求安全闸门**：校验 `Content-Type`（阻断跨站表单式简单请求）、限制请求体 2MB、校验 `Origin` / `Sec-Fetch-Site` 同源；模型端点限定 http(s) 并拒绝元数据地址。确有跨源需要时可用 `AUTOTEST_ALLOW_CROSS_ORIGIN=1` 关闭同源闸门。
- **密钥出参脱敏**：`GET /settings` 的 MySQL / Redis 连接串只回传打码值；`GET /models` 的 API Key 只回传掩码 + `hasApiKey` 布尔；掩码原样回传会被识别为"不改动"，不会覆盖真实凭据。

## 企业级能力（P0 全覆盖 + 高性价比 P1）

对标 ZCode 级编程工作台补齐的企业化能力，**默认全部保持既有行为**（开关式启用，DSH 插件形态零感知）：

| 能力 | 默认 | 启用方式 | 说明 |
|---|---|---|---|
| **认证 + RBAC**（P0-1） | 关闭 | 系统配置 → 「API Key 与访问控制」→ 开启认证 | API Key（SHA-256 哈希存储，明文仅创建时展示一次）；角色 admin/operator/viewer（GET=viewer、写=operator、配置/模型/Key 管理=admin）；本机回环默认免 Key（桌面端/本地开发零感知，可收紧）；Web 端无 Key 时展示登录门 |
| **凭据静态加密**（P0-2） | 自动生效 | 无需配置（`AUTOTEST_MASTER_KEY` 可显式指定主密钥） | AES-256-GCM 信封加密：models 的 API Key 与 settings 的 MySQL/Redis 连接串**落库即密文**；主密钥取环境变量或数据目录 `.master-key` 文件（自动生成 + ACL 收敛）；旧明文数据懒迁移不阻塞启动；出参仍走掩码 |
| **可观测出口**（P0-3） | 生效 | `GET /api/autotest/metrices`→`/metrics`；`AUTOTEST_LOG_FORMAT=json` | 零依赖 Prometheus 指标（HTTP 请求数/延迟按路由、LLM 调用/token/失败、任务 lane 深度/事件、uptime），认证开启时限 admin；结构化 JSON 日志（请求行含 method/route/status/durationMs）可直接进 ELK/Loki |
| **危险操作审批**（P0-4） | 自动放行 | 系统配置 → `exec.autoApprove = false` | 拉取/更新仓库、生成/删除脚本、删库/删用例/删任务等危险操作入「人工队列」页审批队列；批准 = 一次性放行令牌（发起方重试同一操作即放行）；operator+ 可决策，viewer 只读 |
| **技能供应链锁**（P1-2） | 告警 | 仓库根 `node scripts/gen-skills-lock.mjs`；`skills.lockEnforce=true` 收紧 | skills/ 逐文件 SHA-256 锁定，启动时校验（桌面端随包分发自带锁）；篡改/未锁定/缺失可检出；技能升级后必须重跑锁文件并提交 |
| **架构治理即代码**（P1-1） | 生效 | `npm run verify:architecture`（CI 门禁） | `architecture-policy.yaml` 固化六条约束：DSH 解耦白名单、shared 仅类型、web/desktop 隔离、分层顺序、YAML 与审计脚本双边防漂移——违规直接 FAIL |

完整对标评估（差距分析、路线图、遗留项）见 [docs/企业级对标评估-ZCode-2026-10-12.md](docs/企业级对标评估-ZCode-2026-10-12.md)；部署细节见 [docs/standalone-desktop.md](docs/standalone-desktop.md)。

## 快速上手

1. 打开 DSH Web，左侧边栏进入「AutoTest 平台」
2. 「用例库」页浏览 / 搜索用例，可导出 Excel；设置页可导入 Excel 批量入库
3. 「任务」页新建对话任务或使用预置卡片（拉取 / 更新仓库为真实 git 操作），AI 自动产出结果与轨迹
4. 「计划」页创建执行计划（立即 / 定时），**连接在线真机**后真实执行，在「调试」页查看轨迹并追问
5. 「分析」页对仓库 PR 做用例更新分析；「归因」页对失败执行做根因分析

## 纯 Web 独立版 & 桌面端（不依赖 DSH）

不想装 DSH 也能用：同一套后端有两个新入口，前端也有独立构建。

**纯 Web 独立版**（一条命令起服务，浏览器直接用）：

```bash
cd autotest
npm run build:standalone   # 构建独立版前端（dist/web）+ 服务端（lib/standalone.js）
npm start                  # 默认监听 0.0.0.0:3280，打开 http://127.0.0.1:3280/
```

- LLM 不依赖 DSH：在页面「设置 → 自定义模型」里维护 models 表（OpenAI 兼容协议）；
- 高并发：`AUTOTEST_WORKERS=auto` 多进程集群（MySQL 模式默认开启）、keep-alive 调优、静态资源 `.gz` 预压缩 + immutable 缓存、`requestTimeout=0`（AI 分析长接口不被掐断）；
- 数据引擎：MySQL（`AUTOTEST_MYSQL_URL`）或 SQLite 本地降级；多机共享 MySQL + Redis，限流/缓存跨节点；
- 开发：`npm run dev:web`（Vite :5173 代理到 3280）+ `npm run start:dev`（tsx 免构建）；
- 压测：`node scripts/bench-standalone.mjs 2000 50 http://127.0.0.1:3280`。

**桌面端**（Windows，双击即用）：

```bash
cd autotest/desktop
npm run build              # 构建前端 + staging 服务器（随包 node）+ NSIS 安装包
# 产物：src-tauri/target/release/bundle/nsis/AutoTest_1.0.0-rc.1_x64-setup.exe
```

Tauri v2 外壳（~33MB，非 Electron）托管内置独立服务器：随包分发 Node 22 sidecar、数据目录隔离在 `%APPDATA%/com.autotest.platform`、托盘驻留、单实例、硬杀自动清理子进程。开发调试：`cd autotest/desktop && npm run dev`。

环境变量、集群、MySQL/Redis、签名与排障等完整说明见 **[docs/standalone-desktop.md](docs/standalone-desktop.md)**。

## 目录结构

```
├── autotest/
│   ├── dsh-autotest/     # 后端核心（双入口）：
│   │                     #   lib/index.js      → DSH 插件（Cordis）
│   │                     #   lib/standalone.js → 独立服务器（node lib/standalone.js）
│   │                     #   dist/web          → 独立版前端产物
│   │                     #   assets/env/       → R1-R4：14 个环境脚本资产（.ps1 + .sh 成对）
│   │                     #   assets/presets/   → R2：按库类别的预设方案五件套
│   │                     #   assets/三方库测试表.xlsx → R0：随包初始种子
│   ├── web/              # 前端 React 18 + Vite（双构建：build:embed / build:standalone）
│   ├── agent-tools/      # agent 接口层：CLI + MCP Server（44 条命令规格单一事实源，双端生成）
│   ├── rules/            # B3：11 条开发纪律（octospec frontmatter + inject_when + _index.yaml）
│   ├── desktop/          # 桌面端（Tauri v2）：Rust 壳托管独立服务器 + WebView
│   └── shared/           # 前后端共享领域类型
├── data/                 # 人维护的三方库测试表（源表；随包种子在 dsh-autotest/assets/）
├── docs/                 # 部署方案（deploy/）、独立版与桌面端手册、架构评审、
│                         # 重构方案-环境与资源纵轴.md（R0-R4 设计与验收）
├── preview/              # 高保真交互原型与预览图
└── .github/workflows/    # 打 tag 自动跑门禁 → 构建 → 发布 Release + tarball
```

## 开发与构建

```bash
cd autotest
npm run typecheck          # web + 插件 类型检查
npm run verify:all         # 构建 + 28 套自检（离线可跑；无设备/无 hypium 的项自动跳过）
npm run build:standalone   # 独立版：前端 + 服务端
npm start                  # 跑独立服务器（3280）
npm run dev:web            # 前端开发服务器（5173，代理 /api 到 3280）
npm run start:dev          # 服务端免构建开发模式（tsx）
```

**浏览器 UI 全量测试**（`scripts/browser-test/`，零依赖 CDP 客户端驱动真实 Chrome）：

```bash
node scripts/bench-standalone.mjs 2000 50 http://127.0.0.1:3280   # 压测：RPS / P50 / P99

# Web 端：遍历全部 17 个页面（渲染 / console 错误 / 网络失败 / 每页截图）
node scripts/browser-test/ui-walk.mjs --base http://127.0.0.1:3280 --out .test-results/web --launch 9222

# 桌面端：给 Tauri 的 WebView2 开调试端口后，直连桌面端自己的窗口跑同一套遍历
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" ./autotest-desktop.exe &
node scripts/browser-test/ui-walk.mjs --base http://127.0.0.1:<端口> --out .test-results/desktop --connect 9223
```

测试报告与截图归档在 `autotest/.test-results/`（`REPORT.md` + 每页 PNG + 机读 `report.json`）。这套工具曾抓出两个真实浏览器才暴露的缺陷：gzip 分支 MIME 错误导致首页被当文件下载（白屏）、`/libraries/sheet` 被 `/libraries/:id` 路由遮蔽（404）。

**agent 接口层**（`agent-tools/`，给 AI Agent Bot 通过 exec 调用的 CLI + MCP Server，44 条命令单一事实源）：

```bash
# 构建（两个单文件产物，Node ≥20 直接跑，零依赖安装）
cd autotest && npm run build:agent-tools

# CLI：命令树自动生成；成功 → stdout JSON envelope；失败 → stderr + 确定性退出码；零交互
node agent-tools/dist/cli.mjs --help                      # 全量命令树（9 组 33 条）
node agent-tools/dist/cli.mjs --help cases.create         # 单命令参数详情 + 示例
node agent-tools/dist/cli.mjs libraries.list --q lottie --base http://127.0.0.1:3280/api/autotest
node agent-tools/dist/cli.mjs tasks.create --type pull_repo --libraryId 1
node agent-tools/dist/cli.mjs cases.export --libraryId 1 --out cases.xlsx   # 二进制落盘
AUTOTEST_TOKEN=at_xxx node agent-tools/dist/cli.mjs plans.run 1             # 令牌：--token > 环境变量

# MCP Server（stdio，任何 MCP 客户端即插即用）：
#   {"mcpServers":{"autotest":{"command":"node","args":["<repo>/autotest/agent-tools/dist/mcp-server.mjs"],
#     "env":{"AUTOTEST_BASE_URL":"http://127.0.0.1:3280/api/autotest","AUTOTEST_TOKEN":"at_xxx"}}}}
```

退出码（agent 可机械分支）：`0` 成功 · `2` 本地校验失败（命令不存在/参数缺失，请求未发出）· `3` 服务端拒绝（403 权限不足/404/409 审批中/5xx）· `4` 认证失败（401/令牌无效）· `5` 传输失败（网络/超时/非 JSON）。删除类命令需 `--confirm`（审批模式下服务端还会二次拦截，见「企业级能力」节）。规格↔路由漂移由 `verify:agent-tools` 自检兜底（API 演进后规格腐烂会被抓住）。

**规则注入**（B3，`rules/` 11 条开发纪律；编码时按触碰路径/主题注入 agent 上下文，而非事后 FAIL）：

```bash
node scripts/inject-rules.mjs --paths dsh-autotest/src/db/connection.ts   # 按路径命中（glob）
node scripts/inject-rules.mjs --touches transaction,secrets              # 按主题命中
node scripts/inject-rules.mjs --from-git --budget 4000                   # 工作区变更（pre-commit 可用）
node agent-tools/dist/cli.mjs rules.inject --paths dsh-autotest/src/api/http.ts   # agent 经 CLI/MCP 调用（服务端 GET /rules/inject）
node scripts/gen-rules-index.mjs --check                                # CI：索引与 rules/ 防漂移
```

预算内注入规则全文，超预算退化为摘要行（load_bearing 优先）；规则带 `inject_when.paths/touches` frontmatter，增删改后必须重生成索引。

**WebSocket 实时通道**（B4，替代任务事件轮询）：

```
ws://127.0.0.1:3280/api/autotest/ws?token=<key>     # 浏览器 WS 不支持自定义头，token 走 query
→ {"action":"subscribe","channel":"task:123"|"global"}   # task:<id> 收该任务轨迹增量；global 收全部
← {"type":"task_event","taskId":123,"seq":4,"eventType":"trace","title":...,"at":...}
```

鉴权复用 `enforceAuth`（认证开启时校验、回环豁免适用）；双频道同一事件按 (taskId,seq) 去重；Web 端 Tasks/Debug 页「WS 优先 + 轮询兜底」自动切换（连接状态页内有指示）。DSH 插件形态无 upgrade 事件，前端自动回退轮询。

详见 [autotest/README.md](autotest/README.md)：构建命令、数据库设计、里程碑状态、自检覆盖范围；架构问题与整改进展见 [docs/架构评审-2026-09-21.md](docs/架构评审-2026-09-21.md)。

## 发布新版本

1. 改 `autotest/dsh-autotest/package.json` 的 `version`（必须与 tag 一致，CI 会校验）
2. 本地重建并提交产物：`cd autotest && npm run build:plugin`（仓库同时提交了 `lib/`，git 直装路径依赖它；CI 会校验重建结果与提交一致）
3. 打 tag 推送：

```bash
git tag v1.0.0-rc.1 && git push origin v1.0.0-rc.1   # GitHub Actions 自动构建 Release + tarball
```

发布前 CI 会依次跑：类型检查 → 数据层自检 → API 门禁自检 → 步骤契约自检 → `lib/` 产物一致性 → tag 与版本一致性。

也可以直接安装 Release 产物：

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v1.0.0-rc.1/dsh-autotest-1.0.0-rc.1.tgz"
```
