// Target I/O/scanner/primitive owner: skills lane. Indexed recovery scheduler owner: decision lane.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import nativeFs, * as fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { fixture, d } from './decision/fixture.ts';
import * as skills from './skills.ts';
import * as scanner from './skill-guard/scan.ts';
import { planSkillSwitch, skillVerdictHash } from './skill-switch.ts';
import { readSwitchFile, parseSwitchMetadata, SWITCH_LIMITS } from './skill-switch-bounds.ts';
import { createOwnerSettlementRegistry } from './skill-switch-settlement.ts';
import { createSkillSwitchExecutor } from './skill-switch-executor.ts';
import { ProducerApprovalQueue } from './narrow-denials.ts';
import type { QueueRecoverySource } from './decision/types.ts';
import { Ledger } from './turn-settle.ts';
import { SetupAtSettle } from './setup-at-settle.ts';
import * as records from './decision/records.ts';
import * as atomic from './atomic.ts';
import { inspectSkillSwitch } from './skill-switch-executor.ts';
import { automaticSettlement } from './skill-switch-settlement.ts';

it('B04 setup settlement yields after sixteen selections across concurrent generations',async()=>{
  const ledger=new Ledger(),settle=new SetupAtSettle(ledger);
  let active=0,maximum=0,total=0,sinceYield=0,maxPerTick=0,yields=0;
  const immediate=globalThis.setImmediate;
  vi.spyOn(globalThis,'setImmediate').mockImplementation(((callback:any,...args:any[])=>immediate(()=>{
    maxPerTick=Math.max(maxPerTick,sinceYield);sinceYield=0;yields++;callback(...args);
  })) as typeof setImmediate);
  const runs:Promise<void>[]=[];
  for(let gen=0;gen<5;gen++){
    const id=`fixture-generation-${gen}`;ledger.open(id,'fixture-thread','codex','own');
    for(let i=0;i<8;i++)settle.file(id,{req:`fixture-${gen}-${i}`,option:true,push_suppressed:true},{open:()=>true,option:()=>true,
      apply:async()=>{maximum=Math.max(maximum,++active);total++;sinceYield++;await Promise.resolve();active--;return true;},push:()=>{throw new Error('unexpected ask');}});
    runs.push(settle.settle(id,'clean'));
  }
  await Promise.all(runs);maxPerTick=Math.max(maxPerTick,sinceYield);
  expect(total).toBe(40);expect(maximum).toBe(1);expect(maxPerTick).toBeLessThanOrEqual(16);expect(yields).toBeGreaterThanOrEqual(2);
});

const io={fds:new Map<number,string>(),bytes:new Map<string,number>(),opens:[] as string[],readOpens:[] as string[],readSeen:new Set<number>(),growth:undefined as undefined|{path:string;done:boolean}};
const grow=(path:string|undefined)=>{if(io.growth&&io.growth.path===path&&!io.growth.done){io.growth.done=true;nativeFs.appendFileSync(path,'x'.repeat(4096));}};
const originalFs={openSync:nativeFs.openSync,readSync:nativeFs.readSync,readFileSync:nativeFs.readFileSync,readdirSync:nativeFs.readdirSync};
beforeEach(()=>{
  vi.spyOn(nativeFs,'openSync').mockImplementation((...args)=>{const fd=originalFs.openSync(...args);io.fds.set(fd,String(args[0]));io.opens.push(String(args[0]));io.readSeen.delete(fd);return fd;});
  vi.spyOn(nativeFs,'readSync').mockImplementation(((...args:any[])=>{const path=io.fds.get(args[0])??'unknown';if(!io.readSeen.has(args[0])){io.readSeen.add(args[0]);io.readOpens.push(path);}grow(path);const n=(originalFs.readSync as any)(...args);io.bytes.set(path,(io.bytes.get(path)??0)+n);return n;}) as typeof nativeFs.readSync);
  vi.spyOn(nativeFs,'readFileSync').mockImplementation(((...args:any[])=>{const path=typeof args[0]==='number'?io.fds.get(args[0]):String(args[0]);if(path)io.readOpens.push(path);grow(path);const data=(originalFs.readFileSync as any)(...args);if(path)io.bytes.set(path,(io.bytes.get(path)??0)+Buffer.byteLength(data));return data;}) as typeof nativeFs.readFileSync);
  vi.spyOn(nativeFs,'readdirSync').mockImplementation(originalFs.readdirSync);
  syncBuiltinESMExports();
});
afterEach(()=>{vi.restoreAllMocks();syncBuiltinESMExports();io.fds.clear();io.bytes.clear();io.opens.length=0;io.readOpens.length=0;io.readSeen.clear();io.growth=undefined;});
const md=(name='sample-skill')=>`---\nname: ${name}\ndescription: Sample instructions\n---\nRead supplied notes.\n`;
const manifestPath=()=>join(DATA_DIR,'skill-state','b','skills.json');
function install(name='sample-skill') {
  const result=skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content:md(name)}]);expect(result).not.toHaveProperty('error');
}
function resetCounters(){io.fds.clear();io.bytes.clear();io.opens.length=0;io.readOpens.length=0;io.readSeen.clear();vi.mocked(fs.readFileSync).mockClear();vi.mocked(fs.readdirSync).mockClear();}

it('the primitive keeps its scan private from a mutable public listing or fabricated target',()=>{
  const host=fixture();install();
  const manifest=JSON.parse(fs.readFileSync(manifestPath(),'utf8'));manifest['sample-skill'].scan.verdict='review';fs.writeFileSync(manifestPath(),JSON.stringify(manifest));
  const target=skills.readSkillSwitchTarget('b','sample-skill')!;target.listing.scan!.verdict='clean';
  expect(()=>skills.prepareSkillSwitch({...target},'turn_on')).toThrow('skill-switch-revision-required');
  skills.prepareSkillSwitch(target,'turn_on');expect(()=>skills.applySkillSwitchTarget(target,'turn_on')).toThrow();
  expect(JSON.parse(fs.readFileSync(manifestPath(),'utf8'))['sample-skill'].enabled).toBe(false);host.dispose();
});

it.each(([1,1024] as const).flatMap(count=>(['turn_on','turn_off','delete'] as const).map(action=>({count,action}))))('B01 RED_target_settlement_does_not_walk_siblings $count entries $action',({count,action})=>{
  const host=fixture('ask');install();
  const manifest=JSON.parse(fs.readFileSync(manifestPath(),'utf8'));
  manifest['sample-skill'].enabled=action!=='turn_on';
  for(let i=1;i<count;i++)manifest[`sibling-${i}`]=structuredClone(manifest['sample-skill']);
  fs.writeFileSync(manifestPath(),JSON.stringify(manifest));
  const unrelated=join(DATA_DIR,'workspaces','b','skills','.revisions','a'.repeat(64));fs.mkdirSync(unrelated,{recursive:true});fs.writeFileSync(join(unrelated,'SKILL.md'),md('unrelated-skill'));
  const listing=vi.spyOn(skills,'listSkills'),scan=vi.spyOn(scanner,'scanSkill');resetCounters();
  const target=skills.readSkillSwitchTarget('b','sample-skill')!;
  expect(planSkillSwitch(target.listing,target.text,action,'sample-skill',undefined,target).ok).toBe(true);
  skills.prepareSkillSwitch(target,action);skills.applySkillSwitchTarget(target,action);
  expect(listing).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
  expect(io.opens.filter(path=>path.endsWith('/SKILL.md'))).toHaveLength(2);
  expect(io.opens.every(path=>!path.includes('/sibling-'))).toBe(true);
  expect(vi.mocked(fs.readdirSync).mock.calls.filter(args=>String(args[0]).includes('/skills'))).toHaveLength(0);
  expect(vi.mocked(fs.readFileSync).mock.calls.filter(args=>String(args[0]).endsWith('/SKILL.md'))).toHaveLength(0);
  host.dispose();
});
it('B02 RED_bytes_are_bounded_before_parse_hash_scan',()=>{
  const host=fixture(),path=join(DATA_DIR,'bounded-file');
  fs.writeFileSync(path,'x'.repeat(SWITCH_LIMITS.content));resetCounters();
  expect(readSwitchFile(path,SWITCH_LIMITS.content)).toHaveLength(SWITCH_LIMITS.content);
  expect(io.bytes.get(path)).toBe(SWITCH_LIMITS.content);
  fs.appendFileSync(path,'x');resetCounters();expect(()=>readSwitchFile(path,SWITCH_LIMITS.content)).toThrow();
  expect(io.bytes.get(path)??0).toBeLessThanOrEqual(SWITCH_LIMITS.content+1);
  fs.writeFileSync(path,'x'.repeat(SWITCH_LIMITS.content));resetCounters();io.growth={path,done:false};
  expect(()=>readSwitchFile(path,SWITCH_LIMITS.content)).toThrow();expect(io.bytes.get(path)??0).toBeLessThanOrEqual(SWITCH_LIMITS.content+1);io.growth=undefined;
  fs.writeFileSync(path,' '.repeat(SWITCH_LIMITS.metadata+4096));resetCounters();expect(()=>parseSwitchMetadata(path)).toThrow();
  expect(io.bytes.get(path)??0).toBeLessThanOrEqual(SWITCH_LIMITS.metadata+1);
  const scan={verdict:'review' as const,scannerVersion:1,scannedAt:'fixture',contentHash:'fixture',findings:Array.from({length:129},()=>({rule:'fixture',category:'instruction',severity:'medium' as const,confidence:1,message:'Review',evidence:'Sample',file:'SKILL.md',source:'murage' as const}))};
  expect(()=>skillVerdictHash(scan)).toThrow();host.dispose();
});
it('B02 RED_bytes_are_bounded_before_parse_hash_scan invalid UTF-8 cannot alias reviewed raw bytes',()=>{
  const host=fixture(),content=md()+'\ufffd';
  expect(skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content}])).not.toHaveProperty('error');
  expect(skills.readSkillSwitchTarget('b','sample-skill')!.text).toBe(content);
  fs.writeFileSync(join(DATA_DIR,'workspaces','b','skills','sample-skill','SKILL.md'),Buffer.concat([Buffer.from(md()),Buffer.from([255])]));
  expect(()=>skills.readSkillSwitchTarget('b','sample-skill')).toThrow();
  const file=join(DATA_DIR,'fixture-byte-order-mark');fs.writeFileSync(file,'\ufeff'+md());expect(readSwitchFile(file,SWITCH_LIMITS.content)).toBe('\ufeff'+md());host.dispose();
});
it('B03 RED_scans_and_primitive_work_share_budget',()=>{
  const host=fixture();install();
  const manifest=JSON.parse(fs.readFileSync(manifestPath(),'utf8'));
  manifest['sample-skill'].scan.scannerVersion+=1;fs.writeFileSync(manifestPath(),JSON.stringify(manifest));
  const effect=vi.spyOn(skills,'applySkillSwitchTarget'),scan=vi.spyOn(scanner,'scanSkill');resetCounters();
  let failure:unknown;try{skills.readSkillSwitchTarget('b','sample-skill');}catch(error){failure=error;}
  console.log('SCANNER_BUDGET '+JSON.stringify({limit:SWITCH_LIMITS.scanCalls,scans:scan.mock.calls.length,primitiveCalls:effect.mock.calls.length}));
  expect(failure).toBeInstanceOf(Error);expect(String(failure)).toMatch(/refreshing/);
  expect(scan.mock.calls.length).toBeLessThanOrEqual(SWITCH_LIMITS.scanCalls);
  expect(effect).not.toHaveBeenCalled();expect(io.opens.filter(path=>path.endsWith('/SKILL.md'))).toHaveLength(1);
  host.dispose();
});
it('B03 RED_scans_and_primitive_work_share_budget deletion plan cap',()=>{
  const host=fixture();install();const directory=join(DATA_DIR,'workspaces','b','skills','sample-skill');
  for(let i=0;i<128;i++)fs.writeFileSync(join(directory,`asset-${i}`),'fixture');
  const target=skills.readSkillSwitchTarget('b','sample-skill')!,before=fs.readFileSync(manifestPath(),'utf8');
  expect(()=>skills.prepareSkillSwitch(target,'delete')).toThrow();expect(fs.readFileSync(manifestPath(),'utf8')).toBe(before);
  expect(fs.existsSync(join(directory,'SKILL.md'))).toBe(true);host.dispose();
});
it('B04 RED_upgrade_recovery_settle_are_paged_and_serial',async()=>{
  const host=fixture('ask'),file=join(DATA_DIR,'fixture-batch-queue.json');
  install('sample-skill');
  const rows:any[]=[];
  for(let i=0;i<40;i++){
    const name=i===0?'sample-skill':`sample-${i}`;if(i)install(name);
    const target=skills.readSkillSwitchTarget('b',name)!,plan=planSkillSwitch(target.listing,target.text,'turn_on',name,undefined,target);
    if(!plan.ok)throw new Error(plan.error);
    const id=`fixture-${String(i).padStart(3,'0')}`;
    rows.push({version:2,state:'waiting',base:{approve:null,source:'no-grant'},item:{kind:'skill',ref:id,epoch:id,approvalId:id,proof:'trusted',view:{title:'Fixture change',subtitle:''},call:{tool:'switch_skill',input:{schema:1,name,action:'turn_on',skillSha256:plan.skillSha256,enabledBefore:false,source:plan.source,shared:plan.shared,scanContentHash:plan.scanContentHash,previewSha256:plan.previewSha256,verdictHash:plan.verdictHash},approval:{queueRef:id,epoch:id,action:{requestId:id,tool:'switch_skill',options:['Turn on','Deny'],skillRequest:{id,action:'turn_on',name}}}}}});
  }
  fs.writeFileSync(file,JSON.stringify({version:1,entries:rows}));
  const q=new ProducerApprovalQueue('skill',file),registry=createOwnerSettlementRegistry(),execute=createSkillSwitchExecutor(registry,{automatic:()=>true,owner:()=>true});
  q.registerDelivery('switch_skill',(item,answer,delivery)=>{if(answer.behavior==='allow')execute('b',item.call.input as any,delivery);});
  let selected=0,processed=0,active=0,maxActive=0,yields=0;
  const page=q.pendingPage.bind(q),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const source:QueueRecoverySource={kind:'skill',base:q.base,reopen:item=>({kind:'service',service:'skill',claim:host.claim,call:item.call}),
    pendingApprovals:()=>{throw new Error('whole-population selection');},approval:id=>q.approval(id),receipt:item=>q.receipt(item),
    pendingPage:(after,limit)=>{const result=page(after,limit);selected+=result.items.length+(result.next?1:0);return result;},
    respond:async(item,answer,options,settlement)=>{processed++;active++;maxActive=Math.max(maxActive,active);try{return await q.respond(item,answer,options,settlement);}finally{active--;}},
    cancel:(item,reason)=>q.cancel(item,reason),renew:(item,identity)=>q.renew(item,identity)};
  const originalImmediate=setImmediate;
  vi.spyOn(globalThis,'setImmediate').mockImplementation(((callback:any,...args:any[])=>{
    expect(selected).toBeLessThanOrEqual(17);expect(processed).toBeLessThanOrEqual(16);selected=0;processed=0;yields++;
    return originalImmediate(callback,...args);
  }) as typeof setImmediate);
  host.setLevel('unlimited');d.installDecisionHost({store:host.store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:()=>({kind:'eligible',retire:false})});const dispose=d.installQueueSources([source]);
  await d.recover();
  expect(yields).toBeGreaterThanOrEqual(2);expect(maxActive).toBe(1);expect(effect).toHaveBeenCalledTimes(40);
  expect(new Set(effect.mock.calls.map(args=>args[0].listing.name)).size).toBe(40);
  dispose();host.dispose();
},120_000);
it('B05 RED_receipt_lookup_short_circuits_skill_work capacity',()=>{
  const host=fixture('ask'),file=join(DATA_DIR,'fixture-capacity-queue.json');install();
  const prototype={version:2,state:'accepted',base:{approve:null,source:'no-grant'},item:{kind:'skill',ref:'fixture',epoch:'fixture',approvalId:'fixture',proof:'trusted',view:{title:'Fixture',subtitle:''},call:{tool:'switch_skill',input:{},approval:{queueRef:'fixture',epoch:'fixture',action:{}}}}};
  const entries=Array.from({length:1024},(_,i)=>{const row=structuredClone(prototype),id=`history-${i}`;row.item.ref=id;row.item.epoch=id;row.item.approvalId=id;row.item.call.approval.queueRef=id;row.item.call.approval.epoch=id;return row;});
  fs.writeFileSync(file,JSON.stringify({version:1,entries}));const q=new ProducerApprovalQueue('skill',file),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  resetCounters();
  const request=q.open({authority:{claim:host.claim,proof:'trusted'},ref:'new-operation',epoch:'new-operation',tool:'switch_skill',input:{},action:{requestId:'new-operation',tool:'switch_skill',skillRequest:{id:'new-operation'},options:['Turn on','Deny']},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
  if(request.outcome.kind!=='card')throw new Error('fixture registration failed');
  expect(()=>q.stage(request,request.outcome.kind==='card'?request.outcome.ref:({} as never))).toThrow(/capacity/);
  expect(io.opens.filter(path=>path.endsWith('/SKILL.md'))).toHaveLength(0);expect(effect).not.toHaveBeenCalled();host.dispose();
});

it('B04 RED_upgrade_recovery_settle_are_paged_and_serial stable cursors survive insertion and removal',async()=>{
  const host=fixture('ask'),file=join(DATA_DIR,'fixture-cursor-queue.json');
  const entries=Array.from({length:40},(_,i)=>{const id=`fixture-${String(i).padStart(3,'0')}`;return {state:'waiting',base:{approve:null,source:'no-grant'},item:{kind:'skill',ref:id,epoch:id,approvalId:id,proof:'trusted',view:{title:'Fixture',subtitle:''},call:{tool:'stage_skill',input:{},approval:{queueRef:id,epoch:id,action:{requestId:id,skillRequest:{id}}}}}};});
  fs.writeFileSync(file,JSON.stringify({version:1,entries}));const q=new ProducerApprovalQueue('skill',file);
  let page=q.pendingPage(undefined,16);const seen=page.items.map(item=>item.ref);expect(seen).toHaveLength(16);
  await q.cancel(page.items[5]!,'cancelled');
  const id='fixture-100',request=q.open({authority:{claim:host.claim,proof:'trusted'},ref:id,epoch:id,tool:'stage_skill',input:{},action:{requestId:id,skillRequest:{id},options:['Enable','Deny']},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
  if(request.outcome.kind!=='card')throw new Error('fixture cursor registration failed');q.stage(request,request.outcome.ref);
  while(page.next){page=q.pendingPage(page.next,16);expect(page.items.length).toBeLessThanOrEqual(16);seen.push(...page.items.map(item=>item.ref));}
  expect(new Set(seen).size).toBe(41);
  for(const entry of entries)expect(seen).toContain(entry.item.ref);
  expect(seen).toContain(id);host.dispose();
});

it.each(['upgrade','full-access','concurrent'] as const)('B04 forty real effects obey shared tick budgets: %s',async mode=>{
  const host=fixture('ask'),file=join(DATA_DIR,'fixture-shared-batch.json'),q=new ProducerApprovalQueue('skill',file);
  const ledger=new Ledger();ledger.open('g','t','codex','own');const setup=new SetupAtSettle(ledger);
  let currentLevel:'ask'|'auto'|'unlimited'='ask';
  d.installProvenanceReader({turnGenerationFor:threadId=>threadId,provenance:generation=>({generation,threadId:generation,botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}),
    live:()=>({botId:'b',turnId:'turn',providerInstanceId:'fixture',principal:'owner',owner:true,level:currentLevel})});
  const verify=d.installClaimVerifier(proof=>typeof proof==='string'&&proof.startsWith('fixture-thread-')?{threadId:proof,botId:'b',generation:proof}:undefined);
  let setupFlight:string|undefined;
  const registry=createOwnerSettlementRegistry();
  const permitted=(item:any,cause:string)=>d.readTurnPolicy({threadId:item.call.input.threadId,generation:item.call.input.threadId})?.permission.noLimits===true
    ||cause==='full-access-settle'&&ledger.rows.get(item.call.input.threadId)!.settled&&setupFlight===item.approvalId;
  const execute=createSkillSwitchExecutor(registry,{automatic:permitted,owner:()=>false});
  d.installDecisionHost({store:host.store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:(item,cause)=>{
    inspectSkillSwitch('b',item.call.input as any);return {kind:permitted(item,cause)?'eligible':'stale',retire:false};
  }});
  const accept=vi.fn((item:any,answer:any,delivery:any)=>{if(answer.behavior==='allow')execute('b',item.call.input,delivery);});
  q.bindAcceptance('switch_skill',accept,accept);
  const items:any[]=[],refs:any[]=[];
  for(let i=0;i<40;i++){
    const name=`bounded-${i}`,id=`fixture-batch-${String(i).padStart(3,'0')}`;install(name);
    const target=skills.readSkillSwitchTarget('b',name)!,plan=planSkillSwitch(target.listing,target.text,'turn_on',name,undefined,target);
    if(!plan.ok)throw new Error(plan.error);
    const input={schema:1,threadId:`fixture-thread-${i}`,botId:'b',name,action:'turn_on',skillSha256:plan.skillSha256,enabledBefore:false,source:plan.source,shared:plan.shared,
      scanContentHash:plan.scanContentHash,previewSha256:plan.previewSha256,verdictHash:plan.verdictHash};
    const request=q.open({authority:{claim:verify(input.threadId)!,proof:input.threadId},ref:id,epoch:id,tool:'switch_skill',input,
      action:{requestId:id,tool:'switch_skill',options:['Turn on','Deny'],skillRequest:{id,action:'turn_on',name}},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
    if(request.outcome.kind!=='card')throw new Error('fixture must register Ask cards '+JSON.stringify({i,outcome:request.outcome}));
    items.push(await q.present(request,request.outcome.ref));refs.push(request.outcome.ref);
  }
  let selected=0,processed=0,active=0,maximum=0,yields=0;
  const page=q.pendingPage.bind(q),openPage=records.openBasePage,recoveryPage=records.recoveryPage;
  const countPage=(rows:any[])=>{selected+=rows.length;return rows;};
  vi.spyOn(records,'openBasePage').mockImplementation((...args)=>countPage(openPage(...args)));
  vi.spyOn(records,'recoveryPage').mockImplementation((...args)=>countPage(recoveryPage(...args)));
  const source:QueueRecoverySource={kind:'skill',base:q.base,approval:id=>q.approval(id),receipt:item=>q.receipt(item),
    pendingApprovals:()=>{throw new Error('whole-population selection');},pendingPage:(after,limit)=>{const result=page(after,limit);selected+=result.items.length+(result.next?1:0);return result;},
    reopen:item=>({kind:'service',service:'skill',claim:verify(String((item.call.input as any).threadId))!,call:item.call}),refuseBeforeEffect:(item,code,message)=>q.refuseBeforeEffect(item,code,message),
    respond:async(item,answer,options,settlement)=>{processed++;maximum=Math.max(maximum,++active);try{return await q.respond(item,answer,options,settlement);}finally{active--;}},
    cancel:(item,reason)=>q.cancel(item,reason),renew:(item,identity)=>q.renew(item,identity)};
  const dispose=d.installQueueSources([source]);
  for(let i=0;i<40;i++){const generation=items[i].call.input.threadId;ledger.open(generation,generation,'codex','own');setup.file(generation,{req:items[i].approvalId,option:true,push_suppressed:true},{
    open:()=>d.readApproval(items[i].approvalId)?.state==='open',option:()=>{selected++;return true;},
    apply:async()=>{setupFlight=items[i].approvalId;try{await d.answerApproval(refs[i],{behavior:'allow'},automaticSettlement('full-access-settle'));return d.readApprovalExecution(refs[i]).delivery==='accepted';}finally{setupFlight=undefined;}},
    push:()=>{throw new Error('unexpected review card');}});}
  const effect=vi.spyOn(skills,'applySkillSwitchTarget'),scan=vi.spyOn(scanner,'scanSkill'),phases=vi.spyOn(skills,'readSkillSwitchTarget'),writes=vi.spyOn(atomic,'writeFileAtomic');
  resetCounters();
  const checkTick=()=>{
    expect(selected).toBeLessThanOrEqual(17);expect(processed).toBeLessThanOrEqual(16);expect(phases.mock.calls.length).toBeLessThanOrEqual(32);expect(scan).not.toHaveBeenCalled();
    const targetPaths=io.readOpens.filter(path=>path.endsWith('/SKILL.md')),metadataPaths=io.readOpens.filter(path=>!path.endsWith('/SKILL.md'));
    expect(targetPaths.length).toBeLessThanOrEqual(64);expect(metadataPaths.length).toBeLessThanOrEqual(128);expect(writes.mock.calls.length).toBeLessThanOrEqual(192);
    expect([...io.bytes].filter(([path])=>path.endsWith('/SKILL.md')).reduce((n,[,bytes])=>n+bytes,0)).toBeLessThanOrEqual(64*(SWITCH_LIMITS.content+1));
    expect([...io.bytes].filter(([path])=>!path.endsWith('/SKILL.md')).reduce((n,[,bytes])=>n+bytes,0)).toBeLessThanOrEqual(128*(SWITCH_LIMITS.metadata+1));
    selected=0;processed=0;phases.mockClear();writes.mockClear();resetCounters();yields++;
  };
  const immediate=setImmediate;vi.spyOn(globalThis,'setImmediate').mockImplementation(((callback:any,...args:any[])=>{checkTick();return immediate(callback,...args);}) as typeof setImmediate);
  try{
    const settleAll=()=>Promise.all(items.map(item=>{const generation=item.call.input.threadId;ledger.rows.get(generation)!.settled=true;return setup.settle(generation,'clean');}));
    if(mode==='full-access'){currentLevel='auto';await settleAll();}
    else {currentLevel='unlimited';if(mode==='concurrent')await Promise.all([d.onLevelChange('b'),d.recover(),settleAll()]);else await d.onLevelChange('b');}
    checkTick();expect(maximum).toBe(1);expect(effect).toHaveBeenCalledTimes(40);expect(accept).toHaveBeenCalledTimes(40);expect(yields).toBeGreaterThanOrEqual(2);
    expect(effect.mock.calls.every(call=>Object.keys(call[2]??{}).length===0)).toBe(true);
  }finally{dispose();host.dispose();}
},120_000);
