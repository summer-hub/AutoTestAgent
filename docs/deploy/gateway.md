# HTTPS 网关（Caddy 反向代理 DSH / AutoTest）

给 DSH Web（AutoTest 平台）加一层 HTTPS + 域名入口：外部用户通过 `https://你的域名` 访问，Caddy 把请求转发到本机 3080 的 DSH Web。Caddy 自动申请/续期 Let's Encrypt 证书，跨 Windows/macOS/Linux 一致。

## 1. 安装 Caddy

```bash
# Windows（PowerShell）
winget install Caddy.Caddy

# macOS
brew install caddy

# Linux（Debian/Ubuntu）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.list' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

## 2. 配置 Caddyfile

把 [Caddyfile](./Caddyfile) 放到 Caddy 配置目录：

- Windows：`%ProgramData%\Caddy\Caddyfile`（`caddy run` 时用 `--config` 指定也可以）
- macOS/Linux：`/etc/caddy/Caddyfile`

改域名后：

```bash
caddy validate --config Caddyfile   # 校验配置
caddy reload --config Caddyfile     # 热加载（caddy 服务运行中）
# 或首次：caddy start --config Caddyfile
```

## 3. 路径说明

反代转发的是 `127.0.0.1:3080` 整个 DSH Web：

- `https://域名/` → DSH Web 界面（AutoTest 侧边栏入口）
- `https://域名/autotest-web/*` → AutoTest 嵌入前端
- `https://域名/api/autotest/*` → AutoTest 业务 API（登录/用例/任务/分析等）
- DSH 自身 API/WebSocket 也在同一入口下

无需按路径拆分，整体转发即可。

## 4. 防火墙 / 端口

- 只开 `443`（HTTPS）与可选 `80`（证书签发用，Caddy 会自动 80→443）。3080 不需要对外。
- 数据服务（MySQL 3306 / Redis 6379）保持只监听 `127.0.0.1`，**绝不**暴露到公网。

```bash
# Linux 示例
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 5. 内网无公网域名

用 IP 或自签证书（Caddyfile 里 `tls internal` 块）：

- 浏览器首次访问会提示证书不受信任，手动信任即可（内网工具可接受）。
- 或购买/自建内网 CA，把 CA 加入各客户端信任库。

## 6. 常见问题

- **WebSocket 连不上 / 执行轨迹不刷新**：确认 Caddyfile 里带了 `header_up Upgrade/Connection`（已包含）；DSH 某些路径用 WS/SSE，缺这两个头会断连。
- **上传 Excel 报 413**：`request_body max_size` 已放宽到 100MB，仍失败检查 DSH 侧是否有其他限制。
- **证书申请失败**：域名需真实解析到本机公网 IP；防火墙 80/443 需开放；内网环境用 `tls internal`。
- **浏览器提示「不安全」**：检查是否用了 http 访问（应 https），或自签证书未信任。
- **Caddy 服务未开机自启**：Linux 用 `systemctl enable caddy`；macOS `brew services start caddy`；Windows 用任务计划程序或 NSSM 注册服务。

## 7. 多节点统一入口（可选）

多台 DSH 节点时，可以让 Caddy 按子路径或子域分发到各节点：

```text
node1.example.com { reverse_proxy 127.0.0.1:3080 }
node2.example.com { reverse_proxy 192.168.1.11:3080 }
```

这样每个节点一个域名，数据仍共享同一 MySQL（见 multi-node.md）。
