// BASE-F measures the fake-engine harness on the pinned BASE server tree.
// It does not replace the live BASE run or assert real-engine action witnesses.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ProductClient} from './run.mjs';
import {scenarios,engineSpecs} from './historical-baseline.mjs';
import {scenarioPlan,promptPlan,planHash} from './baseline-f-plan.mjs';
import {verifyScenarioRow} from './baseline-f-proof.mjs';
import {BASE_SHA} from './baseline.mjs';
const rowFilter=process.argv.find(a=>a.startsWith('--rows='))?.slice(7).split(',');
const engineFilter=process.argv.find(a=>a.startsWith('--engines='))?.slice(10).split(',');
const smoke=process.argv.includes('--smoke')||Boolean(rowFilter||engineFilter);
const selectedRows=rowFilter?scenarios.filter(r=>rowFilter.includes(r.id)):smoke?scenarios.slice(0,1):scenarios;
const selectedEngines=engineFilter?engineSpecs.filter(e=>engineFilter.includes(e.id)):engineSpecs;
const base=resolve(process.argv[2]),out=resolve(process.argv[3]);mkdirSync(out,{recursive:true});
const {launchVerificationServer}=await import(pathToFileURL(join(base,'scripts/control-murage.ts')));
const candidate=fileURLToPath(new URL('../../',import.meta.url));
const models={claude:'sonnet',codex:'gpt-5.4','gpt-sol':'gpt-5.4',fuigo:'fake-model',gemini:'fake-model'};
const config=Object.fromEntries(engineSpecs.map(e=>[e.id,{driver:e.driver,config:{cli:join(candidate,'scripts/no-limits-live/fakes',e.driver==='claudeAgent'?'claude.mjs':e.driver==='codex'?'codex.mjs':'acp.mjs')},environment:{GEMINI_API_KEY:'fixture-not-a-provider-key'}}]));
const instrumentationSource=`import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {join} from 'node:path';process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;const auth=join(process.env.HOME,'.fuigo');mkdirSync(auth,{recursive:true});writeFileSync(join(auth,'auth.json'),JSON.stringify({fixture:true}));const p=join(process.env.MURAGE_DATA_DIR,'config.json'),c=JSON.parse(readFileSync(p));c.instances=${JSON.stringify(config)};for(const i of Object.values(c.instances))i.environment.BASE_F_LOG=join(process.env.MURAGE_DATA_DIR,'base-native.ndjson');writeFileSync(p,JSON.stringify(c));`;
const report={schema:1,label:'fake-engine BASE',tree:BASE_SHA,liveBaseline:false,smoke,testSeams:['fixture-only Fuigo auth marker','fixture-only Gemini key','suite host-power unwrapped launch symbol; no host-power qualification'],scenarioSet:scenarios.map(s=>s.id),engines:engineSpecs.map(e=>e.id),rows:[],errors:[],scope:'native fake-engine HTTP/SSE workflow observations; action witnesses remain required by integrated/live J3'};
let fixture,client;
try{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource});
 const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json();
 client=new ProductClient(fixture.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret.secret},fixture.info.dataDir,15000);await client.connect();
 const instances=(await client.api('GET','/api/instances')).instances;
 for(const engine of selectedEngines){
  const available=instances.find(i=>i.instanceId===engine.id);const model=available?.models?.options?.[0]?.id??models[engine.id];
  for(const row of selectedRows){
   let bot;const scripts=[];let switched,queue,room;const mark=client.events.length;try{
    bot=await client.bot(`BASE-F ${engine.id} ${row.id}`,{id:engine.id,model},fixture.info.dataDir,row.initialLevel??row.level);
    const plan={...scenarioPlan(row),engine:engine.id},nativeLog=join(fixture.info.dataDir,'base-native.ndjson');
    const native=()=>existsSync(nativeLog)?readFileSync(nativeLog,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
    const make=(steps,stage,gate)=>{const script={...plan,steps,stage,...(gate?{gate}:{})};scripts.push({plan:script,hash:planHash(script)});return promptPlan(script);};
    const gate=join(fixture.info.dataDir,`gate-${engine.id}-${row.id}`);
    let prompt=make(plan.steps,0,row.initialLevel||plan.workflow==='queue'?gate:undefined);
    let obs;
    if(row.initialLevel){
     obs=await client.turn(bot,prompt,async()=>{
      if(switched||!native().some(r=>r.type==='plan'&&r.id===row.id&&r.hash===scripts[0].hash))return;
      const before=(await client.api('GET',`/api/bots/${bot.id}`)).bot;
      if(!before.busy)throw Error('switch did not occur in a running turn');
      await client.level(bot.id,row.level);const after=(await client.api('GET',`/api/bots/${bot.id}`)).bot;
      const level=b=>!b.autoApprove?'ask':b.fullAccess?b.noLimits?'unlimited':'full':'auto';
      switched={from:level(before),to:level(after),duringTurn:true};writeFileSync(gate,'go');
     });
    }else if(plan.workflow==='two-turn'){
     scripts.length=0;const first=await client.turn(bot,make(plan.steps.slice(0,1),0));
     const second=await client.turn(bot,make(plan.steps.slice(1),1));obs={...second,ended:first.ended&&second.ended,events:[...first.events,...second.events]};
    }else if(plan.workflow==='queue'){
     scripts.length=0;prompt=make(plan.steps.slice(0,1),0,gate);const followup=make(plan.steps.slice(1),1);
     const first=await client.turn(bot,prompt,async()=>{
      if(queue||!native().some(r=>r.type==='plan'&&r.id===row.id&&r.hash===scripts[0].hash))return;
      queue=await client.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:followup,sendId:`base-queue-${Date.now()}`});
      if(!queue.queued||!queue.queueId)throw Error('fake BASE queued send receipt missing');writeFileSync(gate,'go');
     });
     const until=Date.now()+20000;let ended=false;
     while(Date.now()<until){
      const events=client.events.slice(mark).filter(e=>e.threadId===bot.threadId);
      const open=await client.api('GET',`/api/threads/${bot.threadId}/open-cards`);
      for(const m of open.openCards??[])if(m.card?.requestId&&!m.card.answered)await client.api('POST',`/api/threads/${bot.threadId}/respond`,{requestId:m.card.requestId,behavior:'deny'});
      if(events.filter(e=>e.type==='turn.completed'&&e.ok!==false).length>=2&&(await client.api('GET',`/api/bots/${bot.id}`)).bot.busy===false){ended=true;break;}await sleep(100);
     }
     await client.messages(bot.threadId);obs={...first,ended,events:client.events.slice(mark).filter(e=>e.threadId===bot.threadId),cards:client.ledger.forThreads([bot.threadId])};
    }else if(row.id==='owner-room-turn'){
     room=(await client.api('POST','/api/groups',{name:'BASE-F owner room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).group;
     if(!room?.threadId)throw Error('fake BASE owner room missing');bot.threadId=room.threadId;
     obs=await client.observe(bot,()=>client.api('POST',`/api/groups/${room.id}/messages`,{text:prompt}));
    }else if(row.actor==='owner')obs=await client.turn(bot,prompt);
    else {
     const mark=client.events.length;let runId;
     if(row.actor==='routine'){
      if(['project-room-routine','project-routine-owner-room'].includes(row.id)){
       room=(await client.api('POST','/api/projects',{clientId:`base-${engine.id}-${row.id}`,purpose:'BASE-F project routine',mode:'bots',members:[bot.id],leadBotId:bot.id})).group;
       if(!room?.id)throw Error('fake BASE project room missing');
      }
      const made=await client.api('POST','/api/routines',{name:row.id,botId:bot.id,prompt,enabled:false,permissionMode:row.id==='routine-captured-auto'?'auto':row.level,...(room?{target:'room-goal',groupId:room.id}:{}),schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});
      const started=await client.api('POST',`/api/routines/${made.routine.id}/run`,{});runId=started.run?.id??started.runId;
     }else{
      const hook=await client.api('POST','/api/webhooks',{name:row.id,botId:bot.id,prompt,runOn:'ember'});
      const url=new URL(hook.credential.url);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('webhook escaped fixture');
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(response.status!==202)throw Error('webhook not accepted');runId=(await response.json()).runId;
     }
     let run,ended;const until=Date.now()+20000;
     while(Date.now()<until){
      run=(await client.api('GET','/api/routines')).runs?.find(r=>r.id===runId);
      if(run?.threadId){bot.threadId=run.threadId;const open=await client.api('GET',`/api/threads/${run.threadId}/open-cards`);for(const m of open.openCards??[])if(m.card?.requestId&&!m.card.answered)await client.api('POST',`/api/threads/${run.threadId}/respond`,{requestId:m.card.requestId,behavior:'deny'});
       const events=client.events.slice(mark).filter(e=>e.threadId===run.threadId);const latest=events.filter(e=>e.type==='turn.started').at(-1)?.turnId;ended=events.findLast(e=>e.type==='turn.completed'&&(!latest||e.turnId===latest));if(ended?.stopReason==='submission_refused')ended=undefined;if(ended)break;
      }
      await sleep(100);
     }
     if(!ended)throw Error('routine/webhook completion witness missing');await client.messages(bot.threadId);
     obs={complete:true,ended:ended.ok!==false,cards:client.ledger.forThreads([bot.threadId]),events:client.events.slice(mark).filter(e=>e.threadId===bot.threadId),errors:[],runId,triggerSource:run.triggerSource};
    }
    const result={...(room?{groupId:room.id}:{}),engine:engine.id,id:row.id,actor:row.actor,level:row.level,expected:row.expected,complete:obs.complete,ended:obs.ended,terminal:obs.turn,runtimeErrors:obs.events.filter(e=>e.type==='runtime.error').map(e=>e.message),
     completedTurns:obs.events.filter(e=>e.type==='turn.completed'&&e.ok!==false).length,cardCount:obs.cards.filter(c=>!c.question).length,questionCount:obs.cards.filter(c=>c.question).length,
     ...(obs.runId?{runId:obs.runId,triggerSource:obs.triggerSource}:{}),nativeToolCompletions:obs.events.filter(e=>e.type==='item.completed'&&e.itemType==='tool').length,errors:obs.errors,
     scripts:scripts.map(script=>({...script,requests:native().filter(r=>r.type==='request'&&r.hash===script.hash),receipts:native().filter(r=>r.type==='receipt'&&r.hash===script.hash)})),
     ...(switched?{switch:switched}:{}),...(queue?{queue:{...queue,drained:obs.ended}}:{})};
    result.errors.push(...verifyScenarioRow(result,row));report.rows.push(result);
    console.log(`${engine.id}/${row.id}: ${result.errors.length?'FAIL '+result.errors.join('; '):'PASS'}`);
   }catch(error){report.rows.push({engine:engine.id,id:row.id,status:'FAIL',reason:error.message});}
   finally{if(room)await client.api('POST',`/api/groups/${room.id}/interrupt`,{});if(bot){await client.stop(bot);await client.api('DELETE',`/api/bots/${bot.id}`);}}
  }
 }
 report.verdict=report.rows.length===selectedRows.length*selectedEngines.length&&report.rows.every(r=>r.complete&&r.ended&&!r.errors.length)?'PASS':'FAIL';
 if(report.verdict==='FAIL')process.exitCode=1;
}catch(error){report.errors.push(error.stack);report.verdict='FAIL';process.exitCode=1;}
finally{if(fixture){writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));const nativeLog=join(fixture.info.dataDir,'base-native.ndjson');if(existsSync(nativeLog))writeFileSync(join(out,'native.ndjson'),readFileSync(nativeLog));}await client?.disconnect();await fixture?.close();
 const bytes=JSON.stringify(report,null,2)+'\n';writeFileSync(join(out,'baseline-f.json'),bytes);if(!smoke&&report.verdict==='PASS')writeFileSync(new URL('./baseline-f.sha256',import.meta.url),createHash('sha256').update(bytes).digest('hex')+'\n');console.log(`${report.verdict}: fake-engine BASE ${report.rows.length} rows`);}
