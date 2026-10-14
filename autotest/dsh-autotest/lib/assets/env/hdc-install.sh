#!/usr/bin/env bash
# 安装 HAP 到真机（envkit 脚本资产：hdc_install · POSIX 侧）
#
# 与 hdc-install.ps1 同一份契约（src/services/envkit/builtin.ts::hdc_install）。
# 环境准备的终点：包装上真机，后续真机遍历与用例执行才有对象。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 装前先查设备——设备离线必须归 device_offline，不能等 install 报错再猜；
#   · 成功判据是输出含 "Successfully install"，不是退出码 0（hdc 部分版本失败也返回 0）；
#   · 多设备不静默选错——指定了序列号但不匹配就报错，不换设备。
set -uo pipefail

HAP_PATH=""; DEVICE_SERIAL=""; REPLACE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hap-path) HAP_PATH="$2"; shift 2 ;;
    --device-serial) DEVICE_SERIAL="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    *) echo "[hdc_install] 未知参数：$1" >&2; exit 2 ;;
  esac
done

if ! command -v hdc >/dev/null 2>&1; then
  echo "[hdc_install] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。" >&2
  exit 2
fi

[[ -z "$HAP_PATH" || ! -f "$HAP_PATH" ]] && { echo "[hdc_install] HAP 文件不存在：$HAP_PATH" >&2; exit 1; }

# 设备在线校验（装前查）
mapfile -t TARGETS < <(hdc list targets 2>/dev/null | grep -v '^[[:space:]]*$')
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "[hdc_install] 未检测到在线设备（hdc list targets 为空）。请连接鸿蒙设备并开启开发者模式。" >&2
  exit 1
fi

SERIAL="$DEVICE_SERIAL"
if [[ -z "$SERIAL" ]]; then
  SERIAL="${TARGETS[0]}"
  [[ ${#TARGETS[@]} -gt 1 ]] && echo "[hdc_install] 检测到 ${#TARGETS[@]} 台设备，未指定序列号，使用第一台：$SERIAL"
fi
# 指定了但不匹配：不静默换设备
if [[ -n "$DEVICE_SERIAL" ]]; then
  FOUND=0
  for t in "${TARGETS[@]}"; do [[ "$t" == "$DEVICE_SERIAL" ]] && FOUND=1; done
  if [[ $FOUND -ne 1 ]]; then
    echo "[hdc_install] 指定设备不在线：$DEVICE_SERIAL。当前在线：${TARGETS[*]}" >&2
    exit 1
  fi
fi

echo "[hdc_install] hap=$HAP_PATH serial=$SERIAL replace=$REPLACE"

INSTALL_ARGS=(-t "$SERIAL" install)
[[ $REPLACE -eq 1 ]] && INSTALL_ARGS+=(-r)
INSTALL_ARGS+=("$HAP_PATH")

OUTPUT=$(hdc "${INSTALL_ARGS[@]}" 2>&1)
CODE=$?

# 成功判据：输出含 Successfully install（hdc 部分版本失败也返回 0）
if ! grep -q 'Successfully install' <<< "$OUTPUT"; then
  echo "[hdc_install] 安装失败（退出码 $CODE）：$OUTPUT" >&2
  exit 1
fi

echo "[hdc_install] 完成：$HAP_PATH → $SERIAL"
echo "INSTALL_LOG=$(echo "$OUTPUT" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
exit 0
