# Linux rollback harness (Astra n4:625 reservation rollback): the real qualification-paths.ps1 is dot-sourced, so
# Reserve-QualificationOutputs, Remove-QualificationOutputs and the compiled LeaseRefused type run unchanged. Only the
# kernel32 lease object is replaced by a recorder whose Reserve/Delete calls can be told to fail. Native rollback by
# handle is proved by run-on-windows.ps1 (W-RP14 rollback native).
# Usage: pwsh -File rollback-harness.ps1 -Tree <repo root>
param([string]$Tree)
$ErrorActionPreference='Stop'
if(!$Tree){throw 'usage: -Tree <repo root>'}
. (Join-Path $Tree 'native/backup-age/real-main-qualification/qualification-paths.ps1')

$failures=[Collections.Generic.List[string]]::new()
function Fail([string]$Witness,[string]$Detail){
  $at=@(Get-PSCallStack | Where-Object { $_.ScriptName -eq $PSCommandPath })[-1].ScriptLineNumber
  $Detail=$Detail -replace '\s*\r?\n\s*',' | '
  $failures.Add(('{0}: {1}' -f $Witness,$Detail)); Write-Output ('FAIL {0}: {1} [AssertionFailed rollback-harness.ps1:{2}]' -f $Witness,$Detail,$at)
}

# The recorder is compiled C#, like the real Lease, and throws the real LeaseRefused type from C#, so a refusal reaches
# Invoke-QualificationLeaseCall with the same MethodInvocationException -> LeaseRefused chain as the kernel32 lease.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
namespace RollbackWitness {
  public sealed class Item { public string Relative; public string Kind; public bool Used; }
  public sealed class RecorderLease {
    public string[] PlannedOutputs; public string[] PlannedTaskLogs; public string RefuseReserve; public string[] RefuseDelete;
    public Func<string, Exception> Refused; public string RefuseMessage;
    public readonly List<Item> Items = new List<Item>();
    public readonly List<string> Deleted = new List<string>();
    public Item Reserve(string name, bool taskLog) {
      if (name == RefuseReserve) throw Refused(RefuseMessage ?? ("Output name already exists: <admitted>\\" + name));
      Item item = new Item(); item.Relative = "<admitted>\\" + name; item.Kind = taskLog ? "tasklog" : "output"; item.Used = taskLog;
      Items.Add(item); return item;
    }
    void Delete(Item item) {
      Deleted.Add(item.Relative);
      if (Array.IndexOf(RefuseDelete, item.Relative) >= 0) throw Refused("Reserved output delete failed (5): " + item.Relative);
      Items.Remove(item);
    }
    public void DeleteReserved(Item item) { Delete(item); }
    public void DeleteTaskLog(Item item) { Delete(item); }
  }
}
'@

function New-RecorderLease([string[]]$Outputs,[string[]]$TaskLogs,[string]$RefuseReserve,[string[]]$RefuseDelete) {
  $lease=[RollbackWitness.RecorderLease]::new()
  $lease.PlannedOutputs=@($Outputs); $lease.PlannedTaskLogs=@($TaskLogs); $lease.RefuseReserve=$RefuseReserve; $lease.RefuseDelete=@($RefuseDelete)
  $lease.Refused=[Func[string,Exception]]{ param($m) [MurageQualification.LeaseRefused]::new($m) }
  return $lease
}
function Threw([scriptblock]$Call){ try { & $Call; return $null } catch { return $_.Exception.Message } }

# R1: the refused reservation is rolled back completely -> REFUSED-RESERVE, every created file deleted.
$l=New-RecorderLease @('journey-task.xml','journey-lease.txt') @('journey-console.log') 'journey-console.log' @()
$t=Threw { Reserve-QualificationOutputs $l }
if($t -notlike 'REFUSED-RESERVE: Output name already exists:*' -or ($l.Deleted -join ',') -ne '<admitted>\journey-task.xml,<admitted>\journey-lease.txt'){ Fail 'R1 clean rollback' ("threw={0} deleted={1}" -f $t,($l.Deleted -join ',')) }

# R2: one rollback delete fails -> never plain REFUSED-RESERVE; the left file is named and every other file was still attempted.
$l=New-RecorderLease @('journey-task.xml','journey-lease.txt','journey-watchdog.txt') @('journey-console.log') 'journey-console.log' @('<admitted>\journey-lease.txt')
$t=Threw { Reserve-QualificationOutputs $l }
if($t -notlike 'REFUSED-RESERVE-DIRTY: Output name already exists:*' -or $t -notlike '*rollback left: <admitted>\journey-lease.txt'){ Fail 'R2 dirty rollback' ("threw={0}" -f $t) }
if(($l.Deleted -join ',') -ne '<admitted>\journey-task.xml,<admitted>\journey-lease.txt,<admitted>\journey-watchdog.txt'){ Fail 'R2 attempts all' ("deleted={0}" -f ($l.Deleted -join ',')) }

# R5: Reserve could not remove the file it created itself ('; rollback left:' from the lease) -> REFUSED-RESERVE-DIRTY.
$l=New-RecorderLease @('journey-task.xml') @('journey-console.log') 'journey-console.log' @()
$l.RefuseMessage='Output name check failed (5): <admitted>\journey-console.log; rollback left: <admitted>\journey-console.log'
$t=Threw { Reserve-QualificationOutputs $l }
if($t -ne ('REFUSED-RESERVE-DIRTY: '+$l.RefuseMessage) -or ($l.Deleted -join ',') -ne '<admitted>\journey-task.xml'){ Fail 'R5 refused item left' ("threw={0} deleted={1}" -f $t,($l.Deleted -join ',')) }

# R3: unused-reservation removal attempts every output and names each one it could not delete.
$l=New-RecorderLease @('a.txt','b.txt','c.txt') @() $null @('<admitted>\b.txt')
foreach($n in 'a.txt','b.txt','c.txt'){ $null=$l.Reserve($n,$false) }
$t=Threw { Remove-QualificationOutputs $l }
if($t -ne 'Reserved output delete failed: <admitted>\b.txt' -or ($l.Deleted -join ',') -ne '<admitted>\a.txt,<admitted>\b.txt,<admitted>\c.txt'){ Fail 'R3 removal attempts all' ("threw={0} deleted={1}" -f $t,($l.Deleted -join ',')) }

# R4: used outputs are kept unless -All.
$l=New-RecorderLease @('a.txt','b.txt') @() $null @()
foreach($n in 'a.txt','b.txt'){ $null=$l.Reserve($n,$false) }; $l.Items[0].Used=$true
$t=Threw { Remove-QualificationOutputs $l }
if($t -or ($l.Deleted -join ',') -ne '<admitted>\b.txt'){ Fail 'R4 used kept' ("threw={0} deleted={1}" -f $t,($l.Deleted -join ',')) }

if($failures.Count){ Write-Output ('ROLLBACK HARNESS RED: {0} failure(s)' -f $failures.Count); exit 1 }
Write-Output 'ROLLBACK HARNESS GREEN'
