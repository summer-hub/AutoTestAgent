# 解析 XTS 报告成平台统一执行记录（envkit 脚本资产：xts_report）
#
# 契约见 src/services/envkit/builtin.ts::xts_report。
# 为什么需要单独一步：XTS 的报告格式（xml/json/html 混杂、设备 pull 下来目录结构不一）
# 与平台的执行记录是两套语义。不收敛的话，"这次 XTS 跑得怎么样"永远要看原始报告，
# 前端无法统计、无法与其它执行记录放在一起对比。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 解析不出结构化结果**不是**失败——至少产出"报告存在但无法解析"的摘要并如实标注，
#     让人知道去看原始日志，而不是静默返回空；
#   · 摘要必须区分 total / passed / failed / blocked / ignored 五态（XTS 的标准语义）；
#   · reportSource 如实透出（device_pulled / raw_log），不把退化来源假装成标准报告。
param(
  [Parameter(Mandatory=$true)][string]$reportDir
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }

if (-not (Test-Path -LiteralPath $reportDir)) {
  & $script:Fail "[xts_report] 报告目录不存在：$reportDir"
}

# ---- 收集报告文件 ----
$files = @(Get-ChildItem -LiteralPath $reportDir -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in @('.xml', '.json', '.html', '.log') })
if ($files.Count -eq 0) {
  & $script:Fail "[xts_report] 报告目录里没有可解析文件：$reportDir"
}

$meta = $null
$metaFile = Join-Path $reportDir "run-meta.json"
if (Test-Path -LiteralPath $metaFile) {
  try { $meta = Get-Content -LiteralPath $metaFile -Raw | ConvertFrom-Json } catch { $meta = $null }
}

# ---- 解析 XTS 结果 ----
# XTS 标准结果文件是 Tests.xml（每个 TestCase 一个 <TestCase> 节点，Result 属性为
# Pass/Fail/Blocked/Ignore）。这里做最小可用解析：数节点 + 读 Result 属性。
$total = 0; $passed = 0; $failed = 0; $blocked = 0; $ignored = 0
$cases = @()
$parsedStructured = $false

foreach ($f in $files) {
  if ($f.Extension -ne '.xml') { continue }
  try {
    [xml]$doc = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction Stop
    $nodes = $doc.SelectNodes('//TestCase')
    if (-not $nodes -or $nodes.Count -eq 0) { continue }
    $parsedStructured = $true
    foreach ($n in $nodes) {
      $total++
      $result = [string]$n.Result
      $name = [string]$n.Name
      switch ($result.ToLower()) {
        'pass' { $passed++ }
        'fail' { $failed++ }
        'blocked' { $blocked++ }
        'ignored' { $ignored++ }
        default { $ignored++ }
      }
      $cases += @{ name = $name; result = $result }
    }
  } catch {
    Write-Output "[xts_report] 跳过无法解析的 xml：$($f.Name)（$($_.Exception.Message)）"
  }
}

# ---- 产出归一化摘要 ----
$summaryPath = Join-Path $reportDir "xts-summary.json"
$summary = [ordered]@{
  reportDir = $reportDir
  reportSource = $(if ($meta) { [string]$meta.reportSource } else { 'unknown' })
  structured = $parsedStructured
  total = $total
  passed = $passed
  failed = $failed
  blocked = $blocked
  ignored = $ignored
  passRate = $(if ($total -gt 0) { [math]::Round($passed / $total, 4) } else { 0 })
  module = $(if ($meta) { [string]$meta.module } else { '' })
  bundleName = $(if ($meta) { [string]$meta.bundleName } else { '' })
  serial = $(if ($meta) { [string]$meta.serial } else { '' })
  cases = $cases
  note = $(if (-not $parsedStructured) {
      '未解析出结构化用例结果（报告可能是原始日志或非标准格式），请查看原始报告'
    } else { '' })
  at = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

# ---- 平台可读的输出 ----
Write-Output "[xts_report] total=$total passed=$passed failed=$failed blocked=$blocked ignored=$ignored structured=$parsedStructured"
Write-Output "XTS_TOTAL=$total"
Write-Output "XTS_PASSED=$passed"
Write-Output "XTS_FAILED=$failed"
Write-Output "SUMMARY_PATH=$summaryPath"

# 有失败用例**不是**步骤失败（报告解析成功了）——由平台按用例维度判通过率
exit 0
