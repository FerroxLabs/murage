// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated real server/driver/broker/proxy, with a fake, nonbillable CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../../scripts/control-murage.ts';
import { raiseLevel } from '../testing/raise-level.ts';
import { openSse, type SseRecorder } from '../testing/sse.ts';
import { OWNER_PERMISSION_REPLY_TOO_LARGE, PERMISSION_REPLY_TOO_LARGE } from '../permission-reply.ts';
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
 const {ClaudeDriver}=await import(${JSON.stringify(new URL('./claude.ts',import.meta.url).href)});
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
for(const scenario of ['large unchanged','small changed','oversize changed'] as const){
 it(`No limits managed 1000: ${scenario}`,async()=>{
  const cwd=join(fixture.info.dataDir,'fixture-repo');
  const {bot}=await api('POST','/api/bots',{name:scenario,modelSelection:{instanceId:'verification',model:'sonnet'}});
  await api('PATCH',`/api/bots/${bot.id}`,{cwd,computer:'off',browser:false,composio:false,autoReview:'off'});
  await raiseLevel(async(method,path,body)=>({status:200,body:await api(method,path,body)}),bot.id,{autoApprove:true,fullAccess:true,noLimits:true,acknowledgeNoLimits:true,acknowledgeLocalAuto:true});
  const target=join(cwd,scenario+'.txt');
  const input={file_path:target,content:scenario==='large unchanged'?'✓'.repeat(400*1024):'before'};
  const changed={...input,content:scenario==='oversize changed'?'changed'.repeat(10000):'approved ✓'};
  writeFileSync(join(cwd,'input.json'),JSON.stringify(input));
  // Every case supplies its original input or a real change; equal copies must be omitted.
  writeFileSync(join(cwd,'rewrite.json'),JSON.stringify(scenario==='large unchanged'?input:changed));
  try{
   await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__',threadId:bot.threadId});
   const waited=await runControlMurage(['wait','--bot',bot.id,'--timeout','10','--url',fixture.info.url]);
   const transcript=await runControlMurage(['messages','--bot',bot.id,'--limit','60','--url',fixture.info.url]);
   const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`);
   const publicEnds=stream.frames.map(frame=>frame.event??frame).filter(event=>event.threadId===bot.threadId&&event.type==='turn.completed');
   const current=(await api('GET',`/api/bots/${bot.id}`)).bot;
   console.info('fixture-terminal observed '+JSON.stringify({scenario,publicEnds:publicEnds.map(event=>({ok:event.ok,stopReason:event.stopReason})),busy:current.busy,activity:current.tasks?.find((task:any)=>task.threadId===bot.threadId)?.activity}));
   save(scenario+'.json',{waited,transcript,messages});
   const cards=messages.messages.filter((m:any)=>(m.card?.requestHandle||m.card?.requestId)&&!m.card.dismissed);
   if(scenario==='oversize changed'){
    // Sean's binding rule: No limits is a wipe check only, so an owner No limits bot gets no card.
    // The changed reply is not delivered, nothing is written, and the owner reads one plain sentence.
    // (A bot below No limits keeps the deny-only "reply too large" card: permission-reply-hold-1019.test.ts.)
    expect(waited).toMatchObject({status:'settled'});
    expect(cards).toEqual([]);
    expect(existsSync(target)).toBe(false);
    const texts=messages.messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').map((m:any)=>m.text);
    expect(texts.filter((t:string)=>t===OWNER_PERMISSION_REPLY_TOO_LARGE)).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('permission: allowed');
    expect(JSON.stringify(messages)).not.toContain('permission: failed');
    expect(JSON.stringify(messages)).not.toContain(PERMISSION_REPLY_TOO_LARGE);
   }else{
    expect(waited).toMatchObject({status:'settled'});expect(cards).toEqual([]);
    // Owner rule (hunt-redact2 prompt, MAIN 21:22Z GO of fix/1020-redact-acp-fable 832aa2ad61, supersedes the
    // REDACT-MD turn mask): the owner never sees «redacted» in their own thread; an oversize input is shortened
    // for display, never a turn mask. The 400 KiB input is still never shown whole, the reply is shown, and
    // execution still writes its original bytes.
    expect(JSON.stringify(messages)).not.toContain('«redacted»');
    if(scenario==='large unchanged')expect(JSON.stringify(messages)).not.toContain('✓'.repeat(32));
    expect(JSON.stringify(messages)).toContain('permission: allowed');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target,'utf8')).toBe(scenario==='large unchanged'?input.content:changed.content);
   }
  }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
 },60000);
}
