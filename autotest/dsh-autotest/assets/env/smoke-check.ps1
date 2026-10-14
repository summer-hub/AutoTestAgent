# 冒烟校验（envkit 脚本资产：smoke_check）
#
# 契约见 src/services/envkit/builtin.ts::smoke_check。
# 环境准备的终点不是"包装上了"，而是"应用真能拉起来且不崩"。
# 少了这一步，装包成功会被当成环境就绪，后续真机遍历/执行才在启动阶段失败——
# 那时候已经浪费了一次完整的环境准备。
#
# 退出码：0 成功（SMOKE_OK） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 成功判据是显式标记（stdout 打 SMOKE_OK），不是退出码 0——
#     与 hdc_install 同款思路：hdc 部分版本失败也返回 0；
#   · 三级校验：设备在线 → 应用已安装 → 能拉到前台。任一不过都明确说卡在哪级；
#   · 不静默换设备：指定了序列号但不在线就报错，不偷偷用第一台。

param(
  [Parameter(Mandatory=$true)][string]$bundleName,
  [string]$deviceSerial = "",
  [string]$abilityName = ""
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

$hdc = Get-Command hdc -ErrorAction SilentlyContinue
if (-not $hdc) {
  & $script:Fail "[smoke_check] 未检测到 hdc 命令。请安装 HarmonyOS Device Connector 并配置 PATH。"
  exit 2
}

if (-not $bundleName) {
  & $script:Fail "[smoke_check] bundleName 不能为空（真机遍历与执行都依赖它）"
  exit 2
}

# ① 设备在线
$targets = @(& hdc list targets 2>&1 | Where-Object { $_ -match '\S' })
if ($targets.Count -eq 0) {
  & $script:Fail "[smoke_check] 未检测到在线设备（hdc list targets 为空）"
  exit 1
}
$serial = $deviceSerial
if (-not $serial) {
  $serial = [string]$targets[0]
  if ($targets.Count -gt 1) { Write-Output "[smoke_check] 多设备在线，未指定序列号，使用第一台：$serial" }
} elseif ($targets -notcontains $deviceSerial) {
  & $script:Fail "[smoke_check] 指定设备不在线：$deviceSerial。当前在线：$($targets -join ', ')"
  exit 1
}
Write-Output "[smoke_check] 设备在线：$serial"

# ② 应用已安装
$installed = & hdc -t $serial shell bm dump -a 2>&1 | Out-String
if ($installed -notmatch [regex]::Escape($bundleName)) {
  & $script:Fail "[smoke_check] 应用未安装或不可见：$bundleName（bm dump -a 中未找到）。请先执行 hdc_install。"
  exit 1
}
Write-Output "[smoke_check] 应用已安装：$bundleName"

# ③ 能拉到前台
$startArgs = @("-t", $serial, "shell", "aa", "start", "-b", $bundleName)
if ($abilityName) { $startArgs += @("-a", $abilityName) }
$startOut = & hdc @startArgs 2>&1 | Out-String
$startCode = $LASTEXITCODE
if ($startCode -ne 0 -or $startOut -match 'error|fail') {
  & $script:Fail "[smoke_check] 应用拉起失败（退出码 $startCode）：$startOut"
  exit 1
}
Write-Output "[smoke_check] 应用已拉起：$bundleName"

# ④ 前台确认（给系统一点时间切换）
Start-Sleep -Seconds 2
$foreground = & hdc -t $serial shell "hidumper -s AbilityManagerService -a '-l'" 2>&1 | Out-String
if ($foreground -and $foreground -notmatch [regex]::Escape($bundleName)) {
  Write-Output "[smoke_check] 警告：前台未确认到 $bundleName（hidumper 输出不含该包名），但启动命令已成功"
}

Write-Output "[smoke_check] 冒烟通过：$bundleName @ $serial"
Write-Output "SMOKE_OK=1"
Write-Output "SMOKE_BUNDLE=$bundleName"
Write-Output "SMOKE_SERIAL=$serial"
exit 0
