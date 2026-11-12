import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeLauncher,assertLinuxFixtureWindowsRefusal} from './native-launcher.mjs';
const proof=()=>({ownerClosed:true,empty:true,flags:8192,remaining:[]});
test('snapshot deadline is absolute and timeout propagates only with job proof',async()=>{
 let request;const launcher=createNativeLauncher({now:()=>151000,transport:async r=>{request=r;return {error:'Owned command exceeded its deadline',proof:proof()};}});
 await assert.rejects(launcher.run('powershell.exe',['-File','snapshot.ps1'],300000),/exceeded its deadline/);
 assert.equal(request.deadlineAt,451000);assert.deepEqual(request.args,['-File','snapshot.ps1']);await launcher.close();
});
for(const corrupt of [p=>p.empty=false,p=>p.ownerClosed=false,p=>p.flags|=2048,p=>p.remaining=[999]])test(`refuse native proof: ${corrupt}`,async()=>{
 const p=proof();corrupt(p);const launcher=createNativeLauncher({transport:async()=>({exitCode:0,stdout:'success',proof:p})});
 await assert.rejects(launcher.run('powershell.exe',[]),/job proof/);await launcher.close();
});
test('cleanup waits for outstanding native proof and closes admission',async()=>{
 let finish;const launcher=createNativeLauncher({transport:()=>new Promise(resolve=>{finish=resolve;})});
 const running=launcher.run('powershell.exe',[]);let closed=false;const closing=launcher.close().then(()=>{closed=true;});
 await Promise.resolve();assert.equal(closed,false);assert.throws(()=>launcher.run('powershell.exe',[]),/closed/);
 finish({exitCode:0,stdout:'done',proof:proof()});assert.equal(await running,'done');await closing;assert.equal(closed,true);
});
test('native command failure and broker failure cannot become success',async()=>{
 for(const response of [{exitCode:1,stderr:'failed',proof:proof()},{exitCode:0,stdout:'unproven'}]){
  const launcher=createNativeLauncher({transport:async()=>response});await assert.rejects(launcher.run('powershell.exe',[]));await launcher.close();
 }
});
test('Linux fixture launch entry points all refuse Windows before native execution',async()=>{
 await assertLinuxFixtureWindowsRefusal(assert);
});
