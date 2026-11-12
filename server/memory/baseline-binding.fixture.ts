// Behavioral start-commit probe. The fallback invokes the historical activation
// signature and historical route; it never substitutes a missing implementation.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(()=>vi.resetModules());
const fake=vi.hoisted(()=>({mode:'run',calls:new Map<object,any>(),attached:[] as any[],presented:[] as any[]}));
vi.mock('../decision/index.ts',()=>({
  openRequest:(source:any)=>{const h={};fake.calls.set(h,structuredClone(source));return h;},
  decide:()=>fake.mode==='run'?{kind:'run'}:{kind:'card',ref:{approvalId:'pending'}},
  executeServiceSync:(h:object,execute:any)=>({kind:'executed',value:execute(fake.calls.get(h).call)}),
  attachQueue:(ref:any,item:any)=>fake.attached.push({ref,item}),
  presentApprovalSync:(ref:any,view:any)=>fake.presented.push({ref,view}),
}));
vi.mock('../approval-decision.ts',()=>({approvalDecision:()=>fake.mode==='run'?{verdict:'run'}:{verdict:'card'}}));
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { appendMessage } from '../message-db.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { memoryAccess, reconcileMemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { memoryAgentRoute } from './routes.ts';
import * as authority from './authority.ts';
const a=authority as any;
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});fake.mode='run';fake.calls.clear();fake.attached=[];fake.presented=[];});
function fixture(){
 const roster={bots:[{id:'bot',threadId:'thread'}],groups:[]};reconcileMemoryRoster(roster);setMemoryMode('capture');
 appendMessage('thread',{id:'note',at:1,role:'user',origin:'desktop',kind:'text',text:'Original owner note'});
 const work=claimMemoryJob('baseline')!;publishMemoryWork(work,'baseline',captureWork(work));setMemoryMode('active');
 const registry=new InternalCapabilities();registry.begin('bot','thread','generation');
 const token=registry.mint({botId:'bot',threadId:'thread',generation:'generation',kind:'memory',depth:1,skillAuthoring:false});
 const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
 const evidence=[{sourceId:work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(work.text)}];
 const context={claim:{} as any,proof:{source:'baseline'}};
 const save=(text:string,key:string)=>authority.saveMemoryCandidate(text,evidence,key,access);
 const open=(id:string)=>{
   if(a.openMemoryRequest)return a.openMemoryRequest(context,access,id,1);
   // There was no request registration on the start commit. Retain the attempted
   // call only in the test driver, then call the real historical activation.
   const handle={};fake.calls.set(handle,{call:{tool:'memory_save',input:{candidateId:id,text:'first',generation:'generation',scopeId:'original',evidence:[{end_byte:work.text.length}]}}});
   return {handle};
 };
 const apply=(handle:object,id:string)=>a.openMemoryRequest?a.applyRequestedMemory(handle,access,id,1):a.applyRequestedMemory(access,id,1);
 const row=(id:string)=>database().prepare('SELECT state FROM memory_records WHERE id=?').get(id);
 const route=()=>memoryAgentRoute('/api/internal/memory/save',{text:'Supported note',evidence,idempotencyKey:'queued'},access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{authority:context});
 return {save,open,apply,row,route,revoke:()=>registry.revokeThread('thread')};
}
it('R16 baseline: candidate substitution is rejected without activating either candidate',()=>{
 const f=fixture(),first=f.save('first','a'),second=f.save('second','b'),request=f.open(first);
 let rejected=false;try{f.apply(request.handle,second);}catch{rejected=true;}
 expect({rejected,first:f.row(first)?.state,second:f.row(second)?.state}).toEqual({rejected:true,first:'candidate',second:'candidate'});
});
it.each(['tool','text','evidence','generation','scope'])('R16 baseline: changed registered %s never activates',field=>{
 const f=fixture(),id=f.save('first','a'),request=f.open(id),call=fake.calls.get(request.handle).call;
 if(field==='tool')call.tool='memory_correction';else if(field==='text')call.input.text='substitution';else if(field==='evidence')call.input.evidence[0].end_byte=1;else if(field==='scope')call.input.scopeId='substitution';else call.input.generation='substitution';
 let rejected=false;try{f.apply(request.handle,id);}catch{rejected=true;}
 expect({rejected,state:f.row(id)?.state}).toEqual({rejected:true,state:'candidate'});
});
for(const scenario of ['queue-before-attach','restart-enumeration','same-answer-dedup','renewal','failed-delivery-recovery','pending-answer-crash'])it(`A2/A4a baseline: ${scenario} retains the exact durable candidate request`,async()=>{
 const f=fixture();fake.mode='deny';const result:any=await f.route();
 const queue=a.memoryApprovalQueue?.();
 let item=queue?.pendingApprovals()[0];
 // Read the actual on-disk queue after the route, even when the historical
 // producer supplied no queue. This is an observable absent request, not an
 // import/export assertion. Each recovery scenario needs this durable input.
 const file=DATA_DIR+'/decision-queues/memory.json';
 let entries=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).entries:[];
 expect(entries.map((e:any)=>e.item.call.input.candidateId)).toContain(result.candidateId);
 expect(item.call.input.candidateId).toBe(result.candidateId);
 if(scenario==='queue-before-attach')expect(fake.attached[0].item.call).toEqual(item.call);
 if(scenario==='restart-enumeration'){
   const {MemoryApprovalQueue}=await import('./service-approval.ts');
   expect(new MemoryApprovalQueue('memory',file).pendingApprovals()).toEqual([item]);
 }
 if(scenario==='same-answer-dedup'){
   const answer={behavior:'allow'};expect(queue.respondNow(item,answer,{answerId:'answer'})).toEqual({state:'accepted'});
   expect(queue.respondNow(item,answer,{answerId:'answer'})).toEqual({state:'already'});
 }
 if(scenario==='renewal'){
   item=await queue.renew(item,{approvalId:'renewed',epoch:'renewed-epoch'});
   expect(JSON.parse(readFileSync(file,'utf8')).entries[0].item).toEqual(item);
 }
 if(scenario==='failed-delivery-recovery'||scenario==='pending-answer-crash'){
   if(scenario==='failed-delivery-recovery'){f.revoke();expect(queue.respondNow(item,{behavior:'allow'},{answerId:'answer'})).toEqual({state:'failed'});}
   else {entries[0]={...entries[0],state:'pending',answerId:'answer',answer:{behavior:'allow'}};writeFileSync(file,JSON.stringify({version:1,entries}));}
   const {MemoryApprovalQueue}=await import('./service-approval.ts');const accept=vi.fn();
   const recovered=new MemoryApprovalQueue('memory',file,accept,accept);
   expect(recovered.respondNow(item,{behavior:'allow'},{answerId:'answer'})).toEqual({state:'accepted'});expect(accept).toHaveBeenCalledOnce();
 }
});

useOutsideStoreFixture();
