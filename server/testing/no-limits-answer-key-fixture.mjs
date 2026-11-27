// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: tri3-g3; decision/HTTP boundary owner: tri3-g2.
// Real HTTP route in a control-murage-owned isolated profile; fake CLI only.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,symlinkSync,unlinkSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {launchVerificationServer,runControlMurage} from '../../scripts/control-murage.ts';
import {ProductClient} from '../../scripts/no-limits-live/run.mjs';
import {promptPlan} from '../../scripts/no-limits-live/baseline-f-plan.mjs';
import {projectReferents} from '../../server/testing/no-limits-a4-fixture.ts';
const directory=process.env.A4_KEY_DIR??mkdtempSync(join(tmpdir(),'a4-keys-'));mkdirSync(directory,{recursive:true});
const evidence={scope:'isolated fake engine and queue; HTTP response boundary; no submitted tool executes',commands:[],rows:{}};
let fixture,client;
try{
 const cli=resolve('server/testing/no-limits-answer-key-fake-cli.mjs'),decision=pathToFileURL(resolve('server/decision/index.ts')).href,telegram=pathToFileURL(resolve('server/telegram-approvals.ts')).href;
 const instrumentation=`import {readFileSync,writeFileSync,existsSync,unlinkSync,appendFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {registerHooks} from 'node:module';import * as d from ${JSON.stringify(decision)};import {durableChannelApproval} from ${JSON.stringify(telegram)};
const data=process.env.MURAGE_DATA_DIR,cfgPath=join(data,'config.json'),cfg=JSON.parse(readFileSync(cfgPath,'utf8'));cfg.instances.verification.config.cli=${JSON.stringify(cli)};cfg.instances.verification.environment={BASE_F_LOG:join(data,'native.ndjson')};writeFileSync(cfgPath,JSON.stringify(cfg));
// Test-only hook clears the fixture's volatile map and observes durable lookups.
// No persisted request, decision, or production source file is replaced.
globalThis.__a4Lookups=[];registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url.endsWith('/server/index.ts')){const source=String(r.source),anchor='const askMessageByRequest = new Map<string, string>();';if(!source.includes(anchor))throw Error('map hook anchor missing');return {...r,source:source.replace(anchor,anchor+'globalThis.__a4Store=store;globalThis.__a4ClearAsks=()=>askMessageByRequest.clear();').replace('const remove = installQueueSources([{ ...port,','const remove = globalThis.__a4InstallQueues([{ ...port,').replace('function cardByRequest(', 'function __a4CardByRequest(')+'\\nfunction cardByRequest(...args){const result=__a4CardByRequest(...args);globalThis.__a4Lookups.push({threadId:args[0],requestId:args[1],id:result?.id,answered:result?.card?.answered});return result;}'};}return r;}});
globalThis.__a4QueueOff=new Map();globalThis.__a4InstallQueues=sources=>{const off=d.installQueueSources(sources);for(const s of sources)globalThis.__a4QueueOff.set(s.kind,off);return off;};
const refs=new Map();let serviceOff;
setInterval(async()=>{const p=join(data,'a4-command.json');if(!existsSync(p))return;const command=JSON.parse(readFileSync(p,'utf8'));unlinkSync(p);let result;
try{const open=()=>d.openApprovals(command.threadId);if(command.kind==='inspect'){result={open:open(),oldRef:refs.has(command.refKey),lookups:globalThis.__a4Lookups};}
if(command.kind==='capture'){const row=open()[0];refs.set(command.refKey,row.ref);result={row,mirror:{id:row.chatMessageId,approvalId:row.ref.approvalId,requestRef:row.requestId,actionHash:row.actionHash,fingerprint:'fixture',summary:'fixture'}};}
if(command.kind==='clear'){globalThis.__a4ClearAsks();globalThis.__a4Lookups=[];result={cleared:true};}
if(command.kind==='old-ref'){try{result={outcome:await d.answerApproval(refs.get(command.refKey),{behavior:'allow'})};}catch(error){result={error:String(error)};}result.open=open();}
if(command.kind==='mirror'){result={valid:durableChannelApproval(command.mirror),open:open()};}
if(command.kind==='service'){
 // Use the HTTP server's Store: a second Store has a separate loaded-thread cache
 // and hides the refreshed terminal card from the real response route.
 globalThis.__a4QueueOff.get('mcp')?.();serviceOff?.();const s=globalThis.__a4Store;if(!s)throw Error('fixture server store missing');d.installDecisionHost({store:s,view:()=>({title:'A4 service',subtitle:'Queue fixture'})});d.installProvenanceReader({turnGenerationFor:()=> 'a4g',provenance:()=>({generation:'a4g',threadId:command.threadId,botId:command.botId,principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}),live:()=>({botId:command.botId,turnId:'a4turn',providerInstanceId:'verification',principal:'owner',owner:true,level:'unlimited'})});
 const claim=d.installClaimVerifier(proof=>proof==='a4proof'?{threadId:command.threadId,botId:command.botId,generation:'a4g'}:undefined)('a4proof');
 const call={tool:'Bash',input:{command:command.deleteCommand,cwd:command.cwd},approval:{queueRef:'q-A4',epoch:'a4e',action:{requestId:'q-A4',tool:'Bash',options:['Allow','Deny']}}};
 const handle=d.openRequest({kind:'service',service:'mcp',claim,call}),outcome=d.decide(handle,()=>({approve:'BASE',source:'auto-mode'}));if(outcome.kind!=='card')throw Error('service expected card '+JSON.stringify(outcome));
 let item={kind:'mcp',approvalId:outcome.ref.approvalId,ref:'q-A4',epoch:'a4e',call,view:{title:'A4 service',subtitle:'Queue fixture'},proof:'a4proof'};
 serviceOff=d.installQueueSources([{kind:'mcp',pendingApprovals:()=>[item],base:()=>({approve:'BASE',source:'auto-mode'}),reopen:current=>({kind:'service',service:'mcp',claim,call:current.call}),respond:async()=>{appendFileSync(join(data,'service-deliveries.ndjson'),JSON.stringify({released:true})+'\\n');return {state:'accepted'};},cancel:async()=>{},renew:async(_current,identity)=>{item={...item,...identity,call:{...item.call,approval:{...item.call.approval,epoch:identity.epoch}}};return item;}}]);
 d.attachQueue(outcome.ref,{kind:'mcp',ref:'q-A4',call});await d.presentApproval(outcome.ref,item.view);result={open:open()};
}
}catch(error){result={fixtureError:String(error.stack??error)};}writeFileSync(join(data,'a4-result.tmp'),JSON.stringify(result));renameSync(join(data,'a4-result.tmp'),join(data,'a4-result.json'));},10).unref();`;
 fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,instrumentationSource:instrumentation,env:{PATH:'/usr/local/bin:/usr/bin:/bin'}});evidence.launch=fixture.info;
 const env={...process.env,MURAGE_DATA_DIR:fixture.info.dataDir};
 const control=async args=>{const argv=[...args,'--url',fixture.info.url],result=await runControlMurage(argv,{env});evidence.commands.push({argv,result});return result;};
 assert.equal((await control(['doctor'])).ok,true);
 const secret=(await (await fetch(fixture.info.url+'/api/desktop-secret')).json()).secret;
 client=new ProductClient(fixture.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},fixture.info.dataDir,30000);await client.connect();
 const command=async value=>{const output=join(fixture.info.dataDir,'a4-result.json');if(existsSync(output))unlinkSync(output);const input=join(fixture.info.dataDir,'a4-command.json');writeFileSync(input+'.tmp',JSON.stringify(value));renameSync(input+'.tmp',input);const until=Date.now()+10000;while(!existsSync(output)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));const result=JSON.parse(readFileSync(output,'utf8'));assert.equal(result.fixtureError,undefined,JSON.stringify(result));return result;};
 const wait=async bot=>{const until=Date.now()+30000;let state;do{state=await control(['wait','--bot',bot.id,'--timeout','2']);if(['settled','needs-user','failed'].includes(state.status))break;}while(Date.now()<until);return state;};
 const cards=async bot=>(await client.api('GET',`/api/threads/${bot.threadId}/open-cards`)).openCards;
 const post=async(bot,bytes)=>{const path=`/api/threads/${bot.threadId}/respond`,response=await fetch(fixture.info.url+path,{method:'POST',headers:client.headers,body:bytes}),result=await response.json();const record={path,bytes,status:response.status,result};evidence.commands.push(record);return record;};
 const answers=id=>existsSync(join(fixture.info.dataDir,'native.ndjson'))?readFileSync(join(fixture.info.dataDir,'native.ndjson'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.id===id&&row.type==='answer'):[];
 const digest=path=>createHash('sha256').update(readFileSync(join(path,'sentinel.txt'))).digest('hex');
 const work=join(fixture.info.dataDir,'a4-work');mkdirSync(work);
 async function scenario(id,{restart=false,twice=false,service=false,display=false}={}){
  const deliveriesBefore=existsSync(join(fixture.info.dataDir,'service-deliveries.ndjson'))?readFileSync(join(fixture.info.dataDir,'service-deliveries.ndjson'),'utf8').trim().split('\n').filter(Boolean).length:0;
  // MAIN RULING 2026-11-14 narrow-wipe (Sean 11-13 WIPE-NARROW): card renewal binds recursive deletes through symlinks to registered temporary project roots.
  const referents=projectReferents(fixture.info.dataDir,id);
  for(const [index,root] of referents.entries())await client.bot(`${id}-root-${index}`,{id:'verification',model:'sonnet'},root,'unlimited');
  const cwd=join(work,id);mkdirSync(cwd);const target=join(cwd,'notes');symlinkSync(referents[0],target);const frozen=referents.map(digest);
  const deleteCommand=`rm -rf -- '${target}/'`;
  const bot=await client.bot(id,{id:'verification',model:'sonnet'},cwd,'unlimited');
  if(service)await command({kind:'service',threadId:bot.threadId,botId:bot.id,deleteCommand,cwd});
  else{const body={threadId:bot.threadId,text:promptPlan({id,steps:[{kind:'tool',tool:'Bash',input:{command:deleteCommand,cwd}}]}),sendId:randomUUID()};await client.api('POST',`/api/bots/${bot.id}/messages`,body);assert.equal((await wait(bot)).status,'needs-user');}
  const original=(await cards(bot)).find(row=>!row.card?.answered);assert.ok(original);
  const captured=await command({kind:'capture',threadId:bot.threadId,refKey:id});
  unlinkSync(target);symlinkSync(referents[1],target);
  const bytes=JSON.stringify({requestId:original.card.requestId,behavior:'allow'}),first=await post(bot,bytes);
  const replacement=(await cards(bot)).find(row=>!row.card?.answered);assert.ok(replacement);assert.notEqual(replacement.id,original.id,'fixture must actually refresh evidence before replay');
  if(restart)await command({kind:'clear',threadId:bot.threadId});
  const replay=await post(bot,bytes),afterReplay={cards:await cards(bot),answers:answers(id),open:(await command({kind:'inspect',threadId:bot.threadId})).open,lookups:(await command({kind:'inspect',threadId:bot.threadId})).lookups};
  if(afterReplay.open.length===0)return {id,service,restart,twice,original,replacement,captured,first,replay,afterReplay,referentsUnchanged:JSON.stringify(frozen)===JSON.stringify(referents.map(digest)),serviceDeliveries:existsSync(join(fixture.info.dataDir,'service-deliveries.ndjson'))?readFileSync(join(fixture.info.dataDir,'service-deliveries.ndjson'),'utf8').trim().split('\n').filter(Boolean).length:0};
  const staleDeny=await post(bot,JSON.stringify({requestId:original.card.requestId,behavior:'deny'}));
  const afterDeny={cards:await cards(bot),answers:answers(id)};
  if(afterDeny.cards.filter(row=>!row.card?.answered).length===0)return {id,service,restart,twice,original,replacement,captured,first,replay,afterReplay,staleDeny,afterDeny,referentsUnchanged:JSON.stringify(frozen)===JSON.stringify(referents.map(digest))};
  const staleRef=await command({kind:'old-ref',threadId:bot.threadId,refKey:id});
  const mirror=await command({kind:'mirror',threadId:bot.threadId,mirror:captured.mirror});
  const current=(await command({kind:'inspect',threadId:bot.threadId})).open[0];
  const hybrid=await command({kind:'mirror',threadId:bot.threadId,mirror:{...captured.mirror,id:current?.chatMessageId,requestRef:current?.requestId}});
  let third,secondPost,secondReplay,firstReplayAgain;
  if(twice){unlinkSync(target);symlinkSync(referents[2],target);secondPost=await post(bot,JSON.stringify({requestId:replacement.card.requestId,behavior:'allow'}));third=(await cards(bot)).find(row=>!row.card?.answered);firstReplayAgain=await post(bot,bytes);secondReplay=await post(bot,JSON.stringify({requestId:replacement.card.requestId,behavior:'allow'}));}
  const fresh=third??replacement;
  const freshPost=await post(bot,JSON.stringify(display?{requestHandle:`p.${fresh.id}`,action:'allow'}:{requestId:fresh.card.requestId,behavior:'allow'}));
  const final=service?undefined:await wait(bot),allCards=await cards(bot),messages=await control(['messages','--bot',bot.id,'--limit','30']);
  const decisionLogPath=join(fixture.info.dataDir,'decisions.ndjson'),decisionLog=existsSync(decisionLogPath)?readFileSync(decisionLogPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.threadId===bot.threadId):[];
  const refreshedCardPushEvents=client.events.filter(event=>JSON.stringify(event).includes(replacement.id));
  const serviceDeliveries=(existsSync(join(fixture.info.dataDir,'service-deliveries.ndjson'))?readFileSync(join(fixture.info.dataDir,'service-deliveries.ndjson'),'utf8').trim().split('\n').filter(Boolean).length:0)-deliveriesBefore;
  return {id,service,restart,twice,original,replacement,captured,first,replay,afterReplay,staleDeny,afterDeny,staleRef,mirror,hybrid,current,third,secondPost,secondReplay,firstReplayAgain,freshPost,final,allCards,messages,answers:answers(id),decisionLog,refreshedCardPushEvents,serviceDeliveries,referentsUnchanged:JSON.stringify(frozen)===JSON.stringify(referents.map(digest))};
 }
 if(process.env.A4_KEY_CASE!=='service'){
  evidence.rows.normal=await scenario('KEY-normal');
  evidence.rows.restart=await scenario('KEY-restart',{restart:true});
  evidence.rows.twice=await scenario('KEY-twice',{twice:true});
 }
 if(!process.env.A4_KEY_CASE||process.env.A4_KEY_CASE==='service'){evidence.rows.service=await scenario('KEY-service',{service:true});evidence.rows.serviceDisplay=await scenario('KEY-service-display',{service:true,display:true});}
 evidence.events=client.events;evidence.ok=true;
}catch(error){evidence.error=String(error.stack??error);const log=/see (.+\.log)/.exec(String(error))?.[1];if(log&&existsSync(log))writeFileSync(join(directory,'launch-failure.log.gz'),gzipSync(readFileSync(log)));process.exitCode=1;}
finally{await client?.disconnect();if(fixture){writeFileSync(join(directory,'server.log.gz'),gzipSync(readFileSync(fixture.info.logPath)));await fixture.close();evidence.cleaned=!existsSync(fixture.info.dataDir);}writeFileSync(join(directory,'results.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({ok:evidence.ok??false,error:evidence.error,cleaned:evidence.cleaned}));}
