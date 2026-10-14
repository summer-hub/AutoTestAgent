#!/usr/bin/env bash
# 构建 HAP 包（envkit 脚本资产：build_hap · POSIX 侧）
#
# 与 build-hap.ps1 同一份契约（src/services/envkit/builtin.ts::build_hap）。
# HAP 是真机安装的单位，是环境准备的终点。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：产物必须真存在且非空；命令成功但没 .hap 就是 artifact_not_found。
set -uo pipefail

PROJECT_DIR=""; MODULE="entry"; BUILD_MODE="debug"; PRODUCT="default"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --module) MODULE="$2"; shift 2 ;;
    --build-mode) BUILD_MODE="$2"; shift 2 ;;
    --product) PRODUCT="$2"; shift 2 ;;
    *) echo "[build_hap] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]] && { echo "[build_hap] 工程目录不存在：$PROJECT_DIR" >&2; exit 2; }
[[ "$BUILD_MODE" != "debug" && "$BUILD_MODE" != "release" ]] && { echo "[build_hap] build-mode 仅支持 debug/release" >&2; exit 2; }

USE_CMD=""
if [[ -f "$PROJECT_DIR/hvigorw" ]]; then USE_CMD="$PROJECT_DIR/hvigorw"
elif command -v hvigorw >/dev/null 2>&1; then USE_CMD="hvigorw"
elif command -v hvigor >/dev/null 2>&1; then USE_CMD="hvigor"
else
  echo "[build_hap] 未检测到 hvigorw / hvigor。请在 DevEco Studio 环境下执行。" >&2
  exit 2
fi

MODULE_DIR="$PROJECT_DIR/$MODULE"
if [[ ! -d "$MODULE_DIR" ]]; then
  echo "[build_hap] 模块目录不存在：$MODULE_DIR" >&2
  exit 1
fi

echo "[build_hap] projectDir=$PROJECT_DIR module=$MODULE mode=$BUILD_MODE product=$PRODUCT via=$USE_CMD"

MODE_SUFFIX="Debug"; [[ "$BUILD_MODE" == "release" ]] && MODE_SUFFIX="Release"
HAP_PATH="$MODULE_DIR/build/${MODULE}${MODE_SUFFIX}.hap"

# 幂等：已有非空产物则跳过
if [[ -f "$HAP_PATH" && -s "$HAP_PATH" ]]; then
  echo "[build_hap] 已存在产物，跳过构建（幂等）：$HAP_PATH"
  echo "HAP_PATH=$HAP_PATH"
  exit 0
fi

cd "$PROJECT_DIR" || exit 2
if ! "$USE_CMD" assembleHap --mode module -p "module=$MODULE@$PRODUCT" --no-daemon 2>&1; then
  echo "[build_hap] hvigor assembleHap 失败" >&2
  exit 1
fi

if [[ ! -f "$HAP_PATH" ]]; then
  echo "[build_hap] 构建命令成功但未找到产物：$HAP_PATH" >&2
  exit 1
fi
if [[ ! -s "$HAP_PATH" ]]; then
  echo "[build_hap] 产物为空文件：$HAP_PATH" >&2
  exit 1
fi

BUILD_ID=$(sha256sum "$HAP_PATH" | cut -c1-16)
SIZE=$(stat -c%s "$HAP_PATH" 2>/dev/null || stat -f%z "$HAP_PATH")
echo "[build_hap] 完成：$HAP_PATH（${SIZE} bytes, buildId=$BUILD_ID）"
echo "HAP_PATH=$HAP_PATH"
echo "BUILD_ID=$BUILD_ID"
exit 0
