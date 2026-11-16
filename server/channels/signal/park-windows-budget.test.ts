// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, test, vi } from 'vitest';
import * as atomic from '../../atomic.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs, parkFsDebug, WINDOWS_PARK_DEADLINE_MS } from './park-fs.ts';
import { parkSignalForDowngrade } from './park.ts';
import type { SecurityRunner } from './storage.ts';
const roots:string[]=[];
const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`;
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(files=1){
 const root=mkdtempSync(join(tmpdir(),'park-windows-budget-'));roots.push(root);
 mkdirSync(join(root,'signal/auth'),{recursive:true,mode:0o700});
 for(let i=0;i<files;i++)writeFileSync(join(root,'signal/auth',`key-${i}`),'FAKE-KEY',{mode:0o600});
 const children:{exe:string;paths:string[]}[]=[];
 const run:SecurityRunner=(exe,_args,opts)=>{
  const paths=JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]') as string[];
  children.push({exe,paths});
  if(exe.endsWith('whoami.exe'))return `"host\\owner","${sid}"`;
  if(exe.endsWith('icacls.exe'))return '';
  if(opts.env.MURAGE_SIGNAL_NEW)return 'MURAGE_SIGNAL_PROTECTED';
  const rows:unknown[]=[],seen=new Set<string>();
  function visit(path:string,recurse:boolean){
   if(seen.has(path))return;seen.add(path);const stat=lstatSync(path);
   rows.push({path,attributes:stat.isDirectory()?16:0,sddl});
   if(recurse&&stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name),true);
  }
  for(const path of paths)visit(path,opts.env.MURAGE_SIGNAL_TREE===path||(JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]') as string[]).includes(path));
  return rows.map(row=>JSON.stringify(row)).join('\n');
 };
 return{root,run,children};
}
test('Windows deadline is a single 120-second liveness budget; other platforms keep 25 seconds',()=>{
 const {root,run}=fixture(),start=Date.now();
 const io=new ParkFs(root,{platform:'win32',windowsRun:run});
 expect(WINDOWS_PARK_DEADLINE_MS).toBe(120_000);expect(io.deadline).toBeGreaterThanOrEqual(start+120_000);
 // The fixture's host filesystem may be NTFS: it has no POSIX uid. Supply the
 // actual fixture owner for this platform-budget witness, retaining ACL tests.
 expect(new ParkFs(root,{platform:'darwin',uid:lstatSync(root).uid}).deadline).toBeLessThanOrEqual(Date.now()+25_000);
});
for(const files of [1,200])test(`all native children are counted for a ${files}-file park`,()=>{
 const {root,run,children}=fixture(files),io=new ParkFs(root,{platform:'win32',windowsRun:run,sync:()=> 'synced'});
 const tree=join(root,'signal'),manifest=io.fingerprint(tree,true);io.mkdir(join(root,'bundle'));io.move(tree,join(root,'bundle/signal'),manifest,true);
 expect(io.fingerprint(join(root,'bundle/signal'),true)).toEqual(manifest);
 expect(readFileSync(join(root,'bundle/signal/auth',`key-${files-1}`),'utf8')).toBe('FAKE-KEY');
 expect(io.debug.childProcesses).toBe(children.length);
 expect(children.filter(child=>child.exe.endsWith('whoami.exe'))).toHaveLength(1);
 expect(children.length).toBeLessThanOrEqual(files===1?12:15);
 expect(io.debug.powerShellSpawns).toBeLessThanOrEqual(4);
});
for(const files of [1,200])test(`complete ${files}-file downgrade park counts every child with unchanged parent keys`,()=>{
 const {root,run,children}=fixture(files);mkdirSync(join(root,'channels/signal'),{recursive:true,mode:0o700});
 writeFileSync(join(root,'install-id.json'),JSON.stringify({installId:randomUUID()}));
 writeFileSync(join(root,'channels/signal/connection.json'),JSON.stringify({version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null}));
 // Model a Windows operation whose directory lstat keys remain unchanged.
 // Separate parent-race fixtures exercise actual and injected changed keys.
 const directoryKeys=new Map<bigint,{ctimeMs:bigint;mtimeMs:bigint;ctimeNs:bigint;mtimeNs:bigint;size:bigint}>();
 const stat=(path:string,options:{bigint:true})=>{const value=lstatSync(path,options);if(value.isDirectory()){let key=directoryKeys.get(value.ino);if(!key){key={ctimeMs:value.ctimeMs,mtimeMs:value.mtimeMs,ctimeNs:value.ctimeNs,mtimeNs:value.mtimeNs,size:value.size};directoryKeys.set(value.ino,key);}Object.assign(value,key);}return value;};
 const debug=parkFsDebug();
 const result=parkSignalForDowngrade(root,{platform:'win32',windowsRun:run,stat,debug,sync:()=> 'synced',fence:{lease:()=> 'fixture',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1}});
 console.log('SIGNAL_PARK_SPAWNS',JSON.stringify({files,...debug}));
 expect(result.parked).toBe(true);expect(debug.childProcesses).toBe(children.length);
 expect(children.filter(child=>child.exe.endsWith('whoami.exe'))).toHaveLength(1);
 expect(children.length).toBeLessThanOrEqual(files===1?12:15);
 expect(debug.powerShellSpawns).toBeLessThanOrEqual(4);
 expect(debug.publishParentReads).toBe(0);expect(debug.childProcesses).toBeLessThanOrEqual(5);
});

test('an unchanged verified dirty parent is not reread at publication',()=>{
 const {root,run,children}=fixture(),io=new ParkFs(root,{platform:'win32',windowsRun:run,sync:()=> 'synced'});
 // Mark staging without a key change: no own operation may refresh the key.
 io['dirtyParent'](root);const before=children.length;
 io.barrier(root);io.barrier(root);
 expect(children).toHaveLength(before);expect(io.debug.publishParentReads).toBe(0);
});
test('64 sequential park-state seeds bound PowerShell startups to four per park and share one SID',()=>{
 const {run,children}=fixture();let powershell=0;
 for(let index=0;index<64;index++){
  const root=fixture().root,io=new ParkFs(root,{platform:'win32',windowsRun:run,sync:()=> 'synced'}),tree=join(root,'signal');
  const target=join(root,'bundle/signal'),manifest=io.fingerprint(tree,true);
  io.mkdir(join(root,'bundle'));
  io.move(tree,target,manifest,true);expect(io.fingerprint(target,true)).toEqual(manifest);
  expect(io.debug.powerShellSpawns).toBeLessThanOrEqual(4);powershell+=io.debug.powerShellSpawns;
 }
 expect(powershell).toBeLessThanOrEqual(4*64);
 expect(children.filter(child=>child.exe.endsWith('whoami.exe'))).toHaveLength(1);
});

test('one write protects every new directory and empty temp in one child before entry validation or content',()=>{
 const {root,run}=fixture(),created=join(root,'new'),path=join(created,'nested/metadata.json');
 let protectedBatch=false,batches=0;
 const io=new ParkFs(root,{platform:'win32',sync:()=> 'synced',windowsRun:(exe,args,opts)=>{
  if(opts.env.MURAGE_SIGNAL_NEW){
   batches++;
   const entries=JSON.parse(opts.env.MURAGE_SIGNAL_NEW) as {path:string;directory:boolean}[];
   expect(entries.map(entry=>entry.directory)).toEqual([true,true,false]);
   expect(entries.slice(0,2).map(entry=>entry.path)).toEqual([created,join(created,'nested')]);
   expect(entries[2]!.path).toMatch(/metadata[.]json[.].*[.]tmp$/);
   expect(readFileSync(entries[2]!.path)).toHaveLength(0);
   expect(opts.input).toContain('Set-Acl -LiteralPath');
   expect(opts.input).not.toContain(created);protectedBatch=true;
  }
  return run(exe,args,opts);
 }});
 const validate=io.validate.bind(io);io.validate=(file,stat,privateFile)=>{
  if(file.startsWith(created))expect(protectedBatch).toBe(true);
  return validate(file,stat,privateFile);
 };
 io.options.after=op=>{if(op==='temp')expect(protectedBatch).toBe(true);};
 io.write(path,{private:'fixture-content'});
 expect(batches).toBe(1);expect(io.debug.protectionBatches).toBe(1);
 expect(JSON.parse(io.read(path).toString())).toEqual({private:'fixture-content'});
});
for(const failure of ['missing-marker','partial-marker','spawn-failure'] as const)test(`failed batch protection (${failure}) cannot expose content or publish`,()=>{
 const {root,run}=fixture(),path=join(root,'new/metadata.json');let temporary:string|undefined,published=false;
 const io=new ParkFs(root,{platform:'win32',sync:()=> 'synced',windowsRun:(exe,args,opts)=>{
  if(opts.env.MURAGE_SIGNAL_NEW){
   temporary=(JSON.parse(opts.env.MURAGE_SIGNAL_NEW) as {path:string;directory:boolean}[]).find(entry=>!entry.directory)!.path;
   if(failure==='spawn-failure')throw Object.assign(new Error('denied'),{code:'EACCES'});
   return failure==='missing-marker'?'':'MURAGE_SIGNAL_PROTECTED\npartial';
  }
  return run(exe,args,opts);
 },after:op=>{if(op==='temp'||op==='metadata-rename')published=true;}});
 expect(()=>io.write(path,{private:'fixture-content'})).toThrow('unsafe');
 expect(published).toBe(false);expect(temporary).toBeDefined();expect(readFileSync(temporary!)).toHaveLength(0);
});

test('priming never enumerates opaque bundles or unrelated installation stores',()=>{
 const {root,run,children}=fixture(),bundles=join(root,'recovery-quarantine/signal-parked');
 mkdirSync(join(bundles,'old.g1','opaque'),{recursive:true,mode:0o700});
 mkdirSync(join(root,'unrelated',...Array.from({length:34},(_,index)=>`d${index}`)),{recursive:true,mode:0o700});
 const io=new ParkFs(root,{platform:'win32',windowsRun:run,prefetchWindowsPark:true});
 expect(io.debug.powerShellSpawns).toBe(1);
 expect(children.flatMap(child=>child.paths)).toContain(bundles);
 expect(io['security'].has(io['pathKey'](join(bundles,'old.g1')))).toBe(false);
 expect(io['security'].has(io['pathKey'](join(root,'unrelated')))).toBe(false);
});

test('64 complete sequential park-state seeds stay within four PowerShell children per park',()=>{
 const {run,children}=fixture();let powershell=0;
 for(let index=0;index<64;index++){
  const root=fixture().root;mkdirSync(join(root,'channels/signal'),{recursive:true,mode:0o700});
  writeFileSync(join(root,'install-id.json'),JSON.stringify({installId:randomUUID()}));
  writeFileSync(join(root,'channels/signal/connection.json'),JSON.stringify({version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null}));
  const keys=new Map<bigint,{ctimeMs:bigint;mtimeMs:bigint;ctimeNs:bigint;mtimeNs:bigint;size:bigint}>();
  const stat=(path:string,options:{bigint:true})=>{const value=lstatSync(path,options);if(value.isDirectory()){let key=keys.get(value.ino);if(!key){key={ctimeMs:value.ctimeMs,mtimeMs:value.mtimeMs,ctimeNs:value.ctimeNs,mtimeNs:value.mtimeNs,size:value.size};keys.set(value.ino,key);}Object.assign(value,key);}return value;};
  const debug=parkFsDebug();
  expect(parkSignalForDowngrade(root,{platform:'win32',windowsRun:run,stat,debug,sync:()=> 'synced',fence:{lease:()=> 'fixture',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1}}).parked).toBe(true);
  expect(debug.powerShellSpawns).toBeLessThanOrEqual(4);expect(debug.childProcesses).toBeLessThanOrEqual(12);
  expect(debug.publishParentReads).toBe(0);powershell+=debug.powerShellSpawns;
 }
 expect(powershell).toBeLessThanOrEqual(4*64);
 expect(children.filter(child=>child.exe.endsWith('whoami.exe'))).toHaveLength(1);
});

test('journal reserve reuse refuses changed empty inodes before writing content',()=>{
 const {root,run}=fixture(),io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid,sync:()=> 'synced'}),file=join(root,'park.json');
 io.reserveMetadataWrites(file,3);io.write(file,{original:true});
 const reserve=readdirSync(root).find(name=>name.startsWith('park.json.')&&name.endsWith('.tmp'))!;
 expect(reserve).toBeDefined();writeFileSync(join(root,reserve),'FOREIGN');
 // Alter both retained reserves to make the next selection deterministic.
 for(const name of readdirSync(root).filter(name=>name.startsWith('park.json.')&&name.endsWith('.tmp')))writeFileSync(join(root,name),'FOREIGN');
 expect(()=>io.write(file,{secret:'NEVER'})).toThrow('changed');expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({original:true});
});

for(const stage of ['reserve','publish'])for(const code of ['EPERM','EACCES','EBUSY'])test(`Windows park metadata ${stage} rename retries one ${code}`,()=>{
 const {root,run}=fixture(),io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid,sync:()=> 'synced'}),file=join(root,'park.json');
 io.reserveMetadataWrites(file,3);io.write(file,{original:true});
 const builtin=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),rename=builtin.renameSync;let attempts=0;
 builtin.renameSync=(from,to)=>{
  if((stage==='publish')===(String(to)===file)&&++attempts===1)throw Object.assign(new Error('transient rename'),{code});
  rename(from,to);
 };syncBuiltinESMExports();
 try{io.write(file,{replacement:true});}finally{builtin.renameSync=rename;syncBuiltinESMExports();}
 expect(attempts).toBe(2);expect(JSON.parse(io.read(file).toString())).toEqual({replacement:true});
});
test('Windows park metadata publication has six attempts and retains a failed temporary',()=>{
 const {root,run}=fixture(),io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid,sync:()=> 'synced'}),file=join(root,'park.json');
 io.write(file,{original:true});
 const builtin=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),rename=builtin.renameSync;
 const failure=Object.assign(new Error('locked'),{code:'EPERM'});let attempts=0;
 builtin.renameSync=(from,to)=>{if(String(to)===file){attempts++;throw failure;}rename(from,to);};syncBuiltinESMExports();
 try{expect(()=>io.write(file,{replacement:true})).toThrow(failure);}finally{builtin.renameSync=rename;syncBuiltinESMExports();}
 expect(attempts).toBe(6);expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({original:true});
 const temps=readdirSync(root).filter(name=>name.startsWith('park.json.')&&name.endsWith('.tmp'));
 expect(temps).toHaveLength(1);expect(JSON.parse(readFileSync(join(root,temps[0]),'utf8'))).toEqual({replacement:true});
});

for(const name of ['park.json','control.json','set-aside.json'])for(const committed of [false,true])test(`Windows park metadata rejects a replaced temporary after EPERM for ${name} (committed=${committed})`,()=>{
 const {root,run}=fixture(),io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid,sync:()=> 'synced'}),file=join(root,name);
 if(committed)io.write(file,{original:true});
 const before=committed?readFileSync(file):null;
 let attempts=0,published=false,replaced=false,temporary='';const held=join(root,'written-inode');
 io.options.after=operation=>{if(operation==='metadata-rename')published=true;};
 const builtin=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),rename=builtin.renameSync;
 const retry=atomic.renameWithRetry;
 const retrySpy=vi.spyOn(atomic,'renameWithRetry').mockImplementation((from,to,attempt,platform,sleep)=>retry(from,to,attempt,platform,to===file?()=>{
  expect(attempts).toBe(1);
  // Run after EPERM was caught, during the delay before the next attempt.
  // Retain the written inode so the foreign file cannot reuse its identity.
  rename(temporary,held);writeFileSync(temporary,'FOREIGN',{mode:0o600});replaced=true;
 }:sleep));
 builtin.renameSync=(from,to)=>{
  if(String(to)===file&&++attempts===1){
   temporary=String(from);
   throw Object.assign(new Error('injected Windows rename refusal'),{code:'EPERM'});
  }
  rename(from,to);
 };syncBuiltinESMExports();
 try{expect(()=>io.write(file,{replacement:true})).toThrow('changed');}finally{builtin.renameSync=rename;syncBuiltinESMExports();retrySpy.mockRestore();}
 expect(replaced).toBe(true);expect(attempts).toBe(1);expect(published).toBe(false);
 if(committed)expect(readFileSync(file)).toEqual(before);
 else expect(existsSync(file)).toBe(false);
 expect(readFileSync(temporary,'utf8')).toBe('FOREIGN');
 expect(JSON.parse(readFileSync(held,'utf8'))).toEqual({replacement:true});
});
