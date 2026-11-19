// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import * as roots from './roots.ts';
import { MountInventory,MountProbe } from './mounts.ts';
import { mkdtempSync,mkdirSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('a stuck filesystem worker has a finite wait and no accumulating requests',async()=>{
 expect('BoundedPathPort' in roots).toBe(true);
 const {BoundedPathPort}=roots as typeof roots & {BoundedPathPort:new (options:{source:string;timeoutMs:number})=>roots.RootClassifier['port'] & {close():Promise<void>}};
 const port=new BoundedPathPort({timeoutMs:40,source:"const {workerData}=require('node:worker_threads'); workerData.port.on('message',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});"});
 try{
  const start=performance.now();expect(()=>port.realpath('/fixture/stalled')).toThrow(/timeout/);expect(performance.now()-start).toBeLessThan(500);
  // MAIN RULING INT-CONFLICT-DEFAULT: retry the stalled path; unrelated owners now retain an available worker.
  const retry=performance.now();for(let i=0;i<1000;i++)expect(()=>port.realpath('/fixture/stalled')).toThrow(/busy/);expect(performance.now()-retry).toBeLessThan(500);
 }finally{await port.close();}
});
it('asynchronous mount refresh keeps the previous inventory until atomic publication',async()=>{
 let finish:((roots:string[])=>void)|undefined,calls=0;
 const inventory=new MountInventory(()=>{calls++;return calls===1?['/srv/old']:new Promise<string[]>(resolve=>{finish=resolve;});});
 inventory.refresh();const refresh=inventory.refresh();
 expect(inventory.contains('/srv/old')).toBe(true);expect(inventory.contains('/srv/new')).toBe(false);
 finish!(['/srv/new']);await refresh;
 expect(inventory.contains('/srv/old')).toBe(false);expect(inventory.contains('/srv/new')).toBe(true);
});
it('the production worker preserves realpath, link identity, missing paths and device queries',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'wipe-probe-')),port=new roots.BoundedPathPort({timeoutMs:1000});
 try{
  const target=join(folder,'target'),link=join(folder,'link');mkdirSync(target);symlinkSync(target,link);
  expect(port.realpath(link)).toBe(target);expect(port.lstat(link)?.isSymbolicLink?.()).toBe(true);expect(port.stat(link)?.isSymbolicLink?.()).toBe(false);
  expect(port.stat(link)?.ino).toBe(port.stat(target)?.ino);expect(port.statfs(target)).not.toBeNull();expect(port.isBlockDevice(target)).toBe(false);
  expect(port.realpath(join(folder,'absent'))).toBeNull();expect(port.stat(join(folder,'absent'))).toBeNull();
  if(process.platform==='linux')expect(port.mountId(target)).toMatch(/^\d+$/);
 }finally{await port.close();rmSync(folder,{recursive:true,force:true});}
});
it('a stuck mount worker times out without blocking timers, replacing inventory or accumulating work',async()=>{
 const probe=new MountProbe("require('node:worker_threads').parentPort.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));",40);
 const inventory=new MountInventory(()=>probe.read());inventory.add('/srv/retained');
 try{
  let ticked=false;setTimeout(()=>{ticked=true;},5);
  await expect(inventory.refresh()).rejects.toThrow(/timeout/);expect(ticked).toBe(true);expect(inventory.contains('/srv/retained')).toBe(true);
  await expect(inventory.refresh()).rejects.toThrow(/busy/);expect(inventory.contains('/srv/retained')).toBe(true);
 }finally{await probe.close();}
});

it('path probe quarantine has a fixed worker ceiling even across unrelated stalls',async()=>{
 const port=new roots.BoundedPathPort({timeoutMs:150,source:"require('node:worker_threads').workerData.port.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));"});
 try{
  /* MAIN RULING WIPE-V3 S8: sixteen quarantined keys, retaining bounded healthy replacements. */
  for(let i=0;i<16;i++)expect(()=>port.realpath('/fixture/stall-'+i)).toThrow(/timeout/);
  const start=performance.now();for(let i=0;i<1000;i++)expect(()=>port.realpath('/fixture/overflow-'+i)).toThrow(/busy/);
  expect(performance.now()-start).toBeLessThan(500);
 }finally{await port.close();}
});
