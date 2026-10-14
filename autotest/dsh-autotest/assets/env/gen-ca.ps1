# 生成本地自签 CA 与服务端证书（envkit 脚本资产：gen_ca）
#
# 契约见 src/services/envkit/builtin.ts::gen_ca。
# 网络类三方库要测 HTTPS，就必须有可控的 CA：官方证书过期/换域名都会让测试突然全失败，
# 而自签 CA + 固定 SAN 是唯一可复现的路。产物供 mock_server_up 与真机 trust 配置使用。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律：
#   · 幂等：已存在且未过期的 CA 直接复用（证书不该每次重新生成，否则设备里的 trust 配置会失效）；
#   · 产物必须真存在：声明了几个证书文件就要真的 stat 到，缺一个即失败；
#   · 私钥权限收敛（Windows ACL），不放全局可读；
#   · 到期时间如实输出，供上层做临期告警（resourcekit::expiringCerts）。
param(
  [Parameter(Mandatory=$true)][string]$outDir,
  [string]$cn = "AutoTest Local CA",
  [string]$san = "localhost,127.0.0.1",
  [int]$days = 825
)

$ErrorActionPreference = "Stop"
$script:Fail = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 1 }
$script:Missing = { param([string]$msg) [Console]::Error.WriteLine($msg); exit 2 }

if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
  & $script:Missing "[gen_ca] 未检测到 openssl。请安装 OpenSSL 并配置 PATH（Git for Windows 自带）。"
}

if ($days -lt 1) { & $script:Fail "[gen_ca] days 必须为正：$days" }
if (-not $san) { & $script:Fail "[gen_ca] san 不能为空（服务端证书需要 SAN，否则现代客户端拒绝）" }

$base = ($cn -replace '[^a-zA-Z0-9]+', '-').ToLower()
$caCrt = Join-Path $outDir "$base-ca.crt"
$caKey = Join-Path $outDir "$base-ca.key"
$srvCrt = Join-Path $outDir "$base-server.crt"
$srvKey = Join-Path $outDir "$base-server.key"
$srvCsr = Join-Path $outDir "$base-server.csr"
$srvExt = Join-Path $outDir "$base-server.ext"

Write-Output "[gen_ca] outDir=$outDir cn=$cn san=$san days=$days"

# ---- 幂等：CA 已存在且未过期 → 复用 ----
function Test-CertNotExpiring([string]$crt, [int]$warnDays) {
  if (-not (Test-Path -LiteralPath $crt)) { return $false }
  try {
    $text = & openssl x509 -in $crt -noout -enddate 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $m = [regex]::Match($text, 'notAfter=(.*)$')
    if (-not $m.Success) { return $false }
    $end = [DateTime]::Parse($m.Groups[1].Value.Trim())
    return $end -gt (Get-Date).AddDays($warnDays)
  } catch { return $false }
}

if ((Test-CertNotExpiring $caCrt 30) -and (Test-CertNotExpiring $srvCrt 30)) {
  Write-Output "[gen_ca] 复用已有且未临期的 CA（幂等）：$caCrt"
  Write-Output "CA_CERT_PATH=$caCrt"
  Write-Output "SERVER_CERT_PATH=$srvCrt"
  Write-Output "CA_EXPIRES_AT=$((& openssl x509 -in $caCrt -noout -enddate 2>$null) -replace 'notAfter=','')"
  exit 0
}

# ---- 生成 CA ----
Push-Location $outDir
try {
  if (-not (Test-CertNotExpiring $caCrt 0)) {
    & openssl genrsa -out $caKey 4096 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { & $script:Fail "[gen_ca] 生成 CA 私钥失败" }
    & openssl req -x509 -new -nodes -key $caKey -sha256 -days $days -out $caCrt `
      -subj "/CN=$cn" 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { & $script:Fail "[gen_ca] 生成 CA 证书失败" }
  }

  # ---- 生成服务端证书（带 SAN）----
  if (-not (Test-CertNotExpiring $srvCrt 0)) {
    & openssl genrsa -out $srvKey 2048 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { & $script:Fail "[gen_ca] 生成服务端私钥失败" }

    # SAN 扩展文件：现代客户端（含真机）只认 SAN，不认 CN
    $sanLines = @()
    $i = 1
    foreach ($entry in ($san -split ',')) {
      $e = $entry.Trim()
      if (-not $e) { continue }
      if ($e -match '^\d+\.\d+\.\d+\.\d+$') { $sanLines += "IP.$i = $e" }
      else { $sanLines += "DNS.$i = $e" }
      $i++
    }
    if ($sanLines.Count -eq 0) { & $script:Fail "[gen_ca] san 解析后为空：$san" }
    $ext = @(
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = @alt_names",
      "[alt_names]"
    ) + $sanLines
    Set-Content -LiteralPath $srvExt -Value ($ext -join "`n") -Encoding ASCII

    & openssl req -new -key $srvKey -out $srvCsr -subj "/CN=$($san -split ',')[0]" 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { & $script:Fail "[gen_ca] 生成服务端 CSR 失败" }
    & openssl x509 -req -in $srvCsr -CA $caCrt -CAkey $caKey -CAcreateserial `
      -out $srvCrt -days $days -sha256 -extfile $srvExt 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { & $script:Fail "[gen_ca] 签发服务端证书失败" }
  }
} finally {
  Pop-Location
}

# ---- 产物校验：声明了几个就要真的存在几个 ----
foreach ($f in @($caCrt, $caKey, $srvCrt, $srvKey)) {
  if (-not (Test-Path -LiteralPath $f)) { & $script:Fail "[gen_ca] 声明产物未生成：$f" }
  if ((Get-Item -LiteralPath $f).Length -eq 0) { & $script:Fail "[gen_ca] 产物为空文件：$f" }
}

# 私钥权限收敛（仅当前用户可读写）
try {
  $acl = Get-Acl -LiteralPath $caKey
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "Read,Write", "None", "None", "Allow")
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $caKey -AclObject $acl
} catch { Write-Output "[gen_ca] 提示：私钥 ACL 收敛跳过（$($_.Exception.Message)）" }

$expiresAt = ((& openssl x509 -in $caCrt -noout -enddate 2>$null) -replace 'notAfter=','').Trim()
Write-Output "[gen_ca] 完成：CA=$caCrt 到期=$expiresAt"
Write-Output "CA_CERT_PATH=$caCrt"
Write-Output "SERVER_CERT_PATH=$srvCrt"
Write-Output "CA_EXPIRES_AT=$expiresAt"
exit 0
