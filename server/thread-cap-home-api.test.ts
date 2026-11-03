// U4 S1 on a 4 GB size: the home guard is 2 threads across every bot. A queued owner batch drained at a full home is never refused:
// it waits for a slot and starts when one frees, with no "could not start" line.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture:VerificationServer,headers:Record<string,string>,modelOne:string,modelTwo:string;
const api=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
};
const ownerDump=()=>join(fixture.info.dataDir,"second-dump.json");
const dumped=(second:boolean,label:string)=>{try{return JSON.stringify(JSON.parse(readFileSync(second?ownerDump():fixture.fixtureDumpPath,"utf8")).prompt).includes(label);}catch{return false;}};
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const os=await import('node:os');os.default.totalmem=()=>4*1024**3;(await import('node:module')).syncBuiltinESMExports();
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.second={...cfg.instances.verification,displayName:'Second isolated account',environment:{FAKE_CLAUDE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'second-dump.json')}};
    fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  `});
  headers={};
  const proof=await api("GET","/api/desktop-secret");headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
  const models=(await api("GET","/api/instances")).body.instances.find((engine:any)=>engine.instanceId==="verification").models.options;
  modelOne=models[0].id;modelTwo=models[1]?.id??models[0].id;
},30000);
afterAll(async()=>{await fixture?.close();});
async function bot(name:string,instanceId:string,model:string){
  const created=await api("POST","/api/bots",{name,modelSelection:{instanceId,model}});expect(created.status).toBe(201);
  expect((await api("PATCH",`/api/bots/${created.body.bot.id}`,{computer:"off",browser:false,composio:false})).status).toBe(200);
  return created.body.bot as {id:string;threadId:string};
}
async function hold(botId:string,threadId:string,label:string,second:boolean){
  expect((await api("POST",`/api/bots/${botId}/messages`,{threadId,text:`__fixture_hold_authority__ ${label}`})).status).toBe(202);
  await expect.poll(()=>dumped(second,label),{timeout:30000}).toBe(true);
}
it("on a 4 GB size, a queued owner batch at a full home across two bots waits for a slot and starts, never refused",async()=>{
  expect((await api("GET","/api/config")).body.threads).toEqual({perBot:null,homeGuard:2});
  const alpha=await bot("Home guard alpha","second",modelTwo),beta=await bot("Home guard beta","verification",modelOne);
  await hold(alpha.id,alpha.threadId,"u4s1-home-alpha",true);await hold(beta.id,beta.threadId,"u4s1-home-beta",false);
  const queued=await api("POST",`/api/bots/${alpha.id}/messages`,{threadId:alpha.threadId,text:"__fixture_hold_authority__ u4s1-home-queued-owner"});
  expect(queued.status).toBe(202);expect(queued.body.queued).toBe(true);
  rmSync(ownerDump(),{force:true});
  try{
    expect((await api("POST",`/api/bots/${alpha.id}/interrupt`,{threadId:alpha.threadId})).status).toBe(200);
    await expect.poll(()=>dumped(true,"u4s1-home-queued-owner"),{timeout:15000,interval:25}).toBe(true);
    const lines=(await api("GET",`/api/threads/${alpha.threadId}/messages?limit=100`)).body.messages as any[];
    expect(lines.some(message=>message.tool?.ok===false&&String(message.tool?.name).includes("queued message could not start"))).toBe(false);
  }finally{
    for(const [id,threadId] of [[alpha.id,alpha.threadId],[beta.id,beta.threadId]]] as const)await api("POST",`/api/bots/${id}/interrupt`,{threadId});
  }
},60000);
