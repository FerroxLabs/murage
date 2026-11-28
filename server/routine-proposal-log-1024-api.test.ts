// SPDX-License-Identifier: AGPL-3.0-or-later
// 1024 hygiene (S09): a routine proposal from a No limits conversation files its owner card and logs nothing per proposal.
// q1024-weakfix: the removed `[no-limits] routine proposal capacity ...` line is witnessed on a booted server (real route, real log file).
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {launchVerificationServer,runControlMurage,type VerificationServer} from '../scripts/control-murage.ts';
import {withTurnSecrets} from './testing/fixture-dump.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,desktop:Record<string,string>;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json() as any};
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{dumpLog:true,instrumentationSource:"process.env.FAKE_CLAUDE_MODE='hang';process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';"});
 const secret=(await api('GET','/api/desktop-secret',undefined,{})).body.secret;
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':secret};
 expect(await runControlMurage(['doctor','--url',fixture.info.url])).toMatchObject({ok:true});
},120000);
afterAll(async()=>{if(fixture)await fixture.close();});
it('H6 a routine proposal on a No limits thread is filed and the server logs no per-proposal capacity line',async()=>{
 const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
 const b=(await api('POST','/api/bots',{name:'H6 proposal log',modelSelection:{instanceId:'verification',model:instance.models.options[0].id}})).body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const prompt='__fixture_hold_authority__ H6-proposal-log';
 const routine=await api('POST','/api/routines',{botId:b.id,name:'H6 host',prompt,enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});
 expect(routine.status).toBe(201);
 const started=await api('POST',`/api/routines/${routine.body.routine.id}/run`,{});expect(started.status).toBe(201);
 let auth:Record<string,string>|undefined,threadId:string|undefined;
 try{
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(prompt));if(!line)return false;const token=withTurnSecrets(JSON.parse(line)).mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;if(!token)return false;auth={authorization:'Bearer '+token};return true;}catch{return false;}},{timeout:30000}).toBe(true);
  threadId=(await api('GET','/api/routines')).body.runs.find((row:any)=>row.id===started.body.run.id)?.threadId;expect(threadId).toBeTruthy();
  const proposal=await api('POST','/api/internal/routine-requests',{fromBotId:b.id,fromThreadId:threadId,action:'create',routine:{name:'H6 proposed',instructions:'Inert fixture work',schedule:{type:'interval',everyMinutes:60}}},auth);
  expect(proposal.status,JSON.stringify(proposal.body)).toBe(201);
  // the proposal reached the changed branch (it was filed), and the log never named it
  expect((await api('GET','/api/routines')).body.routines.some((row:any)=>row.name==='H6 proposed')).toBe(true);
  expect(readFileSync(fixture.info.logPath,'utf8')).not.toContain('routine proposal capacity');
 }finally{if(threadId)await api('POST',`/api/bots/${b.id}/interrupt`,{threadId});}
},90000);
