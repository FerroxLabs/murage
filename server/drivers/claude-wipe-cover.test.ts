import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// SDK fake only: these shell inputs are never executed.
import { chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { beginOutsideTurn } from '../email/external-marks.ts';
import { noteToolStartOutside } from '../outside-wire.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { ClaudeDriver } from './claude.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { ensureDirs } from '../config.ts';
import { d, fixture, baseRun } from '../decision/fixture.ts';
import type { ProviderInstance } from '../contracts.ts';
vi.mock('node:child_process', async (original) => (await import('../testing/exec-check-spy.ts')).withExecCheckSpy(await original()));
const recovery=vi.hoisted(()=>({fail:false,missing:false,decisions:[] as string[]}));
vi.mock('./claude-bash-hook.ts',async original=>{
 const actual=await original<typeof import('./claude-bash-hook.ts')>();
 return {...actual,relayClaudeBash:async(...args:Parameters<typeof actual.relayClaudeBash>)=>{
  if(recovery.fail)args[0]+='-transport-failed';
  if(recovery.missing)args[3]={};
  const result=await actual.relayClaudeBash(...args);
  if(recovery.fail)recovery.decisions.push((result.hookSpecificOutput as any).permissionDecision);
  return result;
 }};
});
useOutsideStoreFixture();
const cli=fileURLToPath(new URL('../testing/fake-claude-cli.ts',import.meta.url));
let instance:ProviderInstance|undefined;
afterEach(async()=>{await instance?.dispose();instance=undefined;delete process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS;delete process.env.FAKE_CLAUDE_SDK_SANDBOX;delete process.env.FAKE_CLAUDE_PERM_INPUT;});
for(const sandbox of [false,true])for(const [command,kind]of [['rm -rf backups','card'],['echo ok','run'],['rm -rf /','card']] as const)it(`W4 SDK acceptEdits Bash reaches wipe decision (sandbox=${sandbox}): ${command}`,async()=>{
 ensureDirs();chmodSync(cli,0o755);
 process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS='1';if(sandbox)process.env.FAKE_CLAUDE_SDK_SANDBOX='1';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command});
 const f=fixture(),cwd=fixtureBotFolder();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Wipe'}),executionContext:()=>({cwd,project:cwd})});
 instance=await admittedFixtureInstance(ClaudeDriver.create({instanceId:'p',displayName:'Fixture',environment:{},enabled:true,config:{cli,permissionMode:'acceptEdits'}}));
 const recorder=recordEvents(instance.adapter),outcomes:string[]=[];
 const off=instance.adapter.onEvent(event=>{
  if(event.type!=='request.opened')return;
  f.setTurn(event.turnId!);
  // The production registry stamps this on driver events before the bus.
  f.publish({...event,providerInstanceId:'p'});
  const outcome=d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!}),baseRun);outcomes.push(outcome.kind);
  void instance!.adapter.respondToRequest('t',event.requestId!,{behavior:outcome.kind==='run'?'allow':'deny'});
 });
 try{
  await instance.adapter.sendTurn({threadId:'t',cwd,text:'__fixture_permission_tool__',noLimits:true,stopLine:true,routeAsks:true});
  await recorder.until(event=>event.type==='turn.completed',45000);
  // MAIN RULING 2026-11-13 narrow-wipe (Sean)
  expect(outcomes).toEqual([command==='rm -rf /'?kind:'run']);
  const requests=recorder.events.filter(event=>event.type==='request.opened');expect(requests).toHaveLength(1);
 }finally{off();recorder.stop();f.dispose();}
},60000);

it.each(['bash cleanup.sh','source ./cleanup.sh','ksh cleanup.sh','bash < cleanup.sh'])('D2 SDK transport failure after this turn writes cleanup.sh opens a wipe card and never allows: %s',async command=>{
 ensureDirs();chmodSync(cli,0o755);recovery.fail=true;recovery.decisions=[];
 process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS='1';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command});
 const f=fixture(),cwd=fixtureBotFolder(),file=join(cwd,'cleanup.sh');
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Wipe'}),executionContext:()=>({cwd,project:cwd})});
 instance=await admittedFixtureInstance(ClaudeDriver.create({instanceId:'p',displayName:'Fixture',environment:{},enabled:true,config:{cli,permissionMode:'acceptEdits'}}));
 const recorder=recordEvents(instance.adapter),outcomes:string[]=[],errors:unknown[]=[];
 const off=instance.adapter.onEvent(event=>{
  if(event.type==='turn.started'){
   f.setTurn(event.turnId!);beginOutsideTurn('t','p',event.turnId!,false,Date.now()-20);
   const input={file_path:file,content:'rm -rf ~'};
   expect(d.decide(f.open('d2-write',input,{tool:'Write',toolCall:{name:'Write',input}}),baseRun).kind).toBe('run');
   noteToolStartOutside('t',{origin:'engine',title:'Write',input},cwd);writeFileSync(file,'rm -rf ~');
  }
  if(event.type!=='request.opened')return;
  f.publish({...event,providerInstanceId:'p'});
  const outcome=d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!}),baseRun);outcomes.push(outcome.kind);
  void (async()=>{
   try{if(outcome.kind==='card'){
    await d.presentApproval(outcome.ref,{title:'Wipe',subtitle:'Fixture'});
    expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({why:'wipe'});
   }}catch(error){errors.push(error);}
   finally{await instance!.adapter.respondToRequest('t',event.requestId!,{behavior:'deny'});}
  })();
 });
 try{
  await instance.adapter.sendTurn({threadId:'t',cwd,text:'__fixture_permission_tool__',noLimits:true,stopLine:true,routeAsks:true});
  await recorder.until(event=>event.type==='turn.completed',45000);
  // MAIN RULING 2026-11-13 narrow-wipe (Sean)
  expect(errors).toEqual([]);expect(outcomes).toEqual([]);expect(recovery.decisions).toEqual(['allow']);
 }finally{recovery.fail=false;off();recorder.stop();f.dispose();}
},60000);

// An unavailable journal must still show a real central wipe card. The fake
// SDK supplies the command but never executes it or calls a paid provider.
it.each([`printf -v 'a[$(./cleanup.sh)]' %s x`,"git status","grep ok README.md","rg ok README.md","cp a b","mv a b","file file","rg --pre=./cleanup.sh x f","rg --pre ./cleanup.sh x f","git -c core.pager=./x log","sort --compress-program=./x f","find . -exec sh x \\;","eval 'python3 -c \"exec(input())\"' < cleanup.py","cat cleanup.py | eval 'python3 -c \"exec(input())\"' ","echo ok",'bash -e cleanup.sh','ksh -e cleanup.sh','bash -se < cleanup.sh','sh -x cleanup.sh','python3 -u cleanup.py','env -S bash cleanup.sh','cat cleanup.sh | bash','find . -exec bash cleanup.sh \\;','pypy3 cleanup.py','builtin source cleanup.sh','xargs sh < list','./anything','ls -la','git status','cat README.md',"bash -c 'echo ok'"] )('R4 SDK failed transport without authenticated write context: %s',async command=>{
 ensureDirs();chmodSync(cli,0o755);recovery.fail=true;recovery.missing=true;recovery.decisions=[];
 process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS='1';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command});
 const f=fixture(),cwd=fixtureBotFolder();
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Wipe'}),executionContext:()=>({cwd,project:cwd})});
 instance=await admittedFixtureInstance(ClaudeDriver.create({instanceId:'p',displayName:'Fixture',environment:{},enabled:true,config:{cli,permissionMode:'acceptEdits'}}));
 const recorder=recordEvents(instance.adapter),outcomes:string[]=[],errors:unknown[]=[];
 // MAIN RULING 2026-11-13 narrow-wipe (Sean)
 const safe=true;
 const off=instance.adapter.onEvent(event=>{
  if(event.type==='turn.started')f.setTurn(event.turnId!);
  if(event.type!=='request.opened')return;
  f.publish({...event,providerInstanceId:'p'});
  const outcome=d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!}),baseRun);outcomes.push(outcome.kind);
  void (async()=>{
   try{
    expect(outcome.kind).toBe('card');
    if(outcome.kind==='card'){
     await d.presentApproval(outcome.ref,{title:'Wipe',subtitle:'Fixture'});
     expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({why:'wipe'});
    }
   }catch(error){errors.push(error);}
   finally{await instance!.adapter.respondToRequest('t',event.requestId!,{behavior:'deny'});}
  })();
 });
 try{
  await instance.adapter.sendTurn({threadId:'t',cwd,text:'__fixture_permission_tool__',noLimits:true,stopLine:true,routeAsks:true});
  await recorder.until(event=>event.type==='turn.completed',45000);
  expect(errors).toEqual([]);expect(outcomes).toEqual(safe?[]:['card']);expect(recovery.decisions).toEqual([safe?'allow':'deny']);
 }finally{recovery.fail=false;recovery.missing=false;off();recorder.stop();f.dispose();}
},60000);
