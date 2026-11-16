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
 assert.match(source('../../electron/sentinel-schedule.mjs'),/MURAGE_GATE_RUN_PREFIX/);
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
