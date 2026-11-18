// Harness evidence consumer owner: gnl-harness-r10. Native permission producer: MAIN.
import {hashInput} from './oracle-class.mjs';
import {declaredRequests} from './declared-requests.mjs';
import {fieldPlan} from './field-plan.mjs';
import {readNativeEvents,nativeOperationEvidence,availabilityEvidence,bareTool,completedOperations} from './native-operation-evidence.mjs';
import {normalizeLiveAccounting} from './live-accounting.mjs';
import {installDedicatedBindings} from './dedicated-bindings.mjs';
import {readSurfaces} from './readers.mjs';
import {observe} from './observe.mjs';
import {ingressMessages} from './origin-fixtures.mjs';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
const check=(v,why)=>{if(!v)throw Error(why);};
async function poll(fn){const end=Date.now()+45000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('workflow witness deadline');}
function boundError(endpoint,error){if(/returned 404|returned 405/.test(error.message))throw Error(`unbound: ${endpoint}`);throw error;}
// Bindings use the proven owner HTTP client exclusively. Native fake engines
// exercise tools from their real turn mounts; fixture files never create product rows.
// A delivered copy is input to a wake, never evidence that the provider resumed.
function routineWakeEvidence(threadId,peerId,events,messages){
 const own=events.filter(e=>e.threadId===threadId);
 const original=own.find(e=>e.type==='turn.started');
 if(!original?.turnId)return;
 const deliveries=messages.filter(m=>m.id?.startsWith('dres-')&&m.from?.botId===peerId&&
  m.inboundKind==='action'&&m.copyOf&&m.text?.includes('S3_PEER_REPLY')&&Number.isFinite(m.at));
 for(const delivery of deliveries)for(let i=0;i<own.length;i++){
  const start=own[i];
  if(start.type!=='turn.started'||!start.turnId||start.turnId===original.turnId||
   Date.parse(start.createdAt)<=delivery.at||!Number.isFinite(Date.parse(start.createdAt))||
   !start.provider||!start.providerInstanceId||start.provider!==original.provider||start.providerInstanceId!==original.providerInstanceId)continue;
  const same=e=>e.turnId===start.turnId&&e.provider===start.provider&&e.providerInstanceId===start.providerInstanceId;
  const endIndex=own.findIndex((e,n)=>n>i&&same(e)&&e.type==='turn.completed'&&e.ok===true);
  if(endIndex<0||own.slice(i+1,endIndex).some(e=>same(e)&&['turn.failed','turn.interrupted','turn.completed'].includes(e.type)))continue;
  const output=own.slice(i+1,endIndex).find(e=>same(e)&&e.type==='item.completed'&&e.itemType==='assistant_text'&&e.origin==='engine'&&e.text?.includes('S3_PEER_REPLY'));
  if(!output)continue;
  const message=messages.find(m=>m.turnId===start.turnId&&m.role==='bot'&&m.kind==='text'&&
   m.provenance==='provider'&&m.engine?.instanceId===start.providerInstanceId&&m.engine?.driverKind===start.provider&&
   !m.inboundKind&&!m.copyOf&&!m.id?.startsWith('dres-')&&m.text===output.text&&m.at>delivery.at);
  if(message)return {deliveryMessageId:delivery.id,delegationTurnId:original.turnId,wakeTurnId:start.turnId,
   wakeMessageId:message.id,wakeStartEventId:start.eventId,wakeOutputEventId:output.eventId,wakeEndEventId:own[endIndex].eventId};
 }
}
// Saved-app rows require the native permission protocol, even when the service
// independently registers a decision. Normalized service/tool items cannot stand
// in for that request. Observe still binds registrations and accepted answers.
export function savedAppPermissionEvidence(spec,snapshot,events,engine){
 if(!['deny-app-denied','deny-app-revoked'].includes(spec.id))return true;
 const inputHash=hashInput({accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'});
 const requests=(snapshot.taps??[]).filter(t=>t.type==='request'&&!t.nativeItem&&t.engine===engine?.driver&&t.providerInstanceId===engine?.id&&bareTool(t.tool)==='GMAIL_SEND_EMAIL'&&t.inputHash===inputHash);
 return requests.length===1&&events.some(e=>e.type==='request.opened'&&e.requestType==='permission'&&e.threadId===requests[0].threadId&&e.turnId===requests[0].generation&&e.requestId===requests[0].requestId)&&completedOperations(events).some(op=>op.threadId===requests[0].threadId&&op.turnId===requests[0].generation&&op.provider===engine.driver&&op.providerInstanceId===engine.id&&bareTool(op.tool)==='GMAIL_SEND_EMAIL'&&hashInput(op.input)===inputHash);
}
export function bindNativeRowEvidence(spec,snapshot,events,engine){
 const native=nativeOperationEvidence({...spec,nativeEngine:engine},snapshot,events);snapshot.errors.push(...native.errors);
 if(!savedAppPermissionEvidence(spec,snapshot,events,engine))snapshot.errors.push('Saved-app native permission request absent');
 if(spec.expected!=='OFF_WITH_LINE'&&!(snapshot.taps??[]).some(t=>t.type==='request')&&native.count===0){snapshot.complete=false;snapshot.errors.push('Native request and receipt absent');}
 return {...observe(spec,snapshot),native_operations:native.count};
}
export function installBindings(f){
 f.workflowFixtures={...f.workflowFixtures,...installDedicatedBindings(f),
  'unavailable-shell-missing-input':async({client:c,bot,spec,cwd})=>{
   const plan=fieldPlan({tool:'Bash',input:{}});
   const obs=await c.turn(bot,`Work ONLY inside ${cwd}. Use the requested tools. ${plan.instruction}`);
   const proof=availabilityEvidence(spec.availabilityWitness,readNativeEvents(f.data??f.info.dataDir,obs.threadIds,obs.events),cwd);
   return {obs,proof,availabilityWitness:{...spec.availabilityWitness,observed:proof}};
  }};
 f.observeRow=async({spec,engine,threadIds,observation})=>{
  const snapshot=await readSurfaces({dataDir:f.data??f.info.dataDir,url:f.client?.url??f.info?.url,headers:f.client?.headers,
   window:{threadIds,start:spec.id.startsWith('switch-')&&Number.isFinite(observation?.switch?.at)?observation.switch.at:f.client?.scenario?.start??0,end:Date.now()}});
  let events=[];try{events=readNativeEvents(f.data??f.info.dataDir,threadIds,f.client?.events??[]);}catch{snapshot.complete=false;snapshot.errors.push('Native operation surface unavailable');}
  if(spec.id.startsWith('switch-')&&Number.isFinite(observation?.switch?.at)){
   // The intentional stopped turn is retained in switch.before. All seven
   // accounting surfaces and native operations judge the same retry window.
   events=events.filter(e=>Date.parse(e.createdAt)>=observation.switch.at);
  }
  if(spec.availabilityWitness&&!availabilityEvidence(spec.availabilityWitness,events,f.client?.scenario?.cwd))snapshot.errors.push('Availability witness does not match missing input');
  normalizeLiveAccounting(snapshot,{dataDir:f.data??f.info.dataDir,events,threadIds});
  const pageFile=join(f.data??f.info.dataDir,'gnl-browser-pages.ndjson');
  const pages=existsSync(pageFile)?readFileSync(pageFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const dynamic=threadIds.flatMap(thread=>(f.client?.declarationInputs?.get(thread)??[]).flatMap(p=>declaredRequests(p.text,p.engine,p.spec,p.cwd,pages.filter(page=>page.scope.split(':')[1]===thread))));
  const incidental=[...new Map([...threadIds.flatMap(t=>f.client?.declared?.get(t)??[]),...dynamic].map(r=>[JSON.stringify(r),r])).values()];
  const nativeEngine=engine??f.client?.scenario?.engine;
  if(nativeEngine&&(snapshot.taps??[]).some(t=>t.type==='request'&&(t.engine!==nativeEngine.driver||t.providerInstanceId!==nativeEngine.id)))snapshot.errors.push('Native engine identity mismatch');
  if(observation?.featureOff)snapshot.featureOff=observation.featureOff;
  return bindNativeRowEvidence({...spec,incidental},snapshot,events,nativeEngine);
 };

 const routine=async({client:c,bot,engine,cwd,spec,threads,ids},project=false,wake=false)=>{
  let peer,group;
  if(wake){peer=await c.bot('S3 wake peer',engine,cwd,'unlimited');ids.push(peer.id);threads.add(peer.threadId);}
  if(project){const made=await c.api('POST','/api/projects',{clientId:`s3-${Date.now()}`,purpose:'S3 project routine',mode:'bots',members:[bot.id],leadBotId:bot.id});group=made.group;check(group?.id,'project room absent');threads.add(group.threadId);}
  const made=await c.api('POST','/api/routines',{name:spec.id,botId:bot.id,prompt:wake?`S3_DELEGATE ${peer.id}`:'S3_PROJECT_ROUTINE',enabled:false,permissionMode:'unlimited',schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()},...(project?{target:'room-goal',groupId:group.id}:{})});
  const executionEvents=()=>f.fakeWorkflow?readFileSync(join(f.info.dataDir,'s3-workflow-execution.ndjson'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):c.events;
  const eventMark=c.events.length;
  // The file starts on the first engine event, after the routine is launched.
  const executionMark=f.fakeWorkflow?(()=>{try{return executionEvents().length;}catch(error){if(error.code==='ENOENT')return 0;throw error;}})():eventMark;
  const started=await c.api('POST',`/api/routines/${made.routine.id}/run`,{}),runId=started.run?.id??started.runId;check(runId,'routine run id absent');
  const run=await poll(async()=>{const list=await c.api('GET','/api/routines');return list.runs?.find(r=>r.id===runId&&r.threadId);});threads.add(run.threadId);
  if(project)c.ownedCwds.set(run.threadId,join(f.data??f.info.dataDir,'workspaces',bot.id,'threads',run.threadId));
  let obs=await c.observe({...bot,threadId:run.threadId},async()=>{});
  let wakeWitness;
  if(wake){
   check(obs.ended,'routine delegation turn failed');
   let messages;
   wakeWitness=await poll(async()=>{messages=await c.messages(run.threadId);return routineWakeEvidence(run.threadId,peer.id,executionEvents().slice(executionMark),messages);});
   const events=executionEvents().slice(executionMark).filter(e=>e.threadId===run.threadId);
   obs={...obs,events,messages,ended:true,turn:{type:'turn.completed',ok:true,turnId:wakeWitness.wakeTurnId},
    cards:c.ledger.forWindow(run.threadId,messages.map(m=>m.id)),errors:[...new Set([...obs.errors,...c.ledger.problems([run.threadId]),...c.streamErrors])]};
  }
  const witness={runId,threadId:run.threadId,...(project?{groupId:group.id,target:run.target}:{}),...(wake?wakeWitness: {})};
  return {obs,proof:Boolean(runId)&&(!project||run.groupId===group.id)&&(!wake||Boolean(wakeWitness)),witness};
 };
 const queued=async({client:c,bot,cwd,ids,threads})=>{
  if(f.fakeWorkflow){bot=await c.bot('S3 queue native Pi',{id:'verification-queue',model:'ollama-cloud/glm-5.2'},cwd,'unlimited');ids.push(bot.id);threads.add(bot.threadId);}
  let firstFailed=false,firstFailure;
  const first=c.turn(bot,'S3_HOLD');first.catch(error=>{firstFailed=true;firstFailure=error;});
  // The redactor may correctly hold every text delta until the turn ends.
  // Queue against the host's start control; the busy and durable receipt
  // assertions below still prove this send arrived during the first turn.
  await poll(()=>{if(firstFailed)throw firstFailure;return c.events.find(e=>e.threadId===bot.threadId&&e.type==='turn.started');});
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
  const captureFile=join(f.info?.dataDir??f.data,'s3-email-capture.ndjson');
  const capturesBefore=()=>{try{return readFileSync(captureFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};const before=capturesBefore().length;
  const obs=await c.turn(bot,'S3_EMAIL',async()=>{
   for(const row of await c.messages(bot.threadId))if(row.card?.emailSend?.phase==='open'&&!row.card.answered)
    await c.api('POST',`/api/threads/${bot.threadId}/respond`,{requestId:row.card.requestId,behavior:'allow',emailAction:'send',emailRevision:row.card.emailSend.revision});
  });const captures=await c.api('GET',`/api/email/bots/${bot.id}`);
  // The stub's remote receipt is also read independently by the self-test.
  const sent=(captures.activity??[]).find(x=>x.ref);
  const delivered=capturesBefore().slice(before);check(delivered.length===1&&delivered[0].subject==='rm -rf ~ is quoted text','email target receipt absent');
  check(sent&&/sent/i.test(sent.line)&&!/not sent/i.test(sent.line),'email send receipt absent');return {obs,proof:true,witness:{sendRef:sent.ref,activity:sent.line}};
 };
 // Seed a pre-existing saved denial/grant only while the isolated server is
 // stopped, then exercise its real owner review route to save the denial.
 const app=async({client:c,bot,spec})=>{
  const dataDir=f.info?.dataDir??f.data;
  check(dataDir&&f.restart,'isolated app fixture lifecycle unavailable');
  const before=await c.api('GET',`/api/bots/${bot.id}/access`),policy=before.policy;
  const grant={toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL']};
  const revoked=spec.id==='deny-app-revoked',releaseApp=Boolean(f.root&&c.releaseFixture||f.fakeWorkflow);
  const appRoot=f.root??join(dataDir,'nolim-live-workflow-app');
  const seed=data=>{
    const file=join(data,'bots.json'),bots=JSON.parse(readFileSync(file,'utf8'));
    const saved=bots.find(b=>b.id===bot.id);check(saved,'saved app fixture bot absent');
    // Only these isolated rows mount the inert connector. Ordinary and off rows
    // retain the product's real omitted-tool inventory. No success is seeded.
    const configFile=join(data,'config.json');
    if(releaseApp){mkdirSync(appRoot,{recursive:true});const cfg=JSON.parse(readFileSync(configFile,'utf8'));cfg.mcpServers={...cfg.mcpServers,'gnl-app':{enabled:true,command:process.execPath,args:[fileURLToPath(new URL('./launchers/release-tool-service.mjs',import.meta.url))],env:{NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:appRoot,GNL_APP_DATA_DIR:data,S3_STATE_DIR:join(data,'s3-state'),GNL_SAVED_APP_FIXTURE:'1',GNL_APP_BOT:bot.id,GNL_APP_SCENARIO:spec.id}}};writeFileSync(configFile,JSON.stringify(cfg));}
    saved.composio=true;
    saved.connectedAppAccess={...policy,allowWrites:true,grants:revoked?[grant]:[],requests:[],denials:revoked?[]:[{id:'gnl-request-denied',toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL'],ops:['write'],source:'request-denied',at:Date.now(),revision:policy.revision}]};
    writeFileSync(file,JSON.stringify(bots));
  };
  const restartApp=async mutate=>{
   if(f.stop){
    await c.disconnect();await f.stop();mutate(dataDir);await f.restart();
    const secret=await(await fetch(c.url+'/api/desktop-secret')).json();c.headers['x-murage-surface-secret']=secret.secret;c.streamErrors=[];await c.connect();
   }else await f.restart(mutate);
  };
  await restartApp(seed);
  try{
  const action={action:'configure',revision:policy.revision,mode:'restricted',allowWrites:true,grants:[]};
  const reviewed=await c.api('PUT',`/api/bots/${bot.id}/access`,action);
  const denial=reviewed.policy.denials?.find(d=>d.source===(revoked?'grant-revoked':'request-denied')&&d.tools.includes('GMAIL_SEND_EMAIL')&&d.accountId==='fixture-account');
  check(denial&&reviewed.enabled===true,'matching saved app denial absent or whole feature disabled');
  const payload=Buffer.from(JSON.stringify({id:spec.id,ruleId:denial.id})).toString('base64url');
  const priorMessages=new Set((await c.messages(bot.threadId)).map(m=>m.id));
  const actionFile=join(dataDir,'s3-state/app-actions.ndjson');
  const readActions=()=>existsSync(actionFile)?readFileSync(actionFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  const beforeActions=readActions().length;
  const obs=await c.turn(bot,'S3_SAVED_APP:'+payload);
  obs.messages=ingressMessages(obs.messages,priorMessages);
  const actions=readActions().slice(beforeActions);
  const actionExecuted=actions.length===1&&actions[0].id===spec.id&&actions[0].ruleId===denial.id&&actions[0].executed===true&&actions[0].tool==='GMAIL_SEND_EMAIL'&&JSON.stringify(actions[0].input)===JSON.stringify({accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'});
  const current=await c.api('GET',`/api/bots/${bot.id}/access`);
  const ruleInstalled=current.policy.denials?.some(d=>d.id===denial.id)===true;
  return {obs,proof:actionExecuted&&ruleInstalled,permissionRuleWitness:{source:spec.id,ruleInstalled,actionExecuted},witness:{ruleId:denial.id,source:denial.source,actionExecuted,ruleInstalled}};
  }finally{if(releaseApp)await restartApp(data=>{const file=join(data,'config.json'),cfg=JSON.parse(readFileSync(file,'utf8'));delete cfg.mcpServers?.['gnl-app'];writeFileSync(file,JSON.stringify(cfg));});}
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
  const run=await poll(async()=>(await c.api('GET','/api/routines')).runs?.find(r=>r.id===runId&&r.threadId));threads.add(run.threadId);c.declare(run.threadId,prompt);
  const roomRun=await poll(async()=>{
    const error=(await c.messages(run.threadId)).find(m=>m.text?.startsWith('S3_FIXTURE_ERROR'));
    if(error)throw Error(error.text);
    return (await c.api('GET','/api/routines')).runs?.find(r=>r.routineId===routineId&&r.groupId===group.id&&r.threadId);
  });
  threads.add(roomRun.threadId);
  c.declare(roomRun.threadId,'S3_ROOM_WEBHOOK_ACTION');
  await poll(()=>c.events.slice(mark).some(e=>e.threadId===roomRun.threadId&&e.type==='turn.completed'&&e.ok!==false));
  const events=c.events.slice(mark),messages=await c.messages(roomRun.threadId),cards=c.ledger.forThreads([run.threadId,roomRun.threadId]);
  const records=readFileSync(join(f.info?.dataDir??f.data,'s3-state/room-actions.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const proof=records.some(r=>r.groupId===group.id&&r.routineId===routineId&&r.nativeMcp===true&&r.ownerSurface===false)&&events.some(e=>e.threadId===roomRun.threadId&&e.type==='item.completed'&&e.itemType==='tool'&&e.ok===true);
  check(proof,'webhook room action not witnessed');
  return {obs:{complete:true,ended:true,events,messages,cards,errors:[],threadIds:[run.threadId,roomRun.threadId]},proof,witness:{runId,roomRunId:roomRun.id,routineId,groupId:group.id,threadId:roomRun.threadId,triggerSource:run.triggerSource,nativeMcp:true,ownerSurface:false}};
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
