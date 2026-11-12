import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.hoisted(()=>vi.resetModules());
import * as d from '../decision/index.ts';
import * as policy from '../decision/implementation.ts';
const presentations=()=>(policy as any).fixturePresentations as Promise<void>[];
import type { Initiator, Registration } from '../decision/index.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { Store } from '../store.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { appendMessage } from '../message-db.ts';
import { RoutineManager } from '../routines.ts';
import { markTurnOutside } from '../email/external-marks.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { memoryAccess, reconcileMemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { authenticatedMemoryAgentRoute } from './http-authority.ts';

const report='server/memory/.afix-evidence/field-results.jsonl';
beforeAll(()=>{mkdirSync('server/memory/.afix-evidence',{recursive:true});writeFileSync(report,'');});
const recordField=(row:unknown)=>appendFileSync(report,JSON.stringify(row)+'\n');
let disposers:Array<()=>void>=[];
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});presentations().length=0;});
afterEach(async()=>{await Promise.all(presentations());for(const dispose of disposers.splice(0))dispose();});

async function fixture(level:Registration['level']='unlimited',owner=true){
  const store=new Store(),bot=store.createBot({name:'Synthetic field bot'},{seedMessages:false});
  store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true});
  const threadId=bot.threadId,generation='fixture-generation';
  reconcileMemoryRoster({bots:store.bots,groups:store.groups});setMemoryMode('capture');
  appendMessage(threadId,{id:'owner-note',at:1,role:'user',origin:'desktop',kind:'text',text:'Original owner note'});
  const work=claimMemoryJob('fixture')!;publishMemoryWork(work,'fixture',captureWork(work));setMemoryMode('active');
  const target=String(database().prepare('SELECT id FROM memory_records WHERE state=\'active\'').get()!.id);
  const registry=new InternalCapabilities();registry.begin(bot.id,threadId,generation);
  const token=registry.mint({botId:bot.id,threadId,generation,kind:'memory',skillAuthoring:false,depth:1});
  const capability=registry.resolve(`Bearer ${token}`)!;
  const access=memoryAccess(registry,capability,()=>({bots:store.bots,groups:store.groups}));
  let initiator:Initiator=owner?{k:'owner-typed'}:{k:'guest'};
  let routine:any;
  const observations:any[]=[];let deny=false;
  disposers.push(d.installDecisionHost({store,view:()=>({title:'Synthetic field action',subtitle:'Fixture'})}));
  d.installProvenanceReader({turnGenerationFor:()=>generation,provenance:()=>({threadId,botId:bot.id,generation,principal:'owner',roomOwnerOnly:true,at:1,initiator}),live:()=>({botId:bot.id,turnId:'native-turn',providerInstanceId:'fake-provider',principal:'owner',owner,level,routine})});
  d.installDenySources({revision:()=>[String(deny)],resolve:()=>deny?[{kind:'deny',class:'owner-rule',ruleId:'synthetic-deny',span:'fixture'}]:[]});
  disposers.push(d.installDecisionObserver(o=>observations.push(o)));
  const nativeListeners:Array<(event:any)=>void>=[];
  disposers.push(d.installRequestIngress({subscribe:fn=>{nativeListeners.push(fn);return()=>{};}}));
  const evidence=[{sourceId:work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(work.text)}];
  const call=async(operation:'save'|'correction',key='field')=>{
    const path=operation==='save'?'/api/internal/memory/save':'/api/internal/memory/propose-correction';
    const body=operation==='save'?{text:'Quoted rm -rf ~ is data',evidence,idempotencyKey:key}:{id:target,version:1,replacement:'Quoted rm -rf ~ is data',evidence,idempotencyKey:key};
    const args=[path,body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{}] as const;
    return authenticatedMemoryAgentRoute(registry,capability,...args) as Promise<{candidateId:string;state:string;pendingReview:boolean}>;
  };
  return {store,bot,threadId,target,call,observations,registry,capability,access,
    deny:()=>{deny=true;},
    native:(tool:string,input:unknown)=>{
      const requestId='native-'+observations.length;
      for(const emit of nativeListeners)emit({type:'request.opened',threadId,requestId,turnId:'native-turn',providerInstanceId:'fake-provider',tool,summary:'Synthetic Sable shape',requestType:'permission',toolCall:{name:tool,input}});
      return d.decide(d.openRequest({kind:'engine',threadId,requestId}),()=>({approve:null,source:'always-ask',rule:'outside-turn'}));
    },
    routine:(runId:string)=>{
      routine={sourceRunId:runId,sourceBotId:bot.id,recipientGeneration:generation,owner:true};
      initiator={k:'routine-run',form:'run',sourceRunId:runId,sourceBotId:bot.id,recipientGeneration:generation,trigger:'manual'};
    },
  };
}
const shapes=[
  ['Bash',{command:'cd some/dir && ls'},'Bash cd/ls'],
  ['Write',{file_path:'/tmp/synthetic-field-note',content:'earlier-turn content'},'Write'],
  ['mcp__artifacts__register_artifact',{path:'/tmp/synthetic-field-note',title:'outside content'},'MCP register_artifact'],
  ['Bash',{command:"cat > /tmp/synthetic-field-note <<'EOF'\nfield note\nEOF"},'Bash heredoc/redirect'],
] as const;
for(const outside of ['web page','earlier turn','cloned folder'] as const)for(const [tool,input,shape]of shapes)for(const operation of ['save','correction'] as const){
  it(`Field 7 real policy: ${operation}, ${shape} after ${outside}: zero owner cards`,async()=>{
    const f=await fixture();markTurnOutside(f.threadId,outside);
    expect(f.native(tool,input)).toEqual({kind:'run'});
    const result=await f.call(operation);
    expect(result).toMatchObject({state:'active',pendingReview:false});
    expect(d.openApprovals(f.threadId)).toHaveLength(0);
    expect(f.observations.filter(o=>o.type==='registered').at(-1)).toMatchObject({actor:'owner',level:'unlimited'});
    expect(f.observations.filter(o=>o.type==='decided').every(o=>o.kind==='run')).toBe(true);
    recordField({case:'owner-field',outside,shape,tool,input,operation,state:result.state,pendingReview:result.pendingReview,cards:d.openApprovals(f.threadId).length,actor:'owner',level:'unlimited'});
    if(operation==='correction')expect(database().prepare('SELECT state FROM memory_records WHERE id=?').get(f.target)?.state).toBe('superseded');
  });
}
for(const outside of ['web page','earlier turn','cloned folder'] as const)for(const operation of ['save','correction'] as const){
  it(`memory claim under routine provenance (unit): ${operation} after ${outside}`,async()=>{
    const f=await fixture();markTurnOutside(f.threadId,outside);
    let complete!:(value:any)=>void,fail!:(error:unknown)=>void;
    const done=new Promise<any>((resolve,reject)=>{complete=resolve;fail=reject;});
    const manager=new RoutineManager({file:join(DATA_DIR,'field-routines.json'),now:()=>Date.now(),emit:()=>{},botState:()=> 'ready',createTask:()=>({threadId:f.threadId}),botMode:()=> 'unlimited',
      startTurn:async(_bot,thread,_prompt,_runOn,_trigger,_error,_event,_audience,runId)=>{
        try {expect(thread).toBe(f.threadId);expect(runId).toBeTruthy();f.routine(runId!);complete(await f.call(operation));}catch(error){fail(error);}
      }});
    disposers.push(()=>manager.stop());
    const routine=manager.create({name:'Synthetic routine after outside read',prompt:'Keep the supported note',botId:f.bot.id,target:'bot',runOn:'ember',enabled:false,schedule:{type:'interval',everyMinutes:30,anchorAt:Date.now()}});
    expect(routine.permissionMode).toBe('unlimited');
    const run=manager.runNow(routine.id);expect(run).not.toBeNull();
    const result=await done;expect(result).toMatchObject({state:'active',pendingReview:false});
    expect(f.observations.filter(o=>o.type==='registered').at(-1)).toMatchObject({actor:'owner-routine',level:'unlimited'});
    expect(d.openApprovals(f.threadId)).toHaveLength(0);
    expect(manager.listRuns().find(r=>r.id===run!.id)?.status).toBe('running');
    recordField({case:'routine-provenance-unit',outside,operation,routineId:routine.id,runId:run!.id,status:'running',state:result.state,pendingReview:result.pendingReview,cards:d.openApprovals(f.threadId).length,actor:'owner-routine',level:'unlimited'});
  });
}
for(const operation of ['save','correction'] as const){
  it(`Real policy: ${operation} keeps deny CARD`,async()=>{
    const f=await fixture();markTurnOutside(f.threadId,'web page');f.deny();
    expect(await f.call(operation)).toMatchObject({state:'candidate',pendingReview:true});
    await Promise.all(presentations());expect(d.openApprovals(f.threadId)).toHaveLength(1);
    expect(d.openApprovals(f.threadId)[0].why).toBe('deny');
  });
  for(const [level,owner]of [['unlimited',false],['ask',true],['auto',true],['full',true]] as const)it(`Real policy: ${operation} ${owner?'owner':'guest'} ${level} keeps BASE`,async()=>{
    const f=await fixture(level,owner);markTurnOutside(f.threadId,'earlier turn');
    expect(await f.call(operation)).toMatchObject({state:'candidate',pendingReview:true});
    await Promise.all(presentations());expect(d.openApprovals(f.threadId)).toHaveLength(1);expect(d.openApprovals(f.threadId)[0].why).toBe('base');
  });
}
it('HTTP caller always uses the authenticated memory adapter',()=>{
  const index=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
  expect(/authenticatedMemoryAgentRoute\(internalCapabilities,internalClaim,path/.test(index)).toBe(true);
});
useOutsideStoreFixture();

it('HTTP authority rejects a copied capability and a stopped generation',async()=>{
  const f=await fixture();const {memoryHttpAuthority}=await import('./http-authority.ts');
  expect(()=>memoryHttpAuthority(f.registry,{...f.capability})).toThrow('MEMORY_UNAUTHORIZED');
  f.registry.revokeThread(f.threadId);
  expect(()=>memoryHttpAuthority(f.registry,f.capability)).toThrow('MEMORY_UNAUTHORIZED');
});
it('HTTP authority cannot be moved to a different memory access',async()=>{
  const f=await fixture();
  expect(()=>authenticatedMemoryAgentRoute(f.registry,f.capability,'/api/internal/memory/save',{}, {...f.access,generation:'substituted'},{search:async()=>({hits:[],vectorRows:0})})).toThrow('MEMORY_UNAUTHORIZED');
});

for(const [tool,input,why]of [
  ['Bash',{command:'rm -rf ~'},'wipe'],
  ['Write',{file_path:'/etc/hosts',content:'synthetic fixture'},'deny'],
] as const)it(`Field exceptions: real ${why} target retains its card after an outside read`,async()=>{
  const f=await fixture();markTurnOutside(f.threadId,'web page');
  const result=f.native(tool,input);expect(result.kind).toBe('card');
  if(result.kind!=='card')throw new Error('Expected exception card');
  await d.presentApproval(result.ref,{title:'Synthetic exception',subtitle:'Fixture'});
  expect(d.openApprovals(f.threadId)).toHaveLength(1);expect(d.openApprovals(f.threadId)[0].why).toBe(why);
});
