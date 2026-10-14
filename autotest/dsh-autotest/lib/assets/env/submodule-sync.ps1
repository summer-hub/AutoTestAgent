# git 子模块同步（envkit 脚本资产：submodule_sync）
#
# 契约见 src/services/envkit/builtin.ts::submodule_sync。
# 三方库常把第三方 C 库（zlib/openssl/sqlite）放子模块，不同步会让后续
# 二进制依赖与编译直接失败——而失败信息往往只是"找不到头文件"，
# 根因却在子模块没拉。所以这一步要显式、幂等、可跳过。
#
# 退出码：0 成功（含"无子模块"跳过） · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 无 .gitmodules 是**正常情况**（大多数库没有子模块）→ 退出 0 并说明，不算失败；
#   · 幂等：已同步过的子模块重复执行走增量，不重新 clone；
#   · 浅克隆加速：三方库的子模块通常只需要最新代码，--depth 1 省大量时间。

param(
  [Parameter(Mandatory=$true)][string]$projectDir,
  [switch]$recursive,
  [int]$jobs = 4
)

$ErrorActionPreference = "Stop"
# 探测类失败用「写错误流 + exit」而不是 Write-Error：
# $ErrorActionPreference="Stop" 下 Write-Error 会抛异常中断脚本，
# 后面的 exit 2 根本执行不到——工具缺失会被误判成退出码 1（业务失败），
# 归类成 unknown 而不是 toolchain_missing。这是实测踩过的坑。
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $projectDir)) {
  & $script:Fail "[submodule_sync] 工程目录不存在：$projectDir"
  exit 2
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  & $script:Fail "[submodule_sync] 未检测到 git 命令。"
  exit 2
}

$gitmodules = Join-Path $projectDir ".gitmodules"
if (-not (Test-Path -LiteralPath $gitmodules)) {
  # 无子模块是正常情况：明确说明并成功返回（不是失败）
  Write-Output "[submodule_sync] 无 .gitmodules，跳过（$projectDir）"
  Write-Output "SUBMODULES_PATH=$projectDir"
  exit 0
}

Write-Output "[submodule_sync] projectDir=$projectDir recursive=$recursive jobs=$jobs"

Push-Location $projectDir
try {
  # init 先注册子模块（.gitmodules 有但 .git/config 没注册时必需）
  & git submodule init 2>&1 | ForEach-Object { Write-Output $_ }
  $initCode = $LASTEXITCODE
  if ($initCode -ne 0) {
    & $script:Fail "[submodule_sync] git submodule init 失败（退出码 $initCode）"
    exit 1
  }

  $syncArgs = @("submodule", "update", "--depth", "1", "--jobs", "$jobs")
  if ($recursive) { $syncArgs += "--recursive" }
  & git @syncArgs 2>&1 | ForEach-Object { Write-Output $_ }
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    & $script:Fail "[submodule_sync] git submodule update 失败（退出码 $code）——常见原因是网络/代理或子模块地址失效"
    exit 1
  }
} finally {
  Pop-Location
}

Write-Output "[submodule_sync] 完成：$projectDir"
Write-Output "SUBMODULES_PATH=$projectDir"
exit 0
