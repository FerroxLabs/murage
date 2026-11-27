# Linux driver harness for run-on-windows.ps1 (ASTRA ps1-reparse 5cdb72c73a: M14 and M6a receipts): pwsh 7, --network none.
# The native driver's own functions (Checks, Failed, Edit-File, Set-Mutant, Test-Refusal, Test-StopPending, Mutant), its
# op here-strings and its 'Mutant M14'/'Mutant M6a' statements are taken from run-on-windows.ps1 unchanged and run here.
# qualification-run.ps1 and the PowerShell lease wrappers of qualification-paths.ps1 run unchanged. Only the OS layer is a
# model: the kernel32 lease (a held path or ancestor refuses a rename/write/delete with 32; Close releases it; CREATE_NEW
# fails on an existing name; CheckAbsent refuses only while the tree's C# CheckAbsent still has its refusal statement),
# and the recorder scheduler on a fake clock. Native behaviour itself is proved only by run-on-windows.ps1 on Windows.
# Usage: pwsh -File native-driver-harness.ps1 -Tree <repo root>
param([string]$Tree)
$ErrorActionPreference='Stop'
if(!$Tree){throw 'usage: -Tree <repo root>'}
$Tree=(Resolve-Path -LiteralPath $Tree).Path
$pwsh=(Get-Process -Id $PID).Path
$work=Join-Path ([IO.Path]::GetTempPath()) ('wrp-driver-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$Out=Join-Path $work 'out'; New-Item -ItemType Directory -Path $Out | Out-Null
$Repo=$Tree; $rmqName='real-main-qualification'; $HostExe=$pwsh
$results=[Collections.Generic.List[object]]::new()
$account='Fixture Person'; $sid=('S-1-5','21','1001','2002','3003','1001' -join '-')

# ---- The driver under test, from the tree's run-on-windows.ps1.
$driver=Join-Path $Tree "native/backup-age/$rmqName/witnesses/run-on-windows.ps1"
$perr=$null; $ast=[Management.Automation.Language.Parser]::ParseFile($driver,[ref]$null,[ref]$perr)
if($perr){ throw ('driver parse error: '+$perr[0].Message) }
foreach($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'Checks','Failed','Edit-File','Set-Mutant','Test-Refusal','Test-StopPending','Get-TreeManifest','Sha','Mutant' },$true)) { . ([scriptblock]::Create($f.Extent.Text)) }
foreach($a in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -in '$swapOps','$watchdogProbe' },$false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$mutantStatements=@{}
foreach($c in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Mutant' -and $n.CommandElements.Count -gt 1 },$true)) { $mutantStatements[$c.CommandElements[1].Extent.Text.Trim("'")]=$c.Extent.Text }

# ---- OS layer for the driver (Windows sandbox, work tree copy, journey launch).
function Row([string]$Id,[string]$Status,[string]$Detail){ $results.Add([pscustomobject]@{id=$Id;status=$Status;detail=$Detail}); Write-Host ('ROW {0} {1} {2}' -f $Status,$Id,$Detail) }
$editFile=${function:Edit-File}
function Edit-File([string]$Path,[string]$Old,[string]$New){ & $editFile ($Path -replace '\\','/') $Old $New }
function global:Get-CimInstance { param($ClassName,$Filter) return @() }
function New-Sandbox([string]$RunPs1) {
  $base=Join-Path $work ('wrp-'+[guid]::NewGuid().ToString('N').Substring(0,12))
  $profileRoot=Join-Path $base 'Users/fixture'
  $adm=Join-Path $profileRoot 'AppData/Local/Temp/murage-b20-real-main-20260914-025600'
  $app=Join-Path $adm 'candidate-d70fe5a145d0/app'
  New-Item -ItemType Directory -Force -Path (Join-Path $adm 'fixture'),(Join-Path $app 'resources'),(Join-Path $base 'outside') | Out-Null
  foreach($n in 'run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs','journey-entry.ps1'){ [IO.File]::WriteAllText((Join-Path $adm "fixture/$n"),"fixture $n") }
  [IO.File]::WriteAllText((Join-Path $app 'Murage.exe'),'synthetic exe'); [IO.File]::WriteAllText((Join-Path $app 'resources/app.asar'),'synthetic asar')
  return [pscustomobject]@{Base=$base;Profile=$profileRoot;Admitted=$adm;ManifestSha=('0'*64);Outside=(Join-Path $base 'outside')}
}
function Remove-Sandbox($Box){ if($Box){ Remove-Item -LiteralPath $Box.Base -Recurse -Force -ErrorAction SilentlyContinue } }
function New-WorkTree([string]$Mutant,[switch]$Recorder) {
  $w=Join-Path $work ('wrp-tree-'+[guid]::NewGuid().ToString('N'))
  Copy-Item -Recurse -LiteralPath (Join-Path $Repo 'native/backup-age') -Destination $w
  if($Mutant){ Set-Mutant $w $Mutant }
  return $w
}

# Child: the real qualification-run.ps1 and lease wrappers over the lease/scheduler model; journey admission as register-journey.ps1:50.
$model=@'
param([string]$Tree,[string]$Admitted,[string]$OpsFile,[string]$DeadlineUtc,[string]$Log)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
namespace MurageQualification { public class LeaseRefused : System.Exception { public LeaseRefused(string m) : base(m) {} } }
public static class WrpFs {
  public static bool LeaseOpen; public static string Admitted;
  static string N(string p) { return p.Replace('\\', '/'); }
  static void Guard(string p) { p = N(p); if (LeaseOpen && (p == Admitted || p.StartsWith(Admitted + "/") || Admitted.StartsWith(p + "/"))) throw new System.IO.IOException("sharing violation (lease model)", unchecked((int)0x80070020)); }
  public static void Move(string a, string b) { Guard(a); System.IO.Directory.Move(N(a), N(b)); }
  public static void WriteAllText(string p, string t) { Guard(p); System.IO.File.WriteAllText(N(p), t); }
  public static void Delete(string p) { Guard(p); System.IO.File.Delete(N(p)); }
}
public class ModelHeld { public string Relative, Name, Kind; public bool Used; }
// The lease model: same method names as MurageQualification.Lease, refusals thrown as LeaseRefused like the C# lease.
public class ModelLease {
  public static bool CheckAbsentRefuses;
  public string Admitted; public bool Closed;
  public System.Collections.Generic.List<ModelHeld> Items = new System.Collections.Generic.List<ModelHeld>();
  public System.Collections.Generic.HashSet<string> WorkNames = new System.Collections.Generic.HashSet<string>();
  string Full(string rel) { return Admitted + "/" + rel.Replace('\\', '/'); }
  static void Refuse(string m) { throw new MurageQualification.LeaseRefused(m); }
  public void CheckAbsent(string rel) { string f = Full(rel); if (CheckAbsentRefuses && (System.IO.File.Exists(f) || System.IO.Directory.Exists(f) || new System.IO.FileInfo(f).LinkTarget != null)) Refuse("Output name already exists: <admitted>\\" + rel); }
  public ModelHeld Reserve(string rel, bool taskLog) {
    try { new System.IO.FileStream(Full(rel), System.IO.FileMode.CreateNew).Dispose(); } catch (System.IO.IOException) { Refuse("Output name already exists: <admitted>\\" + rel); }
    ModelHeld item = new ModelHeld(); item.Relative = "<admitted>\\" + rel; item.Name = rel; item.Kind = taskLog ? "tasklog" : "output"; item.Used = taskLog; Items.Add(item); return item;
  }
  public void DeleteReserved(ModelHeld item) { System.IO.File.Delete(Full(item.Name)); Items.Remove(item); }
  public void DeleteTaskLog(ModelHeld item) { DeleteReserved(item); }
  public void Write(string rel, byte[] bytes) {
    if (Closed) Refuse("Not held: lease closed");
    ModelHeld item = Items.Find(x => x.Name == rel); if (item == null) Refuse("Not held: " + rel);
    System.IO.File.WriteAllBytes(Full(rel), bytes); item.Used = true;
  }
  public void Assert() { if (Closed) Refuse("Not held: lease closed"); }
  public void Dispose() { Closed = true; WrpFs.LeaseOpen = false; }
}
"@
$rmq=Join-Path $Tree 'real-main-qualification'
$paths=[IO.File]::ReadAllText((Join-Path $rmq 'qualification-paths.ps1'))
$perr=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($paths,[ref]$null,[ref]$perr)
foreach($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'Invoke-QualificationLeaseCall','Test-QualificationOutputs','Assert-QualificationLease','Reserve-QualificationOutputs','Write-QualificationOutput','Remove-QualificationOutputs','Close-QualificationLease' },$false)) { . ([scriptblock]::Create($f.Extent.Text)) }
# CheckAbsent refuses an existing name only while the tree's compiled C# CheckAbsent keeps its refusal (M6a removes it).
$i=$paths.IndexOf('public void CheckAbsent('); $j=$paths.IndexOf('public Held HoldExisting(',$i)
$global:CheckAbsentRefuses=$paths.Substring($i,$j-$i).Contains('throw new LeaseRefused("Output name already exists: " + Name(full));')
[WrpFs]::Admitted=$Admitted; [WrpFs]::LeaseOpen=$true
[ModelLease]::CheckAbsentRefuses=$global:CheckAbsentRefuses
$lease=[ModelLease]::new(); $lease.Admitted=$Admitted
# Recorder scheduler (run-on-windows.ps1 bootstrap semantics) on a fake clock; the action is a flag with a lifetime.
$global:Now=[DateTime]::UtcNow; $global:Calls=[Collections.Generic.List[string]]::new(); $global:Ops=@(); $global:Task=$null; $global:Running=$false
function global:Start-Sleep { param($Seconds,$Milliseconds) $global:Now=$global:Now.AddSeconds([double]$Seconds).AddMilliseconds([double]$Milliseconds) }
function global:Get-QualificationUtcNow { return $global:Now }
function global:WrpTick {
  if($global:Running -and $global:Now -ge $global:ActionEnd){ $global:Running=$false }
  if($global:StopAt) {
    if($OpsFile -and !$global:StopOpsRun){ $global:StopOpsRun=$true; $text=[IO.File]::ReadAllText($OpsFile) -replace '\[IO\.Directory\]::Move','[WrpFs]::Move' -replace '\[IO\.File\]::WriteAllText','[WrpFs]::WriteAllText' -replace '\[IO\.File\]::Delete','[WrpFs]::Delete'; foreach($op in @(& ([scriptblock]::Create($text)))){ $global:Ops+=('stop '+(& $op)) } }
    if($global:Now -ge $global:StopAt){ $global:Running=$false }
  }
}
function global:Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject) $global:Calls.Add('MUT register'); $global:Task=$InputObject }
function global:Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm) $global:Calls.Add('MUT unregister'); $global:Task=$null }
function global:Disable-ScheduledTask { param($TaskName,$TaskPath) $global:Calls.Add('MUT disable') }
function global:Export-ScheduledTask { param($TaskName,$TaskPath) return '<Task/>' }
function global:Start-ScheduledTask { param($TaskName,$TaskPath) $global:Calls.Add('MUT start'); $global:Running=$true; $global:Started=$true; $global:ActionEnd=$global:Now.AddSeconds([int]$env:WRP_ACTION_SECONDS) }
function global:Stop-ScheduledTask { param($TaskName,$TaskPath) $global:Calls.Add('MUT stop'); if($env:WRP_STOP_PENDING){ if(!$global:StopAt){ $global:StopAt=$global:Now.AddSeconds([int]$env:WRP_STOP_PENDING) }; return }; $global:Running=$false }
function global:Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) WrpTick; if(!$global:Task){ if($ErrorAction -eq 'SilentlyContinue'){return $null}; throw 'No MSFT_ScheduledTask objects found' }; return [pscustomobject]@{State=$(if($global:Running){'Running'}else{'Ready'})} }
function global:Get-ScheduledTaskInfo { param($TaskName,$TaskPath) return [pscustomobject]@{LastRunTime=$(if($global:Started){[DateTime]::Now}else{[DateTime]::MinValue});LastTaskResult=$(if($global:Started){0}else{267011})} }
function global:Get-QualificationTaskActionPid([string]$TaskName) { WrpTick; if($global:Running){return 4242}; return $null }
function global:Bind-QualificationInvocation($Job,[int]$ActionPid,[string]$Admitted) { return $true }
function global:New-QualificationJob { $j=[pscustomobject]@{}; $j | Add-Member ScriptMethod ActiveProcesses { if($global:Running){1}else{0} }; $j | Add-Member ScriptMethod Terminate { $global:Running=$false }; $j | Add-Member ScriptMethod Dispose {}; return $j }
. (Join-Path $rmq 'qualification-run.ps1')
$threw=$null; $res=$null
try {
  try { Test-QualificationOutputs $lease -Outputs @('journey-task.xml','journey-task-invoked.txt','journey-watchdog.txt','journey-lease.txt') -TaskLogs @('journey-console.log') } catch { Close-QualificationLease $lease; throw }
  $res=Invoke-QualificationLeasedTask -Lease $lease -TaskName 'Murage-B20-RealMain-20260914-025600' -Task ([pscustomobject]@{}) -Admitted $Admitted -XmlName 'journey-task.xml' -InvokedName 'journey-task-invoked.txt' -WatchdogName 'journey-watchdog.txt' -ReceiptName 'journey-lease.txt' -DeadlineUtc ([DateTime]::Parse($DeadlineUtc).ToUniversalTime()) -Correct $null -Started @{task='t'}
} catch { $threw=$_.Exception.Message }
[ordered]@{threw=$threw;exit=$(if($res -and $res.outcome -eq 'LEASE-OK'){0}elseif($res){1}else{$null});outcome=$(if($res){$res.outcome}else{$null});calls=@($global:Calls);ops=@($global:Ops)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Log
'@
$modelFile=Join-Path $work 'model.ps1'; Set-Content -LiteralPath $modelFile -Value $model
function Invoke-Journey($Box,[string]$Tree,[hashtable]$Extra,[switch]$Recorder,[string]$Ops,[switch]$Real) {
  $deadline=[DateTime]::UtcNow.AddMinutes(15).ToString('o'); if($Extra -and $Extra.DeadlineUtc){ $deadline=$Extra.DeadlineUtc }
  $log=Join-Path $Out ('run-'+[guid]::NewGuid().ToString('N')+'.json')
  $opsFile=''; if($env:WRP_STOP_OPS){ $opsFile=$env:WRP_STOP_OPS }
  $stdout=& $pwsh -NoProfile -NonInteractive -File $modelFile -Tree $Tree -Admitted $Box.Admitted -OpsFile $opsFile -DeadlineUtc $deadline -Log $log 2>&1 | Out-String
  if(!(Test-Path -LiteralPath $log)){ throw ('model child produced no log: '+$stdout.Trim()) }
  return (Get-Content -LiteralPath $log -Raw | ConvertFrom-Json)
}

$failures=[Collections.Generic.List[string]]::new()
# Each FAIL names the harness statement that asserted it (the receipt line for mutant receipts).
function Fail([string]$Witness,[string]$Detail){
  $at=@(Get-PSCallStack | Where-Object { $_.ScriptName -eq $PSCommandPath })[-1].ScriptLineNumber
  $failures.Add(('{0}: {1}' -f $Witness,$Detail)); Write-Output ('FAIL {0}: {1} [AssertionFailed native-driver-harness.ps1:{2}]' -f $Witness,$Detail,$at)
}
function Expect-Green([string]$Witness,$Res){ if(!$Res -or !$Res.ok){ Fail $Witness ('failed='+$(if($Res){Failed $Res}else{'no result'})) } else { Write-Output ('PASS '+$Witness) } }
function Expect-Killed([string]$Id){
  if(!$mutantStatements.ContainsKey($Id)){ Fail ('MUTANT '+$Id) 'statement absent'; return }
  . ([scriptblock]::Create($mutantStatements[$Id]))
  $row=@($results | Where-Object id -eq ('MUTANT '+$Id))[-1]
  if(!$row -or $row.status -ne 'KILLED'){ Fail ('MUTANT '+$Id) ('status={0} {1}' -f $row.status,$row.detail) } else { Write-Output ('PASS MUTANT '+$Id+' KILLED '+$row.detail) }
}

try {
  # Unmutated: the witnesses the two mutants target are GREEN in the model (W-RP13 J4 stop pending, W-RP7a hardlink log).
  Expect-Green 'W-RP13' (Test-StopPending $null)
  Expect-Green 'W-RP7a hardlink journey-console.log' (Test-Refusal 'W-RP7a hardlink journey-console.log' { param($b) $t=Join-Path $b.Outside 't'; [IO.File]::WriteAllText($t,'o'); New-Item -ItemType HardLink -Path (Join-Path $b.Admitted 'journey-console.log') -Target $t | Out-Null } 'Output name already exists')
  # The driver's own Mutant statements: each mutant must reach its target and be KILLED there, not OFF-TARGET.
  Expect-Killed 'M14'
  Expect-Killed 'M6a'
} finally {
  $env:WRP_ACTION_SECONDS=$null; $env:WRP_STOP_PENDING=$null; $env:WRP_STOP_OPS=$null
  Set-Location /; Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if($failures.Count){ Write-Output ('DRIVER HARNESS RED failures='+$failures.Count); exit 1 }
Write-Output 'DRIVER HARNESS GREEN'
