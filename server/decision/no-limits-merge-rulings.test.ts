// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean / MAIN 2026-11-12: only a visible catastrophe holds an owner turn.
// All command strings are inert; only the fake transport receives replies.
import {mkdtempSync, symlinkSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {fixture, d, baseCard, baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
import {noLimitsWipe} from '../no-limits-wipe.ts';
import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {permissionsForOrigin, installPermissionInheritance} from '../permission-inheritance.ts';
import {bindHumanThread, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding} from '../human-principals.ts';
import {ownerMemoryTicket} from '../memory/authority.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {bindServiceTurn,serviceNoLimits} from '../service-no-limits.ts';
const dirs:string[]=[];
let reset=()=>{};
afterEach(()=>{reset();for(const dir of dirs.splice(0))removeTempDirSync(dir);});

it('C1 an owner write through a credential symlink reaches native delivery without a card',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nolim-merge-link-'));dirs.push(root);
 const path=join(root,'config');symlinkSync(join(homedir(),'.ssh','config'),path);
 const f=fixture();
 const h=f.open('link',{path,content:'fixture'},{tool:'write_file',toolCall:{name:'write_file',input:{path,content:'fixture'}}});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(guardEngineRelease({threadId:'t',requestId:'link',turnId:'turn',providerInstanceId:'p'})).toBe(true);
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});
it('C1 changed non-wipe input between decision and release still runs',async()=>{
 const f=fixture(),h=f.open('changed',{command:'printf ok'});expect(d.decide(h,baseCard).kind).toBe('run');
 f.publish(f.event('changed',{command:'printf changed > ~/.ssh/config'}));await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});
it('C1 a wipe introduced after the decision holds at final delivery',async()=>{
 const f=fixture(),h=f.open('late-wipe',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 f.publish(f.event('late-wipe',{command:'rm -rf ~'}));await d.deliverRequest(h);
 expect(f.respond).not.toHaveBeenCalled();expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'wipe'}));f.dispose();
});
it('C1 a native replay or missing registry entry cannot hold non-wipe owner work',()=>{
 const f=fixture(),h=f.open('cache',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 expect(guardEngineRelease({threadId:'t',requestId:'cache',turnId:'turn',providerInstanceId:'p'},undefined,{tool:'Bash',input:{command:'touch ~/.ssh/config'}})).toBe(true);
 expect(guardEngineRelease({threadId:'t',requestId:'not-captured',turnId:'turn',providerInstanceId:'p'},{command:'printf ok'})).toBe(true);
 expect(guardEngineRelease({threadId:'t',requestId:'not-captured',turnId:'turn',providerInstanceId:'p'},{command:'rm -rf ~'})).toBe(false);
 f.dispose();
});
it.each(['full','unlimited'] as const)('C2 legacy %s bot never gives its level to a stranger',level=>{
 reset=installPermissionInheritance(()=>true);const f=fixture(level);
 const bot=f.store.createBot({name:'Legacy guest fixture'},{seedMessages:false});
 f.store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:level==='unlimited',permissionExplicit:false});
 const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'merge-guest',userId:'GUEST'});
 linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});bindHumanThread(bot.threadId,resolveHumanBinding(binding));
 expect(f.store.projectBotForTask(bot.id,bot.threadId)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
 for(const origin of ['guest','other-human','other'] as const){
  expect(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:false})).toBe(false);
  expect(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true})).toBe(true);
 }
 expect(permissionsForOrigin({autoApprove:true,fullAccess:true,noLimits:true},false)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});f.dispose();
});
it.each(['full','unlimited'] as const)('C2 a non-owner webhook remains Ask even if its raw live level is %s',level=>{
 const f=fixture(level,{k:'webhook'});f.setOwner(false);
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level:'ask',permission:{askLevel:true}});
 expect(d.decide(f.open('guest-hook',{command:'printf ok'}),baseCard).kind).toBe('card');f.dispose();
});
it('H1 an owner-only live thread survives a stale engine snapshot without recarding',async()=>{
 const f=fixture(),h=f.open('restarted',{command:'printf ok'},{turnId:'previous-process'});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
it('H2 persisted owner proof survives a missing live record, while visible wipes still card',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>undefined,
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})} as Parameters<typeof d.installProvenanceReader>[0]);
 expect(d.decide(f.open('identity',{command:'printf ok'}),baseCard).kind).toBe('run');
 expect(d.decide(f.open('identity-wipe',{command:'rm -rf ~'}),baseCard).kind).toBe('card');f.dispose();
});
it('H1 queued phone words keep their content origin while the persisted owner-only thread runs wipe-only',()=>{
 const f=fixture('unlimited',{k:'other-human'});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:false,at:1,initiator:{k:'other-human'}}),
  live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:false,level:'unlimited'}),
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'unattended'})});
 expect(d.decide(f.open('phone',{command:'printf ok'}),baseCard).kind).toBe('run');
 expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
it('H5 service policy uses the same recovered owner predicate as engine policy',()=>{
 const f=fixture();let active=true;
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>undefined,
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})});
 bindServiceTurn('g','t','b',()=>active,()=>({ownerAudience:false,origin:'unproven',noLimits:true}));
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
 expect(serviceNoLimits('g','t','b')).toBe(true);active=false;f.dispose();
});
it.each(['eval "$(ssh-agent -s)"','eval "$(brew shellenv)"','eval "$(pyenv init -)"','eval "$OPAQUE"'])('H3 unresolved evaluation runs: %s',command=>{
 expect(noLimitsWipe(command)).toBeNull();const f=fixture();expect(d.decide(f.open('eval',{command}),baseCard).kind).toBe('run');f.dispose();
});
it('H3 unresolved evaluation cannot hide a visible tail catastrophe',()=>{
 const f=fixture();expect(d.decide(f.open('eval-wipe',{command:'eval "$(ssh-agent -s)"; rm -rf ~'}),baseRun).kind).toBe('card');f.dispose();
});

it('C1 explicit Stop cancels release even at No limits',async()=>{
 const f=fixture(),h=f.open('stopped',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 await d.cancelRequests({kind:'generation',threadId:'t',generation:'g'},'cancelled');
 expect(guardEngineRelease({threadId:'t',requestId:'stopped',turnId:'turn',providerInstanceId:'p'},undefined,{tool:'Bash',input:{command:'printf ok'}})).toBe(false);
 f.dispose();
});

it('H3 a literal home assignment remains a visible catastrophe in a live owner context',()=>{
 const command='nolim_wipe=~; rm -rf "${nolim_wipe:?}"';
 expect(noLimitsWipe(command,{cwd:'/tmp/fixture-work',project:'/tmp/fixture-work',home:homedir()})).not.toBeNull();
 const f=fixture();
 expect(d.decide(f.open('assignment-wipe',{command,cwd:'/tmp/fixture-work'}),baseRun).kind).toBe('card');f.dispose();
});

it.each(['nolim_wipe=notes; rm -rf "${nolim_wipe:?}"','unset target; rm -rf "${target:?}"','unset target; rm -rf "${target:?rm -rf /}"'])('H3 error guards with no executable catastrophe run: %s',command=>{
 expect(noLimitsWipe(command,{cwd:'/tmp/fixture-work',home:homedir()})).toBeNull();
 const f=fixture();expect(d.decide(f.open('guard-data',{command,cwd:'/tmp/fixture-work'}),baseRun).kind).toBe('run');f.dispose();
});

it('H6 a visible Ruby wipe survives an earlier protected-path finding',()=>{
 for(const command of [`ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`,`touch /etc/motd; ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`]){
  expect(noLimitsWipe(command)).not.toBeNull();
  const f=fixture();expect(d.decide(f.open('ruby-wipe',{command}),baseRun).kind).toBe('card');f.dispose();
 }
});
it('H6 Git push dry runs do not become catastrophe findings',()=>{
 for(const command of ['git push --mirror --dry-run','git push --mirror -n']){expect(noLimitsWipe(command)).toBeNull();const f=fixture();expect(d.decide(f.open('dry-run',{command}),baseRun).kind).toBe('run');f.dispose();}
 expect(noLimitsWipe('git push --mirror')).not.toBeNull();
 expect(noLimitsWipe('git push --mirror --push-option --dry-run')).not.toBeNull();
});
it.each([`ruby -e 'puts "ordinary"'`,'ruby -e '+JSON.stringify(`puts 'FileUtils.rm_rf("/")'`),'ruby -e '+JSON.stringify(`puts 'FileUtils.rm_rf("/")`),'ruby -e '+JSON.stringify('puts <<~TEXT\nFileUtils.rm_rf("/")\nTEXT\n'),'ruby -e '+JSON.stringify('# FileUtils.rm_rf("/")'),'ruby -e '+JSON.stringify('=begin\nFileUtils.rm_rf("/")\n=end\n'),'ruby -e '+JSON.stringify('puts %q{FileUtils.rm_rf("/")}'),'ruby -e '+JSON.stringify('puts %r{FileUtils.rm_rf("/")}'),`echo 'ruby -e FileUtils.rm_rf("/")'`,`ruby -e 'FileUtils.rm_rf("notes")'`])('H6 interpreter data and ordinary deletes still run: %s',command=>{
 expect(noLimitsWipe(command)).toBeNull();
 const f=fixture();expect(d.decide(f.open('ruby-data',{command}),baseRun).kind).toBe('run');f.dispose();
});
