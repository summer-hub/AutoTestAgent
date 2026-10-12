# 独立版（纯 Web）与桌面端 — 部署与运维手册

本手册覆盖**不依赖 DeepSeek Harness（DSH）**的两条交付链路：

- **纯 Web 独立版**：`node lib/standalone.js` 起服务，浏览器直接访问（任何人、任何机器，只要 Node ≥ 20）；
- **桌面端**：Tauri v2 外壳（Windows），内置随包分发的 Node + 独立服务器，双击即用。

两条链路与 DSH 插件**共用同一套后端源码**（`autotest/dsh-autotest/src`），差异只在宿主：

| | DSH 插件 | 纯 Web 独立版 | 桌面端 |
|---|---|---|---|
| 入口 | `lib/index.js`（Cordis 插件） | `lib/standalone.js` | `lib/standalone.js`（被 Rust 托管） |
| HTTP | 挂 `ctx.webServer` | 自带 `node:http` | 同独立版（127.0.0.1 随机端口） |
| LLM | `ctx.llm`（DSH 模型配置） | `models` 表（OpenAI 兼容） | 同独立版 |
| 前端 | `/autotest-web/*`（iframe 嵌入） | `/`（站点根 SPA） | WebView 指向本地服务器 |
| 数据 | `<DSH profile>/autotest-data` | `AUTOTEST_DATA_DIR` 或安装根 `autotest-data` | 应用数据目录 |

---

## 一、纯 Web 独立版

### 1. 构建

```bash
cd autotest
npm run build:standalone
# 产物：
#   dsh-autotest/dist/web/   独立版前端（含 .gz 预压缩伴生文件）
#   dsh-autotest/lib/        服务端编译产物（含 lib/standalone.js）
```

### 2. 启动

```bash
npm start                    # = cd dsh-autotest && node lib/standalone.js
# 默认监听 0.0.0.0:3280
# 打开 http://127.0.0.1:3280/
```

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTOTEST_HOST` | `0.0.0.0` | 监听地址（仅本机用可设 `127.0.0.1`） |
| `AUTOTEST_PORT` | `3280` | `0` = 随机端口，并向 stdout 打印 `AUTOTEST_LISTENING=<port>`（桌面端依赖此行） |
| `AUTOTEST_DATA_DIR` | 安装根 `autotest-data` | SQLite 库 / `.mysql-url` / xlsx 落点 |
| `AUTOTEST_WORKSPACE` | 启动目录下 `workspace` | 仓库克隆 / 脚本 / 知识库根目录（**建议设固定路径**） |
| `AUTOTEST_MYSQL_URL` | — | MySQL 连接串（配了即用 MySQL，否则 SQLite 本地模式） |
| `AUTOTEST_DB_MODE` | 自动 | `sqlite` / `mysql` 强制引擎 |
| `AUTOTEST_WEB_DIR` | `dist/web` | 前端产物目录（自己托管前端时用） |
| `AUTOTEST_WORKERS` | MySQL→auto、SQLite→1 | 进程数：`1`/`auto`/`N` |
| `AUTOTEST_ALLOW_SQLITE_CLUSTER` | — | `=1` 允许 SQLite 模式多进程（写会串行，默认禁止） |
| `AUTOTEST_ALLOW_CROSS_ORIGIN` | — | `=1` 关闭同源闸门（默认开启，防 CSRF） |

健康检查：`GET /healthz`（不碰 DB，LB 探活用）；业务健康：`GET /api/autotest/health`。

### 3. 前端开发模式

```bash
npm run dev:web              # Vite dev server（:5173），/api 代理并改写前缀到 3280
npm run start:dev            # 免构建直接跑 TS 服务端（tsx）
```

### 4. 配置模型（独立版第一次必做）

独立版没有 DSH 的模型设置，LLM 走**系统配置里的 `models` 表**（OpenAI 兼容协议）：

1. 打开页面 → 左下角「设置 / 自定义模型」（或「系统配置」页）；
2. 添加模型：`name`、`baseUrl`（如 `https://api.deepseek.com/v1`）、`modelId`、`apiKey`；
3. 「系统配置 → 默认模型」可指定 `agent.defaultModel`（按 modelId 匹配）；
4. 连通性测试按钮会真实发一次请求（计入 LLM 限流）。

> 种子库里预置了一个本地示例 `http://localhost:11434/v1`（ollama），本地跑模型的话装上 ollama 即可用。

### 5. 高并发部署

**单机多核（集群）**：

```bash
AUTOTEST_WORKERS=auto npm start        # 或显式 N
```

- 调度器 / 每日归档 / 统计预热 / 设备扫描 / 启动清理**只在 worker 1** 运行（多节点语义与插件一致）；
- worker 异常退出自动重启（1 分钟 10 次熔断，超过则主进程退出交给进程管理器）；
- **SQLite 模式默认单进程**（WAL 下多进程写退化）；MySQL 模式无此限制；
- 多进程未配 Redis 时，LLM 限流与缓存按进程生效（上限 ≈ 配置值 × worker 数）——**生产建议接 Redis**。

**多机水平扩展**：所有节点共享 MySQL（`db.mysqlUrl`）+ Redis（`data.redisUrl` + `data.redisCache=true`），仅一个节点开调度（其余设 `exec.schedulerEnabled=false`）。API 无状态，前面挂 LB 即可。

**进程管理**（任选其一）：

```bash
pm2 start dsh-autotest/lib/standalone.js --name autotest -i max   # pm2 集群模式亦可（此时 AUTOTEST_WORKERS=1）
systemd / docker restart=always                                      # 或容器编排
```

**连接与超时已按高并发调优**：keep-alive 65s、`requestTimeout=0`（AI 分析类接口合法运行数分钟，不能被 Node 默认 300s 掐断）、静态资源构建期 `.gz` 预压缩 + hashed 资产 `immutable` 缓存（运行时零压缩 CPU）。

### 6. 压测

```bash
# 先起服务，然后：
node scripts/bench-standalone.mjs 2000 50 http://127.0.0.1:3280
# 参数：总请求数 并发数 baseUrl；输出 RPS / avg / P50 / P99 / 错误率
```

### 7. 数据迁移（SQLite → MySQL）

复用插件自带的迁移脚本（独立版同样适用）：

```bash
# 1. MySQL 建库 autotest；配置连接串（环境变量或启动后在系统配置里填 db.mysqlUrl）
# 2. 执行迁移（保留原 id，行数校验，可重复执行）
cd dsh-autotest && npx tsx scripts/migrate-sqlite-to-mysql.ts
# 3. 重启服务，即从 MySQL 读写
```

多机共享时只需共享这一份 MySQL 数据（含 `.mysql-url` 引导文件的约定一致）。

### 8. 安全说明

- API **无账号体系**（打开即用，与插件一致），依赖同源闸门防跨站写入：`Origin`/`Sec-Fetch-Site` 与 Host 不一致 → 403；`Content-Type` 必须 `application/json`；请求体上限 2MB；
- 绑定 `0.0.0.0` 时上述闸门是主要防线，**不要**再叠一层匿名可写的反向代理而不做访问控制；内网/本机使用建议 `AUTOTEST_HOST=127.0.0.1`；
- 模型端点限定 http(s)，拒绝链路本地/云元数据地址（防密钥外泄）；
- `GET /settings` 的 MySQL/Redis 连接串、`GET /models` 的 API Key 均脱敏返回。

---

## 二、桌面端（Tauri v2）

### 1. 它是什么

一个 ~10MB 级的 Windows 桌面应用：

- **外壳**：Tauri v2（系统 WebView2，非 Electron——包体与内存占用低一个量级）；
- **内核**：随包分发 Node 22 sidecar + 上面的独立服务器（`lib/standalone.js`）；
- **数据**：隔离在应用数据目录（`%APPDATA%/com.autotest.platform`），不碰开发机；
- **体验**：托盘驻留；点关闭 = 隐藏到托盘（服务器继续跑）；托盘「退出」才停服务器；单实例。

### 2. 开发

```bash
cd autotest/desktop
npm run dev          # tauri dev：编译 debug + 拉起服务器 + 开窗口
```

开发模式服务器目录解析顺序：`AUTOTEST_SERVER_DIR` → exe 相对路径回溯（`target/debug` → 仓库 `dsh-autotest`），零配置直接跑。

### 3. 构建发布包

```bash
cd autotest/desktop
npm run build
# 内部三步：
#   1. build:web        构建独立版前端（dist/web）
#   2. stage:server     把 lib/dist/生产 node_modules 装进 src-tauri/resources/server
#                        —— 用随包的 node 执行 npm install，保证 better-sqlite3 ABI 一致
#   3. tauri build      release 编译 + NSIS 打包
# 产物：src-tauri/target/release/bundle/nsis/AutoTest_1.0.0-rc.1_x64-setup.exe
```

首次构建前置：`node scripts/fetch-node.mjs`（下载 Node 22 sidecar 到 `src-tauri/bin/`，已随流程自动执行过一次；重装环境时需重跑）。

### 4. 分发注意

- **代码签名**：未签名安装包会被 SmartScreen 拦截，建议购买 OV/EV 证书后 `tauri build --config` 配 `bundle.windows.certificateThumbprint`（占位，未配）；
- **自动更新**：未接入（占位）。可后续加 `tauri-plugin-updater` + 静态 JSON manifest；
- **其他平台**：`fetch-node.mjs` 目前只下 Windows x64；macOS/Linux 需按 `TAURI_ENV_TARGET_TRIPLE` 各下一份 node 并重新 staging（脚本结构已支持，改平台参数即可）；
- **卸载**：NSIS 卸载不会删应用数据目录（数据库/仓库/知识库在那里），需要的话手动删 `%APPDATA%/com.autotest.platform`。

### 5. 排障

| 症状 | 排查 |
|---|---|
| 启动即弹「未找到 Node.js 运行时」 | sidecar 丢失/被安全软件杀；重装或设 `AUTOTEST_NODE` 指向 node ≥ 20 |
| 窗口白屏/转圈 | 看 `<数据目录>/server.log`（桌面端会把服务器 stdout/stderr 全量落盘在那里） |
| 端口冲突 | 桌面端用随机端口（`AUTOTEST_PORT=0`），不会冲突；纯 Web 版改 `AUTOTEST_PORT` |
| 数据库损坏 | SQLite WAL 崩溃安全；真损坏就换 MySQL（见 §一.7） |
| 想看服务器在干什么 | 托盘「打开数据目录」→ `server.log`；或直接 `node lib/standalone.js` 同数据目录跑一份看输出 |

---

## 三、与 DSH 插件链路的关系

- 插件安装链路**完全不变**（`dsh plugin add` / tgz / bundle 注册），`lib/index.js` 与 `lib/client.js` 行为不变；
- 三个链路可以**同时存在**：DSH 里跑插件、服务器上跑独立版、本机跑桌面端，各自数据目录互不干扰（除非显式共指）；
- 想从插件迁到独立版：数据库文件可直接共用（`AUTOTEST_DATA_DIR` 指过去），或按 §一.7 迁 MySQL 后多端共享。
