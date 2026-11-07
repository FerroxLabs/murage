import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BackupCoordinator} from '../server/backup-coordinator.ts';
import {createBackupScheduleHost} from './backup-schedule-host.mjs';
import {backupStartupDispatch,explicitBackupReturn} from './backup-startup.mjs';
import {createBackupReturn} from './backup-offline-return.mjs';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
const choices={enabled:false,installationRef:'installation',destinationRef:'destination',recoveryRef:'recovery',timezone:'UTC',time:'09:00',catchupMs:86400000,maxBytes:100000,maxDurationMs:60000,selection:{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'},preUpgrade:false};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'backup-startup-'));let now=Date.parse('2026-09-13T08:00:00Z');
 const options={stateDirectory:root,now:()=>now},c=new BackupCoordinator(options);c.configure(0,choices);c.requestManual(1,randomUUID());
 const intent={version:1,id:randomUUID(),bindingRevision:'a'.repeat(64),installationIdentity:'b'.repeat(64),expiresAt:now+60000};
 const file=join(root,'backup-coordinator.json'),events=[];
 const fresh=(extra={})=>{const coordinator=new BackupCoordinator({...options,...extra});return {coordinator,host:createBackupScheduleHost({coordinator,now:()=>now,supported:()=>true,installation:()=>root,readProtected:async()=>null,prepare:async()=>{events.push('prepare');},capture:async()=>{events.push('capture');}})};};
 return {root,c,intent,file,fresh,events,advance:ms=>{now+=ms;},cleanup:()=>safeWipeSync(root)};
}
for(const backupMode of [false,true])for(const phase of ['claiming','handoff-prepared','offline-claimed','capturing','handoff-armed'])test(`T-startup-manual BF-2 BF-4: ${phase}, backup-mode=${backupMode}`,()=>{
 const f=fixture();try{
  if(phase!=='claiming')f.c.prepareHandoff(f.c.status().job.id,f.intent);
  const raw=JSON.parse(readFileSync(f.file));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));
  if(phase==='handoff-armed')f.c.recordHandoffFailure({job:raw.job.id,handoff:f.intent.id,stage:'capture',code:'BACKUP_DISK_FULL'});
  const {host,coordinator}=f.fresh();const dispatch=backupStartupDispatch({host,backupMode,publish:()=>{assert.equal(coordinator.committedState().job.phase,'needs-review');f.events.push('publish');}});
  assert.equal(dispatch.route,'workspace');assert.equal(dispatch.consumedNonUpgradeHandoff,true);assert.equal(coordinator.status().reviewReason,phase==='handoff-armed'?'capture-unconfirmed':'interrupted');
  assert.deepEqual(f.events,['publish']);assert.equal(coordinator.clearReview(1).phase,'idle');
 }finally{f.cleanup();}
});
for(const backupMode of [false,true])for(const phase of ['claiming','handoff-armed'])test(`BF-2 BF-4: crash after review save retains diagnostic and workspace dispatch (${backupMode}, ${phase})`,()=>{
 const f=fixture();try{
  if(phase==='claiming'){const raw=JSON.parse(readFileSync(f.file));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));}
  else {f.c.prepareHandoff(f.c.status().job.id,f.intent);f.c.armHandoff(f.intent.id);f.c.recordHandoffFailure({job:f.c.status().job.id,handoff:f.intent.id,stage:'capture',code:'BACKUP_DISK_FULL'});}
  f.fresh().coordinator.reconcileStartup();const committed=readFileSync(f.file,'utf8');
  const {host,coordinator}=f.fresh();const dispatch=backupStartupDispatch({host,backupMode});
  assert.equal(dispatch.route,'workspace');assert.equal(dispatch.consumedNonUpgradeHandoff,true);assert.equal(readFileSync(f.file,'utf8'),committed);assert.equal(coordinator.status().reviewReason,phase==='claiming'?'interrupted':'capture-unconfirmed');
  if(phase==='handoff-armed')assert.deepEqual(coordinator.status().captureFailure,{stage:'capture',code:'BACKUP_DISK_FULL'});
  assert.equal(coordinator.clearReview(1).phase,'idle');assert.deepEqual(f.events,[]);
 }finally{f.cleanup();}
});
for(const phase of ['due','waiting-idle','waiting-backup-mode','handoff-armed','capturing'])test(`T-torn-prerun T-startup-dispatch: side wait beats torn ${phase} under both argv forms`,()=>{
 const f=fixture();try{
  if(['handoff-armed','capturing'].includes(phase))f.c.prepareHandoff(f.c.status().job.id,f.intent);
  const raw=JSON.parse(readFileSync(f.file));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));
  const crash=new BackupCoordinator({stateDirectory:f.root,now:()=>Date.parse('2026-09-13T08:00:00Z'),onSideWritten(){throw Error('crash');}});
  assert.throws(()=>phase==='handoff-armed'||phase==='capturing'?crash.waitHandoff(raw.job.id,{cause:'busy',code:'BACKUP_FILE_IN_USE',drive:null}):crash.waitJob(raw.job.id,{cause:'space',code:'BACKUP_DISK_FULL',drive:'backup'}),/crash/);
  for(const backupMode of [false,true]){const {host,coordinator}=f.fresh();assert.equal(backupStartupDispatch({host,backupMode}).route,'workspace');assert.equal(coordinator.status().phase,'waiting');assert.equal(coordinator.committedState().job.phase,'skipped');}
  assert.deepEqual(f.events,[]);
 }finally{f.cleanup();}
});
test('T-startup-dispatch: marker-free armed, unrelated recovery, blocked lease and closed startup retain their distinct routes',()=>{
 const f=fixture();try{
  assert.equal(backupStartupDispatch({host:f.fresh().host,backupMode:true}).route,'recovery');
  f.c.prepareHandoff(f.c.status().job.id,f.intent);f.c.armHandoff(f.intent.id);
  assert.equal(backupStartupDispatch({host:f.fresh().host,backupMode:true}).route,'offline');
  assert.equal(backupStartupDispatch({host:f.fresh().host,closed:true}).route,'closed');
  const blocked=f.fresh({acquire(){throw Error('busy');}});assert.equal(backupStartupDispatch({host:blocked.host,backupMode:true,publish:()=>assert.fail('blocked publication')}).route,'recovery');
  assert.equal(backupStartupDispatch({host:blocked.host,closed:true}).route,'closed-blocked');
  assert.equal(backupStartupDispatch({host:f.fresh().host}).route,'offline');
 }finally{f.cleanup();}
});
test('upgrade routing precedes a consumed stale argument',()=>{
 const host={reconcileStartup:()=>({blocked:false,consumedNonUpgradeHandoff:true}),internalStatus:()=>({phase:'return-pending'}),pendingUpgrade:()=>({phase:'return-pending'})};
 assert.equal(backupStartupDispatch({host,backupMode:true}).route,'upgrade');
});
test('BF-3: actual explicit Return callback resets only a failed cleanup',async()=>{
 let count=0,shutdown=false,relaunches=0;const calls=[];
 const back=createBackupReturn({app:{quit(){},exit(){}},shutdownStarted:()=>shutdown,cleanup:async()=>{shutdown=true;if(++count===1)throw Error('failed');},relaunch:()=>{relaunches++;},takeProgress:()=>null,setTimer:()=>0});
 await assert.rejects(back(),/failed/);await assert.rejects(back(),/failed/);
 const host={noteStop:()=>calls.push('stop'),prepareWorkspaceReturn:()=>calls.push('prepare'),pendingUpgrade:()=>null};
 await explicitBackupReturn(host,back);await explicitBackupReturn(host,back);assert.equal(count,2);assert.equal(relaunches,1);assert.deepEqual(calls,['stop','prepare','stop']);// the second Return joins the leaving attempt (b9 F6: prepare only inside the shared attempt)
});
test('T-stop-wiring T-startup-dispatch: main uses the real helpers before armed routing and normal writers',()=>{
 const main=readFileSync(new URL('./main.mjs',import.meta.url),'utf8');
 assert.match(main,/import \{backupStartupDispatch, explicitBackupReturn\} from "\.\/backup-startup.mjs"/);
 const dispatch=main.indexOf('const backupDispatch=backupStartupDispatch');
 assert.ok(dispatch>main.indexOf('await initializeBackupScheduleHost();',main.indexOf('const desktopStartup')));
 assert.ok(dispatch<main.indexOf('if(backupDispatch.route==="offline")'));
 assert.ok(dispatch<main.indexOf('migrateLegacyDataDirectory({',dispatch));
 assert.match(main,/backupDispatch.route==="recovery"/);assert.match(main,/explicitBackupReturn\(backupScheduleHost,returnToWorkspaceAfterBackup\)/);
 assert.match(main,/function cleanupDesktopForExit\(reason="user-stop",token\) \{\s*if\(reason==="user-stop"&&!token\?\.stopNoted\)backupScheduleHost\?\.noteStop\?\.\(\)/);
 assert.match(main,/shutdownStarted:\(\)=>desktopShutdownStarted/);assert.match(main,/cleanupDesktopForExit\("internal",token\)/);
 assert.match(main,/token\.cancelQueued=/);
});

test('T-stop-admission: actual main relaunch queue can be revoked before scheduling, and internal quit runs once',async()=>{
 const main=readFileSync(new URL('./main.mjs',import.meta.url),'utf8');
 const body=/relaunch:async\(mode,budgetArgument,token\)=>(\{[\s\S]*?\n    \}),/.exec(main);assert.ok(body);
 const queue=[],events=[];
 const scope={returnToWorkspaceAfterBackup:createBackupReturn({app:{quit:()=>events.push('internal quit'),exit(){}},cleanup:async()=>{},relaunch:()=>events.push('relaunch'),takeProgress:()=>null,setTimer:()=>0}),withoutBackupBudgetArgument:args=>args,process:{argv:['node','app']},BACKUP_MODE_ARGUMENT:'--backup',serverStopReason:{note(){}},relaunchDesktop:()=>events.push('relaunch'),app:{},quitAfterBackup:()=>events.push('internal quit'),setImmediate:callback=>{queue.push(callback);return callback;},clearImmediate:callback=>{queue.splice(queue.indexOf(callback),1);}};
 const relaunch=new Function(...Object.keys(scope),`return async(mode,budgetArgument,token)=>${body[1]}`)(...Object.values(scope));
 const token={cancelled:false};const stopped=relaunch('backup',null,token);token.cancelled=true;token.cancelQueued();await assert.rejects(stopped,/STOPPED/);assert.deepEqual(events,[]);assert.equal(queue.length,0);
 const success=relaunch('backup',null,{cancelled:false});queue.shift()();await success;assert.deepEqual(events,['relaunch','internal quit']);
});

test('queued relaunch failure rejects admission instead of escaping its callback',async()=>{
 const main=readFileSync(new URL('./main.mjs',import.meta.url),'utf8');
 const body=/relaunch:async\(mode,budgetArgument,token\)=>(\{[\s\S]*?\n    \}),/.exec(main);assert.ok(body);
 const callbacks=[];const scope={returnToWorkspaceAfterBackup:createBackupReturn({app:{quit:()=>assert.fail('quit after failed relaunch'),exit(){}},cleanup:async()=>{},relaunch:()=>{throw Error('fixture restart failed');},takeProgress:()=>null,setTimer:()=>0}),withoutBackupBudgetArgument:args=>args,process:{argv:['node','app']},BACKUP_MODE_ARGUMENT:'--backup',serverStopReason:{note(){}},relaunchDesktop:()=>{throw Error('fixture restart failed');},app:{},quitAfterBackup:()=>assert.fail('quit after failed relaunch'),setImmediate:fn=>{callbacks.push(fn);return fn;},clearImmediate:()=>{}};
 const relaunch=new Function(...Object.keys(scope),`return async(mode,budgetArgument,token)=>${body[1]}`)(...Object.values(scope));
 const pending=relaunch('backup',null,{});callbacks.shift()();await assert.rejects(pending,/fixture restart failed/);
});
