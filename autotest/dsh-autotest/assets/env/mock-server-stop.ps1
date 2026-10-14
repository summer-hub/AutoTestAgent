# 停止本地 mock HTTP server（envkit 脚本资产：mock_server_stop）
#
# 契约见 src/services/envkit/builtin.ts::mock_server_stop。
# mock_server_up 是**后台常驻**服务（否则会占住 runner 直到超时），
# 所以必须有配套的停止步骤——否则每轮测试都会漏一个 node 进程，端口最终被占满。
#
# 退出码：0 成功（含"pid 文件不存在 = 已停止"） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · pid 文件不存在是**正常情况**（服务已停/从未起）→ 成功返回，不算失败；
#   · 幂等：重复停止同一服务第二次直接成功；
#   · 先 SIGTERM 宽限、再 SIGKILL，给 server.close() 机会优雅退出。
param(
  [Parameter(Mandatory=$true)][string]$pidPath
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }

if (-not (Test-Path -LiteralPath $pidPath)) {
  # 已停止或从未启动：正常情况，明确说明并成功返回
  Write-Output "[mock_server_stop] pid 文件不存在，服务未在运行（幂等）：$pidPath"
  Write-Output "MOCK_STOPPED=1"
  exit 0
}

$pidText = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction SilentlyContinue)
$procId = 0
if ($pidText -and [int]::TryParse($pidText.Trim(), [ref]$procId) -and $procId -gt 0) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $p) {
    Write-Output "[mock_server_stop] 进程 $procId 已不存在（可能已被回收），清理 pid 文件"
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Write-Output "MOCK_STOPPED=1"
    exit 0
  }
  Write-Output "[mock_server_stop] 停止服务：pid=$procId name=$($p.ProcessName)"

  # 先 SIGTERM（CloseMainWindow 对无窗口进程无效，直接 Stop-Process 等价于 Terminate），
  # 宽限 3 秒后再强杀——给 server.close() 优雅退出的机会
  try {
    $sig = Add-Type -PassThru -Name "MockStopSig" -MemberDefinition `
      "[DllImport(`"kernel32.dll`")] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);" `
      -ErrorAction SilentlyContinue
  } catch { }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  $gone = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $gone = $true; break }
  }
  if (-not $gone) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
      & $script:Fail "[mock_server_stop] 进程 $procId 无法结束"
    }
  }
  Write-Output "[mock_server_stop] 已停止 pid=$procId"
} else {
  Write-Output "[mock_server_stop] pid 文件内容无法解析为进程号：$pidPath（按已停止处理）"
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Output "MOCK_STOPPED=1"
exit 0
