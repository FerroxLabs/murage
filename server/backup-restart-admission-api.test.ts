import { randomUUID } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll,afterAll,expect,it } from "vitest";
import { launchVerificationServer,type VerificationServer } from "../scripts/control-murage.ts";
let fixture:VerificationServer,headers:Record<string,string>;
async function api(method:string,path:string,body?:unknown){const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json() as any};}
beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs');const path=await import('node:path');const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL("./drivers/builtIn.ts",import.meta.url).href)});
    const driver=BUILT_IN_DRIVERS.find(item=>item.driverKind==='claudeAgent'),create=driver.create;
    driver.create=async function(input){const instance=await create.call(this,input),stop=instance.adapter.interruptTurn.bind(instance.adapter);instance.adapter.interruptTurn=async(...args)=>{fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'backup-interrupts.log'),'interrupt\\n');return stop(...args);};return instance;};
  `});
  const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json() as {secret:string};headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
},30000);
afterAll(async()=>{await fixture?.close();});
it("owner idle claim blocks direct and room dispatch; cancel reopens; busy preparation never interrupts",async()=>{
  const instance=(await api("GET","/api/instances")).body.instances.find((item:any)=>item.instanceId==="verification");
  const bot=(await api("POST","/api/bots",{name:"Backup restart fixture",modelSelection:{instanceId:"verification",model:instance.models.options[0].id}})).body.bot;
  await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
  const group=(await api("POST","/api/groups",{name:"Backup room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).body.group;
  const unauth=await fetch(fixture.info.url+"/api/backup-restart",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"prepare",token:randomUUID()})});expect([403,404]).toContain(unauth.status);
  const token=randomUUID();expect((await api("POST","/api/backup-restart",{action:"prepare",token})).status).toBe(200);
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{text:"Must not dispatch"})).status).toBe(409);
  expect((await api("POST",`/api/groups/${group.id}/messages`,{text:"Must not dispatch room"})).status).toBe(409);
  expect((await api("POST","/api/backup-restart",{action:"cancel",token:randomUUID()})).status).toBe(409);
  expect((await api("POST","/api/backup-restart",{action:"cancel",token})).body.released).toBe(true);
  expect((await api("POST",`/api/bots/${bot.id}/messages`,{text:"__fixture_hold_authority__ backup admission"})).status).toBe(202);
  await expect.poll(async()=>(await api("GET","/api/bots?messages=0")).body.bots.find((item:any)=>item.id===bot.id).busy).toBe(true);
  expect((await api("POST","/api/backup-restart",{action:"prepare",token:randomUUID()})).status).toBe(409);
  expect(existsSync(join(fixture.info.dataDir,"backup-interrupts.log"))?readFileSync(join(fixture.info.dataDir,"backup-interrupts.log"),"utf8"):"").toBe("");
  expect((await api("GET","/api/bots?messages=0")).body.bots.find((item:any)=>item.id===bot.id).busy).toBe(true);
  await api("POST",`/api/bots/${bot.id}/interrupt`,{});
},20000);
