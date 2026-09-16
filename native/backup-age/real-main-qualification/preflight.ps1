param([Parameter(Mandatory=$true)][string]$Parent,[Parameter(Mandatory=$true)][string]$NodeExecutable,[switch]$ResumeAfterCompilerEnvironmentCorrection)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=Join-Path $Parent 'real-main-qualification'
$result=[ordered]@{startedUtc=[DateTime]::UtcNow.ToString('o');parsed=@();jobInstantiated=$false;appLaunched=$false;seedRoot=$root}
$suffix=''
if($ResumeAfterCompilerEnvironmentCorrection) {
  $previous=Get-Content -LiteralPath (Join-Path $Parent 'preflight-result.json') -Raw | ConvertFrom-Json
  if($previous.ok -or $previous.failure -ne 'The system cannot find the path specified' -or (Test-Path -LiteralPath $root)) {throw 'Compiler-environment correction precondition absent'}
  $suffix='-r2';$result.reusedUnchangedParser='dialogs.ps1';$result.fixtureCorrections=1
}
if(Test-Path -LiteralPath (Join-Path $Parent "preflight-invoked$suffix.txt")){throw 'Preflight invocation already exists'}
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath (Join-Path $Parent "preflight-invoked$suffix.txt")
$previousTemp=$env:TEMP;$previousTmp=$env:TMP
try {
  foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    if($ResumeAfterCompilerEnvironmentCorrection -and $file.Name -eq 'dialogs.ps1'){continue}
    $tokens=$null;$errors=$null
    $null=[System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw ($errors | Out-String)}
    $result.parsed+=@{file=$file.Name;errors=0}
  }
  $compilerTemp=Join-Path $Parent 'compiler-temp'
  [IO.Directory]::CreateDirectory($compilerTemp) | Out-Null
  $env:TEMP=$compilerTemp;$env:TMP=$compilerTemp
  Add-Type -Path (Join-Path $PSScriptRoot 'OwnedJob.cs')
  $result.csharpCompiled=$true
  $version=(& $NodeExecutable --version | Out-String).Trim()
  if($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.') {throw 'Existing Node24 required'}
  $result.nodeVersion=$version
  foreach($name in @('seed.bundled.mjs','seed-check.mjs','verify.mjs')) {
    & $NodeExecutable --check (Join-Path $PSScriptRoot $name)
    if($LASTEXITCODE -ne 0){throw "JavaScript syntax failed: $name"}
  }
  & $NodeExecutable (Join-Path $PSScriptRoot 'seed.bundled.mjs') $root
  if($LASTEXITCODE -ne 0){throw 'Synthetic seed failed'}
  & $NodeExecutable (Join-Path $PSScriptRoot 'seed-check.mjs') $root
  if($LASTEXITCODE -ne 0){throw 'Synthetic seed verification failed'}
  $result.seed=Get-Content -LiteralPath (Join-Path $root 'evidence\seed-preflight.json') -Raw | ConvertFrom-Json
  $result.hashes=@(Get-ChildItem -LiteralPath $PSScriptRoot -File | ForEach-Object {@{file=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
  $result.ok=$true
} catch {$result.ok=$false;$result.failure=$_.Exception.Message;$result.failureDetail=$_.ToString()}
finally {$env:TEMP=$previousTemp;$env:TMP=$previousTmp}
$result.finishedUtc=[DateTime]::UtcNow.ToString('o')
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Parent "preflight-result$suffix.json")
$result | ConvertTo-Json -Depth 8
if(!$result.ok){exit 1}
