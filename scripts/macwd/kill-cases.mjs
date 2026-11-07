// Mac GUI only. All profiles and the instrumented app copy are disposable.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,existsSync,cpSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron} from '@playwright/test';
import {closedControlDirectory} from '../../electron/backup-closed-controller.mjs';
import {dataDirLeasePaths,inspectDataDirLease} from '../../electron/data-dir-lease.mjs';
import {killPhases,resolveApp,processTree,parseProcesses,waitForKilledProcesses,compareDestination,classifyWindow} from './kill-support.mjs';

const isWorkspace=url=>classifyWindow(url)==='workspace';
const delay=()=>new Promise(resolve=>setTimeout(resolve,100));
async function until(check,message,timeout=120000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await check();if(value)return value;await delay();}
 throw Error(message);
}
const json=file=>JSON.parse(readFileSync(file,'utf8'));

async function checkedWorkspace(running){
 let workspace;
 for(const window of running.windows()){
  let code;
  try{code=await window.evaluate(()=>document.getElementById('error')?.dataset.code??'');}
  catch(error){
   if(window.isClosed()||/Execution context was destroyed/.test(String(error)))continue;
   throw error;
  }
  assert.notEqual(code,'LEASE_CHILD_BUSY','relaunch hit child lease recovery');
  const kind=classifyWindow(window.url(),code);
  assert.notEqual(kind,'recovery',`startup must leave recovery/update pause (${code||window.url()})`);
  if(kind==='workspace')workspace=window;
 }
 return workspace;
}

function processes(){
 const result=spawnSync('ps',['-axo','pid=,ppid=,stat='],{encoding:'utf8'});
 assert.equal(result.status,0,'process snapshot required');return parseProcesses(result.stdout);
}
function signal(pid,signal){try{process.kill(pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
async function killAppTree(pid,data){
 // Freeze each discovered descendant before re-snapshotting. A child cannot
 // fork between our final snapshot and the kill once the whole tree is stopped.
 const owned=new Set();
 const childLease=dataDirLeasePaths(data).childLeasePath;
 const holder=existsSync(childLease)?json(childLease).pid:null;
 await until(()=>{
  const rows=processes();
  for(const child of processTree(pid,rows)){if(!owned.has(child)){owned.add(child);signal(child,'SIGSTOP');}}
  const after=processes();
  const descendants=processTree(pid,after);
  return descendants.every(child=>owned.has(child))&&after.filter(row=>owned.has(row.pid)).every(row=>/[TZ]/.test(row.stat));
 },'app tree could not be stopped');
 if(holder&&processes().some(row=>row.pid===holder&&!row.stat.includes('Z')))
  assert.ok(owned.has(holder),'live lease holder must belong to launched process tree');
 for(const child of [...owned].reverse())signal(child,'SIGKILL');
 await waitForKilledProcesses({pids:[...owned,...(holder?[holder]:[])],processes,
  inspectLease:()=>inspectDataDirLease(data)});
 return [...owned];
}

function qualificationCopy(source,root){
 const app=path.join(root,'Murage.app');cpSync(source,app,{recursive:true});
 const server=path.join(app,'Contents/Resources/server');
 const coordinator=path.join(server,'backup-coordinator.js');
 assert.ok(existsSync(coordinator),'packaged coordinator required');
 renameSync(coordinator,path.join(server,'macwd-original-coordinator.js'));
 for(const name of ['kill-support.mjs','qualification-hook.mjs'])copyFileSync(fileURLToPath(new URL(name,import.meta.url)),path.join(server,name));
 writeFileSync(coordinator,`import {BackupCoordinator} from './macwd-original-coordinator.js';
import {installQualification} from './qualification-hook.mjs';
if(process.type==='browser'){const {app}=await import('electron');installQualification(BackupCoordinator,app);}
export * from './macwd-original-coordinator.js';\n`);
 // Keep every executable's original signature and bytes. Re-signing ad-hoc
 // would discard the team identity required by the backup tool attestation.
 // Only external JavaScript resources in this disposable copy are instrumented.
 return path.join(app,'Contents/MacOS/Murage');
}

export async function qualifyKillCases(input='.'){
 if(process.platform!=='darwin')throw Error('Kill qualification requires a Mac');
 const source=resolveApp(input,existsSync);
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'macwd-kill-')));
 console.log('Kill case evidence: '+root);
 const executable=qualificationCopy(source,root);
 for(const phase of killPhases){
  const directory=path.join(root,phase),data=path.join(directory,'data'),user=path.join(directory,'user'),home=path.join(directory,'home'),destination=path.join(directory,'backups');
  for(const dir of [data,user,home,destination,path.join(home,'Documents')])mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(closedControlDirectory(data),'backup-coordinator.json');
  const committed=path.join(directory,'committed.json'),relaunch=path.join(directory,'relaunch.json');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('MURAGE_')&&!k.startsWith('ELECTRON_')));
  Object.assign(env,{HOME:home,MURAGE_DATA_DIR:data,MURAGE_USER_DATA:user,MURAGE_MACWD_CASE:directory});
  const launch=()=>_electron.launch({executablePath:executable,args:[],env,timeout:60000});
  let running,offline;
  const workspace=async()=>until(()=>checkedWorkspace(running),'isolated workspace did not open');
  const exited=async child=>until(()=>child.exitCode!==null||child.signalCode!==null,'app did not exit');
  // Relaunch interception changes only who spawns the next process. Cleanup,
  // arming, offline claim, capture and receipt verification remain app code.
  const nextLaunch=async()=>{
   await until(()=>existsSync(relaunch),'app did not request a relaunch');
   const request=json(relaunch);unlinkSync(relaunch);
   assert.ok(Array.isArray(request.args),'app relaunch args required');
   assert.ok(!request.execPath||request.execPath===executable,'unexpected relaunch executable');
   return request.args;
  };
  const startBackup=async()=>{
   const page=await workspace();
   const status=await until(async()=>{
    const status=await page.evaluate(()=>window.muragebox.backupSchedule.status());
    return status.supported&&!status.checking&&!status.pending?status:null;
   },'backup host did not become ready');
   // The request closes this renderer. Observe its result on disk, and retain
   // any rejection so a refused request cannot pass as an interrupted backup.
   void page.evaluate(revision=>window.muragebox.backupSchedule.runNow(revision),status.revision)
    .catch(error=>writeFileSync(path.join(directory,'run-now.log'),String(error)));
  };
  try{
   running=await launch();await workspace();
   // Answer only the expected setup dialogs in this isolated process.
   await running.evaluate(({app,dialog},{destination,home})=>{
    app.setPath('home',home);
    dialog.showOpenDialog=async(...args)=>{const options=args.at(-1);if(options.title!=='Choose scheduled backup destination')throw Error('Unexpected picker');return {canceled:false,filePaths:[destination]};};
    dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options.buttons?.[1]!=='Back up every day')throw Error('Unexpected confirmation');return {response:1,checkboxChecked:false};};
   },{destination,home});
   const page=await workspace();
   await until(async()=>{const s=await page.evaluate(()=>window.muragebox.backupSchedule.status());return s.supported&&!s.checking;},'backup tool unavailable');
   const setup=await page.evaluate(()=>window.muragebox.backupSchedule.setUp());
   assert.ok(!setup.cancelled,'backup setup must complete');
   await page.evaluate(async setup=>{
    const {installationRef,destinationRef,recoveryRef}=setup.refs;
    const time=new Date(Date.now()+12*60*60*1000).toISOString().slice(11,16);
    const enabled=await window.muragebox.backupSchedule.configure(setup.revision,{
     enabled:true,installationRef,destinationRef,recoveryRef,timezone:'UTC',time,catchupMs:60000,
     maxBytes:1024*1024*1024,maxDurationMs:30*60000,
     selection:{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'},allowIdleRestart:true,
    });
    const deadline=Date.now()+10000;
    while((await window.muragebox.backupSchedule.status()).pending){
     if(Date.now()>deadline)throw Error('initial schedule tick did not settle');
     await new Promise(resolve=>setTimeout(resolve,50));
    }
    await window.muragebox.backupSchedule.configure(enabled.revision,{...enabled.schedule,enabled:false});
   },setup);
   // First create a genuine verified archive, using the app's configured folder.
   await startBackup();const args=await nextLaunch();await exited(running.process());running=undefined;
   offline=spawn(executable,args,{env,stdio:['ignore','pipe','pipe']});
   offline.stdout.pipe(process.stdout);offline.stderr.pipe(process.stderr);
   await nextLaunch();await exited(offline);offline=undefined;
   running=await launch();await workspace();
   const original=json(file);assert.ok(original.lastVerified,'app must verify a prior backup');
   const archives=readdirSync(destination).filter(n=>n.endsWith('.age')).map(n=>[n,readFileSync(path.join(destination,n))]);assert.ok(archives.length);
   assert.equal(original.lastVerified.destinationRef,setup.refs.destinationRef);
   assert.equal(original.schedule.destinationRef,setup.refs.destinationRef);
   const verified=archives.find(([name])=>name===original.lastVerified.artifactRef+'.age');
   assert.ok(verified,'receipt must name an archive in the configured backup destination');
   assert.equal(verified[1].length,original.lastVerified.bytes);
   assert.equal(createHash('sha256').update(verified[1]).digest('hex'),original.lastVerified.sha256);
   compareDestination(destination,archives,readFileSync);
   writeFileSync(path.join(directory,'stop-phase'),phase);
   await startBackup();
   if(phase!=='handoff-prepared'){
    const args=await nextLaunch();await exited(running.process());running=undefined;
    offline=spawn(executable,args,{env,stdio:['ignore','pipe','pipe']});
    offline.stdout.pipe(process.stdout);offline.stderr.pipe(process.stderr);
   }
   const child=offline??running.process();
   await until(()=>existsSync(committed),'operation never committed requested phase');
   const boundary=json(committed);assert.equal(boundary.pid,child.pid);assert.equal(boundary.file,file);assert.equal(boundary.phase,phase);
   assert.equal(json(file).job.phase,phase);
   // Marker is emitted after the app's fsync, then the app stops itself.
   await until(()=>/T/.test(spawnSync('ps',['-o','stat=','-p',String(child.pid)],{encoding:'utf8'}).stdout),'app did not stop at commit');
   const killed=await killAppTree(child.pid,data);await exited(child);
   writeFileSync(path.join(directory,'killed-pids.json'),JSON.stringify(killed));
   running=undefined;offline=undefined;
   unlinkSync(path.join(directory,'stop-phase'));
   let saved;
   for(let restart=0;restart<2;restart++){
    running=await launch();const deadline=Date.now()+60000;
    while(json(file).job.phase!=='needs-review'){
     await checkedWorkspace(running);
     if(Date.now()>deadline)throw Error('Startup did not reach backup review');
     await delay();
    }
    const bytes=readFileSync(file,'utf8'),after=JSON.parse(bytes);
    assert.equal(after.job.error,'interrupted');assert.deepEqual(after.lastVerified,original.lastVerified);
    if(saved)assert.equal(bytes,saved);saved=bytes;
    let opened=false;
    while(!opened&&Date.now()<deadline){
     opened=Boolean(await checkedWorkspace(running));
     if(!opened)await delay();
    }
    assert.ok(opened,'workspace opens with backup review available');
    const page=running.windows().find(window=>isWorkspace(window.url()));
    const publicStatus=await page.evaluate(()=>window.muragebox.backupSchedule.status());
    assert.equal(publicStatus.phase,'needs-review');assert.equal(publicStatus.reviewReason,'interrupted');
    assert.deepEqual(publicStatus.lastVerified,original.lastVerified);
    if(restart===1){
     await page.evaluate(revision=>window.muragebox.backupSchedule.clearReview(revision),publicStatus.revision);
     const cleared=json(file);assert.equal(cleared.job,undefined);assert.deepEqual(cleared.lastVerified,original.lastVerified);
    }
    compareDestination(destination,archives,readFileSync);
    await running.close();running=undefined;
   }
   writeFileSync(path.join(directory,'passed.json'),JSON.stringify({phase,restarts:2,review:'interrupted',backupIntact:true}));
  }finally{
   if(offline&&offline.exitCode===null&&offline.signalCode===null){await killAppTree(offline.pid,data);await exited(offline);}
   if(running){await killAppTree(running.process().pid,data);await exited(running.process());}
  }
 }
 return root;
}
