// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SOCKET TEST: supervisor/build-box only. Runs the real index.ts ask-bot path.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let headers: Record<string,string>;
const api=async(method:string,path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
beforeAll(async()=>{
 const fake=join(dirname(fileURLToPath(import.meta.url)),"testing","fake-acp-cli.ts");
 fixture=await launchVerificationServer(process.env,undefined,{portRange:{from:47000,span:500},instrumentationSource:`const fs=await import('node:fs');const path=await import('node:path');const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(file,'utf8'));config.instances.asker={driver:'grokAgent',displayName:'Shared asker fixture',environment:{FAKE_ACP_MODE:'ask-peer'},config:{cli:${JSON.stringify(fake)},fullAuto:true}};config.instances.delegator={...config.instances.asker,environment:{FAKE_ACP_MODE:'delegate-peer'}};config.instances.creator={...config.instances.asker,environment:{FAKE_ACP_MODE:'create-peer'}};fs.writeFileSync(file,JSON.stringify(config));`});
 const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
},30000);
afterAll(async()=>{await fixture?.close();});
it("SOCKET: sync ask issues and dispatches a team row through index.ts, never the target home",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,instanceId:string,section:string)=>{const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===instanceId);const made=await api("POST","/api/bots",{name,modelSelection:{instanceId,model:instance.models.options[0].id}});expect(made.status).toBe(201);await api("PATCH",`/api/bots/${made.body.bot.id}`,{section,computer:"off",browser:false,composio:false,approvePeerComms:false});return made.body.bot;};
 const iris=await make("Iris","verification","Design"),sam=await make("Sam","asker","Sales");
 await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
 Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now()});Object.assign(bots.find((b:any)=>b.id===sam.id),{chiefOfStaff:true});writeFileSync(file,JSON.stringify(bots));await fixture.restart();
 const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 expect((await api("POST",`/api/bots/${sam.id}/messages`,{text:"Ask Iris to reply."})).status).toBe(202);
 const row=()=>{const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true});try{return db.prepare("SELECT * FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask' ORDER BY created_at DESC LIMIT 1").get(sam.id,iris.id);}finally{db.close();}};
 await expect.poll(()=>row()?.state,{timeout:60000}).toBe("done");const request=row()!;expect(request.target_thread_id).not.toBe(iris.threadId);expect(JSON.parse(String(request.execution_audience))).toMatchObject({kind:"team",rootRequestId:request.id});
 const stored=JSON.parse(readFileSync(file,"utf8")).find((b:any)=>b.id===iris.id);expect(stored.tasks.find((t:any)=>t.threadId===request.target_thread_id).sharedWork).toBeDefined();
 const home=(await api("GET",`/api/threads/${iris.threadId}/messages?limit=200`)).body.messages;expect(JSON.stringify(home)).not.toContain("ping from fake");
},90000);


it.each([
 {partitioned:true,instanceId:"asker"},{partitioned:false,instanceId:"asker"},
 {partitioned:true,instanceId:"delegator"},{partitioned:false,instanceId:"delegator"},
])("R3c C2/A2: home peer turn reaches the provider ($instanceId, partitioned=$partitioned)",async({partitioned,instanceId})=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,engine:string)=>{
  const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===engine);
  const made=await api("POST","/api/bots",{name,modelSelection:{instanceId:engine,model:instance.models.options[0].id}});expect(made.status).toBe(201);
  expect((await api("PATCH",`/api/bots/${made.body.bot.id}`,{section:"Design",computer:"off",browser:false,composio:false,approvePeerComms:false})).status).toBe(200);return made.body.bot;
 };
 const iris=await make("Iris","verification"),carl=await make("Carl",instanceId);
 if(partitioned){
  await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
  Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now()});writeFileSync(file,JSON.stringify(bots));await fixture.restart();
  const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 }
 const messages=async()=>(await api("GET",`/api/threads/${iris.threadId}/messages?limit=200`)).body.messages as any[];
 const prior=new Set((await messages()).map(m=>m.id));
 expect((await api("POST",`/api/bots/${carl.id}/messages`,{text:"Ask Iris to reply."})).status).toBe(202);
 await expect.poll(async()=>(await messages()).some(m=>!prior.has(m.id)&&m.role==="bot"&&m.kind==="text"&&!m.copyOf),{timeout:60000}).toBe(true);
 const carlSays=async()=>((await api("GET",`/api/threads/${carl.threadId}/messages?limit=200`)).body.messages as any[]).filter(m=>m.role==="bot"&&m.kind==="text").map(m=>String(m.text)).join("\n");
 await expect.poll(carlSays,{timeout:60000}).toMatch(instanceId==="asker"?/peer says:/:/delegated:/);
 expect(await carlSays()).not.toMatch(/peer error|delegate error|cannot be reached|no longer/);
 const stored=JSON.parse(readFileSync(join(fixture.info.dataDir,"bots.json"),"utf8")).find((b:any)=>b.id===iris.id);
 expect(stored.tasks.some((t:any)=>t.sharedWork)).toBe(false);
},150000);

it("R3c A2: a sync ask from a home room to a partitioned teammate delivers its answer to the room",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,engine:string)=>{
  const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===engine);
  const made=await api("POST","/api/bots",{name,modelSelection:{instanceId:engine,model:instance.models.options[0].id}});expect(made.status).toBe(201);
  expect((await api("PATCH",`/api/bots/${made.body.bot.id}`,{section:"Design",computer:"off",browser:false,composio:false,approvePeerComms:false})).status).toBe(200);return made.body.bot;
 };
 const iris=await make("Iris","verification"),carl=await make("Carl","asker");
 const room=(await api("POST","/api/groups",{name:"Design room",section:"Design",memberIds:[carl.id,iris.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:carl.id}}})).body.group;
 await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
 Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now()});writeFileSync(file,JSON.stringify(bots));await fixture.restart();
 const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Ask Iris to reply."})).status).toBeLessThan(300);
 const said=async()=>((await api("GET",`/api/threads/${room.threadId}/messages?limit=200`)).body.messages as any[]).filter(m=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===carl.id).map(m=>String(m.text)).join("\n");
 await expect.poll(said,{timeout:60000}).toMatch(/peer (says|error):/);
 expect(await said()).toMatch(/peer says:/);
 expect(await said()).not.toMatch(/peer error|cannot be reached|no longer fits/);
},150000);

it("R3c C5: an owner room send to a free member is admitted directly, never queued as not reachable",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId==="verification");
 const made=await api("POST","/api/bots",{name:"Moss",modelSelection:{instanceId:"verification",model:instance.models.options[0].id}});expect(made.status).toBe(201);
 const moss=made.body.bot;await api("PATCH",`/api/bots/${moss.id}`,{computer:"off",browser:false,composio:false});
 const room=(await api("POST","/api/groups",{name:"Moss room",memberIds:[moss.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:moss.id}}})).body.group;
 expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Please answer briefly."})).status).toBeLessThan(300);
 const thread=async()=>(await api("GET",`/api/threads/${room.threadId}/messages?limit=200`)).body.messages as any[];
 await expect.poll(async()=>(await thread()).some(m=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===moss.id),{timeout:60000}).toBe(true);
 expect((await thread()).some(m=>/is busy right now/.test(String(m.tool?.name??m.text??"")))).toBe(false);
 const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true});
 try{expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE group_id=? AND refusal='not_reachable'").get(room.id)).toMatchObject({n:0});}finally{db.close();}
},90000);

it("R3c A5: a shared result committed before a crash is delivered to the requester at the next boot",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,instanceId:string,section:string)=>{const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===instanceId);const made=await api("POST","/api/bots",{name,modelSelection:{instanceId,model:instance.models.options[0].id}});expect(made.status).toBe(201);await api("PATCH",`/api/bots/${made.body.bot.id}`,{section,computer:"off",browser:false,composio:false,approvePeerComms:false});return made.body.bot;};
 const iris=await make("Iris","verification","Design"),sam=await make("Sam","asker","Sales");
 await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
 Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now()});Object.assign(bots.find((b:any)=>b.id===sam.id),{chiefOfStaff:true});writeFileSync(file,JSON.stringify(bots));await fixture.restart();
 let proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 expect((await api("POST",`/api/bots/${sam.id}/messages`,{text:"Ask Iris to reply."})).status).toBe(202);
 const dbFile=join(fixture.info.dataDir,"messages.db");
 const row=()=>{const db=new DatabaseSync(dbFile,{readOnly:true});try{return db.prepare("SELECT * FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask' ORDER BY created_at DESC LIMIT 1").get(sam.id,iris.id);}finally{db.close();}};
 await expect.poll(()=>row()?.state,{timeout:60000}).toBe("done");const request=row()!;
 const delivered=async()=>((await api("GET",`/api/threads/${sam.threadId}/messages?limit=200`)).body.messages as any[]).filter(m=>m.requestId===request.id&&m.turnTerminal).length;
 await expect.poll(delivered,{timeout:30000}).toBe(1);
 // the process died after the request committed and before its delivery: the delivery is not on disk
 await fixture.stop();
 const db=new DatabaseSync(dbFile);try{expect(Number(db.prepare("DELETE FROM messages WHERE thread_id=? AND json_extract(json,'$.requestId')=? AND json_extract(json,'$.turnTerminal')=1").run(sam.threadId,request.id).changes)).toBe(1);
  expect(Number(db.prepare("UPDATE room_requests SET refusal=NULL WHERE id=? AND refusal='delivered'").run(request.id).changes)).toBe(1);}finally{db.close();}
 await fixture.restart();proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 await expect.poll(delivered,{timeout:30000}).toBe(1);
 await fixture.stop();await fixture.restart();proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 expect(await delivered()).toBe(1);
},150000);

it("R4d N1: a delivered shared result is marked on its row and a deleted requester thread is not brought back at boot",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,instanceId:string,section:string)=>{const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===instanceId);const made=await api("POST","/api/bots",{name,modelSelection:{instanceId,model:instance.models.options[0].id}});expect(made.status).toBe(201);await api("PATCH",`/api/bots/${made.body.bot.id}`,{section,computer:"off",browser:false,composio:false,approvePeerComms:false});return made.body.bot;};
 const iris=await make("Iris","verification","Design"),sam=await make("Sam","asker","Sales");
 const refresh=async()=>{const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;};
 await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
 Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now()});Object.assign(bots.find((b:any)=>b.id===sam.id),{chiefOfStaff:true});writeFileSync(file,JSON.stringify(bots));await fixture.restart();await refresh();
 expect((await api("POST",`/api/bots/${sam.id}/messages`,{text:"Ask Iris to reply."})).status).toBe(202);
 const dbFile=join(fixture.info.dataDir,"messages.db");
 const read=<T,>(fn:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(dbFile,{readOnly:true});try{return fn(db);}finally{db.close();}};
 const row=()=>read(db=>db.prepare("SELECT * FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask' ORDER BY created_at DESC LIMIT 1").get(sam.id,iris.id));
 await expect.poll(()=>row()?.state,{timeout:60000}).toBe("done");const request=row()!;
 await expect.poll(()=>row()?.refusal,{timeout:30000}).toBe("delivered");
 // the owner deletes the requester's conversation, and its delivery receipt with it
 const gone=sam.threadId;
 await expect.poll(async()=>(await api("DELETE",`/api/bots/${sam.id}/tasks/${gone}`)).status,{timeout:30000}).toBe(200);
 const resurrected=()=>read(db=>Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=?").get(gone)!.n));
 expect(resurrected()).toBe(0);
 await fixture.stop();
 await fixture.restart();await refresh();expect(resurrected()).toBe(0);
 // a row from before the marker existed is still never delivered to a thread nothing owns
 await fixture.stop();{const rw=new DatabaseSync(dbFile);try{rw.prepare("UPDATE room_requests SET refusal=NULL WHERE id=?").run(request.id);}finally{rw.close();}}
 await fixture.restart();await refresh();expect(resurrected()).toBe(0);
},150000);

it("L1: a shared lead working for Sales cannot create a bot through the real create-bot route; at home it can",async()=>{
 for(const b of (await api("GET","/api/bots?messages=0")).body.bots)await api("PATCH",`/api/bots/${b.id}`,{hidden:true});
 const make=async(name:string,instanceId:string,section:string)=>{const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId===instanceId);const made=await api("POST","/api/bots",{name,modelSelection:{instanceId,model:instance.models.options[0].id}});expect(made.status).toBe(201);await api("PATCH",`/api/bots/${made.body.bot.id}`,{section,computer:"off",browser:false,composio:false,approvePeerComms:false});return made.body.bot;};
 const iris=await make("Iris","creator","Design");await make("Sam","verification","Sales");
 await fixture.stop();const file=join(fixture.info.dataDir,"bots.json"),bots=JSON.parse(readFileSync(file,"utf8"));
 Object.assign(bots.find((b:any)=>b.id===iris.id),{sharedWith:{mode:"all",teams:[]},partitionedAt:Date.now(),chiefOfStaff:true});writeFileSync(file,JSON.stringify(bots));await fixture.restart();
 const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers["x-murage-surface-secret"]=proof.secret;
 const opened=await api("POST",`/api/bots/${iris.id}/work-threads`,{teamName:"Sales"});expect(opened.status).toBe(200);
 const work=opened.body.threadId as string;
 const said=async(threadId:string)=>((await api("GET",`/api/threads/${threadId}/messages?limit=200`)).body.messages as any[]).filter(m=>m.role==="bot"&&m.kind==="text").map(m=>String(m.text)).join("\n");
 const pixels=async()=>((await api("GET","/api/bots?messages=0")).body.bots as any[]).filter(b=>b.name==="Pixel"&&!b.hidden).length;
 expect((await api("POST",`/api/bots/${iris.id}/messages`,{text:"Make a designer for this work.",threadId:work})).status).toBe(202);
 await expect.poll(()=>said(work),{timeout:60000}).toMatch(/create error:|team created:/);
 expect(await said(work)).toMatch(/create error: .*Manage bots from Iris's own team\./);
 expect(await pixels()).toBe(0);
 // the same call from Iris's own home thread goes through
 const home=async()=>{const sent=await api("POST",`/api/bots/${iris.id}/messages`,{text:"Make a designer.",threadId:iris.threadId});return sent.status===202?202:`${sent.status} ${JSON.stringify(sent.body)}`;};
 await expect.poll(home,{timeout:30000,interval:1000}).toBe(202);
 await expect.poll(()=>said(iris.threadId),{timeout:60000}).toMatch(/create error:|team created:/);
 expect(await said(iris.threadId)).toMatch(/team created:/);
 expect(await pixels()).toBe(1);
},150000);
