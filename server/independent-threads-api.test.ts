import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture:VerificationServer,headers:Record<string,string>,modelOne:string,modelTwo:string;
const sockets:Socket[]=[];
const api=async(method:string,path:string,body?:unknown,owner=true)=>{
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...(owner?headers:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
};
const botState=async(id:string)=>(await api("GET","/api/bots?messages=0")).body.bots.find((bot:any)=>bot.id===id);
const messages=async(threadId:string)=>(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const dump=(second=false)=>JSON.parse(readFileSync(second?join(fixture.info.dataDir,"second-dump.json"):fixture.fixtureDumpPath,"utf8"));
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.second={...cfg.instances.verification,displayName:'Second isolated account',environment:{FAKE_CLAUDE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'second-dump.json')}};
    fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  `});
  const proof=await api("GET","/api/desktop-secret",undefined,false);headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
  const engines=(await api("GET","/api/instances")).body.instances;
  const models=engines.find((engine:any)=>engine.instanceId==="verification").models.options;
  modelOne=models[0].id;modelTwo=models[1]?.id??models[0].id;
},30000);
afterAll(async()=>{for(const socket of sockets)socket.destroy();await fixture?.close();});
async function create(){
  const created=await api("POST","/api/bots",{name:"Independent threads fixture",modelSelection:{instanceId:"verification",model:modelOne}});
  expect(created.status).toBe(201);const bot=created.body.bot;
  expect((await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false})).status).toBe(200);
  const second=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Second thread"})).body.task;
  expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${second.threadId}`,{modelSelection:{instanceId:"second",model:modelTwo},autoApprove:false})).status).toBe(200);
  return {id:bot.id,first:bot.threadId,second:second.threadId};
}
async function hold(id:string,threadId:string,label:string,second=false){
  expect((await api("POST",`/api/bots/${id}/messages`,{threadId,text:`__fixture_hold_authority__ ${label}`})).status).toBe(202);
  await expect.poll(()=>{try{return JSON.stringify(dump(second).prompt).includes(label);}catch{return false;}},{timeout:10000}).toBe(true);
  return dump(second);
}
it("runs distinct models/accounts concurrently, enforces three, and stops exactly one thread",async()=>{
  const bot=await create();
  const first=await hold(bot.id,bot.first,"first-independent");
  const second=await hold(bot.id,bot.second,"second-independent",true);
  expect(first.pid).not.toBe(second.pid);expect(first.argv).toContain(modelOne);expect(second.argv).toContain(modelTwo);
  const third=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Third"})).body.task;
  await hold(bot.id,third.threadId,"third-independent");
  const fourth=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Fourth"})).body.task;
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{threadId:fourth.threadId,text:"fourth must not launch"})).status).toBe(409);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{})).status).toBe(409);
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{text:"ambiguous"})).status).toBe(409);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:"wrong-thread"})).status).toBe(404);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first})).status).toBe(200);
  const state=await botState(bot.id);
  expect(state.tasks.find((task:any)=>task.threadId===bot.first).busy).toBe(false);
  expect(state.tasks.find((task:any)=>task.threadId===bot.second).busy).toBe(true);
  expect(state.tasks.find((task:any)=>task.threadId===third.threadId).busy).toBe(true);
  expect((await messages(bot.second)).some(message=>message.text?.includes("second-independent"))).toBe(true);
  for(const threadId of [bot.second,third.threadId])expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId})).status).toBe(200);
},30000);
it("keeps simultaneous approval requests on their owning thread and provider",async()=>{
  const bot=await create();const first=await hold(bot.id,bot.first,"approval-first"),second=await hold(bot.id,bot.second,"approval-second",true);
  const a=connect(first.mcpConfig.mcpServers.muragebox.args.at(-1)),b=connect(second.mcpConfig.mcpServers.muragebox.args.at(-1));sockets.push(a,b);
  await Promise.all([once(a,"connect"),once(b,"connect")]);
  let replyA="",replyB="";a.on("data",bytes=>replyA+=bytes);b.on("data",bytes=>replyB+=bytes);
  a.write(JSON.stringify({t:"ask",id:"first-ask",tool:"Bash",input:{command:"rm ./NEVER_EXECUTED_FIRST_FIXTURE"}})+"\n");
  b.write(JSON.stringify({t:"ask",id:"second-ask",tool:"Bash",input:{command:"rm ./NEVER_EXECUTED_SECOND_FIXTURE"}})+"\n");
  const pending=async(thread:string)=>(await messages(thread)).find(message=>message.card?.requestId&&!message.card.answered);
  await expect.poll(async()=>Boolean(await pending(bot.first))&&Boolean(await pending(bot.second)),{timeout:5000}).toBe(true);
  const cardA=(await pending(bot.first)).card,cardB=(await pending(bot.second)).card;
  expect((await api("POST",`/api/bots/${bot.id}/respond`,{requestId:cardA.requestId,behavior:"deny"})).status).toBe(409);
  expect((await api("POST",`/api/bots/${bot.id}/respond`,{threadId:bot.first,requestId:cardB.requestId,behavior:"deny"})).body.outcome).toBe("unavailable");
  expect((await api("POST",`/api/bots/${bot.id}/respond`,{threadId:bot.first,requestId:cardA.requestId,behavior:"deny"})).status).toBe(200);
  await expect.poll(()=>replyA.length>0).toBe(true);expect(replyB).toBe("");expect(await pending(bot.second)).toBeTruthy();
  for(const threadId of [bot.first,bot.second])await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId});
},30000);
it("refuses a competing working-directory launch without touching its peer's run",async()=>{
  const bot=await create(),cwd=join(fixture.info.dataDir,"shared-project");mkdirSync(cwd);
  for(const threadId of [bot.first,bot.second])expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${threadId}`,{cwd})).status).toBe(200);
  await hold(bot.id,bot.first,"workspace-first");rmSync(join(fixture.info.dataDir,"second-dump.json"),{force:true});
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.second,text:"competing workspace"})).status).toBe(202);
  await expect.poll(async()=>(await messages(bot.second)).some(message=>message.tool?.name?.includes("Another thread is using this working folder")),{timeout:5000}).toBe(true);
  expect(existsSync(join(fixture.info.dataDir,"second-dump.json"))).toBe(false);
  expect((await botState(bot.id)).tasks.find((task:any)=>task.threadId===bot.first).busy).toBe(true);
  await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first});
},30000);
