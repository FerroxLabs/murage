import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scanWindowsTree} from './scan-native.mjs';
const source=n=>readFileSync(new URL(n,import.meta.url),'utf8');
test('p11b 1: TimeoutSeconds 60, prelaunch CIM blocked beyond 150s still has operator-owned wrapper cleanup',()=>{
 const outer=source('run-interactive.ps1'),child=source('desktop-task.ps1');
 assert.match(outer,/CreateWrapperJob/);
 assert.match(outer,/Invoke-LauncherCleanup/);
 assert.match(source('ownership.ps1'),/Remove-WrapperTask/);
 assert.match(outer,/launcher-cleanup\.json/);
 assert(child.indexOf('JoinNamedJob($requestData.wrapperJob)')>=0);
 assert(child.indexOf('JoinNamedJob($requestData.wrapperJob)')<child.indexOf('Get-SessionProcesses'));
 assert.match(outer,/\$TimeoutSeconds \+ 90/);
});
test('p11b 2: schtasks beyond 30s uses suspended job creation, job timeout and empty proof',()=>{
 const s=source('owned-process.ps1');
 const native=s.slice(s.indexOf('function Invoke-WindowsNative'));
 assert.match(native,/Invoke-OwnedNative.*-TimeoutSeconds 30/);
 assert.doesNotMatch(native,/Diagnostics\.Process|\.Start\(/);
 assert.match(s,/PROC_THREAD_ATTRIBUTE_JOB_LIST/);
 assert.match(s,/if\(waited==258\)\s*\{\s*Check\(TerminateJobObject\(job,1\)\)/);
 assert.match(s,/AssertEmpty\(audit,proofTimeoutMilliseconds\)/);
 assert.doesNotMatch(s,/TerminateProcess\(/,'even failed assignment must not kill an unowned process');
});
test('p11b 2: recursive ban includes all Windows source and test files',()=>{
 assert.deepEqual(scanWindowsTree(),[]);
});
test('p11b 3: all six MAIN mutants are installed',()=>{
 const s=source('mutate-ownership.mjs');
 for(const name of ['allow-breakaway','delete-unprefixed-task','desktop-https-dispatch','finalize-inside-child','preserve-running-wrapper','native-outside-job']) assert(s.includes(`name:'${name}'`),name);
});
