// SPDX-License-Identifier: AGPL-3.0-or-later
// SDK fake only: these shell inputs are never executed.
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeDriver } from './claude.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { ensureDirs } from '../config.ts';
import { d, fixture, baseRun } from '../decision/fixture.ts';
import type { ProviderInstance } from '../contracts.ts';
vi.mock('node:child_process', async (original) => (await import('../testing/exec-check-spy.ts')).withExecCheckSpy(await original()));
const cli=fileURLToPath(new URL('../testing/fake-claude-cli.ts',import.meta.url));
let instance:ProviderInstance|undefined;
afterEach(async()=>{await instance?.dispose();instance=undefined;delete process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS;delete process.env.FAKE_CLAUDE_SDK_SANDBOX;delete process.env.FAKE_CLAUDE_PERM_INPUT;});
for(const sandbox of [false,true])for(const [command,kind]of [['rm -rf backups','card'],['echo ok','run']] as const)it(`W4 SDK acceptEdits Bash reaches wipe decision (sandbox=${sandbox}): ${command}`,async()=>{
 ensureDirs();chmodSync(cli,0o755);
 process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS='1';if(sandbox)process.env.FAKE_CLAUDE_SDK_SANDBOX='1';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command});
 const f=fixture(),cwd=fixtureBotFolder();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Wipe'}),executionContext:()=>({cwd,project:cwd})});
 instance=await ClaudeDriver.create({instanceId:'p',displayName:'Fixture',environment:{},enabled:true,config:{cli,permissionMode:'acceptEdits'}});
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
  expect(outcomes).toEqual([kind]);
  const requests=recorder.events.filter(event=>event.type==='request.opened');expect(requests).toHaveLength(1);
 }finally{off();recorder.stop();f.dispose();}
},60000);
