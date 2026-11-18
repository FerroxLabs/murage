// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkFixtureMkdir, parkFixtureWrite, privateParkDirectory, protectParkFixtureTree, expectPrivateParkFile } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import * as parkFs from './park-fs.ts';
import { ParkFs, type ParkFsOptions } from './park-fs.ts';
import { type SecurityRunOptions, type SecurityRunner, windowsSecurityPathKey } from './storage.ts';
import { DATA_DIR } from '../../config.ts';
import { closeDatabase, database } from '../../database.ts';
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from '../../human-principals.ts';
import { ownerMemoryTicket } from '../../memory/authority.ts';
import { RoutineManager } from '../../routines.ts';
import { createSignalLocalAuthority } from './park-authority.ts';
import { keepBothAndLinkAgain } from './park-replacement.ts';
import { parkSignalForDowngrade } from './park.ts';
import { windowsSecuritySessionDebug } from './windows-security-session.ts';
import { flushCoalesced } from '../../atomic.ts';

const roots:string[]=[],managers:RoutineManager[]=[];
const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;;FA;;;SY)(A;;FA;;;${sid})`;
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
afterEach(()=>{vi.restoreAllMocks();managers.splice(0).forEach(manager=>manager.stop());closeDatabase();roots.splice(0).forEach(root=>removeTempDirSync(root));});
function put(path:string,value:unknown){parkFixtureMkdir(dirname(path),{recursive:true,mode:0o700});parkFixtureWrite(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}
function fixture(){
 const root=privateParkTemp(join(tmpdir(),'park-directory-race-'));roots.push(root);
 const directory=join(root,'within-root'),key=join(directory,'key');put(key,'FAKE-KEY');return{root,directory,key};
}
/** Adapt only native tool output. ParkFs still takes its real no-follow stats,
 * performs its entire batch/cache policy and uses the real filesystem. */
function nativeRows(opts:SecurityRunOptions){
 const output:Array<{path:string;attributes:number;sddl:string}>=[],seen=new Set<string>();
 const trees=JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]') as string[];
 function visit(path:string,recursive:boolean){
  const key=windowsSecurityPathKey(path);if(seen.has(key))return;seen.add(key);
  const stat=fs.lstatSync(path);output.push({path,attributes:(stat.isDirectory()?16:0)|(stat.isSymbolicLink()?0x400:0),sddl});
  if(recursive&&stat.isDirectory()&&!stat.isSymbolicLink())for(const name of fs.readdirSync(path))visit(join(path,name),true);
 }
 for(const path of JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]') as string[])visit(path,opts.env.MURAGE_SIGNAL_TREE===path||trees.includes(path));
 return output;
}
function windowsOptions(duringRead?:(opts:SecurityRunOptions)=>void):ParkFsOptions{
 const run:SecurityRunner=(exe,_args,opts)=>{
  if(exe.endsWith('whoami.exe'))return `"fixture\\owner","${sid}"`;
  if(opts.env.MURAGE_SIGNAL_NEW)return 'MURAGE_SIGNAL_PROTECTED';
  duringRead?.(opts);return nativeRows(opts).map(row=>JSON.stringify(row)).join('\n');
 };
 return{platform:'win32',windowsSid:()=>sid,windowsRun:run};
}
/** Native witnesses retain the real SID, resident reader and protection.
 * Linux keeps the modeled Windows runner; the race crosses the same snapshot seam. */
function raceOptions(beforeWindowsRead?:ParkFsOptions['beforeWindowsRead']):ParkFsOptions{
 return {...(process.platform==='win32'?{}:windowsOptions()),beforeWindowsRead};
}
function expectUnsafe(operation:()=>unknown){
 let error:unknown;try{operation();}catch(caught){error=caught;}
 expect(error).toBeInstanceOf(parkFs.SignalParkError);expect(error).toHaveProperty('reason','unsafe');
}
for(const code of ['EACCES','EPERM'])for(const phase of ['checked','cached','recursive-prefetch','after-native-read','direct-checked'] as const)
 test(`F8 Windows ${phase} lstat ${code} refuses with typed unsafe`,()=>{
  const {root}=fixture(),key=join(root,'signal/auth/key');put(key,'FAKE-KEY');
  let denied=phase==='recursive-prefetch',faults=0;
  const options=windowsOptions(),run=options.windowsRun!;
  options.prefetchWindowsPark=phase==='recursive-prefetch';
  options.stat=(path,opts)=>{
   if(path===key&&denied){faults++;throw Object.assign(new Error('protected reparse entry'),{code});}
   return fs.lstatSync(path,opts);
  };
  if(phase==='direct-checked')options.windowsEntry=path=>({path,attributes:fs.lstatSync(path).isDirectory()?16:128,sddl});
  if(phase==='recursive-prefetch'){
   expectUnsafe(()=>new ParkFs(root,options));
  }else{
   const io=new ParkFs(root,options);
   if(phase==='cached')expect(io.read(key).toString()).toBe('FAKE-KEY');
   if(phase==='after-native-read')options.windowsRun=(exe,args,opts)=>{
    const rows=run(exe,args,opts);
    if((JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]') as string[]).includes(key))denied=true;
    return rows;
   };else denied=true;
   expectUnsafe(()=>io.checked(key,true));
  }
  expect(faults).toBe(1);expect(fs.readFileSync(key,'utf8')).toBe('FAKE-KEY');
 });
test('F8 protected lstat preserves ENOENT absence and unexpected I/O errors',()=>{
 const {root,key}=fixture();let code='ENOENT';const options=windowsOptions();
 options.stat=(path,opts)=>{if(path===key)throw Object.assign(new Error('original I/O'),{code});return fs.lstatSync(path,opts);};
 const io=new ParkFs(root,options);expect(io.checked(key)).toBeNull();
 code='EIO';expect(()=>io.checked(key)).toThrow(expect.objectContaining({message:'original I/O',code:'EIO'}));
});
function createChild(directory:string){
 const before=fs.lstatSync(directory,{bigint:true});put(join(directory,'concurrent-child'),'FAKE-CHILD');
 // Force observable mtime drift even on a filesystem that coalesces mutations.
 fs.utimesSync(directory,new Date(),new Date(Number(before.mtimeMs)+2000));
 const after=fs.lstatSync(directory,{bigint:true});
 expect(after.dev).toBe(before.dev);expect(after.ino).toBe(before.ino);
 expect(after.mtimeNs).not.toBe(before.mtimeNs);
 return{before,after};
}
for(const entry of ['root','within-root directory'] as const)test(`F7 Windows ${entry} accepts a child created between lstat and the ACL batch`,()=>{
 const {root,directory,key}=fixture(),target=entry==='root'?root:directory;let injected=0;
 const options=raceOptions(paths=>{
  if(!injected&&paths.includes(target)){injected++;createChild(target);}
 });
 const io=new ParkFs(root,options);
 expect(io.read(key,64,true).toString()).toBe('FAKE-KEY');
 expect(injected).toBe(1);expect(fs.readFileSync(join(target,'concurrent-child'),'utf8')).toBe('FAKE-CHILD');
});
for(const field of ['ctime','mtime','size'] as const)test(`F7 Windows directory ${field} drift is not an identity change during the ACL batch`,()=>{
 const {root,directory}=fixture();let changed=false,injected=0;
 const options=windowsOptions(opts=>{if((JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[]).includes(directory))changed=true;});
 options.stat=(path,opts)=>{
  const stat=fs.lstatSync(path,opts);
  if(path===directory&&changed){injected++;if(field==='size')stat.size+=4096n;else{stat[`${field}Ns`]+=1_000_000_000n;stat[`${field}Ms`]+=1000n;}}
  return stat;
 };
 const io=new ParkFs(root,options);
 expect(()=>io.checked(directory)).not.toThrow();
 expect(io.checked(directory)?.isDirectory()).toBe(true);expect(injected).toBeGreaterThan(0);
});
for(const swap of ['inode','link','file'] as const)test(`F7 Windows directory ${swap} swap during the batch still gives changed`,()=>{
 const {root,directory}=fixture();let injected=0;
 const options=windowsOptions(),run=options.windowsRun!;
 options.windowsRun=(exe,args,opts)=>{
  const output=run(exe,args,opts);
  if(!injected&&(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]') as string[]).includes(directory)){
   injected++;fs.renameSync(directory,join(root,'original'));
   if(swap==='inode')parkFixtureMkdir(directory,{mode:0o700});
   else if(swap==='link')fs.symlinkSync(join(root,'original'),directory,'junction');
   else parkFixtureWrite(directory,'REPLACEMENT',{mode:0o600});
  }
  return output;
 };
 const io=new ParkFs(root,options);
 expect(()=>io.checked(directory)).toThrow('changed');expect(injected).toBe(1);
 expect(fs.readFileSync(join(root,'original/key'),'utf8')).toBe('FAKE-KEY');
});
for(const attack of ['reparse','broad-acl','foreign-owner','file-shape'] as const)test(`F7 fresh Windows directory batch detects changed ${attack} verdict on the same inode`,()=>{
 const {root,directory,key}=fixture(),options=windowsOptions(),run=options.windowsRun!;
 const io=new ParkFs(root,options);io.checked(directory);let injected=0;
 options.windowsRun=(exe,args,opts)=>run(exe,args,opts).split('\n').map(line=>{
  const row=JSON.parse(line);if(windowsSecurityPathKey(row.path)===windowsSecurityPathKey(directory)){
   injected++;if(attack==='reparse')row.attributes|=0x400;
   if(attack==='broad-acl')row.sddl+='(A;;FA;;;WD)';
   if(attack==='foreign-owner')row.sddl='O:S-1-5-21-9-9-9-1001D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-9-9-9-1001)';
   if(attack==='file-shape')row.attributes&=~16;
  }return JSON.stringify(row);
 }).join('\n');
 expect(()=>io['windowsWalk']([directory],false,true)).toThrow('changed');
 expect(injected).toBe(1);expect(fs.readFileSync(key,'utf8')).toBe('FAKE-KEY');
});
for(const field of ['ctime','mtime','size','ino'] as const)test(`F7 Windows regular file ${field} change during the ACL batch still gives changed`,()=>{
 const {root,key}=fixture();let changed=false,injected=0;
 const options=windowsOptions(opts=>{if((JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[]).includes(key))changed=true;});
 options.stat=(path,opts)=>{const stat=fs.lstatSync(path,opts);if(path===key&&changed){injected++;if(field==='mtime'||field==='ctime'){stat[`${field}Ns`]+=1_000_000_000n;stat[`${field}Ms`]+=1000n;}else stat[field]+=1n;}return stat;};
 const io=new ParkFs(root,options);expect(()=>io.checked(key)).toThrow('changed');expect(injected).toBe(1);
});

test('F7 Windows directory child mutation between windowsRow input and the fresh batch snapshot preserves identity',()=>{
 const {root,directory}=fixture();let reads=0,injected=0;
 const options=windowsOptions();
 options.stat=(path,opts)=>{
  if(path===directory&&[3,4].includes(++reads)){injected++;createChild(directory);}
  return fs.lstatSync(path,opts);
 };
 const io=new ParkFs(root,options);
 expect(()=>io.checked(directory)).not.toThrow();
 expect(injected).toBe(2);expect(io.checked(directory)?.isDirectory()).toBe(true);
});

test('F7 Windows directory identity normalizes a signed inode before and an unsigned inode after the batch',()=>{
 const {root,directory}=fixture();let changed=false,injected=0;
 const signed=-1161084278931400327n,unsigned=BigInt.asUintN(64,signed);
 const options=windowsOptions(opts=>{if((JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[]).includes(directory))changed=true;});
 options.stat=(path,opts)=>{const stat=fs.lstatSync(path,opts);if(path===directory){stat.ino=changed?unsigned:signed;injected++;}return stat;};
 const io=new ParkFs(root,options);expect(io.checked(directory)?.isDirectory()).toBe(true);expect(injected).toBeGreaterThan(1);
 expect(io['security'].get(io['pathKey'](directory))?.stat.ino).toBe(String(unsigned));
});

function authorityFixture(){
 closeDatabase();removeTempDirSync(DATA_DIR);privateParkDirectory(DATA_DIR);
 const manager=new RoutineManager({file:join(DATA_DIR,'routines.json'),emit:()=>{},botState:()=> 'ready',goalState:()=> 'ready',
  createTask:()=>({threadId:randomUUID()}),startTurn:async()=>{},interruptTurn:async()=>{},isChannelCurrent:()=>true,dispatchOpen:()=>false});
 managers.push(manager);return manager;
}
test('F7 RED34 win32 child mutation during Keep both construction still cancels the real queued run before fresh linking',async()=>{
 const manager=authorityFixture(),options={...raceOptions(),sync:()=> 'synced' as const,fence};
 put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});
 put(join(DATA_DIR,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 put(join(DATA_DIR,'signal/auth/key'),'FAKE-KEY');parkSignalForDowngrade(DATA_DIR,options);
 const bindingId=observeVerifiedHuman({platform:'signal',authorityId:'11111111-1111-4111-8111-111111111111',userId:'11111111-1111-4111-8111-111111111111',connectionId:'old'});
 linkHumanBinding(ownerMemoryTicket(),{bindingId,expectedRevision:1,as:'owner'});
 const queued=manager.enqueueWebhook({webhookId:'queued',webhookName:'fixture',prompt:'FAKE work',botId:'fixture',runOn:'ember',deliveryId:'queued',receivedAt:Date.now(),channelOrigin:{platform:'signal',connectionId:'old'},humanPrincipal:resolveHumanBinding(bindingId)});
 expect(manager.listRuns().find(run=>run.id===queued.id)?.status).toBe('queued');
 let injected=0,published=false;
 const nativeOptions=raceOptions(paths=>{
  if(!injected&&paths.includes(DATA_DIR)){injected++;createChild(DATA_DIR);}
 });
 // The replacement protocol uses its durability seam; the authority's
 // authority retains the unsupported directory verdict. The factory observes
 // the real constructor even when native module bindings bypass vi.spyOn.
 const constructed:ParkFs[]=[],RealParkFs=ParkFs;
 const authority=createSignalLocalAuthority(DATA_DIR,manager,()=>{},root=>{protectParkFixtureTree(root);const io=new RealParkFs(root,{...nativeOptions,sync:()=> 'unsupported'});constructed.push(io);return io;});
 protectParkFixtureTree(DATA_DIR);
 const requests=windowsSecuritySessionDebug().requests;
 const result=await keepBothAndLinkAgain(DATA_DIR,authority,{...options,after:(operation,path)=>{
  if(operation==='write'&&path===join(DATA_DIR,'channels/signal/connection.json')){
   published=true;expect(manager.listRuns().find(run=>run.id===queued.id)).toMatchObject({status:'cancelled',eventBudget:{closed:true}});
  }
 }});
 expect(result.state).toBe('ready');expect(injected).toBe(1);expect(published).toBe(true);
 expect(manager.listRuns().find(run=>run.id===queued.id)).toMatchObject({status:'cancelled',eventBudget:{closed:true}});
 expect(constructed.some(io=>io.durabilityLimited)).toBe(true);
 if(process.platform==='win32'){expect(windowsSecuritySessionDebug().requests).toBeGreaterThan(requests);expectPrivateParkFile(join(DATA_DIR,'concurrent-child'));}
});
test('F7 RED20 win32 native authority flush accepts root child mutation and retains unsupported directory durability',async()=>{
 const manager=authorityFixture(),db=database();flushCoalesced();let injected=0;
 const options=raceOptions(paths=>{
  if(!injected&&paths.includes(DATA_DIR)){injected++;createChild(DATA_DIR);}
 });
 const constructed:ParkFs[]=[],RealParkFs=ParkFs;
 const authority=createSignalLocalAuthority(DATA_DIR,manager,()=>{},root=>{const io=new RealParkFs(root,{...options,sync:()=> 'unsupported'});constructed.push(io);return io;});
 protectParkFixtureTree(DATA_DIR);
 const requests=windowsSecuritySessionDebug().requests;
 await expect(authority.flush()).resolves.toBeUndefined();
 expect(injected).toBe(1);expect(constructed).toHaveLength(1);expect(constructed[0]!.durabilityLimited).toBe(true);
 const checkpoint=db.prepare('PRAGMA wal_checkpoint(FULL)').get() as {busy:number;log:number;checkpointed:number};
 expect(checkpoint.busy).toBe(0);expect(checkpoint.log).toBe(checkpoint.checkpointed);
 if(process.platform==='win32'){expect(windowsSecuritySessionDebug().requests).toBeGreaterThan(requests);expectPrivateParkFile(join(DATA_DIR,'concurrent-child'));}
});
