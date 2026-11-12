// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual provider transports plus S1 registration/automatic answer; only the
// engines and filesystem are fixtures. No tool input is executed.
import {Socket} from 'node:net';
import {gzipSync} from 'node:zlib';
import {protectedReferent} from '../testing/no-limits-a4-fixture.ts';
import {readFileSync} from 'node:fs';
import {extractInspectedOperation} from '../no-limits-operation.ts';
import {chmodSync,mkdirSync,mkdtempSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {expect,it,vi} from 'vitest';
import {fixture,d,baseRun} from '../decision/fixture.ts';
import {recordEvents} from '../testing/events.ts';
import {removeTempDir} from '../testing/cleanup.ts';
import type {ProviderInstance,RuntimeEvent,RequestAnswerOptions,RequestDelivery} from '../contracts.ts';
import {ClaudeDriver} from './claude.ts';
import {PiDriver} from './pi.ts';
import {AntigravityDriver} from './antigravity.ts';
import {MuseCodeDriver} from './muse-code.ts';
import {createAcpDriver} from './acp/core.ts';

const engines=['claude','pi','antigravity','acp','muse'] as const;
type Engine=typeof engines[number];
function allows(frame:any):boolean {
 if(frame?.t==='answer')return frame.behavior==='allow';
 if(frame?.type==='extension_ui_response')try{return JSON.parse(frame.value).allow===true;}catch{return frame.confirmed===true;}
 return frame?.decision==='allow'||frame?.result?.outcome?.optionId==='allow'||frame?.method==='approval/decide'&&['c-once'].includes(String(frame.params?.choiceId));
}
async function run(engine:Engine,changed:boolean,native:boolean,level:'full'|'unlimited'='unlimited',auto=false,approve=false){
 const scratch=mkdtempSync(join(tmpdir(),'nlsym-provider-')),out=join(scratch,'out'),target=join(out,'notes');mkdirSync(out);
 const command=`printf x > '${target}'`,log=join(scratch,'frames.ndjson');
 fixture(level);let instance:ProviderInstance|undefined;let turnId='';const offs:Array<()=>void>=[];
 const frames:unknown[]=[],rawFrames:string[]=[];
 const capture=(value:unknown)=>{try{const frame=JSON.parse(String(value));if(frame?.t==='answer'||frame?.type==='extension_ui_response'||frame?.decision==='allow'||frame?.decision==='deny'||frame?.id===900&&frame?.result||frame?.method==='approval/decide')rawFrames.push(String(value));if(allows(frame))frames.push(frame);}catch{}};
 const write=Socket.prototype.write,end=Socket.prototype.end;
 const writes=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){capture(args[0]);return write.apply(this,args as any);} as any);
 const ends=vi.spyOn(Socket.prototype,'end').mockImplementation(function(this:Socket,...args:any[]){capture(args[0]);return end.apply(this,args as any);} as any);
 const environment:Record<string,string>={HOME:scratch};
 let fake=fileURLToPath(new URL(engine==='acp'?'../testing/no-limits-acp-release.mjs':engine==='claude'?'../testing/fake-claude-cli.ts':engine==='pi'?'../testing/fake-pi-cli.ts':engine==='muse'?'../testing/fake-muse-cli.ts':'../testing/fake-agy-cli.ts',import.meta.url));chmodSync(fake,0o755);
 if(engine==='muse'){const custom=join(scratch,'fake-muse.ts');writeFileSync(custom,readFileSync(fake,'utf8').replace('toolName: \"shell\", rawArgs: \"{}\"','toolName: \"write_file\", rawArgs: JSON.stringify({path: \"out/notes\",content: \"fake-only\"})'));fake=custom;chmodSync(fake,0o755);}
 if(engine==='claude'){process.env.FAKE_CLAUDE_PERM_TOOL=native?'Write':'Bash';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify(native?{file_path:target,content:'fake-only'}:{command,cwd:scratch});}
 if(engine==='pi')Object.assign(environment,{FAKE_PI_MODE:'gate',FAKE_PI_COMMAND_LOG:log,FAKE_PI_GATE_CALL:JSON.stringify({tool:native?'write':'bash',input:native?{path:target,content:'fake-only'}:{command,cwd:scratch}})});
 if(engine==='antigravity'){process.env.FAKE_AGY_RUN_HOOKS='1';process.env.FAKE_AGY_TOOL_CALLS=JSON.stringify([native?{name:'write_to_file',args:{TargetFile:'out/notes',CodeContent:'fake-only'}}:{name:'run_command',args:{CommandLine:command,Cwd:scratch}}]);}
 if(engine==='muse')Object.assign(environment,{FAKE_MUSE_TURN:'approval',FAKE_MUSE_LOG:log,FAKE_MUSE_SUBJECT:JSON.stringify(native?{kind:'tool',toolName:'write_file'}:{kind:'shell',command,workspaceRoot:scratch})});
 if(engine==='acp')Object.assign(environment,{NLSYM_ACP_LOG:log,NLSYM_ACP_CALL:JSON.stringify({toolCallId:'exact',kind:native?'edit':'execute',rawInput:native?{path:target,content:'fake-only'}:{command,cwd:scratch},...(native?{locations:[{path:target}]}:{})})});
 const input={instanceId:'p',displayName:'Release fixture',enabled:true,environment,config:{cli:fake,fullAuto:auto,permissionMode:'default' as const}};
 let recorder:ReturnType<typeof recordEvents>|undefined;
 try{
  instance=engine==='acp'?await createAcpDriver({driverKind:'gemini',displayName:'ACP fixture',models:{default:'',options:[]},defaultCli:fake,nativeSource:'fixture.acp',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true}).create(input):await (engine==='claude'?ClaudeDriver:engine==='pi'?PiDriver:engine==='muse'?MuseCodeDriver:AntigravityDriver).create(input);
  recorder=recordEvents(instance.adapter);
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',initiator:{k:'owner-typed'},roomOwnerOnly:true,at:1}),live:()=>({botId:'b',turnId,providerInstanceId:'p',principal:'owner',owner:true,level})});
  offs.push(d.installRequestIngress({subscribe:fn=>instance!.adapter.onEvent(event=>{if(event.type==='turn.started')turnId=event.turnId??'';fn({...event,providerInstanceId:'p'});})}));
  let crossed=false;
  d.installDecisionTransport({interrupt:async()=>{},respond:async(deliveryTarget,answer,options)=>{
   if(!crossed){crossed=true;if(changed)symlinkSync(protectedReferent(),target);}
   return (instance!.adapter.respondToRequest as unknown as (t:string,r:string,a:typeof answer,o:Readonly<RequestAnswerOptions>)=>Promise<RequestDelivery>)(deliveryTarget.threadId,deliveryTarget.requestId,answer,options);
  }});
  const opened:RuntimeEvent[]=[];const deliveries:Promise<void>[]=[];
  offs.push(instance.adapter.onEvent(event=>{if(event.type!=='request.opened')return;opened.push(event);const h=d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!});expect(d.decide(h,baseRun)).toEqual({kind:'run'});deliveries.push(d.deliverRequest(h));}));
  await instance.adapter.sendTurn({threadId:'t',cwd:scratch,text:engine==='claude'?'__fixture_permission_tool__':'fake-only',routeAsks:true,stopLine:true,...(level==='unlimited'?{noLimits:true}:{}),permissionNow:()=>d.readTurnPolicy({threadId:'t',generation:'g'})!.permission});
  await recorder.until(event=>event.type==='request.opened');await Promise.all(deliveries);
  const directory='evidence/nlsym-A4/provider-cwd';mkdirSync(directory,{recursive:true});
  const first=opened[0] as Extract<RuntimeEvent,{type:'request.opened'}>|undefined;
  const exact=first?extractInspectedOperation({tool:first.toolCall?.name??first.tool??'',input:first.toolCall?.input,event:first} as any):undefined;
  writeFileSync(join(directory,`${process.env.NLSYM_PHASE??'GREEN'}-${engine}-${native?'native':'exec'}-${changed}${auto?'-auto':''}.json.gz`),gzipSync(JSON.stringify({engine,native,changed,level,crossed,exact,opened,frames,rawFrames,approvals:d.openApprovals('t'),events:recorder.events},null,2)));
  expect(crossed).toBe(true);expect(opened).toHaveLength(1);
  if(changed){
   expect(d.openApprovals('t')).toEqual([expect.objectContaining({why:'deny',state:'open'})]);
   expect(frames).toEqual([]);
   expect(recorder.events.filter(event=>event.type==='request.resolved'&&event.behavior==='allow')).toEqual([]);
   if(approve){await d.answerApproval(d.openApprovals('t')[0]!.ref,{behavior:'allow'});await recorder.until(event=>event.type==='turn.completed');expect(frames.length).toBeGreaterThan(0);expect(d.openApprovals('t')).toEqual([]);writeFileSync(join(directory,`${process.env.NLSYM_PHASE??'GREEN'}-${engine}-native-approved.json.gz`),gzipSync(JSON.stringify({engine,exact,opened,frames,rawFrames,approvals:d.openApprovals('t'),events:recorder.events},null,2)));}

  }else{
   await recorder.until(event=>event.type==='turn.completed');
   expect(d.openApprovals('t')).toEqual([]);
   expect(recorder.events).toContainEqual(expect.objectContaining({type:'request.resolved',behavior:'allow'}));
   expect(frames.length).toBeGreaterThan(0);
  }
 }finally{
  for(const off of offs)off();recorder?.stop();await instance?.dispose();writes.mockRestore();ends.mockRestore();
  for(const key of ['FAKE_CLAUDE_PERM_TOOL','FAKE_CLAUDE_PERM_INPUT','FAKE_AGY_RUN_HOOKS','FAKE_AGY_TOOL_CALLS'])delete process.env[key];
  await removeTempDir(scratch);
 }
}
it('CWD-4 real Antigravity relative native writer rechecks its turn cwd',()=>run('antigravity',true,true),30000);
it('CWD-4-run real Antigravity ordinary relative native write runs without card',()=>run('antigravity',false,true),30000);
it('CWD-5 real Muse args branch rechecks its turn cwd',()=>run('muse',true,true),30000);
it('CWD-5-run real Muse ordinary args branch runs without card',()=>run('muse',false,true),30000);
