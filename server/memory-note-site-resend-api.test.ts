import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { RESEND_OFFER_LINE } from "../shared/resend-offer.ts";

// D7, the NOTE site (server/index.ts turnRefusalNotes.note): a turn whose id was handed back, whose fence passed, and whose engine then refused
// without confirming a write is UNCERTAIN. Murage never sends it again by itself; the owner gets exactly ONE resend row (the approved line,
// marked for Send again) and no old uncertain card and no error row. Removing the note-site row leaves the owner with nothing.
let fixture: VerificationServer, dump: string, headers: Record<string,string>;
const api = async (method:string,path:string,body?:unknown) => {
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rows=()=>existsSync(dump)?readFileSync(dump,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
describe.skipIf(process.platform==="win32")("a refusal after a released attempt notes ONE resend row (D7 note site)",()=>{
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.afterfence={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_REFUSE_AFTER_FENCE:'1',FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'afterfence-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `});
    dump=join(fixture.info.dataDir,"afterfence-dump");
    const proof=await(await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  },30000);
  afterAll(async()=>{await fixture?.close();});
  it("direct: one resend row with the approved text, no uncertain card, no error row, no second send",async()=>{
    rmSync(dump,{force:true});
    const bot=(await api("POST","/api/bots",{name:"After fence",modelSelection:{instanceId:"afterfence",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:"say hello once"});
    const messages=async()=>(await api("GET",`/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    const isResend=(message:any)=>message.memoryNote==="resend";
    await expect.poll(async()=>(await messages()).filter(isResend).length,{timeout:20000}).toBe(1);
    // give a stray second row or a rebuild the time it would take
    await new Promise(resolve=>setTimeout(resolve,1500));
    const all=await messages();
    const resend=all.filter(isResend);
    expect(resend).toHaveLength(1);
    expect(resend[0].tool.name).toBe(RESEND_OFFER_LINE);
    expect(resend[0].tool.ok).toBe(true);
    // R3: the row names the exact message it is for, in this conversation, for this bot (Send again resolves it; nothing is guessed)
    const sent=all.filter(message=>message.role==="user");
    expect(sent).toHaveLength(1);
    expect(resend[0].resendOf).toEqual({messageId:sent[0].id,threadId:bot.threadId,botId:bot.id});
    expect(all.filter(message=>message.tool?.ok===false&&String(message.tool?.name).startsWith("error:"))).toHaveLength(0);
    expect(JSON.stringify(all)).not.toContain("The earlier submission may have started.");
    expect(JSON.stringify(all)).not.toContain("could not start this reply");
    // 1.0.19 L1: Send again is claimed once on the server (a lost answer then a reload cannot offer it again)
    const claimPath=`/api/threads/${bot.threadId}/messages/${resend[0].id}/resend-used`;
    expect(await api("POST",claimPath,{})).toEqual({claimed:true});
    expect(await api("POST",claimPath,{})).toEqual({claimed:false});
    expect((await messages()).find(isResend).resendUsed).toBe(true);
    const notResend=sent[0].id;
    expect((await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/messages/${notResend}/resend-used`,{method:"POST",headers:{"content-type":"application/json",...headers},body:"{}"})).status).toBe(404);
    // never sent again by itself: the engine saw the one turn
    expect(rows().filter(row=>row.threadId===bot.threadId&&!row.prompt)).toHaveLength(1);
  },60000);
});
