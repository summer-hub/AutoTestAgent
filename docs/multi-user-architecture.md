# AutoTest 多用户服务器架构设计（定稿）

> 规模参数：10 人 / 400 个三方库 / 10 万条用例 / 单内部团队共用 / AutoTest 内置账号 / 服务器可部署 Windows·macOS·Linux。

## 1. 结论先行

1. **不做分库分表**。10 万行在 PostgreSQL 单表里是"小表"，索引到位后毫秒级返回；10 人并发的 QPS 需求只有几十~几百，远没到分片阈值。现有 `repository.ts` 的 `cases_0..15` 分表路由层**保留不动**，作为未来量级 ×100 时的扩展点。
2. **数据库从 SQLite 迁到 PostgreSQL**。SQLite 是嵌入式单写者，多用户并发写会锁库，不适合服务器模式。全库 157 处 `getDb().prepare/withRead` 调用集中在 5 个文件，迁移面可控。
3. **单租户 + 角色分级，不做行级 RLS**。一个团队共用全部 400 个库，隔离需求退化为"谁能读/写/删"，用 RBAC 角色解决；业务表加 `owner_id` 只做归属展示与审计，不做强制行级过滤。
4. **认证与权限由 AutoTest 插件自建**。DSH 本身无多用户能力，社区认证插件只是 Web 登录门禁且不做业务隔离；业务侧账号体系必须在插件内实现。
5. **DSH + AutoTest 跑宿主机，PG/Redis 容器化**。hdc 真机需要 USB 直连运行 DSH 的机器，全容器方案在 Windows/macOS 下 USB 透传很麻烦；宿主机跑 Node + 容器跑数据服务是最稳的跨平台形态。

## 2. 部署拓扑

```
浏览器（10 个用户） / CI 机器
        │ HTTPS（自签或内网证书）
        ▼
[宿主机：Windows / macOS / Linux]
   DSH(3080) + AutoTest 插件  ←── hdc USB 直连真机
        │ 内置 auth 中间件（JWT / API Key）→ RBAC → 资源权限
        ▼
[Docker Compose]  postgres:16（数据）  redis:7（缓存，可后加）
        │
        ▼
磁盘：<workspace>/repos（git clone）、<workspace>/scripts（生成脚本）
```

## 3. 认证与用户体系（AutoTest 内置）

### 3.1 表结构（PostgreSQL DDL）

```sql
-- 用户
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,            -- 小写字母数字下划线
  email         TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,                   -- scrypt: salt$hash
  status        TEXT NOT NULL DEFAULT 'active',  -- active / locked / disabled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- 登录会话（refresh token，可吊销）
CREATE TABLE refresh_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,               -- 只存哈希
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API Key（CI / 脚本 / hdc 自动化）
CREATE TABLE api_keys (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                      -- 如 "CI 流水线"
  key_hash   TEXT NOT NULL UNIQUE,               -- sha256(sk_...)
  scopes     TEXT NOT NULL DEFAULT '[]',         -- JSON 数组，如 ["case:write","exec:run"]
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- 角色 / 权限（RBAC）
CREATE TABLE roles (
  id         BIGSERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,   -- admin / manager / engineer / viewer
  name       TEXT NOT NULL,
  builtin    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE permissions (
  id   BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE          -- library:write / case:delete / ...
);

CREATE TABLE user_roles (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- 审计
CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT,                              -- 可为空（匿名失败尝试）
  action     TEXT NOT NULL,                       -- login / case.update / task.delete ...
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
```

### 3.2 认证流程

- **注册**：邀请制。管理员在用户管理页生成一次性邀请码 → 新用户凭邀请码注册（用户名 + 密码）→ 初始角色默认 `viewer`，管理员再升权。避免公网开放注册被扫号。
- **密码**：用 `node:crypto.scrypt`（Node 内置，零原生依赖，跨平台最稳），格式 `salt$hash`；不要用 argon2 原生包（Windows/macOS/Linux 都要预编译，徒增部署问题）。
- **登录**：`POST /api/autotest/auth/login` → 返回 JWT access（15~60 分钟，含 `user_id/roles`）+ refresh token（7~30 天，落 `refresh_sessions` 表）。`POST /auth/refresh` 换新 access；登出/改密时吊销 refresh。
- **API Key**：`POST /api/autotest/auth/keys` 生成，明文只展示一次（`sk_` 前缀 + 48 位随机），服务端只存 sha256。支持多 key、按 scope 限制、吊销。CI 和自动化脚本走 `Authorization: Bearer sk_xxx`。
- **失败锁定**：同一账号连续 5 次密码错误锁 15 分钟；所有登录尝试写 `audit_logs`。

## 4. 权限分级（RBAC）

### 4.1 权限点清单

```
library:read/write/manage    用例库增删改与归属管理
case:read/write/delete       用例 CRUD（import/export 归入 write）
task:read/create/manage      任务创建与删除
plan:read/create/manage      执行计划
exec:read/run/cancel         执行与设备调用
device:read/manage           设备管理
analysis:read/run/delete     数据分析/归因
settings:read/write          系统配置
user:manage                  用户/角色/邀请码/API Key 管理
audit:read                   审计日志查看
```

### 4.2 角色矩阵

| 权限 | admin | manager | engineer | viewer |
|---|---|---|---|---|
| library | manage | write | read | read |
| case | manage | write | write | read |
| task / plan / exec | manage | manage | create+run | read |
| device | manage | manage | run | read |
| analysis | manage | write | run | read |
| settings | write | read | read | read |
| user / audit | manage | read | – | – |

内置 4 角色 + 权限点可扩展；`roles/permissions/user_roles/role_permissions` 四张表支持将来自定义角色。

### 4.3 检查链路

```
请求 → authRequired(permission?) 中间件
  ├─ 无 token / 无效 → 401
  ├─ 有 token → 验 JWT → 载入 user + roles + permissions
  ├─ 缺权限点 → 403
  └─ 通过 → 进入业务路由（58 个现有路由逐一标注所需权限点）
```

白名单（免登录）：`/health`、`/auth/login`、`/auth/register`、`/auth/refresh`。其余全部走中间件。

## 5. 数据模型改造

- 业务表（`libraries/cases/tasks/plans/executions/analyses`）各加一列 `owner_id BIGINT REFERENCES users(id)`，仅用于"创建者"展示与审计，**不做强制过滤**（单租户共享）。
- `devices` 加 `owner_id`（谁登记的），执行记录已有 `device_id` 可追溯。
- `settings/models/prompts` 属于系统级，只有 admin 可写。
- 审计写入点：登录/登出、改密、Key 生成吊销、用例增删改、任务删除、计划删除、执行取消、系统配置修改、用户/角色变更。

## 6. 高并发设计（10 人规模够用且留余地）

- **连接池**：`pg.Pool` 大小 = CPU×2~4（10 人规模 10~20 连接足够）。替代现有 better-sqlite3 主写连接 + 4 读池。
- **缓存**：复用现有 `cache.ts`（`data.redisCache/data.redisUrl/data.cacheTtlSeconds` 配置项已存在）。热点读（库列表、用例列表、首页统计卡片）走 Redis，写路径 `cacheDel` 失效已实现，接通 Redis 即生效。
- **深分页**：列表接口从 `OFFSET` 改为 keyset（`WHERE (id < ?) ORDER BY id DESC LIMIT 20`），10 万行规模翻页不衰减。
- **统计预聚合**：首页"用例库覆盖率/分片统计"不实时 COUNT，定时任务聚合到 `stats_cache` 表或 Redis，TTL 60s。
- **LLM 限流**：每用户每分钟最大调用数（如 10 次），防止误刷模型额度。
- **索引**：现有 `idx_*` 保留；补充 `cases(library_id, status, source)` 复合索引、`executions(plan_id, status)`、`analyses(library_id, kind, created_at)`。

## 7. 数据库迁移（SQLite → PostgreSQL）

### 7.1 改造点

| 文件 | 改动 |
|---|---|
| `db/connection.ts` | better-sqlite3 → `pg.Pool`；同步 `prepare(...).get/all/run` 改为异步 `query`；`withRead` 改为从池取连接 |
| `db/schema.ts` | 提供 PG 方言建表脚本（类型 TEXT→TEXT 基本兼容；自增列用 BIGSERIAL） |
| `db/repository.ts` | 保留分表路由层；`caseTableFor` 暂返回 `cases` |
| `api/http.ts` | 157 处调用中占比最大，逐路由改异步 |
| `services/executor.ts` / `analyzer.ts` | 同步改异步，注意事务用 `pool.connect()` |
| `services/cache.ts` | 已有 Redis 分支，配置接通即可 |

### 7.2 迁移步骤（停机迁移，数据量小）

1. 停 DSH → 对 SQLite 做一致性快照（`VACUUM INTO 'backup.db'`）。
2. 写一次性迁移脚本：读 SQLite（better-sqlite3 只读）→ 按表顺序写入 PG（libraries → cases → case_versions → tasks → plans → executions → devices → prompts → models → analyses → settings）。
3. 主键自增序列对齐：`setval('cases_id_seq', (SELECT max(id) FROM cases))`。
4. 启动 DSH（连接 PG）→ 冒烟：登录、用例列表、任务、分析各跑一遍。
5. 校验行数一致性（每表 `COUNT(*)` 对比）。

### 7.3 配置

`settings` 表新增键（或环境变量，环境变量优先）：

```
db.pgUrl = "postgres://autotest:密码@127.0.0.1:5432/autotest"
data.redisUrl = "redis://127.0.0.1:6379"
auth.jwtSecret = "<随机 32+ 字符>"   # 首次部署生成，勿泄露
auth.inviteOnly = true
```

## 8. 跨平台部署（Windows / macOS / Linux）

### 8.1 推荐形态：宿主机 DSH + 容器数据服务

理由：hdc 真机必须 USB 直连 DSH 所在机器；DSH/AutoTest 是 Node 应用（三平台都支持，当前已在 Windows 跑通）；PG/Redis 用 Docker 保证三平台一致。

```yaml
# docker-compose.yml（放在服务器任意目录）
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: autotest
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: autotest
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports: ["127.0.0.1:5432:5432"]   # 只暴露本机，不对外
  redis:
    image: redis:7
    restart: unless-stopped
    ports: ["127.0.0.1:6379:6379"]
volumes:
  pgdata:
```

```bash
# 启动数据服务（三平台同一命令）
docker compose up -d
```

### 8.2 宿主机准备

- **Windows**：安装 Node LTS + Docker Desktop（WSL2 后端）；`dsh --profile web` 启动。hdc 需 `HDC_SERVER_PORT` 与 adb-server 类似；USB 设备直接识别。
- **macOS**：Node LTS + Docker Desktop（Apple Silicon 用 arm64 镜像，PG/Redis 官方镜像原生支持）；USB 直连；`hdc` 工具链需 darwin 版。
- **Linux**：Node LTS + Docker Engine（无 Desktop 也可）；`hdc` 用 linux 版；USB 权限需 udev 规则（`adb`/`hdc` 常见）。
- 防火墙只开 3080（或经反代 443），5432/6379 只监听 127.0.0.1。

### 8.3 兼容性注意

- 认证用 `node:crypto` 的 scrypt + 纯 JS JWT 实现，**零原生依赖**，避免 argon2/bcrypt 在三平台预编译问题。
- 迁移到 PG 后不再依赖 better-sqlite3（可整体移除），原生编译面只剩 hdc 工具链本身。
- 路径处理已用 `node:path`（跨平台），代码无需改动；部署脚本分别提供 `setup.ps1`（Windows）与 `setup.sh`（macOS/Linux）。

## 9. 实施路线

| 阶段 | 内容 | 数据层 | 交付 |
|---|---|---|---|
| **0：认证与权限** | users/roles/audit 表 + JWT + API Key + 邀请注册 + RBAC 中间件接入 58 路由 + 前端登录页/用户管理页 | 仍 SQLite（表结构兼容） | 多人可登录、按角色操作 |
| **1：数据上服务器** | connection.ts 换 pg + 157 处调用异步化 + SQLite→PG 迁移脚本 + Redis 缓存接通 | PostgreSQL + Redis | 服务器化，并发写不锁库 |
| **2：加固** | keyset 深分页、统计预聚合、LLM 限流、审计查询页、executions 分区 | PostgreSQL | 规模化与可观测 |

阶段 0 与阶段 1 可独立上线；建议先做阶段 0（不动数据、风险最小），团队并行使用时再切阶段 1。
