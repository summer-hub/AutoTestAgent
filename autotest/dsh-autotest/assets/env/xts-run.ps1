# 跑 XTS（acts）测试用例（envkit 脚本资产：xts_run）
#
# 契约见 src/services/envkit/builtin.ts::xts_run。
#
# ⚠️ 关于 XTS 执行方式的说明（诚实声明，避免误导）：
# 鸿蒙 XTS 的真实执行入口是 DevEco Studio 的「测试应用」（xts test runner），
# 命令行侧成熟可脚本化的是 `hdc shell aa test`（启动测试 Ability 并产出报告）。
# 本步骤采用后者：它能在无 GUI 的构建机/CI 上跑，且产物是标准 XTS 报告目录，
# 供 xts_report 解析。**不实现** Studio 专有的 runner 协议——那需要 GUI 会话，
# 与"无人值守执行"的目标冲突。
#
# 退出码：0 成功（用例跑完，含失败用例） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 设备在线与测试模块存在都要前置校验——缺一项就明确报，不跑到一半才失败；
#   · 报告目录必须真存在：命令"成功"但没产出报告是失败（artifact_not_found）；
#   · 用例失败**不是**步骤失败（exit 0，报告里有 failed 计数）——
#     把"有用例失败"判成步骤失败会让整条环境链被误判为断掉。
param(
  [Parameter(Mandatory=$true)][string]$testModuleDir,
  [string]$deviceSerial = "",
  [string]$testCase = ""
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $testModuleDir)) {
  & $script:Fail "[xts_run] 测试模块目录不存在：$testModuleDir（请先执行 xts_scaffold）"
}
$hdc = Get-Command hdc -ErrorAction SilentlyContinue
if (-not $hdc) {
  & $script:Missing "[xts_run] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。"
}

# ① 设备在线
$targets = @(& hdc list targets 2>&1 | Where-Object { $_ -match '\S' })
if ($targets.Count -eq 0) {
  & $script:Fail "[xts_run] 未检测到在线设备（hdc list targets 为空）"
}
$serial = $deviceSerial
if (-not $serial) {
  $serial = [string]$targets[0]
  if ($targets.Count -gt 1) { Write-Output "[xts_run] 多设备在线，未指定序列号，使用第一台：$serial" }
} elseif ($targets -notcontains $deviceSerial) {
  & $script:Fail "[xts_run] 指定设备不在线：$deviceSerial。当前在线：$($targets -join ', ')"
}

# ② 从测试模块推导 bundleName / abilityName（骨架里写死了约定）
$ohPkg = Join-Path $testModuleDir "oh-package.json5"
if (-not (Test-Path -LiteralPath $ohPkg)) { & $script:Fail "[xts_run] 缺少 oh-package.json5：$ohPkg" }
$moduleName = Split-Path $testModuleDir -Leaf
$bundleName = "ohos.acts.$moduleName"          # XTS 约定的测试包名前缀
$abilityName = "$bundleName.MainAbility"

Write-Output "[xts_run] module=$testModuleDir serial=$serial bundle=$bundleName case=$testCase"

# ③ 报告目录（带时间戳，避免覆盖上一轮）
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reportDir = Join-Path $testModuleDir "reports" "xts-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$rawLog = Join-Path $reportDir "aa-test-raw.log"

# ④ 执行：aa test 启动测试 Ability（-s class 可指定单个用例类）
$testArgs = @("-t", $serial, "shell", "aa", "test", "-b", $bundleName, "-a", $abilityName)
if ($testCase) { $testArgs += @("-s", $testCase) }

$output = & hdc @testArgs 2>&1 | Out-String
$code = $LASTEXITCODE
Set-Content -LiteralPath $rawLog -Value $output -Encoding UTF8

# 命令级失败（连测试都没跑起来）与"有用例失败"要分开：
# 前者是步骤失败，后者命令本身是成功的。
if ($code -ne 0) {
  & $script:Fail "[xts_run] aa test 执行失败（退出码 $code）：$output"
}

# ⑤ 报告落盘：把原始输出转成最小可解析结构（xts_report 的输入）
# 真实 XTS 报告由 runner 写到设备 /sdcard/reports 下，这里 pull 过来；
# 拿不到就退化为"用原始日志当报告"——并如实标注来源，不假装是标准报告。
$pulled = $false
try {
  & hdc -t $serial file recv "/sdcard/reports/xts" $reportDir 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0 -and (Get-ChildItem -LiteralPath $reportDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(xml|json|html)$' } | Select-Object -First 1)) {
    $pulled = $true
  }
} catch { /* 设备侧没有标准报告目录：退化为原始日志 */ }

$summary = @{
  module = $moduleName
  bundleName = $bundleName
  serial = $serial
  testCase = $testCase
  exitCode = $code
  reportSource = $(if ($pulled) { 'device_pulled' } else { 'raw_log' })
  rawLog = $rawLog
  at = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $reportDir "run-meta.json") -Value $summary -Encoding UTF8

# 产物校验：报告目录必须非空
$files = @(Get-ChildItem -LiteralPath $reportDir -Recurse -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) { & $script:Fail "[xts_run] 报告目录为空：$reportDir" }

Write-Output "[xts_run] 完成：$reportDir（来源 $($summary.reportSource)）"
Write-Output "XTS_REPORT_DIR=$reportDir"
Write-Output "XTS_REPORT_SOURCE=$(if ($pulled) { 'device_pulled' } else { 'raw_log' })"
exit 0
