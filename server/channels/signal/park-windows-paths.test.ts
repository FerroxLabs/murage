// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkFixtureMkdir, parkFixtureWrite } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs } from './park-fs.ts';
import { lstatIdentity } from './file-identity.ts';
import { windowsSecurityPathKey, windowsSecurityPathsSync, type SecurityRunner } from './storage.ts';

const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;;FA;;;${sid})`;
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
const row=(path:string,attributes=16)=>JSON.stringify({path,attributes,sddl});
const identityRealpath=()=>vi.spyOn(realpathSync,'native').mockImplementation(path=>String(path));
const shapes:Record<string,(path:string)=>string>={
 case:path=>path.toUpperCase(),
 'extended prefix':path=>'\\\\?\\'+path,
 'device prefix':path=>'\\\\.\\'+path,
 'trailing separator':path=>path+'\\',
 'forward slashes':path=>path.replace(/\\/g,'/'),
 'resolved components':path=>path+'\\child\\..',
};

for(const [shape,transform] of Object.entries(shapes))test(`recursive Windows rows and requests match ${shape}`,()=>{
 identityRealpath();
 const root='C:\\Signal Fixture',child=root+'\\auth',file=root+'\\key';
 // The requested root, recursiveRoot and returned root all have different spellings.
 const run:SecurityRunner=(_file,_args,opts)=>{
  expect(opts.env.MURAGE_SIGNAL_TREE).toBe(root);
  expect(opts.input).toContain("if ($env:MURAGE_SIGNAL_PATHS -eq '1') { $p = $item.FullName }");
  expect(opts.input).toContain('Get-Item -LiteralPath $p -Force');
  expect(opts.input).toContain('Get-Acl -LiteralPath $p');
  return [row(transform(root)),row(transform(child)),row(transform(file),0)].join('\n');
 };
 expect(windowsSecurityPathsSync([root],Date.now()+30_000,run,{},transform(root))).toHaveLength(3);
 // Canonicalization also applies when the requested path itself has the alternate shape.
 expect(windowsSecurityPathsSync([transform(root)],Date.now()+30_000,()=>row(root))).toHaveLength(1);
});

test('8.3 temporary root is expanded through native realpath before the PowerShell batch',()=>{
 const longRoot=privateParkTemp(join(tmpdir(),'windows long signal root-'));roots.push(longRoot);
 const shortRoot=join(tmpdir(),'WINDOW~1');
 const native=realpathSync.native;
 const realpath=vi.spyOn(realpathSync,'native').mockImplementation(path=>String(path)===shortRoot?native(longRoot):native(path));
 const run:SecurityRunner=(_file,_args,opts)=>{
  expect(JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!)).toEqual([native(longRoot)]);
  expect(opts.env.MURAGE_SIGNAL_TREE).toBe(native(longRoot));
  return [row(native(longRoot)),row(join(native(longRoot),'key'),0)].join('\n');
 };
 expect(windowsSecurityPathsSync([shortRoot],Date.now()+30_000,run,{},longRoot)).toHaveLength(2);
 expect(realpath).toHaveBeenCalledWith(shortRoot);
});

test('Windows comparison keys preserve drive roots and normalize extended UNC paths',()=>{
 expect(windowsSecurityPathKey('c:/')).toBe('c:\\');
 expect(windowsSecurityPathKey('\\\\?\\C:\\')).toBe('c:\\');
 expect(windowsSecurityPathKey('\\\\?\\UNC\\Server\\Share\\Signal\\')).toBe(windowsSecurityPathKey('\\\\server\\share/signal'));
});

test('root directories and root files themselves are included',()=>{
 identityRealpath();
 for(const attributes of [0,16])expect(windowsSecurityPathsSync(['C:\\'],Date.now()+30_000,()=>row('c:/',attributes),{},'c:/')).toEqual([{path:'c:/',attributes,sddl}]);
});

test('missing requests, omitted rows, outside children and canonical duplicates fail closed',()=>{
 const root=privateParkTemp(join(tmpdir(),'windows-paths-missing-'));roots.push(root);
 const run=vi.fn<SecurityRunner>();
 expect(windowsSecurityPathsSync([join(root,'absent')],Date.now()+30_000,run)).toBeNull();
 expect(run).not.toHaveBeenCalled();
 identityRealpath();
 const path='C:\\Signal';
 for(const output of [row(path+'\\child'),row(path)+'\n'+row(path+'-outside\\key'),row(path)+'\n'+row('C:\\other'),row(path)+'\n'+row(path.toUpperCase())]){
  expect(windowsSecurityPathsSync([path],Date.now()+30_000,()=>output,{},path)).toBeNull();
 }
 expect(windowsSecurityPathsSync([path],Date.now()+30_000,run,{},'C:\\other')).toBeNull();
 expect(windowsSecurityPathsSync([],Date.now()+30_000,run,{},path)).toBeNull();
});

test('ParkFs maps differently shaped recursive FullName rows back to its snapshot',()=>{
 const root=privateParkTemp(join(tmpdir(),'windows-paths-cache-'));roots.push(root);
 const dir=join(root,'auth'),key=join(dir,'key');parkFixtureMkdir(dir);parkFixtureWrite(key,'fixture');
 let recursive=false;
 const run:SecurityRunner=(_file,_args,opts)=>{
  const paths=JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[];
  if(opts.env.MURAGE_SIGNAL_TREE){recursive=true;paths.push(dir,key);}
  return paths.map(path=>row('\\\\?\\'+win32.resolve(path).toUpperCase(),path===key?0:16)).join('\n');
 };
 const io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid});
 expect(io.fingerprint(root).entries).toBe(3);
 expect(recursive).toBe(true);
 expect(io.read(key,64,true).toString()).toBe('fixture');
 const prior=io['security'].size;const runAgain=vi.fn<SecurityRunner>();io.options.windowsRun=runAgain;
 expect(io['windowsRow'](win32.resolve(key).toUpperCase().replace(/\\/g,'/'),lstatIdentity(key))?.sddl).toBe(sddl);
 expect(io['security'].size).toBe(prior);expect(runAgain).not.toHaveBeenCalled();
});

test('lowercase Node drive and uppercase PowerShell descendants match the recursive request',()=>{
 identityRealpath();const root='c:\\x\\signal';
 expect(windowsSecurityPathsSync([root],Date.now()+30_000,()=>[row('C:\\X\\SIGNAL'),row('C:\\X\\SIGNAL\\auth')].join('\n'),{},root)).toHaveLength(2);
});
