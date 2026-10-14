#!/usr/bin/env bash
# 跑 XTS（acts）测试用例（envkit 脚本资产：xts_run · POSIX 侧）
#
# 与 xts-run.ps1 同一份契约（src/services/envkit/builtin.ts::xts_run）。
#
# ⚠️ 关于 XTS 执行方式的说明（诚实声明，避免误导）：
# 鸿蒙 XTS 的真实执行入口是 DevEco Studio 的「测试应用」，命令行侧成熟可脚本化的是
# `hdc shell aa test`（启动测试 Ability 并产出报告）。本步骤采用后者：能在无 GUI 的
# 构建机/CI 上跑，产物是标准 XTS 报告目录，供 xts_report 解析。
# **不实现** Studio 专有 runner 协议——那需要 GUI 会话，与"无人值守执行"冲突。
#
# 退出码：0 成功（用例跑完，含失败用例） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 设备在线与测试模块存在都前置校验；
#   · 报告目录必须真存在（命令"成功"但没报告是 artifact_not_found）；
#   · 用例失败不是步骤失败——把"有用例失败"判成步骤失败会误判整条链断掉。
set -uo pipefail

TEST_MODULE_DIR=""; DEVICE_SERIAL=""; TEST_CASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -testModuleDir|--test-module-dir) TEST_MODULE_DIR="$2"; shift 2 ;;
    -deviceSerial|--device-serial) DEVICE_SERIAL="$2"; shift 2 ;;
    -testCase|--test-case) TEST_CASE="$2"; shift 2 ;;
    *) echo "[xts_run] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$TEST_MODULE_DIR" || ! -d "$TEST_MODULE_DIR" ]] && { echo "[xts_run] 测试模块目录不存在：$TEST_MODULE_DIR（请先执行 xts_scaffold）" >&2; exit 1; }
command -v hdc >/dev/null 2>&1 || { echo "[xts_run] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。" >&2; exit 2; }

# ① 设备在线
mapfile -t TARGETS < <(hdc list targets 2>/dev/null | grep -v '^[[:space:]]*$')
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "[xts_run] 未检测到在线设备（hdc list targets 为空）" >&2
  exit 1
fi
SERIAL="$DEVICE_SERIAL"
if [[ -z "$SERIAL" ]]; then
  SERIAL="${TARGETS[0]}"
  [[ ${#TARGETS[@]} -gt 1 ]] && echo "[xts_run] 多设备在线，未指定序列号，使用第一台：$SERIAL"
else
  FOUND=0
  for t in "${TARGETS[@]}"; do [[ "$t" == "$DEVICE_SERIAL" ]] && FOUND=1; done
  if [[ $FOUND -ne 1 ]]; then
    echo "[xts_run] 指定设备不在线：$DEVICE_SERIAL。当前在线：${TARGETS[*]}" >&2
    exit 1
  fi
fi

# ② 从测试模块推导 bundleName / abilityName（骨架里写死了约定）
OH_PKG="$TEST_MODULE_DIR/oh-package.json5"
[[ -f "$OH_PKG" ]] || { echo "[xts_run] 缺少 oh-package.json5：$OH_PKG" >&2; exit 1; }
MODULE_NAME=$(basename "$TEST_MODULE_DIR")
BUNDLE_NAME="ohos.acts.$MODULE_NAME"       # XTS 约定的测试包名前缀
ABILITY_NAME="$BUNDLE_NAME.MainAbility"

echo "[xts_run] module=$TEST_MODULE_DIR serial=$SERIAL bundle=$BUNDLE_NAME case=$TEST_CASE"

# ③ 报告目录（带时间戳，避免覆盖上一轮）
STAMP=$(date +%Y%m%d%H%M%S)
REPORT_DIR="$TEST_MODULE_DIR/reports/xts-$STAMP"
mkdir -p "$REPORT_DIR" || { echo "[xts_run] 创建报告目录失败" >&2; exit 1; }
RAW_LOG="$REPORT_DIR/aa-test-raw.log"

# ④ 执行：aa test 启动测试 Ability（-s class 可指定单个用例类）
TEST_ARGS=(-t "$SERIAL" shell aa test -b "$BUNDLE_NAME" -a "$ABILITY_NAME")
[[ -n "$TEST_CASE" ]] && TEST_ARGS+=(-s "$TEST_CASE")

OUTPUT=$(hdc "${TEST_ARGS[@]}" 2>&1)
CODE=$?
printf '%s\n' "$OUTPUT" > "$RAW_LOG"

# 命令级失败（连测试都没跑起来）与"有用例失败"分开
if [[ $CODE -ne 0 ]]; then
  echo "[xts_run] aa test 执行失败（退出码 $CODE）：$OUTPUT" >&2
  exit 1
fi

# ⑤ 报告落盘：pull 设备侧标准报告；拿不到就退化为原始日志并如实标注来源
PULLED=0
if hdc -t "$SERIAL" file recv "/sdcard/reports/xts" "$REPORT_DIR" >/dev/null 2>&1; then
  if find "$REPORT_DIR" -type f \( -name '*.xml' -o -name '*.json' -o -name '*.html' \) | grep -q .; then
    PULLED=1
  fi
fi
if [[ $PULLED -eq 1 ]]; then REPORT_SOURCE="device_pulled"; else REPORT_SOURCE="raw_log"; fi

cat > "$REPORT_DIR/run-meta.json" <<EOF
{
  "module": "$MODULE_NAME",
  "bundleName": "$BUNDLE_NAME",
  "serial": "$SERIAL",
  "testCase": "$TEST_CASE",
  "exitCode": $CODE,
  "reportSource": "$REPORT_SOURCE",
  "rawLog": "$RAW_LOG",
  "at": "$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"
}
EOF

# 产物校验：报告目录必须非空
if [[ -z "$(find "$REPORT_DIR" -type f 2>/dev/null | head -1)" ]]; then
  echo "[xts_run] 报告目录为空：$REPORT_DIR" >&2
  exit 1
fi

echo "[xts_run] 完成：$REPORT_DIR（来源 $REPORT_SOURCE）"
echo "XTS_REPORT_DIR=$REPORT_DIR"
echo "XTS_REPORT_SOURCE=$REPORT_SOURCE"
exit 0
