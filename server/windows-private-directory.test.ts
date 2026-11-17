// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createPrivateWindowsDirectories } from './windows-private-directory.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import type { SecurityRunner } from './channels/signal/windows-security-runner.ts';
const roots:string[]=[],sid='S-1-5-21-1-2-3-1001';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){const root=fs.mkdtempSync(join(tmpdir(),'windows-private-dir-'));roots.push(root);return root;}
test('fresh install root, events and native directories share one protection batch before content',()=>{
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events'),native=join(root,'native');let batches=0;
 const run:SecurityRunner=(_file,_args,opts)=>{
  batches++;expect(JSON.parse(opts.env.MURAGE_SIGNAL_NEW!)).toEqual([{path:root,directory:true},{path:events,directory:true},{path:native,directory:true}]);
  expect(fs.readdirSync(events)).toEqual([]);expect(fs.readdirSync(native)).toEqual([]);return 'MURAGE_SIGNAL_PROTECTED';
 };
 createPrivateWindowsDirectories([root,events,native],{run,sid:()=>sid});expect(batches).toBe(1);
 createPrivateWindowsDirectories([root,events,native],{run,sid:()=>sid});expect(batches).toBe(1);
});
test('failed creation cannot leave empty unprotected directories as an existing-path bypass',()=>{
 const parent=fixture(),root=join(parent,'profile');let attempts=0;
 const run:SecurityRunner=()=>{attempts++;throw new Error('denied');};
 for(let index=0;index<2;index++){
  expect(()=>createPrivateWindowsDirectories([root,join(root,'events')],{run,sid:()=>sid})).toThrow('Private directory protection failed');
  expect(fs.existsSync(root)).toBe(false);
 }
 expect(attempts).toBe(2);
});
test('a replaced directory refuses and cleanup preserves the replacement and its content',()=>{
 const parent=fixture(),root=join(parent,'profile');
 const run:SecurityRunner=()=>{fs.renameSync(root,join(parent,'original'));fs.mkdirSync(root);fs.writeFileSync(join(root,'foreign'),'PRESERVE');return 'MURAGE_SIGNAL_PROTECTED';};
 expect(()=>createPrivateWindowsDirectories([root,join(root,'events')],{run,sid:()=>sid})).toThrow('Private directory changed');
 expect(fs.readFileSync(join(root,'foreign'),'utf8')).toBe('PRESERVE');
});

test('a later mkdir failure cleans earlier empty allocations and retry protects them',()=>{
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events');
 const builtin=createRequire(import.meta.url)('node:fs') as typeof fs,mkdir=builtin.mkdirSync;
 const failure=Object.assign(new Error('mkdir denied'),{code:'EACCES'});let batches=0;
 builtin.mkdirSync=((path,...args)=>{if(String(path)===events)throw failure;return Reflect.apply(mkdir,builtin,[path,...args]);}) as typeof fs.mkdirSync;syncBuiltinESMExports();
 try{expect(()=>createPrivateWindowsDirectories([root,events],{sid:()=>sid})).toThrow(failure);}
 finally{builtin.mkdirSync=mkdir;syncBuiltinESMExports();}
 expect(fs.existsSync(root)).toBe(false);
 createPrivateWindowsDirectories([root,events],{sid:()=>sid,run:(_exe,_args,opts)=>{
  batches++;expect(JSON.parse(opts.env.MURAGE_SIGNAL_NEW!).map((row:{path:string})=>row.path)).toEqual([root,events]);return 'MURAGE_SIGNAL_PROTECTED';
 }});
 expect(batches).toBe(1);
});

for (const failure of ['whoami', 'powershell'] as const) test(`startup preserves data and logs once when ${failure} fails, then retries`, async () => {
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events'),native=join(root,'native');
 let fail=true, calls=0;
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const run:SecurityRunner=(file)=>{
  calls++;
  if(fail && (failure==='whoami' || !file.endsWith('whoami.exe')))throw Error('restricted native runner');
  return file.endsWith('whoami.exe') ? `"fixture","${sid}"` : 'MURAGE_SIGNAL_PROTECTED';
 };
 const options={run,retryProtection:true};
 await expect(Promise.resolve(createPrivateWindowsDirectories([root,events,native],options))).resolves.toBeUndefined();
 expect([root,events,native].every(path=>fs.statSync(path).isDirectory())).toBe(true);
 fs.writeFileSync(join(events,'history'),'RETAIN');
 await expect(Promise.resolve(createPrivateWindowsDirectories([root,events,native],options))).resolves.toBeUndefined();
 expect(warn).toHaveBeenCalledTimes(1);
 fail=false;
 await createPrivateWindowsDirectories([root,events,native],options);
 const afterSuccess=calls;
 await createPrivateWindowsDirectories([root,events,native],options);
 expect(calls).toBe(afterSuccess);
 expect(fs.readFileSync(join(events,'history'),'utf8')).toBe('RETAIN');
 expect(warn).toHaveBeenCalledTimes(1);
});
test('restricted PowerShell falls back to icacls without reapplying a successful ACL',async ()=>{
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events');
 const calls:string[]=[];
 const run:SecurityRunner=(file,args)=>{
  calls.push(file);
  if(file.endsWith('powershell.exe'))throw Error('PowerShell disabled');
  expect(file).toMatch(/icacls.exe$/);
  expect(args).toContain('/inheritance:r');
  return '';
 };
 await createPrivateWindowsDirectories([root,events],{run,sid:()=>sid,retryProtection:true});
 expect(calls.filter(file=>file.endsWith('icacls.exe'))).toHaveLength(2);
 await createPrivateWindowsDirectories([root,events],{run,sid:()=>sid,retryProtection:true});
 expect(calls).toHaveLength(3);
});


test('startup retries native ACL failures in the background, retaining history and stopping after success',async ()=>{
 vi.useFakeTimers();
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events');
 let fail=true,calls=0;
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const run:SecurityRunner=()=>{calls++;if(fail)throw Error('restricted');return 'MURAGE_SIGNAL_PROTECTED';};
 await createPrivateWindowsDirectories([root,events],{run,sid:()=>sid,retryProtection:true});
 fs.writeFileSync(join(events,'history'),'RETAIN');
 const beforeRetry=calls;fail=false;
 await vi.advanceTimersByTimeAsync(60_000);
 expect(calls).toBeGreaterThan(beforeRetry);
 expect(fs.readFileSync(join(events,'history'),'utf8')).toBe('RETAIN');
 const afterSuccess=calls;
 await vi.advanceTimersByTimeAsync(120_000);
 expect(calls).toBe(afterSuccess);
 expect(warn).toHaveBeenCalledTimes(1);
});

test('background retry never reapplies a directory ACL whose fallback already succeeded',async ()=>{
 vi.useFakeTimers();
 const parent=fixture(),root=join(parent,'profile'),events=join(root,'events');
 let fail=true;const protectedPaths:string[]=[];
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const run:SecurityRunner=(file,args)=>{
  if(file.endsWith('powershell.exe'))throw Error('restricted PowerShell');
  protectedPaths.push(String(args[0]));
  if(fail&&args[0]===events)throw Error('temporary failure');
  return '';
 };
 await createPrivateWindowsDirectories([root,events],{run,sid:()=>sid,retryProtection:true});
 fail=false;await vi.advanceTimersByTimeAsync(60_000);
 expect(protectedPaths.filter(path=>path===root)).toHaveLength(1);
 expect(protectedPaths.filter(path=>path===events)).toHaveLength(2);
});

test('background retry preserves a replacement directory and never applies our ACL to it',async ()=>{
 vi.useFakeTimers();
 const parent=fixture(),root=join(parent,'profile');let calls=0;
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const run:SecurityRunner=()=>{calls++;throw Error('restricted');};
 await createPrivateWindowsDirectories([root],{run,sid:()=>sid,retryProtection:true});
 fs.renameSync(root,join(parent,'original'));fs.mkdirSync(root);fs.writeFileSync(join(root,'foreign'),'PRESERVE');
 const beforeRetry=calls;
 await vi.advanceTimersByTimeAsync(60_000);
 expect(calls).toBe(beforeRetry);
 expect(fs.readFileSync(join(root,'foreign'),'utf8')).toBe('PRESERVE');
});
