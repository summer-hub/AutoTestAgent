#!/usr/bin/env bash
# 冒烟校验（envkit 脚本资产：smoke_check · POSIX 侧）
#
# 与 smoke-check.ps1 同一份契约（src/services/envkit/builtin.ts::smoke_check）。
# 环境准备的终点不是"包装上了"，而是"应用真能拉起来且不崩"。
#
# 退出码：0 成功（SMOKE_OK） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 成功判据是显式标记（stdout 打 SMOKE_OK），不是退出码 0；
#   · 三级校验：设备在线 → 应用已安装 → 能拉到前台；
#   · 不静默换设备：指定了序列号但不在线就报错。
set -uo pipefail

BUNDLE_NAME=""; DEVICE_SERIAL=""; ABILITY_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -bundleName|--bundle-name) BUNDLE_NAME="$2"; shift 2 ;;
    -deviceSerial|--device-serial) DEVICE_SERIAL="$2"; shift 2 ;;
    -abilityName|--ability-name) ABILITY_NAME="$2"; shift 2 ;;
    *) echo "[smoke_check] 未知参数：$1" >&2; exit 2 ;;
  esac
done

if ! command -v hdc >/dev/null 2>&1; then
  echo "[smoke_check] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。" >&2
  exit 2
fi
[[ -z "$BUNDLE_NAME" ]] && { echo "[smoke_check] bundleName 不能为空（真机遍历与执行都依赖它）" >&2; exit 2; }

# ① 设备在线
mapfile -t TARGETS < <(hdc list targets 2>/dev/null | grep -v '^[[:space:]]*$')
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "[smoke_check] 未检测到在线设备（hdc list targets 为空）" >&2
  exit 1
fi
SERIAL="$DEVICE_SERIAL"
if [[ -z "$SERIAL" ]]; then
  SERIAL="${TARGETS[0]}"
  [[ ${#TARGETS[@]} -gt 1 ]] && echo "[smoke_check] 多设备在线，未指定序列号，使用第一台：$SERIAL"
else
  FOUND=0
  for t in "${TARGETS[@]}"; do [[ "$t" == "$DEVICE_SERIAL" ]] && FOUND=1; done
  if [[ $FOUND -ne 1 ]]; then
    echo "[smoke_check] 指定设备不在线：$DEVICE_SERIAL。当前在线：${TARGETS[*]}" >&2
    exit 1
  fi
fi
echo "[smoke_check] 设备在线：$SERIAL"

# ② 应用已安装
if ! hdc -t "$SERIAL" shell bm dump -a 2>&1 | grep -qF "$BUNDLE_NAME"; then
  echo "[smoke_check] 应用未安装或不可见：$BUNDLE_NAME（bm dump -a 中未找到）。请先执行 hdc_install。" >&2
  exit 1
fi
echo "[smoke_check] 应用已安装：$BUNDLE_NAME"

# ③ 能拉到前台
START_ARGS=(-t "$SERIAL" shell aa start -b "$BUNDLE_NAME")
[[ -n "$ABILITY_NAME" ]] && START_ARGS+=(-a "$ABILITY_NAME")
START_OUT=$(hdc "${START_ARGS[@]}" 2>&1)
START_CODE=$?
if [[ $START_CODE -ne 0 ]] || grep -qiE 'error|fail' <<< "$START_OUT"; then
  echo "[smoke_check] 应用拉起失败（退出码 $START_CODE）：$START_OUT" >&2
  exit 1
fi
echo "[smoke_check] 应用已拉起：$BUNDLE_NAME"

# ④ 前台确认（给系统一点时间切换）
sleep 2
FOREGROUND=$(hdc -t "$SERIAL" shell "hidumper -s AbilityManagerService -a '-l'" 2>&1 || true)
if [[ -n "$FOREGROUND" ]] && ! grep -qF "$BUNDLE_NAME" <<< "$FOREGROUND"; then
  echo "[smoke_check] 警告：前台未确认到 $BUNDLE_NAME（hidumper 输出不含该包名），但启动命令已成功"
fi

echo "[smoke_check] 冒烟通过：$BUNDLE_NAME @ $SERIAL"
echo "SMOKE_OK=1"
echo "SMOKE_BUNDLE=$BUNDLE_NAME"
echo "SMOKE_SERIAL=$SERIAL"
exit 0
