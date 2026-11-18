// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner SDK hook consumer: c3-nl-b. Owner checker: wipe-fable.
import {admittedFixtureInstance} from '../testing/mcp-admission-fixture.ts';
import {chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {useOutsideStoreFixture} from '../testing/outside-store-fixture.ts';
import {ClaudeDriver} from './claude.ts';
import {recordEvents} from '../testing/events.ts';
import {fixtureBotFolder} from '../testing/bot-folder-fixture.ts';
import {ensureDirs} from '../config.ts';
import {d,fixture,baseRun} from '../decision/fixture.ts';
import type {ProviderInstance} from '../contracts.ts';
vi.mock('node:child_process',async original=>(await import('../testing/exec-check-spy.ts')).withExecCheckSpy(await original()));
const recovery=vi.hoisted(()=>({decisions:[] as string[],envs:[] as unknown[]}));
vi.mock('./claude-bash-hook.ts',async original=>{
 const actual=await original<typeof import('./claude-bash-hook.ts')>();
 return {...actual,relayClaudeBash:async(...args:Parameters<typeof actual.relayClaudeBash>)=>{
  // Break only the transport: use the production callback and recovery scanner.
  args[0]+='-transport-failed';
  const context=typeof args[3]==='function'?args[3]():args[3];recovery.envs.push(context?.env);
  const result=await actual.relayClaudeBash(...args);
  recovery.decisions.push((result.hookSpecificOutput as any).permissionDecision);return result;
 }};
});
useOutsideStoreFixture();
const cli=fileURLToPath(new URL('../testing/fake-claude-cli.ts',import.meta.url));
let instance:ProviderInstance|undefined;
afterEach(async()=>{await instance?.dispose();instance=undefined;vi.unstubAllEnvs();});
for(const wipe of [false,true])it(`SDK Bash recovery uses this engine's handed environment (wipe=${wipe})`,async()=>{
 ensureDirs();chmodSync(cli,0o755);recovery.decisions=[];recovery.envs=[];
 vi.stubEnv('FAKE_CLAUDE_SDK_ACCEPT_EDITS','1');
 vi.stubEnv('FAKE_CLAUDE_PERM_INPUT',JSON.stringify({command:'rm -rf "$HOOK_BUILD_DIR"/*'}));
 const f=fixture(),cwd=fixtureBotFolder(),value=wipe?'/':cwd+'/build';
 // Distinct server value proves that the engine's hand wins.
 vi.stubEnv('HOOK_BUILD_DIR',wipe?cwd+'/build':'/');
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Wipe'}),executionContext:()=>({cwd,project:cwd})});
 instance=await admittedFixtureInstance(ClaudeDriver.create({instanceId:'p',displayName:'Fixture',environment:{HOOK_BUILD_DIR:value},enabled:true,config:{cli,permissionMode:'acceptEdits'}}));
 const recorder=recordEvents(instance.adapter),outcomes:string[]=[];
 const off=instance.adapter.onEvent(event=>{
  if(event.type==='turn.started')f.setTurn(event.turnId!);
  if(event.type!=='request.opened')return;
  f.publish({...event,providerInstanceId:'p'});
  const outcome=d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!}),baseRun);outcomes.push(outcome.kind);
  void instance!.adapter.respondToRequest('t',event.requestId!,{behavior:'deny'});
 });
 try{
  await instance.adapter.sendTurn({threadId:'t',cwd,text:'__fixture_permission_tool__',noLimits:true,stopLine:true,routeAsks:true});
  await recorder.until(event=>event.type==='turn.completed',45000);
  expect(recovery.envs).toEqual([expect.objectContaining({HOOK_BUILD_DIR:value})]);
  expect(outcomes).toEqual(wipe?['card']:[]);
  expect(recovery.decisions).toEqual([wipe?'deny':'allow']);
 }finally{off();recorder.stop();f.dispose();}
},60000);
