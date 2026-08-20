$log = "D:\code\HarmonyProject\20260604\AutoTestAgent\autotest\dsh-autotest\ps51-test.log"
"=== ps51 test at $(Get-Date) ===" | Out-File $log -Encoding utf8
"write ok" | Out-File $log -Append -Encoding utf8
