import {fieldRows,scenarios} from './scenarios.mjs';
import {judgeScenario} from './counts.mjs';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchVerificationServer,runControlMurage} from '../control-murage.ts';
import {ProductClient} from './run.mjs';
import {installBindings} from './bindings.mjs';
const out=resolve(process.argv[2]??'.afix-evidence/r3/workflows');mkdirSync(out,{recursive:true});
const preload=`import {installWorkflowFixture} from ${JSON.stringify(new URL('./workflow-fixture.mjs',import.meta.url).href)};installWorkflowFixture();`;
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
let fixture,client;const report={mode:'fake-engine workflow bindings',releaseGate:false,testSeams:['idle-load preload','unwrapped host-power fixture'],rows:[],commands:[],verdict:'FAIL'};
try{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:preload});
 report.fixture=fixture.info;
 report.doctor=await runControlMurage(['doctor','--url',fixture.info.url],{env:{...process.env,MURAGE_DATA_DIR:fixture.info.dataDir}});
 const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json();
 client=new ProductClient(fixture.info.url,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret.secret},fixture.info.dataDir,45000);await client.connect();
 const api=client.api.bind(client);client.api=async(method,path,body,headers)=>{report.commands.push({method,path,...(body===undefined?{}:{body})});return api(method,path,body,headers);};
 const engine={id:'verification',model:'sonnet'},bindings=installBindings(Object.assign(fixture,{fakeWorkflow:true})),ids=[],threads=new Set();
 const allIds=['two-questions','question-with-instruction','queued-owner-drain','email-subject-rm','routine-wake','project-room-routine','project-routine-owner-room','deny-app-denied','deny-app-revoked','webhook-in-owner-room'];
 if(only&&!allIds.includes(only))throw Error('Unknown workflow selection');
 for(const id of only?[only]:allIds){
  const bot=await client.bot(`S3 ${id}`,engine,fixture.info.dataDir,'unlimited');ids.push(bot.id);threads.add(bot.threadId);
  try{const result=await bindings[id]({client,bot,engine,cwd:fixture.info.dataDir,spec:{id},ids,threads});if(!result.proof)throw Error('witness failed');
   if(['deny-app-denied','deny-app-revoked','webhook-in-owner-room'].includes(id)){
    const judged=judgeScenario(scenarios.find(s=>s.id===id),{...result.obs,actionProven:result.proof,permissionRuleWitness:result.permissionRuleWitness});
    if(judged.verdict!=='PASS')throw Error(judged.errors.join('; '));
   }
   writeFileSync(join(out,id+'-observation.json'),JSON.stringify(result,null,2)+'\n');
   report.rows.push({id,status:'PASS',witness:result.witness});}
  catch(error){
   const messages=(await Promise.all([...threads].map(t=>client.messages(t).catch(()=>[])))).flat().slice(-30);
   report.rows.push({id,status:error.message.startsWith('unbound: ')?'UNBOUND':'FAIL',reason:error.message,messages});
  }
  await client.stop(bot);
 }
 try{report.emailCapture=readFileSync(join(fixture.info.dataDir,'s3-email-capture.ndjson'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch{report.emailCapture=[];}
 if((!only||only==='email-subject-rm')&&(report.emailCapture.length!==1||report.emailCapture[0]?.subject!=='rm -rf ~ is quoted text'))report.rows.push({id:'email-stub-capture',status:'FAIL',reason:'email stub capture absent or substituted'});
 report.fields=[];
 for(const row of only?[]:fieldRows){
  const bot=await client.bot(`S3 field ${row.id}`,engine,fixture.info.dataDir,'unlimited');
  if(row.outside==='earlier-turn')await client.turn(bot,'S3_FIELD:'+Buffer.from(JSON.stringify({...row,tool:'WebFetch',input:{url:'http://fixture.nolim.invalid/'}})).toString('base64url'));
  const obs=await client.turn(bot,'S3_FIELD:'+Buffer.from(JSON.stringify(row)).toString('base64url'));
  if(!obs.complete||!obs.ended||!obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool'))throw Error(`field harness failed: ${row.id} ${JSON.stringify({complete:obs.complete,ended:obs.ended,errors:obs.errors,events:obs.events.map(e=>({type:e.type,...(e.type==='runtime.error'?{message:e.message}:{})}))})}`);
  writeFileSync(join(out,`${row.id}-observation.json`),JSON.stringify(obs,null,2)+'\n');
  report.fields.push(judgeScenario(row,{...obs,actionProven:obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool')}));
  await client.stop(bot);
 }
 report.verdict=report.rows.some(r=>r.status!=='PASS')||report.fields.some(r=>r.verdict!=='PASS')?'FAIL':'PASS';if(report.verdict==='FAIL')process.exitCode=1;
} catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(fixture)report.finalFixture=fixture.info;if(fixture)writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));await client?.disconnect();await fixture?.close();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
