// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as sessions from './windows-security-session.ts';
import { defaultSecurityRunner } from './windows-security-runner.ts';
const builtin=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'),originalExec=builtin.execFileSync;
const oneShot=vi.fn(()=> 'one-shot');
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
 const options={input:script,env:process.env,timeout:15_000};
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
