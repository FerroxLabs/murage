import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
// CXP / LLS STOP-ORD on codex (STAGE2 CXP "Stop after claim via the real Stop route", LLS STOP-ORD CX3, Fc#13): a running codex turn's ledger lease is
// refused; the lease wins the close and its fallback is the driver's id-bearing interruptTurn, held here before it runs. The owner's Stop goes through
// the real route (POST /api/bots/:id/interrupt): it must stay pending on the refusal's teardown, never call the id-less interruptTurn (no driver Stop,
// so stopWins is never asked), and the turn ends once, memory_refused, with ONE refusal row and no Stop note or error row.
// Harness pieces copied from nativecrash-lls-t37l-1019.test.ts (lease capture, appendMessage capture, interrupt wrapper); the engine is the codex fake.

let fixture: VerificationServer, headers: Record<string, string>;
const LEDGER_LINE = "I stopped this turn because some of its context is no longer available.";
const dir = dirname(fileURLToPath(import.meta.url));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: response.status, body: parsed };
};
const jsonl = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy;
const isRefusalRow = (a: any) => a.text === LEDGER_LINE || a.memoryNote === "resend"
  || /submission_refused|MEMORY_CONTEXT_REVOKED/.test(String(a.errorDetails ?? "")) || /^error: .*(original message was submitted|could not|refus)/i.test(String(a.tool ?? ""));
const sse: any[] = []; const sseAbort = new AbortController();
const rmHold = (hold: string) => { for (const f of [hold, hold + ".waiting"]) if (existsSync(f)) unlinkSync(f); };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    await import(${JSON.stringify(pathToFileURL(join(dir, "testing/fake-engine-unwrapped-preload.mjs")).href)});
    const fs=await import('node:fs'), path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR, NL=String.fromCharCode(10);
    const leases=new Set(), mapSet=Map.prototype.set;
    Map.prototype.set=function(k,v){if(v&&typeof v==='object'&&typeof v.onLedgerRefused==='function'&&typeof v.attach==='function'&&typeof v.admissionNotLaunched==='function'&&!leases.has(v))leases.add(v);return mapSet.call(this,k,v);};
    const leaseArm=path.join(data,'lease-refuse-arm');
    setInterval(()=>{
      if(!fs.existsSync(leaseArm))return;const threadId=fs.readFileSync(leaseArm,'utf8');
      const lease=[...leases].find(l=>l.identity.threadId===threadId&&l.state==='open'&&l.providerTurnId);
      if(!lease)return;fs.unlinkSync(leaseArm);
      fs.writeFileSync(path.join(data,'lease-refused.json'),JSON.stringify({generation:lease.identity.dispatchGeneration,providerTurnId:lease.providerTurnId}));
      lease.onLedgerRefused({state:'checking',reason:'not-built'});
    },20).unref();
    const { Store }=await import(${JSON.stringify(pathToFileURL(join(dir, "store.ts")).href)});
    const append=Store.prototype.appendMessage;
    Store.prototype.appendMessage=function(threadId,input,...rest){
      const out=append.call(this,threadId,input,...rest);
      fs.appendFileSync(path.join(data,'appends.jsonl'),JSON.stringify({at:Date.now(),threadId,role:input?.role,kind:input?.kind,text:typeof input?.text==='string'?input.text.slice(0,120):undefined,tool:input?.tool?.name?.slice(0,140),errorDetails:input?.tool?.errorDetails,memoryNote:input?.memoryNote})+NL);
      return out;
    };
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/builtIn.ts")).href)});
    const codex=BUILT_IN_DRIVERS.find(d=>d.driverKind==='codex'), create=codex.create.bind(codex);
    const hold=(gate)=>new Promise(resolve=>{fs.writeFileSync(gate+'.waiting','');const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});
    codex.create=async input=>{
      const instance=await create(input),LOG=input.environment.FAKE_STOPORD_LOG;
      if(!LOG)return instance;
      const ev=value=>fs.appendFileSync(LOG,JSON.stringify({at:Date.now(),...value})+NL);
      instance.adapter.onEvent(event=>{if(event.type==='turn.completed'||event.type==='turn.started')ev({ev:event.type,stopReason:event.stopReason,ok:event.ok,turnId:event.turnId});});
      const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      instance.adapter.interruptTurn=async(...args)=>{
        const withId=args[1]!==undefined, leaseHold=input.environment.FAKE_STOPORD_HOLD;
        ev({ev:'interrupt',withId});
        if(withId&&leaseHold&&!fs.existsSync(leaseHold)){await hold(leaseHold);ev({ev:'lease-release'});}
        const result=await interrupt(...args);ev({ev:'interrupt-result',withId});return result;
      };
      return instance;
    };
    const file=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    const cli=${JSON.stringify(join(dir, "testing/fake-codex-app-server.ts"))};fs.chmodSync(cli,0o755);
    cfg.instances.tcodex={driver:'codex',displayName:'Codex fixture',config:{cli},environment:{FAKE_CODEX_VERSION:'codex-cli 0.128.0',FAKE_CODEX_COMPLETE_ON_FILE:path.join(data,'never'),FAKE_STOPORD_LOG:path.join(data,'tcodex.ev'),FAKE_STOPORD_HOLD:path.join(data,'tcodex-hold')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
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
        if (e?.type === "turn.completed") sse.push({ threadId: e.threadId ?? frame.threadId, stopReason: e.stopReason ?? null, ok: e.ok });
      }
    }
  })().catch(() => undefined);
}, 30000);
afterAll(async () => { sseAbort.abort(); await fixture?.close(); });

for (const withStop of [true, false]) it(`CXP STOP-ORD codex: lease refusal on the running turn${withStop ? ", then the owner's Stop: pending on the teardown, no driver Stop" : " (control, no Stop)"}, one memory_refused`, async () => {
  const data = fixture.info.dataDir, logFile = join(data, "tcodex.ev"), hold = join(data, "tcodex-hold"), t0 = Date.now();
  const evs = () => jsonl(logFile).filter(e => e.at >= t0);
  rmHold(hold);
  const created = await api("POST", "/api/bots", { name: "Stop order", modelSelection: { instanceId: "tcodex", model: "gpt-6.1-sol" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop after the refusal" })).status).toBe(202);
  await expect.poll(() => evs().filter(e => e.ev === "turn.started").length, { timeout: 20000 }).toBe(1);
  writeFileSync(join(data, "lease-refuse-arm"), bot.threadId);
  // the lease wins the close: its fallback (the id-bearing interruptTurn) is held before it runs
  await expect.poll(() => existsSync(hold + ".waiting"), { timeout: 10000 }).toBe(true);
  let stopSettled = false;
  // the Stop is the person's, through the real route; the control case sends none
  const stopping = withStop ? api("POST", `/api/bots/${bot.id}/interrupt`, {}).then(r => { stopSettled = true; return r; }) : Promise.resolve({ status: 200, body: null });
  // an explicit gate: a Stop the route did not hold on the refusal answers (and calls the id-less interruptTurn) well inside this window
  await sleep(1500);
  const during = { settled: stopSettled, idLess: evs().filter(e => e.ev === "interrupt" && !e.withId).length, terminals: evs().filter(e => e.ev === "turn.completed").length };
  writeFileSync(hold, "release");
  const stop = await Promise.race([stopping, sleep(10000).then(() => ({ status: "pending", body: null }))]);
  let busyAfter = await busy(bot.id);
  for (let i = 0; i < 40 && busyAfter; i++) { await sleep(250); busyAfter = await busy(bot.id); }
  await sleep(500);
  const ev = evs(), own = jsonl(join(data, "appends.jsonl")).filter(a => a.threadId === bot.threadId);
  console.log("STOPORD-CODEX " + JSON.stringify({ withStop, during, stop: stop.status, busyAfter, ev: ev.map(e => [e.ev, e.withId ?? e.stopReason ?? null]), rows: own.map(a => [a.role, a.kind, a.text?.slice(0, 40), a.tool, a.memoryNote, a.errorDetails]), sse: sse.filter(e => e.threadId === bot.threadId) }));
  // CODEX-LEASE-BUSY: the refused turn frees the bot within the same settle bound as a plain end (the control below), with or without the
  // Stop: the lease's fallback interrupt is close-confirmed, so its confirmation releases the run (was busy >= 30 s: codex returned void).
  expect(busyAfter, "the bot is free once the refused turn settled").toBe(false);
  expect(during.settled, "the Stop waits on the refusal's teardown").toBe(false);
  expect(during.idLess, "no driver Stop while the fallback is held").toBe(0);
  expect(during.terminals, "no terminal before the fallback ran").toBe(0);
  expect(stop.status).toBe(200);
  expect(ev.filter(e => e.ev === "interrupt" && !e.withId), "the Stop never reaches the driver's interruptTurn").toHaveLength(0);
  expect(ev.filter(e => e.ev === "interrupt" && e.withId), "one lease fallback").toHaveLength(1);
  const ends = ev.filter(e => e.ev === "turn.completed");
  expect(ends, "one adapter terminal").toHaveLength(1);
  expect([ends[0].ok, ends[0].stopReason], "the adapter terminal is the refusal (P1), never cancelled").toEqual([false, "memory-refused"]);
  expect(sse.filter(e => e.threadId === bot.threadId).map(e => e.stopReason), "one broadcast terminal, the refusal").toEqual(["memory_refused"]);
  expect(own.filter(isRefusalRow), "ONE refusal row").toHaveLength(1);
  expect(own.filter(a => String(a.tool ?? "").startsWith("error:") && !isRefusalRow(a)), "no error row").toHaveLength(0);
}, 60000);

// control: the same fixture turn without a refusal, ended by the engine (the never-file), clears busy
it("STOP-ORD codex control: no refusal, the engine ends the turn: busy clears", async () => {
  const data = fixture.info.dataDir, logFile = join(data, "tcodex.ev"), t0 = Date.now();
  const evs = () => jsonl(logFile).filter(e => e.at >= t0);
  const created = await api("POST", "/api/bots", { name: "Plain end", modelSelection: { instanceId: "tcodex", model: "gpt-6.1-sol" } });
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Plain end" })).status).toBe(202);
  await expect.poll(() => evs().filter(e => e.ev === "turn.started").length, { timeout: 20000 }).toBe(1);
  writeFileSync(join(data, "never"), "");
  await expect.poll(() => evs().filter(e => e.ev === "turn.completed").length, { timeout: 10000 }).toBe(1);
  let busyAfter = await busy(bot.id);
  for (let i = 0; i < 40 && busyAfter; i++) { await sleep(250); busyAfter = await busy(bot.id); }
  unlinkSync(join(data, "never"));
  console.log("STOPORD-CODEX-PLAIN " + JSON.stringify({ busyAfter, ev: evs().map(e => [e.ev, e.stopReason ?? null]) }));
  expect(busyAfter).toBe(false);
}, 60000);
