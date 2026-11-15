# Linux-only syntax/schema check. This never invokes the Windows scripts.
# Run pwsh inside the job's it-remote.sh container, not on a Desktop PC.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Write-Output ("PowerShell " + $PSVersionTable.PSVersion.ToString() + "; .NET " + [Environment]::Version.ToString())
$files = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)
$files += Get-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'windows-hide-desktop-gate.ps1')
foreach ($file in $files) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "Parse failed: $($file.Name): $($errors -join '; ')" }
  Write-Output "PARSE $($file.Name)"
}
# Compile the embedded C# on Linux without calling a Windows native method.
. (Join-Path $PSScriptRoot 'owned-process.ps1')
Initialize-OwnedProcess
foreach ($case in @(
  @('', '""'),
  @('plain', '"plain"'),
  @('C:\space here\', '"C:\space here\\"'),
  @('a"b', '"a\"b"')
)) {
  if ((ConvertTo-WindowsArgument $case[0]) -cne $case[1]) { throw "Windows argument quoting failed: $($case[0])" }
}
Write-Output 'QUOTING empty, plain, spaced/trailing backslash and embedded quote'
$schema = Join-Path $PSScriptRoot 'receipt.schema.json'
$valid = @{
  cleanup=@{writer='operator';pid=1;childPid=2;prefix=('MurageCI-'+('a'*32)+'-');completedAt=1;finalizedAt=2;job=@{ownerClosed=$true;empty=$true;flags=8192;remaining=@()};processes=@{ok=$true;escaped=@();enrolled=@();browsers=@()};tasks=@{before=@();after=@();added=@();changed=@();removed=@();deleted=@();remaining=@();errors=@();ok=$true};launcher=@{before=@();after=@();added=@();changed=@();removed=@();deleted=@();remaining=@();errors=@();ok=$true};registrations=$null}
  fixture='C:\murage-ci\runs\winhide-test'; executable='C:\murage-ci\app\Murage.exe'
  isolated=$true; fakeProvidersOnly=$true; kind='desktop';machine='gate-win-desktop';commit=('a'*40);sha256=('b'*64);candidateVersion='1.0.19';updateVersion='1.0.190';updateSha256=('c'*64);user='desktop';observer=@{startedAt=100;stoppedAt=900;finalGapMs=250;controls=@(@{group='mcp';edge='start';at=200;detected=$true},@{group='mcp';edge='end';at=800;detected=$true});samples=8;maxGapMs=251;visible=@();enumerationErrors=@()}
  packageSha256=('e'*64);appManifest=@(@{path='Murage.exe';sha256=('b'*64)},@{path='resources/app.asar';sha256=('f'*64)},@{path='resources/build-provenance.json';sha256=('a'*64)})
  groups=@(@('bot-turns','tools','sentinel','updates-isolated','mcp','browser') | ForEach-Object {
    @{ name=$_;startedAt=300;endedAt=700; passed=3; failed=0; skipped=0; artifacts=@("evidence/$_.json") }
  })
}
function Assert-Schema([object]$Value, [bool]$Expected, [string]$Case) {
  $json = $Value | ConvertTo-Json -Depth 10
  $actual = Test-Json -Json $json -SchemaFile $schema -ErrorAction SilentlyContinue
  if ($actual -ne $Expected) { throw "Schema case failed: $Case (expected $Expected, got $actual)" }
  Write-Output "SCHEMA $Case"
}
function Copy-Receipt { $valid | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable }
Assert-Schema $valid $true 'six complete groups'
foreach ($name in @('bot-turns','tools','sentinel','updates-isolated','mcp','browser')) {
  $r = Copy-Receipt; $r.groups = @($r.groups | Where-Object { $_.name -ne $name })
  Assert-Schema $r $false "missing $name"
}
$r = Copy-Receipt; $r.groups[0].name = 'tools'; Assert-Schema $r $false 'duplicate name'
$r = Copy-Receipt; $r.groups += $r.groups[0]; Assert-Schema $r $false 'extra group'
$r = Copy-Receipt; $r.groups[0].name = 'unknown'; Assert-Schema $r $false 'unknown group'
foreach ($field in @('isolated','fakeProvidersOnly')) {
  $r = Copy-Receipt; $r[$field] = $false; Assert-Schema $r $false "$field false"
  $r = Copy-Receipt; $r[$field] = 'true'; Assert-Schema $r $false "$field string"
}
foreach ($field in @('failed','skipped')) {
  $r = Copy-Receipt; $r.groups[0][$field] = 1; Assert-Schema $r $false "$field nonzero"
}
foreach ($count in @(0,-1,0.5,'1')) {
  $r = Copy-Receipt; $r.groups[0].passed = $count; Assert-Schema $r $false "bad passed $count"
}
foreach ($artifact in @('../escape.json','evidence/../../escape.json','C:\outside.json','\\server\share\x','/absolute.json','evidence/./x','evidence/x:stream','')) {
  $r = Copy-Receipt; $r.groups[0].artifacts = @($artifact); Assert-Schema $r $false "unsafe artifact $artifact"
}
$r = Copy-Receipt; $r.groups[0].artifacts = @(); Assert-Schema $r $false 'no artifact'
$r = Copy-Receipt; $r.groups[0].artifacts = @('evidence/mcp.json','evidence/mcp.json'); Assert-Schema $r $false 'duplicate artifact'
$r = Copy-Receipt; $r.groups[0].Remove('passed'); Assert-Schema $r $false 'missing assertion count'
# Handoff has exactly one group, default profile, and the provisioned account.
$r=Copy-Receipt;$r.kind='handoff';$r.machine='gate-win-nogit';$r.isolated=$false;$r.user='murage-gate';$r.groups=@(@{name='updates-handoff';startedAt=300;endedAt=700;passed=7;failed=0;skipped=0;artifacts=@('evidence/updates-handoff.json')})
Assert-Schema $r $true 'handoff complete'
$r.isolated=$true;Assert-Schema $r $false 'handoff custom profile'
$r.isolated=$false;$r.user='owner';Assert-Schema $r $false 'handoff owner account'
$r=Copy-Receipt;$r.updateVersion='1.0.19-gate.1';Assert-Schema $r $false 'prerelease refused'
Test-OwnedNativeCompilation
Write-Output 'CSHARP owned-process, console-observer, visible-control, task-bridge: compiled only'
Write-Output 'PASS Linux dry check: syntax, C# compilation and receipt schema only; no Windows workflow executed'
