// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { wipeBreaker } from '../wipe-breaker.ts';
import { RootClassifier,canonicalPath } from './roots.ts';
import { known } from './types.ts';
import { toAbsolute } from './expand.ts';
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

// POSIX tools can run in WSL or Git Bash even when the engine's cwd names a Windows drive.
for(const dialect of ['sh','pwsh','cmd'] as const){
 it.each(['/dev/project','/dev/project/*'])(`Windows ${dialect} keeps the drive project wipe at %s`,path=>{
  const command=(dialect==='sh'?'rm -rf ':dialect==='pwsh'?'Remove-Item -Recurse ':'rd /s ')+path;
  expect(wipeBreaker(command,{...ctx,dialect,project:'C:\\dev\\project'})).toMatchObject({rule:'delete-system-folder'});
 });
 it.each(['dd if=/dev/zero of=/dev/sda','dd if=/dev/zero of=/dev/./nvme0n1','cat blob > /dev/sda','tee /dev/sda','cp blob /dev/sda'])(`Windows ${dialect} keeps the POSIX device wipe: %s`,command=>{
  expect(wipeBreaker(command,{...ctx,dialect}),command).toMatchObject({rule:'disk-erase'});
 });
 it.each(['dd if=/dev/zero of=/dev/null','dd if=/dev/zero of=/dev/zero','dd if=/dev/zero of=./dev/sda','dd if=/dev/zero of=D:/dev/sda'])(`Windows ${dialect} ordinary output still runs: %s`,command=>{
  expect(wipeBreaker(command,{...ctx,dialect}),command).toBeNull();
 });
}

it('a POSIX device candidate never replaces the resolved Windows link target',()=>{
 const paths=toAbsolute(known('/dev/link/'),{cwd:known('C:/work/project'),platform:'win32',links:new Map([['C:/dev/link','C:/Users/fixture']])});
 expect(paths[0]).toBe('C:/Users/fixture');
 expect(paths).toContain('/dev/link/');
});
