# AutoTest Agent — DeepSeek Harness 自动化测试插件

面向鸿蒙三方库的自动化测试平台，以 **DeepSeek Harness（DSH）插件** 形式交付：安装后 DSH Web 侧边栏出现「AutoTest 平台」入口，用例库、AI 任务、执行计划、设备管理开箱即用。

## 功能特性

- **用例库**：注册 400+ 真实三方库（repo_url 指向真实仓库），用例由 AI 生成 / Excel 导入 / 问题单跟踪产生（不灌虚假数据），支持增删改查、版本历史与回滚、Excel 导入导出
- **AI 任务**：复用 DSH 模型配置，对话式任务 + 预置卡片，LLM 输出 JSON 容错 + 多模型重试
- **执行计划**：立即 / 定时（cron）/ 单独 / 批量 / 全量五种模式，默认 hdc 真机执行（uiautomator/input），无设备自动回退模拟；支持脚本动作执行与失败策略（重试 / 整库中止）
- **设备管理**：hdc 真机识别（型号/系统版本）、历史设备维护；「打开应用」支持 `device.appAbilities` 映射
- **仓库同步**：`pull_repo` / `update_repo` 真实 git 拉取更新 + 变更文件解析，支持弹窗输入仓库地址直接拉取，内置「仓库目录 / 脚本目录」浏览服务器本地代码；`to_script` 脚本落盘
- **真实用例生成**：`write_cases` 基于已下载仓库的 bundleName / mainAbility / 页面代码设计真实 UI 用例（步骤可触发、预期写明动画与日志）；用例支持增删改、来源分类（AI 生成 / 老库存量 / 问题单跟踪）、DTS 问题单链接跳转
- **数据分析 / 归因**：从 GitCode 拉取真实 PR，AI 分析用例更新点、影响范围与风险；失败用例三粒度归因（单用例 / 单库 / 多库）；可指定 #PR 单独分析、实时进度动画、结果小卡片放大查看
- **前端插件化**：DSH client 插件侧边栏入口 + 主区 iframe 嵌入，复用 DSH 深色风格
- **高并发（M7）**：LRU/Redis 缓存、读连接池、分表路由（library_id % 16），压测热路径 3077 QPS

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
#    "dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.33/dsh-autotest-0.1.33.tgz"
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

也可以把 tgz 下载到本地后用 `"dsh-autotest": "file:./dsh-autotest-0.1.33.tgz"` 或 `pnpm add ./dsh-autotest-0.1.33.tgz`，离线环境更稳；第 2~5 步不变。

安装成功后：

- 健康检查：`GET /api/autotest/health`
- 业务 API：`/api/autotest/*`（用例 / 任务 / 计划 / 设备 / Prompt / 分析）
- 嵌入前端：`/autotest-web/*`
- AI 任务直接使用 DSH「设置 → 模型」里配置的模型

### 迁移环境 / 数据分析轮次说明

- **迁移到新机器**：插件数据（`~/.dsh/profiles/web/node_modules/dsh-autotest/data/autotest.db`）携带了三方库、用例、分析记录；启动时会自动对账——本地没有对应仓库克隆目录（`<workspace>/repos/<lib>`）的库，会清空 `last_commit` / `last_synced_at`，界面显示「未同步」，不会残留旧机器的拉取记录。仓库克隆目录不随 DB 迁移，首次「拉取仓库代码」会自动 clone。
- **多次扫描**：每次「拉取并分析 PR / 用例更新分析」都会生成一个新的扫描轮次（`round`，如 `R-<时间戳>-<随机数>`），旧轮次记录保留、按轮次分组展示，可「删除本轮」或「清空该库」。
- **换仓库互不影响**：所有分析记录按三方库（`library_id`）隔离，切换/更换仓库只影响该库自己的记录。

### 多用户（阶段 0：认证 + 权限）

认证与业务数据都已放在服务器 MySQL（`auth_*` 表 + `libraries/cases/tasks/...` 业务表）；Redis 作缓存。

```powershell
# 1. 系统配置里填好（或直接改 ~/.dsh/profiles/web/node_modules/dsh-autotest/data/autotest.db 的 settings 表）：
#    db.mysqlUrl   = mysql://用户:密码@127.0.0.1:3306/autotest   （库需已创建，启动自动建 auth_* 表）
#    data.redisUrl = redis://127.0.0.1:6379
#    data.redisCache = true

# 2. 重启 DSH，启动日志会打印初始管理员账号：
#    [dsh-autotest] 已创建初始管理员：admin / <随机密码>

# 3. 打开 AutoTest 平台会先显示登录页；用 admin 登录后，在「用户管理」页：
#    - 新建用户并指定角色（管理员/组长/测试工程师/只读访客）
#    - 生成邀请码给新同事注册（注册即自动登录，初始角色 viewer）
#    - 给 CI/脚本生成 API Key（Bearer sk_xxx，可吊销）
#    - 查看审计日志（登录/建号/改密/增删改记录）
```

角色权限：`admin`（全量+用户/审计）、`manager`（管理业务+设备，不可管用户）、`engineer`（写用例/跑任务/执行）、`viewer`（只读）。所有业务 API 均需登录；未带 token 返回 401，越权返回 403。

### 业务库迁移到 MySQL（阶段 1）

SQLite → MySQL 一次性迁移（保留原 id，行数校验，可重复执行）：

```powershell
# 前置：MySQL 已建库 autotest；settings 表里 db.mysqlUrl 已配置（或环境变量 AUTOTEST_MYSQL_URL）
cd $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-autotest
npx tsx scripts/migrate-sqlite-to-mysql.ts
# 成功后日志显示 11 张表行数全部 ✓，并写入 data/.mysql-url 连接引导文件
# 重启 DSH 即从 MySQL 读写（旧 SQLite 文件保留为备份）
```

迁移后所有业务表（三方库/用例/版本/任务/计划/执行/设备/Prompt/模型/分析/配置）都在 MySQL，多机共享时只需共享 MySQL 数据。

### 一键部署（阶段 2：Docker Compose 数据服务）

```bash
# 服务器（Windows/macOS/Linux 通用）：在 docs/deploy 下
cp .env.example .env          # 改 MYSQL_ROOT_PASSWORD
docker compose up -d          # 启动 MySQL 8 + Redis 7（只监听 127.0.0.1）
```

之后宿主机直接 `dsh --profile web` 启动插件，首次连接引导读 `data/.mysql-url`（迁移脚本自动写入）。防火墙只开放 DSH Web 端口（3080），3306/6379 不对外。

### 加固能力（阶段 2）

- **LLM 限流**：每用户每分钟调用上限（系统配置 `exec.llmRatePerMin`，默认 10），防刷模型额度，超限返回 429。
- **keyset 深分页**：三方库/任务/执行/分析列表支持 `cursor` 参数（上一页最后 id），返回 `nextCursor`，深翻页不衰减。
- **执行记录归档**：每日凌晨自动把 6 个月前的执行记录移入 `executions_archive` 表，主表保持小。
- **统计预聚合**：每分钟预热首页统计/分片缓存，覆盖率卡片不实时 COUNT。
- **审计筛选**：用户管理页审计日志可按操作类型筛选。

## 快速上手

1. 打开 DSH Web，左侧边栏进入「AutoTest 平台」
2. 「用例库」页浏览/搜索用例，可导出 Excel；设置页可导入 Excel 批量入库
3. 「任务」页新建对话任务或使用预置卡片（拉取/更新仓库为真实 git 操作），AI 自动产出结果与轨迹
4. 「计划」页创建执行计划（立即 / 定时），连接 hdc 真机后真实执行，在「调试」页查看轨迹并追问
5. 「分析」页对仓库 PR 做用例更新分析；「归因」页对失败执行做根因分析

## 目录结构

```
├── autotest/
│   ├── dsh-autotest/     # DSH 服务端插件（Cordis）：API / DB / 调度 / 服务
│   ├── web/              # 前端 React 18 + Vite（独立 + 嵌入双模式）
│   └── shared/           # 前后端共享领域类型
├── preview/              # 高保真交互原型与预览图
└── .github/workflows/    # 打 tag 自动构建并发布 Release + tarball
```

## 开发与构建

详见 [autotest/README.md](autotest/README.md)：本地构建命令、数据库设计、里程碑状态。

## 发布新版本

```bash
git tag v0.2.0 && git push origin v0.2.0   # GitHub Actions 自动构建 Release + tarball
```

也可以直接安装 Release 产物：

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.33/dsh-autotest-0.1.33.tgz"
```
