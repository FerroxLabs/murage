import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_ACP=join(dirname(fileURLToPath(import.meta.url)),"testing","fake-acp-cli.ts");
const processAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}};
let fixture:VerificationServer,headers:Record<string,string>,modelOne:string,modelTwo:string;
const acpFile=(name:string)=>join(fixture.info.dataDir,`close-confirmed-${name}`);
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
    const acp=(name)=>path.join(process.env.MURAGE_DATA_DIR,'close-confirmed-'+name);
    cfg.instances.acpStop={driver:'customAcp',displayName:'Close-confirmed ACP fixture',config:{cli:${JSON.stringify(FAKE_ACP)}},environment:{FAKE_ACP_MODE:'cancel-ack',FAKE_ACP_TERM:'gate',FAKE_ACP_PID_FILE:acp('pid'),FAKE_ACP_TERM_MARK:acp('term'),FAKE_ACP_EXIT_GATE:acp('gate'),FAKE_ACP_RPC_DUMP:acp('rpc')}};
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
  expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${third.threadId}`,{modelSelection:{instanceId:"verification",model:modelOne}})).status).toBe(200);
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
const taskState=async(botId:string,threadId:string)=>(await botState(botId)).tasks.find((task:any)=>task.threadId===threadId);
it("waits for a competing working folder, keeps the message, and runs when the holder releases",async()=>{
  const bot=await create(),cwd=join(fixture.info.dataDir,"shared-project");mkdirSync(cwd);
  for(const threadId of [bot.first,bot.second])expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${threadId}`,{cwd})).status).toBe(200);
  await hold(bot.id,bot.first,"workspace-first");rmSync(join(fixture.info.dataDir,"second-dump.json"),{force:true});
  const holderTitle=(await taskState(bot.id,bot.first)).title;
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.second,text:"__fixture_hold_authority__ workspace-waiter"})).status).toBe(202);
  // Barrier: the server publishes the waiting marker only once the waiter is queued.
  await expect.poll(async()=>(await taskState(bot.id,bot.second)).waitingFor,{timeout:5000}).toEqual({resource:"working-folder",holderTitle});
  const waiting=await taskState(bot.id,bot.second);
  expect(waiting).toMatchObject({busy:true,activity:"working"});
  expect((await messages(bot.second)).some(message=>message.role==="user"&&message.text?.includes("workspace-waiter"))).toBe(true);
  expect((await messages(bot.second)).some(message=>message.tool?.ok===false)).toBe(false);
  expect(existsSync(join(fixture.info.dataDir,"second-dump.json"))).toBe(false);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first})).status).toBe(200);
  await expect.poll(()=>{try{return JSON.stringify(dump(true).prompt).includes("workspace-waiter");}catch{return false;}},{timeout:10000}).toBe(true);
  const running=await taskState(bot.id,bot.second);
  expect(running.busy).toBe(true);expect(running.waitingFor).toBeUndefined();
  expect((await messages(bot.second)).some(message=>message.tool?.name?.includes("Another thread is using"))).toBe(false);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.second})).status).toBe(200);
},30000);
it("stops a waiting thread cleanly without starting it or taking the folder",async()=>{
  const bot=await create(),cwd=join(fixture.info.dataDir,"stop-waiting-project");mkdirSync(cwd);
  const third=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Third same folder"})).body.task;
  for(const threadId of [bot.first,bot.second,third.threadId])expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${threadId}`,{cwd,modelSelection:{instanceId:threadId===bot.second?"second":"verification",model:threadId===bot.second?modelTwo:modelOne}})).status).toBe(200);
  await hold(bot.id,bot.first,"stop-waiting-holder");rmSync(join(fixture.info.dataDir,"second-dump.json"),{force:true});
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.second,text:"__fixture_hold_authority__ stopped-while-waiting"})).status).toBe(202);
  await expect.poll(async()=>(await taskState(bot.id,bot.second)).waitingFor?.resource,{timeout:5000}).toBe("working-folder");
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.second})).status).toBe(200);
  await expect.poll(async()=>(await taskState(bot.id,bot.second)).busy,{timeout:5000}).toBe(false);
  const stopped=await taskState(bot.id,bot.second);
  expect(stopped.waitingFor).toBeUndefined();expect(stopped.activity).toBe("idle");
  expect((await messages(bot.second)).filter(message=>message.tool?.ok===false)).toEqual([]);
  expect((await taskState(bot.id,bot.first)).busy).toBe(true);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first})).status).toBe(200);
  // Barrier: a fresh thread on the same folder starts at once, so the stopped
  // waiter neither leaked a claim nor took the folder when the holder left.
  await hold(bot.id,third.threadId,"after-stopped-waiter");
  expect(existsSync(join(fixture.info.dataDir,"second-dump.json"))).toBe(false);
  expect((await taskState(bot.id,bot.second)).busy).toBe(false);
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:third.threadId})).status).toBe(200);
},30000);
it("a routine run that needs a busy working folder waits and then runs instead of failing",async()=>{
  const holder=await create(),cwd=join(fixture.info.dataDir,"routine-shared-project");mkdirSync(cwd);
  expect((await api("PATCH",`/api/bots/${holder.id}/tasks/${holder.first}`,{cwd})).status).toBe(200);
  await hold(holder.id,holder.first,"routine-folder-holder");rmSync(join(fixture.info.dataDir,"second-dump.json"),{force:true});
  const routineBot=(await api("POST","/api/bots",{name:"Routine waiter fixture",modelSelection:{instanceId:"second",model:modelTwo}})).body.bot;
  expect((await api("PATCH",`/api/bots/${routineBot.id}`,{computer:"off",browser:false,composio:false,cwd})).status).toBe(200);
  const routine=(await api("POST","/api/routines",{name:"Routine waiter",prompt:"routine-waiter-prompt",botId:routineBot.id,schedule:{type:"interval",everyMinutes:60,anchorAt:Date.now()+3_600_000},enabled:false})).body.routine;
  expect(routine?.id).toBeTruthy();
  try {
    expect((await api("POST",`/api/routines/${routine.id}/run`)).status).toBe(201);
    const routineTask=async()=>(await botState(routineBot.id)).tasks.find((task:any)=>task.title==="Routine waiter");
    await expect.poll(async()=>(await routineTask())?.waitingFor?.resource,{timeout:10000}).toBe("working-folder");
    expect(existsSync(join(fixture.info.dataDir,"second-dump.json"))).toBe(false);
    expect((await messages((await routineTask()).threadId)).some(message=>message.tool?.ok===false)).toBe(false);
    expect((await api("POST",`/api/bots/${holder.id}/interrupt`,{threadId:holder.first})).status).toBe(200);
    await expect.poll(()=>{try{return JSON.stringify(dump(true).prompt).includes("routine-waiter-prompt");}catch{return false;}},{timeout:10000}).toBe(true);
    await expect.poll(async()=>(await routineTask()).busy,{timeout:10000}).toBe(false);
    expect((await messages((await routineTask()).threadId)).some(message=>message.tool?.name?.includes("Another thread is using"))).toBe(false);
  } finally { await api("DELETE",`/api/routines/${routine.id}`); }
},30000);
it("keeps a stopped ACP thread's working folder until its engine process has closed",async()=>{
  const created=(await api("POST","/api/bots",{name:"Close-confirmed stop fixture",modelSelection:{instanceId:"verification",model:modelOne}})).body.bot;
  expect((await api("PATCH",`/api/bots/${created.id}`,{computer:"off",browser:false,composio:false})).status).toBe(200);
  const shared=acpFile("project"),unrelated=acpFile("unrelated");mkdirSync(shared);mkdirSync(unrelated);
  const acpThread=created.threadId;
  expect((await api("PATCH",`/api/bots/${created.id}/tasks/${acpThread}`,{modelSelection:{instanceId:"acpStop",model:"agent-default"},cwd:shared})).status).toBe(200);
  const waiting=(await api("POST",`/api/bots/${created.id}/tasks`,{title:"Same folder"})).body.task;
  const sibling=(await api("POST",`/api/bots/${created.id}/tasks`,{title:"Unrelated folder"})).body.task;
  expect((await api("PATCH",`/api/bots/${created.id}/tasks/${waiting.threadId}`,{cwd:shared,modelSelection:{instanceId:"verification",model:modelOne}})).status).toBe(200);
  expect((await api("PATCH",`/api/bots/${created.id}/tasks/${sibling.threadId}`,{cwd:unrelated,modelSelection:{instanceId:"verification",model:modelOne}})).status).toBe(200);
  expect((await api("POST",`/api/bots/${created.id}/messages`,{threadId:acpThread,text:"close-confirmed fixture"})).status).toBe(202);
  await expect.poll(()=>{try{return readFileSync(acpFile("rpc"),"utf8").includes("session/prompt");}catch{return false;}},{timeout:10000}).toBe(true);
  const pid=Number(readFileSync(acpFile("pid"),"utf8"));
  await hold(created.id,sibling.threadId,"close-confirmed-unrelated");
  const stopping=api("POST",`/api/bots/${created.id}/interrupt`,{threadId:acpThread});
  if(process.platform!=="win32"){
    // POSIX delivers SIGTERM to a handler, so the engine can outlive its
    // termination request until the gate opens. Windows taskkill /F cannot be
    // intercepted; there only the post-close invariants below are observable.
    await expect.poll(()=>existsSync(acpFile("term")),{timeout:10000}).toBe(true);
    // The same-folder send waits (it does not fail) until the engine closes.
    expect((await api("POST",`/api/bots/${created.id}/messages`,{threadId:waiting.threadId,text:"__fixture_hold_authority__ close-confirmed-replacement"})).status).toBe(202);
    await expect.poll(async()=>(await botState(created.id)).tasks.find((task:any)=>task.threadId===waiting.threadId).waitingFor?.resource,{timeout:5000}).toBe("working-folder");
    expect(JSON.stringify(dump().prompt)).not.toContain("close-confirmed-replacement");
    expect(processAlive(pid)).toBe(true);
    writeFileSync(acpFile("gate"),"");
  }
  expect((await stopping).status).toBe(200);
  expect(processAlive(pid)).toBe(false);
  if(process.platform!=="win32")await expect.poll(()=>{try{return JSON.stringify(dump().prompt).includes("close-confirmed-replacement");}catch{return false;}},{timeout:10000}).toBe(true);
  else await hold(created.id,waiting.threadId,"close-confirmed-replacement");
  expect((await botState(created.id)).tasks.find((task:any)=>task.threadId===sibling.threadId).busy).toBe(true);
  for(const threadId of [waiting.threadId,sibling.threadId])await api("POST",`/api/bots/${created.id}/interrupt`,{threadId});
},30000);
it("routes owner defaults separately and refuses ambiguous legacy multi-thread settings",async()=>{
  const created=(await api("POST","/api/bots",{name:"Defaults fixture",modelSelection:{instanceId:"verification",model:modelOne}})).body.bot;
  await api("PATCH",`/api/bots/${created.id}`,{computer:"off"});
  expect((await api("PATCH",`/api/bots/${created.id}`,{settingsScope:"defaults",modelSelection:{instanceId:"second",model:modelTwo},autoApprove:true})).status).toBe(200);
  expect((await botState(created.id)).tasks[0]).toMatchObject({modelSelection:{instanceId:"verification",model:modelOne},autoApprove:false});
  const second=(await api("POST",`/api/bots/${created.id}/tasks`,{})).body.task;
  expect(second).toMatchObject({modelSelection:{instanceId:"verification",model:modelOne},autoApprove:true});
  expect((await api("PATCH",`/api/bots/${created.id}`,{autoApprove:false})).status).toBe(409);
  expect((await api("PATCH",`/api/bots/${created.id}`,{settingsScope:"defaults",autoApprove:false},false)).status).toBe(404);
});

it("new task retains the visible engine and model through the actual API and dispatch",async()=>{
  const bot=await create();
  const selection={instanceId:"second",model:modelTwo,effort:"high"};
  expect((await api("PATCH",`/api/bots/${bot.id}/tasks/${bot.second}`,{modelSelection:selection})).status).toBe(200);
  const created=await api("POST",`/api/bots/${bot.id}/tasks`,{});
  expect(created.status).toBe(201);
  expect(created.body.task.modelSelection).toEqual(selection);
  const state=await botState(bot.id);
  expect(state.threadId).toBe(created.body.task.threadId);
  expect(state.tasks.find((task:any)=>task.threadId===state.threadId).modelSelection).toEqual(selection);
  const invocation=await hold(bot.id,state.threadId,"inherited-selection",true);
  expect(invocation.argv).toContain(modelTwo);
  expect(invocation.argv).not.toContain("--resume");
  expect((await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:state.threadId})).status).toBe(200);
},30000);


it("dispatches pinned skill bytes through explicit references and native discovery across owner edits",async()=>{
  const bot=await create(),skillRoot=join(fixture.info.dataDir,"workspaces",bot.id,"skills","pinned-fixture"),stateRoot=join(fixture.info.dataDir,"skill-state",bot.id);
  mkdirSync(skillRoot,{recursive:true});mkdirSync(stateRoot,{recursive:true});
  const edit=(body:string)=>{
    const text=`---\nname: pinned-fixture\ndescription: Verify the pinned fixture\n---\n${body}\n`;
    writeFileSync(join(skillRoot,"SKILL.md"),text);
    writeFileSync(join(stateRoot,"skills.json"),JSON.stringify({"pinned-fixture":{description:"Verify the pinned fixture",enabled:true,source:"fixture:owner",sha256:createHash("sha256").update(text).digest("hex"),importedAt:new Date().toISOString(),warnings:[],skippedFiles:[]}}));
  };
  edit("ORIGINAL PROCEDURE");
  const first=await hold(bot.id,bot.first,"__fixture_procedure_probe__ pin-first");
  expect(first.procedureProbe.explicit).toContain("ORIGINAL PROCEDURE");expect(first.procedureProbe.native).toBe(first.procedureProbe.explicit);
  await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first});
  edit("OWNER REVISED PROCEDURE");
  const continued=await hold(bot.id,bot.first,"__fixture_procedure_probe__ pin-continued");
  expect(continued.procedureProbe.explicit).toContain("ORIGINAL PROCEDURE");expect(continued.procedureProbe.native).toBe(continued.procedureProbe.explicit);
  await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.first});
  const next=await hold(bot.id,bot.second,"__fixture_procedure_probe__ pin-next",true);
  expect(next.procedureProbe.explicit).toContain("OWNER REVISED PROCEDURE");expect(next.procedureProbe.native).toBe(next.procedureProbe.explicit);
  await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.second});
  const custom=join(fixture.info.dataDir,"procedure-custom-project");mkdirSync(custom);writeFileSync(join(custom,"owner.txt"),"untouched");
  const third=(await api("POST",`/api/bots/${bot.id}/tasks`,{})).body.task;
  await api("PATCH",`/api/bots/${bot.id}/tasks/${third.threadId}`,{cwd:custom,modelSelection:{instanceId:"verification",model:modelOne}});
  const customRun=await hold(bot.id,third.threadId,"__fixture_procedure_probe__ pin-custom");
  expect(realpathSync(customRun.procedureProbe.cwd)).toBe(realpathSync(custom));expect(customRun.procedureProbe.explicit).toContain("OWNER REVISED PROCEDURE");expect(customRun.procedureProbe.native).toBeNull();
  expect(existsSync(join(custom,".agents"))).toBe(false);expect(readFileSync(join(custom,"owner.txt"),"utf8")).toBe("untouched");
  await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:third.threadId});
},30000);
