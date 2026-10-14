# 读取并校验工程清单（envkit 脚本资产：build_manifest）
#
# 契约见 src/services/envkit/builtin.ts::build_manifest。
# 为什么单独一步：bundleName / module 名 / target API level 是后面所有步骤
# （构建、装包、真机遍历、执行）的公共输入。提前把它读出来并落成一份归一化 JSON，
# 后续步骤就不必各自去解析 build-profile.json5 / oh-package.json5 的细节差异。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 读不到就明说读不到——manifest 缺失是常见且重要的失败（工程结构不符预期），
#     绝不返回一份"猜出来的"清单；
#   · JSON5 的注释与尾逗号要容忍（鸿蒙工程里普遍这么写），解析不了要给出原文行号。

param(
  [Parameter(Mandatory=$true)][string]$projectDir
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $projectDir)) {
  Write-Error "[build_manifest] 工程目录不存在：$projectDir"
  exit 2
}

$buildProfile = Join-Path $projectDir "build-profile.json5"
$ohPackage = Join-Path $projectDir "oh-package.json5"

if (-not (Test-Path -LiteralPath $buildProfile) -and -not (Test-Path -LiteralPath $ohPackage)) {
  Write-Error "[build_manifest] 未找到 build-profile.json5 或 oh-package.json5：$projectDir"
  exit 1
}

# 归一化清单：把散在两个文件里的事实合成一份，供后续步骤与平台读取。
# 解析失败不静默：任何一个文件读不出来都要在 errors 里记明，由平台判失败。
$manifest = [ordered]@{
  projectDir  = $projectDir
  bundleName  = ""
  moduleName  = ""
  apiLevel    = ""
  versionName = ""
  versionCode = 0
  modules     = @()
  errors      = @()
}

function Strip-Json5([string]$text) {
  # 去掉行注释与块注释、去尾逗号：让标准 JSON 解析器能读鸿蒙的 JSON5
  $t = $text -replace '(?m)//.*$', '' -replace '(?s)/\*.*?\*/', ''
  $t = $t -replace ',(\s*[}\]])', '$1'
  return $t
}

function Read-JsonLoose([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  if (-not $raw) { return $null }
  try {
    return $raw | Strip-Json5 | ConvertFrom-Json
  } catch {
    Write-Error "[build_manifest] 解析失败：$file — $($_.Exception.Message)"
    return $null
  }
}

$bp = Read-JsonLoose $buildProfile
if ($bp) {
  # app.bundleName（新格式）或 modules[0].apiVersion 兜底
  if ($bp.app -and $bp.app.bundleName) { $manifest.bundleName = [string]$bp.app.bundleName }
  if ($bp.app -and $bp.app.products) {
    $first = @($bp.app.products)[0]
    if ($first -and $first.targetSdkVersion) { $manifest.apiLevel = [string]$first.targetSdkVersion }
  }
  if ($bp.modules) {
    $manifest.modules = @($bp.modules | ForEach-Object { [string]$_.name })
    if ($manifest.modules.Count -gt 0 -and -not $manifest.moduleName) { $manifest.moduleName = $manifest.modules[0] }
  }
}

$op = Read-JsonLoose $ohPackage
if ($op) {
  if ($op.name) { $manifest.moduleName = [string]$op.name }
  if ($op.version) { $manifest.versionName = [string]$op.version }
}

# bundleName 是后续真机遍历与执行的必要输入，读不到就是失败（不能拿空串往下跑）
if (-not $manifest.bundleName) {
  $manifest.errors += "未解析到 bundleName（检查 build-profile.json5 的 app.bundleName）"
}

$manifestDir = Join-Path $projectDir ".autotest-env"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir "manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

if ($manifest.errors.Count -gt 0) {
  Write-Error ("[build_manifest] " + ($manifest.errors -join "; "))
  exit 1
}

Write-Output "[build_manifest] bundleName=$($manifest.bundleName) module=$($manifest.moduleName) apiLevel=$($manifest.apiLevel)"
Write-Output "MANIFEST_PATH=$manifestPath"
Write-Output "BUNDLE_NAME=$($manifest.bundleName)"
exit 0
