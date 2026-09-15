$ErrorActionPreference = 'Stop'
$scratch = 'C:\Users\seand\AppData\Local\Temp\murage-b20-dirguard-20260913-154251'
$taskName = 'Murage-B20-AgeQualification-20260913-155151'
if ((Get-CimInstance Win32_ComputerSystem).UserName -ne 'SeanDesktop\seand') { throw 'Expected interactive account unavailable' }
if (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Task already exists' }
if (Test-Path "$scratch\age-qualification-invoked.txt") { throw 'Already invoked' }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}\native-probe.exe'' --limited-session *> ''{0}\age-qualification.log''; exit $LASTEXITCODE"' -f $scratch
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $scratch
$principal = New-ScheduledTaskPrincipal -UserId 'SeanDesktop\seand' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject (New-ScheduledTask -Action $action -Principal $principal -Settings $settings) | Out-Null
Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath "$scratch\age-qualification-task.xml"
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath "$scratch\age-qualification-invoked.txt"
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
[pscustomobject]@{task=$taskName;startedUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
