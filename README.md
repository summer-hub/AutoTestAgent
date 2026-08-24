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
#    "dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.24/dsh-autotest-0.1.24.tgz"
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

也可以把 tgz 下载到本地后用 `"dsh-autotest": "file:./dsh-autotest-0.1.24.tgz"` 或 `pnpm add ./dsh-autotest-0.1.24.tgz`，离线环境更稳；第 2~5 步不变。

安装成功后：

- 健康检查：`GET /api/autotest/health`
- 业务 API：`/api/autotest/*`（用例 / 任务 / 计划 / 设备 / Prompt / 分析）
- 嵌入前端：`/autotest-web/*`
- AI 任务直接使用 DSH「设置 → 模型」里配置的模型

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
"dsh-autotest": "https://github.com/summer-hub/AutoTestAgent/releases/download/v0.1.24/dsh-autotest-0.1.24.tgz"
```
