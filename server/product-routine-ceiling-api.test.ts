// Real service authorization from an isolated routine turn on a No limits bot.
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,runControlMurage,type VerificationServer} from '../scripts/control-murage.ts';
import {withTurnSecrets} from './testing/fixture-dump.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,desktop:Record<string,string>;
const evidence:unknown[]=[];
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:response.status,body:await response.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,...result});return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{dumpLog:true,instrumentationSource:"process.env.FAKE_CLAUDE_MODE='hang';process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';"});
 const secret=(await api('GET','/api/desktop-secret',undefined,{})).body.secret;
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':secret};
 expect(await runControlMurage(['doctor','--url',fixture.info.url])).toMatchObject({ok:true});
},120000);
afterAll(async()=>{
 if(!fixture)return;
 const out=process.env.GNL_PRODUCT_CEILING_EVIDENCE??'evidence/gnl-prod-r3/service-ceiling';mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'workflow.json'),JSON.stringify({fixture:fixture.info,evidence},null,2));
 writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));await fixture.close();
});
it.each(['ask','auto','full','inherit'] as const)('H2 real %s routine service authorization preserves the resolved ceiling',async mode=>{
 const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
 const b=(await api('POST','/api/bots',{name:'H2 service '+mode,modelSelection:{instanceId:'verification',model:instance.models.options[0].id}})).body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const prompt='__fixture_hold_authority__ H2-service-'+mode;
 const routine=await api('POST','/api/routines',{botId:b.id,name:'H2 '+mode,prompt,enabled:false,...(mode==='inherit'?{}:{permissionMode:mode}),schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});
 expect(routine.status).toBe(201);
 const started=await api('POST',`/api/routines/${routine.body.routine.id}/run`,{});expect(started.status).toBe(201);
 let auth:Record<string,string>|undefined,threadId:string|undefined;
 try{
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(line=>line.includes(prompt));if(!line)return false;const dump=withTurnSecrets(JSON.parse(line));const token=dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;if(!token)return false;auth={authorization:'Bearer '+token};return true;}catch{return false;}},{timeout:30000}).toBe(true);
  threadId=(await api('GET','/api/routines')).body.runs.find((row:any)=>row.id===started.body.run.id)?.threadId;expect(threadId).toBeTruthy();
  const proposal=await api('POST','/api/internal/routine-requests',{fromBotId:b.id,fromThreadId:threadId,action:'create',routine:{name:'Proposed by '+mode,instructions:'Inert fixture work',schedule:{type:'interval',everyMinutes:60}}},auth);
  expect(proposal.status,JSON.stringify(proposal.body)).toBe(mode==='inherit'?201:403);
  const definitions=(await api('GET','/api/routines')).body.routines;
  expect(definitions.some((row:any)=>row.name==='Proposed by '+mode)).toBe(mode==='inherit');
  if(mode==='inherit')expect(proposal.body.autoApproved).toBe(true);
 }finally{if(threadId)await api('POST',`/api/bots/${b.id}/interrupt`,{threadId});}
},60000);
