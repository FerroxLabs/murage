// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it} from 'vitest';
import {autoVerdict} from './auto-approve.ts';
import {routineTurnApproval} from './routine-permissions.ts';
import {installPermissionInheritance} from './permission-inheritance.ts';
import {d,fixture,baseCard} from './decision/fixture.ts';
let reset=()=>{};afterEach(()=>reset());
// W3: standalone opaque eval is now a wipe hold; relief twins use a non-wipe protected write.
const nl={autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
it.each(['webhook','unattended','routine'] as const)('R3-5 %s distinguishes explicit, inherited and legacy No limits',noLimitsOrigin=>{
 reset=installPermissionInheritance(()=>true);
 const context={noLimitsOrigin,fullAccessOrigin:noLimitsOrigin==='routine'?'routine' as const:'other' as const,routineLevel:noLimitsOrigin==='routine',unattended:true};
 for(const bot of [nl,{autoApprove:false,permissionExplicit:false}])for(const [command,card] of [['eval "$OPAQUE"; echo ok',false],['rm -rf ~',true]] as const){
  expect(autoVerdict(bot,'Bash',command,{...context,commandText:command}).approve===null).toBe(card);
 }
 for(const bot of [{autoApprove:true,fullAccess:true,noLimits:true},{autoApprove:true,fullAccess:true,noLimits:false}]){
  const command='printf fixture > /etc/fixture-policy';
  expect(autoVerdict(bot,'Bash',command,{...context,commandText:command}).approve).toBeNull();
  if(noLimitsOrigin==='routine')expect(routineTurnApproval({bot,run:{},tool:'Bash',summary:command,context:{...context,commandText:command}}).verdict.approve).toBeNull();
 }
});
it.each([true,false])('R3-5 owner channel enabled=%s is honoured',enabled=>{
 reset=installPermissionInheritance(()=>true);
 expect(autoVerdict({...nl,fullAccessChannelMessages:enabled},'Bash','printf fixture > /etc/fixture-policy',{noLimitsOrigin:'owner-channel',fullAccessOrigin:'owner-channel',channelOwner:true,unattended:true,commandText:'printf fixture > /etc/fixture-policy'}).approve!==null).toBe(enabled);
});
it.each(['webhook','delegation'] as const)('R3-5 registered %s checks every visible wipe',k=>{
 for(const [command,expected]of [['eval "$OPAQUE"; echo ok','run'],['rm -rf ~','card']] as const){const f=fixture('unlimited',{k});expect(d.decide(f.open('external',{command}),baseCard).kind).toBe(expected);f.dispose();}
});
it('R3-5 explicit Auto external turn retains Auto instead of inheriting No limits',()=>{
 reset=installPermissionInheritance(()=>true);
 const result=autoVerdict({autoApprove:true,fullAccess:false,noLimits:false,permissionExplicit:true},'Bash','printf fixture > /etc/fixture-policy',{noLimitsOrigin:'webhook',fullAccessOrigin:'other',unattended:true,commandText:'printf fixture > /etc/fixture-policy'});
 expect(result.approve).toBeNull();
});
it.each(['ask','auto','full','unlimited'] as const)('R3-5 registered owner channel off refuses without a card at %s',async level=>{
 const f=fixture(level,{k:'owner-channel-dm',channel:'fixture'});
 d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Channel off'})});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-channel-dm',channel:'fixture'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level,fullAccessChannelMessages:false})});
 const handle=f.open();expect(d.decide(handle,baseCard)).toMatchObject({kind:'refuse',message:'Channel messages are off; turn them on in this bot’s Permissions → Channel messages.'});
 await d.deliverRequest(handle);expect(d.openApprovals('t')).toEqual([]);expect(f.respond.mock.calls).toHaveLength(1);expect(f.respond.mock.calls[0]?.[1]).toMatchObject({behavior:'deny',message:'Channel messages are off; turn them on in this bot’s Permissions → Channel messages.'});
 expect(f.store.messagesFor('t').filter(m=>m.role==='bot'&&m.kind==='text')).toEqual([expect.objectContaining({text:'Channel messages are off; turn them on in this bot’s Permissions → Channel messages.'})]);
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).not.toBe(true);f.dispose();
});
it('R3-6 Ask routine still needs its grant',()=>{
 expect(autoVerdict({autoApprove:false,permissionExplicit:true},'Bash','printf fixture > /etc/fixture-policy',{fullAccessOrigin:'routine',routineLevel:true,automated:true,commandText:'printf fixture > /etc/fixture-policy'}).approve).toBeNull();
});
it('R3-6 No limits routine does not need a grant',()=>{
 expect(autoVerdict(nl,'Bash','printf fixture > /etc/fixture-policy',{fullAccessOrigin:'routine',routineLevel:true,automated:true,unattended:true,commandText:'printf fixture > /etc/fixture-policy'}).approve).toBeTruthy();
});

it('D2 manually started owner routine keeps Full access and owner No limits authority',()=>{
 const command='printf fixture > /etc/fixture-policy';
 const context={fullAccessOrigin:'routine' as const,routineLevel:true,automated:true,ownerStarted:false,commandText:command};
 expect(autoVerdict({autoApprove:true,fullAccess:true},'Bash','printf ready',{...context,commandText:'printf ready'})).toEqual({approve:'auto-approved Bash (full access)',source:'full-access'});
 expect(autoVerdict({...nl,permissionExplicit:undefined,permissionRev:0},'Bash',command,context).approve).toBeTruthy();
 expect(autoVerdict(nl,'Bash','rm -rf ~',{...context,commandText:'rm -rf ~'})).toMatchObject({approve:null,rule:'delete-home'});
 expect(autoVerdict({autoApprove:false,permissionExplicit:true},'Bash',command,context).approve).toBeNull();
});

it.each(['ask','auto','full'] as const)('R3-6 unattended routine explicit %s ceiling cannot inherit through its bot',permissionMode=>{
 reset=installPermissionInheritance(()=>true);
 const result=routineTurnApproval({bot:{...nl,noLimits:false,permissionExplicit:true},run:{permissionMode},tool:'Bash',summary:'printf fixture > /etc/fixture-policy',context:{noLimitsOrigin:'routine',fullAccessOrigin:'routine',routineLevel:true,unattended:true,commandText:'printf fixture > /etc/fixture-policy'}});
 expect(result.mode).toBe(permissionMode);expect(result.verdict.approve).toBeNull();
});

it.each(['ask','auto','full'] as const)('No limits unattended routine ignores the saved %s ceiling',permissionMode=>{
 reset=installPermissionInheritance(()=>true);
 const result=routineTurnApproval({bot:nl,run:{permissionMode},tool:'Bash',summary:'printf fixture > /etc/fixture-policy',context:{noLimitsOrigin:'routine',fullAccessOrigin:'routine',routineLevel:true,unattended:true,commandText:'printf fixture > /etc/fixture-policy'}});
 expect(result.mode).toBe('unlimited');expect(result.verdict.approve).toBeTruthy();
});

it('R3-5 webhook turn policy carries No limits to the engine',()=>{
 const f=fixture('unlimited',{k:'webhook'});
 try{expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);}finally{f.dispose();}
});
it('R3-5 a webhook base card releases after its bot is raised to No limits',async()=>{
 const f=fixture('ask',{k:'webhook'});
 try{
  const out=d.decide(f.open('webhook-upgrade',{command:'eval "$OPAQUE"'}),baseCard);
  expect(out.kind).toBe('card');if(out.kind!=='card')throw Error('missing initial Ask card');
  await d.presentApproval(out.ref,{title:'Action',subtitle:'Fixture'});f.setLevel('unlimited');await d.onLevelChange('b');
  expect(f.respond.mock.calls[0]?.[1].behavior).toBe('allow');
 }finally{f.dispose();}
});

it.each(['ask','auto','full'] as const)('R3-5 channel option off retains its existing card at %s', level=>{
 const f=fixture(level,{k:'owner-channel-dm',channel:'fixture'});
 try {
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-channel-dm',channel:'fixture'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level,fullAccessChannelMessages:false})});
  expect(d.decide(f.open(),baseCard).kind).toBe('card');
 } finally {f.dispose();}
});
