// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it} from 'vitest';
import {ownerMemoryTicket} from './memory/authority.ts';
import {Store} from './store.ts';
import {bindHumanThread,observeVerifiedHuman,linkHumanBinding,resolveHumanBinding} from './human-principals.ts';
import {installPermissionInheritance} from './permission-inheritance.ts';
import {autoVerdict,hasNoLimits} from './auto-approve.ts';
import {d,fixture,baseCard} from './decision/fixture.ts';
// Sean / MAIN 11-12: guests never inherit; recorded No limits selections apply as set.
let reset=()=>{};afterEach(()=>reset());
it('R3-1 guest thread cannot inherit the owner default or waive its card',()=>{
 reset=installPermissionInheritance(()=>true);
 const store=new Store(),bot=store.createBot({name:'Guest fixture'},{seedMessages:false});
 // A non-owner human binding is persisted and projected by the real store.
 const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'fixture-guest',userId:'GUEST'});
 linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});
 bindHumanThread(bot.threadId,resolveHumanBinding(binding));
 const projected=store.projectBotForTask(bot.id,bot.threadId)!;
 expect(hasNoLimits(projected)).toBe(false);
 expect(autoVerdict(projected,'Bash','printf fixture > /etc/fixture-policy',{fullAccessOrigin:'other',commandText:'printf fixture > /etc/fixture-policy',unattended:true}).approve).toBeNull();
});
it.each(['guest','other-human'] as const)('R3-1 registered %s never gets wipe-only relief',k=>{
 const f=fixture('ask',{k});f.setOwner(false);
 expect(d.decide(f.open('guest',{command:'printf fixture > /etc/fixture-policy'}),baseCard).kind).toBe('card');f.dispose();
});
it('R3-1 an owner-only thread does not re-card a stale snapshot',()=>{
 const f=fixture();expect(d.decide(f.open('stale',{}, {turnId:'old'}),baseCard).kind).toBe('run');f.dispose();
});
it('R3-1 an unverified routine delegation cannot become an unattended No limits turn',()=>{
 const f=fixture('unlimited',{k:'routine-run',sourceRunId:'unverified',sourceBotId:'b',recipientGeneration:'g',form:'run',trigger:'manual'});
 expect(d.decide(f.open('unverified-routine',{command:'eval "$OPAQUE"'}),baseCard).kind).toBe('card');f.dispose();
});
it.each(['owner','routine','owner-channel'] as const)('R3-1 proven %s retains wipe-only relief',origin=>{
 const bot={autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
 expect(autoVerdict(bot,'Bash','printf fixture > /etc/fixture-policy',{fullAccessOrigin:origin,routineLevel:origin==='routine',channelOwner:origin==='owner-channel'}).approve).toBeTruthy();
});

it.each(['ask','auto','full','unlimited'] as const)('R3-1 guest applies only a recorded No limits bot level %s',level=>{
 reset=installPermissionInheritance(()=>true);
 const store=new Store(),bot=store.createBot({name:'Explicit guest fixture'},{seedMessages:false});
 const flags={autoApprove:level!=='ask',fullAccess:level==='full'||level==='unlimited',noLimits:level==='unlimited',permissionExplicit:true};
 store.patchBot(bot.id,flags);
 const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'fixture-explicit-guest',userId:'GUEST'});
 linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});bindHumanThread(bot.threadId,resolveHumanBinding(binding));
 const projected=store.projectBotForTask(bot.id,bot.threadId)!;
 expect(projected).toMatchObject(level==='unlimited'?flags:{autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:true});
 expect(hasNoLimits(projected)).toBe(level==='unlimited');
 const result=autoVerdict(projected,'Bash','printf fixture > /etc/fixture-policy',{fullAccessOrigin:'other',commandText:'printf fixture > /etc/fixture-policy',unattended:true});
 if(level==='unlimited')expect(result.approve).toBeTruthy();else expect(result.approve).toBeNull();
});

it('R3-1 live guest card survives an unavailable legacy grant builder',()=>{
 const f=fixture('ask',{k:'other-human'});f.setOwner(false);
 d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Guest'})});
 expect(d.decide(f.open('guest-no-builder',{command:'printf fixture > /etc/fixture-policy'}),baseCard).kind).toBe('card');f.dispose();
});

it('08:05 owner-only stale snapshots run past stored permission denies without a card',()=>{
 const f=fixture();f.deny([{kind:'deny',class:'stored',ruleId:'fixture-deny',span:'fixture'}]);
 expect(d.decide(f.open('stale-deny',{command:'printf ok'},{turnId:'old'}),()=>({approve:'base',source:'auto-mode'})).kind).toBe('run');f.dispose();
});
