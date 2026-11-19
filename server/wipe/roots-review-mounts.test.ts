// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it,vi } from 'vitest';
import { wipeBreaker } from '../wipe-breaker.ts';
import { BoundedPathPort } from './roots.ts';
import { MountInventory } from './mounts.ts';
vi.hoisted(()=>vi.resetModules());
const fixture=vi.hoisted(()=>({platform:'',table:'',target:''}));
// Exercise the shipped worker dispatch and mount parser with inert OS responses.
vi.mock('node:worker_threads',async original=>{
 const real=await original<typeof import('node:worker_threads')>();
 return {...real,Worker:class extends real.Worker {
  constructor(source:string|URL,options:import('node:worker_threads').WorkerOptions){
   if(fixture.platform&&options.workerData?.port){
    const prelude=`const nativeRequire=require;require=name=>name==='node:fs'?{realpathSync:{native:p=>p},statSync:p=>({dev:p===${JSON.stringify(fixture.target)}?2n:1n,ino:3n,isSymbolicLink:()=>false}),lstatSync:p=>({dev:p===${JSON.stringify(fixture.target)}?2n:1n,ino:3n,isSymbolicLink:()=>false})}:name==='node:child_process'?{execFileSync:()=>${JSON.stringify(fixture.table)}}:nativeRequire(name);`;
    source=prelude+String(source).replaceAll('process.platform',JSON.stringify(fixture.platform));
   }
   super(source,options);
  }
 }};
});
const context={home:'/home/fixture',cwd:'/scratch',project:'/work/project',dataDir:'/state/app',registry:{contains:()=>false},mountInventory:{contains:()=>false}};
it.each([
 ['darwin','/Volumes/Fresh','/dev/fixture on / (apfs, local)\n/dev/volume on /Volumes/Fresh (apfs, local)\n'],
 ['win32','C:/attached/Fresh','    \\\\?\\Volume{fixture}\\\r\n        C:\\\r\n    \\\\?\\Volume{fresh}\\\r\n        C:\\attached\\Fresh\\\r\n'],
] as const)('H2 %s confirms a newly attached mount before inventory refresh',async(platform,path,table)=>{
 // WIPE-V3 S8 confirms a mount after its device differs from its parent.
 fixture.platform=platform;fixture.table=table;fixture.target=path;
 const port=new BoundedPathPort({timeoutMs:1000});
 // Start with an empty snapshot, then a failed background refresh.
 const inventory=new MountInventory(()=>{throw Error('fixture-refresh-failed');});
 expect(()=>inventory.refresh()).toThrow();expect(inventory.contains(path)).toBe(false);
 try{
  const ctx={...context,platform,pathPort:port,mountInventory:inventory};
  expect(port.mountId(path)).toBe(platform==='win32'?path.toLowerCase():path);
  expect(wipeBreaker('rm -rf '+path,ctx)).toBeTruthy();
  expect(inventory.has(path)).toBe(true);
  expect(wipeBreaker('rm -rf '+path+'/cache',ctx)).toBeNull();
  expect(wipeBreaker('rm -rf '+(platform==='darwin'?'/usr/local':'C:/scratch/ordinary'),ctx)).toBeNull();
  // A readable unmounted directory must immediately lose its former mount card.
  fixture.table=platform==='darwin'?'/dev/fixture on / (apfs, local)\n':'    \\\\?\\Volume{fixture}\\\r\n        C:\\\r\n';
  const next=new BoundedPathPort({timeoutMs:1000});
  try{expect(wipeBreaker('rm -rf '+path,{...ctx,pathPort:next})).toBeNull();expect(inventory.has(path)).toBe(false);}finally{await next.close();}
 }finally{fixture.platform='';await port.close();}
});
