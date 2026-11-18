# Container-only behavior tests. No Windows native APIs or live scheduler.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'owned-process.ps1')
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
function Must-Fail([scriptblock]$Action,[string]$Label) {
  $failed=$false;try{Invoke-LinuxFixtureCallback -Callback $Action}catch{$failed=$true}
  if(-not $failed){throw "Expected rejection: $Label"}
  "PASS $Label"
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('winscen-safety-'+[Guid]::NewGuid().ToString('N'))
$outside=Join-Path ([IO.Path]::GetTempPath()) ('winscen-outside-'+[Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path (Join-Path $root 'runs'),$outside | Out-Null
  $link=Join-Path $root 'runs/junction'
  # Linux symlink and Windows junction both expose FileAttributes.ReparsePoint.
  # The Windows Junction variant is supplied separately for MAIN; never run here.
  New-Item -ItemType SymbolicLink -Path $link -Target $outside | Out-Null
  Must-Fail {Assert-GatePath (Join-Path $link 'new-file') $root} 'reparse ancestor under runs'
  Must-Fail {Assert-GatePath $outside $root} 'outside root'
  if((Assert-GatePath (Join-Path $root 'runs/new-file') $root) -ne (Join-Path $root 'runs/new-file')){throw 'fresh contained path refused'}
  'PASS fresh contained path'
  # Load the production publication function alone, without the Windows driver.
  . (Join-Path $PSScriptRoot 'sentinel-scenario.ps1') -DefineOnly
  $evidence=Join-Path $root 'evidence';New-Item -ItemType Directory -Path $evidence | Out-Null
  $physicalGuard=${function:Assert-GatePath}
  function Assert-GatePath([string]$Path) { Invoke-LinuxFixtureCallback -Callback $physicalGuard -Arguments @($Path,$root) }
  $viewFile=Join-Path $root 'view.json'
  @{summary=@{scanner='running';lastCheckedAt=100}} | ConvertTo-Json | Set-Content -LiteralPath $viewFile
  Must-Fail {Await-Publication $viewFile 100 'stale' 0} 'stale publication after successful scheduler exit'
  @{summary=@{scanner='running';lastCheckedAt=102}} | ConvertTo-Json | Set-Content -LiteralPath $viewFile
  if((Await-Publication $viewFile 101 'fresh' 0) -ne 102){throw 'fresh publication not accepted'}
  'PASS publication newer than tested run start'
  . (Join-Path $PSScriptRoot 'gate-admission.ps1')
  Must-Fail {Assert-GateAdmission} 'direct launch without ownership context refused'
} finally {
  if($root -and (Test-Path -LiteralPath $root)){Remove-Item -LiteralPath $root -Recurse -Force}
  if($outside -and (Test-Path -LiteralPath $outside)){Remove-Item -LiteralPath $outside -Recurse -Force}
}
