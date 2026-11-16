[CmdletBinding()]
param([ValidateSet('Open','Closed','Cleanup')][string]$Mode,[string]$Fixture,[string]$Executable,[switch]$DefineOnly)
function Owned-Descriptors {
  if (-not (Test-Path -LiteralPath $base)) { return @() }
  @(Get-ChildItem -LiteralPath $base -Filter descriptor.json -Recurse -File | Where-Object {
    $d=Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    # Bound to the fixture's data directory, including after the handoff changes executable path.
    $d.installationRoot -eq $expectedData
  })
}
function Await-Run($Task,[datetime]$After) {
  $deadline=[DateTime]::Now.AddSeconds(75)
  do {
    Start-Sleep -Milliseconds 250
    if($Task.LastRunTime -gt $After -and $Task.State -ne 4) {
      if($Task.LastTaskResult -ne 0){throw "Scanner exit $($Task.LastTaskResult)"}
      return $Task.LastRunTime
    }
  }while([DateTime]::Now -lt $deadline)
  throw 'No successful scheduler run before deadline'
}
function Publication-Time([string]$File) {
  if(-not (Test-Path -LiteralPath $File)){return 0L}
  [void](Assert-GatePath $File)
  $value=(Get-Content -LiteralPath $File -Raw | ConvertFrom-Json).summary.lastCheckedAt
  if($null -eq $value){return 0L}
  return [long]$value
}
function Await-Publication([string]$File,[long]$After,[string]$Label,[int]$TimeoutSeconds=20) {
  $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    [void](Assert-GatePath $File)
    $view=Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    if($view.summary.scanner -ne 'running' -or $view.summary.lastCheckedAt -le $After){Start-Sleep -Milliseconds 250;continue}
    $publication=@{after=$After;lastCheckedAt=$view.summary.lastCheckedAt;view=$view}
    $publication | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $evidence ('sentinel-publication-'+$Label+'.json')) -Encoding UTF8
    return [long]$view.summary.lastCheckedAt
  }while([DateTime]::UtcNow -lt $deadline)
  throw 'Scheduler completed without a fresh publication for this run'
}
if($DefineOnly){return}
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
if($Mode -ne 'Cleanup'){Assert-GateAdmission}
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
foreach($path in @($Fixture,$Executable,$env:LOCALAPPDATA)){[void](Assert-GatePath $path)}
. (Join-Path $PSScriptRoot 'owned-process.ps1')
$service=New-Object -ComObject 'Schedule.Service'
$service.Connect()
$evidence=Join-Path $Fixture 'evidence'
$record=Join-Path $Fixture 'sentinel-owned.json'
$base=Join-Path $env:LOCALAPPDATA 'MurageSentinel'
$expectedData=if($env:MURAGE_DATA_DIR){$env:MURAGE_DATA_DIR}else{Join-Path $env:USERPROFILE '.murage'}
if($Mode -eq 'Cleanup'){throw 'Only the outer snapshot finalizer may delete tasks'}
$deadline=[DateTime]::Now.AddSeconds(90)
do {
  $files=@(Owned-Descriptors)
  if($files.Count -eq 1){break}
  Start-Sleep -Milliseconds 250
}while([DateTime]::Now -lt $deadline)
if($files.Count -ne 1){throw 'Expected one fixture-owned Sentinel descriptor'}
$descriptor=$files[0].FullName
$d=Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
if($d.executable.path -ne $Executable){throw 'Descriptor must name packaged executable'}
if(-not $d.executable.entry.StartsWith($files[0].DirectoryName+'\runtime\',[StringComparison]::OrdinalIgnoreCase)){throw 'Scanner entry escaped owned runtime'}
if((Get-FileHash -LiteralPath $d.executable.entry -Algorithm SHA256).Hash -ne $d.executable.sha256){throw 'Scanner entry digest mismatch'}
$name='\FerroxLabs\Murage\Sentinel\'+$env:MURAGE_GATE_RUN_PREFIX+$files[0].Directory.Name
$task=$service.GetFolder('\').GetTask($name)
[xml]$xml=$task.Xml
if($xml.Task.Actions.Exec.Command -ne $env:MURAGE_GATE_TASK_HELPER -or $xml.Task.Actions.Exec.Arguments -notlike '*--murage-sentinel-scan*' -or $xml.Task.Actions.Exec.Arguments -notlike "*$descriptor*"){throw 'Task does not invoke packaged scheduler entry'}
if($xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or $xml.Task.Triggers.LogonTrigger.Repetition.Interval -ne 'PT2M'){throw 'Wrong production schedule'}
$clone=$env:MURAGE_GATE_RUN_PREFIX+'sentinel-'+[Guid]::NewGuid().ToString('N')
@{names=@($name,$clone)} | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding UTF8
$task.Xml | Set-Content -LiteralPath (Join-Path $evidence 'sentinel-task.xml') -Encoding UTF8
$viewFile=Join-Path $files[0].DirectoryName 'view.json'
$beforePublication=Publication-Time $viewFile
$startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$before=$task.LastRunTime
[void]$task.Run($null)
$ran=Await-Run $task $before
$manualPublication=Await-Publication $viewFile ([Math]::Max($startedAt,$beforePublication)) ($Mode.ToLowerInvariant()+'-manual')
Copy-Item -LiteralPath $viewFile -Destination (Join-Path $evidence ('sentinel-view-'+$Mode.ToLowerInvariant()+'.json'))
if($Mode -eq 'Open') {
  @{descriptor=$descriptor;entry=$d.executable.entry;task=$name;lastTaskResult=$task.LastTaskResult;lastRunTime=$ran.ToString('O');app='open'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'sentinel-open.json') -Encoding UTF8
  return
}
# Use the exact packaged task action under a gate-owned real time trigger. No /Run on this task.
# A newly registered production LogonTrigger cannot repeat until the next logon.
$ns=New-Object Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('t',$xml.DocumentElement.NamespaceURI)
$triggers=$xml.SelectSingleNode('/t:Task/t:Triggers',$ns)
$triggers.RemoveAll()
$trigger=$xml.CreateElement('TimeTrigger',$xml.DocumentElement.NamespaceURI)
$trigger.InnerXml='<Repetition xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Interval>PT1M</Interval><Duration>PT4M</Duration><StopAtDurationEnd>true</StopAtDurationEnd></Repetition><StartBoundary xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'+[DateTime]::Now.AddSeconds(10).ToString('yyyy-MM-ddTHH:mm:ss')+'</StartBoundary><Enabled xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">true</Enabled>'
[void]$triggers.AppendChild($trigger)
$xml.Task.RegistrationInfo.URI='\'+$clone
$xml.OuterXml | Set-Content -LiteralPath (Join-Path $evidence 'sentinel-recurring.xml') -Encoding UTF8
$recurring=$null
try {
  $recurring=$service.GetFolder('\').RegisterTask($clone,$xml.OuterXml,2,$null,$null,3,$null)
  $first=Await-Run $recurring ([DateTime]::Now.AddSeconds(-1))
  $firstPublication=Await-Publication $viewFile ([Math]::Max($manualPublication,([DateTimeOffset]$first).ToUnixTimeMilliseconds())) 'recurring-1'
  $second=Await-Run $recurring $first
  $secondPublication=Await-Publication $viewFile ([Math]::Max($firstPublication,([DateTimeOffset]$second).ToUnixTimeMilliseconds())) 'recurring-2'
  @{descriptor=$descriptor;task=$name;closedManualRun=$ran.ToString('O');recurringTask=$clone;recurringRuns=2;publications=@($firstPublication,$secondPublication);times=@($first.ToString('O'),$second.ToString('O'));lastTaskResult=$recurring.LastTaskResult;app='closed'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'sentinel-closed.json') -Encoding UTF8
} finally {
  # Disable only; outer finalizer proves idle and deletes against its baseline.
  if($null -ne $recurring){$recurring.Enabled=$false}
}
