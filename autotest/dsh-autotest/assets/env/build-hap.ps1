# 构建 HAP 包（envkit 脚本资产：build_hap）
#
# 契约见 src/services/envkit/builtin.ts::build_hap。
# HAP 是**真机安装的单位**——环境准备的终点就是"有一个能装的 .hap"。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 build_har 完全一致，两侧脚本保持同构便于对照）：
#   · 产物必须真存在且非空——命令成功但没 .hap 就是 artifact_not_found；
#   · 构建前校验工程/模块，不在错误目录上白跑；
#   · 幂等——已有非空产物则跳过；
#   · 失败分类交给平台侧，本脚本只保证日志前缀统一。

param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [string]$module = "entry",
  [ValidateSet("debug","release")][string]$buildMode = "debug",
  [string]$product = "default"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $projectDir)) {
  Write-Error "[build_hap] 工程目录不存在：$projectDir"
  exit 2
}

# 工具探测：工程自带 hvigorw 优先
$hvigorw = Join-Path $projectDir "hvigorw"
$useCmd = ""
if (Test-Path -LiteralPath $hvigorw) { $useCmd = $hvigorw }
elseif (Get-Command hvigorw -ErrorAction SilentlyContinue) { $useCmd = "hvigorw" }
elseif (Get-Command hvigor -ErrorAction SilentlyContinue) { $useCmd = "hvigor" }
else {
  Write-Error "[build_hap] 未检测到 hvigorw / hvigor。请在 DevEco Studio 环境下执行。"
  exit 2
}

# 模块目录校验：HAP 模块通常是 entry
$moduleDir = Join-Path $projectDir $module
if (-not (Test-Path -LiteralPath $moduleDir)) {
  Write-Error "[build_hap] 模块目录不存在：$moduleDir"
  exit 1
}

Write-Output "[build_hap] projectDir=$projectDir module=$module mode=$buildMode product=$product via=$useCmd"

$modeSuffix = if ($buildMode -eq "release") { "Release" } else { "Debug" }
$hapName = "$module$modeSuffix.hap"
$hapPath = Join-Path $moduleDir "build" "$hapName"

# 幂等：已有非空产物则跳过
if (Test-Path -LiteralPath $hapPath) {
  $sz = (Get-Item -LiteralPath $hapPath).Length
  if ($sz -gt 0) {
    Write-Output "[build_hap] 已存在产物，跳过构建（幂等）：$hapPath（$sz bytes）"
    Write-Output "HAP_PATH=$hapPath"
    exit 0
  }
}

Push-Location $projectDir
try {
  & $useCmd "assembleHap" "--mode" "module" "-p" "module=$module@$product" "--no-daemon" 2>&1 | ForEach-Object { Write-Output $_ }
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Error "[build_hap] hvigor assembleHap 失败（退出码 $code）"
    exit 1
  }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $hapPath)) {
  Write-Error "[build_hap] 构建命令成功但未找到产物：$hapPath"
  exit 1
}
$size = (Get-Item -LiteralPath $hapPath).Length
if ($size -eq 0) {
  Write-Error "[build_hap] 产物为空文件：$hapPath"
  exit 1
}

$buildId = (Get-FileHash -LiteralPath $hapPath -Algorithm SHA256).Hash.Substring(0,16)
Write-Output "[build_hap] 完成：$hapPath（$size bytes, buildId=$buildId）"
Write-Output "HAP_PATH=$hapPath"
Write-Output "BUILD_ID=$buildId"
exit 0
