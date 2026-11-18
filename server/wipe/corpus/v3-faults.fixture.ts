// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER bounded-probe/confirmMount producer: wipe-v3. OWNER injected faults: wipe-v3-tests.
import "../../../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../../../shared/win-hide-child-process.mjs";
import {Worker} from 'node:worker_threads';
import {fixturePathPort,linuxContext} from './v3-context.fixture.ts';
import type {PathPort} from '../types.ts';
// confirmMount is the S8 bounded dev-change confirmation seam. null/throw = fault.
export type ConfirmPort=PathPort & {confirmMount(path:string):boolean|null};
export const aliasPort:PathPort={
 ...fixturePathPort,
 realpath:p=>p.replace('/scratch/home-link','/home/u'),
};
export const probeWorkerSource=String.raw`
const {workerData}=require('node:worker_threads');
workerData.port.on('message',({method,path,signal})=>{
 if(path.startsWith('/hung/')||path.startsWith('/stalled/')){
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  return;
 }
 let value=null;
 if(method==='realpath')value=path.replace('/scratch/home-link','/home/u');
 if(method==='lstat'||method==='stat')value={dev:1,ino:path,symlink:false};
 if(method==='statfs')value={type:0xef53};
 if(method==='isBlockDevice')value=false;
 if(method==='confirmMount')value=false;
 if(method==='mountId')value='/';
 workerData.port.postMessage({value});
 const done=new Int32Array(signal);Atomics.store(done,0,1);Atomics.notify(done,0);
});`;
// The regression's synchronous allocation happens off the test runner's thread.
export async function boundedFacadeCheck(command:string):Promise<{rule:string|null;elapsed:number;error?:string}> {
 const moduleUrl=new URL('../../wipe-breaker.ts',import.meta.url).href;
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
 import(workerData.moduleUrl).then(({wipeBreaker})=>{
 const start=performance.now();
 const hit=wipeBreaker(workerData.command,{...workerData.context,pathPort:{realpath:p=>p,isBlockDevice:()=>false},registry:{contains:()=>false},mountInventory:{contains:()=>false}});
 parentPort.postMessage({rule:hit?.rule??null,elapsed:performance.now()-start});
 }).catch(()=>parentPort.postMessage({rule:null,elapsed:Infinity,error:'fixture-import'}));`,withHideInherit({
  eval:true,workerData:{moduleUrl,command,context:{...linuxContext(),pathPort:undefined,registry:undefined,mountInventory:undefined}},
  execArgv:['--experimental-strip-types'],resourceLimits:{maxOldGenerationSizeMb:96},
 }));
 try{return await new Promise(resolve=>{
  const timer=setTimeout(()=>resolve({rule:null,elapsed:Infinity,error:'deadline'}),2000);
  worker.once('message',result=>{clearTimeout(timer);resolve(result);});
  worker.once('error',()=>{clearTimeout(timer);resolve({rule:null,elapsed:Infinity,error:'worker-memory-or-runtime'});});
 });}finally{await worker.terminate();}
}
export const nested=(command:string)=>'('.repeat(17)+command+')'.repeat(17);
