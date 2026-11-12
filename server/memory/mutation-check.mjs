// Run only in the isolated test container. Every mutation is restored in finally.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const authority='server/memory/authority.ts', queue='server/memory/service-approval.ts';
const cases=[
  ['MM1-outside-hold',authority,
   "  const result=request.outcome.kind==='run'?applyRequestedMemory(request.handle,access,id,version):request.outcome;",
   "  if(turnOutsideRead(access.threadId)!==null)return;\n  const result=request.outcome.kind==='run'?applyRequestedMemory(request.handle,access,id,version):request.outcome;",
   'server/memory/registered-request.test.ts','owner RUN activates actual'],
  ['MM2-executor-bypass',authority,
   '  return executeServiceSync(handle,call=>applyRegisteredMemory(call,access,id,version));',
   "  const input=requestedMemoryInput(access,id,version);\n  applyRegisteredMemory({tool:input.operation==='correction'?'memory_correction':'memory_save',input},access,id,version);\n  return {kind:'executed',value:undefined};",
   'server/memory/registered-request.test.ts','changed deny at execution'],
  ['MM3-request-substitution',authority,
   '    if(call.tool!==tool || !isDeepStrictEqual(structuredClone(call.input),expected))throw new Error("MEMORY_REQUEST_MISMATCH");',
   '    // MUTANT: candidate and operation are no longer bound to the registered call.',
   'server/memory/registered-request.test.ts','handle for candidate A'],
  ['MM4-base-widening',queue,
   'const outcome = decide(handle,()=>{baseBranch=true;return base;});',
   "const outcome = decide(handle,()=>{baseBranch=true;return {approve:'mutant',source:'always-allow'};});",
   'server/memory/registered-request.test.ts','guest BASE'],
  ['MM5-queue-after-attach',queue,
   '    const item=this.stage(request,ref); // queue FIRST, fsynced',
   '    const item=frozen(copy({...request.item,approvalId:ref.approvalId})); // MUTANT: queue not durable at attach',
   'server/memory/service-approval.test.ts','writes queue before attach'],
  ['MM6-owner-ticket-mint',authority,
   'function applyRegisteredMemory(call:ServiceCall,access:MemoryAccess,id:string,version:number):void {',
   'function applyRegisteredMemory(call:ServiceCall,access:MemoryAccess,id:string,version:number):void {\n  ownerMemoryTicket();',
   'server/memory/registered-request.test.ts','never mint a desktop owner ticket'],
];
const out='server/memory/.s2m-evidence';mkdirSync(out,{recursive:true});
let failures=0;
for(const [name,file,before,after,test,pattern]of cases){
 const original=readFileSync(file,'utf8');
 if(!original.includes(before))throw new Error(`Missing mutation target: ${name}`);
 try{
  writeFileSync(file,original.replace(before,after));
  const command=['node_modules/vitest/vitest.mjs','run',test,'-t',pattern];
  const run=spawnSync(process.execPath,command,{encoding:'utf8',timeout:120000});
  const output=`COMMAND: ${JSON.stringify([process.execPath,...command])}\n${run.stdout??''}${run.stderr??''}`;
  writeFileSync(`${out}/${name}.log`,output);
  const killed=run.status!==0 && run.signal===null && /AssertionError/.test(output) && /Tests\s+\d+ failed/.test(output);
  console.log(`${name}: ${killed?'KILLED':'SURVIVED OR INVALID'} exit=${run.status}`);
  if(!killed)failures++;
 }finally{writeFileSync(file,original);}
}
if(failures)process.exitCode=1;
