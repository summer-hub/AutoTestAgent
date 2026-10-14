# 构建 HAR 包（envkit 脚本资产：build_har）
#
# 契约见 src/services/envkit/builtin.ts::build_har。
# HAR 是三方库的交付形态——宿主应用集成的是这个包，所以它必须真的被构建出来。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 产物必须真存在——hvigorw 说成功但找不到 .har 就是失败（artifact_not_found），
#     这是最能骗过人的一类：命令退出码 0，产物却没有；
#   · 构建前先确认工程与模块存在，避免在错误目录上白跑几十分钟；
#   · 日志前缀统一 [build_har]，平台侧按信号归类失败。

param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [string]$module = "entry",
  [ValidateSet("debug","release")][string]$buildMode = "debug",
  [string]$product = "default"
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $projectDir)) {
  & $script:Fail "[build_har] 工程目录不存在：$projectDir"
  exit 2
}

# 工具探测：hvigorw 优先（工程自带包装器），退回全局 hvigor
$hvigorw = Join-Path $projectDir "hvigorw"
$useCmd = ""
if (Test-Path -LiteralPath $hvigorw) { $useCmd = $hvigorw }
elseif (Get-Command hvigorw -ErrorAction SilentlyContinue) { $useCmd = "hvigorw" }
elseif (Get-Command hvigor -ErrorAction SilentlyContinue) { $useCmd = "hvigor" }
else {
  & $script:Fail "[build_har] 未检测到 hvigorw / hvigor。请在 DevEco Studio 环境下执行，或将 hvigorw 放到工程根目录。"
  exit 2
}

# 模块目录必须存在：har 模块通常在 <projectDir>/<module> 或 library/
$moduleDir = Join-Path $projectDir $module
if (-not (Test-Path -LiteralPath $moduleDir)) {
  # 三方库常见布局：工程根即 library 模块，或存在 library/ 子目录
  $libDir = Join-Path $projectDir "library"
  if (Test-Path -LiteralPath $libDir) { $moduleDir = $libDir }
  else {
    & $script:Fail "[build_har] 模块目录不存在：$moduleDir（也未找到 library/）"
    exit 1
  }
}

Write-Output "[build_har] projectDir=$projectDir module=$module mode=$buildMode product=$product via=$useCmd"

# 产物名与 hvigor 的实际命名规则保持一致（大写模式名）
$modeSuffix = if ($buildMode -eq "release") { "Release" } else { "Debug" }
$harName = "$module$modeSuffix.har"
$harPath = Join-Path $moduleDir "build" "$harName"

# 已存在且非空 → 幂等跳过（避免重复全量编译）
if (Test-Path -LiteralPath $harPath) {
  $sz = (Get-Item -LiteralPath $harPath).Length
  if ($sz -gt 0) {
    Write-Output "[build_har] 已存在产物，跳过构建（幂等）：$harPath（$sz bytes）"
    Write-Output "HAR_PATH=$harPath"
    exit 0
  }
}

Push-Location $projectDir
try {
  & $useCmd "assembleHar" "--mode" "module" "-p" "module=$module@$product" "--no-daemon" 2>&1 | ForEach-Object { Write-Output $_ }
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    & $script:Fail "[build_har] hvigor assembleHar 失败（退出码 $code）"
    exit 1
  }
} finally {
  Pop-Location
}

# 产物判据：文件存在且非空。命令成功但没产物 = artifact_not_found
if (-not (Test-Path -LiteralPath $harPath)) {
  & $script:Fail "[build_har] 构建命令成功但未找到产物：$harPath"
  exit 1
}
$size = (Get-Item -LiteralPath $harPath).Length
if ($size -eq 0) {
  & $script:Fail "[build_har] 产物为空文件：$harPath"
  exit 1
}

$buildId = (Get-FileHash -LiteralPath $harPath -Algorithm SHA256).Hash.Substring(0,16)
Write-Output "[build_har] 完成：$harPath（$size bytes, buildId=$buildId）"
Write-Output "HAR_PATH=$harPath"
Write-Output "BUILD_ID=$buildId"
exit 0
