import {expect,it,vi} from 'vitest';
import {fixture,d,baseCard} from './fixture.ts';
import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {autoVerdict} from '../auto-approve.ts';
import {installPermissionInheritance} from '../permission-inheritance.ts';
it.each([undefined,'unproven','guest','other','other-human'] as const)('P4 %s never inherits owner No limits',origin=>{
 const dispose=installPermissionInheritance(()=>true);
 try{const bot={autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};expect(noLimitsAppliesTo(origin,bot)).toBe(false);expect(autoVerdict(bot,'Bash','touch /fixture/effect',{noLimitsOrigin:origin??'unproven',commandText:'touch /fixture/effect'}).approve).toBeNull();}finally{dispose();}
});
it('P4 missing provenance binds Ask to the real BASE callback while owner turns keep No limits',()=>{
 const f=fixture();expect(d.decide(f.open('owner'),baseCard).kind).toBe('run');
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
 const base=vi.fn((r:d.Registration)=>({approve:r.level==='unlimited'?'inherited':null,source:'always-ask' as const}));
 expect(d.decide(f.open('unknown',{command:'touch /fixture/effect'}),base).kind).toBe('card');
 expect(base).toHaveBeenCalledOnce();expect(base.mock.calls[0][0]).toMatchObject({actor:'unproven',level:'ask'});
});

it.each(['guest','other-human','unrecognised'] as const)('P4 %s never borrows a stale live owner flag',kind=>{
 const f=fixture('unlimited',{k:kind} as any),base=vi.fn((_r:d.Registration)=>baseCard());
 expect(d.decide(f.open('stale-owner'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({level:'ask'});
});
it('P4 lost provenance still preserves wipe and deny evidence',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
 const base=()=>({approve:'BASE',source:'auto-mode' as const});
 expect(d.decide(f.open('unknown-wipe',{command:'rm -rf ~'}),base).kind).toBe('card');
});

it('P4 a guest principal cannot recover a different owner principal',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
 provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'guest',roomOwnerOnly:false,at:1,initiator:{k:'other-human'}}),
 live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'guest',owner:false,level:'unlimited'}),
 ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})});
 const base=vi.fn((_r:d.Registration)=>baseCard());expect(d.decide(f.open('guest-recovery'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({level:'ask'});
});

it.each(['webhook','peer','delegation'] as const)('P4 a %s cannot lift a known guest audience',kind=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
 provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'guest',roomOwnerOnly:false,at:1,initiator:{k:kind} as any}),
 live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'guest',owner:false,level:'unlimited'})});
 const base=vi.fn((_r:d.Registration)=>baseCard());expect(d.decide(f.open('guest-trigger'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({actor:'other',level:'ask'});
});

// Review H1: the thread's owner is not proof of this turn's sender.
it.each([undefined,'other-human','unrecognised','owner-typed'] as const)('H1 owner-owned thread with unauthenticated %s turn stays Ask before recovery',kind=>{
 const f=fixture();
 const recovery=vi.fn(()=>({botId:'b',principal:'owner',level:'unlimited' as const,origin:'owner' as const}));
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
  provenance:()=>kind===undefined?undefined:({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:kind==='unrecognised',at:1,initiator:{k:kind} as any}),
  live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:false,level:'unlimited'}),ownerThread:recovery});
 const base=vi.fn((_r:d.Registration)=>baseCard());
 expect(d.decide(f.open('unverified-owner'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({level:'ask'});
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level:'ask',permission:{routeAsks:true,askLevel:true}});
 expect(recovery).not.toHaveBeenCalled();f.dispose();
});
it('H1 authenticated owner turn may recover missing live settings and still holds a wipe',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
  provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}),
  live:()=>undefined,ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})});
 expect(d.decide(f.open('verified-recovery'),baseCard).kind).toBe('run');
 expect(d.decide(f.open('verified-wipe',{command:'rm -rf ~'}),baseCard).kind).toBe('card');f.dispose();
});

// MAIN RULING: "owner No limits authority comes ONLY from an authenticated owner turn (the turn's own verified origin), never from thread ownership".
it('SFX-AUTH unknown-origin in an owner-owned thread is Ask even without live settings',()=>{
 const f=fixture(),recovery=vi.fn(()=>({botId:'b',principal:'owner',level:'unlimited' as const,origin:'owner' as const}));
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>undefined,ownerThread:recovery});
 const base=vi.fn((_r:d.Registration)=>baseCard());
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({actor:'unproven',level:'ask',permission:{routeAsks:true,askLevel:true}});
 // Without an addressable live transport, Ask refuses delivery instead of inventing a card target.
 expect(d.decide(f.open('unknown-no-live'),base).kind).toBe('refuse');
 expect(recovery).not.toHaveBeenCalled();f.dispose();
});
// MAIN RULING: "guests and other people threads ALWAYS Ask, even on a bot explicitly at No limits".
it.each(['guest','other-human'] as const)('SFX-AUTH %s on an explicit No limits bot stays Ask before recovery',kind=>{
 const f=fixture(),bot=f.store.createBot({name:'Explicit No limits'},{seedMessages:false});
 Object.assign(bot,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
 expect(f.store.bot(bot.id)).toMatchObject({noLimits:true,permissionExplicit:true});
 const recovery=vi.fn(()=>({botId:bot.id,principal:'owner',level:'unlimited' as const,origin:'owner' as const}));
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
  provenance:()=>({threadId:'t',botId:bot.id,generation:'g',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:kind}}),
  live:()=>({botId:bot.id,turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',permissionExplicit:true}),ownerThread:recovery});
 const base=vi.fn((_r:d.Registration)=>baseCard());
 expect(d.decide(f.open('explicit-guest'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({actor:'other',level:'ask'});expect(recovery).not.toHaveBeenCalled();f.dispose();
});
it('SFX-AUTH stale service claim cannot borrow the replacement owner generation',()=>{
 const f=fixture(),claim=f.claim;f.setGeneration('replacement');
 const base=vi.fn((_r:d.Registration)=>baseCard());
 const handle=d.openRequest({kind:'service',service:'email',claim,call:{tool:'fixture_read',input:{}}});
 expect(d.decide(handle,base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({actor:'unproven',level:'ask'});f.dispose();
});
it('SFX-AUTH a valid owner routine explicitly at Ask keeps its ceiling on a No limits bot',()=>{
 const initiator={k:'routine-run' as const,form:'run' as const,sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g',trigger:'schedule' as const};
 const f=fixture('unlimited',initiator);
 const bot=f.store.createBot({name:'Routine host'},{seedMessages:false});
 initiator.sourceBotId=bot.id;
 Object.assign(bot,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
 expect(f.store.bot(bot.id)).toMatchObject({noLimits:true,permissionExplicit:true});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',
  provenance:()=>({threadId:'t',botId:bot.id,generation:'g',principal:'owner',roomOwnerOnly:true,at:1,initiator}),
  live:()=>({botId:bot.id,turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'ask',permissionExplicit:true,
   routine:{sourceRunId:'run',sourceBotId:bot.id,recipientGeneration:'g',owner:true}})});
 const base=vi.fn((_r:d.Registration)=>baseCard());
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({actor:'owner-routine',level:'ask',permission:{routeAsks:true,askLevel:true}});
 expect(d.decide(f.open('explicit-routine-ask'),base).kind).toBe('card');
 expect(base.mock.calls[0][0]).toMatchObject({actor:'owner-routine',level:'ask'});f.dispose();
});
