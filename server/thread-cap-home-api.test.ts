// U4 S1 on a 4 GB size: the home guard is 2 threads across every bot. A queued owner batch drained at a full home is never refused,
// and the slot its thread's turn frees is its own: a routine waiting for a slot is still waiting when it starts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture:VerificationServer,headers:Record<string,string>,modelOne:string;
const api=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
};
const FAKE_ACP=join(dirname(fileURLToPath(import.meta.url)),"testing","fake-acp-cli.ts");
const dumped=(label:string)=>{try{return JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8")).prompt).includes(label);}catch{return false;}};
// the owner's thread runs on an engine that cannot be steered (no interjection), so a send into its running turn really queues
const acpPrompted=(label:string)=>{try{return readFileSync(join(fixture.info.dataDir,"u4s1-queue-rpc"),"utf8").split("\n").some(line=>line.includes("session/prompt")&&line.includes(label));}catch{return false;}};
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const os=await import('node:os');os.default.totalmem=()=>4*1024**3;(await import('node:module')).syncBuiltinESMExports();
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.acpQueue={driver:'customAcp',displayName:'Queueing ACP fixture',config:{cli:${JSON.stringify(FAKE_ACP)}},environment:{FAKE_ACP_MODE:'cancel-ack',FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'u4s1-queue-rpc')}};
    fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  `});
  headers={};
  const proof=await api("GET","/api/desktop-secret");headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
  const models=(await api("GET","/api/instances")).body.instances.find((engine:any)=>engine.instanceId==="verification").models.options;
  modelOne=models[0].id;
},30000);
afterAll(async()=>{await fixture?.close();});
async function bot(name:string,instanceId:string,model:string){
  const created=await api("POST","/api/bots",{name,modelSelection:{instanceId,model}});expect(created.status).toBe(201);
  expect((await api("PATCH",`/api/bots/${created.body.bot.id}`,{computer:"off",browser:false,composio:false})).status).toBe(200);
  return created.body.bot as {id:string;threadId:string};
}
async function hold(botId:string,threadId:string,label:string){
  expect((await api("POST",`/api/bots/${botId}/messages`,{threadId,text:`__fixture_hold_authority__ ${label}`})).status).toBe(202);
  await expect.poll(()=>dumped(label),{timeout:30000}).toBe(true);
}
it("on a 4 GB size, a queued owner batch at a full home starts ahead of a routine waiting for a slot, never refused",async()=>{
  expect((await api("GET","/api/config")).body.threads).toEqual({perBot:null,homeGuard:2});
  const alpha=await bot("Home guard alpha","acpQueue","agent-default"),beta=await bot("Home guard beta","verification",modelOne),gamma=await bot("Home guard gamma","verification",modelOne);
  expect((await api("POST",`/api/bots/${alpha.id}/messages`,{threadId:alpha.threadId,text:"u4s1-home-alpha"})).status).toBe(202);
  await expect.poll(()=>acpPrompted("u4s1-home-alpha"),{timeout:15000}).toBe(true);
  await hold(beta.id,beta.threadId,"u4s1-home-beta");
  // the home is full (2 of 2): a routine on a third bot waits for a slot
  const routine=(await api("POST","/api/routines",{name:"Home guard routine",prompt:"__fixture_hold_authority__ u4s1-home-routine",botId:gamma.id,schedule:{type:"interval",everyMinutes:60,anchorAt:Date.now()+3_600_000},enabled:false})).body.routine;
  const run=await api("POST",`/api/routines/${routine.id}/run`);expect(run.status).toBe(201);
  const routineTask=async()=>(await api("GET","/api/bots?messages=0")).body.bots.find((item:any)=>item.id===gamma.id)?.tasks?.find((item:any)=>item.title==="Home guard routine");
  try{
    await expect.poll(async()=>(await routineTask())?.waitingFor,{timeout:10000}).toEqual({resource:"thread-slot"});
    const queued=await api("POST",`/api/bots/${alpha.id}/messages`,{threadId:alpha.threadId,text:"u4s1-home-queued-owner"});
    expect(queued.status).toBe(202);expect(queued.body,JSON.stringify(queued.body)).toMatchObject({queued:true});
    // alpha's turn ends: the one freed slot is wanted by the routine in line and by the owner's drained batch
    expect((await api("POST",`/api/bots/${alpha.id}/interrupt`,{threadId:alpha.threadId})).status).toBe(200);
    await expect.poll(()=>acpPrompted("u4s1-home-queued-owner"),{timeout:15000,interval:25}).toBe(true);
    // order: the owner's words took it; the routine still waits and never reached its engine
    expect((await routineTask())?.waitingFor).toEqual({resource:"thread-slot"});
    expect(dumped("u4s1-home-routine")).toBe(false);
    const lines=(await api("GET",`/api/threads/${alpha.threadId}/messages?limit=100`)).body.messages as any[];
    expect(lines.some(message=>message.tool?.ok===false&&String(message.tool?.name).includes("queued message could not start"))).toBe(false);
  }finally{
    await api("POST",`/api/routine-runs/${run.body.run.id}/cancel`);
    for(const [id,threadId] of [[alpha.id,alpha.threadId],[beta.id,beta.threadId]] as const)await api("POST",`/api/bots/${id}/interrupt`,{threadId});
    await api("DELETE",`/api/routines/${routine.id}`);
  }
},60000);
