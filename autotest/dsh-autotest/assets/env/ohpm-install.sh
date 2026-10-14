#!/usr/bin/env bash
# ohpm 依赖安装（envkit 脚本资产：ohpm_install · POSIX 侧）
#
# 与 ohpm-install.ps1 同一份契约（src/services/envkit/builtin.ts::ohpm_install），
# 行为逐条对齐：同样的参数、同样的退出码、同样的产物判据。
# 两侧实现必须同步改——只改一侧会造成"Windows 能跑、Linux 静默失败"。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
set -uo pipefail

PROJECT_DIR=""
OHPM_REGISTRY=""
OFFLINE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --ohpm-registry) OHPM_REGISTRY="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    *) echo "[ohpm_install] 未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]]; then
  echo "[ohpm_install] 工程目录不存在：$PROJECT_DIR" >&2
  exit 2
fi

if ! command -v ohpm >/dev/null 2>&1; then
  echo "[ohpm_install] 未检测到 ohpm 命令。请安装 DevEco Studio 命令行工具并配置 PATH。" >&2
  exit 2
fi

echo "[ohpm_install] projectDir=$PROJECT_DIR offline=$OFFLINE registry=$OHPM_REGISTRY"

ARGS=(install)
[[ -n "$OHPM_REGISTRY" ]] && ARGS+=(--registry "$OHPM_REGISTRY")
[[ "$OFFLINE" == "1" ]] && ARGS+=(--offline)

cd "$PROJECT_DIR" || exit 2
if ! ohpm "${ARGS[@]}"; then
  echo "[ohpm_install] ohpm install 失败" >&2
  exit 1
fi

# 产物判据：oh_modules 存在且非空（不让"命令成功但没产物"过关）
OH_MODULES="$PROJECT_DIR/oh_modules"
if [[ ! -d "$OH_MODULES" ]]; then
  echo "[ohpm_install] 安装命令成功但未生成 oh_modules：$OH_MODULES" >&2
  exit 1
fi
COUNT=$(find "$OH_MODULES" -mindepth 1 -maxdepth 1 | wc -l)
if [[ "$COUNT" -eq 0 ]]; then
  echo "[ohpm_install] oh_modules 为空：$OH_MODULES" >&2
  exit 1
fi

echo "[ohpm_install] 完成：$OH_MODULES（$COUNT 项）"
echo "OH_MODULES_PATH=$OH_MODULES"
exit 0
