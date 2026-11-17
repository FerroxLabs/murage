// The only Node process boundary. Windows calls exchange requests with the
// already job-owned PowerShell parent; even a bootstrap exe is never spawned.
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {assertPhysicalPath} from './package-identity.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function exchange(request) {
 if(process.platform!=='win32')throw new Error('Windows native broker required');
 const directory=process.env.MURAGE_GATE_NATIVE_BROKER;
 if(!directory)throw new Error('Owned native broker missing');
 assertPhysicalPath(directory,'C:\\murage-ci');
 const id=randomUUID(),pending=join(directory,`${id}.pending`),input=join(directory,`${id}.request.json`),output=join(directory,`${id}.response.json`);
 writeFileSync(pending,JSON.stringify({...request,id}),{flag:'wx'});renameSync(pending,input);
 // The child budget is absolute; this grace is only for proof/response delivery.
 // A missing broker fails the driver, whose PowerShell parent closes its job.
 while(!existsSync(output)) {
  if(Date.now()>request.deadlineAt+20000)throw new Error('Native broker failed to return job-empty proof');
  await pause(25);
 }
 const result=JSON.parse(readFileSync(output,'utf8').replace(/^\uFEFF/,''));unlinkSync(output);
 if(result.id!==id)throw new Error('Native broker response identity mismatch');
 return result;
}
function checkProof(proof) {
 if(!proof?.ownerClosed||!proof.empty||proof.flags!==8192||!Array.isArray(proof.remaining)||proof.remaining.length)throw new Error('Native helper missing closed, empty, no-breakaway job proof');
}
export function createNativeLauncher({transport=exchange,now=Date.now}={}) {
 const active=new Set();let closed=false;
 return {
  run(file,args,timeout=300000) {
   if(closed)throw new Error('Native launcher closed');
   if(typeof file!=='string'||!Array.isArray(args)||args.some(a=>typeof a!=='string')||!Number.isInteger(timeout)||timeout<1000||timeout>300000)throw new Error('Invalid native request');
   const promise=(async()=>{
    const result=await transport({file,args,deadlineAt:now()+timeout});
    checkProof(result.proof);
    if(result.error)throw new Error(result.error);
    if(result.exitCode!==0)throw new Error(`${file} exit=${result.exitCode}: ${result.stderr}`);
    return result.stdout;
   })();
   active.add(promise);promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise;
  },
  async close(){closed=true;const results=await Promise.allSettled([...active]);const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;}
 };
}
// Linux-only fixture harnesses share this exact module. They can never be used
// to bypass Windows ownership, including when called from test/check/mutate.
function linuxOnly(){if(process.platform!=='linux')throw new Error('Linux fixture execution only');}
export function runLinuxFixture(...args){linuxOnly();return spawnSync(...args);}
export function readLinuxFixture(...args){linuxOnly();return execFileSync(...args);}
export function startLinuxFixture(...args){linuxOnly();return spawn(...args);}
export async function closeLinuxFixture(child){linuxOnly();if(child.exitCode===null){child.stdin?.end();await new Promise(resolve=>{child.once('close',resolve);child.kill();});}}
export function runNodeFixture(args,options){return runLinuxFixture(process.execPath,args,options);}
export function startNodeFixture(args,options){return startLinuxFixture(process.execPath,args,options);}
// Fixed observations for the console fixture; never return the process object.
export function fixturePid(){return process.pid;}
export function fixtureInput(){return createInterface({input:process.stdin});}
export function windowsHideHookInstalled(){return !!process[Symbol.for('murage.windowsHide.installed')];}
export async function assertLinuxFixtureWindowsRefusal(assert) {
 linuxOnly();const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 try {
  Object.defineProperty(process,'platform',{value:'win32'});
  for(const fn of [runLinuxFixture,readLinuxFixture,startLinuxFixture])assert.throws(()=>fn('never-executed.exe',[]),/Linux fixture execution only/);
  for(const fn of [runNodeFixture,startNodeFixture])assert.throws(()=>fn([]),/Linux fixture execution only/);
  await assert.rejects(closeLinuxFixture({}),/Linux fixture execution only/);
 }finally{Object.defineProperty(process,'platform',descriptor);}
}

// Generate the fake engine bootstrap inside the process owner. Its dynamic
// load must follow the mount receipt write, before the fake engine takes stdin.
export function fixtureEngineEntry(fakeUrl,mountsFile) {
 return `import {appendFileSync} from 'node:fs';
const mounts=process.argv.filter(a=>/^mcp_servers\\.(gateecho|gatefallback)\\.(args|command)=/.test(a));
if(mounts.length)appendFileSync(${JSON.stringify(mountsFile)},JSON.stringify({pid:process.pid,kind:process.env.WINSCEN_ENGINE_KIND,mounts})+'\\n');
await import(${JSON.stringify(fakeUrl)});
`;
}
