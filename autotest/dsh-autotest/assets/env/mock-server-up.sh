#!/usr/bin/env bash
# 起本地 mock HTTP server（envkit 脚本资产：mock_server_up · POSIX 侧）
#
# 与 mock-server-up.ps1 同一份契约（src/services/envkit/builtin.ts::mock_server_up）。
# 网络类三方库的测试不能依赖真实第三方服务——对方限流/改接口/挂掉都会让测试突然全失败，
# 且结果不可复现。本地 mock server + fixture 目录是唯一可控的路。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# ⚠️ 生命周期：后台起服务，写出 SERVER_URL 与 SERVER_PID_PATH 后立即退出 0；
#    后续用例执行期间服务保持存活。停止请用配套的 mock_server_stop。
set -uo pipefail

FIXTURE_DIR=""; PORT=18080; LATENCY_MS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -fixtureDir|--fixture-dir) FIXTURE_DIR="$2"; shift 2 ;;
    -port|--port) PORT="$2"; shift 2 ;;
    -latencyMs|--latency-ms) LATENCY_MS="$2"; shift 2 ;;
    *) echo "[mock_server_up] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$FIXTURE_DIR" ]] && { echo "[mock_server_up] fixtureDir 必填" >&2; exit 2; }
[[ -d "$FIXTURE_DIR" ]] || { echo "[mock_server_up] fixture 目录不存在：$FIXTURE_DIR" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[mock_server_up] 未检测到 node 命令（mock server 由 Node 实现）。" >&2; exit 2; }

[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "[mock_server_up] 端口非法：$PORT" >&2; exit 1; }
if (( PORT < 1024 || PORT > 65535 )); then echo "[mock_server_up] 端口超出范围：$PORT" >&2; exit 1; fi

# fixture 非空校验：空目录起服务等于所有请求 404，测试结果无意义
shopt -s nullglob
FIXTURES=("$FIXTURE_DIR"/*.json)
shopt -u nullglob
if [[ ${#FIXTURES[@]} -eq 0 ]]; then
  echo "[mock_server_up] fixture 目录里没有 .json：$FIXTURE_DIR（每个 .json 对应一个路由响应）" >&2
  exit 1
fi

# 端口占用检查：不能静默换端口（测试代码写死了基址）
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&- 3<&-
  echo "[mock_server_up] 端口已被占用：$PORT。请先停止占用进程或换端口。" >&2
  exit 1
fi

RUN_DIR="$FIXTURE_DIR/.mock-run"
mkdir -p "$RUN_DIR" || exit 2
LOG_PATH="$RUN_DIR/mock-server.log"
PID_PATH="$RUN_DIR/mock-server.pid"

# 服务实现（Node，随脚本内联）：读 fixture 目录，按文件名匹配路由，统一注入延迟；
# 未匹配返回 404 JSON（明确而非静默）。
SERVER_JS="$RUN_DIR/mock-server.js"
cat > "$SERVER_JS" <<'EOF'
const http = require('http');
const fs = require('fs');
const path = require('path');
const fixtureDir = process.argv[2];
const port = Number(process.argv[3]);
const latency = Number(process.argv[4] || 0);
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const respond = () => {
    const name = (req.url || '/').replace(/^\/+/, '').split('?')[0] || 'index';
    const file = path.join(fixtureDir, name.endsWith('.json') ? name : `${name}.json`);
    if (!fs.existsSync(file)) { send(404, { error: 'no_fixture', url: req.url }); return; }
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { send(500, { error: 'bad_fixture', detail: String(e.message) }); return; }
    const code = typeof obj.status === 'number' ? obj.status : 200;
    const payload = obj.body !== undefined ? obj.body : obj;
    send(code, payload);
  };
  if (latency > 0) { setTimeout(respond, latency); } else { respond(); }
});
server.listen(port, '127.0.0.1', () => { console.log(`MOCK_LISTENING port=${port}`); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
EOF

echo "[mock_server_up] fixture=$FIXTURE_DIR port=$PORT latency=${LATENCY_MS}ms fixtures=${#FIXTURES[@]}"

# 后台启动（不占住 runner），写 pid 文件供 mock_server_stop 使用
nohup node "$SERVER_JS" "$FIXTURE_DIR" "$PORT" "$LATENCY_MS" > "$LOG_PATH" 2>&1 &
PID=$!
echo "$PID" > "$PID_PATH"

# 就绪探测：等 MOCK_LISTENING 出现在日志里（最多 10 秒）
READY=0
for _ in $(seq 1 50); do
  sleep 0.2
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[mock_server_up] 服务进程提前退出，日志：$(cat "$LOG_PATH" 2>/dev/null || echo '(无)')" >&2
    rm -f "$PID_PATH"
    exit 1
  fi
  if grep -q 'MOCK_LISTENING' "$LOG_PATH" 2>/dev/null; then READY=1; break; fi
done
if [[ $READY -ne 1 ]]; then
  kill "$PID" 2>/dev/null || true
  rm -f "$PID_PATH"
  echo "[mock_server_up] 服务 10 秒内未就绪：port=$PORT（看 $LOG_PATH）" >&2
  exit 1
fi

echo "[mock_server_up] 服务就绪：http://127.0.0.1:$PORT（pid=$PID）"
echo "SERVER_URL=http://127.0.0.1:$PORT"
echo "SERVER_PID_PATH=$PID_PATH"
echo "SERVER_LOG_PATH=$LOG_PATH"
exit 0
