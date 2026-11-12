// Isolated fake engine HTTP/SSE replay. No requested command is executed.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {launchVerificationServer,runControlMurage} from '../control-murage.ts';
import {levelPatch} from '../smoothness/smooth-config.mjs';
import {ProductClient} from './run.mjs';
import {trulyRows} from './truly-rows.mjs';
import {featureOffErrors} from './feature-off.mjs';
const out=resolve(process.argv[2]??'evidence/nolim-truly/raw/live');mkdirSync(out,{recursive:true});
const preload=`import {installTrulyFixture} from ${JSON.stringify(new URL('./truly-fixture.mjs',import.meta.url).href)};await installTrulyFixture();`;
let fixture,client;const report={mode:'isolated fake native relay + HTTP/SSE',ruling:'Sean 2026-11-12 08:05Z correction',rows:[],verdict:'FAIL'};
class ProofClient extends ProductClient {
 async api(method,path,body){
  if(method==='PATCH'&&/^\/api\/bots\/[^/]+$/.test(path)&&body?.autoApprove===true)body={...body,acknowledgeLocalAuto:true};
  const response=await fetch(this.url+path,{method,headers:this.headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  (report.commands??=[]).push({method,path,body,status:response.status,result});
  assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
 }
}
async function staleTermsProof(row){
 let child,childClient;
 try{
  child=await launchVerificationServer(process.env,undefined,{instrumentationSource:preload.replace('installTrulyFixture();','installTrulyFixture({staleTerms:true});')});
  report.staleTermsFixture=child.info;
  const proof=await(await fetch(child.info.url+'/api/desktop-secret')).json();
  childClient=new ProofClient(child.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret},child.info.dataDir,60000);await childClient.connect();
  const bot=JSON.parse(readFileSync(join(child.info.dataDir,'truly-stale-bot.json'),'utf8'));
  const obs=await childClient.turn(bot,'S3_FIELD:'+Buffer.from(JSON.stringify(row)).toString('base64url'));
  return {bot,obs};
 }finally{
  if(child)writeFileSync(join(out,'stale-terms-server.log'),readFileSync(child.info.logPath));
  await childClient?.disconnect();await child?.close();
 }
}
try{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:preload});
 report.fixture=fixture.info;
 report.doctor=await runControlMurage(['doctor','--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});
 assert.equal(report.doctor.ok,true);
 const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json();
 client=new ProofClient(fixture.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret.secret},fixture.info.dataDir,60000);await client.connect();
 const engine={id:'verification',model:'sonnet'};
 // Elect the owner's global No limits lead while the new-bot setting is Auto.
 const chief=await client.bot('truly-owner-global',engine,fixture.info.dataDir,'unlimited');
 await client.api('PATCH',`/api/bots/${chief.id}`,{chiefOfStaff:true,chiefScope:'workspace'});
 await client.api('PATCH','/api/config',{newBots:{permissionLevel:'auto'}});
 for(const row of trulyRows.filter(row=>!process.env.TRULY_ONLY||row.id.includes(process.env.TRULY_ONLY))){
  let bot,obs,routineId;
  if(row.staleTerms)({bot,obs}=await staleTermsProof(row));
  else {
  if(row.oldOwnerDefault){
   bot=JSON.parse(readFileSync(join(fixture.info.dataDir,'truly-old-owner-bot.json'),'utf8'));client.owned.add(bot.id);
  }else if(row.inherit){
   const made=await client.api('POST','/api/bots',{name:row.id,modelSelection:{instanceId:engine.id,model:engine.model}});
   bot=made.bot;client.owned.add(bot.id);
   await client.api('PATCH',`/api/bots/${bot.id}`,{cwd:fixture.info.dataDir,autoReview:'off'});
  }else bot=await client.bot(row.id,engine,fixture.info.dataDir,'unlimited');
  if(row.oldOwnerDefault){
   const changed=await client.api('GET',`/api/bots/${bot.id}`);
   const saved=JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8'));
   const stored=(Array.isArray(saved)?saved:saved.bots).find(record=>record.id===bot.id);
   const old=stored?.tasks?.find(task=>task.threadId===bot.threadId);
   report.oldOwnerDefault={stored:old,projected:changed.bot?.tasks?.find(task=>task.threadId===bot.threadId)};
   assert.ok(old,'old owner task retained');assert.notEqual(old.noLimits,true,'stored default was not copied to No limits');
  }
  if(row.channelOff)await client.api('PATCH',`/api/bots/${bot.id}`,{fullAccessChannelMessages:false});
  const text='S3_FIELD:'+Buffer.from(JSON.stringify(row)).toString('base64url');
  if(row.incoming){
   const hook=await client.api('POST','/api/webhooks',{name:row.id,botId:bot.id,prompt:text,runOn:'ember'});
   obs=await client.observe(bot,async()=>{
    const sent=await fetch(hook.credential.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'fixture event'})});
    assert.equal(sent.status,202);const accepted=await sent.json();
    // The scheduler may open a new task, or reuse the channel person's task.
    for(let n=0;n<200;n++){
     const state=await client.api('GET','/api/routines');const run=state.runs.find(run=>run.id===accepted.runId);
     if(run?.threadId){bot.threadId=run.threadId;return;}
     if(run?.status==='failed')throw Error(JSON.stringify(run));
     await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('incoming run did not acquire a thread');
   });
  }else if(row.routine){
   if(row.useAll)await client.level(bot.id,'auto');
   const made=await client.api('POST','/api/routines',{name:row.id,botId:bot.id,prompt:text,enabled:false,permissionMode:row.useAll?'ask':'unlimited',schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()},runOn:'ember'});
   routineId=made.routine.id;
   if(row.useAll){
    const before=await client.api('GET','/api/permissions/no-limits');
    assert.equal(before.enabled,true);assert.ok(before.lower.some(item=>item.kind==='bot'&&item.id===bot.id));assert.ok(before.lower.some(item=>item.kind==='routine'&&item.id===routineId));
    const after=await client.api('POST','/api/permissions/no-limits',{});
    assert.ok(!after.lower.some(item=>item.id===bot.id||item.id===routineId));assert.ok(after.bots>=1);assert.ok(after.routines>=1);
    report.inheritance={before,after};
   }
   obs=await client.observe(bot,async()=>{
    const started=await client.api('POST',`/api/routines/${routineId}/run`,{});
    for(let n=0;n<200;n++){
     const state=await client.api('GET','/api/routines');const run=state.runs.find(run=>run.id===started.run.id);
     if(run?.threadId){bot.threadId=run.threadId;return;}
     if(run?.status==='failed')throw Error(JSON.stringify(run));
     await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('routine did not acquire a thread');
   });
  }else obs=await client.turn(bot,text);
  }
  const count=obs.cards.filter(card=>!card.question).length;
  const resolutions=obs.events.filter(event=>event.type==='request.resolved').map(event=>({requestId:event.requestId,behavior:event.behavior}));
  const offLines=obs.messages.filter(message=>message.kind==='text'&&message.text==='Channel messages are off for this bot. Turn them on in the bot’s Permissions settings.').length;
  const result={offLines,resolutions,id:row.id,expected:row.expected,expectedCards:row.expectedCards,cards:count,complete:obs.complete,ended:obs.ended,errors:obs.errors,threadId:bot.threadId,events:obs.events,messages:obs.messages};
  report.rows.push(result);writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  assert.equal(obs.complete,true,row.id);assert.equal(obs.ended,true,row.id);assert.deepEqual(obs.errors,[],row.id);assert.equal(count,row.expectedCards,row.id);if(row.expected==='OFF_WITH_LINE'){
   const current=(await client.api('GET',`/api/bots/${bot.id}`)).bot;assert.equal(current.fullAccessChannelMessages,false);
   const tools=obs.events.filter(event=>event.itemType==='tool');
   const featureOff={feature:row.feature,actionExecuted:tools.some(event=>event.type==='item.completed'&&event.ok===true),actionNotRunProven:tools.length===0,
    continued:obs.ended,ownerLines:obs.messages.filter(message=>message.role==='bot'&&message.kind==='text'&&message.text?.trim()).map(message=>message.text)};
   result.featureOff=featureOff;
   assert.equal(resolutions.length,0,row.id+' disabled capability reached native permission surface');
   assert.deepEqual(featureOffErrors(row,{...obs,featureOff}),[],row.id);
  }else{
   assert.ok(resolutions.length>0,row.id+' native resolution');assert.ok(resolutions.every(result=>result.behavior===(row.expected==='RUN'?'allow':'deny')),row.id+' native behavior');
  }
  if(row.expected==='OFF')assert.equal(offLines,1,row.id+' off explanation');
  if(!row.staleTerms)await client.stop(bot);
 }
 report.verdict='PASS';
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
 if(fixture)writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));
 await client?.disconnect();await fixture?.close();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({verdict:report.verdict,rows:report.rows.map(({id,cards,expectedCards})=>({id,cards,expectedCards})),error:report.error}));
}
