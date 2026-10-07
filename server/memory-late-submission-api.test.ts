// An adapter can hand its turn id back before it writes the prompt (ACP,
// Codex). The submission fence runs again right before that later write, and
// a revoke in between is refused there: nothing is written, the turn settles
// failed, and the server re-runs it once on fresh context (round 3, item 1).
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
describe.skipIf(process.platform==="win32")("memory refusal at a late submission",()=>{
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.handback={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'handback-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'handback-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `});
    gate=join(fixture.info.dataDir,"handback-gate");dump=join(fixture.info.dataDir,"handback-dump");
    const proof=await(await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  },30000);
  afterAll(async()=>{await fixture?.close();});
  for(const room of [false,true])it(`${room?"room":"direct"}: nothing is written, and the turn runs once more`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:`Handback ${room?"room":"direct"}`,modelSelection:{instanceId:"handback",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Handback room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    expect((await api("GET","/api/memory/status")).mode).toBe("active");
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"hello there"});
    // the id is back and the prompt not yet written: the revoke lands now
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke after handback"});
    writeFileSync(gate,"");
    const replies=async()=>((await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
    await expect.poll(async()=>(await replies()).some(message=>message.role==="bot"&&message.kind==="text"&&message.text==="Hello from late"),{timeout:20000}).toBe(true);
    const mine=rows().filter(row=>row.threadId===threadId);
    // two dispatches, and only the second one wrote its prompt
    expect(mine.filter(row=>!row.prompt)).toHaveLength(2);
    expect(mine.filter(row=>row.prompt)).toHaveLength(1);
    expect(mine.find(row=>row.prompt)?.turnId).toBe(mine.filter(row=>!row.prompt)[1]?.turnId);
    expect((await replies()).filter(message=>String(message.tool?.name??"").startsWith("error:")).map(message=>message.tool.name)).toEqual([]);
  },60000);
});
