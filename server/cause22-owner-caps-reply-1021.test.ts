// SPDX-License-Identifier: AGPL-3.0-or-later
// cause22 caps r3 (ASTRA 2724 on 2271914b37): a permission reply over a size cap denies that ONE request; it never ends the owner's turn.
// One table, one row per reply cap that used to end the turn. Real server, driver, broker, decision layer and permission proxy,
// with a fake, nonbillable CLI whose managed settings (a virtual file) cap a permission reply at 1000.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { openSse, type SseRecorder } from './testing/sse.ts';
import { OWNER_PERMISSION_REPLY_TOO_LARGE, PERMISSION_REPLY_TOO_LARGE } from './permission-reply.ts';
let fixture: VerificationServer, headers: Record<string,string>, stream: SseRecorder;
const commands: unknown[]=[];
const evidence=process.env.GNL_ENGINE_EVIDENCE;
function save(name:string,value:unknown){if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,name),JSON.stringify(value,null,2)+'\n');}}
async function api(method:string,path:string,body?:unknown):Promise<any>{
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();commands.push({method,path,body,status:response.status,result});expect(response.ok,JSON.stringify(result)).toBe(true);return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
 const fs=await import('node:fs'); const path=await import('node:path');
 const originalError=console.error;
 console.error=(...args)=>{if(args[0]==='bus: listener threw')console.info('fixture-terminal fold-error '+args[1]?.name+' '+args[1]?.message);originalError(...args);};
 (await import('node:module')).registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url.endsWith('/server/index.ts'))result.source=String(result.source)
   .replace('const foldRuntimeEvent = (event: RuntimeEvent) => {', 'const foldRuntimeEvent = (event: RuntimeEvent) => { if(event.type==="turn.completed")console.info("fixture-terminal fold reached verdicts="+[...admittedLedgerLeases.values()].filter(l=>l.providerTurnId===event.turnId).map(l=>Boolean(l.verdict)).join(","));')
   .replace('case "turn.completed": {','case "turn.completed": { console.info("fixture-terminal fold admitted");');
  return result;
 }});
 const root=path.join(process.env.MURAGE_DATA_DIR,'fixture-repo');fs.mkdirSync(root,{recursive:true});
 // Virtual managed file: the fixture never writes the machine's policy.
 const original=fs.default.readFileSync;
 fs.default.readFileSync=function(file,...rest){
  if(String(file)==='/etc/claude-code/managed-settings.json')return JSON.stringify({env:{MAX_MCP_OUTPUT_TOKENS:'1000'}});
  return original.call(this,file,...rest);
 };
 (await import('node:module')).syncBuiltinESMExports();
 const {ClaudeDriver}=await import(${JSON.stringify(new URL('./drivers/claude.ts',import.meta.url).href)});
 const create=ClaudeDriver.create.bind(ClaudeDriver);
 ClaudeDriver.create=async(...args)=>{
  const instance=await create(...args);
  instance.adapter.onEvent(event=>{if(event.type==='turn.completed')console.info('fixture-terminal driver completed '+event.ok+' '+event.stopReason);});
  const adapter=instance.decisionAdapter;
  return {...instance,decisionAdapter:{...adapter,respondToRequest:(t,r,answer,options)=>{
   const file=path.join(root,'rewrite.json');
   return adapter.respondToRequest(t,r,answer.behavior==='allow'&&fs.existsSync(file)?{...answer,updatedInput:JSON.parse(fs.readFileSync(file,'utf8'))}:answer,options);
  }}};
 };
 process.env.FAKE_CLAUDE_PERM_TOOL='Write';process.env.FAKE_CLAUDE_PERM_WRITE='1';
 process.env.FAKE_CLAUDE_MANAGED_PERMISSION_LIMIT='1000';
 process.env.FAKE_CLAUDE_PERM_INPUT_FILE=path.join(root,'input.json');
 `});
 save('fixture-launch.json',fixture.info);
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
 stream=await openSse(fixture.info.url+'/api/events',headers);
 const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);save('doctor.json',doctor);expect(doctor).toMatchObject({ok:true});
},120000);
afterAll(async()=>{try{if(fixture)console.info(readFileSync(fixture.info.logPath,'utf8').split('\n').filter(line=>/fixture-terminal|direct-teardown|direct-stop|claude close/.test(line)).join('\n'));save('commands.json',commands);if(evidence&&fixture&&existsSync(fixture.info.logPath))writeFileSync(join(evidence,'server.log'),readFileSync(fixture.info.logPath));}finally{stream?.close();await fixture?.close();}});
type Row={hop:string;control?:true;changed:(input:{file_path:string;content:string})=>{file_path:string;content:string}};
const HOPS:Row[]=[
 // control (passes on the base): a changed allow that fits is delivered and the tool runs
 {hop:'control: a changed allow under the managed output cap is delivered',control:true,changed:input=>({...input,content:'approved ✓'})},
 // server/drivers/claude.ts allowFits (managed MAX_MCP_OUTPUT_TOKENS) -> respondToRequest -> server/decision/implementation.ts send()
 {hop:'claude changed allow over the managed output cap (drivers/claude.ts allowFits -> decision send)',changed:input=>({...input,content:'changed'.repeat(10000)})},
];
it.each(HOPS)('owner No limits turn, $hop',async({hop,control,changed})=>{
 const cwd=join(fixture.info.dataDir,'fixture-repo');
 const {bot}=await api('POST','/api/bots',{name:control?'reply control':'reply over cap',modelSelection:{instanceId:'verification',model:'sonnet'}});
 await api('PATCH',`/api/bots/${bot.id}`,{cwd,computer:'off',browser:false,composio:false,autoReview:'off'});
 await raiseLevel(async(method,path,body)=>({status:200,body:await api(method,path,body)}),bot.id,{autoApprove:true,fullAccess:true,noLimits:true,acknowledgeNoLimits:true,acknowledgeLocalAuto:true});
 const target=join(cwd,(control?'control':'over-cap')+'.txt');
 const input={file_path:target,content:'before'};
 writeFileSync(join(cwd,'input.json'),JSON.stringify(input));
 writeFileSync(join(cwd,'rewrite.json'),JSON.stringify(changed(input)));
 try{
  await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__',threadId:bot.threadId});
  const waited=await runControlMurage(['wait','--bot',bot.id,'--timeout','10','--url',fixture.info.url]);
  const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`);
  const ends=stream.frames.map(frame=>frame.event??frame).filter(event=>event.threadId===bot.threadId&&event.type==='turn.completed').map(event=>({ok:event.ok,stopReason:event.stopReason}));
  const texts:string[]=messages.messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').map((m:any)=>m.text);
  save(hop.replace(/[^a-z]+/gi,'-')+'.json',{waited,messages,ends});
  expect(waited,hop).toMatchObject({status:'settled'});
  if(control){
   expect(ends,"the control turn ends on the engine's own end_turn").toEqual([{ok:true,stopReason:'end_turn'}]);
   expect(existsSync(target)&&readFileSync(target,'utf8'),"the control's changed input is what the tool wrote").toBe('approved ✓');
   expect(texts,"the control shows no too-large line").not.toContain(OWNER_PERMISSION_REPLY_TOO_LARGE);
   return;
  }
  expect(ends,"a permission reply over the cap does not interrupt the owner's turn: the engine ends it itself").toEqual([{ok:true,stopReason:'end_turn'}]);
  expect(texts.filter(text=>/^permission: /.test(text)),"the engine read a deny for that one request and went on").toEqual(['permission: denied']);
  expect(texts.filter(text=>text===OWNER_PERMISSION_REPLY_TOO_LARGE),"the owner reads the fixed too-large line once").toHaveLength(1);
  expect(existsSync(target),"nothing was written: the changed input never reached the tool").toBe(false);
  expect(messages.messages.filter((m:any)=>(m.card?.requestHandle||m.card?.requestId)&&!m.card.dismissed),"No limits raises no card").toEqual([]);
  expect(JSON.stringify(messages),"the below-No-limits card line is never shown to the owner").not.toContain(PERMISSION_REPLY_TOO_LARGE);
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
},60000);
