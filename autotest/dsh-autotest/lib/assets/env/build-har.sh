#!/usr/bin/env bash
# 构建 HAR 包（envkit 脚本资产：build_har · POSIX 侧）
#
# 与 build-har.ps1 同一份契约（src/services/envkit/builtin.ts::build_har）。
# HAR 是三方库的交付形态，必须真的被构建出来。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：产物必须真存在且非空——命令成功但没 .har 就是 artifact_not_found。
set -uo pipefail

PROJECT_DIR=""; MODULE="entry"; BUILD_MODE="debug"; PRODUCT="default"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --module) MODULE="$2"; shift 2 ;;
    --build-mode) BUILD_MODE="$2"; shift 2 ;;
    --product) PRODUCT="$2"; shift 2 ;;
    *) echo "[build_har] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]] && { echo "[build_har] 工程目录不存在：$PROJECT_DIR" >&2; exit 2; }
[[ "$BUILD_MODE" != "debug" && "$BUILD_MODE" != "release" ]] && { echo "[build_har] build-mode 仅支持 debug/release" >&2; exit 2; }

# 工具探测：工程自带 hvigorw 优先，退回 PATH 上的 hvigorw / hvigor
USE_CMD=""
if [[ -f "$PROJECT_DIR/hvigorw" ]]; then USE_CMD="$PROJECT_DIR/hvigorw"
elif command -v hvigorw >/dev/null 2>&1; then USE_CMD="hvigorw"
elif command -v hvigor >/dev/null 2>&1; then USE_CMD="hvigor"
else
  echo "[build_har] 未检测到 hvigorw / hvigor。请在 DevEco Studio 环境下执行。" >&2
  exit 2
fi

# 模块目录：三方库常见布局是 library/，其次 <module>
MODULE_DIR="$PROJECT_DIR/$MODULE"
if [[ ! -d "$MODULE_DIR" ]]; then
  if [[ -d "$PROJECT_DIR/library" ]]; then MODULE_DIR="$PROJECT_DIR/library"
  else
    echo "[build_har] 模块目录不存在：$MODULE_DIR（也未找到 library/）" >&2
    exit 1
  fi
fi

echo "[build_har] projectDir=$PROJECT_DIR module=$MODULE mode=$BUILD_MODE product=$PRODUCT via=$USE_CMD"

MODE_SUFFIX="Debug"; [[ "$BUILD_MODE" == "release" ]] && MODE_SUFFIX="Release"
HAR_PATH="$MODULE_DIR/build/${MODULE}${MODE_SUFFIX}.har"

# 幂等：已有非空产物则跳过
if [[ -f "$HAR_PATH" && -s "$HAR_PATH" ]]; then
  echo "[build_har] 已存在产物，跳过构建（幂等）：$HAR_PATH"
  echo "HAR_PATH=$HAR_PATH"
  exit 0
fi

cd "$PROJECT_DIR" || exit 2
if ! "$USE_CMD" assembleHar --mode module -p "module=$MODULE@$PRODUCT" --no-daemon 2>&1; then
  echo "[build_har] hvigor assembleHar 失败" >&2
  exit 1
fi

if [[ ! -f "$HAR_PATH" ]]; then
  echo "[build_har] 构建命令成功但未找到产物：$HAR_PATH" >&2
  exit 1
fi
if [[ ! -s "$HAR_PATH" ]]; then
  echo "[build_har] 产物为空文件：$HAR_PATH" >&2
  exit 1
fi

BUILD_ID=$(sha256sum "$HAR_PATH" | cut -c1-16)
SIZE=$(stat -c%s "$HAR_PATH" 2>/dev/null || stat -f%z "$HAR_PATH")
echo "[build_har] 完成：$HAR_PATH（${SIZE} bytes, buildId=$BUILD_ID）"
echo "HAR_PATH=$HAR_PATH"
echo "BUILD_ID=$BUILD_ID"
exit 0
