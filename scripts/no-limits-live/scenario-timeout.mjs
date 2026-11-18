import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export function requestSignal(){
 const signal=scope.getStore();signal?.throwIfAborted();
 return signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
}
export async function cappedScenario(run,timeout){
 const controller=new AbortController();let timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{
  const error=Error(`Scenario timed out after ${timeout} ms`);reject(error);controller.abort(error);
 },timeout);});
 try{return await Promise.race([scope.run(controller.signal,run),expired]);}
 finally{clearTimeout(timer);}
}

export function scenarioGit(args,cwd,env){
 const signal=requestSignal();
 return new Promise((resolve,reject)=>{
  const child=spawn('git',args,{cwd,env,signal,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();
  child.on('error',reject);child.on('close',code=>code===0?resolve(output.trim()):reject(Error('Fixture Git operation failed')));
 });
}
