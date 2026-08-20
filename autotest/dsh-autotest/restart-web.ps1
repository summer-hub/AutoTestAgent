# Restart dsh web with dsh-autotest plugin (ASCII only, PS5.1 compatible).
# Status log and dsh run log are separated so polling never conflicts with
# the dsh process's own output redirect. Kills the 3080 listener tree, starts
# a hidden `dsh --profile web`, then polls /api/autotest/health until ready.
$ErrorActionPreference = 'Stop'
$statusLog = "D:\code\HarmonyProject\20260604\AutoTestAgent\autotest\dsh-autotest\restart-status.log"
$runLog    = "D:\code\HarmonyProject\20260604\AutoTestAgent\autotest\dsh-autotest\dsh-web-run.log"

"=== restart at $(Get-Date) ===" | Out-File $statusLog -Encoding utf8

$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    "killing PID $($conn.OwningProcess)" | Out-File $statusLog -Append -Encoding utf8
    taskkill /PID $conn.OwningProcess /T /F 2>&1 | Out-File $statusLog -Append -Encoding utf8
} else {
    "no listener on 3080" | Out-File $statusLog -Append -Encoding utf8
}
Start-Sleep -Seconds 4

$proc = Start-Process -FilePath "powershell.exe" -ArgumentList '-NoProfile','-Command',"dsh --profile web *> '$runLog' 2>&1" -WindowStyle Hidden -PassThru
"new web pid: $($proc.Id)" | Out-File $statusLog -Append -Encoding utf8

for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod http://localhost:3080/api/autotest/health -TimeoutSec 3
        "health ok: $($h | ConvertTo-Json -Compress)" | Out-File $statusLog -Append -Encoding utf8
        "RESTART_OK" | Out-File $statusLog -Append -Encoding utf8
        exit 0
    } catch { }
}
"RESTART_FAIL: no health after 120s" | Out-File $statusLog -Append -Encoding utf8
exit 1
