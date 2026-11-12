import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export function requestSignal(){
 const signal=scope.getStore();signal?.throwIfAborted();
 return signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
}
export async function cappedScenario(run,timeout){
 const controller=new AbortController();let timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{
  const error=Error(`Scenario timed out after ${timeout} ms`);controller.abort(error);reject(error);
 },timeout);});
 try{return await Promise.race([scope.run(controller.signal,run),expired]);}
 finally{clearTimeout(timer);}
}
