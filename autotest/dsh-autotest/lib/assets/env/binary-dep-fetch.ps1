# 取二进制依赖（envkit 脚本资产：binary_dep_fetch）
#
# 契约见 src/services/envkit/builtin.ts::binary_dep_fetch。
# 三方库的 C++ 核心（lottie_turbo、sqlite、编解码库）需要 .so/.a 产物，
# 而"预编译 or 现编"是每个库都要做的决策——这一步把三种来源统一成一个入口：
#   ① 本地缓存（最快，命中即返回）
#   ② 按 URL 下载（artifactUrl 给了就走这条）
#   ③ 按 ABI 现编（前两者都没有且 buildIfMissing=true）
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 产物必须真存在：三路都走完仍拿不到文件就是失败，绝不说"应该有了"；
#   · source 输出必须如实反映来源（cache/download/build）——后续归因与
#     缓存策略都依赖它，写假来源会让"为什么这次特别慢"查不出来；
#   · 目录遍历防止穿越：abi 参数只允许白名单字符（与 git-repo-path-safety 同纪律）。

param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [string]$artifactUrl = "",
  [string]$abi = "arm64-v8a",
  [switch]$buildIfMissing
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $projectDir)) {
  & $script:Fail "[binary_dep_fetch] 工程目录不存在：$projectDir"
  exit 2
}

# ABI 白名单：防目录穿越与拼错路径
if ($abi -notmatch '^(arm64-v8a|armeabi-v7a|armeabi|x86_64|x64|riscv64)$') {
  & $script:Fail "[binary_dep_fetch] 不支持的 ABI：$abi"
  exit 2
}

$cacheRoot = Join-Path $projectDir ".autotest-env" "binaries" $abi
$target = Join-Path $cacheRoot "libdependency.so"

# ① 本地缓存
if (Test-Path -LiteralPath $target) {
  $sz = (Get-Item -LiteralPath $target).Length
  if ($sz -gt 0) {
    Write-Output "[binary_dep_fetch] 命中本地缓存：$target（$sz bytes）"
    Write-Output "BINARY_PATH=$target"
    Write-Output "SOURCE=cache"
    exit 0
  }
}

# ② 按 URL 下载
if ($artifactUrl) {
  Write-Output "[binary_dep_fetch] 下载预编译产物：$artifactUrl"
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  try {
    Invoke-WebRequest -Uri $artifactUrl -OutFile $target -TimeoutSec 900 -ErrorAction Stop
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -gt 0)) {
      $sz = (Get-Item -LiteralPath $target).Length
      Write-Output "[binary_dep_fetch] 下载完成：$target（$sz bytes）"
      Write-Output "BINARY_PATH=$target"
      Write-Output "SOURCE=download"
      exit 0
    }
    & $script:Fail "[binary_dep_fetch] 下载后文件为空：$target"
    exit 1
  } catch {
    & $script:Fail "[binary_dep_fetch] 下载失败（网络/代理/URL 失效）：$($_.Exception.Message)"
    exit 1
  }
}

# ③ 按 ABI 现编
if (-not $buildIfMissing) {
  & $script:Fail "[binary_dep_fetch] 无缓存、无 artifactUrl、且不允许现编——无法取得二进制依赖"
  exit 1
}

Write-Output "[binary_dep_fetch] 本地与远程都无产物，尝试按 ABI=$abi 现编"

# 现编判据：工程里要有 CMake 或 NDK 构建脚本，否则谈不上"现编"
$cmakeLists = Join-Path $projectDir "CMakeLists.txt"
$ndkBuild = Join-Path $projectDir "src" "main" "cpp" "CMakeLists.txt"
$hasBuildScript = (Test-Path -LiteralPath $cmakeLists) -or (Test-Path -LiteralPath $ndkBuild) -or
  (Get-ChildItem -LiteralPath $projectDir -Filter "CMakeLists.txt" -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1)

if (-not $hasBuildScript) {
  & $script:Fail "[binary_dep_fetch] 工程中未找到 CMakeLists.txt，无法现编；且无缓存/无下载地址"
  exit 1
}

$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) {
  & $script:Fail "[binary_dep_fetch] 未检测到 cmake，无法现编（工具链缺失）"
  exit 2
}

# 现编超出本脚本职责范围（需要 NDK 工具链与 ABI 参数组装），
# 这里明确报"需人工或后续脚本完成"，而不是假装成功。
& $script:Fail "[binary_dep_fetch] 检测到 CMake 工程，但现编流程需 NDK 工具链与 ABI 组装，请补充 build_if_missing 实现或提供预编译 artifactUrl"
exit 1
