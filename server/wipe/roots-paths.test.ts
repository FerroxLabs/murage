// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { wipeBreaker } from '../wipe-breaker.ts';
import { RootClassifier,canonicalPath } from './roots.ts';
import { known } from './types.ts';
const pathPort={realpath:(p:string)=>p,isBlockDevice:()=>null};
const ctx={home:'C:\\Users\\fixture',cwd:'C:\\work\\project',project:'C:\\work\\project',dataDir:'C:\\state\\app',platform:'win32' as const,pathPort,mountInventory:{contains:()=>false}};
it.each(['/c/Users','/c/Users/fixture/*','/mnt/c/Users','/mnt/c/Users/fixture/*','/c/','/mnt/c/','/c/Windows','/mnt/c/work/project'])('Windows shell alias %s retains the catastrophe card',path=>{
 expect(wipeBreaker('rm -rf '+path,ctx)).toBeTruthy();
});
it.each(['/c/Users/fixture','/mnt/c/Users/fixture'])('Windows shell cd into %s retains whole-home protection',path=>{
 expect(wipeBreaker('cd '+path+'; rm -rf *',ctx)).toBeTruthy();
});
it('root-relative Windows paths use the execution drive',()=>{
 const classifier=new RootClassifier({...ctx,cwd:'D:\\work\\project',home:'D:\\Users\\fixture'},{contains:()=>false});
 expect(classifier.classify(known('\\Users'))).toBe('homes-parent');
 expect(classifier.classify(known('\\Users\\fixture'))).toBe('home');
 expect(wipeBreaker('rd /s \\Users',{...ctx,dialect:'cmd'})).toBeTruthy();
 expect(wipeBreaker("Remove-Item -Recurse '\\Users'",{...ctx,dialect:'pwsh'})).toBeTruthy();
});
it('Windows alias normalization never expands ordinary children or POSIX drive-like folders',()=>{
 for(const path of ['/c/Users/fixture/cache','/mnt/c/work/project/build','/d/scratch/ordinary'])expect(wipeBreaker('rm -rf '+path,ctx),path).toBeNull();
 expect(canonicalPath('/c/Users','linux')).toBe('/c/Users');
 expect(canonicalPath('/mnt/c/Users','darwin')).toBe('/mnt/c/Users');
 expect(canonicalPath('\\\\share\\data','win32')).toBe('//share/data');
});
