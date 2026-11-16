// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { ParkFs, ParkFsConfigurationError, type ParkFsOptions } from './park-fs.ts';
import { defaultSecurityRunner, type SecurityRunOptions, type SecurityRunner } from './storage.ts';
import { markWindowsSecuritySessionRunner, windowsSecuritySessionDebug } from './windows-security-session.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';

const roots:string[]=[],sid='S-1-5-21-1-2-3-1001';
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){const root=fs.mkdtempSync(join(tmpdir(),'park-injection-'));roots.push(root);return root;}
function row(path:string){return {path,attributes:fs.lstatSync(path).isDirectory()?16:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)`};}

for(const resident of [false,true])for(const injectedSid of [false,true])test(`F11 ${resident?'resident-capable':'one-shot'} injected runner owns reads, SID and all protection with injectedSid=${injectedSid}`,()=>{
 const root=fixture(),calls:Array<{exe:string;args:readonly string[];opts:SecurityRunOptions}>=[],native=windowsSecuritySessionDebug();
 const run:SecurityRunner=(exe,args,opts)=>{
  calls.push({exe,args,opts});
  if(exe.endsWith('whoami.exe'))return `"fixture\\owner","${sid}"`;
  if(exe.endsWith('icacls.exe'))return '';
  if(opts.env.MURAGE_SIGNAL_NEW)return 'MURAGE_SIGNAL_PROTECTED';
  return (JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[]).map(path=>JSON.stringify(row(path))).join('\n');
 };
 if(resident)markWindowsSecuritySessionRunner(run);
 let io!:ParkFs;
 expect(()=>{io=new ParkFs(root,{platform:'win32',windowsRun:run,...(injectedSid?{windowsSid:()=>sid}:{}),sync:()=> 'synced'});}).not.toThrow();
 // A singleton must use this runner too; a session-capable adapter gets a
 // PowerShell request while a one-shot adapter gets icacls through the adapter.
 expect(()=>io.mkdir(join(root,'single'))).not.toThrow();
 expect(()=>io.write(join(root,'nested/deep/control.json'),{fixture:true})).not.toThrow();
 expect(io.read(join(root,'nested/deep/control.json'),1024,true).toString()).toBe('{"fixture":true}');
 expect(calls.filter(call=>call.exe.endsWith('whoami.exe'))).toHaveLength(injectedSid?0:1);
 expect(calls.some(call=>call.opts.env.MURAGE_SIGNAL_ROOTS)).toBe(true);
 const batches=calls.filter(call=>call.opts.env.MURAGE_SIGNAL_NEW);
 expect(batches.some(call=>(JSON.parse(call.opts.env.MURAGE_SIGNAL_NEW!) as unknown[]).length===3)).toBe(true);
 expect(batches.every(call=>call.opts.env.MURAGE_SIGNAL_SID===sid)).toBe(true);
 if(resident)expect(batches.some(call=>(JSON.parse(call.opts.env.MURAGE_SIGNAL_NEW!) as unknown[]).length===1)).toBe(true);
 else expect(calls.some(call=>call.exe.endsWith('icacls.exe')&&call.args.some(arg=>arg.includes(sid)))).toBe(true);
 expect(windowsSecuritySessionDebug()).toEqual(native);
 expect(io.debug.childProcesses).toBe(calls.length);
});

for(const partial of ['SID only','SID and native runner','SID and entry','SID and protection','SID and batch protection','SID and entry with native runner'] as const)
 test(`F11 incomplete ${partial} fails at construction with typed configuration error before any I/O`,()=>{
  const root=fixture(),missing=join(root,'absent'),native=windowsSecuritySessionDebug();let callbacks=0;
  const options:ParkFsOptions={platform:'win32',windowsSid:()=>{callbacks++;return sid;},beforeWindowsRead:()=>{callbacks++;}};
  if(partial.includes('native runner'))options.windowsRun=defaultSecurityRunner;
  if(partial.includes('entry'))options.windowsEntry=path=>{callbacks++;return row(path);};
  if(partial==='SID and protection')options.protectNewWindowsEntry=()=>{callbacks++;return true;};
  if(partial==='SID and batch protection')options.protectNewWindowsEntries=()=>{callbacks++;return true;};
  let failure:unknown;try{new ParkFs(missing,options);}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(ParkFsConfigurationError);
  expect(failure).toHaveProperty('code','ERR_SIGNAL_PARK_WINDOWS_CONFIG');
  expect(callbacks).toBe(0);expect(fs.readdirSync(root)).toEqual([]);expect(windowsSecuritySessionDebug()).toEqual(native);
 });

for(const batch of [false,true])test(`F11 complete entry and ${batch?'batch':'singleton'} protection adapters use the injected SID without native security`,()=>{
 const root=fixture(),native=windowsSecuritySessionDebug(),protectedPaths:string[]=[];
 const protect=(path:string)=>{protectedPaths.push(path);return true;};
 const io=new ParkFs(root,{platform:'win32',windowsSid:()=>sid,windowsEntry:row,sync:()=> 'synced',
  ...(batch?{protectNewWindowsEntries:(paths:readonly string[])=>paths.every(protect)}:{protectNewWindowsEntry:protect})});
 io.write(join(root,'new/control.json'),{fixture:true});
 expect(protectedPaths).toHaveLength(2);expect(io.read(join(root,'new/control.json'),1024,true).toString()).toBe('{"fixture":true}');
 expect(windowsSecuritySessionDebug()).toEqual(native);
});
