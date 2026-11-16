// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkFixtureMkdir, parkFixtureWrite, protectParkFixtureTree, parkProtocolOptions } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs, SignalParkError, type ParkFsOptions } from './park-fs.ts';
import { parkSignalForDowngrade } from './park.ts';
import { bootstrapWindowsSignal } from './windows-bootstrap.ts';
import type { SecurityRunOptions, SecurityRunner } from './storage.ts';
import * as winAcl from '../../win-acl.ts';
import * as protection from './park-windows-protect.ts';

vi.mock('node:fs',async importOriginal=>({...await importOriginal<typeof import('node:fs')>()}));

const roots:string[]=[];
const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;;FA;;;SY)(A;;FA;;;${sid})`;
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
afterEach(()=>{vi.restoreAllMocks();roots.splice(0).forEach(root=>removeTempDirSync(root));});
function put(file:string,value:unknown){parkFixtureMkdir(dirname(file),{recursive:true,mode:0o700});parkFixtureWrite(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}
function fixture(){
 const root=privateParkTemp(join(tmpdir(),'park-sidecar-'));roots.push(root);
 put(join(root,'install-id.json'),{installId:randomUUID()});
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 put(join(root,'signal/auth/key'),'FAKE-KEY');return root;
}
function rows(opts:SecurityRunOptions){
 const output:string[]=[],seen=new Set<string>(),trees=JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]') as string[];
 function visit(path:string,tree:boolean){
  if(seen.has(path))return;seen.add(path);const stat=fs.lstatSync(path);
  output.push(JSON.stringify({path,attributes:stat.isDirectory()?16:0,sddl}));
  if(tree&&stat.isDirectory())for(const name of fs.readdirSync(path))visit(join(path,name),true);
 }
 for(const path of JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]') as string[])visit(path,opts.env.MURAGE_SIGNAL_TREE===path||trees.includes(path));
 return output.join('\n');
}
function options(afterRead?:()=>void):ParkFsOptions{
 const run:SecurityRunner=(_exe,_args,opts)=>{const output=rows(opts);afterRead?.();return output;};
 return {platform:'win32',windowsSid:()=>sid,windowsRun:run,sync:()=> 'synced'};
}
function typed(operation:()=>unknown,reason:'changed'|'unsafe'){
 let error:unknown;try{operation();}catch(caught){error=caught;}
 expect(error).toBeInstanceOf(SignalParkError);expect(error).toHaveProperty('reason',reason);
 expect(error).not.toHaveProperty('code');
}
for(const suffix of ['-shm','-wal','-journal'])for(const code of ['ENOENT','EPERM'] as const)
 for(const phase of ['recursive-prefetch','after-native-read','fingerprint-open','downgrade'] as const)
 test(`F10 win32 ${suffix} ${code} at ${phase} is a typed refusal`,()=>{
  const root=fixture(),tree=join(root,'signal'),file=join(tree,'auth/messages.db'+suffix);put(file,'FAKE-SIDECAR');
  let armed=phase==='recursive-prefetch'||phase==='downgrade',faults=0;
  const opts=options(()=>{if(phase==='after-native-read')armed=true;});
  if(phase==='recursive-prefetch')opts.prefetchWindowsPark=true;
  opts.stat=(path,statOptions)=>{
   if(path===file&&armed){faults++;throw Object.assign(new Error('SQLite sidecar closing'),{code});}
   return fs.lstatSync(path,statOptions);
  };
  const reason=code==='ENOENT'?'changed':'unsafe';
  if(phase==='downgrade')typed(()=>parkSignalForDowngrade(root,{...opts,fence}),reason);
  else if(phase==='recursive-prefetch')typed(()=>new ParkFs(root,opts),reason);
  else{
   const io=new ParkFs(root,opts);
   if(phase==='fingerprint-open'){
    // Leave the stat/ACL evidence intact, then remove the actual listed file
    // at the open boundary. The open itself supplies the real ENOENT.
    const open=fs.openSync;
    vi.spyOn(fs,'openSync').mockImplementation(((path,...args)=>{
     if(String(path)===file){faults++;if(code==='ENOENT')fs.unlinkSync(file);else throw Object.assign(new Error('delete pending'),{code});}
     return Reflect.apply(open,fs,[path,...args]);
    }) as typeof fs.openSync);
    typed(()=>io.fingerprint(tree,true),reason);
   }else typed(()=>io.checked(tree,false,true),reason);
  }
  expect(faults).toBe(1);expect(fs.readFileSync(join(tree,'auth/key'),'utf8')).toBe('FAKE-KEY');
  expect(fs.existsSync(join(root,'recovery-quarantine'))).toBe(false);
 });

for(const code of ['ENOENT','EPERM'] as const)test(`F10 win32 sidecar-named directory ${code} never receives file leniency`,()=>{
 const root=fixture(),directory=join(root,'signal/auth/messages.db-shm');parkFixtureMkdir(directory,{mode:0o700});
 const opts=options();opts.prefetchWindowsPark=true;let faults=0;
 opts.stat=(path,statOptions)=>{if(path===directory){faults++;throw Object.assign(new Error('directory disappeared'),{code});}return fs.lstatSync(path,statOptions);};
 typed(()=>new ParkFs(root,opts),code==='ENOENT'?'changed':'unsafe');expect(faults).toBe(1);
});

test('F10 first-use Windows bootstrap refuses a sidecar that vanishes after enumeration with a typed outcome',()=>{
 const root=fixture(),file=join(root,'signal/auth/messages.db-shm');put(file,'FAKE-SIDECAR');
 const read=fs.readdirSync;let removed=0;
 vi.spyOn(fs,'readdirSync').mockImplementation(((path,...args)=>{
  const entries=Reflect.apply(read,fs,[path,...args]);
  if(String(path)===dirname(file)&&!removed++){fs.unlinkSync(file);}
  return entries;
 }) as typeof fs.readdirSync);
 typed(()=>bootstrapWindowsSignal(root,{platform:'win32',sid:()=>sid,run:options().windowsRun}),'changed');
 expect(removed).toBe(1);expect(fs.existsSync(join(root,'.signal-owner-only.json'))).toBe(false);
});

test('F10 native SQLite second handle closes after first close and listed shm becomes delete-pending during park',()=>{
 const root=fixture(),file=join(root,'signal/auth/messages.db'),shm=file+'-shm';
 const first=new DatabaseSync(file);let second:DatabaseSync|undefined,held:number|undefined,firstClosed=false;
 let closedDuringWalk=false,originalCode:string|undefined;
 try{
  first.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'FAKE-ROW\')');
  second=new DatabaseSync(file);expect(second.prepare('SELECT value FROM fixture').get()).toEqual({value:'FAKE-ROW'});
  expect(fs.readdirSync(dirname(file))).toContain('messages.db-shm');
  // This ordinary Windows file handle shares delete access. SQLite's last
  // connection deletes shm while this handle still holds its pending inode.
  held=fs.openSync(shm,fs.constants.O_RDONLY);
  protectParkFixtureTree(root);
  first.close();firstClosed=true;
  expect(second.prepare('SELECT value FROM fixture').get()).toEqual({value:'FAKE-ROW'});
  let error:unknown;
  try{parkSignalForDowngrade(root,{...parkProtocolOptions,fence,stat:(path,statOptions)=>{
   if(path===shm&&!closedDuringWalk){
    closedDuringWalk=true;second!.close();second=undefined;
    try{return fs.lstatSync(path,statOptions);}catch(caught){originalCode=(caught as NodeJS.ErrnoException).code;throw caught;}
   }
   return fs.lstatSync(path,statOptions);
  }});}catch(caught){error=caught;}
  expect(closedDuringWalk).toBe(true);expect(['ENOENT','EPERM']).toContain(originalCode);
  expect(error).toBeInstanceOf(SignalParkError);expect(error).toHaveProperty('reason',originalCode==='ENOENT'?'changed':'unsafe');
  expect(fs.existsSync(join(root,'recovery-quarantine'))).toBe(false);
 }finally{if(!firstClosed)first.close();second?.close();if(held!==undefined)fs.closeSync(held);}
 const checked=new DatabaseSync(file);
 try{expect(checked.prepare('SELECT value FROM fixture').get()).toEqual({value:'FAKE-ROW'});}finally{checked.close();}
});

// Exercise the Windows-only fixture policy on every host. Only native ACL
// tooling is adapted; enumeration, lstat, disappearance and directory checks
// use the real isolated filesystem. Restore the platform before cleanup.
for(const shape of ['file','directory'] as const)
 for(const phase of ['collection','before-protection','protection','after-protection'] as const)
 test(`F10 fixture ${shape} disappearance at ${phase} preserves strict directory checks`,()=>{
  const root=fixture(),target=join(root,'messages.db-shm');
  if(shape==='file')fs.writeFileSync(target,'FAKE-SIDECAR',{mode:0o600});else fs.mkdirSync(target,{mode:0o700});
  const nativeStat=fs.lstatSync;let stats=0,removed=0;
  const disappear=()=>{if(removed)return;removed++;if(shape==='file')fs.unlinkSync(target);else fs.rmdirSync(target);};
  vi.spyOn(winAcl,'currentUserSid').mockReturnValue(sid);
  vi.spyOn(protection,'protectWindowsParkEntries').mockImplementation(()=>{
   const race=(phase==='protection'||phase==='after-protection')&&!removed;
   if(race)disappear();
   return !(race&&phase==='protection');
  });
  vi.spyOn(fs,'lstatSync').mockImplementation(((path,...args)=>{
   if(String(path)===target){stats++;if((phase==='collection'&&stats===1)||(phase==='before-protection'&&stats===2))disappear();}
   return Reflect.apply(nativeStat,fs,[path,...args]);
  }) as typeof fs.lstatSync);
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
  try{
   Object.defineProperty(process,'platform',{...platform,value:'win32'});
   if(shape==='file')expect(()=>protectParkFixtureTree(root)).not.toThrow();
   else expect(()=>protectParkFixtureTree(root)).toThrow(expect.objectContaining({code:'ENOENT'}));
  }finally{Object.defineProperty(process,'platform',platform);}
  expect(removed).toBe(1);expect(fs.existsSync(target)).toBe(false);
 });
for(const code of ['EPERM','EACCES'])test(`F10 fixture never ignores a regular file ${code}`,()=>{
 const root=fixture(),target=join(root,'messages.db-wal');fs.writeFileSync(target,'FAKE-SIDECAR',{mode:0o600});
 const nativeStat=fs.lstatSync;let faults=0;
 vi.spyOn(fs,'lstatSync').mockImplementation(((path,...args)=>{
  if(String(path)===target){faults++;throw Object.assign(new Error('fixture access denied'),{code});}
  return Reflect.apply(nativeStat,fs,[path,...args]);
 }) as typeof fs.lstatSync);
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
 try{
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  expect(()=>protectParkFixtureTree(root)).toThrow(expect.objectContaining({code}));
 }finally{Object.defineProperty(process,'platform',platform);}
 expect(faults).toBe(1);expect(fs.readFileSync(target,'utf8')).toBe('FAKE-SIDECAR');
});

for(const code of ['ENOENT','EPERM'] as const)test(`F10 win32 sidecar ancestor ${code} remains a typed refusal`,()=>{
 const root=fixture(),ancestor=join(root,'signal/auth');put(join(ancestor,'messages.db-shm'),'FAKE-SIDECAR');
 const opts=options();opts.prefetchWindowsPark=true;let faults=0;
 opts.stat=(path,statOptions)=>{if(path===ancestor){faults++;throw Object.assign(new Error('ancestor unavailable'),{code});}return fs.lstatSync(path,statOptions);};
 typed(()=>parkSignalForDowngrade(root,{...opts,fence}),code==='ENOENT'?'changed':'unsafe');expect(faults).toBe(1);
 expect(fs.existsSync(join(root,'recovery-quarantine'))).toBe(false);
});
test('F10 fixture never treats a vanished sidecar ancestor as a vanished file',()=>{
 const root=fixture(),ancestor=join(root,'signal/auth'),file=join(ancestor,'messages.db-shm');fs.writeFileSync(file,'FAKE-SIDECAR',{mode:0o600});
 const nativeStat=fs.lstatSync;let moved=0;
 vi.spyOn(fs,'lstatSync').mockImplementation(((path,...args)=>{
  if(String(path)===ancestor&&!moved++){fs.renameSync(ancestor,join(root,'retained-auth'));}
  return Reflect.apply(nativeStat,fs,[path,...args]);
 }) as typeof fs.lstatSync);
 vi.spyOn(winAcl,'currentUserSid').mockReturnValue(sid);
 vi.spyOn(protection,'protectWindowsParkEntries').mockReturnValue(true);
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
 try{
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  expect(()=>protectParkFixtureTree(root)).toThrow(expect.objectContaining({code:'ENOENT'}));
 }finally{Object.defineProperty(process,'platform',platform);}
 expect(moved).toBe(1);expect(fs.readFileSync(join(root,'retained-auth/messages.db-shm'),'utf8')).toBe('FAKE-SIDECAR');
});
