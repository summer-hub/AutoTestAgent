# 安装 HAP 到真机（envkit 脚本资产：hdc_install）
#
# 契约见 src/services/envkit/builtin.ts::hdc_install。
# 这是环境准备的终点：包装上真机，后续真机遍历与用例执行才有对象。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 装前先查设备——设备离线必须归 device_offline，不能等 install 报一堆错再猜；
#   · 成功判据是 hdc 输出里的 "Successfully install"，不是退出码 0
#     （hdc 在部分版本上安装失败也返回 0，这是实测踩过的坑）；
#   · 未指定序列号时取 list targets 的第一个，但**不静默选错设备**——多设备要显式指定。

param(
  [Parameter(Mandatory=$true)][string]$hapPath,
  [string]$deviceSerial = "",
  [switch]$replace
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

# 工具探测
$hdc = Get-Command hdc -ErrorAction SilentlyContinue
if (-not $hdc) {
  & $script:Fail "[hdc_install] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。"
  exit 2
}

# 产物校验：待安装的 hap 必须真实存在
if (-not (Test-Path -LiteralPath $hapPath)) {
  & $script:Fail "[hdc_install] HAP 文件不存在：$hapPath"
  exit 1
}

# 设备在线校验（装前查，避免把"设备没连"归成安装失败）
$targets = & hdc list targets 2>&1
$targetLines = @($targets | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*$' })
if ($targetLines.Count -eq 0) {
  & $script:Fail "[hdc_install] 未检测到在线设备（hdc list targets 为空）。请连接鸿蒙设备并开启开发者模式。"
  exit 1
}

$serial = $deviceSerial
if (-not $serial) {
  $serial = [string]$targetLines[0]
  if ($targetLines.Count -gt 1) {
    Write-Output "[hdc_install] 检测到 $($targetLines.Count) 台设备，未指定序列号，使用第一台：$serial"
  }
}
# 指定了但不匹配：不静默换设备（会把包装到别的机器上）
if ($deviceSerial -and ($targetLines -notcontains $deviceSerial)) {
  & $script:Fail "[hdc_install] 指定设备不在线：$deviceSerial。当前在线：$($targetLines -join ', ')"
  exit 1
}

Write-Output "[hdc_install] hap=$hapPath serial=$serial replace=$replace"

$installArgs = @("-t", $serial, "install")
if ($replace) { $installArgs += "-r" }
$installArgs += $hapPath

$output = & hdc @installArgs 2>&1
$outputText = ($output | Out-String)
$code = $LASTEXITCODE

# 成功判据：输出含 Successfully install（hdc 部分版本失败也返回 0）
if ($outputText -notmatch 'Successfully install') {
  & $script:Fail "[hdc_install] 安装失败（退出码 $code）：$outputText"
  exit 1
}

Write-Output "[hdc_install] 完成：$hapPath → $serial"
Write-Output "INSTALL_LOG=$($outputText.Trim())"
exit 0
