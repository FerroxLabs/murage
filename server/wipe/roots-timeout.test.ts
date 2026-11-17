// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it,vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { systemPathPort } from './roots.ts';
vi.hoisted(()=>vi.resetModules());
const fixture=vi.hoisted(()=>({entered:new SharedArrayBuffer(4)}));
vi.mock('node:worker_threads',async original=>{
 const real=await original<typeof import('node:worker_threads')>();
 return {...real,Worker:class extends real.Worker {
  constructor(source:string|URL,options:import('node:worker_threads').WorkerOptions){
   if(options.workerData?.port){
    options={...options,workerData:{...options.workerData,entered:fixture.entered}};
    source=`const native=require('node:fs').realpathSync.native;require('node:fs').realpathSync.native=p=>{if(p==='/fixture/slow-probe'){const entered=new Int32Array(require('node:worker_threads').workerData.entered);Atomics.store(entered,0,1);Atomics.wait(entered,0,1,700);return p;}return native(p);};`+source;
   }
   super(source,options);
  }
 }};
});
it('the shipped physical probe returns before a slow filesystem call finishes',async()=>{
 const original=realpathSync.native;
 const spy=vi.spyOn(realpathSync,'native').mockImplementation(((p:string)=>{
  if(p==='/fixture/slow-probe'){const entered=new Int32Array(fixture.entered);Atomics.store(entered,0,1);Atomics.wait(entered,0,1,700);return p;}
  return original(p);
 }) as typeof original);
 try{
  // Warm the real worker before measuring the filesystem deadline.
  systemPathPort.realpath('/fixture/not-present');
  const start=performance.now();
  try{systemPathPort.realpath('/fixture/slow-probe');}catch(error){expect(String(error)).toMatch(/timeout/);}
  expect(Atomics.load(new Int32Array(fixture.entered),0)).toBe(1);
  expect(performance.now()-start).toBeLessThan(400);
 }finally{spy.mockRestore();if('close' in systemPathPort)await (systemPathPort as typeof systemPathPort & {close():Promise<void>}).close();}
});
