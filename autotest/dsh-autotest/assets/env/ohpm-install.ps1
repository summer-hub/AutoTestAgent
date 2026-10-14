# ohpm 依赖安装（envkit 脚本资产：ohpm_install）
#
# 契约见 src/services/envkit/builtin.ts::ohpm_install。本脚本只负责
# 「参数组装 + 产物定位 + 日志规范」三件事，平台侧永远只认契约。
#
# 退出码（与 envkit/contract.ts::EXIT_CODES 对齐）：
#   0 成功（oh_modules 目录已生成） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 幂等——ohpm install 本身增量，重复执行不会重下已装依赖；
#   · 产物必须真存在——oh_modules 目录不存在即视为失败（不让"看起来成功了"过关）；
#   · 不吞错误——ohpm 的 stderr 原样转发，失败分类由平台侧按信号归类。

param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [string]$ohpmRegistry = "",
  [switch]$offline
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $projectDir)) {
  & $script:Missing "[ohpm_install] 工程目录不存在：$projectDir"
}

# 工具探测：ohpm 不存在要归成 toolchain_missing，不能等到 install 才报一堆看不懂的错
$ohpm = Get-Command ohpm -ErrorAction SilentlyContinue
if (-not $ohpm) {
  & $script:Missing "[ohpm_install] 未检测到 ohpm 命令。请安装 DevEco Studio 的命令行工具并配置环境变量。"
}

Write-Output "[ohpm_install] projectDir=$projectDir offline=$offline registry=$ohpmRegistry"

$installArgs = @("install")
if ($ohpmRegistry) { $installArgs += @("--registry", $ohpmRegistry) }
if ($offline) { $installArgs += "--offline" }

Push-Location $projectDir
try {
  & ohpm @installArgs
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    & $script:Fail "[ohpm_install] ohpm install 失败（退出码 $code）"
    exit 1
  }
} finally {
  Pop-Location
}

# 产物判据：oh_modules 目录存在且非空
$ohModules = Join-Path $projectDir "oh_modules"
if (-not (Test-Path -LiteralPath $ohModules)) {
  & $script:Fail "[ohpm_install] 安装命令成功但未生成 oh_modules：$ohModules"
  exit 1
}
$count = (Get-ChildItem -LiteralPath $ohModules -ErrorAction SilentlyContinue | Measure-Object).Count
if ($count -eq 0) {
  & $script:Fail "[ohpm_install] oh_modules 为空：$ohModules"
  exit 1
}

Write-Output "[ohpm_install] 完成：$ohModules（$count 项）"
Write-Output "OH_MODULES_PATH=$ohModules"
exit 0
