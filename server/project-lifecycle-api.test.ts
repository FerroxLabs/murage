// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture:VerificationServer, headers:Record<string,string>, memberId:string;
async function api(method:string,path:string,body?:unknown){const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json() as any};}
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    process.env.FAKE_CLAUDE_MODE='slow';process.env.FAKE_CLAUDE_REPLY_GATE=path.join(process.env.MURAGE_DATA_DIR,'tmp','close-reply');
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'groups.json'),JSON.stringify([{id:'pair-fixture',threadId:'pair-thread',name:'Pair',memberIds:[],dm:true,bulletin:'',unread:false,createdAt:1,busyBotId:null,defaultResponder:{kind:'mentions'}}]));

    const {Store}=await import(${JSON.stringify(new URL('./store.ts',import.meta.url).href)});
    const {database}=await import(${JSON.stringify(new URL('./database.ts',import.meta.url).href)});
    const {createProjectRows}=await import(${JSON.stringify(new URL('./project-new.ts',import.meta.url).href)});
    const {materializeProjectCreation}=await import(${JSON.stringify(new URL('./project-migration.ts',import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));const bot=store.createBot({name:'Signoff lead'},{seedMessages:false});
    createProjectRows(database(),{clientId:'signoff-http',purpose:'Finished',mode:'goal',members:[bot.id],leadBotId:bot.id,goal:{title:'Finished'}},[{id:bot.id,name:bot.name}],1);
    materializeProjectCreation(store,'signoff-http');database().prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE group_id='signoff-http'").run();
    const configPath=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(configPath,'utf8'));config.features={...config.features,projectsAutonomy:false};fs.writeFileSync(configPath,JSON.stringify(config));
  `});
  const proof=await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  const model=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId==="verification").models.options[0].id;
  const made=await api("POST","/api/bots",{name:"Member",modelSelection:{instanceId:"verification",model}});expect(made.status).toBe(201);memberId=made.body.bot.id;
  await api("PATCH",`/api/bots/${memberId}`,{computer:"off",browser:false,composio:false});
},30000);
afterAll(async()=>{await fixture?.close();});
it("creates, closes with a fallback, reopens paused, and ends with readable history",async()=>{
  const body={clientId:"lane-n-flow",purpose:"Synthetic project",mode:"bots",members:[memberId],leadBotId:null};
  expect((await api("GET","/api/projects/new-options")).body.members).toEqual(expect.arrayContaining([{id:memberId,name:"Member"}]));
  const made=await api("POST","/api/projects",body);expect(made.status).toBe(200);
  expect((await api("POST","/api/projects",body)).body.group.id).toBe(made.body.group.id);
  const base=`/api/groups/${made.body.group.id}`;
  expect(await api("POST",`${base}/project/close`,{})).toMatchObject({status:200,body:{summaryRequestId:null}});
  expect(await api("GET",`${base}/project`)).toMatchObject({status:200,body:{lifecycle:"closed",settings:{runState:"paused"}}});
  const messages=(await api("GET",`/api/threads/${made.body.group.threadId}/messages?limit=50`)).body.messages;
  expect(messages.some((m:any)=>m.actorKind==="murage"&&m.text?.includes("Project closed."))).toBe(true);
  expect((await api("POST",`${base}/board/cards`,{clientId:"late",title:"Late"})).status).toBe(409);
  expect(await api("POST",`${base}/project/reopen`,{})).toMatchObject({status:200,body:{settings:{closedAt:null,runState:"paused"}}});
  expect((await api("POST",`${base}/project/reopen`,{})).status).toBe(409);
  expect((await api("PATCH",base,{channelProject:null})).status).toBe(200);
  expect(await api("GET",`${base}/board`)).toMatchObject({status:200,body:{lifecycle:"ended"}});
  expect(await api("POST",`${base}/board/cards`,{clientId:"ended",title:"Late"})).toMatchObject({status:409,body:{reason:expect.stringContaining("This is a channel now")}});
  expect((await api("GET",`/api/threads/${made.body.group.threadId}/messages?limit=50`)).body.messages.length).toBeGreaterThan(0);
});
it("rejects dm lifecycle actions and unknown request fields",async()=>{
  for(const action of ["close","reopen","export-brief"])expect((await api("POST",`/api/groups/pair-fixture/project/${action}`,{})).status).toBe(404);
  expect((await api("POST","/api/projects/proposal",{purpose:"Test",extra:true})).status).toBe(400);
});

it('C1 HTTP sign-off starts a durable summary request with the goal transition',async()=>{
  const base='/api/groups/signoff-http';const project=(await api('GET',`${base}/project`)).body;
  expect(await api('PATCH',`${base}/project/goals/${project.goal.id}`,{action:'sign_off',expectedRevision:project.goal.revision})).toMatchObject({status:200,body:{goal:{state:'done'}}});
  const {DatabaseSync}=await import('node:sqlite');const {join}=await import('node:path');const db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
  try{expect(db.prepare("SELECT id FROM room_requests WHERE group_id='signoff-http' AND admission_key LIKE 'goal-close:%'").all()).toHaveLength(1);}finally{db.close();}
});
it('C3 HTTP Close fences Resume, End and Make project with the exact refusal',async()=>{
  const made=await api('POST','/api/projects',{clientId:'closing-http',purpose:'Closing',mode:'chat',members:[memberId],leadBotId:memberId});expect(made.status).toBe(200);
  const base='/api/groups/closing-http';expect((await api('POST',`${base}/project/close`,{})).status).toBe(200);
  const refusal={status:409,body:{error:'not_allowed',reason:'This project is closing.'}};
  expect(await api('POST',`${base}/project/control/resume`,{})).toEqual(refusal);
  expect(await api('PATCH',base,{channelProject:null})).toEqual(refusal);
  expect(await api('PATCH',base,{channelProject:{goal:'Again',status:'active'}})).toEqual(refusal);
  expect(await api('GET',`${base}/project`)).toMatchObject({status:200,body:{closing:true,closeStep:1}});
});
it('R1 invalid export index is 400 and a typed closed refusal is 409',async()=>{
  await api('POST','/api/projects',{clientId:'export-http',purpose:'Export',mode:'bots',members:[memberId]});
  expect(await api('POST','/api/groups/export-http/project/export-brief',{workRootIndex:0})).toEqual({status:400,body:{error:'Choose a project work folder.'}});
  await api('POST','/api/groups/export-http/project/close',{});
  expect(await api('POST','/api/groups/export-http/project/export-brief',{workRootIndex:0})).toEqual({status:409,body:{error:'not_allowed',reason:'This project is closed.'}});
});
it('R5 HTTP Close interrupts a live room turn through the real Stop path and still settles its usage',async()=>{
  // A bot of its own: the other cases leave their lead held in a gated close summary.
  const model=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;
  const bot=(await api('POST','/api/bots',{name:'Live lead',modelSelection:{instanceId:'verification',model}})).body.bot.id as string;
  await api('PATCH',`/api/bots/${bot}`,{computer:'off',browser:false,composio:false});
  const made=await api('POST','/api/projects',{clientId:'live-close-http',purpose:'Live',mode:'chat',members:[bot],leadBotId:bot});expect(made.status).toBe(200);
  const {DatabaseSync}=await import('node:sqlite');const {join}=await import('node:path');
  const read=<T,>(sql:string,...args:string[])=>{const db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});try{return db.prepare(sql).all(...args) as T[];}finally{db.close();}};
  const until=async<T,>(probe:()=>T|undefined,what:string|(()=>string))=>{for(let i=0;i<150;i++){const value=probe();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,100));}throw new Error(`timed out: ${typeof what==='string'?what:what()}`);};
  expect((await api('POST','/api/groups/live-close-http/messages',{text:'Please work on this.'})).status).toBe(202);
  const running=await until(()=>read<{id:string}>("SELECT id FROM room_requests WHERE group_id='live-close-http' AND state='running'")[0],
    ()=>'a running room turn; requests: '+JSON.stringify(read("SELECT verb,state,refusal,to_bot_id FROM room_requests WHERE group_id='live-close-http'")));
  expect((await api('POST','/api/groups/live-close-http/project/close',{})).status).toBe(200);
  const ended=await until(()=>read<{state:string}>("SELECT state FROM room_requests WHERE id=? AND state IN ('cancelled','failed','done','expired','unknown')",running.id)[0],'the live turn to end');
  expect(['cancelled','failed']).toContain(ended.state);
  await until(()=>read<{settle_key:string}>("SELECT settle_key FROM usage_ledger WHERE request_id=?",running.id)[0],
    ()=>'its usage row; ledger: '+JSON.stringify(read("SELECT settle_key,request_id,group_id,ok FROM usage_ledger"))+' request: '+JSON.stringify(read("SELECT state,dispatched_at,outcome_note FROM room_requests WHERE id=?",running.id)));
},30000);
it('C Start now with project work turned off keeps the draft goal and says why',async()=>{
  const made=await api('POST','/api/projects',{clientId:'start-off-http',purpose:'Start now',mode:'goal',members:[memberId],leadBotId:memberId,goal:{title:'Start now'},startGoal:true});
  expect(made).toMatchObject({status:200,body:{startReason:'Projects work on their own is off.'}});
  expect((await api('GET','/api/groups/start-off-http/project')).body.goal).toMatchObject({state:'draft'});
});
