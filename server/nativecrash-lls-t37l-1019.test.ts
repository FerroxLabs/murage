import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REQUIRED_CONTROLS } from "./drivers/acp/opencode-tool-budget.ts";
// T37-L (r4 item 11, nativecrash LLS): the Stop route during a held id-bearing interruptTurn after a ledger lease refusal. Harness copied from c11-refused-resend-api.test.ts; adds
// adapter event/interrupt/teardown logging, a ledger-lease capture (Map.prototype.set) with a file-armed onLedgerRefused,
// and an id-bearing interruptTurn hold (FAKE_C11_LEASE_HOLD).

let fixture: VerificationServer, headers: Record<string, string>;
const LEDGER_LINE = "I stopped this turn because some of its context is no longer available.";
const dir = dirname(fileURLToPath(import.meta.url));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: response.status, body: parsed };
};
const jsonl = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy;
const sources = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT turn_id AS turnId, outcome FROM memory_sources WHERE thread_id=? AND kind='turn'").all(threadId) as any[]; }
  catch (error) { return [{ error: String(error).slice(0, 120) }]; } finally { db.close(); }
};
// The per-turn "Murage left remembered details out" note (memoryNote without-memory, sites 17632/17654) precedes every fixture turn: not a refusal row.
const isRefusalRow = (a: any) => a.text === LEDGER_LINE || a.memoryNote === "resend"
  || /submission_refused|MEMORY_CONTEXT_REVOKED/.test(String(a.errorDetails ?? "")) || /^error: .*(original message was submitted|could not|refus)/i.test(String(a.tool ?? ""));

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs'), path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR, NL=String.fromCharCode(10);
    // ncr4a2: capture every admitted ledger lease (admittedLedgerLeases.set, index.ts:3291) without touching tracked code.
    const leases=new Set(), mapSet=Map.prototype.set;
    Map.prototype.set=function(k,v){if(v&&typeof v==='object'&&typeof v.onLedgerRefused==='function'&&typeof v.attach==='function'&&typeof v.admissionNotLaunched==='function'&&!leases.has(v)){leases.add(v);fs.appendFileSync(path.join(data,'leases.jsonl'),JSON.stringify({threadId:v.identity.threadId,generation:v.identity.dispatchGeneration})+String.fromCharCode(10));}return mapSet.call(this,k,v);};
    const leaseArm=path.join(data,'lease-refuse-arm');
    setInterval(()=>{
      if(!fs.existsSync(leaseArm))return;const threadId=fs.readFileSync(leaseArm,'utf8');
      const lease=[...leases].find(l=>l.identity.threadId===threadId&&l.state==='open'&&l.providerTurnId);
      const seen=[...leases].filter(l=>l.identity.threadId===threadId).map(l=>({g:l.identity.dispatchGeneration,state:l.state,provider:Boolean(l.providerTurnId)}));
      fs.writeFileSync(path.join(data,'lease-seen.json'),JSON.stringify(seen));
      if(!lease)return;fs.unlinkSync(leaseArm);
      fs.writeFileSync(path.join(data,'lease-refused.json'),JSON.stringify({generation:lease.identity.dispatchGeneration,providerTurnId:lease.providerTurnId}));
      lease.onLedgerRefused({state:'checking',reason:'not-built'});
      fs.writeFileSync(path.join(data,'lease-refused.after.json'),JSON.stringify({state:lease.state,quarantined:lease.quarantined}));
    },20).unref();
    const { checkedOpenTurns }=await import(${JSON.stringify(pathToFileURL(join(dir, "memory/lineage-write.ts")).href)});
    const { Store }=await import(${JSON.stringify(pathToFileURL(join(dir, "store.ts")).href)});
    const append=Store.prototype.appendMessage;
    Store.prototype.appendMessage=function(threadId,input,...rest){
      const sites=(new Error().stack??'').split(NL).filter(l=>l.includes('server/index.ts')).map(l=>(l.match(/index[.]ts:([0-9]+)/)||[])[1]).slice(0,6);
      const out=append.call(this,threadId,input,...rest);
      fs.appendFileSync(path.join(data,'ncr4a2-appends.jsonl'),JSON.stringify({at:Date.now(),threadId,role:input?.role,kind:input?.kind,text:typeof input?.text==='string'?input.text.slice(0,120):undefined,tool:input?.tool?.name?.slice(0,140),errorDetails:input?.tool?.errorDetails,memoryNote:input?.memoryNote,murage:input?.murage?.kind,turnId:input?.turnId,sites})+NL);
      return out;
    };
    const { TurnSubmissionBoundary }=await import(${JSON.stringify(pathToFileURL(join(dir, "turn-dispatch-guard.ts")).href)});
    const proto=TurnSubmissionBoundary.prototype, before=proto.beforeSubmit;
    const arm=path.join(data,'stale-refusal-arm');
    proto.beforeSubmit=function(validate){
      if(!fs.existsSync(arm))return before.call(this,validate);
      const mode=fs.readFileSync(arm,'utf8');fs.unlinkSync(arm);
      if(mode==='refuse'){const error=new Error('delegation submitted refusal');this.refuse(error);throw error;}
      return before.call(this,validate);
    };
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/builtIn.ts")).href)});
    const { createAcpDriver }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/acp/core.ts")).href)});
    const driver=createAcpDriver({driverKind:'c11Fixture',displayName:'C11 fixture',models:{default:'opencode/mock',options:[{id:'opencode/mock',label:'Mock'}]},defaultCli:'unused',nativeSource:'c11.fixture',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,fluxReach:()=>"elsewhere",mcpListedWait:true,toolBudget:{routeKey:()=> 'a'.repeat(64)},transformEnv:env=>{env.OPENCODE_CONFIG_CONTENT=JSON.stringify({permission:{'*':'ask'}})}});
    const create=driver.create;
    const hold=(gate)=>new Promise(resolve=>{fs.writeFileSync(gate+'.waiting','');const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});
    driver.create=async input=>{
      const instance=await create(input),send=instance.adapter.sendTurn.bind(instance.adapter),LOG=input.environment.FAKE_C11_LOG;
      const ev=value=>fs.appendFileSync(LOG+'.ev',JSON.stringify({at:Date.now(),...value})+NL);
      instance.adapter.onEvent(event=>{
        if(event.type==='turn.completed'||event.type==='turn.started')ev({ev:event.type,stopReason:event.stopReason,ok:event.ok,threadId:event.threadId,turnId:event.turnId});
        if(event.type==='turn.completed'&&event.stopReason==='submission_refused')fs.writeFileSync(LOG+'.terminal','');
      });
      const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      instance.adapter.interruptTurn=async(...args)=>{
        const withId=args[1]!==undefined, leaseHold=input.environment.FAKE_C11_LEASE_HOLD;
        ev({ev:'interrupt',withId});
        if(withId){fs.writeFileSync(LOG+'.lease','');if(leaseHold&&!fs.existsSync(leaseHold)){ev({ev:'lease-hold'});await hold(leaseHold);ev({ev:'lease-release'});}}
        else{fs.writeFileSync(LOG+'.stop','');const stopHold=input.environment.FAKE_C11_STOP_HOLD;if(stopHold&&!fs.existsSync(stopHold)){ev({ev:'stop-hold'});await hold(stopHold);ev({ev:'stop-release'});}}
        const result=await interrupt(...args);ev({ev:'interrupt-result',withId,result:result===undefined?'void':result});return result;
      };
      const teardown=instance.adapter.awaitTurnTeardown?.bind(instance.adapter);
      if(teardown)instance.adapter.awaitTurnTeardown=async(...args)=>{
        const result=await teardown(...args),gate=input.environment.FAKE_C11_TEARDOWN,terminal=fs.existsSync(LOG+'.terminal');
        ev({ev:'teardown',terminal,gated:Boolean(gate),result});
        if(gate&&terminal&&!fs.existsSync(gate)){await hold(gate);ev({ev:'teardown-release'});}
        return result;
      };
      instance.adapter.sendTurn=async turn=>{
        // FAKE_C11_FENCE: when fence-revoke-arm exists, the turn's beforeSubmit (core.ts:7527) runs unchanged, THEN the consuming binding's open
        // lineage members are sealed (OpenTurn.sealed, the state refuseRetainedTurn sets at lineage-write.ts:512, without its onLedgerRefused
        // callback: the lease stays open), so the next check is the release fence inside turn.fencedWrite (fencedSubmit, core.ts:3748).
        if(input.environment.FAKE_C11_FENCE&&turn.beforeSubmit){
          const orig=turn.beforeSubmit,origWrite=turn.fencedWrite,fenceArm=path.join(data,'fence-revoke-arm');
          turn={...turn,beforeSubmit:(...a)=>{const r=orig(...a);if(fs.existsSync(fenceArm)){fs.unlinkSync(fenceArm);let sealed=0,err;
            try{for(const m of checkedOpenTurns(turn.releaseBinding.turn)){m.sealed=true;sealed++;}}catch(e){err=String(e).slice(0,120);}
            ev({ev:'fence-revoked',hasBinding:Boolean(turn.releaseBinding),hasFencedWrite:Boolean(origWrite),sealed,err});}return r;},
          ...(origWrite?{fencedWrite:(...a)=>{try{return origWrite(...a);}catch(e){ev({ev:'fencedWrite-threw',code:e?.code,name:e?.constructor?.name,fence:e?.fence??e?.verdict,
            frames:(e?.stack??'').split(NL).slice(1,7).map(l=>(l.match(/server[/][^):]+:[0-9]+/)||[l.trim().slice(0,60)])[0])});throw e;}}}:{})};
        }
        const value=await send(turn);ev({ev:'handback',turnId:value?.turnId});return value;};
      return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const file=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    const controls=${JSON.stringify(REQUIRED_CONTROLS.filter(n => n !== "project_propose"))};
    const base={driver:'c11Fixture',displayName:'C11 fixture',config:{cli:${JSON.stringify(join(dir, "testing/fake-acp-cli.ts"))}},environment:{FAKE_ACP_MODE:'c11-budget',FAKE_C11_SPEC:JSON.stringify({native:11,limit:40,catalogs:{agents:[...controls,...Array.from({length:40},(_,i)=>'extra'+i)],'murage-memory':[]}})}};
    cfg.instances.c11=structuredClone(base);cfg.instances.c11.environment.FAKE_C11_LOG=path.join(data,'c11.jsonl');
    for(const variant of ['tlease','tadopt']){
      const item=structuredClone(base),spec=JSON.parse(item.environment.FAKE_C11_SPEC);
      item.environment.FAKE_C11_LOG=path.join(data,variant+'.jsonl');
      if(variant==='tlease'||variant==='tadopt'){spec.limit=1000;spec.promptGate=path.join(data,variant+'-prompt');if(variant==='tlease')item.environment.FAKE_C11_LEASE_HOLD=path.join(data,'tlease-hold');else item.environment.FAKE_C11_STOP_HOLD=path.join(data,'tadopt-hold');}
      else {if(variant.startsWith('tsubf'))item.environment.FAKE_C11_FENCE='1';spec.recoveryGate=path.join(data,variant+'-gate');item.environment.FAKE_C11_TEARDOWN=path.join(data,variant+'-teardown');}
      item.environment.FAKE_C11_SPEC=JSON.stringify(spec);cfg.instances[variant]=item;
    }
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  // Harness broadcast boundary: every frame the server publishes to an SSE subscriber (/api/events), turn.completed kept.
  const res = await fetch(`${fixture.info.url}/api/events`, { headers, signal: sseAbort.signal });
  void (async () => {
    let buffer = ""; const decoder = new TextDecoder();
    for await (const chunk of res.body as any) {
      buffer += decoder.decode(chunk, { stream: true }); let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trimEnd(); buffer = buffer.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let frame: any; try { frame = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const e = frame.event ?? frame;
        if (e?.type === "turn.completed") sse.push({ kind: frame.kind, threadId: e.threadId ?? frame.threadId, turnId: e.turnId ?? frame.turnId, generation: e.generation ?? frame.generation, at: Date.now(), stopReason: e.stopReason ?? null, ok: e.ok, keys: Object.keys(e).join(","), frameKeys: Object.keys(frame).join(",") });
      }
    }
  })().catch(() => undefined);
}, 30000);
afterAll(async () => { sseAbort.abort(); await fixture?.close(); });
const sse: any[] = []; const sseAbort = new AbortController();
const sseTerminals = (threadId: string) => sse.filter(e => e.threadId === threadId).map(e => ({ at: e.at, turnId: e.turnId, generation: e.generation, stopReason: e.stopReason, kind: e.kind, keys: e.keys, frameKeys: e.frameKeys }));
// Generation-matched: the broadcast terminal names the refused attempt's provider turn id or the refused lease's dispatch generation.
// c11 broadcast turn.completed frames carry no turnId and only the bus's numeric completion generation (t37c2), so the refused attempt is
// matched by thread + window: published after that attempt's own adapter handback (.ev, same host clock).
const matchesGeneration = (e: any, turnId: string | undefined, generation: string | undefined, after?: number) => (turnId !== undefined && e.turnId === turnId) || (generation !== undefined && e.generation === generation)
  || (after !== undefined && e.turnId === undefined && typeof e.generation === "number" && e.at >= after);
const handbackAt = (log: string, turnId: string | undefined) => jsonl(log + ".ev").find(e => e.ev === "handback" && e.turnId === turnId)?.at;

const setup = async (variant: string, label: string) => {
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: variant, model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); return bot;
  };
  return { bot: await create(label), other: await create(label + " bystander") };
};
const appends = (threadId: string) => jsonl(join(fixture.info.dataDir, "ncr4a2-appends.jsonl")).filter(a => a.threadId === threadId);
const summarize = (threadId: string, log: string, since: number, logOffset: number) => {
  const own = appends(threadId), later = own.filter(a => a.at >= since);
  const tail = serverLog().slice(logOffset);
  return {
    refusalRows: own.filter(isRefusalRow).length,
    postStopNonRefusalRows: later.filter(a => !isRefusalRow(a)).map(a => ({ kind: a.kind, text: a.text, tool: a.tool, memoryNote: a.memoryNote, sites: a.sites })),
    errorRows: own.filter(a => String(a.tool ?? "").startsWith("error:") && !isRefusalRow(a)).length,
    errorRowsAll: own.filter(a => String(a.tool ?? "").startsWith("error:")).length,
    rebuildLinesAfterRelease: tail.split("\n").filter(l => /re-preparing|rebuild/i.test(l)).length,
    prompts: jsonl(log).filter(r => r.event === "prompt").length, spawns: jsonl(log).filter(r => r.event === "spawn").length,
    events: jsonl(log + ".ev").map(e => ({ ...e, at: undefined, turnId: undefined, threadId: undefined })),
    sources: sources(threadId),
    refusalLogLines: tail.split("\n").filter(l => /ledger refusal|refus/i.test(l)).map(l => l.slice(0, 160)).slice(0, 6),
    allRows: own.map(a => ({ kind: a.kind, text: a.text, tool: a.tool, memoryNote: a.memoryNote, errorDetails: a.errorDetails, sites: a.sites })),
  };
};

const leaseCase = (variant: "tlease", tag: string) => async () => {
  const log = join(fixture.info.dataDir, variant + ".jsonl"), promptGate = join(fixture.info.dataDir, "tlease-prompt"), hold = join(fixture.info.dataDir, variant + "-hold");
  const { bot, other } = await setup(variant, tag + " stop");
  if (variant === "tlease") {
    // Turn 1 completes; turn 2's prompt is held by the fixture promptGate (a running, handed-back turn); its ledger lease is refused there.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "First turn" })).status).toBe(202);
    await expect.poll(() => jsonl(log).filter(r => r.event === "completed").length, { timeout: 20000 }).toBe(1);
    await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this lease refusal" })).status).toBe(202);
    await expect.poll(() => existsSync(promptGate + ".waiting"), { timeout: 20000 }).toBe(true);
    writeFileSync(join(fixture.info.dataDir, "lease-refuse-arm"), bot.threadId);
  } else {
    // The original c11 T37 drive (bystander PATCH during recovery): the production ledger refusal (withheld:deny-memory) on the handed-back turn.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this refused resend" })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "lorig-gate.waiting")), { timeout: 10000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before resend Stop" })).status).toBe(200);
    writeFileSync(join(fixture.info.dataDir, "lorig-gate"), "release");
  }
  let armed = false;
  for (let i = 0; i < 100 && !armed; i++) { armed = existsSync(hold + ".waiting"); await sleep(100); }
  if (!armed) {
    const seen = existsSync(join(fixture.info.dataDir, "lease-seen.json")) ? readFileSync(join(fixture.info.dataDir, "lease-seen.json"), "utf8") : null;
    console.log("NCR4A2-" + tag + " " + JSON.stringify({ reachedStopDuringHold: false, notRun: "id-bearing interrupt hold never armed", seen, refused: existsSync(join(fixture.info.dataDir, "lease-refused.json")), ...summarize(bot.threadId, log, Date.now(), 0) }));
    writeFileSync(promptGate, "release");
    expect(armed).toBe(true);
  }
  const refusedFile = join(fixture.info.dataDir, "lease-refused.json");
  const refused = existsSync(refusedFile) ? JSON.parse(readFileSync(refusedFile, "utf8")) : { generation: "missing" };
  const stopFileBefore = existsSync(log + ".stop"), busyBefore = await busy(bot.id);
  const since = Date.now();
  let stopSettled: number | undefined;
  const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {}).then(r => { stopSettled = Date.now(); return r; });
  await sleep(1500);
  const duringHold = { holdStillWaiting: existsSync(hold + ".waiting") && !existsSync(hold), stopLookupInterruptDuringHold: existsSync(log + ".stop"), stopSettledDuringHold: stopSettled !== undefined };
  // Stop was issued (POST sent at `since`) and the id-bearing hold was still waiting 1.5s later; server-side evidence fields reported separately.
  const reachedStopDuringHold = duringHold.holdStillWaiting;
  const logOffset = serverLog().length;
  writeFileSync(hold, "release");
  let promptGateReleased = false;
  const stop = await Promise.race([stopping, sleep(8000).then(() => undefined)]);
  let busyAfter = await busy(bot.id);
  for (let i = 0; i < 40 && busyAfter; i++) { await sleep(250); busyAfter = await busy(bot.id); }
  if (busyAfter && variant === "tlease") { promptGateReleased = true; writeFileSync(promptGate, "release"); await sleep(3000); busyAfter = await busy(bot.id); }
  const stopFinal = stop ?? await Promise.race([stopping, sleep(5000).then(() => ({ status: "pending", body: null }))]);
  await sleep(500);
  const s = summarize(bot.threadId, log, since, logOffset);
  const broadcast = sseTerminals(bot.threadId), matched = broadcast.filter(e => matchesGeneration(e, refused.providerTurnId, refused.generation, handbackAt(log, refused.providerTurnId)));
  console.log("NCR4A2-" + tag + " " + JSON.stringify({ reachedStopDuringHold, refusedGeneration: refused.generation, busyBefore, stopFileBefore, ...duringHold,
    stopStatus: stopFinal.status, stopBody: stopFinal.body, terminals: jsonl(log + ".ev").filter(e => e.ev === "turn.completed").map(e => e.stopReason), promptGateReleased, busyAfter, generationTurnId: refused.providerTurnId, broadcastTerminals: broadcast, matchedBroadcastTerminals: matched.length, ...s }));
  if (!promptGateReleased && variant === "tlease") writeFileSync(promptGate, "release");
  expect(reachedStopDuringHold).toBe(true);
  expect.soft(duringHold.stopSettledDuringHold).toBe(false);
  expect.soft(duringHold.stopLookupInterruptDuringHold).toBe(false);
  expect.soft(stopFinal.status).toBe(200);
  expect.soft(s.refusalRows).toBe(1);
  expect.soft(matched.length).toBe(1);
  expect.soft(matched.map(e => e.stopReason)).toEqual(["memory_refused"]);
  expect.soft(s.postStopNonRefusalRows).toHaveLength(0);
  expect.soft(s.errorRowsAll).toBe(0);
  expect.soft(s.rebuildLinesAfterRelease).toBe(0);
  expect.soft(busyAfter).toBe(false);
};
it("T37-L lease refusal on the running turn: Stop stays pending while the id-bearing interrupt is held", leaseCase("tlease", "T37-L"), 60000);

// LLS adoption: a refusal that lands while the Stop's own id-less interrupt is in flight adopts that call as the lease's close.
it("STOP-ADOPT lease refusal while the Stop's id-less interrupt is held: no second (id-bearing) interruptTurn", async () => {
  const variant = "tadopt", log = join(fixture.info.dataDir, variant + ".jsonl"), promptGate = join(fixture.info.dataDir, variant + "-prompt"), hold = join(fixture.info.dataDir, variant + "-hold");
  const { bot } = await setup(variant, "STOP-ADOPT");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "First turn" })).status).toBe(202);
  await expect.poll(() => jsonl(log).filter(r => r.event === "completed").length, { timeout: 20000 }).toBe(1);
  await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop while the interrupt is held" })).status).toBe(202);
  await expect.poll(() => existsSync(promptGate + ".waiting"), { timeout: 20000 }).toBe(true);
  const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
  await expect.poll(() => existsSync(hold + ".waiting"), { timeout: 10000 }).toBe(true);
  writeFileSync(join(fixture.info.dataDir, "lease-refuse-arm"), bot.threadId);
  await expect.poll(() => existsSync(join(fixture.info.dataDir, "lease-refused.after.json")), { timeout: 10000 }).toBe(true);
  await sleep(500);
  const idBearingDuringHold = jsonl(log + ".ev").filter(e => e.ev === "interrupt" && e.withId).length;
  writeFileSync(hold, "release");
  const stop = await Promise.race([stopping, sleep(10000).then(() => ({ status: "pending", body: null }))]);
  writeFileSync(promptGate, "release");
  await expect.poll(() => busy(bot.id), { timeout: 10000 }).toBe(false);
  const s = summarize(bot.threadId, log, 0, serverLog().length);
  expect(idBearingDuringHold, "the lease adopts the held Stop interrupt").toBe(0);
  expect(jsonl(log + ".ev").filter(e => e.ev === "interrupt" && e.withId)).toHaveLength(0);
  expect(stop.status).toBe(200);
  expect(s.refusalRows).toBe(1);
  expect(s.errorRowsAll).toBe(0);
}, 60000);
