// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual provider transports plus S1 registration/automatic answer; only the
// engines and filesystem are fixtures. No tool input is executed.
import {Socket} from 'node:net';
import {ServerResponse} from 'node:http';
import {gzipSync} from 'node:zlib';
import {extractInspectedOperation} from '../no-limits-operation.ts';
import {chmodSync,mkdirSync,mkdtempSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {fixture,d,baseRun} from '../decision/fixture.ts';
import {recordEvents} from '../testing/events.ts';
import {removeTempDir} from '../testing/cleanup.ts';
import type {ProviderInstance,RuntimeEvent,RequestAnswerOptions,RequestDelivery} from '../contracts.ts';
import {ClaudeDriver} from './claude.ts';
import {PiDriver} from './pi.ts';
import {AntigravityDriver} from './antigravity.ts';
import {MuseCodeDriver} from './muse-code.ts';
import {createAcpDriver} from './acp/core.ts';

afterEach(()=>vi.restoreAllMocks());
const engines=['claude','pi','antigravity','acp','muse'] as const;
type Engine=typeof engines[number];
const socketWrite=Socket.prototype.write,socketEnd=Socket.prototype.end,httpEnd=ServerResponse.prototype.end;
function allows(frame:any):boolean {
 if(frame?.t==='answer')return frame.behavior==='allow';
 if(frame?.type==='extension_ui_response')try{return JSON.parse(frame.value).allow===true;}catch{return frame.confirmed===true;}
 return frame?.decision==='allow'||frame?.result?.outcome?.optionId==='allow'||frame?.method==='approval/decide'&&['c-once'].includes(String(frame.params?.choiceId));
}
async function run(engine:Engine,changed:boolean,native:boolean,level:'full'|'unlimited'='unlimited',auto=false,wipeAtWriter=false,narrow=false,approve=false){
 const scratch=mkdtempSync(join(tmpdir(),'nlsym-provider-')),out=join(scratch,'out'),target=join(out,'notes');mkdirSync(out);
 const command=wipeAtWriter?'rm -rf /':`printf x > '${target}'`,log=join(scratch,'frames.ndjson');
 fixture(level);let instance:ProviderInstance|undefined;let turnId='';const offs:Array<()=>void>=[];
 const frames:unknown[]=[],rawFrames:string[]=[];
 const capture=(value:unknown)=>{try{const frame=JSON.parse(String(value));if(frame?.t==='answer'||frame?.type==='extension_ui_response'||frame?.decision==='allow'||frame?.decision==='deny'||frame?.id===900&&frame?.result||frame?.method==='approval/decide')rawFrames.push(String(value));if(allows(frame))frames.push(frame);}catch{}};
 const writes=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){capture(args[0]);return socketWrite.apply(this,args as any);} as any);
 const ends=vi.spyOn(Socket.prototype,'end').mockImplementation(function(this:Socket,...args:any[]){capture(args[0]);return socketEnd.apply(this,args as any);} as any);
 const httpEnds=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:any[]){capture(args[0]);return httpEnd.apply(this,args as any);} as any);
 const environment:Record<string,string>={HOME:scratch};
 const fake=fileURLToPath(new URL(engine==='acp'?'../testing/no-limits-acp-release.mjs':engine==='claude'?'../testing/fake-claude-cli.ts':engine==='pi'?'../testing/fake-pi-cli.ts':engine==='muse'?'../testing/fake-muse-cli.ts':'../testing/fake-agy-cli.ts',import.meta.url));chmodSync(fake,0o755);
 if(engine==='claude'){process.env.FAKE_CLAUDE_PERM_TOOL=native?'Write':'Bash';process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify(native?{file_path:target,content:'fake-only'}:{command,cwd:scratch});}
 if(engine==='pi')Object.assign(environment,{FAKE_PI_MODE:'gate',FAKE_PI_COMMAND_LOG:log,FAKE_PI_GATE_CALL:JSON.stringify({tool:native?'write':'bash',input:native?{path:target,content:'fake-only'}:{command,cwd:scratch}})});
 if(engine==='antigravity'){process.env.FAKE_AGY_RUN_HOOKS='1';process.env.FAKE_AGY_REPORT_STATE='DONE';process.env.FAKE_AGY_TOOL_CALLS=JSON.stringify([native?{name:'write_to_file',args:{TargetFile:target,CodeContent:'fake-only'}}:{name:'run_command',args:{CommandLine:command,Cwd:scratch}}]);}
 if(engine==='muse')Object.assign(environment,{FAKE_MUSE_TURN:'approval',FAKE_MUSE_LOG:log,FAKE_MUSE_SUBJECT:JSON.stringify(native?{kind:'fileAccess',access:'write',path:target,workspaceRoot:scratch}:{kind:'shell',command,workspaceRoot:scratch})});
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
   if(!crossed){crossed=true;if(changed)symlinkSync('/etc/hosts',target);}
   if(narrow)answer={...answer,updatedInput:{command:'printf narrower',cwd:scratch}};
   return (instance!.adapter.respondToRequest as unknown as (t:string,r:string,a:typeof answer,o:Readonly<RequestAnswerOptions>)=>Promise<RequestDelivery>)(deliveryTarget.threadId,deliveryTarget.requestId,answer,options);
  }});
  const opened:RuntimeEvent[]=[];const deliveries:Promise<void>[]=[];
  offs.push(instance.adapter.onEvent(event=>{if(event.type!=='request.opened')return;opened.push(event);const h=d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!});const outcome=d.decide(h,baseRun);expect(outcome.kind).toBe(wipeAtWriter?'card':'run');deliveries.push(wipeAtWriter&&!approve?(async()=>{await instance!.adapter.respondToRequest('t',event.requestId!,{behavior:'allow'});})():d.deliverRequest(h));}));
  await instance.adapter.sendTurn({threadId:'t',cwd:scratch,text:engine==='claude'?'__fixture_permission_tool__':'fake-only',routeAsks:true,stopLine:true,...(level==='unlimited'?{noLimits:true}:{}),permissionNow:()=>d.readTurnPolicy({threadId:'t',generation:'g'})!.permission});
  if(level==='full'&&engine==='claude'){
   // The legacy Claude Full access path auto-answers this native edit before S1.
   // Require the native tool and terminal witnesses rather than inventing a broker ask.
   await recorder.until(event=>event.type==='turn.completed');
   expect(opened).toHaveLength(0);expect(crossed).toBe(false);expect(d.openApprovals('t')).toEqual([]);
   expect(recorder.events).toContainEqual(expect.objectContaining({type:'item.completed',itemType:'tool',ok:true}));
   return;
  }
  await recorder.until(event=>event.type==='request.opened');await Promise.all(deliveries);
  const directory='evidence/nlsym-build-C2/provider-frames';mkdirSync(directory,{recursive:true});
  const first=opened[0] as Extract<RuntimeEvent,{type:'request.opened'}>|undefined;
  const exact=first?extractInspectedOperation({tool:first.toolCall?.name??first.tool??'',input:first.toolCall?.input,event:first} as any):undefined;
  writeFileSync(join(directory,`${process.env.NLSYM_PHASE??'GREEN'}-${engine}-${level}-${native?'native':'exec'}-${changed}${auto?'-auto':''}${wipeAtWriter?'-wipe':''}${narrow?'-narrow':''}.json.gz`),gzipSync(JSON.stringify({engine,native,changed,level,crossed,exact,opened,frames,rawFrames,approvals:d.openApprovals('t'),events:recorder.events},null,2)));
  expect(crossed).toBe(!wipeAtWriter);expect(opened).toHaveLength(1);
  if(wipeAtWriter){
   expect(d.openApprovals('t')).toEqual([expect.objectContaining({why:'wipe',state:'open'})]);
   expect(frames).toEqual([]);
   expect(recorder.events.filter(event=>event.type==='request.resolved'&&event.behavior==='allow')).toEqual([]);
   if(approve){
    const approval=d.openApprovals('t')[0]!;
    await d.answerApproval(approval.ref,{behavior:'allow'});
    await recorder.until(event=>event.type==='turn.completed');
    expect(crossed).toBe(true);expect(opened).toHaveLength(1);expect(opened[0]!.requestId).toBe(first!.requestId);
    expect(frames.length).toBeGreaterThan(0);expect(d.openApprovals('t')).toEqual([]);
    expect(recorder.events).toContainEqual(expect.objectContaining({type:'request.resolved',requestId:first!.requestId,behavior:'allow'}));
    expect(d.readApproval(approval.ref.approvalId)).toMatchObject({state:'answered'});
    writeFileSync(join(directory,`${process.env.NLSYM_PHASE??'GREEN'}-${engine}-wipe-approved.json.gz`),gzipSync(JSON.stringify({engine,exact,opened,frames,rawFrames,approval:d.readApproval(approval.ref.approvalId),events:recorder.events},null,2)));
   }

  }else if(narrow&&level==='full'){
   await recorder.until(event=>event.type==='turn.completed');expect(frames).toEqual([]);expect(d.openApprovals('t')).toEqual([]);
   expect(recorder.events).toContainEqual(expect.objectContaining({type:'request.resolved',behavior:'deny'}));
  }else{
   await recorder.until(event=>event.type==='turn.completed');
   expect(d.openApprovals('t')).toEqual([]);
   if(level==='full'&&engine==='muse'){
    // Legacy Muse may complete before its resolved callback; freeze the actual one-use native decision.
    expect(frames).toContainEqual(expect.objectContaining({method:'approval/decide',params:expect.objectContaining({choiceId:'c-once'})}));
   }else expect(recorder.events).toContainEqual(expect.objectContaining({type:'request.resolved',behavior:'allow'}));
   expect(frames.length).toBeGreaterThan(0);
  }
 }finally{
  for(const off of offs)off();recorder?.stop();writes.mockRestore();ends.mockRestore();httpEnds.mockRestore();
  try{await instance?.dispose();}finally{
  for(const key of ['FAKE_CLAUDE_PERM_TOOL','FAKE_CLAUDE_PERM_INPUT','FAKE_AGY_RUN_HOOKS','FAKE_AGY_TOOL_CALLS','FAKE_AGY_REPORT_STATE'])delete process.env[key];
  await removeTempDir(scratch);
  }
 }
}
for(const engine of engines)for(const native of [false,true])it.each([false,true])(`C7 ${engine} ${native?'native':'exec'} changed=%s`,changed=>run(engine,changed,native),30000);
it('C7 ACP fullAuto still registers owner No limits permission',()=>run('acp',true,false,'unlimited',true),30000);

for(const engine of engines)it(`C7 ${engine} a visible wipe cannot be bypassed at the native writer`,()=>run(engine,false,false,'unlimited',false,true),30000);
for(const engine of engines)it(`C7 ${engine} Full access preserves its native release path`,()=>run(engine,true,true,'full'),30000);
for(const engine of engines)it(`C7 ${engine} refreshed native card can release the same waiting ask after exact wipe review`,()=>run(engine,false,false,'unlimited',false,true,false,true),30000);
it('C7 Antigravity non-wipe updated input cannot deny owner No limits work',()=>run('antigravity',false,false,'unlimited',false,false,true),30000);
it('C7 Antigravity Full access retains its narrower-input refusal',()=>run('antigravity',false,false,'full',false,false,true),30000);

it.each([false,true])('C7 ACP host action final callback changed=%s',async changed=>{
 const root=mkdtempSync(join(tmpdir(),'nlsym-host-'));mkdirSync(join(root,'out'));const target=join(root,'out','notes'),cli=fileURLToPath(new URL('../testing/no-limits-acp-release.mjs',import.meta.url));chmodSync(cli,0o755);
 fixture();let turnId='';const instance=await createAcpDriver({driverKind:'gemini',displayName:'Host fixture',models:{default:'',options:[]},defaultCli:cli,nativeSource:'fixture.host',loginNote:'fixture',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,hostComputerAskedByMurage:true}).create({instanceId:'p',displayName:'Host fixture',enabled:true,environment:{NLSYM_ACP_HOLD:'1'},config:{cli,fullAuto:false}});
 const recorder=recordEvents(instance.adapter),offs:Array<()=>void>=[];let allowed=false;
 try{
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',initiator:{k:'owner-typed'},roomOwnerOnly:true,at:1}),live:()=>({botId:'b',turnId,providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
  offs.push(d.installRequestIngress({subscribe:fn=>instance.adapter.onEvent(event=>{if(event.type==='turn.started')turnId=event.turnId??'';fn({...event,providerInstanceId:'p'});})}));
  d.installDecisionTransport({interrupt:async()=>{},respond:async(identity,answer,options)=>{if(changed)symlinkSync('/etc/hosts',target);return (instance.adapter.respondToRequest as any)(identity.threadId,identity.requestId,answer,options);}});
  const deliveries:Promise<void>[]=[];offs.push(instance.adapter.onEvent(event=>{if(event.type!=='request.opened')return;const h=d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!});expect(d.decide(h,baseRun)).toEqual({kind:'run'});deliveries.push(d.deliverRequest(h));}));
  await instance.adapter.sendTurn({threadId:'t',cwd:root,text:'fake-only',stopLine:true,noLimits:true,permissionNow:()=>d.readTurnPolicy({threadId:'t',generation:'g'})!.permission,integrations:{localComputer:{command:process.execPath,args:['/fake/never-executed.mjs'],env:{},platform:'linux',scope:'local-computer'}}});
  await recorder.until(event=>event.type==='content.delta');
  const result=instance.adapter.askHostAction!('t',{name:'write_file',arguments:{path:target,content:'fake-only'}}).then(answer=>{allowed=answer==='allow';return answer;});
  await recorder.until(event=>event.type==='request.opened');await Promise.all(deliveries);
  expect(await result).toBe('allow');expect(allowed).toBe(true);expect(d.openApprovals('t')).toEqual([]);
  mkdirSync('evidence/nlsym-build-C2/provider-frames',{recursive:true});writeFileSync(`evidence/nlsym-build-C2/provider-frames/${process.env.NLSYM_PHASE??'GREEN'}-acp-host-${changed}.json.gz`,gzipSync(JSON.stringify({changed,allowed,approvals:d.openApprovals('t'),events:recorder.events},null,2)));
 }finally{for(const off of offs)off();recorder.stop();await instance.dispose();await removeTempDir(root);}
},30000);
