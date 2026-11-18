// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, readdirSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkFixtureMkdir, parkFixtureWrite } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs, parkReason } from './park-fs.ts';
import { signalActionFailure } from './action-error.ts';
import { preserveSignalForDowngrade, signalDowngradeRefusal } from './park-downgrade.ts';
import { windowsSecurityPathsSync, type SecurityRunner, type SecurityRunOptions } from './storage.ts';

const roots:string[]=[];
const sid='S-1-5-21-1-2-3-1001';
const sddl=`O:${sid}D:P(A;;FA;;;${sid})`;
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){
 const root=privateParkTemp(join(tmpdir(),'park-windows-batch-'));roots.push(root);
 const dir=join(root,'signal/auth/deep');parkFixtureMkdir(dir,{recursive:true,mode:0o700});
 const key=join(dir,'key');parkFixtureWrite(key,'fake-private-key',{mode:0o600});return{root,key};
}
function rows(options:SecurityRunOptions){
 const output:string[]=[],seen=new Set<string>();
 function visit(path:string,recurse:boolean){
  if(seen.has(path))return;seen.add(path);
  const stat=lstatSync(path);output.push(JSON.stringify({path,attributes:stat.isDirectory()?16:0,sddl}));
  if(recurse&&stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name),true);
 }
 for(const path of JSON.parse(options.env.MURAGE_SIGNAL_ROOTS!) as string[])visit(path,options.env.MURAGE_SIGNAL_TREE===path);
 return output.join('\n');
}
function options(run:SecurityRunner,deadline=Date.now()+60_000){return{platform:'win32' as const,windowsRun:run,windowsSid:()=>sid,deadline};}
const timeout=()=>Object.assign(new Error('spawn timed out'),{code:'ETIMEDOUT'});

test('one native spawn reads the whole ancestor chain; each uncached checked walk is one batch',()=>{
 const {root,key}=fixture(),calls:string[][]=[];
 const run:SecurityRunner=(_file,_args,opts)=>{calls.push(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!));return rows(opts);};
 const io=new ParkFs(root,options(run));
 const chain:string[]=[];for(let path=root;;path=dirname(path)){chain.unshift(path);if(dirname(path)===path)break;}
 expect(calls).toEqual([chain]);
 expect(io.checked(key)?.isFile()).toBe(true);
 expect(calls).toEqual([chain,[join(root,'signal'),join(root,'signal/auth'),dirname(key),key]]);
 expect(io.checked(key)?.isFile()).toBe(true);expect(calls).toHaveLength(2);
 expect(io.read(key,64,true).toString()).toBe('fake-private-key');expect(calls).toHaveLength(2);
 // Between operations, foreign key changes require a full new ACL batch.
 const st=lstatSync(key);utimesSync(key,st.atime,new Date(st.mtimeMs+2000));
 expect(io.checked(key)?.isFile()).toBe(true);expect(calls).toHaveLength(3);expect(calls[2]).toEqual([key]);
 new ParkFs(root,options(run));expect(calls).toHaveLength(4);
});

test('a 2.5 second security read succeeds inside the park deadline without the old 1.5 second cap',()=>{
 const {root}=fixture();let now=Date.now(),calls=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const deadline=now+30_000;
 const run:SecurityRunner=(_file,_args,opts)=>{calls++;expect(opts.timeout).toBe(15_000);now+=2500;return rows(opts);};
 expect(()=>new ParkFs(root,options(run,deadline))).not.toThrow();expect(calls).toBe(1);
});

test('one timeout retries the entire batch with the remaining deadline and succeeds',()=>{
 const {root}=fixture();let now=Date.now(),calls=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const batches:string[][]=[];
 const run:SecurityRunner=(_file,_args,opts)=>{
  batches.push(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!));expect(opts.timeout).toBe(calls===0?15_000:27_500);
  if(calls++===0){now+=2500;throw timeout();}return rows(opts);
 };
 expect(()=>new ParkFs(root,options(run,now+30_000))).not.toThrow();expect(calls).toBe(2);expect(batches[1]).toEqual(batches[0]);
});

test('two timeouts refuse distinctly and surface the reason in the plain downgrade line without moving files',()=>{
 const {root,key}=fixture(),before=readFileSync(key);let calls=0;
 const run:SecurityRunner=()=>{calls++;throw timeout();};
 let direct:unknown;try{new ParkFs(root,options(run));}catch(error){direct=error;}
 expect(parkReason(direct)).toBe('security read timed out');expect(calls).toBe(2);calls=0;
 expect(signalActionFailure(direct)).toEqual({cause:'security read timed out',message:'The Signal security read timed out. Try again in Signal settings.'});
 let failure:unknown;try{preserveSignalForDowngrade(root,options(run));}catch(error){failure=error;}
 expect(calls).toBe(2);
 expect(failure).toMatchObject({reason:'security read timed out',stage:'read-only'});
 expect((failure as Error).message).toContain('security read timed out');
 expect((failure as Error).message).toMatch(/^No Signal files were moved\./);expect(readFileSync(key)).toEqual(before);
 for(const stage of ['read-only','metadata','moved'] as const)expect(signalDowngradeRefusal(stage,'security read timed out')).toContain('security read timed out');
});

test('the batched security timeout has a ten second floor',()=>{
 const {root}=fixture();const now=Date.now();let calls=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const run:SecurityRunner=(_file,_args,opts)=>{calls++;expect(opts.timeout).toBe(10_000);return rows(opts);};
 expect(windowsSecurityPathsSync([root],now+10_000,run)).toHaveLength(1);expect(calls).toBe(1);
 expect(()=>windowsSecurityPathsSync([root],now+9999,run)).toThrow('security read timed out');expect(calls).toBe(1);
});

test('a timeout while checking new metadata retains its reason through the durability wrapper',()=>{
 const {root,key}=fixture();let timeouts=0;
 const run:SecurityRunner=(_file,_args,opts)=>{
  const paths=JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[];
  if(paths.some(path=>path.endsWith('.tmp'))){timeouts++;throw timeout();}
  return rows(opts);
 };
 const io=new ParkFs(root,{...options(run),protectNewWindowsEntry:path=>{windowsSecurityPathsSync([path],Date.now()+60_000,run);return true;},sync:()=> 'synced'});
 let failure:unknown;try{io.write(join(root,'metadata.json'),{fixture:true});}catch(error){failure=error;}
 // The protection adapter can itself need native evidence; timeout must retain its reason.
 expect(timeouts).toBe(2);expect(parkReason(failure)).toBe('security read timed out');
 expect(readFileSync(key,'utf8')).toBe('fake-private-key');
});

for(const bad of ['missing','null','malformed','reparse','foreign-owner','broad-acl','spawn-failure'] as const)test(`successful batch keeps ${bad} evidence fail closed without retry`,()=>{
 const {root,key}=fixture(),before=readFileSync(key);let calls=0;
 const run:SecurityRunner=(_file,_args,opts)=>{
  calls++;
  if(bad==='spawn-failure')throw Object.assign(new Error('access denied'),{code:'EACCES'});
  if(bad==='malformed')return '{';
  return rows(opts).split('\n').flatMap(line=>{
   const row=JSON.parse(line);if(row.path!==root)return[line];
   if(bad==='missing')return[];
   if(bad==='null')row.sddl=null;
   if(bad==='reparse'){row.attributes|=0x400;row.sddl=null;}
   if(bad==='foreign-owner')row.sddl='O:S-1-5-21-9-9-9-1001D:P(A;;FA;;;S-1-5-21-9-9-9-1001)';
   if(bad==='broad-acl')row.sddl+='(A;;FA;;;WD)';
   return[JSON.stringify(row)];
  }).join('\n');
 };
 expect(()=>new ParkFs(root,options(run))).toThrow('unsafe');expect(calls).toBe(1);expect(readFileSync(key)).toEqual(before);
});

test('arbitrary exact path lists use the PS 5.1 unwrap and never interpolate paths or enumerate children',()=>{
 vi.spyOn(realpathSync,'native').mockImplementation(path=>String(path));
 const paths=['C:\\private\\é"quoted','C:\\private\\second'];let calls=0;
 const run:SecurityRunner=(_file,args,opts)=>{
  calls++;expect(args).toEqual(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','-']);
  expect(opts.env.MURAGE_SIGNAL_PATHS).toBe('1');expect(opts.env.MURAGE_SIGNAL_POINT).toBeUndefined();
  expect(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!)).toEqual(paths);
  expect(opts.input).toContain('@(($env:MURAGE_SIGNAL_ROOTS | ConvertFrom-Json) | ForEach-Object { $_ })');
  expect(opts.input).not.toContain(paths[0]);expect(opts.env.MURAGE_SIGNAL_TREE).toBeUndefined();expect(opts.input).toContain('Visit-SignalPath $p ($env:MURAGE_SIGNAL_TREE -eq $p -or $trees[$p])');
  return paths.map(path=>JSON.stringify({path,attributes:16,sddl})).join('\n');
 };
 expect(windowsSecurityPathsSync(paths,Date.now()+30_000,run,{SystemRoot:'C:\\Windows',MURAGE_SIGNAL_POINT:'1',MURAGE_SIGNAL_TREE:paths[0]})).toHaveLength(2);expect(calls).toBe(1);
});

test('a change during the batch cannot poison the stat-keyed security cache',()=>{
 const {root,key}=fixture();let armed=false;
 const run:SecurityRunner=(_file,_args,opts)=>{
  const output=rows(opts);
  if(armed){const stat=lstatSync(key);utimesSync(key,stat.atime,new Date(stat.mtimeMs+2000));}
  return output;
 };
 const io=new ParkFs(root,options(run));armed=true;
 expect(()=>io.checked(key)).toThrow('changed');
});

test('a successful process with partial, empty, duplicate or extra rows cannot authorize an exact path list',()=>{
 vi.spyOn(realpathSync,'native').mockImplementation(path=>String(path));
 const paths=['C:\\private','C:\\private\\child'];
 const row=(path:string)=>JSON.stringify({path,attributes:16,sddl});
 for(const output of ['',row(paths[0]!),row(paths[0]!)+'\n'+row(paths[0]!),paths.map(row).join('\n')+'\n'+row('C:\\other')]){
  let calls=0;expect(windowsSecurityPathsSync(paths,Date.now()+30_000,()=>{calls++;return output;})).toBeNull();expect(calls).toBe(1);
 }
});

test('the public downgrade wrapper retains the 120-second Windows operation budget',()=>{
 const {root}=fixture(),now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
 const budgets:number[]=[];
 const run:SecurityRunner=(_exe,_args,opts)=>{budgets.push(opts.timeout);throw Object.assign(new Error('denied'),{code:'EACCES'});};
 expect(()=>preserveSignalForDowngrade(root,{platform:'win32',windowsRun:run})).toThrow();
 expect(budgets).toEqual([60_000]);
});
