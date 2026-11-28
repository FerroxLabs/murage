import * as records from './decision/records.ts';
import {skillSettlementWork} from './skill-settlement-work.ts';
import {phoneOwnerSettlementSession,revokePhoneOwnerSettlementSession} from './owner-settlement-session.ts';
// Test ingress/executor owner: skills lane. Real durable queue/receipt owner: decision lane.
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, d } from './decision/fixture.ts';
import { DATA_DIR } from './config.ts';
import * as skills from './skills.ts';
import * as atomic from './atomic.ts';
import { ProducerApprovalQueue } from './narrow-denials.ts';
import { planSkillSwitch, skillVerdictHash, type SwitchInput } from './skill-switch.ts';
import { createSkillSwitchExecutor } from './skill-switch-executor.ts';
import { createOwnerSettlementRegistry, automaticSettlement, ownerSkillPosture, type OwnerResponseContext, type SkillDeliveryContext, type Settlement } from './skill-switch-settlement.ts';
import type { PendingQueueApproval, QueueRecoverySource } from './decision/types.ts';

const md='---\nname: sample-skill\ndescription: Sample instructions\n---\nRead supplied notes.\n';
const statePath=()=>join(DATA_DIR,'skill-state','b','skills.json');
const state=()=>JSON.parse(readFileSync(statePath(),'utf8'));
const update=(change:(entry:any)=>void)=>{const saved=state();change(saved['sample-skill']);writeFileSync(statePath(),JSON.stringify(saved));};
const parked=()=>new Promise<void>(()=>{});
afterEach(()=>vi.restoreAllMocks());
function setup(verdict:'clean'|'review'|'blocked'='clean',action:'turn_on'|'turn_off'|'delete'='turn_on',patchInput?:(input:SwitchInput)=>void) {
  const host=fixture('ask');
  const noLimits=()=>d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits===true;
  d.installDecisionHost({store:host.store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:()=>({kind:noLimits()?'eligible':'stale',retire:noLimits()})});
  const installed=skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content:md}]);
  expect(installed).not.toHaveProperty('error');
  update(entry=>{entry.enabled=action!=='turn_on';entry.scan.verdict=verdict;});
  const target=skills.readSkillSwitchTarget('b','sample-skill')!;
  const plan=planSkillSwitch(target.listing,target.text,action,'sample-skill','Fixture bot',target);
  // Blocked-on fixtures use a clean proposal followed by a blocked final snapshot in their dedicated regression.
  if(!plan.ok)throw new Error(plan.error);
  const input:SwitchInput={schema:1,name:plan.name,action,skillSha256:plan.skillSha256,enabledBefore:plan.enabledBefore,
    source:plan.source,shared:plan.shared,scanContentHash:plan.scanContentHash,previewSha256:plan.previewSha256,verdictHash:plan.verdictHash};
  patchInput?.(input);
  const registry=createOwnerSettlementRegistry();
  const execute=createSkillSwitchExecutor(registry,{automatic:noLimits,owner:()=>!noLimits()});
  const file=join(DATA_DIR,'fixture-switch-queue.json');
  const queue=new ProducerApprovalQueue('skill',file);
  const request=queue.open({authority:{claim:host.claim,proof:'trusted'},ref:'fixture-switch',epoch:'fixture-epoch',tool:'switch_skill',input,
    action:{requestId:'fixture-switch',tool:'switch_skill',options:[plan.allowLabel,'Deny'],skillRequest:{id:'fixture-switch',action,name:plan.name}},
    view:{title:plan.title,subtitle:plan.subtitle},base:{approve:null,source:'no-grant'}});
  if(request.outcome.kind!=='card')throw new Error('fixture must register a real Ask card');
  const item=queue.stage(request,request.outcome.ref);
  const accept=(_item:PendingQueueApproval,answer:{behavior:string},delivery?:SkillDeliveryContext)=>{if(answer.behavior==='allow')execute('b',_item.call.input as SwitchInput,delivery);};
  queue.bindAcceptance('switch_skill',accept,accept);
  const deliver=(settlement:Settlement=automaticSettlement('level-upgrade'))=>{if(settlement.kind==='automatic'&&settlement.cause!=='unspecified')host.setLevel('unlimited');return queue.respond(item,{behavior:'allow'},{answerId:'fixture-answer'},settlement);};
  const reload=()=>{d.installDecisionHost({store:host.store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:()=>({kind:noLimits()?'eligible':'stale',retire:noLimits()})});const q=new ProducerApprovalQueue('skill',file);q.bindAcceptance('switch_skill',accept,accept);return q;};
  let live=true,invocationLive=true;
  const context:OwnerResponseContext={kind:'single-card',authorized:true,affirmative:true,freshAuth:'satisfied',
    session:{reference:{},principal:'owner',epoch:'fixture-session',live:()=>live},invocation:{},invocationLive:()=>invocationLive,cardLive:()=>true,
    reviewedPreview:input.previewSha256,reviewedVerdict:input.verdictHash,currentPreview:input.previewSha256!,currentVerdict:input.verdictHash!};
  const owner=()=>{const token=registry.issue(item,context);expect(token).toBeDefined();return {kind:'owner' as const,token:token!};};
  const durable=()=>JSON.parse(readFileSync(file,'utf8')).entries.find((entry:any)=>entry.item.ref===item.ref);
  return {host,queue,item,input,request,registry,execute,deliver,reload,accept,owner,context,durable,endInvocation:()=>{invocationLive=false;},revoke:()=>{live=false;}};
}

it('RED_upgrade_matching_review_snapshot_never_runs boundary',async()=>{
  const f=setup('review'),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const before=state();
  expect(await f.deliver()).toMatchObject({state:'not-run',message:expect.stringContaining('needs review')});
  expect(effect).not.toHaveBeenCalled();expect(state()).toEqual(before);expect(f.durable().state).toBe('not-run');
  f.host.dispose();
});
it.each(['turn_on','turn_off','delete'] as const)('RED_automatic_review_guard_covers_every_action %s',async action=>{
  const f=setup('review',action),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await f.deliver()).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it.each([undefined,{kind:'owner'},{},JSON.parse('{}')])('RED_owner_tag_or_cast_is_not_owner_proof %j',async token=>{
  const f=setup('review'),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const settlement=token===undefined?automaticSettlement():{kind:'owner' as const,token:token as never};
  expect(await f.deliver(settlement)).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_owner_tag_or_cast_is_not_owner_proof clean No limits remains automatic',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');f.host.setLevel('unlimited');
  expect(await f.deliver({kind:'owner',token:{} as never})).toMatchObject({state:'accepted',authorization:'automatic'});
  expect(effect).toHaveBeenCalledTimes(1);expect(effect.mock.calls[0]![2]).toEqual({});f.host.dispose();
});
it('owner positive control issues once and turns on the exact review revision',async()=>{
  const f=setup('review'),effect=vi.spyOn(skills,'applySkillSwitchTarget'),owner=f.owner();
  expect(await f.deliver(owner)).toMatchObject({state:'accepted',authorization:'owner'});
  expect(effect).toHaveBeenCalledTimes(1);expect(effect.mock.calls[0]![2]).toEqual({acknowledged:f.input.scanContentHash});
  expect(state()['sample-skill'].enabled).toBe(true);
  expect(f.registry.validate(owner.token,f.item)).toBe(false);f.host.dispose();
});
it.each(['deny','wipe'] as const)('No limits preserves the explicit owner %s exception without making a base review exception',async why=>{
  const f=setup('review'),owner=f.owner();f.host.setLevel('unlimited');
  const execute=createSkillSwitchExecutor(f.registry,{automatic:()=>false,owner:()=>ownerSkillPosture(true,true,why)});
  f.queue.bindAcceptance('switch_skill',(item,answer,delivery)=>{if(answer.behavior==='allow')execute('b',item.call.input as SwitchInput,delivery);});
  expect(ownerSkillPosture(true,true,'base')).toBe(false);expect(ownerSkillPosture(true,undefined,'base')).toBe(false);expect(ownerSkillPosture(true,false,'base')).toBe(true);
  expect(await f.deliver(owner)).toMatchObject({state:'accepted',authorization:'owner'});expect(state()['sample-skill'].enabled).toBe(true);f.host.dispose();
});
it.each(['approvalId','ref','epoch','action','input','bot'] as const)('RED_token_is_bound_to_card_operation_epoch %s',async field=>{
  const f=setup('review'),owner=f.owner(),other=structuredClone(f.item) as any;
  if(field==='action')other.call.input.action='delete';else if(field==='input')other.call.input.skillSha256='changed';
  else if(field==='bot')other.call.input.botId='other';else other[field]='different';
  expect(f.registry.validate(owner.token,other)).toBe(false);
  expect(f.registry.validate(owner.token,f.item)).toBe(true);f.host.dispose();
});
it('RED_owner_session_revoked_between_click_and_effect',async()=>{
  const f=setup('review'),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');f.revoke();
  expect(await f.deliver(owner)).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it.each(['verdict','findings','scannerVersion'] as const)('RED_owner_allow_after_verdict_flip_requires_new_review %s',async field=>{
  const f=setup('review'),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  update(entry=>{if(field==='verdict')entry.scan.verdict='clean';else if(field==='scannerVersion')entry.scan.scannerVersion+=1;
    else entry.scan.findings.push({rule:'fixture',category:'instruction',severity:'medium',confidence:1,message:'Changed finding',evidence:'Sample',file:'SKILL.md',source:'murage'});});
  expect(await f.deliver(owner)).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_acknowledgement_only_from_valid_owner_token',async()=>{
  const f=setup('clean','turn_on',input=>{input.acknowledged=input.scanContentHash;}),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await f.deliver()).toMatchObject({state:'accepted'});
  expect(effect.mock.calls[0]![2]).toEqual({});expect(state()['sample-skill'].enabled).toBe(true);f.host.dispose();
});
it.each(['turn_off','delete'] as const)('RED_acknowledgement_only_from_valid_owner_token owner %s omits acknowledgement',async action=>{
  const f=setup('review',action,input=>{input.acknowledged=input.scanContentHash;}),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await f.deliver(f.owner())).toMatchObject({state:'accepted',authorization:'owner'});
  expect(effect).toHaveBeenCalledTimes(1);expect(effect.mock.calls[0]![2]).toEqual({});
  expect(action==='delete'?state()['sample-skill']===undefined:state()['sample-skill'].enabled===false).toBe(true);f.host.dispose();
});
it('RED_missing_proof_is_not_permission_on_Ask',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const execute=createSkillSwitchExecutor(f.registry,{automatic:()=>false,owner:()=>true});
  f.queue.registerDelivery('switch_skill',(item,_answer,delivery)=>execute('b',item.call.input as SwitchInput,delivery));
  expect(await f.deliver(automaticSettlement())).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_legacy_snapshot_is_not_backfilled_authority',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const saved=JSON.parse(readFileSync(join(DATA_DIR,'fixture-switch-queue.json'),'utf8'));
  delete saved.entries[0].item.call.input.verdictHash;
  writeFileSync(join(DATA_DIR,'fixture-switch-queue.json'),JSON.stringify(saved));
  f.host.setLevel('unlimited');const q=f.reload(),item=q.pendingApprovals()[0]!;
  expect(await q.respond(item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'not-run'});
  expect(effect).not.toHaveBeenCalled();f.host.dispose();
});

it('C01 RED_start_fence_is_durable_before_effect',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  f.queue.registerDelivery('switch_skill',(_item,_answer,delivery)=>{delivery!.beginEffect({kind:'automatic',cause:'no-limits'});return parked();});
  void f.deliver();expect(f.durable().state).toBe('effect-started');expect(effect).not.toHaveBeenCalled();
  const q=f.reload();expect(await q.respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'unconfirmed'});
  expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('C01 RED_start_fence_is_durable_before_effect barrier failure',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),write=atomic.writeFileAtomic;
  vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>{
    if(String(path).endsWith('fixture-switch-queue.json')&&JSON.parse(String(data)).entries.some((e:any)=>e.state==='effect-started'))throw new Error('fixture start write unavailable');
    return write(path,data,options);
  });
  expect(await f.deliver()).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();expect(f.durable().state).not.toBe('accepted');f.host.dispose();
});
it('C02 RED_after_effect_before_receipt_never_reexecutes',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  f.queue.registerDelivery('switch_skill',(item,answer,delivery)=>{f.accept(item,answer,delivery);return parked();});
  void f.deliver();expect(effect).toHaveBeenCalledTimes(1);expect(f.durable().state).toBe('effect-started');
  expect(state()['sample-skill'].enabled).toBe(true);
  skills.setSkillEnabled('b','sample-skill',false); // A separate intentional operation restores the starting state.
  const q=f.reload();expect(await q.respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'unconfirmed'});
  expect(effect).toHaveBeenCalledTimes(1);expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});
it.each([false,true])('C03 RED_receipt_write_failure_quarantines_live_retry failed quarantine write=%s',async failQuarantine=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),write=atomic.writeFileAtomic;
  vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>{
    if(String(path).endsWith('fixture-switch-queue.json')){
      const entries=JSON.parse(String(data)).entries;
      if(entries.some((e:any)=>e.state==='accepted'||failQuarantine&&e.state==='unconfirmed'))throw new Error('fixture receipt write unavailable');
    }
    return write(path,data,options);
  });
  expect(await f.deliver()).toMatchObject({state:'unconfirmed'});expect(effect).toHaveBeenCalledTimes(1);
  skills.setSkillEnabled('b','sample-skill',false);
  expect(await f.deliver()).toMatchObject({state:'unconfirmed'});
  const q=f.reload();expect(await q.respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'unconfirmed'});
  expect(effect).toHaveBeenCalledTimes(1);expect(state()['sample-skill'].enabled).toBe(false);expect(f.durable().state).not.toBe('not-run');f.host.dispose();
});
it.each([false,true])('C04 RED_receipt_committed_projection_failed_is_read_only reported write failure=%s',async reportedFailure=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),read=vi.spyOn(skills,'readSkillSwitchTarget'),write=atomic.writeFileAtomic;
  if(reportedFailure)vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>{
    write(path,data,options);
    if(String(path).endsWith('fixture-switch-queue.json')&&JSON.parse(String(data)).entries.some((e:any)=>e.state==='accepted'))throw new Error('fixture post-commit failure');
  });
  expect(['accepted','already']).toContain((await f.deliver()).state);expect(effect).toHaveBeenCalledTimes(1);
  skills.setSkillEnabled('b','sample-skill',false);read.mockClear();
  const q=f.reload();expect(await q.respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'already',authorization:'automatic'});
  expect(effect).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});
it('C05 RED_uncertainty_survives_renewal_compaction_and_legacy',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  f.queue.registerDelivery('switch_skill',(_item,_answer,delivery)=>{delivery!.beginEffect({kind:'automatic'});return parked();});
  void f.deliver();const q=f.reload();
  await expect(q.renew(f.item,{approvalId:'replacement',epoch:'replacement'})).rejects.toThrow();
  await q.cancel(f.item,'superseded');
  expect(await q.respond(f.item,{behavior:'allow'},{answerId:'new-answer'},automaticSettlement('replay'))).toMatchObject({state:'unconfirmed'});
  expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it.each(['pending','failed'])('C05 RED_uncertainty_survives_renewal_compaction_and_legacy %s',async legacy=>{
  const f=setup(),file=join(DATA_DIR,'fixture-switch-queue.json'),saved=JSON.parse(readFileSync(file,'utf8'));
  saved.entries[0].state=legacy;delete saved.entries[0].version;writeFileSync(file,JSON.stringify(saved));
  f.host.setLevel('unlimited');expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'unconfirmed'});
  expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});
it('C05 positive control recovers a proven pending-before-effect once',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');f.queue.registerDelivery('switch_skill',()=>parked());
  void f.deliver();expect(f.durable().state).toBe('pending-before-effect');
  expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'accepted'});
  expect(effect).toHaveBeenCalledTimes(1);expect(state()['sample-skill'].enabled).toBe(true);f.host.dispose();
});

it('verdict digest excludes only scannedAt and binds every finding field',()=>{
  const scan={verdict:'review' as const,contentHash:'fixture-content',scannerVersion:1,scannedAt:'first',findings:[{rule:'r',category:'c',severity:'medium' as const,confidence:1,message:'m',evidence:'e',file:'f',source:'murage' as const}]};
  expect(skillVerdictHash({...scan,scannedAt:'second'})).toBe(skillVerdictHash(scan));
  for(const field of ['rule','category','severity','confidence','message','evidence','file','source']){
    const changed=structuredClone(scan);(changed.findings[0] as any)[field]=field==='confidence'?0:'changed';
    expect(skillVerdictHash(changed)).not.toBe(skillVerdictHash(scan));
  }
});

it('C05 RED_uncertainty_survives_renewal_compaction_and_legacy tombstones past 1024',async()=>{
  const f=setup(),file=join(DATA_DIR,'fixture-switch-queue.json');
  expect(await f.deliver()).toMatchObject({state:'accepted'});
  skills.setSkillEnabled('b','sample-skill',false);
  const saved=JSON.parse(readFileSync(file,'utf8'));
  const prototype=saved.entries[0];
  for(let i=0;i<1024;i++){
    const id=`history-${String(i).padStart(4,'0')}`;
    saved.entries.push({state:'accepted',base:{approve:null,source:'no-grant'},item:{kind:'skill',approvalId:id,ref:id,epoch:id,proof:'trusted',view:{title:'History',subtitle:''},call:{tool:'stage_skill',input:{},approval:{queueRef:id,epoch:id,action:{requestId:id}}}}});
  }
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(1024*1024);
  writeFileSync(file,JSON.stringify(saved));
  const q=f.reload();q.updateProgress(prototype.item.ref,{projected:true});
  const effect=vi.spyOn(skills,'applySkillSwitchTarget'),read=vi.spyOn(skills,'readSkillSwitchTarget');
  expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'new-answer'},automaticSettlement('replay'))).toMatchObject({state:'already'});
  expect(effect).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});
it('B05 RED_receipt_lookup_short_circuits_skill_work',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),read=vi.spyOn(skills,'readSkillSwitchTarget');
  expect(await f.deliver()).toMatchObject({state:'accepted'});
  skills.setSkillEnabled('b','sample-skill',false);effect.mockClear();read.mockClear();
  const writes=atomic.atomicWriteCount(join(DATA_DIR,'fixture-switch-queue.json'));
  vi.spyOn((f.queue as unknown as {entries:Map<string,unknown>}).entries,'values').mockImplementation(()=>{throw new Error('unbounded receipt enumeration');});
  for(let i=0;i<40;i++)expect(await f.deliver()).toMatchObject({state:'already'});
  expect(atomic.atomicWriteCount(join(DATA_DIR,'fixture-switch-queue.json'))).toBe(writes);
  expect(effect).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();f.host.dispose();
});
it('B05 continuation cleanup uses a proof index without enumerating pending items',async()=>{
  const f=setup();expect(f.queue.hasPendingProof(f.item.proof)).toBe(true);
  expect(await f.deliver()).toMatchObject({state:'accepted'});
  const restored=f.reload();vi.spyOn((restored as unknown as {entries:Map<string,unknown>}).entries,'values').mockImplementation(()=>{throw new Error('unbounded proof lookup');});
  expect(restored.hasPendingProof(f.item.proof)).toBe(false);f.host.dispose();
});
it('RED_execution_rechecks_after_preflight',async()=>{
  const f=setup(),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  // The owner-ingress phase saw these exact bytes and verdict. Change only findings before the real callback.
  update(entry=>{entry.scan.verdict='review';});
  expect(await f.deliver(owner)).toMatchObject({state:'not-run'});
  expect(effect).not.toHaveBeenCalled();expect(f.durable().state).not.toBe('accepted');f.host.dispose();
});
it('RED_domain_refusal_never_becomes_allowed_or_retry',async()=>{
  const f=setup('review'),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await f.deliver()).toMatchObject({state:'not-run'});
  update(entry=>{entry.scan.verdict='clean';});
  expect(await f.deliver()).toMatchObject({state:'not-run'});
  const q=f.reload();expect(await q.respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'not-run'});
  expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it.each(['skillSha256','previewSha256','scanContentHash','enabledBefore','source','shared'] as const)('RED_all_snapshot_fields_fence_execution %s',async field=>{
  const f=setup('clean','turn_on',input=>{(input as any)[field]=typeof input[field]==='boolean'?!input[field]:'changed';}),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await f.deliver()).toMatchObject({state:'not-run'});
  expect(effect).not.toHaveBeenCalled();expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});
it.each(['blocked','missing'] as const)('RED_blocked_or_unknown_turn_on_never_runs %s',async verdict=>{
  const f=setup(),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  update(entry=>{if(verdict==='missing')delete entry.scan;else entry.scan.verdict='blocked';});
  expect(await f.deliver(owner)).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_replay_is_automatic_and_receipt_is_idempotent',async()=>{
  const f=setup('review'),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  expect(await Promise.all([f.deliver(owner),f.deliver(owner)])).toEqual(expect.arrayContaining([expect.objectContaining({state:'accepted'})]));
  expect(effect).toHaveBeenCalledTimes(1);expect(await f.deliver()).toMatchObject({state:'already'});
  expect(effect).toHaveBeenCalledTimes(1);f.host.dispose();
});
it('RED_recovery_open_and_pending_review_never_runs',async()=>{
  const f=setup('review'),effect=vi.spyOn(skills,'applySkillSwitchTarget');f.queue.registerDelivery('switch_skill',()=>parked());
  void f.deliver();expect(f.durable().state).toBe('pending-before-effect');
  expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('recovery'))).toMatchObject({state:'not-run'});
  expect(effect).not.toHaveBeenCalled();expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});

it('RED_replay_is_automatic_and_receipt_is_idempotent expired owner invocation',async()=>{
  const f=setup('review'),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  f.endInvocation();f.registry.expire(owner.token);
  expect(await f.deliver(owner)).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_owner_session_revoked_between_click_and_effect after durable fence',async()=>{
  const f=setup('review'),owner=f.owner(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),write=atomic.writeFileAtomic;
  vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options)=>{write(path,data,options);if(String(path).endsWith('fixture-switch-queue.json')&&JSON.parse(String(data)).entries.some((e:any)=>e.state==='effect-started'))f.revoke();});
  expect(await f.deliver(owner)).toMatchObject({state:'unconfirmed'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('RED_blocked_or_unknown_turn_on_never_runs primitive boundary',()=>{
  const f=setup();update(entry=>{entry.scan.verdict='blocked';});
  const target=skills.readSkillSwitchTarget('b','sample-skill')!;skills.prepareSkillSwitch(target,'turn_on');
  expect(()=>skills.applySkillSwitchTarget(target,'turn_on',{acknowledged:target.listing.scan!.contentHash})).toThrow();
  expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});

it('C01 RED_start_fence_is_durable_before_effect unsupported barrier refuses',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  vi.spyOn(atomic,'syncParentDirectoryStatus').mockReturnValue('unsupported');
  expect(await f.deliver()).toMatchObject({state:'not-run'});expect(effect).not.toHaveBeenCalled();f.host.dispose();
});
it('synchronous deliveries use the same effect fence and immutable receipt',()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');f.host.setLevel('unlimited');
  expect(f.queue.respondNow(f.item,{behavior:'allow'},{answerId:'fixture-sync'},automaticSettlement('level-upgrade'))).toMatchObject({state:'accepted',authorization:'automatic'});
  skills.setSkillEnabled('b','sample-skill',false);
  expect(f.reload().respondNow(f.item,{behavior:'allow'},{answerId:'fixture-sync'},automaticSettlement('replay'))).toMatchObject({state:'already',authorization:'automatic'});
  expect(effect).toHaveBeenCalledTimes(1);expect(state()['sample-skill'].enabled).toBe(false);f.host.dispose();
});

it('paired device session rotation and revocation invalidate the bound live reference',()=>{
  const first=phoneOwnerSettlementSession('fixture-paired-session','fixture-first-key')!;expect(first.live()).toBe(true);
  const second=phoneOwnerSettlementSession('fixture-paired-session','fixture-second-key')!;expect(first.live()).toBe(false);expect(second.live()).toBe(true);
  revokePhoneOwnerSettlementSession('fixture-paired-session');expect(second.live()).toBe(false);
  expect(phoneOwnerSettlementSession('fixture-paired-session','fixture-second-key')).toBeUndefined();
});

it('C04 RED_receipt_committed_projection_failed_is_read_only real decision projection',async()=>{
  const f=setup(),callback=vi.fn(f.accept),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  f.queue.bindAcceptance('switch_skill',callback,callback);
  const source:QueueRecoverySource={...f.queue,kind:'skill',base:f.queue.base,
    pendingApprovals:()=>f.queue.pendingApprovals(),approval:id=>f.queue.approval(id),receipt:item=>f.queue.receipt(item),
    refuseBeforeEffect:(item,code,message)=>f.queue.refuseBeforeEffect(item,code,message),
    pendingPage:(after,limit)=>f.queue.pendingPage(after,limit),
    reopen:item=>({kind:'service',service:'skill',claim:f.host.claim,call:item.call}),
    respond:(item,answer,options,settlement)=>f.queue.respond(item,answer,options,settlement),
    cancel:(item,reason)=>f.queue.cancel(item,reason),renew:(item,identity)=>f.queue.renew(item,identity)};
  const dispose=d.installQueueSources([source]);
  try{
    if(f.request.outcome.kind!=='card')throw new Error('fixture requires a registered card');
    await f.queue.present(f.request,f.request.outcome.ref);
    f.host.setLevel('unlimited');await d.onLevelChange('b');
    expect(effect).toHaveBeenCalledTimes(1);expect(callback).toHaveBeenCalledTimes(1);
    expect(f.queue.receipt(f.item)).toMatchObject({state:'already',authorization:'automatic'});
    skills.setSkillEnabled('b','sample-skill',false);
    records.updateRecord(f.host.db,f.item.approvalId,{delivery:'pending'});
    // Discard the decision registry. The persisted row is only a failed projection of the producer receipt.
    d.installDecisionHost({store:f.host.store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:()=>({kind:'eligible',retire:true})});
    const ref=d.readApproval(f.item.approvalId)!.ref,read=vi.spyOn(skills,'readSkillSwitchTarget');
    await d.answerApproval(ref,{behavior:'allow'},automaticSettlement('replay'));
    expect(d.readApprovalExecution(ref).delivery).toBe('accepted');
    expect(callback).toHaveBeenCalledTimes(1);expect(effect).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();
    expect(state()['sample-skill'].enabled).toBe(false);
  }finally{dispose();f.host.dispose();}
});

it('C04 RED_receipt_committed_projection_failed_is_read_only requires a positive final barrier',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget'),barrier=atomic.syncParentDirectoryStatus;
  const spy=vi.spyOn(atomic,'syncParentDirectoryStatus').mockImplementation((path,platform)=>{
    try{if(String(path).endsWith('fixture-switch-queue.json')&&JSON.parse(readFileSync(String(path),'utf8')).entries.some((e:any)=>e.state==='accepted'))return 'unsupported';}catch{}
    return barrier(path,platform);
  });
  expect(await f.deliver()).toMatchObject({state:'unconfirmed'});expect(effect).toHaveBeenCalledTimes(1);
  expect(f.durable().state).toBe('accepted');
  skills.setSkillEnabled('b','sample-skill',false);
  expect(await f.deliver()).toMatchObject({state:'unconfirmed'});
  expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('replay'))).toMatchObject({state:'unconfirmed'});
  expect(effect).toHaveBeenCalledTimes(1);expect(state()['sample-skill'].enabled).toBe(false);
  spy.mockRestore();
  expect(await f.reload().respond(f.item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('replay'))).toMatchObject({state:'already',authorization:'automatic'});
  expect(effect).toHaveBeenCalledTimes(1);f.host.dispose();
});

it('B04 distinct automatic deliveries are serial and a live owner click never waits behind them',async()=>{
  const f=setup(),id='fixture-second-switch';
  const request=f.queue.open({authority:{claim:f.host.claim,proof:'trusted'},ref:id,epoch:id,tool:'switch_skill',input:f.input,
    action:{...f.item.call.approval!.action,requestId:id,skillRequest:{id,action:'turn_on',name:f.input.name}},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
  if(request.outcome.kind!=='card')throw new Error('fixture requires a second registered card');
  const second=f.queue.stage(request,request.outcome.ref);
  let release!:()=>void,active=0,maximum=0;
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const seen:string[]=[];
  f.queue.bindAcceptance('switch_skill',async(item,answer,delivery)=>{
    maximum=Math.max(maximum,++active);seen.push(item.ref);
    try{if(item.ref===f.item.ref)await hold;f.accept(item,answer,delivery);}finally{active--;}
  });
  f.host.setLevel('unlimited');
  const first=f.deliver();
  const token=f.registry.issue(second,f.context)!;expect(token).toBeDefined();
  expect(await f.queue.respond(second,{behavior:'allow'},{answerId:'fixture-owner'},{kind:'owner',token})).toMatchObject({state:'failed',code:'in-flight'});
  expect(f.registry.validate(token,second)).toBe(true);f.registry.expire(token);
  const next=f.queue.respond(second,{behavior:'allow'},{answerId:'fixture-second'},automaticSettlement('recovery'));
  expect(seen).toEqual([f.item.ref]);expect(f.queue.switchDeliverySlotAvailable()).toBe(false);
  release();expect(await first).toMatchObject({state:'accepted'});
  expect(await next).toMatchObject({state:'not-run'});
  expect(seen).toEqual([f.item.ref,second.ref]);expect(maximum).toBe(1);expect(f.queue.switchDeliverySlotAvailable()).toBe(true);f.host.dispose();
});

it('C04 synchronous receipt lookup stays immutable while projection repair waits for capacity',async()=>{
  const f=setup(),effect=vi.spyOn(skills,'applySkillSwitchTarget');
  const source:QueueRecoverySource={kind:'skill',base:f.queue.base,pendingApprovals:()=>f.queue.pendingApprovals(),pendingPage:(after,limit)=>f.queue.pendingPage(after,limit),
    approval:id=>f.queue.approval(id),receipt:item=>f.queue.receipt(item),reopen:item=>({kind:'service',service:'skill',claim:f.host.claim,call:item.call}),
    respond:(...args)=>f.queue.respond(...args),cancel:(...args)=>f.queue.cancel(...args),renew:(...args)=>f.queue.renew(...args)};
  const dispose=d.installQueueSources([source]);let release!:()=>void;
  try{
    if(f.request.outcome.kind!=='card')throw new Error('fixture requires a card');
    await f.queue.present(f.request,f.request.outcome.ref);f.host.setLevel('unlimited');await d.onLevelChange('b');
    records.updateRecord(f.host.db,f.item.approvalId,{delivery:'pending'});skills.setSkillEnabled('b','sample-skill',false);
    const hold=skillSettlementWork.drain(()=>new Promise<void>(resolve=>{release=resolve;})),read=vi.spyOn(skills,'readSkillSwitchTarget');
    expect(d.answerApprovalSync(f.request.outcome.ref,{behavior:'allow'})).toMatchObject({state:'already',authorization:'automatic'});
    release();await hold;await skillSettlementWork.item(()=>{});
    expect(d.readApprovalExecution(f.request.outcome.ref).delivery).toBe('accepted');expect(effect).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expect(state()['sample-skill'].enabled).toBe(false);
  }finally{release?.();dispose();f.host.dispose();}
});
