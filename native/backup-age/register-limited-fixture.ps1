$ErrorActionPreference = 'Stop'
$scratch = 'C:\Users\seand\AppData\Local\Temp\murage-b20-native-20260913-103710'
$taskName = 'Murage-B20-Limited-20260913-113648'
$account = 'SeanDesktop\seand'
if ((Get-CimInstance Win32_ComputerSystem).UserName -ne $account) { throw 'Expected interactive account is unavailable' }
if (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Task already exists; do not adopt/replay' }
if (Test-Path "$scratch\limited-task-invoked.txt") { throw 'Invocation already recorded; no replay' }
if (!(Test-Path "$scratch\native-probe.exe")) { throw 'Fixture binary missing' }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}\native-probe.exe'' --limited-session *> ''{0}\limited-session.log''; exit $LASTEXITCODE"' -f $scratch
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $scratch
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $task | Out-Null
Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath "$scratch\limited-task.xml"
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath "$scratch\limited-task-invoked.txt"
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
[pscustomobject]@{task=$taskName;account=$account;runLevel='Limited';logon='Interactive';startedUtc=[DateTime]::UtcNow.ToString('o');scratch=$scratch} | ConvertTo-Json -Compress
