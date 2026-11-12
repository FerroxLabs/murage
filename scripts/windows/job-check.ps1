# Internal helper: inspect only the tree of the supplied owned app PID.
param([ValidateSet('Snapshot','AssertStopped')][string]$Mode,[int]$RootPid,[string]$File)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($Mode -eq 'Snapshot') {
 $all=@(Get-CimInstance Win32_Process)
 $ids=New-Object 'System.Collections.Generic.HashSet[int]'
 [void]$ids.Add($RootPid)
 do {
  $before=$ids.Count
  foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)}}
 }while($ids.Count -gt $before)
 $owned=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {@{pid=[int]$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('O');path=$_.ExecutablePath}})
 if($owned.Count -lt 2){throw 'Could not observe packaged app descendants'}
 $owned | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $File -Encoding UTF8
 return
}
$owned=@(Get-Content -LiteralPath $File -Raw | ConvertFrom-Json)
$deadline=[DateTime]::UtcNow.AddSeconds(30)
do {
 $alive=@(foreach($p in $owned){$now=Get-CimInstance Win32_Process -Filter "ProcessId = $($p.pid)";if($now -and $now.CreationDate.ToUniversalTime().ToString('O') -eq $p.created){$now}})
 if(-not $alive.Count){return};Start-Sleep -Milliseconds 250
}while([DateTime]::UtcNow -lt $deadline)
throw 'Owned app descendants survived shutdown'
