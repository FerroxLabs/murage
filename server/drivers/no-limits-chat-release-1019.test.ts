// SPDX-License-Identifier: AGPL-3.0-or-later
// Fake completion stream; real stdio MCP client and production tool loop.
import {existsSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {fixture,d,baseRun} from '../decision/fixture.ts';
import {removeTempDir} from '../testing/cleanup.ts';
import {recordEvents} from '../testing/events.ts';
import {createOpenAIChatRuntime} from './openai-chat.ts';
import type {RequestAnswerOptions,RequestDelivery,RuntimeEvent} from '../contracts.ts';
const server=String.raw`
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 else if(m.method==='tools/list')send(m.id,{tools:[{name:'write_file',description:'Fixture only; records arguments without writing.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path']}}]});
 else if(m.method==='tools/call'){appendFileSync(process.env.NLSYM_LOG,JSON.stringify({...m.params,cwd:process.cwd()})+'\n');send(m.id,{content:[{type:'text',text:'fake-only'}]});}
});
`;
async function run(changed:boolean,afterConsumption:boolean,approve=false,relative=false){
 const root=mkdtempSync(join(tmpdir(),'nlsym-chat-'));mkdirSync(join(root,'out'));const target=join(root,'out','notes'),log=join(root,'calls.ndjson'),cli=join(root,'mcp.mjs');writeFileSync(cli,server);
 const f=fixture();let generationTurn='',round=0;const oldFetch=globalThis.fetch;
 const frame=(delta:unknown,finish_reason?:string)=>`data: ${JSON.stringify({choices:[{delta,...(finish_reason?{finish_reason}:{})}]})}\n\n`;
 globalThis.fetch=(async()=>new Response(++round===1?frame({tool_calls:[{index:0,id:'call',type:'function',function:{name:'fixture_write_file',arguments:JSON.stringify({path:relative?'out/notes':target,content:'fake-only'})}}]},'tool_calls')+'data: [DONE]\n\n':frame({content:'fake complete'},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
 const instance=createOpenAIChatRuntime({input:{instanceId:'p',displayName:'Fixture',enabled:true,environment:{},config:{}},driverKind:'fixture-chat',apiKey:'fixture-only',apiUrl:'https://fixture.invalid/v1',models:()=>({default:'fixture',options:[{id:'fixture',label:'Fixture'}]}),requestBody:(model,messages,stream)=>({model,messages,stream}),httpErrorLabel:'Fixture',missingKeyError:'fixture',unavailableReason:'fixture',nativeLog:{source:'fixture.chat',outgoing:(_turn,messages,model)=>({model,messages}),incoming:({text})=>({text})},timeoutMs:10000});
 const recorder=recordEvents(instance.adapter),offs:Array<()=>void>=[];let crossed=false;
 try{
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',initiator:{k:'owner-typed'},roomOwnerOnly:true,at:1}),live:()=>({botId:'b',turnId:generationTurn,providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
  offs.push(d.installRequestIngress({subscribe:fn=>instance.adapter.onEvent(event=>{if(event.type==='turn.started')generationTurn=event.turnId??'';fn({...event,providerInstanceId:'p'});})}));
  const cardOpened=new Promise<void>(resolve=>offs.push(f.store.onChange(()=>{if(d.openApprovals('t').length)resolve();})));
  const deliveries:Promise<void>[]=[],opened:RuntimeEvent[]=[];
  d.installDecisionTransport({interrupt:async()=>{},respond:async(identity,answer,options)=>{
   if(!crossed){crossed=true;if(changed&&!afterConsumption)symlinkSync('/etc/hosts',target);}
   return (instance.adapter.respondToRequest as unknown as (t:string,r:string,a:typeof answer,o:Readonly<RequestAnswerOptions>)=>Promise<RequestDelivery>)(identity.threadId,identity.requestId,answer,options);
  }});
  let rebound=false;
  offs.push(instance.adapter.onEvent(event=>{
   if(event.type==='item.started'&&event.itemType==='tool'&&changed&&afterConsumption&&!rebound){rebound=true;symlinkSync('/etc/hosts',target);}
   if(event.type!=='request.opened')return;opened.push(event);expect(existsSync(log)).toBe(false);
   const h=d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!});expect(d.decide(h,baseRun)).toEqual({kind:'run'});deliveries.push(d.deliverRequest(h));
  }));
  const sent=await instance.adapter.sendTurn({threadId:'t',cwd:root,text:'fake-only',stopLine:true,noLimits:true,permissionNow:()=>d.readTurnPolicy({threadId:'t',generation:'g'})!.permission,integrations:{custom:{fixture:{command:process.execPath,args:[cli],env:{NLSYM_LOG:log}}}}});
  await recorder.until(event=>event.type==='request.opened',10000);await Promise.all(deliveries);
  await Promise.race([cardOpened,recorder.until(event=>event.type==='turn.completed'&&event.turnId===sent.turnId)]);
  expect(crossed).toBe(true);expect(opened).toHaveLength(1);
  if(changed){
   expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'deny',state:'open'}));expect(existsSync(log)).toBe(false);
   if(afterConsumption)expect(rebound).toBe(true);
   if(approve){await d.answerApproval(d.openApprovals('t')[0]!.ref,{behavior:'allow'});await recorder.until(event=>event.type==='turn.completed'&&event.turnId===sent.turnId);expect(readFileSync(log,'utf8').trim().split('\n')).toHaveLength(1);}
  }else{expect(d.openApprovals('t')).toEqual([]);const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(calls).toHaveLength(1);expect(calls[0].cwd).toBe(root);expect(calls[0].arguments.path).toBe(relative?'out/notes':target);}
 }finally{for(const off of offs)off();recorder.stop();await instance.dispose();globalThis.fetch=oldFetch;await removeTempDir(root);}
}
it.each([false,true])('C7 chat before answer consumption changed=%s',changed=>run(changed,false),30000);
it.each([false,true])('C7 chat after answer consumption before MCP invoke changed=%s',changed=>run(changed,true),30000);
it('C7 chat refreshed card can authorize the waiting exact MCP call',()=>run(true,true,true),30000);

it.each([false,true])('C2 relative MCP before answer consumption changed=%s',changed=>run(changed,false,false,true),30000);
it.each([false,true])('C2 relative MCP after answer consumption changed=%s',changed=>run(changed,true,false,true),30000);
it('C2 relative MCP fresh card authorizes the waiting call',()=>run(true,true,true,true),30000);
