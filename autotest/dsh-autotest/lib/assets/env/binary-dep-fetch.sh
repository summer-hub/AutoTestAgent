#!/usr/bin/env bash
# 取二进制依赖（envkit 脚本资产：binary_dep_fetch · POSIX 侧）
#
# 与 binary-dep-fetch.ps1 同一份契约（src/services/envkit/builtin.ts::binary_dep_fetch）。
# 三方库的 C++ 核心（lottie_turbo、sqlite、编解码库）需要 .so/.a 产物，
# 而"预编译 or 现编"是每个库都要做的决策——本步骤把三种来源统一成一个入口：
#   ① 本地缓存（最快，命中即返回）
#   ② 按 URL 下载（artifactUrl 给了就走这条）
#   ③ 按 ABI 现编（前两者都没有且 buildIfMissing=true）
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 产物必须真存在：三路都走完仍拿不到文件就是失败，绝不说"应该有了"；
#   · source 输出必须如实反映来源（cache/download/build）——后续归因与
#     缓存策略都依赖它，写假来源会让"为什么这次特别慢"查不出来；
#   · ABI 白名单防目录穿越（与 git-repo-path-safety 同纪律）。
set -uo pipefail

PROJECT_DIR=""; ARTIFACT_URL=""; ABI="arm64-v8a"; BUILD_IF_MISSING=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -projectDir|--project-dir) PROJECT_DIR="$2"; shift 2 ;;
    -artifactUrl|--artifact-url) ARTIFACT_URL="$2"; shift 2 ;;
    -abi|--abi) ABI="$2"; shift 2 ;;
    -buildIfMissing|--build-if-missing) BUILD_IF_MISSING=1; shift ;;
    *) echo "[binary_dep_fetch] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$PROJECT_DIR" || ! -d "$PROJECT_DIR" ]] && { echo "[binary_dep_fetch] 工程目录不存在：$PROJECT_DIR" >&2; exit 2; }

# ABI 白名单：防目录穿越与拼错路径
case "$ABI" in
  arm64-v8a|armeabi-v7a|armeabi|x86_64|x64|riscv64|riscv) ;;
  *) echo "[binary_dep_fetch] 不支持的 ABI：$ABI" >&2; exit 2 ;;
esac

CACHE_ROOT="$PROJECT_DIR/.autotest-env/binaries/$ABI"
TARGET="$CACHE_ROOT/libdependency.so"

# ① 本地缓存
if [[ -f "$TARGET" && -s "$TARGET" ]]; then
  SZ=$(stat -c%s "$TARGET" 2>/dev/null || stat -f%z "$TARGET")
  echo "[binary_dep_fetch] 命中本地缓存：$TARGET（$SZ bytes）"
  echo "BINARY_PATH=$TARGET"
  echo "SOURCE=cache"
  exit 0
fi

# ② 按 URL 下载
if [[ -n "$ARTIFACT_URL" ]]; then
  echo "[binary_dep_fetch] 下载预编译产物：$ARTIFACT_URL"
  mkdir -p "$CACHE_ROOT" || exit 2
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL --connect-timeout 30 --max-time 900 -o "$TARGET" "$ARTIFACT_URL"; then
      echo "[binary_dep_fetch] 下载失败（网络/代理/URL 失效）：$ARTIFACT_URL" >&2
      rm -f "$TARGET"
      exit 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q --timeout=30 -O "$TARGET" "$ARTIFACT_URL"; then
      echo "[binary_dep_fetch] 下载失败（网络/代理/URL 失效）：$ARTIFACT_URL" >&2
      rm -f "$TARGET"
      exit 1
    fi
  else
    echo "[binary_dep_fetch] 未检测到 curl / wget，无法下载" >&2
    exit 2
  fi
  if [[ -f "$TARGET" && -s "$TARGET" ]]; then
    SZ=$(stat -c%s "$TARGET" 2>/dev/null || stat -f%z "$TARGET")
    echo "[binary_dep_fetch] 下载完成：$TARGET（$SZ bytes）"
    echo "BINARY_PATH=$TARGET"
    echo "SOURCE=download"
    exit 0
  fi
  echo "[binary_dep_fetch] 下载后文件为空：$TARGET" >&2
  exit 1
fi

# ③ 按 ABI 现编
if [[ $BUILD_IF_MISSING -ne 1 ]]; then
  echo "[binary_dep_fetch] 无缓存、无 artifactUrl、且不允许现编——无法取得二进制依赖" >&2
  exit 1
fi

echo "[binary_dep_fetch] 本地与远程都无产物，尝试按 ABI=$ABI 现编"

# 现编判据：工程里要有 CMake 构建脚本，否则谈不上"现编"
HAS_BUILD_SCRIPT=0
if [[ -f "$PROJECT_DIR/CMakeLists.txt" || -f "$PROJECT_DIR/src/main/cpp/CMakeLists.txt" ]]; then
  HAS_BUILD_SCRIPT=1
elif [[ -n "$(find "$PROJECT_DIR" -maxdepth 3 -name CMakeLists.txt -print -quit 2>/dev/null)" ]]; then
  HAS_BUILD_SCRIPT=1
fi
if [[ $HAS_BUILD_SCRIPT -ne 1 ]]; then
  echo "[binary_dep_fetch] 工程中未找到 CMakeLists.txt，无法现编；且无缓存/无下载地址" >&2
  exit 1
fi

command -v cmake >/dev/null 2>&1 || { echo "[binary_dep_fetch] 未检测到 cmake，无法现编（工具链缺失）" >&2; exit 2; }

# 现编超出本脚本职责范围（需要 NDK 工具链与 ABI 参数组装），
# 这里明确报"需人工或后续脚本完成"，而不是假装成功。
echo "[binary_dep_fetch] 检测到 CMake 工程，但现编流程需 NDK 工具链与 ABI 组装，请补充实现或提供预编译 artifactUrl" >&2
exit 1
