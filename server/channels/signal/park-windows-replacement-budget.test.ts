// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { parkSignalForDowngrade } from './park.ts';
import { keepBothAndLinkAgain, replaySignalReplacements, type SignalLocalAuthority } from './park-replacement.ts';
import { pathsFor } from './park-control.ts';
import { type ParkFsOptions } from './park-fs.ts';
import type { SecurityRunner } from './storage.ts';
import * as securitySessions from './windows-security-session.ts';
import { markWindowsSecuritySessionRunner, WindowsSecuritySession } from './windows-security-session.ts';
import { defaultSecurityRunner } from './windows-security-runner.ts';
import { SIGNAL_SECURITY_HELPER } from '../../testing/signal-security-helper.ts';

const roots:string[]=[],sid='S-1-5-21-1-2-3-1001';
const builtin=createRequire(import.meta.url)('node:fs') as typeof fs;
const nativeLstat=builtin.lstatSync;
const measurements:Array<{children:number;icacls:number}>=[];
const sddl=`O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`;
afterEach(()=>{
 for(const root of roots.splice(0))removeTempDirSync(root);
 const completed=measurements.splice(0);
 for(const count of completed){expect(count.children).toBeLessThanOrEqual(2);expect(count.icacls).toBe(0);}
});
function fixture(files:number){
 const root=fs.mkdtempSync(join(tmpdir(),"signal-replacement-私の O'Brien-"));roots.push(root);
 const put=(path:string,value:unknown)=>{fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});};
 put(join(root,'install-id.json'),{installId:randomUUID()});
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 for(let i=0;i<files;i++)put(join(root,'signal/auth',`key-${i}`),`FAKE-${i}`);
 const counts=()=>({children:0,oneShot:0,powershell:0,icacls:0,whoami:0,aclRows:0,identityReads:0,pathIdentityReads:0,descriptorIdentityReads:0,trackedIdentityReads:0});
 let count=counts(),session:WindowsSecuritySession|undefined;
 const run:SecurityRunner=(exe,_args,opts)=>{
  count.children++;
  if(exe.endsWith('whoami.exe')){count.whoami++;return `"host\\owner","${sid}"`;}
  if(exe.endsWith('icacls.exe')){count.icacls++;return '';}
  count.powershell++;
  if(!session)return oneShot(exe,_args,opts);
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
  try{return defaultSecurityRunner(exe,_args,opts);}finally{Object.defineProperty(process,'platform',descriptor);}
 };
 const oneShot=(_exe:string,_args:readonly string[],opts:Parameters<SecurityRunner>[2])=>{
  count.oneShot++;
  if(opts.env.MURAGE_SIGNAL_NEW)return 'MURAGE_SIGNAL_PROTECTED';
  const rows:unknown[]=[],seen=new Set<string>(),trees=JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]') as string[];
  const visit=(path:string,recurse:boolean)=>{
   if(seen.has(path))return;seen.add(path);const stat=nativeLstat(path);
   rows.push({path,attributes:stat.isDirectory()?16:0,sddl});count.aclRows++;
   if(recurse&&stat.isDirectory())for(const name of fs.readdirSync(path))visit(join(path,name),true);
  };
  for(const path of JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]'))visit(path,opts.env.MURAGE_SIGNAL_TREE===path||trees.includes(path));
  return rows.map(row=>JSON.stringify(row)).join('\n');
 };
 markWindowsSecuritySessionRunner(run);
 const stat:NonNullable<ParkFsOptions['stat']>=(path,options)=>{count.trackedIdentityReads++;return fs.lstatSync(path,options);};
 const options={platform:'win32' as const,windowsRun:run,stat,sync:()=> 'synced' as const,fence:{lease:()=> 'fixture',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1}};
 const active=new Set(['old']),runs=new Set(['queued']);
 const authority:SignalLocalAuthority={fence:()=>{},inventory:()=>({connectionIds:[...active],runIds:[...runs]}),revoke:async(ids,runIds)=>{ids.forEach(id=>active.delete(id));runIds.forEach(id=>runs.delete(id));},verify:()=>!active.size&&!runs.size,flush:async()=>{}};
 const measure=async<T>(operation:string,work:()=>T|Promise<T>)=>{
  count=counts();
  // Exercise the production routing decision. Only its resident endpoint and
  // the OS tool boundary are adapted to disposable helpers on this host.
  session=new WindowsSecuritySession({command:process.execPath,args:['-e',SIGNAL_SECURITY_HELPER,'--','--powershell-protocol']});
  const resident=vi.spyOn(securitySessions,'runWindowsSecuritySession').mockImplementation((_exe,_args,opts)=>{
   const output=session!.run(opts);if(!opts.env.MURAGE_SIGNAL_NEW)count.aclRows+=output.trim().split('\n').filter(Boolean).length;return output;
  });
  const cp=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'),exec=cp.execFileSync;
  cp.execFileSync=oneShot as unknown as typeof cp.execFileSync;syncBuiltinESMExports();
  const hideKey=Symbol.for('murage.windowsHide.installed'),hideDescriptor=Object.getOwnPropertyDescriptor(process,hideKey);
  if(!hideDescriptor)Object.defineProperty(process,hideKey,{value:{inherit:<T>(options:T)=>options},configurable:true});
  const lstat=builtin.lstatSync,fstat=builtin.fstatSync;
  builtin.lstatSync=((...args:Parameters<typeof fs.lstatSync>)=>{count.pathIdentityReads++;return Reflect.apply(lstat,builtin,args);}) as typeof fs.lstatSync;
  builtin.fstatSync=((...args:Parameters<typeof fs.fstatSync>)=>{count.descriptorIdentityReads++;return Reflect.apply(fstat,builtin,args);}) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try{return await work();}finally{
   builtin.lstatSync=lstat;builtin.fstatSync=fstat;syncBuiltinESMExports();
   const children=session.debug.spawns+count.oneShot+count.whoami+count.icacls;
   count.identityReads=count.pathIdentityReads+count.descriptorIdentityReads;
   console.log('SIGNAL_REPLACEMENT_SPAWNS',JSON.stringify({files,operation,...count,requests:count.children,powershellRequests:count.powershell,children,powershell:session?.debug.spawns??count.powershell}));
   resident.mockRestore();cp.execFileSync=exec;syncBuiltinESMExports();
   if(hideDescriptor)Object.defineProperty(process,hideKey,hideDescriptor);else Reflect.deleteProperty(process,hideKey);
   session.close();session=undefined;measurements.push({children,icacls:count.icacls});
  }
 };
 return{root,put,options,authority,active,runs,measure};
}
for(const files of [1,200])test(`RED36 win32 per-operation counts with ${files} files and changing directory keys`,async()=>{
 const f=fixture(files),p=pathsFor(f.root);
 await f.measure('park',()=>expect(parkSignalForDowngrade(f.root,f.options).parked).toBe(true));
 const bundle=fs.readdirSync(p.bundles)[0]!;
 await f.measure('replacement-1',()=>keepBothAndLinkAgain(f.root,f.authority,f.options));
 await f.measure('replacement-2',()=>keepBothAndLinkAgain(f.root,f.authority,f.options));
 const control=JSON.parse(fs.readFileSync(p.control,'utf8'));expect(control.replacements).toHaveLength(2);
 f.active.add('old');f.runs.add('queued');removeTempDirSync(p.channel);
 await f.measure('ready-replay',()=>replaySignalReplacements(f.root,f.authority,f.options));
 expect(f.active.size).toBe(0);expect(f.runs.size).toBe(0);
 expect(JSON.parse(fs.readFileSync(join(p.channel,'connection.json'),'utf8')).connectionId).toBe(control.replacements[1].freshId);
 expect(JSON.parse(fs.readFileSync(join(p.bundles,bundle,'signal/auth/key-0'),'utf8'))).toBe('FAKE-0');
});
for(const operation of ['write','rename','metadata-rename','mkdir','barrier'])test(`RED35 win32 per-operation counts interrupted after ${operation}`,async()=>{
 const f=fixture(200),p=pathsFor(f.root);parkSignalForDowngrade(f.root,f.options);
 if(operation==='rename'){
  f.put(join(p.signal,'auth/live-key'),'LIVE-FAKE');
  f.put(join(p.channel,'connection.json'),{version:1,connectionId:'live',generation:5,enabled:false,paused:true,revoking:false,binding:null,account:null});
 }
 let crashed=false;
 await f.measure(`interrupted-${operation}`,async()=>{
  try{await keepBothAndLinkAgain(f.root,f.authority,{...f.options,after:(op,path)=>{if(op===operation&&!crashed&&(operation!=='write'||path===p.control)){crashed=true;throw new Error('fixture crash');}}});}catch{expect(crashed).toBe(true);}
 });
 expect(crashed).toBe(true);
 const control=JSON.parse(fs.readFileSync(p.control,'utf8'));
 await f.measure(`resume-${operation}`,()=>control.replacements.length?replaySignalReplacements(f.root,f.authority,f.options):keepBothAndLinkAgain(f.root,f.authority,f.options));
 expect(fs.existsSync(p.signal)).toBe(false);expect(f.active.size).toBe(0);expect(f.runs.size).toBe(0);
});
