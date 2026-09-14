import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, gate: string, dump: string, headers: Record<string,string>;
const api = async (method:string,path:string,body?:unknown) => {
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rows=()=>existsSync(dump)?readFileSync(dump,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
describe.skipIf(process.platform==="win32")("memory refusal after an unknown submission",()=>{
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.unknown={driver:'fakeLateTerminal',environment:{FAKE_LATE_UNKNOWN_ACTION:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'unknown-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'unknown-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `});
    gate=join(fixture.info.dataDir,"unknown-gate");dump=join(fixture.info.dataDir,"unknown-dump");
    const proof=await(await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  },30000);
  afterAll(async()=>{await fixture?.close();});
  for(const room of [false,true])it(`${room?"room":"direct"}: one prompt and local action, no automatic replay`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:"Unknown action",modelSelection:{instanceId:"unknown",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Unknown room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"perform exactly one fixture action"});
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Revoke during setup"});
    writeFileSync(gate,"");
    await expect.poll(async()=>{
      const state=await api("GET","/api/bots?messages=0");
      return room?!state.groups.find((g:any)=>g.id===group.id)?.busyBotId:!state.bots.find((b:any)=>b.id===bot.id)?.busy;
    },{timeout:20000}).toBe(true);
    const receipts=rows().filter(row=>row.threadId===threadId);
    expect(receipts.filter(row=>row.prompt)).toHaveLength(1);
    expect(receipts.filter(row=>row.action)).toHaveLength(1);
    expect(receipts.filter(row=>row.skillAuthoring!==undefined)).toHaveLength(1);
    const messages=(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages;
    expect(messages.some((message:any)=>message.tool?.name?.includes("previous attempt may have started"))).toBe(true);
  },60000);
});
