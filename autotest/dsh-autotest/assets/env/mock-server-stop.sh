#!/usr/bin/env bash
# 停止本地 mock HTTP server（envkit 脚本资产：mock_server_stop · POSIX 侧）
#
# 与 mock-server-stop.ps1 同一份契约（src/services/envkit/builtin.ts::mock_server_stop）。
# mock_server_up 是**后台常驻**服务，必须有配套停止步骤——否则每轮测试都会漏一个
# node 进程，端口最终被占满。
#
# 退出码：0 成功（含"pid 文件不存在 = 已停止"） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · pid 文件不存在是正常情况 → 成功返回，不算失败；
#   · 幂等：重复停止同一服务第二次直接成功；
#   · 先 SIGTERM 宽限、再 SIGKILL。
set -uo pipefail

PID_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -pidPath|--pid-path) PID_PATH="$2"; shift 2 ;;
    *) echo "[mock_server_stop] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PID_PATH" ]] && { echo "[mock_server_stop] pidPath 必填" >&2; exit 2; }

# 已停止或从未启动：正常情况
if [[ ! -f "$PID_PATH" ]]; then
  echo "[mock_server_stop] pid 文件不存在，服务未在运行（幂等）：$PID_PATH"
  echo "MOCK_STOPPED=1"
  exit 0
fi

PID=$(cat "$PID_PATH" 2>/dev/null | tr -d '[:space:]')
if [[ -n "$PID" && "$PID" =~ ^[0-9]+$ ]]; then
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[mock_server_stop] 进程 $PID 已不存在（可能已被回收），清理 pid 文件"
    rm -f "$PID_PATH"
    echo "MOCK_STOPPED=1"
    exit 0
  fi
  echo "[mock_server_stop] 停止服务：pid=$PID"
  # 先 SIGTERM，宽限 3 秒（15 × 0.2s）给 server.close() 优雅退出，再 SIGKILL
  kill -TERM "$PID" 2>/dev/null || true
  GONE=0
  for _ in $(seq 1 15); do
    sleep 0.2
    if ! kill -0 "$PID" 2>/dev/null; then GONE=1; break; fi
  done
  if [[ $GONE -ne 1 ]]; then
    kill -KILL "$PID" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$PID" 2>/dev/null; then
      echo "[mock_server_stop] 进程 $PID 无法结束" >&2
      exit 1
    fi
  fi
  echo "[mock_server_stop] 已停止 pid=$PID"
else
  echo "[mock_server_stop] pid 文件内容无法解析为进程号：$PID_PATH（按已停止处理）"
fi

rm -f "$PID_PATH"
echo "MOCK_STOPPED=1"
exit 0
