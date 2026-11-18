// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as sessions from './windows-security-session.ts';
import { defaultAsyncSecurityRunner, defaultSecurityRunner } from './windows-security-runner.ts';
const builtin=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'),originalExec=builtin.execFileSync;
const oneShot=vi.fn(()=> 'one-shot');
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',SYSTEM_MODULES='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
// A parent pwsh 7 (the CI step shell, or a person's terminal) hands its own module
// folders to every descendant; Windows PowerShell 5.1 cannot load them for Get-Acl.
const PWSH7_MODULES='C:\\Users\\fixture\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
beforeEach(()=>{oneShot.mockClear();builtin.execFileSync=oneShot as unknown as typeof builtin.execFileSync;syncBuiltinESMExports();});
const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
const hideKey=Symbol.for('murage.windowsHide.installed'),hideDescriptor=Object.getOwnPropertyDescriptor(process,hideKey);
function windows(){
 // The routing fixture changes platform on a POSIX worker; supply only the
 // inheritance adapter that a real Windows process installs at startup.
 if(!hideDescriptor)Object.defineProperty(process,hideKey,{value:{inherit:<T>(options:T)=>options},configurable:true});
 Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
}
afterEach(()=>{builtin.execFileSync=originalExec;syncBuiltinESMExports();Object.defineProperty(process,'platform',descriptor);if(hideDescriptor)Object.defineProperty(process,hideKey,hideDescriptor);else Reflect.deleteProperty(process,hideKey);vi.restoreAllMocks();});

test('production Windows runner routes every registered fixed security read and protection to the resident interpreter',()=>{
 windows();
 const script='fixed routing witness';sessions.registerWindowsSecurityScript(script);
 const resident=vi.spyOn(sessions,'runWindowsSecuritySession').mockReturnValue('resident');
 const options={input:script,env:{...process.env,PSModulePath:SYSTEM_MODULES},timeout:15_000};
 expect(defaultSecurityRunner('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-Command','-'],options)).toBe('resident');
 expect(resident).toHaveBeenCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-Command','-'],options);
 expect(oneShot).not.toHaveBeenCalled();
});

test('unregistered programs retain one-shot execution and cannot enter the fixed-script interpreter',()=>{
 windows();
 const resident=vi.spyOn(sessions,'runWindowsSecuritySession');
 expect(defaultSecurityRunner('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-Command','-'],{input:'unregistered program',env:process.env,timeout:15_000})).toBe('one-shot');
 expect(resident).not.toHaveBeenCalled();expect(oneShot).toHaveBeenCalledTimes(1);
});

test('one-shot Windows PowerShell receives only its own system module folder, never an inherited pwsh 7 PSModulePath',()=>{
 windows();
 expect(defaultSecurityRunner(POWERSHELL,['-Command','-'],{input:'unregistered program',env:{FIXTURE_KEEP:'1',PsModulePath:PWSH7_MODULES},timeout:15_000})).toBe('one-shot');
 const env=(oneShot.mock.calls[0] as unknown as [string,string[],{env:NodeJS.ProcessEnv}])[2].env;
 expect(Object.keys(env).filter(name=>name.toLowerCase()==='psmodulepath')).toEqual(['PSModulePath']);
 expect(env.PSModulePath).toBe(SYSTEM_MODULES);
 expect(env.FIXTURE_KEEP).toBe('1');
});

test('the resident security interpreter is spawned with the pinned module folder, not the parent pwsh 7 one',()=>{
 windows();
 const script='fixed module witness';sessions.registerWindowsSecurityScript(script);
 const resident=vi.spyOn(sessions,'runWindowsSecuritySession').mockReturnValue('resident');
 expect(defaultSecurityRunner(POWERSHELL,['-Command','-'],{input:script,env:{PSModulePath:PWSH7_MODULES,MURAGE_SIGNAL_ROOTS:'[]'},timeout:15_000})).toBe('resident');
 expect(resident.mock.calls[0]![2].env).toEqual({PSModulePath:SYSTEM_MODULES,MURAGE_SIGNAL_ROOTS:'[]'});
});

test('startup repair pins the module folder and other programs keep their environment unchanged',async()=>{
 const execFile=vi.spyOn(builtin,'execFile').mockImplementation(((_file:string,_args:string[],_options:unknown,callback:(error:null,stdout:string)=>void)=>{
  queueMicrotask(()=>callback(null,'repaired'));return {kill(){},stdin:{on(){},end(){}}};
 }) as unknown as typeof builtin.execFile);
 syncBuiltinESMExports();
 try{
  expect(await defaultAsyncSecurityRunner(POWERSHELL,['-Command','-'],{input:'repair',env:{PSModulePath:PWSH7_MODULES},timeout:1_000})).toBe('repaired');
  expect((execFile.mock.calls[0]![2] as {env:NodeJS.ProcessEnv}).env).toEqual({PSModulePath:SYSTEM_MODULES});
 }finally{execFile.mockRestore();syncBuiltinESMExports();}
 windows();
 defaultSecurityRunner('C:\\Windows\\System32\\icacls.exe',['x'],{env:{PSModulePath:PWSH7_MODULES},timeout:1_000});
 expect((oneShot.mock.calls[0] as unknown as [string,string[],{env:NodeJS.ProcessEnv}])[2].env).toEqual({PSModulePath:PWSH7_MODULES});
});
