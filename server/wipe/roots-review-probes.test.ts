// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { wipeBreaker } from '../wipe-breaker.ts';
import { BoundedPathPort } from './roots.ts';
const context={home:'/home/fixture',cwd:'/scratch',project:'/work/project',dataDir:'/state/app',registry:{contains:()=>false},mountInventory:{contains:()=>false}};
it('H1 an unrelated stalled owner does not disable physical home protection',async()=>{
 const source=String.raw`const {workerData}=require('node:worker_threads');workerData.port.on('message',({method,path,signal})=>{
 if(path==='/remote/stalled')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 const value=method==='realpath'?(path==='/scratch/home-link/'?'/home/fixture':path):method==='stat'||method==='lstat'?{dev:1n,ino:2n,symlink:false}:null;
 workerData.port.postMessage({value});const done=new Int32Array(signal);Atomics.store(done,0,1);Atomics.notify(done,0);
 });`;
 const port=new BoundedPathPort({source,timeoutMs:500});
 try{
  expect(port.realpath('/ready')).toBe('/ready');
  expect(()=>port.realpath('/remote/stalled')).toThrow(/timeout/);
  expect(wipeBreaker('rm -rf /scratch/home-link/*',{...context,pathPort:port})).toBeTruthy();
  expect(wipeBreaker('rm -rf /scratch/ordinary',{...context,pathPort:port})).toBeNull();
  const start=performance.now();for(let i=0;i<1000;i++)expect(()=>port.realpath('/remote/stalled')).toThrow(/busy/);
  expect(performance.now()-start).toBeLessThan(500);
 }finally{await port.close();}
});
