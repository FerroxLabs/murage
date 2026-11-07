// Run with the packaged Electron executable in a private, marked fixture directory.
import {app} from "electron";
import {readFileSync,appendFileSync,realpathSync} from "node:fs";
import path from "node:path";
const directory=realpathSync(process.env.MURAGE_MACWD_LOCK_FIXTURE??"");
if(readFileSync(path.join(directory,"fixture-marker"),"utf8")!=="macwd-lock-fixture\n")throw Error("private fixture required");
app.setPath("userData",directory);
const source=readFileSync(new URL("../../electron/main.mjs",import.meta.url),"utf8");
const {runStartupBoundary}=await import('./startup-boundary.mjs');
const note=value=>appendFileSync(path.join(directory,"events.jsonl"),JSON.stringify({pid:process.pid,version:process.env.MURAGE_MACWD_ROLE,event:value})+"\n");
const instrument=fn=>new Proxy(fn,{apply(target,self,args){note(target.name);return Reflect.apply(target,self,args);}});
const operations={
 acquireDesktopDataOwner(){return {};},
 pendingUpgrade(){return {phase:'install-requested',candidate:{version:'2.0.0'}};},
 settleRequestedInstall(){return {kind:'review'};},
 completeUpgrade(){},
};
const host=Object.fromEntries(Object.entries(operations).map(([key,fn])=>[key,instrument(fn)]));host.internalStatus=()=>({phase:'install-requested'});
await runStartupBoundary(source,{app:{requestSingleInstanceLock:()=>app.requestSingleInstanceLock(),isPackaged:true,getVersion:()=>process.env.MURAGE_MACWD_ROLE==='candidate'?'2.0.0':'1.0.0',getLocale:()=> 'en'},closedBackupRequested:false,console:{log(){}},process:{platform:'darwin',exit:code=>{note('loser-exit');process.exit(code);}},acquireDesktopDataOwner:host.acquireDesktopDataOwner,initializeSentinelHost:async()=>{},initializeBackupScheduleHost:async()=>{},desktopMark(){},announceLastBackupFailure(){},announceLastBackupResult(){},backupScheduleHost:host,ensureDesktopUpdater:()=>({}),backupToolCheck:Promise.resolve(),desktopStartup:app.whenReady(),startupSplash:{set(){}},updateRecoveryWords:()=>({}),startUpdateGate:()=>host.settleRequestedInstall(),pauseForReview(){}});
note('winner-ready');
setTimeout(()=>app.exit(0),10000);
