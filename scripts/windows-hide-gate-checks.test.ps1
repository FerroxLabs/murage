$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-hide-gate-checks.ps1')
$script:passed = 0
function Accept([scriptblock]$Action) { & $Action; $script:passed++ }
function Reject([scriptblock]$Action) { $rejected=$false; try { & $Action } catch { $rejected=$true }; if (-not $rejected) { throw 'Expected rejection' }; $script:passed++ }
$desktop = @{session=1;activeSession=1;inputDesktop='Default';threadDesktop='Default';windowStation='WinSta0'}
Accept { Assert-WindowsHideDesktop $desktop }
foreach ($entry in @(@('session',0),@('activeSession',2),@('activeSession',[uint32]::MaxValue),@('inputDesktop','Winlogon'),@('threadDesktop','Other'),@('windowStation','Service'))) {
  $bad=$desktop.Clone();$bad[$entry[0]]=$entry[1];Reject { Assert-WindowsHideDesktop $bad }
}
$control=@{seen=$true;closed=$true;samples=1;observations=@('visible ConsoleWindowClass');errors=@()}
Accept { Assert-WindowsHideControl $control }
foreach ($key in @('seen','closed','samples','observations','errors')) {
  $bad=$control.Clone();switch($key) { 'samples' {$bad[$key]=0}; 'observations' {$bad[$key]=@()}; 'errors' {$bad[$key]=@('enumeration failed')}; default {$bad[$key]=$false} }
  Reject { Assert-WindowsHideControl $bad }
}
"P2-3 desktop/control: $script:passed passed"
$script:passed=0
$root=Join-Path ([IO.Path]::GetTempPath()) ('hide-manifest-'+[Guid]::NewGuid().ToString('N'))
try {
 New-Item -ItemType Directory -Path (Join-Path $root 'resources/server/nested'),(Join-Path $root 'resources/ui') -Force | Out-Null
 $commit='a'*40
 $paths=@('Murage.exe','resources/app.asar','resources/server/index.js','resources/server/nested/worker.js','resources/ui/build-commit.json')
 foreach($path in $paths) {[IO.File]::WriteAllText((Join-Path $root $path),'fixture')}
 [IO.File]::WriteAllText((Join-Path $root 'resources/ui/build-commit.json'),('{"commit":"'+$commit+'"}'))
 $manifest=@{schema=1;commit=$commit;files=@($paths|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $root $_)).Hash.ToLowerInvariant()}})}
 $manifestPath=Join-Path $root 'resources/windows-hide-package-manifest.json'
 function Save { $manifest|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $manifestPath }
 function Check { Assert-WindowsHideManifest (Join-Path $root 'Murage.exe') $commit (Join-Path $root 'retained.json') | Out-Null }
 Save;Accept {Check}
 if([IO.File]::ReadAllText($manifestPath) -cne [IO.File]::ReadAllText((Join-Path $root 'retained.json'))) {throw 'Retained manifest bytes differ'}
 Accept {if(-not (Test-Path (Join-Path $root 'retained.json'))) {throw 'No receipt'}}
 Reject {Assert-WindowsHideManifest (Join-Path $root 'Murage.exe') ('b'*40) (Join-Path $root 'retained.json')}
 foreach($path in $paths) {
  $file=Join-Path $root $path;$old=[IO.File]::ReadAllText($file);[IO.File]::WriteAllText($file,'tampered');Reject {Check};[IO.File]::WriteAllText($file,$old)
 }
 $all=$manifest.files;$manifest.files=@($all|Select-Object -Skip 1);Save;Reject {Check};$manifest.files=$all
 $manifest.files=$all+@($all[0]);Save;Reject {Check};$manifest.files=$all
 $manifest.commit='b'*40;Save;Reject {Check};$manifest.commit=$commit;Save
 [IO.File]::WriteAllText((Join-Path $root 'resources/server/extra.js'),'new unlisted entry');Reject {Check}
} finally { if($root) {Remove-Item -LiteralPath $root -Recurse -Force} }
"P2-4 manifest: $script:passed passed"
# Parse all shipped/test PowerShell and compile the actual observer's C#.
foreach($name in @('windows-hide-desktop-gate.ps1','windows-hide-gate-checks.ps1','windows-hide-gate-checks.test.ps1','windows/scenario-common.ps1','windows/console-observer.ps1','windows/owned-process.ps1','windows/windows-hide-gate-checks.ps1')) {
 $tokens=$null;$errors=$null
 [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
 if($errors.Count) {throw ($errors|Out-String)}
}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows/owned-process.ps1') -Raw
$source=$source.Substring($source.IndexOf('function Initialize-ConsoleObserver'))
$match=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if(-not $match.Success) {throw 'Observer C# not found'}
Add-Type -TypeDefinition $match.Groups[1].Value
'PowerShell: 7 parses, 1 observer C# compilation passed (Win32 calls not executed)'
