import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {BackupCoordinator} from './backup-coordinator.ts';
import {createBackupScheduleHost} from '../electron/backup-schedule-host.mjs';
import {createBackupReturn,runOfflineBackup,createReturnAuthority,revokeReturn,joinExplicitQuit} from '../electron/backup-offline-return.mjs';
import {removeTempDirSync} from './testing/cleanup.ts';
import {atomicWriteCount} from './atomic.ts';
import {runInNewContext} from 'node:vm';
const {explicitBackupReturn}=createRequire(import.meta.url)('../electron/backup-startup.mjs');
// Execute the production callbacks with an already pending desktop cleanup.
// Native services are fixture dependencies; cancellation and cleanup ordering are real.
function desktopStop(host:ReturnType<typeof createBackupScheduleHost>,action:string){
 const source=readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8');
 const cleanup=source.slice(source.indexOf('function cleanupDesktopForExit('),source.indexOf('// Electron restarts a lost GPU'));
 const quit=source.slice(source.indexOf('app.on("before-quit", (e) => {'));
 let trigger!:()=>void,finish!:()=>void,settled=false;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const noop=()=>{}, disposable={dispose:noop,invalidate:noop};
 const scope={backupScheduleHost:host,bannerNative:null,attentionSurfaces:null,internalBackupQuit:false,quitRequested:false,backgroundLifecycle:null,cuaCleanedUp:false,
  desktopCleanup:pending,desktopShutdownStarted:false,serverStopReason:{logOnce:noop},stopDeskPresence:noop,sentinelHost:null,
  stopAutomaticRemoteBackups:noop,localEngineLogin:{shutdown:async()=>{}},modelSignIn:disposable,mcpServers:disposable,
  notificationAuthorization:disposable,showApprovalNotification:disposable,
  // Module lets cleanupDesktopForExit now disposes (Notify 1.0.19, b0cdd0b7a, electron/main.mjs:5883); null as at startup.
  desktopBackupTool:disposable,desktopResticTool:null,
  remoteBackupAttestation:{abort:noop},managedComposioShutdown:{abort:noop},app:{on:(_event:string,cb:()=>void)=>{trigger=cb;},quit:noop},
  setImmediate:noop,slog:noop,dialog:{showErrorBox:noop},explicitBackupReturn,returnToWorkspaceAfterBackup:null as unknown,
  // Names the merged before-quit and Return callback use (b9 return authority, quit join, shutdown cause).
  returnAuthority:createReturnAuthority(),revokeReturn,joinExplicitQuit:(options:Record<string,unknown>)=>joinExplicitQuit({...options,scheduleExit:noop,setTimer:noop} as never),
  shutdownCause:null,noteShutdownCause:noop,startupFailureExit:false,startupDecisionPending:false,updateRecoveryDescriptor:null,updateRequester:false,
  finishUpdateWait:noop,takeBackupProgress:()=>null,cleanupFailed:noop,desktopCleanupStage:'fixture',quitAfterBackup:noop,
  descriptor:{updatePause:false},refusal:(code:string)=>Object.assign(Error(code),{code})};
 runInNewContext(cleanup+quit,scope);
 const cleanupCall=()=>runInNewContext('cleanupDesktopForExit()',scope) as Promise<void>;
 const back=createBackupReturn({app:{quit:noop,exit:noop},authority:scope.returnAuthority,shutdownStarted:()=>false,cleanup:cleanupCall,relaunch:noop,takeProgress:()=>null,setTimer:noop});
 scope.returnToWorkspaceAfterBackup=back;
 // This is the explicit Return callback used by the production recovery page.
 const retryAt=source.indexOf('    retry: async () => {'),callback=source.slice(retryAt,source.indexOf('    openDiagnostics:',retryAt));
 expect(retryAt).toBeGreaterThan(0);expect(callback).toContain('await explicitBackupReturn(backupScheduleHost,returnToWorkspaceAfterBackup);');
 const done=action==='quit'?((trigger as unknown as (event:unknown)=>void)({preventDefault:noop}),pending):runInNewContext('({'+callback+'}).retry()',scope) as Promise<void>;
 void done.then(()=>{settled=true;});
 expect(scope.desktopShutdownStarted).toBe(true);
 expect(settled).toBe(false);
 return async()=>{expect(settled).toBe(false);finish();await done;};
}
const GiB=1024**3;
const roots:string[]=[],hosts:{stopPolling():void}[]=[];
afterEach(()=>{hosts.splice(0).forEach(h=>h.stopPolling());for(const root of roots.splice(0))removeTempDirSync(root);vi.restoreAllMocks();});
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const key='# public key: age1'+'q'.repeat(58)+'\nAGE-SECRET-KEY-1'+'A'.repeat(60)+'\n';
async function rig({enabled=false,closed=false,layout='split'}={}){
 const root=mkdtempSync(join(tmpdir(),'backup-wait-1018-'));roots.push(root);
 const data=join(root,'data'),destination=join(root,'archives'),keyFile=join(root,'key');mkdirSync(data);mkdirSync(destination);writeFileSync(keyFile,key);
 const protectedArtifacts=[join(destination,'older.age'),join(destination,'.murage-backup-retained','backup.age'),join(root,'owner.fixture')];mkdirSync(dirname(protectedArtifacts[1]));protectedArtifacts.forEach(file=>writeFileSync(file,'retained'));
 let time=Date.parse('2026-09-13T08:00:00Z'),binding:string|undefined,backupFree:number|undefined=100*GiB,dataFree:number|undefined=100*GiB;
 const stateDirectory=join(root,'control'),options={stateDirectory,now:()=>time};
 const c=()=>new BackupCoordinator(options);const calls:string[]=[],filenames:string[]=[];
 const base={coordinator:c(),installation:()=>data,now:()=>time,supported:()=>true,readProtected:async()=>binding,writeProtected:async(_key:string,value:string)=>{binding=value;},chooseDestination:async()=>destination,chooseKey:async()=>keyFile,confirmReferences:async()=>true,
   assertUpgradeAllowed:async()=>{},assertClosedAllowed:async()=>{},assertClosedStartup:async()=>{},
   volumeId:(file:string)=>layout==='unknown'?0:layout==='shared'?1:file===destination?1:2,freeBytes:(file:string)=>file===destination?backupFree:dataFree,
   prepare:async()=>{calls.push('prepare');return async()=>{calls.push('release');};},cleanupIdle:async()=>{calls.push('cleanup');},relaunch:async(mode:string)=>{calls.push(mode);},
   capture:async(request:{output:string})=>{calls.push('capture');filenames.push(request.output);const bytes=Buffer.from('fixture ciphertext');writeFileSync(request.output,bytes,{flag:'wx'});return {ok:true,operation:'backup-encrypted',path:request.output,sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:'application-data',fullInstallation:false}};}};
 const make=(overrides:Record<string,unknown>={})=>{const h=createBackupScheduleHost({...base,coordinator:c(),...overrides});hosts.push(h);return h;};
 const host=make();const selected=await host.selectReferences();
 const schedule={enabled:true,timezone:'UTC',time:'09:00',catchupMs:86400000,maxBytes:100*GiB,maxDurationMs:60000,selection:{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'},preUpgrade:true,closedApp:closed,...selected.refs,allowIdleRestart:true,allowClosedApp:closed};
 delete schedule.destinationLabel;delete schedule.recoveryLabel;
 await host.configure(0,schedule);host.stopPolling();while(host.isPreparing())await new Promise(resolve=>setImmediate(resolve));
 if(!enabled){const s=c().status();c().configure(s.revision,{...s.schedule,enabled:false});}
 const side=join(stateDirectory,'backup-wait.json'),main=join(stateDirectory,'backup-coordinator.json');
 return {root,data,destination,keyFile,c,host,make,base,calls,filenames,side,main,options,advance:(ms:number)=>{time+=ms;},now:()=>time,setFree:(backup:number|undefined,local=backup)=>{backupFree=backup;dataFree=local;},
   verifyArtifacts:()=>protectedArtifacts.forEach(file=>expect(readFileSync(file,'utf8')).toBe('retained')),
   seedReceipt:()=>{const raw=JSON.parse(readFileSync(main,'utf8'));raw.lastVerified={jobId:'a'.repeat(64),installationRef:raw.schedule.installationRef,destinationRef:raw.schedule.destinationRef,selectionHash:'a'.repeat(64),snapshotId:randomUUID(),artifactRef:'previous',sha256:'a'.repeat(64),bytes:10*GiB,verifiedAt:time-1};writeFileSync(main,JSON.stringify(raw));},
   settle:async(h=host)=>{h.stopPolling();while(h.isPreparing())await new Promise(resolve=>setImmediate(resolve));}};
}
it('T-H1 T-restart T-status: three hours of open polling keep the floor and deadline, then capture a fresh filename once',async()=>{
 const f=await rig();f.seedReceipt();await f.host.runNow(f.c().status().revision);
 f.setFree(12*GiB);const failure=f.make({capture:async()=>{throw Object.assign(Error('BACKUP_DISK_FULL'),{captureStep:'encrypt'});}});
 await expect(failure.resumeOffline()).rejects.toThrow('BACKUP_WAITING');
 const initial=f.c().status(),raw=readFileSync(f.side,'utf8'),writes=atomicWriteCount(f.side);
 expect(initial.waiting).toMatchObject({attempts:1,nextAt:f.now()+900000});expect(initial.room!.floors.backup!).toBeGreaterThan(12*GiB);
 const fresh=f.make();expect(fresh.reconcileStartup()).toMatchObject({phase:'waiting'});
 const launches=f.calls.filter(x=>x==='backup').length;
 for(let minute=0;minute<180;minute++){f.advance(60000);await fresh.tick();}
 expect(readFileSync(f.side,'utf8')).toBe(raw);expect(atomicWriteCount(f.side)).toBe(writes);expect(f.calls.filter(x=>x==='backup')).toHaveLength(launches);
 const page=await fresh.status();expect(page.waiting.requiredBytes).toBe(initial.room!.floors.backup);expect(page.waiting.neededBytes).toBe(initial.room!.floors.backup!-12*GiB);
 f.setFree(initial.room!.floors.backup!);await fresh.tick();expect(f.c().status().job!.id).not.toBe(initial.job!.id);
 await f.make().resumeOffline();expect(f.c().status().room).toBeUndefined();expect(f.filenames).toHaveLength(1);f.verifyArtifacts();
});
it.each(['split','unknown','shared'])('T-H3 T-volume-unknown: %s admission checks both real volume paths',async layout=>{
 const f=await rig({layout});f.seedReceipt();f.setFree(13*GiB,layout==='split'?11*GiB:13*GiB);
 await f.host.runNow(f.c().status().revision);await f.settle();expect(f.c().status().phase).toBe('waiting');expect(f.calls).not.toContain('prepare');
 const page=await f.host.status();expect(page.waiting.requiredBytes).toBe((layout==='split'?12:24)*GiB);expect(page.waiting.drive).toBe(layout==='split'?'data':'backup');
 f.setFree(24*GiB);await f.make().tick();expect(f.c().status().phase).toBe('handoff-armed');f.verifyArtifacts();
});
it.each(['stage','readback','private-stage'])('T-G2-2: %s floors its actual writer',async captureStep=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);f.setFree(1*GiB);
 await expect(f.make({platform:'linux',capture:async()=>{throw Object.assign(Error('BACKUP_DISK_FULL'),{captureStep});}}).resumeOffline()).rejects.toThrow('BACKUP_WAITING');
 expect(Object.keys(f.c().status().room!.floors)).toEqual([captureStep==='private-stage'?'backup':'data']);f.verifyArtifacts();
});
it('T-manual-preflight T-drive-change: generic reads preserve all bytes; a removed folder waits without replacement',async()=>{
 const f=await rig();f.seedReceipt();f.setFree(1);await f.host.runNow(f.c().status().revision);await f.settle();
 const main=readFileSync(f.main,'utf8'),side=readFileSync(f.side,'utf8'),id=f.c().status().job!.id;
 await expect(f.make({readProtected:async()=>{throw Error('store locked');}}).runNow(f.c().status().revision)).rejects.toThrow('store locked');
 expect(readFileSync(f.main,'utf8')).toBe(main);expect(readFileSync(f.side,'utf8')).toBe(side);
 renameSync(f.destination,f.destination+'-away');await f.host.runNow(f.c().status().revision);await f.settle();expect(f.c().status().job!.id).toBe(id);expect(f.c().status().waiting?.cause).toBe('drive');
 renameSync(f.destination+'-away',f.destination);await f.host.tick();expect(f.c().status().waiting?.cause).toBe('space');expect(f.c().status().waiting?.nextAt).toBe(JSON.parse(side).wait.nextAt);
});
it.each(['quit','return'].flatMap(action=>['preflight','space','prepare','cleanup'].map(boundary=>({action,boundary}))))('T-stop-admission BF-1: $action during manual $boundary releases ownership without reviving the old wait',async ({action,boundary})=>{
 const f=await rig();f.seedReceipt();f.setFree(1);await f.host.runNow(f.c().status().revision);await f.settle();const old=f.c().status(),side=readFileSync(f.side,'utf8');f.setFree(100*GiB);
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const hold=new Promise<void>(resolve=>{release=resolve;});const held=()=>{entered();return hold;};
 const hooks:Record<string,unknown>={};
 if(boundary==='preflight')hooks.readProtected=async()=>{await held();return f.base.readProtected();};
 if(boundary==='space')hooks.freeBytes=async()=>{await held();return 100*GiB;};
 if(boundary==='prepare')hooks.prepare=async()=>{await held();return async()=>{f.calls.push('release');};};
 if(boundary==='cleanup')hooks.cleanupIdle=held;
 const host=f.make(hooks),pending=host.runNow(old.revision);await ready;const finishStop=desktopStop(host,action);release();
 // Both endpoint reads share the held promise in the space case below.
 if(boundary==='space')release();
 await expect(pending).rejects.toThrow('STOPPED');await finishStop();expect(f.calls).not.toContain('backup');
 const state=f.c().status();if(boundary==='preflight'){expect(state.job!.id).toBe(old.job!.id);expect(readFileSync(f.side,'utf8')).toBe(side);}
 else {expect(state.job!.id).not.toBe(old.job!.id);expect(state.phase).toBe(boundary==='cleanup'?'needs-review':'skipped');expect(state.waiting).toBeUndefined();expect(f.c().committedState().seen).toContain(old.job!.occurrence);}
 if(boundary==='prepare'||boundary==='cleanup')expect(f.calls).toContain('release');f.verifyArtifacts();
});
it('T-closed-cadence T-H2: one closed claim renews the deadline; key loss reviews with exact diagnostics',async()=>{
 const f=await rig({enabled:true,closed:true});f.seedReceipt();f.advance(3600001);f.setFree(1);
 expect((await f.make().runClosedDue()).status).toBe('not-due');const old=f.c().status().waiting!;
 f.advance(old.nextAt-f.now());const writes=atomicWriteCount(f.side);expect((await f.make().runClosedDue()).status).toBe('not-due');expect(atomicWriteCount(f.side)).toBe(writes+1);expect(f.c().committedState().lastClosedResult?.status).toBe('not-due');
 f.advance(900000);f.setFree(100*GiB);rmSync(f.keyFile);expect((await f.make().runClosedDue()).status).toBe('needs-review');expect(f.c().status().captureFailure).toEqual({stage:'references',code:'BACKUP_RECOVERY_KEY_MISSING'});expect(f.calls).not.toContain('capture');
});
it('T-wait-return BF-3: a failed automatic cleanup stays latched, then explicit Return retries and retains the wait',async()=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);let shutdown=false,fail=true,cleanups=0,relaunches=0,shown=0,destroyed=0;
 const back=createBackupReturn({app:{quit(){},exit(){}},shutdownStarted:()=>shutdown,cleanup:async()=>{cleanups++;shutdown=true;if(fail)throw Error('cleanup failed');},relaunch:()=>{relaunches++;},takeProgress:()=>null,setTimer:()=>0});
 const host=f.make({shutdownStarted:()=>shutdown,relaunch:()=>back(),capture:async()=>{throw Error('BACKUP_FILE_IN_USE');}});
 const result=await runOfflineBackup({run:()=>host.resumeOffline(),abandon:()=>host.abandonOffline(),returnToWorkspace:back,shutdownStarted:()=>shutdown,showBackupMode:()=>{shown++;},destroyProgress:()=>{destroyed++;}});
 expect(result).toBe('backup-mode');expect([cleanups,relaunches,shown,destroyed]).toEqual([1,0,1,1]);const side=readFileSync(f.side,'utf8');expect(f.c().status().phase).toBe('waiting');
 await expect(back()).rejects.toThrow('cleanup failed');expect(cleanups).toBe(1);fail=false;const {explicitBackupReturn}=createRequire(import.meta.url)('../electron/backup-startup.mjs');await explicitBackupReturn(host,back);expect([cleanups,relaunches]).toEqual([2,1]);expect(readFileSync(f.side,'utf8')).toBe(side);
 const fresh=f.make();expect(fresh.reconcileStartup().phase).toBe('waiting');f.advance(900000);await fresh.tick();expect(f.c().status().phase).toBe('handoff-armed');
});

it.each(['quit','return'].flatMap(action=>['preflight','space','prepare','budget','cleanup','armed'].map(boundary=>({action,boundary}))))('T-stop-admission: automatic $action at $boundary keeps the old wait until handoff commits',async ({action,boundary})=>{
 const f=await rig();f.seedReceipt();f.setFree(1);await f.host.runNow(f.c().status().revision);await f.settle();const old=f.c().status(),saved=readFileSync(f.side,'utf8');f.setFree(100*GiB);
 let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});const pause=()=>{entered();return hold;};
 const hooks:Record<string,unknown>={};
 if(boundary==='preflight')hooks.readProtected=async()=>{await pause();return f.base.readProtected();};
 if(boundary==='space')hooks.freeBytes=async()=>{await pause();return 100*GiB;};
 if(boundary==='prepare')hooks.prepare=async()=>{await pause();return async()=>{f.calls.push('release');};};
 if(boundary==='budget')hooks.chooseBudget=async()=>{await pause();return 60000;};
 if(boundary==='cleanup')hooks.cleanupIdle=pause;
 const coordinator=f.c();let h:ReturnType<typeof createBackupScheduleHost>,finishStop!:()=>Promise<void>;
 if(boundary==='armed'){const arm=coordinator.armHandoff.bind(coordinator);vi.spyOn(coordinator,'armHandoff').mockImplementation(id=>{const result=arm(id);finishStop=desktopStop(h,action);return result;});hooks.coordinator=coordinator;}
 h=f.make(hooks);h.reconcileStartup();const pending=h.tick();
 if(boundary!=='armed'){await ready;finishStop=desktopStop(h,action);await expect(h.runNow(old.revision)).rejects.toThrow('BUSY');release();}
 await pending;await finishStop();expect(f.calls).not.toContain('backup');
 if(['cleanup','armed'].includes(boundary)){expect(f.c().status().job!.id).not.toBe(old.job!.id);expect(f.c().status().phase).toBe('needs-review');}
 else {expect(f.c().status().job!.id).toBe(old.job!.id);expect(readFileSync(f.side,'utf8')).toBe(saved);}
 f.verifyArtifacts();
});
it('BF-1: Stop immediately after manual commit cancels the new ID; reused daily work is not a manual',async()=>{
 const f=await rig();const c=f.c();let h:ReturnType<typeof createBackupScheduleHost>;
 const request=c.requestManual.bind(c);vi.spyOn(c,'requestManual').mockImplementation((...args)=>{const result=request(...args);h.noteStop();return result;});h=f.make({coordinator:c});
 await expect(h.runNow(c.status().revision)).rejects.toThrow('STOPPED');expect(c.status().phase).toBe('skipped');expect(c.committedState().job?.error).toBe('cancelled');expect(f.calls).not.toContain('backup');
 const daily=await rig({enabled:true});daily.advance(3600001);await daily.c().tick();const dc=daily.c(),id=dc.status().job!.id;
 const cancel=vi.spyOn(dc,'cancelManual');let dh:ReturnType<typeof createBackupScheduleHost>;dh=daily.make({coordinator:dc,prepare:async()=>{dh.noteStop();return async()=>{};}});
 await expect(dh.runNow(dc.status().revision)).rejects.toThrow('STOPPED');expect(cancel).not.toHaveBeenCalled();expect(dc.status().job!.id).toBe(id);
});
it.each([0,1])('T-stop-late: Stop in retry delay %i prevents another wait write',async stopDelay=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);const c=f.c();let tries=0,delays=0;let h:ReturnType<typeof createBackupScheduleHost>;
 vi.spyOn(c,'waitHandoff').mockImplementation(()=>{tries++;throw Error('BACKUP_COORDINATOR_BUSY');});
 h=f.make({coordinator:c,capture:async()=>{throw Error('BACKUP_FILE_IN_USE');},pause:async()=>{if(delays++===stopDelay)h.noteStop();}});
 await expect(h.resumeOffline()).rejects.toThrow('REVIEW_REQUIRED');expect(tries).toBe(stopDelay+1);expect(c.status().phase).toBe('needs-review');expect(c.status().waiting).toBeUndefined();f.verifyArtifacts();
});
it('T-lease: exhausted wait and review writes retain the marker for fresh startup',async()=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);const c=f.c();let tries=0;
 vi.spyOn(c,'waitHandoff').mockImplementation(()=>{tries++;throw Error('BACKUP_COORDINATOR_BUSY');});vi.spyOn(c,'failHandoff').mockImplementation(()=>{throw Error('BACKUP_COORDINATOR_BUSY');});
 const h=f.make({coordinator:c,capture:async()=>{throw Error('BACKUP_FILE_IN_USE');},pause:async()=>{}});
 await expect(h.resumeOffline()).rejects.toThrow('REVIEW_REQUIRED');expect(tries).toBe(5);expect(c.status().phase).toBe('capturing');expect(c.status().waiting).toBeUndefined();
 expect(f.make().reconcileStartup()).toMatchObject({phase:'needs-review'});expect(f.c().status().captureFailure?.code).toBe('BACKUP_FILE_IN_USE');
});
it.each(['quit','return','timeout','shutdown'])('T-A5: %s during capture never commits a passing wait',async stop=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);let h:ReturnType<typeof createBackupScheduleHost>;
 h=f.make({shutdownStarted:()=>stop==='shutdown',capture:async()=>{if(stop==='timeout')h.abandonOffline();else if(stop!=='shutdown')h.noteStop();throw Error('BACKUP_DISK_FULL');}});
 await expect(h.resumeOffline()).rejects.toThrow('REVIEW_REQUIRED');expect(f.c().status().waiting).toBeUndefined();expect(f.c().status().phase).toBe('needs-review');if(stop==='timeout')expect(f.c().status().captureFailure?.code).toBe('RECOVERY_WORKER_TIMEOUT');
});
it('T-wait-return: a committed wait signals only after normal return resolves; closed failures never relaunch',async()=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);let release!:()=>void,entered!:()=>void,settled=false;
 const ready=new Promise<void>(resolve=>{entered=resolve;});const h=f.make({capture:async()=>{throw Error('BACKUP_FILE_IN_USE');},relaunch:async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});}});
 const pending=h.resumeOffline().catch((error:Error)=>{settled=true;return error.message;});await ready;expect(settled).toBe(false);expect(f.c().status().phase).toBe('waiting');release();expect(await pending).toBe('BACKUP_WAITING');
 const closed=await rig({enabled:true,closed:true});closed.advance(3600001);expect((await closed.make({capture:async()=>{throw Error('BACKUP_FILE_IN_USE');}}).runClosedDue()).status).toBe('not-due');expect(closed.calls).not.toContain('normal');expect(closed.c().committedState().lastClosedResult?.status).toBe('not-due');
});
it.each(['tick','manual','closed','resume'])('T-side-read: corrupted side data blocks host %s without evidence changes',async entry=>{
 const f=await rig({enabled:true,closed:true});await f.host.runNow(f.c().status().revision);const main=readFileSync(f.main,'utf8');writeFileSync(f.side,'{');const h=f.make();
 if(entry==='tick')await h.tick();else if(entry==='closed')expect((await h.runClosedDue()).reason).toBe('state-unavailable');else await expect(entry==='manual'?h.runNow(1):h.resumeOffline()).rejects.toThrow('STATE_UNAVAILABLE');
 expect(readFileSync(f.main,'utf8')).toBe(main);expect(readFileSync(f.side,'utf8')).toBe('{');expect(f.calls).not.toContain('capture');f.verifyArtifacts();
});

import {canonicalUpdateDescriptor} from '../shared/update-candidate.mjs';
it('T-upgrade: a waiting job can be replaced for an update, but short space reviews without restarting',async()=>{
 const f=await rig({enabled:true});f.seedReceipt();f.setFree(1);await f.host.runNow(f.c().status().revision);await f.settle();
 const sha512=Buffer.alloc(64,1).toString('base64');const candidate={schemaVersion:1 as const,candidateId:'update-'+ '0'.repeat(64),version:'9.0.0',platform:'darwin' as const,arch:'arm64' as const,artifacts:[{kind:'primary' as const,sha512}],manifestDigests:[sha512]};candidate.candidateId='update-'+digest(canonicalUpdateDescriptor(candidate));
 await expect(f.make().requestUpgrade(candidate)).rejects.toThrow('BACKUP_DISK_FULL');expect(f.c().status().phase).toBe('needs-review');expect(f.c().status().captureFailure).toEqual({stage:'precondition',code:'BACKUP_DISK_FULL'});expect(f.c().status().waiting).toBeUndefined();expect(f.calls).not.toContain('prepare');expect(f.calls).not.toContain('backup');
});
it('T-concurrent: a manual preflight revalidates the exact job before replacement',async()=>{
 const f=await rig();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const h=f.make({readProtected:async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return f.base.readProtected();}});
 const pending=h.runNow(f.c().status().revision);await ready;const replacement=f.c().requestManual(f.c().status().revision,randomUUID());const saved=readFileSync(f.main,'utf8');release();
 // The second protected read is also deliberately held, then released.
 await new Promise(resolve=>setImmediate(resolve));release();await expect(pending).rejects.toThrow('BUSY');expect(readFileSync(f.main,'utf8')).toBe(saved);expect(f.c().status().job!.id).toBe(replacement.job!.id);
});

it.each(['quit','return'])('T-stop-admission: %s after transfer but before a successful worker reply reviews the active owner',async action=>{
 const f=await rig();await f.host.runNow(f.c().status().revision);let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const next=f.make({capture:async(request:{output:string})=>{entered();await new Promise<void>(resolve=>{release=resolve;});return f.base.capture(request);}});
 const pending=next.resumeOffline();await ready;const finishStop=desktopStop(next,action);release();await expect(pending).rejects.toThrow('REVIEW_REQUIRED');await finishStop();expect(f.c().status().phase).toBe('needs-review');expect(f.c().status().lastVerified).toBeUndefined();expect(f.c().status().waiting).toBeUndefined();f.verifyArtifacts();
});
it('T-citations T-nothing-deletes: physical path facts and the raw/effective boundary stay explicit',()=>{
 const capture=readFileSync(new URL('./installation-encrypted-backup.ts',import.meta.url),'utf8'),work=readFileSync(new URL('./backup-local-work.ts',import.meta.url),'utf8');
 const host=readFileSync(new URL('../electron/backup-schedule-host.mjs',import.meta.url),'utf8'),coordinator=readFileSync(new URL('./backup-coordinator.ts',import.meta.url),'utf8');
 expect(capture).toContain('mkdtempSync(join(parent,".murage-encrypted-write-"))');expect(capture).toContain('createBackupWork(sourceRoot)');expect(work).toContain('.murage-backup-work');
 expect(host).toContain('path.dirname(realpathSync(host.installation()))');expect(host).toContain('spaceRequirement(await spaceInputs(s,b))');expect(host).not.toMatch(/\b(?:unlinkSync|rmSync)\(/);
 expect(coordinator).toContain('private readRaw():State');expect(coordinator).toContain('private readContext()');expect(coordinator).toContain('stateSchema.parse(state)');
});

import {createRequire,syncBuiltinESMExports} from 'node:module';
import {symlinkSync} from 'node:fs';
it.each((['due','handoff-armed'] as const).flatMap(phase=>['malformed','inconsistent','oversized','symlink','directory','EACCES','EIO'].map(kind=>({phase,kind}))))('T-side-read: torn $phase with $kind blocks every entry until the learned floor is restored',async({phase,kind})=>{
 const f=await rig({enabled:true,closed:true});await f.host.runNow(f.c().status().revision);
 const original=JSON.parse(readFileSync(f.main,'utf8'));original.job.phase=phase;if(phase==='due')delete original.job.handoff;
 const state=f.c().status();f.c().waitHandoff(state.job!.id,{cause:'space',code:'BACKUP_DISK_FULL',drive:'backup'},{destinationRef:state.schedule.destinationRef!,at:f.now(),layout:'split',mode:'pinned',floors:{backup:200*GiB}});
 const valid=readFileSync(f.side,'utf8');writeFileSync(f.main,JSON.stringify(original));const raw=readFileSync(f.main,'utf8');
 const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),read=fs.readFileSync;
 if(kind==='symlink'||kind==='directory'){rmSync(f.side);if(kind==='symlink')symlinkSync(f.main,f.side);else mkdirSync(f.side);}
 else if(!['EACCES','EIO'].includes(kind))writeFileSync(f.side,kind==='malformed'?'{':kind==='oversized'?' '.repeat(128*1024+1):JSON.stringify({version:2,wait:{jobId:state.job!.id}}));
 else {fs.readFileSync=((file,...args)=>{if(String(file)===f.side)throw Object.assign(Error('read failed'),{code:kind});return read(file,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();}
 const before=f.calls.length;
 try{
  const h=f.make();expect(h.reconcileStartup().blocked).toBe(true);await h.tick();expect((await h.runClosedDue()).reason).toBe('state-unavailable');
  await expect(h.runNow(state.revision)).rejects.toThrow('STATE_UNAVAILABLE');await expect(h.resumeOffline()).rejects.toThrow('STATE_UNAVAILABLE');
  expect(readFileSync(f.main,'utf8')).toBe(raw);expect(f.calls.slice(before)).toEqual([]);f.verifyArtifacts();
 }finally{fs.readFileSync=read;syncBuiltinESMExports();}
 if(kind==='symlink'||kind==='directory')rmSync(f.side,{recursive:kind==='directory'});writeFileSync(f.side,valid);
 const recovered=f.make();expect(recovered.reconcileStartup().phase).toBe('waiting');expect(f.c().status().room!.floors.backup).toBe(200*GiB);
 await recovered.tick();expect(f.c().status().phase).toBe('waiting');expect(f.calls.slice(before)).toEqual([]);expect(readFileSync(f.side,'utf8')).toBe(valid);
 f.setFree(250*GiB);await recovered.tick();expect(f.c().status().phase).toBe('handoff-armed');expect(f.calls.slice(before).filter(x=>x==='backup')).toHaveLength(1);f.verifyArtifacts();
});

import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
it.each(['settled','daily','manual','capturing','armed'])('T-downgrade: BASE18 host dispatch bounds %s and recovers next daily',async kind=>{
 const f=await rig({enabled:true});
 if(kind==='manual')f.c().requestManual(f.c().status().revision,randomUUID());
 else {f.advance(3600001);await f.c().tick();}
 if(kind==='armed'||kind==='capturing')await f.host.runNow(f.c().status().revision);
 if(kind==='capturing'||kind==='daily'){const raw=JSON.parse(readFileSync(f.main,'utf8'));raw.job.phase=kind==='daily'?'due':'capturing';writeFileSync(f.main,JSON.stringify(raw));}
 const raw=readFileSync(f.main,'utf8'),job=f.c().status().job!;
 if(kind==='armed'||kind==='capturing')f.c().waitHandoff(job.id,{cause:'busy',code:'BACKUP_FILE_IN_USE',drive:null});
 else f.c().waitJob(job.id,{cause:'space',code:'BACKUP_DISK_FULL',drive:'backup'});
 if(kind!=='settled')writeFileSync(f.main,raw);
 // A historical build must never parse the new side format, including corruption.
 writeFileSync(f.side,'{not-readable-by-new-build');
 const require=createRequire(import.meta.url);
 const historical=(file:string)=>{
  let source=readFileSync(new URL('./testing/fixtures/backup-base-1.0.18/'+file+'.txt',import.meta.url),'utf8');
  source=source.replace(/from ["'](\.\.?\/[^"']+)["']/g,(_all,relative:string)=>`from "${pathToFileURL(resolve(dirname(file),relative)).href}"`);
  source=source.replace('from "zod"',`from "${pathToFileURL(require.resolve('zod')).href}"`);
  const target=join(f.root,kind+'-'+file.split('/').pop()!.replace('.ts','.mjs'));
  writeFileSync(target,file.endsWith('.ts')?stripTypeScriptTypes(source):source);return pathToFileURL(target).href;
 };
 const coordinator=historical('server/backup-coordinator.ts'),host=historical('electron/backup-schedule-host.mjs');
 const script=`
 import {writeFileSync} from 'node:fs';import {createHash,randomUUID} from 'node:crypto';
 const {BackupCoordinator}=await import(${JSON.stringify(coordinator)});
 const {createBackupScheduleHost}=await import(${JSON.stringify(host)});
 let now=${f.now()},captures=0,fail=true;const events=[];
 const c=new BackupCoordinator({stateDirectory:${JSON.stringify(f.options.stateDirectory)},now:()=>now});
 const h=createBackupScheduleHost({coordinator:c,installation:()=>${JSON.stringify(f.data)},now:()=>now,supported:()=>true,
 readProtected:async()=>${JSON.stringify(await f.base.readProtected())},
 prepare:async()=>{events.push('prepare');return async()=>{};},cleanupIdle:async()=>{},relaunch:async mode=>{events.push(mode);},
 capture:async request=>{captures++;if(fail)throw Error('SOURCE_CHANGED');const bytes=Buffer.from('fixture');
 writeFileSync(request.output,bytes,{flag:'wx'});return {ok:true,operation:'backup-encrypted',path:request.output,sha256:createHash('sha256').update(bytes).digest('hex'),snapshotId:randomUUID(),coverage:{scope:'application-data',fullInstallation:false}};}});
 async function dispatch(){if(c.status().phase==='handoff-armed'){try{await h.resumeOffline();}catch{}}else await h.tick();
 if(c.status().phase==='handoff-armed'){try{await h.resumeOffline();}catch{}}}
 await dispatch();const first={phase:c.status().phase,captures};await dispatch();await dispatch();const repeated=captures;
 if(c.status().phase==='needs-review')c.clearReview(c.status().revision);
 now+=86400000;fail=false;await dispatch();const tomorrow={phase:c.status().phase,captures};await dispatch();
 h.stopPolling();console.log(JSON.stringify({first,repeated,tomorrow,final:captures,events}));
 `;
 const result=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{ windowsHide: true,encoding:'utf8'}));
 const expected=kind==='daily'||kind==='armed'?1:0;
 expect(result.first.captures).toBe(expected);
 expect(result.first.phase).toBe(['daily','armed','capturing'].includes(kind)?'needs-review':'skipped');
 expect(result.repeated).toBe(expected);expect(result.tomorrow).toEqual({phase:'return-pending',captures:expected+1});expect(result.final).toBe(expected+1);
 expect(readFileSync(f.side,'utf8')).toBe('{not-readable-by-new-build');f.verifyArtifacts();
});

it.each(['quit','return'].flatMap(action=>['preflight','committed','space','prepare','cleanup'].flatMap(boundary=>(boundary==='preflight'?[false]:[false,true]).map(leaseLost=>({action,boundary,leaseLost})))))('T-stop-admission BF-5: $action at upgrade $boundary leaseLost=$leaseLost',async ({action,boundary,leaseLost})=>{
 const f=await rig({enabled:true});await f.host.runNow(f.c().status().revision);
 f.setFree(1);await expect(f.make({capture:async()=>{throw Error('BACKUP_DISK_FULL');}}).resumeOffline()).rejects.toThrow('BACKUP_WAITING');
 const old=f.c().status(),main=readFileSync(f.main,'utf8'),side=readFileSync(f.side,'utf8');f.calls.length=0;f.setFree(100*GiB);
 let refuse=false;const c=new BackupCoordinator({...f.options,acquire:()=>{if(refuse)throw Error('lease refused');return {release(){}};}});
 const cancel=vi.spyOn(c,'cancelManual'),arm=vi.spyOn(c,'armHandoff'),fail=vi.spyOn(c,'failHandoff'),prepare=c.prepareUpgrade.bind(c);
 let h:ReturnType<typeof createBackupScheduleHost>,finishStop:()=>Promise<void>=async()=>{};
 const stop=()=>{finishStop=desktopStop(h,action);refuse=leaseLost;};
 const hooks:Record<string,unknown>={coordinator:c};
 if(boundary==='preflight')hooks.assertUpgradeAllowed=async()=>{stop();};
 if(boundary==='space')hooks.freeBytes=async()=>{stopOnce();return 100*GiB;};
 let stopped=false;const stopOnce=()=>{if(!stopped){stopped=true;stop();}};
 if(boundary==='prepare')hooks.prepare=async()=>{stop();return async()=>{expect(h.isPreparing()).toBe(true);f.calls.push('release');};};
 if(boundary==='cleanup')hooks.cleanupIdle=async()=>{stop();};
 const commit=vi.spyOn(c,'prepareUpgrade').mockImplementation((...args)=>{const result=prepare(...args);if(boundary==='committed')stop();return result;});
 h=f.make(hooks);
 const sha512=Buffer.alloc(64,1).toString('base64'),candidate={schemaVersion:1 as const,candidateId:'update-'+'0'.repeat(64),version:'9.0.0',platform:'darwin' as const,arch:'arm64' as const,artifacts:[{kind:'primary' as const,sha512}],manifestDigests:[sha512]};
 candidate.candidateId='update-'+digest(canonicalUpdateDescriptor(candidate));
 await expect(h.requestUpgrade(candidate)).rejects.toThrow('STOPPED');await finishStop();
 expect(cancel).not.toHaveBeenCalled();expect(arm).not.toHaveBeenCalled();expect(f.calls).not.toContain('backup');expect(f.calls).not.toContain('capture');expect(h.isPreparing()).toBe(false);
 const state=f.c().status();expect(state.room).toEqual(old.room);
 if(boundary==='preflight'){expect(commit).not.toHaveBeenCalled();expect(fail).not.toHaveBeenCalled();expect(readFileSync(f.main,'utf8')).toBe(main);expect(readFileSync(f.side,'utf8')).toBe(side);}
 else{
  expect(state.job!.id).not.toBe(old.job!.id);expect(state.waiting).toBeUndefined();expect(fail).toHaveBeenCalledWith(state.job!.handoff!.id);
  const marker=JSON.parse(readFileSync(join(f.options.stateDirectory,'backup-handoff-failure.json'),'utf8'));
  expect(marker).toMatchObject({job:state.job!.id,handoff:state.job!.handoff!.id,code:'SNAPSHOT_CANCELLED'});
  expect(state.phase).toBe(leaseLost&&action==='quit'?'handoff-prepared':'needs-review');
  expect(f.c().committedState().seen).toContain(old.job!.occurrence);
  if(['prepare','cleanup'].includes(boundary))expect(f.calls).toContain('release');
  const fresh=f.make();expect(fresh.reconcileStartup().phase).toBe('needs-review');await fresh.tick();await expect(fresh.resumeOffline()).rejects.toThrow('REVIEW_REQUIRED');expect(f.calls).not.toContain('capture');expect(f.c().status().room).toEqual(old.room);
 }
 f.verifyArtifacts();
});
it.each(['offer','hops'] as const)('BW-B9: an applicable wait with invalid %s metadata pauses startup for review instead of blocking every launch',async kind=>{
 const f=await rig();f.seedReceipt();await f.host.runNow(f.c().status().revision);
 f.setFree(12*GiB);
 await expect(f.make({capture:async()=>{throw Object.assign(Error('BACKUP_DISK_FULL'),{captureStep:'encrypt'});}}).resumeOffline()).rejects.toThrow('BACKUP_WAITING');
 const raw=JSON.parse(readFileSync(f.main,'utf8'));
 if(kind==='offer')raw.installerOffer={handoffId:7};else raw.landedHops={candidate:{explicitCount:-1}};
 writeFileSync(f.main,JSON.stringify(raw));
 const bit=kind==='offer'?'offerInvalid':'hopsInvalid';
 expect(f.c().status()[bit]).toBe(true);expect(f.c().status().phase).toBe('waiting');
 const {backupStartupDispatch}=createRequire(import.meta.url)('../electron/backup-startup.mjs');
 const first=backupStartupDispatch({host:f.make()});
 expect(first).toMatchObject({blocked:false,phase:'waiting',[bit]:true});
 // Startup got the review once; the saved projection no longer blocks Return or the next launch.
 expect(f.c().status()[bit]).toBeUndefined();
 const again=f.make();expect(again.reconcileStartup()).toMatchObject({blocked:false});expect(again.reconcileStartup()[bit]).toBeUndefined();
 await expect(explicitBackupReturn(again,{retry:async()=>{}})).resolves.toBeUndefined();
 const main=readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8');
 const blocked=main.indexOf('if(backupDispatch.blocked)'),pause=main.indexOf('if(backupDispatch.offerInvalid||backupDispatch.hopsInvalid){ensureDesktopUpdater(false);pauseForReview("BACKUP_UPGRADE_REVIEW_REQUIRED");return;}');
 expect(blocked).toBeGreaterThan(0);expect(pause).toBeGreaterThan(blocked);expect(pause).toBeLessThan(main.indexOf('if(backupDispatch.route==="offline")'));
 f.verifyArtifacts();
});
