// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import * as atomic from '../../atomic.ts';
import { SignalPrivateWriter } from './private-writer.ts';
import type { SecurityRunner } from './storage.ts';
import { protectWindowsParkEntries } from './park-windows-protect.ts';
import { currentUserSid } from '../../win-acl.ts';
const sid='S-1-5-21-1-2-3-1001',roots:string[]=[],writers:SignalPrivateWriter[]=[];
afterEach(()=>{for(const writer of writers.splice(0))writer.release();for(const root of roots.splice(0))removeTempDirSync(root);vi.restoreAllMocks();});
function fixture(batchSize=64){
 const root=fs.mkdtempSync(join(tmpdir(),'signal-writer-'));roots.push(root);
 const protectedPaths=new Set<string>(),protectedIds=new Set<string>();let calls=0;
 const run:SecurityRunner=(file,args,opts)=>{
  calls++;const paths=file.endsWith('icacls.exe')?[String(args[0])]:(JSON.parse(opts.env.MURAGE_SIGNAL_NEW!) as Array<{path:string}>).map(row=>row.path);
  for(const path of paths){const stat=fs.lstatSync(path);expect(stat.isSymbolicLink()).toBe(false);if(stat.isFile())expect(stat.size).toBe(0);protectedPaths.add(path);const exact=fs.lstatSync(path,{bigint:true});protectedIds.add(`${exact.dev}:${exact.ino}`);}
  return 'MURAGE_SIGNAL_PROTECTED';
 };
 const acls=new Map<string,string>(),reparse=new Set<string>();
 const writer=new SignalPrivateWriter({platform:'win32',run,sid:()=>sid,batchSize,windowsEntry:path=>({path,attributes:reparse.has(path)?0x400:0,sddl:acls.get(path)??`O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)`})});writers.push(writer);
 return{root,writer,protectedPaths,protectedIds,acls,reparse,calls:()=>calls};
}
test('250 atomic saves batch empty protected inodes before writing; every file is independent',()=>{
 const f=fixture(),file=join(f.root,'nested/receipts.json');const original=atomic.writeFileAtomic;let writes=0;
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>original(path,data,{...options,ops:{...options?.ops,write:((fd:number,data:string)=>{
  // open has consumed a protected inode; its old empty name is gone.
  const exact=fs.fstatSync(fd,{bigint:true});expect(f.protectedIds.has(`${exact.dev}:${exact.ino}`)).toBe(true);expect(exact.size).toBe(0n);writes++;fs.writeFileSync(fd,data);
 }) as typeof fs.writeFileSync}}));
 for(let i=0;i<250;i++)f.writer.write(file,JSON.stringify({i}));
 expect(writes).toBe(250);expect(JSON.parse(fs.readFileSync(file,'utf8'))).toEqual({i:249});
 expect(f.calls()).toBe(4);expect(f.writer.debug).toEqual({childProcesses:4,protectionBatches:4});
 expect(fs.lstatSync(file).nlink).toBe(1);f.writer.release();expect(fs.readdirSync(join(f.root,'nested'))).toEqual(['receipts.json']);
});
test('connection reserves use the existing atomic-temporary grammar',async()=>{
 const f=fixture(4),file=join(f.root,'channels/signal/connection.json');f.writer.write(file,'{}');
 const {isAtomicTemp}=await import('./park-fs.ts');
 for(const name of fs.readdirSync(join(f.root,'channels/signal')))if(name!=='connection.json')expect(isAtomicTemp(name,'connection.json')).toBe(true);
});
test('new installation directories are protected together while existing directories retain their ACL',()=>{
 const f=fixture(),channel=join(f.root,'channels/signal'),auth=join(f.root,'signal/auth');
 f.writer.mkdirAll([f.root,channel,auth]);
 for(const path of [join(f.root,'channels'),channel,join(f.root,'signal'),auth])expect(f.protectedPaths.has(path)).toBe(true);
 expect(f.protectedPaths.has(f.root)).toBe(false);expect(f.calls()).toBe(1);
});
test('a fresh temporary root is protected before returning to its first caller',()=>{
 const f=fixture(),root=f.writer.mkdtemp(join(f.root,'fresh-'));
 expect(f.protectedPaths.has(root)).toBe(true);expect(fs.readdirSync(root)).toEqual([]);expect(f.calls()).toBe(1);
});
test('changed reserve identity or metadata refuses without overwriting a committed file',()=>{
 const f=fixture(4),file=join(f.root,'receipts.json');f.writer.write(file,'original');
 for(const name of fs.readdirSync(f.root))if(name!== 'receipts.json')fs.writeFileSync(join(f.root,name),'foreign');
 expect(()=>f.writer.write(file,'replacement')).toThrow('Signal private file refused');expect(fs.readFileSync(file,'utf8')).toBe('original');
});
test('protection failure never writes content or publishes a target',()=>{
 const f=fixture();const run:SecurityRunner=()=>{throw new Error('denied');};
 const writer=new SignalPrivateWriter({platform:'win32',run,sid:()=>sid});writers.push(writer);
 const file=join(f.root,'new/connection.json');expect(()=>writer.write(file,'SECRET')).toThrow();
 expect(fs.existsSync(file)).toBe(false);expect(fs.readdirSync(join(f.root,'new'))).toEqual([]);
});
test('append protects the new empty journal once before content; later rows need no child',()=>{
 const f=fixture(),file=join(f.root,'ingress/one.ndjson');f.writer.append(file,'first\n');f.writer.append(file,'second\n');
 expect(fs.readFileSync(file,'utf8')).toBe('first\nsecond\n');expect(f.calls()).toBe(1);
 expect(f.protectedPaths.has(file)).toBe(true);
});
test('a replaced directory cannot inherit a previous reserve pool',()=>{
 const f=fixture(4),directory=join(f.root,'child'),file=join(directory,'state.json');f.writer.write(file,'original');
 fs.renameSync(directory,join(f.root,'old'));fs.mkdirSync(directory);expect(()=>f.writer.write(file,'SECRET')).toThrow();expect(fs.existsSync(file)).toBe(false);
});

test('replacement of the closed temporary refuses before publication',()=>{
 const f=fixture(4),file=join(f.root,'receipts.json');f.writer.write(file,'original');const original=atomic.writeFileAtomic;
 let injected=0;
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>original(path,data,{...options,rename:(from,to)=>{
  fs.renameSync(from,from+'.held');fs.writeFileSync(from,'FOREIGN');injected++;
  (options!.rename??fs.renameSync)(from,to);
 }}));
 expect(()=>f.writer.write(file,'replacement')).toThrow('Signal private file refused');expect(injected).toBe(1);expect(fs.readFileSync(file,'utf8')).toBe('original');
});
test('append refuses multiply-linked files and exclusive log creation refuses an existing path',()=>{
 const f=fixture(),file=join(f.root,'log');f.writer.append(file,'original');
 expect(()=>f.writer.openAppend(file,true)).toThrow();fs.linkSync(file,join(f.root,'alias'));
 expect(()=>f.writer.append(file,'SECRET')).toThrow('Signal private file refused');expect(fs.readFileSync(file,'utf8')).toBe('original');
});

test('failed append protection removes its empty allocation and retry must protect again',()=>{
 const f=fixture(),file=join(f.root,'failed.ndjson');let attempts=0;
 const writer=new SignalPrivateWriter({platform:'win32',sid:()=>sid,run:()=>{attempts++;throw new Error('denied');}});writers.push(writer);
 for(let i=0;i<2;i++){
  expect(()=>writer.append(file,'SECRET')).toThrow('Signal private file refused');expect(fs.existsSync(file)).toBe(false);
 }
 expect(attempts).toBe(2);
});
test('existing append files require a strict ACL before content',()=>{
 const f=fixture(),file=join(f.root,'external.ndjson');fs.writeFileSync(file,'ORIGINAL');let reads=0;
 const writer=new SignalPrivateWriter({platform:'win32',sid:()=>sid,run:(_exe,_args,opts)=>{
  reads++;expect(opts.env.MURAGE_SIGNAL_POINT).toBe('1');return JSON.stringify({path:file,attributes:0,sddl:`O:${sid}D:(A;;FA;;;WD)`});
 }});writers.push(writer);
 expect(()=>writer.append(file,'SECRET')).toThrow('Signal private file refused');expect(reads).toBe(1);expect(fs.readFileSync(file,'utf8')).toBe('ORIGINAL');
});

const builtin=createRequire(import.meta.url)('node:fs') as typeof fs;
for(const stage of ['reserve','publish'])for(const code of ['EPERM','EACCES','EBUSY'])test(`Windows private ${stage} rename retries one ${code} without losing bytes`,()=>{
 const f=fixture(4),file=join(f.root,'outbox.json');f.writer.write(file,'original');
 const rename=builtin.renameSync;let attempts=0;
 builtin.renameSync=(from,to)=>{
  if((stage==='publish')===(String(to)===file)&&++attempts===1)throw Object.assign(new Error('transient rename'),{code});
  rename(from,to);
 };syncBuiltinESMExports();
 try{f.writer.write(file,'replacement');}finally{builtin.renameSync=rename;syncBuiltinESMExports();}
 expect(attempts).toBe(2);expect(fs.readFileSync(file,'utf8')).toBe('replacement');
 f.writer.release();expect(fs.readdirSync(f.root)).toEqual(['outbox.json']);
});
test('Windows private publication stops after six refused attempts and preserves committed bytes',()=>{
 const f=fixture(4),file=join(f.root,'outbox.json');f.writer.write(file,'original');
 const rename=builtin.renameSync,failure=Object.assign(new Error('locked'),{code:'EPERM'});let attempts=0;
 builtin.renameSync=(from,to)=>{if(String(to)===file){attempts++;throw failure;}rename(from,to);};syncBuiltinESMExports();
 try{expect(()=>f.writer.write(file,'replacement')).toThrow(failure);}finally{builtin.renameSync=rename;syncBuiltinESMExports();}
 expect(attempts).toBe(6);expect(fs.readFileSync(file,'utf8')).toBe('original');
 f.writer.release();expect(fs.readdirSync(f.root)).toEqual(['outbox.json']);
});
test('Windows private retry rechecks a temporary replaced after the first refusal',()=>{
 const f=fixture(4),file=join(f.root,'outbox.json');f.writer.write(file,'original');
 const rename=builtin.renameSync;let attempts=0;
 builtin.renameSync=(from,to)=>{
  if(String(to)===file){attempts++;rename(from,String(from)+'.held');fs.writeFileSync(from,'FOREIGN');throw Object.assign(new Error('locked'),{code:'EPERM'});}
  rename(from,to);
 };syncBuiltinESMExports();
 try{expect(()=>f.writer.write(file,'replacement')).toThrow('Signal private file refused');}finally{builtin.renameSync=rename;syncBuiltinESMExports();}
 expect(attempts).toBe(1);expect(fs.readFileSync(file,'utf8')).toBe('original');
});

// Force timestamp publication on every host: a ctime/mtime mutant must fail.
test('pooled private temp survives directory protection and timestamp publication without reprotection',()=>{
 const f=fixture(4),file=join(f.root,'outbox.json');f.writer.write(file,'original');
 for(const name of fs.readdirSync(f.root).filter(name=>name.endsWith('.tmp'))){const path=join(f.root,name),stat=fs.lstatSync(path);fs.utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));}
 expect(protectWindowsParkEntries([{path:f.root,directory:true}],sid,Date.now()+15_000,()=> '')).toBe(true);
 const calls=f.calls();expect(()=>f.writer.write(file,'replacement')).not.toThrow();
 expect(fs.readFileSync(file,'utf8')).toBe('replacement');expect(f.calls()).toBe(calls);
});
for(const attack of ['inode','hard-link','content','acl','reparse'] as const)test(`pooled private temp refuses ${attack} before replacing committed content`,()=>{
 const f=fixture(4),file=join(f.root,'outbox.json');f.writer.write(file,'original');
 for(const name of fs.readdirSync(f.root).filter(name=>name.endsWith('.tmp'))){
  const path=join(f.root,name);
  if(attack==='inode'){fs.renameSync(path,path+'.held');fs.writeFileSync(path,'');}
  if(attack==='hard-link')fs.linkSync(path,path+'.alias');
  if(attack==='content')fs.writeFileSync(path,'FOREIGN');
  if(attack==='acl')f.acls.set(path,`O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)(A;;FA;;;WD)`);
  if(attack==='reparse')f.reparse.add(path);
 }
 expect(()=>f.writer.write(file,'SECRET')).toThrow('Signal private file refused');expect(fs.readFileSync(file,'utf8')).toBe('original');
});

test('pooled ACL is freshly read through the native security runner without repairing a broadened entry',()=>{
 const f=fixture(4),file=join(f.root,'native-outbox.json');let broad=false,reads=0,protections=0;
 const writer=new SignalPrivateWriter({platform:'win32',sid:()=>sid,batchSize:4,run:(_exe,_args,opts)=>{
  if(opts.env.MURAGE_SIGNAL_NEW){protections++;return 'MURAGE_SIGNAL_PROTECTED';}
  reads++;return [...new Set(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[])].map(path=>JSON.stringify({path,attributes:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)${broad?'(A;;FA;;;WD)':''}`})).join('\n');
 }});writers.push(writer);
 writer.write(file,'original');broad=true;
 expect(()=>writer.write(file,'SECRET')).toThrow('Signal private file refused');
 expect(reads).toBe(2);expect(protections).toBe(1);expect(fs.readFileSync(file,'utf8')).toBe('original');
});

test('native private write survives protecting its directory between pooled saves',()=>{
 const f=fixture(4),file=join(f.root,'actual-outbox.json'),writer=new SignalPrivateWriter({batchSize:4});writers.push(writer);
 writer.write(file,'original');
 if(process.platform==='win32'){
  const nativeSid=currentUserSid();expect(nativeSid).not.toBeNull();
  expect(protectWindowsParkEntries([{path:f.root,directory:true}],nativeSid!,Date.now()+15_000)).toBe(true);
 }else fs.chmodSync(f.root,0o700);
 writer.write(file,'replacement');expect(fs.readFileSync(file,'utf8')).toBe('replacement');
});
