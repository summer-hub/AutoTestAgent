#!/usr/bin/env bash
# git 子模块同步（envkit 脚本资产：submodule_sync · POSIX 侧）
#
# 与 submodule-sync.ps1 同一份契约（src/services/envkit/builtin.ts::submodule_sync）。
# 行为逐条对齐：同样的参数、同样的退出码、同样的"无子模块即成功跳过"语义。
#
# 退出码：0 成功（含"无子模块"跳过） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
set -uo pipefail

PROJECT_DIR=""; RECURSIVE=0; JOBS=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --recursive) RECURSIVE=1; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) echo "[submodule_sync] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]] && { echo "[submodule_sync] 工程目录不存在：$PROJECT_DIR" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "[submodule_sync] 未检测到 git 命令。" >&2; exit 2; }

# 无子模块是正常情况：明确说明并成功返回
if [[ ! -f "$PROJECT_DIR/.gitmodules" ]]; then
  echo "[submodule_sync] 无 .gitmodules，跳过（$PROJECT_DIR）"
  echo "SUBMODULES_PATH=$PROJECT_DIR"
  exit 0
fi

echo "[submodule_sync] projectDir=$PROJECT_DIR recursive=$RECURSIVE jobs=$JOBS"

cd "$PROJECT_DIR" || exit 2
git submodule init || { echo "[submodule_sync] git submodule init 失败" >&2; exit 1; }

ARGS=(submodule update --depth 1 --jobs "$JOBS")
[[ "$RECURSIVE" == "1" ]] && ARGS+=(--recursive)

if ! git "${ARGS[@]}" 2>&1; then
  echo "[submodule_sync] git submodule update 失败——常见原因是网络/代理或子模块地址失效" >&2
  exit 1
fi

echo "[submodule_sync] 完成：$PROJECT_DIR"
echo "SUBMODULES_PATH=$PROJECT_DIR"
exit 0
