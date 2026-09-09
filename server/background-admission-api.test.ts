import { afterAll,beforeAll,expect,it } from "vitest";
import { existsSync,readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer,type VerificationServer } from "../scripts/control-murage.ts";

let fixture:VerificationServer,headers:Record<string,string>={};
const api=async(method:string,path:string,body?:unknown,owner=true)=>{
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...(owner?headers:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
};
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`const path=await import('node:path');process.env.FAKE_CLAUDE_MODE='slow';process.env.FAKE_CLAUDE_REPLY_GATE=path.join(process.env.MURAGE_DATA_DIR,'release-reply');`});const proof=await api("GET","/api/desktop-secret",undefined,false);headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};},30000);
afterAll(async()=>{await fixture?.close();});
it("pauses automatic admission through the real owner API while manual work remains available",async()=>{
  expect((await api("GET","/api/automation-admission",undefined,false)).status).toBe(404);
  expect((await api("POST","/api/automation-admission",{paused:true},false)).status).toBe(404);
  expect((await api("POST","/api/automation-admission",{paused:true}))).toMatchObject({status:200,body:{paused:true}});
  expect((await api("GET","/api/automation-admission")).body.paused).toBe(true);
  const bot=(await api("POST","/api/bots",{name:"Paused automation fixture"})).body.bot;
  await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
  // Past-due once schedules are explicitly supported by initialOccurrence.
  // runNow invokes tick, so this exercises the paused schedule callback now.
  const created=await api("POST","/api/routines",{botId:bot.id,name:"Paused schedule",prompt:"Offline fixture manual and scheduled work",schedule:{type:"once",at:Date.now()-1000}});
  expect(created.status).toBe(201);const routine=created.body.routine;
  const manual=await api("POST",`/api/routines/${routine.id}/run`,{});expect(manual.status).toBe(201);
  const runs=async()=>(await api("GET","/api/routines")).body.runs.filter((run:any)=>run.routineId===routine.id);
  await expect.poll(()=>existsSync(fixture.fixtureDumpPath),{timeout:10000}).toBe(true);
  const pid=JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8")).pid;
  expect((await api("PUT","/api/config",{automationsPaused:true})).status).toBe(200);
  expect(()=>process.kill(pid,0)).not.toThrow();expect((await runs()).find((run:any)=>run.id===manual.body.run.id)?.status).toBe("running");
  writeFileSync(join(fixture.info.dataDir,"release-reply"),"release only this fixture");
  await expect.poll(async()=>(await runs()).find((run:any)=>run.id===manual.body.run.id)?.status,{timeout:10000}).toBe("completed");
  expect(await runs()).toHaveLength(1);expect((await runs())[0].triggerSource).toBe("manual");
  expect((await api("POST","/api/automation-admission",{paused:false}))).toMatchObject({status:200,body:{paused:false}});
  await expect.poll(async()=>(await runs()).find((run:any)=>run.triggerSource==="schedule")?.status,{timeout:15000}).toBe("completed");
  expect(await runs()).toHaveLength(2);
},30000);
