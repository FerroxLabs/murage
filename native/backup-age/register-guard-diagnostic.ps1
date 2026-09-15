$ErrorActionPreference = 'Stop'
$scratch = 'C:\Users\seand\AppData\Local\Temp\murage-b20-native-20260913-103710'
$taskName = 'Murage-B20-GuardDiagnostic-20260913-115706'
if ((Get-CimInstance Win32_ComputerSystem).UserName -ne 'SeanDesktop\seand') { throw 'Expected interactive account unavailable' }
if (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Task already exists' }
if (Test-Path "$scratch\guard-diagnostic-invoked.txt") { throw 'Diagnostic already invoked; no replay' }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}\native-probe.exe'' --guard-diagnostic *> ''{0}\guard-diagnostic.log''; exit $LASTEXITCODE"' -f $scratch
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $scratch
$principal = New-ScheduledTaskPrincipal -UserId 'SeanDesktop\seand' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject (New-ScheduledTask -Action $action -Principal $principal -Settings $settings) | Out-Null
Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath "$scratch\guard-diagnostic-task.xml"
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath "$scratch\guard-diagnostic-invoked.txt"
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
[pscustomobject]@{task=$taskName;startedUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
