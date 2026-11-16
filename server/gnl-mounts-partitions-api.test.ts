// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer, desktop: Record<string,string>;
const evidence: unknown[] = [];
// Only fixture state is seeded. Authentication, admission, guards and HTTP handlers run unchanged.
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.FAKE_CLAUDE_MODE='hang';
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 const fs=process.getBuiltinModule('node:fs');let source=fs.readFileSync(new URL(url),'utf8');
 source=source.replace('const profile = store.bot(botId);',\`const profile = store.bot(botId);
 if(profile?.name.startsWith('H1 team')){
 profile.partitionedAt=1;profile.sharedWith={mode:'all',teams:[]};
 store.taskByThread(profile.id,opts?.threadId??profile.threadId).sharedWork={teamId:fixtureTeamId('H1 source team'),createdAt:Date.now()};
 }
 if(profile?.name.startsWith('H1 project')&&!store.taskByThread(profile.id,opts?.threadId??profile.threadId).channelProjectDesk){
 const target=store.bots.find(b=>b.name==='H1 target project');
 if(target){const other=store.createGroup('H1 target project',[target.id]);database().prepare('INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)').run(other.id);store.ensureProjectDesk(target.id,other.id,other.name);}
 const group=store.createGroup('H1 source project',[profile.id]);
 database().prepare('INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)').run(group.id);
 store.taskByThread(profile.id,opts?.threadId??profile.threadId).channelProjectDesk={groupId:group.id};
 }
 \`);
 source="import {teamIdFor as fixtureTeamId} from './team-identities.ts';\\n"+source;
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;

async function api(method:string,path:string,body?:unknown,headers=desktop){
 const res=await fetch(fixture.info.url+path,{method,signal:AbortSignal.timeout(30000),headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const out={status:res.status,body:await res.json() as any};
 evidence.push({method,path,status:out.status,body:path.includes('secret')?'[redacted]':out.body?.credential?{...out.body,credential:'[redacted]'}:out.body});return out;
}
async function bot(name:string,noLimits=true){
 const instances=await api('GET','/api/instances');const model=instances.body.instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;
 const made=await api('POST','/api/bots',{name,modelSelection:{instanceId:'verification',model}});expect(made.status).toBe(201);
 const b=made.body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 if(noLimits)expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 return b;
}
async function turn(b:any,routine:boolean|'ask'=false){
 const marker='__fixture_hold_authority__ '+b.name;
 let threadId=b.threadId;
 if(routine){
 const made=await api('POST','/api/routines',{botId:b.id,name:b.name,prompt:marker,permissionMode:typeof routine==='string'?routine:'unlimited',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 threadId=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id).threadId;
 }else expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId,text:marker})).status).toBe(202);
 let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents);}catch{return false;}},{timeout:30000}).toBe(true);
 return {b,threadId,dump,auth:{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}};
}
async function noCards(t:any){const rows=(await api('GET',`/api/threads/${t.threadId}/messages?limit=200`)).body.messages;expect(rows.filter((m:any)=>m.card&&!m.card.intake&&!m.card.answered)).toEqual([]);}
async function stop(t:any){await api('POST',`/api/bots/${t.b.id}/interrupt`,{threadId:t.threadId});}
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};},120000);
afterAll(async()=>{mkdirSync('evidence/gnl-mounts-r3',{recursive:true});if(fixture)writeFileSync('evidence/gnl-mounts-r3/server.log',readFileSync(fixture.info.logPath));writeFileSync('evidence/gnl-mounts-r3/workflows.json',JSON.stringify({fixture:fixture?.info,evidence},(key,value)=>/token|secret|credential|authorization/i.test(key)?'[redacted]':value,2));await fixture?.close();});


it.each(['team','project'])('H1 owner No limits ask from %s starts an unshared target outside the source partition',async(kind)=>{
 const target=await bot('H1 target '+kind,false);
 await api('PATCH',`/api/bots/${target.id}`,{section:'H1 target team',sharedWith:{mode:'none',teams:[]}});
 const t=await turn(await bot('H1 '+kind+' source'));
 const marker='__fixture_hold_authority__ H1 target dispatched '+kind;
 try{
 const pending=api('POST','/api/internal/ask-bot',{fromBotId:t.b.id,fromThreadId:t.threadId,toBotId:target.id,message:marker},t.auth);
 let dispatched:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(l=>l.includes(marker));if(!line)return false;dispatched=JSON.parse(line);return true;}catch{return false;}},{timeout:20000}).toBe(true);
 writeFileSync(`${fixture.fixtureFinishGateDir}/${dispatched.pid}`,'finish');
 const out=await pending;expect(out.status,JSON.stringify(out.body)).toBe(200);expect(out.body.error).toBeUndefined();expect(out.body.startCode).toBeUndefined();
 await noCards(t);
 }finally{await stop(t);}
},60000);
