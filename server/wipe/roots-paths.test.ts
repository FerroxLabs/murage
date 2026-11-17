// secret-scan: fixture
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll,expect,it } from 'vitest';
import { lstatSync,statSync,realpathSync,mkdtempSync,mkdirSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wipeBreaker } from '../wipe-breaker.ts';
import { RootClassifier,canonicalPath } from './roots.ts';
import { known } from './types.ts';
import { deviceAliases, deviceContexts } from '../testing/wipe-device-aliases.ts';
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

for(const context of deviceContexts){
 it.each(deviceAliases)(`${context.name} classifier recognizes canonical device alias %s`,path=>{
  const classifier=new RootClassifier({...ctx,platform:context.platform,cwd:context.cwd},{contains:()=>false});
  expect(classifier.isDevice(known(path)),path).toBe(true);
 });
 it.each(['/./dev/null','//dev/zero','/tmp/../dev/null/','/dev/../tmp/sda','/tmp/./dev/sda','./dev/sda','D:/dev/sda'])(`${context.name} canonical ordinary output still runs: %s`,path=>{
  expect(wipeBreaker('dd if=/dev/zero of='+path,{...ctx,platform:context.platform,dialect:context.dialect,cwd:context.cwd}),path).toBeNull();
 });
}

it.each(['//share/data/../file','//share/data/./file','//share/data//file/'])('canonicalization retains the Windows UNC share boundary: %s',path=>{
 const paths=toAbsolute(known(path),{cwd:known(ctx.cwd),platform:'win32'});
 expect(canonicalPath(paths[0]!,'win32')).toBe('//share/data/file');
});
it.each(['/dev/link/.','/./dev/link/.','/tmp/../dev/link/.'])('canonicalization retains final-dot link traversal: %s',path=>{
 const paths=toAbsolute(known(path),{cwd:known('C:/work/project'),platform:'win32',links:new Map([['C:/dev/link','C:/Users/fixture']])});
 expect(canonicalPath(paths[0]!,'win32')).toBe('C:/users/fixture');
});


const posixRoots={platform:'linux' as const,dialect:'sh' as const,cwd:'/work/project',project:'/work/project',home:'/home/fixture',dataDir:'/state/app',pathPort,registry:{contains:(p:string)=>['/root/.ssh','/registry/project'].includes(p)},mountInventory:{contains:()=>false}};
const protectedPaths=['/etc','/root/.ssh','/home/fixture','/work/project','/state/app','/registry/project'];
for(const dialect of ['sh','pwsh'] as const){
 for(const root of protectedPaths){
  const aliases=['/'+root,'//'+root,root+'/',root.replace(/\//g,'//'),root.replace(/\/([^/]+)$/,'/./$1'),'/tmp/..'+root];
  it.each(aliases)(`H1 ${dialect} protected ${root} keeps its exact card through %s`,path=>{
   const context={...posixRoots,dialect},command=(p:string)=>(dialect==='sh'?'rm -rf ':"Remove-Item -Recurse ")+"'"+p+"'";
   const expected=wipeBreaker(command(root),context);expect(expected).not.toBeNull();
   expect(wipeBreaker(command(path),context),path).toEqual(expected);
  });
 }
}
it.each(['//etc','///etc','//root/.ssh','//home/fixture','//work/project','//state/app','//registry/project'])('H1 ambiguous win32 shell keeps POSIX root checks: %s',path=>{
 const context={...posixRoots,platform:'win32' as const,cwd:'C:/scratch'},expected=wipeBreaker('rm -rf '+path.replace(/^\/+/, '/'),posixRoots);
 expect(expected).not.toBeNull();expect(wipeBreaker('rm -rf '+path,context)).toEqual(expected);
});
it.each(['//etc','//root/.ssh','//home/fixture','///etc'])('H1 POSIX canonical operand remains POSIX: %s',path=>{
 expect(toAbsolute(known(path),{cwd:known('/work/project'),platform:'linux',dialect:'sh'})[0]).toBe(path.replace(/^\/+/, '/'));
});

const physicalFixture=mkdtempSync(join(tmpdir(),'wipe-physical-'));
const physicalHome=join(physicalFixture,'home'),physicalLink=join(physicalFixture,'home-link');
mkdirSync(join(physicalHome,'x'),{recursive:true});symlinkSync(physicalHome,physicalLink,'junction');
afterAll(()=>rmSync(physicalFixture,{recursive:true,force:true}));
const physicalPort={isBlockDevice:()=>false,realpath:(p:string)=>realpathSync.native(p),stat:(p:string)=>statSync(p),lstat:(p:string)=>lstatSync(p)};
const physicalContext={...posixRoots,home:physicalHome,project:join(physicalHome,'x'),pathPort:physicalPort};
it.each(['/.','/./','/','//','/./x/..','/x/..','/../home'])('H2 filesystem link%s keeps physical home traversal',suffix=>{
 const expected=wipeBreaker("rm -rf '"+physicalHome+"'",physicalContext);expect(expected).toMatchObject({rule:'delete-home'});
 expect(wipeBreaker("rm -rf '"+physicalLink+suffix+"'",physicalContext)).toEqual(expected);
});
it('H2 filesystem inner dot keeps physical project traversal',()=>{
 expect(wipeBreaker("rm -rf '"+physicalLink+"/./x'",physicalContext)).toEqual(wipeBreaker("rm -rf '"+physicalHome+"/x'",physicalContext));
 expect(wipeBreaker("rm -rf '"+physicalLink+"/./x'",physicalContext)).toMatchObject({rule:'delete-system-folder'});
});
it('H2 filesystem final link removal keeps its ordinary reading',()=>{
 expect(wipeBreaker("rm -rf '"+physicalLink+"'",physicalContext)).toBeNull();
});
it.each(['/tmp/home-link/.','/tmp/home-link/./','/tmp//home-link/.','/tmp/home-link/./x/..','/tmp/home-link/../fixture'])('H2 overlay preserves traversal before normalization: %s',path=>{
 const text='ln -s /home/fixture /tmp/home-link; rm -rf '+path;
 expect(wipeBreaker(text,posixRoots)).toEqual(wipeBreaker('rm -rf /home/fixture',posixRoots));
 expect(wipeBreaker(text,posixRoots)).toMatchObject({rule:'delete-home'});
});
it('H2 overlay final link remains ordinary',()=>{
 expect(wipeBreaker('ln -s /home/fixture /tmp/home-link; rm -rf /tmp/home-link',posixRoots)).toBeNull();
});

it.each(['C:/Users/fixture','C:\\Users\\fixture','C:/Users\\fixture','C:\\Users/fixture',('C:/Users' + '//fixture/'),('C:/Users' + '/./fixture'),'C:/scratch/../Users/fixture','\\\\?\\C:\\Users\\fixture','\\\\.\\C:\\Users\\fixture','//?/C:/Users/fixture','//./C:/Users/fixture'])('sweep Windows protected home spelling: %s',path=>{
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...ctx,dialect:'pwsh'})).toEqual(wipeBreaker("Remove-Item -Recurse 'C:/Users/fixture'",{...ctx,dialect:'pwsh'}));
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...ctx,dialect:'pwsh'})).toMatchObject({rule:'delete-home'});
});
it.each(['C:/scratch/link/.','C:\\scratch\\link\\.','C:/scratch\\link/./','\\\\?\\C:\\scratch\\link\\.','\\\\.\\C:\\scratch\\link\\.'])('H2 Windows overlay keeps physical home: %s',path=>{
 const text="New-Item -ItemType Junction -Path 'C:/scratch/link' -Target 'C:/Users/fixture'; Remove-Item -Recurse '"+path+"'";
 expect(wipeBreaker(text,{...ctx,dialect:'pwsh'})).toEqual(wipeBreaker("Remove-Item -Recurse 'C:/Users/fixture'",{...ctx,dialect:'pwsh'}));
 expect(wipeBreaker(text,{...ctx,dialect:'pwsh'})).toMatchObject({rule:'delete-home'});
});

it.each(['\\\\?\\C:\\scratch\\ordinary','//?/C:/scratch/ordinary','\\\\.\\C:\\scratch\\ordinary','//./C:/scratch/ordinary'])('sweep Windows namespace ordinary output: %s',path=>{
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...ctx,dialect:'pwsh'})).toBeNull();
});


it.each(['/tmp//home-link/../fixture','//tmp/home-link/../fixture','/tmp/./home-link/../fixture'])('H2 overlay physical parent survives separator aliases: %s',path=>{
 expect(wipeBreaker('ln -s /home/fixture /tmp/home-link; rm -rf '+path,posixRoots)).toEqual(wipeBreaker('rm -rf /home/fixture',posixRoots));
 expect(wipeBreaker('ln -s /home/fixture /tmp/home-link; rm -rf '+path,posixRoots)).toMatchObject({rule:'delete-home'});
});
it.each(['//?/C:/Users/fixture','//./C:/Users/fixture','\\\\?/C:/Users/fixture','//?\\C:/Users\\fixture','\\\\.\\C:/Users\\fixture'])('sweep direct classifier namespace: %s',path=>{
 expect(canonicalPath(path,'win32')).toBe('C:/users/fixture');
 expect(new RootClassifier(ctx,{contains:()=>false}).classifyLexical(path)).toBe('home');
});
it.each(['//?/UNC/share/data','//./UNC/share/data','\\\\?\\UNC\\share\\data','\\\\.\\UNC\\share\\data'])('sweep UNC namespace keeps protected share: %s',path=>{
 expect(canonicalPath(path,'win32')).toBe('//share/data');
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...ctx,dialect:'pwsh'})).toMatchObject({rule:'delete-root'});
});
it.each(['//?/C:/scratch/link/.','\\\\?/C:/scratch/link/.','//?\\C:/scratch\\link/.'])('H2 direct Windows overlay normalizes namespace separators: %s',path=>{
 const paths=toAbsolute(known(path),{cwd:known(ctx.cwd),platform:'win32',links:new Map([['C:/scratch/link','C:/Users/fixture']])});
 expect(canonicalPath(paths[0]!,'win32')).toBe('C:/users/fixture');
});
for(const root of ['C:/','C:/Windows','C:/work/project']){
 it.each([root.replaceAll('/','\\'),root.replaceAll('/','//'),root.replaceAll('/','/./'),'\\\\?\\'+root.replaceAll('/','\\'),'\\\\.\\'+root.replaceAll('/','\\'),'//?/'+root])(`sweep Windows ${root} protects its root alias %s`,path=>{
  const expected=wipeBreaker("Remove-Item -Recurse '"+root+"'",{...ctx,dialect:'pwsh'});expect(expected).not.toBeNull();
  expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...ctx,dialect:'pwsh'})).toEqual(expected);
 });
}

it.each(['\\\\?\\UNC\\share\\data','\\\\.\\UNC\\share\\data'])('sweep explicit Windows UNC namespace keeps its meaning on POSIX: %s',path=>{
 expect(canonicalPath(path,'linux')).toBe('//share/data');
 expect(wipeBreaker("rm -rf '"+path+"'",posixRoots)).toMatchObject({rule:'delete-root'});
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...posixRoots,dialect:'pwsh'})).toMatchObject({rule:'delete-root'});
});
it.each(['\\\\?\\UNC\\share\\data\\ordinary','\\\\.\\UNC\\share\\data\\ordinary'])('sweep explicit Windows UNC ordinary child: %s',path=>{
 expect(wipeBreaker("Remove-Item -Recurse '"+path+"'",{...posixRoots,dialect:'pwsh'})).toBeNull();
});

for(const dialect of ['pwsh','cmd'] as const){
 it.each([['\\Users','delete-home'],['\\Windows','delete-system-folder']] as const)(`sweep ${dialect} retains no-drive Windows root fallback: %s`,(path,rule)=>{
  const text=dialect==='pwsh'?"Remove-Item -Recurse '"+path+"'":'rd /s '+path;
  expect(wipeBreaker(text,{...posixRoots,dialect})).toMatchObject({rule});
 });
 it(`sweep ${dialect} leaves POSIX drive-like folders ordinary`,()=>{
  const text=dialect==='pwsh'?"Remove-Item -Recurse '/c/Users/fixture'":'rd /s /c/Users/fixture';
  expect(wipeBreaker(text,{...posixRoots,dialect})).toBeNull();
 });
}
