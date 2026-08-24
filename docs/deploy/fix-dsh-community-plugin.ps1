# Fix DSH "Failed to load plugins":
# @linxin666/dsh-web-ui-all 0.3.3 registers dsh-client-ui-community-plugins
# (data-only package, no client build) as a client plugin, so the browser
# requests /plugins/@linxin666/dsh-client-ui-community-plugins/client.js -> 404.
# Run this after every pnpm install, then fully restart DSH.
# Impact: only disables the community plugin store data source; AutoTest,
# task board, SSH etc. are unaffected.

$ErrorActionPreference = 'Stop'

# 支持 --profile web 指定 profile；默认 web
$profileName = 'web'
if ($args.Count -gt 0 -and $args[0] -eq '--profile') { $profileName = $args[1] }

$patchFile = Join-Path $env:USERPROFILE ".dsh\profiles\$profileName\node_modules\@linxin666\dsh-web-ui-all\cordis.patch.yml"
if (-not (Test-Path $patchFile)) {
  Write-Host "patch file not found: $patchFile (install @linxin666/dsh-web-ui-all first)" -ForegroundColor Yellow
  exit 1
}

$content = Get-Content $patchFile -Raw
if ($content -match '# \[disabled\] .*community-plugins') {
  Write-Host 'Already patched, nothing to do.' -ForegroundColor Green
  exit 0
}

# backup
Copy-Item $patchFile "$patchFile.bak" -Force

# comment out the whole community-plugins registration block (comment line + insert + id + name)
$lines = Get-Content $patchFile
$inBlock = $false
$out = for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^# from \.\./dsh-community-plugins') {
    $inBlock = $true
    "# [disabled] $($lines[$i])"
  } elseif ($inBlock) {
    if ($lines[$i] -match '^# from ') {
      # next block starts
      $inBlock = $false
      $lines[$i]
    } elseif ($lines[$i].Trim() -eq '') {
      $inBlock = $false
      $lines[$i]
    } else {
      "# [disabled] $($lines[$i])"
    }
  } else {
    $lines[$i]
  }
}
$out | Set-Content $patchFile -Encoding utf8

Write-Host "Disabled community-plugins client registration: $patchFile" -ForegroundColor Green
Write-Host 'Fully restart DSH (kill dsh process, then dsh --profile web) to verify.'
