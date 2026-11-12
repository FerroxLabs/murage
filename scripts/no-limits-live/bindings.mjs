import {readPolicyAccounting} from './policy-accounting.mjs';
import {ingressMessages} from './origin-fixtures.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
const check=(v,why)=>{if(!v)throw Error(why);};
async function poll(fn){const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('workflow witness deadline');}
function boundError(endpoint,error){if(/returned 404|returned 405/.test(error.message))throw Error(`unbound: ${endpoint}`);throw error;}
// Bindings use the proven owner HTTP client exclusively. Native fake engines
// exercise tools from their real turn mounts; fixture files never create product rows.
export function installBindings(f){
 f.observeRow=async({spec,threadIds,observation})=>readPolicyAccounting({
  dataDir:f.data??f.info.dataDir,threadIds,spec,
  start:spec.id==='switch-ask-to-nolimits'&&Number.isFinite(observation?.switch?.at)?observation.switch.at:0,end:Date.now(),
 });

 const routine=async({client:c,bot,engine,cwd,spec,threads,ids},project=false,wake=false)=>{
  let peer,group;
  if(wake){peer=await c.bot('S3 wake peer',engine,cwd,'unlimited');ids.push(peer.id);threads.add(peer.threadId);}
  if(project){const made=await c.api('POST','/api/projects',{clientId:`s3-${Date.now()}`,purpose:'S3 project routine',mode:'bots',members:[bot.id],leadBotId:bot.id});group=made.group;check(group?.id,'project room absent');threads.add(group.threadId);}
  const made=await c.api('POST','/api/routines',{name:spec.id,botId:bot.id,prompt:wake?`S3_DELEGATE ${peer.id}`:'S3_PROJECT_ROUTINE',enabled:false,permissionMode:'unlimited',schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()},...(project?{target:'room-goal',groupId:group.id}:{})});
  const started=await c.api('POST',`/api/routines/${made.routine.id}/run`,{}),runId=started.run?.id??started.runId;check(runId,'routine run id absent');
  const run=await poll(async()=>{const list=await c.api('GET','/api/routines');return list.runs?.find(r=>r.id===runId&&r.threadId);});threads.add(run.threadId);
  const obs=await c.observe({...bot,threadId:run.threadId},async()=>{});
  let wakeMessage;
  if(wake)wakeMessage=await poll(async()=>(await c.messages(run.threadId)).find(m=>m.text?.includes('S3_WAKE_DONE')));
  const witness={runId,threadId:run.threadId,...(project?{groupId:group.id,target:run.target}:{}),...(wake?{wakeMessageId:wakeMessage.id}: {})};
  return {obs,proof:Boolean(runId)&&(!project||run.groupId===group.id)&&(!wake||Boolean(wakeMessage)),witness};
 };
 const queued=async({client:c,bot,cwd,ids,threads})=>{
  if(f.fakeWorkflow){bot=await c.bot('S3 queue native Pi',{id:'verification-queue',model:'ollama-cloud/glm-5.2'},cwd,'unlimited');ids.push(bot.id);threads.add(bot.threadId);}
  const first=c.turn(bot,'S3_HOLD');await poll(()=>c.events.find(e=>e.threadId===bot.threadId&&e.type==='content.delta'));
  check((await c.api('GET',`/api/bots/${bot.id}`)).bot?.busy===true,'queue fixture did not hold a running turn');
  const receipt=await c.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'S3_QUEUED_SEND',sendId:`s3-queued-${Date.now()}`});
  check(receipt.queued===true&&receipt.queueId,'owner send did not enter the durable queue');
  const obs=await first;check(obs.ended,'first queued-send turn failed');
  const drained=await poll(async()=>{const b=(await c.api('GET',`/api/bots/${bot.id}`)).bot;const messages=await c.messages(bot.threadId);return b?.busy===false&&messages.some(m=>m.text?.includes('S3_QUEUED_SEND'))&&c.events.filter(e=>e.threadId===bot.threadId&&e.type==='turn.completed'&&e.ok!==false).length>=2?messages:false;});
  return {obs,proof:true,witness:{receipt,drained:true,completedTurns:c.events.filter(e=>e.threadId===bot.threadId&&e.type==='turn.completed'&&e.ok!==false).length}};
 };
 const questions=async({client:c,bot,spec})=>{
  const instruction=spec.id==='question-with-instruction';
  const answered=new Set();
  const obs=await c.turn(bot,instruction?'S3_QUESTION_WITH_INSTRUCTION':'S3_TWO_QUESTIONS',async()=>{
   for(const message of await c.messages(bot.threadId))if(message.kind==='text'&&/^Question \d+ of \d+\n/.test(message.text??'')&&!answered.has(message.id)){
    answered.add(message.id);await c.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'red',sendId:`s3-question-${message.id}`});
   }
  });
  // Questions are conversational text in the current product, never permission cards.
  const records=obs.messages.filter(message=>message.kind==='text'&&/^Question \d+ of \d+\n/.test(message.text??''));
  check(records.length===(instruction?1:2),'question text records absent');
  check(answered.size===records.length,'question reply did not reach the actual owner-send route');
  if(instruction)check(JSON.stringify(records).includes('rm -rf ~'),'question instruction was not delivered as question data');return {obs,proof:true,witness:{questionRecords:records.map(message=>({id:message.id,text:message.text})),answered:[...answered]}};
 };
 const email=async({client:c,bot})=>{
  await c.api('GET','/api/email/status?refresh=1');await c.api('POST',`/api/email/bots/${bot.id}/setup`,{username:'fixture',displayName:'Fixture'});
  await c.api('POST',`/api/email/bots/${bot.id}/trusted-add`,{entry:'fixture@example.test'});
  const obs=await c.turn(bot,'S3_EMAIL',async()=>{
   for(const row of await c.messages(bot.threadId))if(row.card?.emailSend?.phase==='open'&&!row.card.answered)
    await c.api('POST',`/api/threads/${bot.threadId}/respond`,{requestId:row.card.requestId,behavior:'allow',emailAction:'send',emailRevision:row.card.emailSend.revision});
  });const captures=await c.api('GET',`/api/email/bots/${bot.id}`);
  // The stub's remote receipt is also read independently by the self-test.
  const sent=(captures.activity??[]).find(x=>x.ref);
  check(sent&&/sent/i.test(sent.line)&&!/not sent/i.test(sent.line),'email send receipt absent');return {obs,proof:true,witness:{sendRef:sent.ref,activity:sent.line}};
 };
 // Seed a pre-existing saved denial/grant only while the isolated server is
 // stopped, then exercise its real owner review route to save the denial.
 const app=async({client:c,bot,spec})=>{
  const dataDir=f.info?.dataDir??f.data;
  check(dataDir&&f.restart,'isolated app fixture lifecycle unavailable');
  const before=await c.api('GET',`/api/bots/${bot.id}/access`),policy=before.policy;
  const grant={toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL']};
  const revoked=spec.id==='deny-app-revoked';
  const seed=data=>{
    const file=join(data,'bots.json'),bots=JSON.parse(readFileSync(file,'utf8'));
    const saved=bots.find(b=>b.id===bot.id);check(saved,'saved app fixture bot absent');
    saved.connectedAppAccess={...policy,allowWrites:true,grants:revoked?[grant]:[],requests:[],denials:revoked?[]:[{id:'gnl-request-denied',toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL'],ops:['write'],source:'request-denied',at:Date.now(),revision:policy.revision}]};
    writeFileSync(file,JSON.stringify(bots));
  };
  if(f.stop){
    await c.disconnect();await f.stop();seed(dataDir);await f.restart();
    const secret=await(await fetch(c.url+'/api/desktop-secret')).json();c.headers['x-murage-surface-secret']=secret.secret;c.streamErrors=[];await c.connect();
  }else await f.restart(seed);
  const action={action:'configure',revision:policy.revision,mode:'restricted',allowWrites:true,grants:[]};
  const reviewed=await c.api('PUT',`/api/bots/${bot.id}/access`,action);
  const denial=reviewed.policy.denials?.find(d=>d.source===(revoked?'grant-revoked':'request-denied')&&d.tools.includes('GMAIL_SEND_EMAIL')&&d.accountId==='fixture-account');
  check(denial&&reviewed.enabled===true,'matching saved app denial absent or whole feature disabled');
  const payload=Buffer.from(JSON.stringify({id:spec.id,ruleId:denial.id})).toString('base64url');
  const priorMessages=new Set((await c.messages(bot.threadId)).map(m=>m.id));
  const obs=await c.turn(bot,'S3_SAVED_APP:'+payload);
  obs.messages=ingressMessages(obs.messages,priorMessages);
  const actions=readFileSync(join(dataDir,'s3-state/app-actions.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const actionExecuted=actions.some(a=>a.id===spec.id&&a.ruleId===denial.id&&a.executed===true);
  const current=await c.api('GET',`/api/bots/${bot.id}/access`);
  const ruleInstalled=current.policy.denials?.some(d=>d.id===denial.id)===true;
  return {obs,proof:actionExecuted&&ruleInstalled,permissionRuleWitness:{source:spec.id,ruleInstalled,actionExecuted},witness:{ruleId:denial.id,source:denial.source,actionExecuted,ruleInstalled}};
 };
 const webhookRoom=async({client:c,bot,threads})=>{
  const {group}=await c.api('POST','/api/projects',{clientId:'gnl-webhook-'+Date.now(),purpose:'GNL webhook owner room',mode:'bots',members:[bot.id],leadBotId:bot.id});
  check(group?.threadId,'webhook owner room absent');threads.add(group.threadId);
  const made=await c.api('POST','/api/routines',{name:'GNL webhook room action',botId:bot.id,prompt:'S3_ROOM_WEBHOOK_ACTION',enabled:false,permissionMode:'unlimited',schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()},target:'room-goal',groupId:group.id});
  const routineId=made.routine.id;
  const prompt='S3_WEBHOOK_ROOM:'+Buffer.from(JSON.stringify({routineId,groupId:group.id})).toString('base64url');
  const hook=await c.api('POST','/api/webhooks',{name:'GNL owner room ingress',botId:bot.id,prompt,runOn:'ember'});
  const endpoint=new URL(hook.credential.url);check(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname),'non-fixture webhook');
  const mark=c.events.length;
  const receipt=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{"fixture":true}'});check(receipt.status===202,'webhook not accepted');
  const {runId}=await receipt.json();check(runId,'webhook run absent');
  const run=await poll(async()=>(await c.api('GET','/api/routines')).runs?.find(r=>r.id===runId&&r.threadId));threads.add(run.threadId);
  const roomRun=await poll(async()=>{
    const error=(await c.messages(run.threadId)).find(m=>m.text?.startsWith('S3_FIXTURE_ERROR'));
    if(error)throw Error(error.text);
    return (await c.api('GET','/api/routines')).runs?.find(r=>r.routineId===routineId&&r.groupId===group.id&&r.threadId);
  });
  threads.add(roomRun.threadId);
  await poll(()=>c.events.slice(mark).some(e=>e.threadId===roomRun.threadId&&e.type==='turn.completed'&&e.ok!==false));
  const events=c.events.slice(mark),messages=await c.messages(roomRun.threadId),cards=c.ledger.forThreads([run.threadId,roomRun.threadId]);
  const records=readFileSync(join(f.info?.dataDir??f.data,'s3-state/room-actions.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const proof=records.some(r=>r.groupId===group.id&&r.routineId===routineId&&r.nativeMcp===true&&r.ownerSurface===false)&&events.some(e=>e.threadId===roomRun.threadId&&e.type==='item.completed'&&e.itemType==='tool'&&e.ok===true);
  check(proof,'webhook room action not witnessed');
  return {obs:{complete:true,ended:true,events,messages,cards,errors:[]},proof,witness:{runId,roomRunId:roomRun.id,routineId,groupId:group.id,threadId:roomRun.threadId,triggerSource:run.triggerSource,nativeMcp:true,ownerSurface:false}};
 };
 f.r2Fixtures={'email-subject-rm':email,'routine-wake':ctx=>routine(ctx,false,true),'project-room-routine':ctx=>routine(ctx,true,false)};
 f.r31Fixtures={
  'queued-owner-drain':queued,'two-questions':questions,'question-with-instruction':questions,
  'project-routine-owner-room':ctx=>routine(ctx,true,false),
  'deny-app-denied':app,'deny-app-revoked':app,'webhook-in-owner-room':webhookRoom,
 };
 const all={...f.r2Fixtures,...f.r31Fixtures};
 for(const [id,fn]of Object.entries(all))all[id]=async ctx=>{try{return await fn(ctx);}catch(e){return boundError(id,e);}};
 return all;
}
