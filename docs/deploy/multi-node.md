# AutoTest 多节点部署（DSH 多实例共享一个 MySQL）

适用场景：多台测试机（或服务器 + 测试机）各自跑一个 DSH + AutoTest 实例，共用同一套 MySQL/Redis 数据，实现**多机数据互通、设备分散在各节点**。

## 1. 架构

```
                    ┌──────────────────────────┐
                    │  共享数据层（一台机器）    │
                    │  MySQL 8（业务+认证）      │
                    │  Redis 7（缓存）          │
                    └────────────┬─────────────┘
        ┌───────────┬────────────┼────────────┬───────────┐
        ▼           ▼            ▼            ▼           ▼
   ┌─────────┐ ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ 节点 A  │ │ 节点 B  │  │ 节点 C  │  │ 节点 D  │  │ 节点 E  │
   │ DSH+插件 │ │ DSH+插件 │  │ DSH+插件 │  │ DSH+插件 │  │ DSH+插件 │
   │ hdc 设备1│ │ hdc 设备2│  │ hdc 设备3│  │ hdc 设备4│  │ (无设备) │
   └─────────┘ └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

要点：
- **数据只有一份**（MySQL），任何节点增删的用例/任务/执行/分析，其他节点立即可见。
- **设备按节点分散**：每台机器 USB 直连自己的 hdc 真机，执行计划时选择对应节点的设备。
- **浏览器访问**：用户通过各节点 DSH Web（或统一 HTTPS 网关，见 gateway.md）操作，看到的是同一份数据。

## 2. 前提条件（代码已具备）

- 插件 v0.1.33+：业务与认证数据全部走 MySQL；缓存走 Redis；连接串从系统配置 `db.mysqlUrl` 或 `data/.mysql-url` 引导文件读取。
- 各节点安装同一版本的插件（tar 包 URL 安装，见 README），共用同一份 `data/.mysql-url` 内容（或统一在系统配置设置 `db.mysqlUrl`）。
- 数据服务只需一个（见 `docker-compose.yml`），所有节点连它。

## 3. 节点配置步骤

### 3.1 数据服务（只在一台机器起）

```bash
cd docs/deploy
cp .env.example .env      # 改 MYSQL_ROOT_PASSWORD
docker compose up -d      # MySQL + Redis，只监听 127.0.0.1
```

如果 MySQL/Redis 在其他机器（非本机），节点上 `db.mysqlUrl` / `data.redisUrl` 要填**可达地址**（如 `mysql://autotest:密码@192.168.1.10:3306/autotest`），并确保防火墙放行对应端口。

### 3.2 每个节点安装并配置插件

```powershell
# 1. 安装（与单机一致，见 README）
dsh plugin --profile web add github:summer-hub/AutoTestAgent#path:/autotest/dsh-autotest
# 2. 放行 better-sqlite3 构建（如需）后 pnpm install + 重启

# 3. 确认 MySQL 连接一致：系统配置 → db.mysqlUrl 填共享库地址
#    或把同一个连接串写入 data/.mysql-url 后重启

# 4. 多节点关键配置：调度器只保留一个节点开启
#    系统配置 → exec.schedulerEnabled
#    主节点（负责定时计划/统计预热/归档）：true（默认）
#    其余节点：false（避免定时计划重复执行、统计预热重复写入）
```

> **为什么 schedulerEnabled 只能一个节点开**：插件启动时会把所有 `scheduled` 类型计划注册进本机 node-cron，多节点都开会导致同一计划被重复执行；统计预热和每日归档同理。多节点场景指定一台「调度主节点」开即可，业务读写不受影响。

### 3.3 各节点独立事项

- **workspace 目录**（`app.workspace`，默认 `D:\autotest\workspace` 或 `~/.dsh/workspace`）：
  - 默认**各节点独立**：`repos/`（git clone）与 `scripts/`（生成的自动化脚本）落在本机，互不影响，也互不可见。适合「每个库只在一台机器上拉取」的工作方式。
  - 如需共享（如所有节点都能看到同一份 clone 和脚本）：把 `app.workspace` 指到共享盘（NFS / SMB / 云盘挂载），注意并发 git 操作要避免同一目录同时 pull。
- **hdc 设备**：各节点 USB 连接自己的真机，设备管理页 `扫描设备` 会把本机设备登记进共享库（serial 唯一，天然去重）。
- **模型配置**：各节点用自己的 DSH 模型设置（模型 Key 不共享，这是 DSH 层配置）。

## 4. 部署步骤（完整示例，三节点）

```bash
# 服务器 S：数据层 + 主调度节点
docker compose -f docs/deploy/docker-compose.yml up -d
dsh --profile web          # 系统配置：db.mysqlUrl 指本机；exec.schedulerEnabled=true

# 测试机 T1 / T2：只跑实例，不开调度
dsh --profile web          # 系统配置：db.mysqlUrl 指服务器 S 的 MySQL；exec.schedulerEnabled=false
```

各节点浏览器打开自己的 DSH Web（或统一网关），看到的用例/任务/分析/设备数据完全一致。

## 5. 常见问题

- **节点 A 建的用例，节点 B 看不到** → 检查两边 `db.mysqlUrl` 是否指向同一个库；MySQL 服务是否只监听 127.0.0.1（若跨机需要监听局域网并设强密码）。
- **定时计划被重复执行** → `exec.schedulerEnabled` 只在主节点为 true。
- **节点 B 执行计划报「设备不存在」** → 设备按节点登记，选择计划时确认 device_ids 里是该节点已登记的设备。
- **git clone 冲突** → 共享 workspace 时避免多个节点对同一库同时执行「拉取仓库代码」；各节点独立 workspace 则无此问题。
- **版本不一致** → 所有节点必须安装同一插件版本（v0.1.33+），避免 schema 差异。

## 6. 需要插件配合的配置项（已实现）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `exec.schedulerEnabled` | true | 多节点部署时仅主节点开启调度器（v0.1.34+） |
| `db.mysqlUrl` | '' | 共享 MySQL 连接串（系统配置） |
| `data.redisUrl` / `data.redisCache` | '' / false | 共享 Redis 缓存（系统配置） |
