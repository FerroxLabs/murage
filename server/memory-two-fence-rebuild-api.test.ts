import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// 1.0.19 D3, through the real boundary and the real rebuild path (server/index.ts): an engine whose launch fence passed (the process started,
// no prompt bytes sent: proven unwritten by id) and whose prompt's own second fence is then refused by a revoke is proven unwritten as a whole.
// The turn rebuilds and the prompt reaches the engine exactly once; it is never left sitting, and never sent twice.
let fixture: VerificationServer, gate: string, dump: string, headers: Record<string,string>;
const api = async (method:string,path:string,body?:unknown) => {
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rows=()=>existsSync(dump)?readFileSync(dump,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
describe.skipIf(process.platform==="win32")("a refused second fence after an unwritten launch rebuilds the turn (D3)",()=>{
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver({ fencedDefaults: true }));
      // Epoch witness: a rebuild's own view wait (RecallReadiness.rebuildAccess) is held at its start while 'rebuild-view-gate' is armed.
      const {RecallReadiness,RecallViewNotReady}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/memory/recall-readiness.ts")).href)});
      const rebuildAccess=RecallReadiness.prototype.rebuildAccess, viewGate=path.join(process.env.MURAGE_DATA_DIR,'rebuild-view-gate');
      RecallReadiness.prototype.rebuildAccess=async function(...args){
        // Terminal fallback witness: the rebuild's view wait ends as if REBUILD_VIEW_WAIT_MS passed with no view.
        if(fs.existsSync(viewGate+'.expire')){fs.rmSync(viewGate+'.expire');throw new RecallViewNotReady(2000);}
        if(fs.existsSync(viewGate+'.armed')){fs.rmSync(viewGate+'.armed');fs.writeFileSync(viewGate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(viewGate)){clearInterval(poll);resolve();}},5);});}
        return rebuildAccess.apply(this,args);
      };
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.accepted={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_ACCEPTED_RELAUNCH:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'twofence-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'twofence-dump')}};
      cfg.instances.twofence={driver:'fakeLateTerminal',environment:{FAKE_LATE_TWO_FENCES:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'twofence-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'twofence-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `});
    gate=join(fixture.info.dataDir,"twofence-gate");dump=join(fixture.info.dataDir,"twofence-dump");
    const proof=await(await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  },30000);
  afterAll(async()=>{await fixture?.close();});
  for(const room of [false,true])it(`${room?"room":"direct"}: rebuilt once, the prompt is sent exactly once`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:"Two fences",modelSelection:{instanceId:"twofence",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Two fences room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"send this exactly once"});
    // the launch fence passed and the engine holds the turn before its prompt's own fence
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    // Revoke during setup: a team move changes authority (a single fresh owner task no longer does, memory/policy.ts).
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke between the fences"});
    writeFileSync(gate,"");
    await expect.poll(()=>rows().filter(row=>row.prompt).length,{timeout:20000}).toBe(1);
    await expect.poll(async()=>{
      const state=await api("GET","/api/bots?messages=0");
      return room?!state.groups.find((g:any)=>g.id===group.id)?.busyBotId:!state.bots.find((b:any)=>b.id===bot.id)?.busy;
    },{timeout:20000}).toBe(true);
    const receipts=rows().filter(row=>row.threadId===threadId);
    // two engine calls: the refused one (no prompt) and the rebuild; one prompt only
    expect(receipts.filter(row=>!row.prompt)).toHaveLength(2);
    expect(receipts.filter(row=>row.prompt)).toHaveLength(1);
    const messages=(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages;
    expect(messages.some((message:any)=>String(message.text??message.content??"").includes("Hello from late"))).toBe(true);
    expect(messages.some((message:any)=>message.tool?.name?.includes("The earlier submission may have started."))).toBe(false);
  },60000);
  // R3 (Astra 2): an ACCEPTED turn that is entirely unwritten, relaunched, fails its second fence. The launch attempt must be settled before the
  // refusal is classified, or the late refusal reads "a prior submission was released" and the turn gets the no-rebuild ticket (a resend offer, no rebuild).
  for(const room of [false,true])it(`${room?"room":"direct"}: an accepted, entirely unwritten turn that fails its second fence on a relaunch is rebuilt (redispatch allowed)`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:"Accepted relaunch",modelSelection:{instanceId:"accepted",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Accepted relaunch room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"rebuild me once"});
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke between the fences"});
    writeFileSync(gate,"");
    await expect.poll(()=>rows().filter(row=>row.prompt).length,{timeout:20000}).toBe(1);
    const receipts=rows().filter(row=>row.threadId===threadId);
    expect(receipts.filter(row=>!row.prompt)).toHaveLength(2);
    expect(receipts.filter(row=>row.prompt)).toHaveLength(1);
    const messages=(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages;
    expect(messages.some((message:any)=>String(message.text??message.content??"").includes("Hello from late"))).toBe(true);
    expect(messages.filter((message:any)=>message.memoryNote==="resend")).toHaveLength(0);
  },60000);
  // MA-REBUILD ruling (A), deterministic: the rebuild is held INSIDE its own view wait while the thread's replay epoch is bumped.
  // The rebuild captures its replay proof only after that wait, so the bump is already in the proof: it is rebuilt once, its prompt is
  // sent once, and no write is refused send-replay-changed. A proof captured before the wait is stale by then.
  it("direct: the rebuild captures its replay proof after its view wait, so an epoch bump during the wait refuses nothing",async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const viewGate=join(fixture.info.dataDir,"rebuild-view-gate");
    const bot=(await api("POST","/api/bots",{name:"Epoch wait",modelSelection:{instanceId:"twofence",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const logFrom=readFileSync(fixture.info.logPath,"utf8").length;
    const epoch=()=>{ const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true}); try { return Number((db.prepare("SELECT revision FROM send_replay_epochs WHERE thread_id=?").get(bot.threadId) as any)?.revision ?? 0); } finally { db.close(); } };
    await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:"epoch moves while the rebuild waits"});
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    writeFileSync(`${viewGate}.armed`,"");
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke between the fences"});
    writeFileSync(gate,"");
    // the rebuild is in its view wait: nothing more has reached the engine
    await expect.poll(()=>existsSync(`${viewGate}.waiting`),{timeout:15000}).toBe(true);
    expect(rows().filter(row=>row.threadId===bot.threadId&&row.prompt)).toHaveLength(0);
    // the thread's replay ancestry moves while the rebuild waits (the bump a revoke settle or a row write makes, branch-store.ts), forced here
    const before=epoch();
    { const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db")); try { db.exec("PRAGMA busy_timeout=5000"); db.prepare("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id=?").run(bot.threadId); } finally { db.close(); } }
    expect(epoch()).toBe(before+1);
    writeFileSync(viewGate,"");
    await expect.poll(()=>rows().filter(row=>row.threadId===bot.threadId&&row.prompt).length,{timeout:20000}).toBe(1);
    await expect.poll(async()=>!(await api("GET","/api/bots?messages=0")).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:20000}).toBe(true);
    const mine=rows().filter(row=>row.threadId===bot.threadId);
    expect(mine.filter(row=>!row.prompt)).toHaveLength(2);
    expect(mine.filter(row=>row.prompt)).toHaveLength(1);
    const served=readFileSync(fixture.info.logPath,"utf8").slice(logFrom);
    expect(served).not.toContain("send-replay-changed");
    expect(served).not.toContain(`thread ${bot.threadId}; re-preparing (2 of 2)`);
    const messages=(await api("GET",`/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    expect(messages.some((message:any)=>String(message.text??message.content??"").includes("Hello from late"))).toBe(true);
  },60000);
  // Terminal fallback (Astra), both routes: a rebuild whose own view never comes in time takes the last resort (no memory) once, never a card
  // and never a second wait; every exit leaves the bot (room) free and nothing held, so the next message is answered normally.
  for(const room of [false,true])it(`${room?"room":"direct"}: a rebuild whose view wait expires takes the last resort once and leaves nothing held`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const viewGate=join(fixture.info.dataDir,"rebuild-view-gate");
    const bot=(await api("POST","/api/bots",{name:"Wait expires",modelSelection:{instanceId:"twofence",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Wait expires room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    const idle=async()=>{ const state=await api("GET","/api/bots?messages=0"); return room?!state.groups.find((g:any)=>g.id===group.id)?.busyBotId:!state.bots.find((b:any)=>b.id===bot.id)?.busy; };
    const logFrom=readFileSync(fixture.info.logPath,"utf8").length;
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"the view never comes"});
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    writeFileSync(`${viewGate}.expire`,"");
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke between the fences"});
    writeFileSync(gate,"");
    await expect.poll(()=>rows().filter(row=>row.threadId===threadId&&row.prompt).length,{timeout:20000}).toBe(1);
    await expect.poll(idle,{timeout:20000}).toBe(true);
    expect(existsSync(`${viewGate}.expire`)).toBe(false);
    const served=readFileSync(fixture.info.logPath,"utf8").slice(logFrom);
    expect(served).toContain(`recall view not ready after 2000ms on thread ${threadId}; last resort`);
    expect(served).not.toContain(`thread ${threadId}; re-preparing (2 of 2)`);
    let messages=(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages;
    expect(messages.filter((message:any)=>String(message.text??message.content??"").includes("Hello from late"))).toHaveLength(1);
    expect(messages.filter((message:any)=>String(message.tool?.name??"").startsWith("error:")||message.memoryNote==="resend")).toHaveLength(0);
    // nothing held after that exit: the next message is answered
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"and the next one"});
    await expect.poll(()=>rows().filter(row=>row.threadId===threadId&&row.prompt).length,{timeout:20000}).toBe(2);
    await expect.poll(idle,{timeout:20000}).toBe(true);
    messages=(await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages;
    expect(messages.filter((message:any)=>String(message.text??message.content??"").includes("Hello from late"))).toHaveLength(2);
  },60000);
});
