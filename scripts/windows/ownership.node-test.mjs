import {validateReceipt} from './receipt-pair.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const source=n=>readFileSync(new URL(n,import.meta.url),'utf8');
test('MAIN 1: suspended job has no breakaway and verifies empty after owner close',()=>{
 const s=source('owned-process.ps1');
 assert.match(s,/limits.basic.flags=0x2000;/);
 assert.doesNotMatch(s,/limits.basic.flags=0x2000\s*\|/);
 assert.match(s,/QueryInformationJobObject/);
 assert(s.indexOf('CloseHandle(job);')<s.indexOf('AssertEmpty(audit,proofTimeoutMilliseconds)'));
 assert.match(s,/Marshal.WriteIntPtr\(jobList,0,audit\)/);
 assert.match(s,/Marshal.WriteIntPtr\(jobList,IntPtr.Size,job\)/);
 assert.match(source('ownership.ps1'),/GetOwnerSid/,'include caller-owned service-session escapes');
});
test('MAIN 2: full task snapshots and prefix-only new-task cleanup',()=>{
 assert(existsSync(new URL('ownership.ps1',import.meta.url)),'ownership snapshot boundary missing');
 const s=source('ownership.ps1');
 for(const row of ['Get-TaskSnapshot','author=','actions=','Complete-SnapshotDiff','Test-RunPrefix'])assert(s.includes(row),row);
 assert.match(source('packaged-scenario.mjs'),/snapshot\(name,'before'\)/);
 assert.match(source('packaged-scenario.mjs'),/snapshot\(name,'after'\)/);
 // Shipped code reads no gate context; the gate runs only its own prefixed, job-joined copies of the Sentinel task.
 assert.doesNotMatch(source('../../electron/sentinel-schedule.mjs'),/MURAGE_GATE_|task-bridge/);
 const sentinel=source('sentinel-scenario.ps1');
 assert.match(sentinel,/\$exec\.Command=\$env:MURAGE_GATE_TASK_HELPER/);
 assert.match(sentinel,/ConvertTo-WindowsArgument \$env:MURAGE_GATE_JOB_NAME/);
 assert.match(sentinel,/RegisterTask\(\$manual,/);
 assert.doesNotMatch(sentinel,/\$task\.Run\(/,'production task must never run outside the job');
 assert(sentinel.indexOf('Join-GateTask $xml')<sentinel.indexOf('RegisterTask($manual,'),'manual copy must be job-joined');
 assert(sentinel.indexOf('Join-GateTask $xml')<sentinel.indexOf('RegisterTask($clone,'),'recurring copy must be job-joined');
 // The shipped registration starts its own task once, outside the job: the scenario settles that launch before it measures
 // anything, and the finalizer ends the exact owned task instead of preserving a running scanner.
 const settle=sentinel.indexOf('$productionLaunch=Complete-ProductionLaunch $task');
 assert(settle>0,'startup launch must be settled');
 assert(settle<sentinel.indexOf('$beforePublication='),'startup launch settles before the publication baseline');
 assert(settle<sentinel.indexOf('RegisterTask($manual,'),'startup launch settles before the job-joined run');
 const settler=sentinel.slice(sentinel.indexOf('function Complete-ProductionLaunch'),sentinel.indexOf('function Publication-Time'));
 assert.match(settler,/\$Task\.GetInstances\(0\)\.Count/);
 assert.match(settler,/\$Task\.Stop\(0\);throw 'Production scanner still running outside the job'/);
 assert.match(settler,/throw 'Production scanner never started'/);
 assert.match(sentinel,/productionLaunch=\$productionLaunch;app='open'/);
 assert.match(sentinel,/productionLaunch=\$productionLaunch;app='closed'/);
 const owned=s.slice(s.indexOf('function Remove-OwnedSentinelTask'),s.indexOf('function Complete-SnapshotDiff'));
 assert(s.includes('function Remove-OwnedSentinelTask'),'owned Sentinel finalizer missing');
 assert.match(owned,/\$task\.Enabled=\$false/);
 assert.match(owned,/\$task\.Stop\(0\)/);
 assert.match(owned,/\$task\.GetInstances\(0\)\.Count -gt 0/);
 assert.match(owned,/DeleteTask\(/);
 assert(owned.indexOf('$task.Stop(0)')<owned.indexOf('DeleteTask('),'End before delete');
 assert.match(s,/Remove-OwnedSentinelTask \$item @ops/);
 const plain=s.slice(s.indexOf('function Remove-SnapshotTask'),s.indexOf('function Invoke-WrapperScheduler'));
 assert.doesNotMatch(plain,/\.Stop\(/,'prefixed copies die with the job; never Scheduler End');
 assert.match(source('desktop-task.ps1'),/prefix=\$requestData\.prefix;executable=\$requestData\.executable/);
 assert.match(source('winbox-gate.ps1'),/TaskDiff -Payload @\{before=\$baseline;prefix=\$prefix;executable=\$executable\}/);
});
test('MAIN 3: HTTPS dispatch is handoff only; Desktop keeps refusal rows',()=>{
 const s=source('packaged-scenario.mjs');
 const browser=s.slice(s.indexOf("if(selected.includes('browser'))"),s.indexOf("if(selected.includes('sentinel'))"));
 assert(!browser.includes("row:'https-opened'"),'Desktop dispatch forbidden');
 assert(browser.includes('refused.exe'),'executable refusal missing');
 assert(s.indexOf("row:'https-opened'")>s.indexOf("await begin('updates-handoff')"),'handoff dispatch missing');
});
test('MAIN 4: registration diff is Handoff-only and guarded by machine',()=>{
 assert(existsSync(new URL('ownership.ps1',import.meta.url)),'registration boundary missing');
 const s=source('ownership.ps1');
 for(const term of ['Get-RegistrationSnapshot','gate-win-nogit','Registry32','Registry64','Uninstall','Software\\Classes','CommonPrograms','DesktopDirectory'])assert(s.includes(term),term);
 assert.match(s,/if\(\$Kind -eq 'handoff'\)/);
});
test('MAIN 5: only operator finalizes after cleanup; receipt needs cleanup proof',async()=>{

 assert.match(source('receipt-pair.mjs'),/validateCleanup/);
 const child=source('scenario-common.ps1');assert(!child.includes('Move-Item -LiteralPath $pending -Destination $Receipt'));
 const outer=source('run-interactive.ps1');assert(outer.lastIndexOf('Finalize-GateReceipt')>outer.lastIndexOf('Invoke-LauncherCleanup -Task'));
 assert.equal(typeof validateReceipt,'function');
});
