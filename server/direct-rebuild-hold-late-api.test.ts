// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-DRAIN-V2 follow-up 2: the two paths direct-rebuild-hold-api.test.ts leaves out. A routine's turn refused at its send keeps its
// thread while it waits to be rebuilt, and a Stop of that conversation releases it directly: idle at once, nothing started again, and no
// engine interrupt (the held turn has no provider turn, and an interrupt names only the thread). A turn refused at a LATE write (the
// engine handed its id back before the prompt was written, as ACP and Codex do) keeps its thread the same way: a redelivered terminal event
// rebuilds it once, a rebuild refused before its admission frees the thread quietly, and a send in the wait queues behind it. Same fixture
// as direct-rebuild-hold-api.test.ts: 122 legacy audience jobs stay pending, so every settle before a rebuild waits its full
// REDISPATCH_SETTLE_MS, the window each test acts in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LEGACY_JOBS = 122;
const FIRST_LEGACY_ID = 720001;
const HELD = ["rbroutine"] as const;
const LATE = ["lbtwice", "lbrefuse", "lbqueue"] as const;
let fixture: VerificationServer, headers: Record<string, string>;
const raw = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await raw(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const replies = async (threadId: string) => (await messages(threadId)).filter(isReply).length;
const errorLines = (all: any[]) => all.filter(message => String(message.tool?.name ?? "").startsWith("error:")).map(message => String(message.tool.name));
const taskBusy = async (botId: string, threadId: string) => (await api("GET", `/api/bots/${botId}/tasks/${threadId}`)).task?.busy === true;
const dataFile = (name: string) => join(fixture.info.dataDir, name);
const linesOf = (name: string) => existsSync(dataFile(name)) ? readFileSync(dataFile(name), "utf8").trim().split("\n").filter(Boolean) : [];
/** The engine's sendTurn calls on the thread (a dump row without `prompt`), the refused ones included. */
const sends = (instance: string, threadId: string) => linesOf(`${instance}-dump`).map(line => JSON.parse(line)).filter(row => row.threadId === threadId && !row.prompt).length;
/** Every engine interrupt the instance was asked for on the thread. */
const interrupts = (instance: string, threadId: string) => linesOf(`${instance}-interrupts`).filter(line => line === threadId).length;
/** Every rebuild the server started on the thread: one per refusal it logged, at a send or at a late write. */
const rebuildsLogged = (threadId: string) => count(log(), `during dispatch on thread ${threadId}; re-preparing`) + count(log(), `at a late submission on thread ${threadId}; re-preparing`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** HOLD_PREFIX: each send waits, after its prompt was built and before the engine submits it, for its hold file (as in direct-rebuild-hold-api). */
const holds = (instance: string) => {
  let n = 0;
  const file = (k: number) => dataFile(`${instance}-hold-${k}`);
  return {
    async pass(botId: string, threadId: string, revoke?: string) {
      n++;
      await expect.poll(() => existsSync(`${file(n)}.waiting`), { timeout: 60000 }).toBe(true);
      expect(readFileSync(`${file(n)}.waiting`, "utf8")).toBe(threadId);
      if (revoke) await api("PATCH", `/api/bots/${botId}`, { section: revoke });
      writeFileSync(file(n), "");
    },
    idle: () => !existsSync(`${file(n + 1)}.waiting`),
  };
};
/** FAKE_LATE_GATE_EACH: each send hands its id back, then waits before its prompt is written for the instance's gate; a revoke landed in
 * that wait refuses the write (nothing written, the turn settles "submission_refused"). */
const lateGates = (instance: string) => {
  const gate = dataFile(`${instance}-gate`);
  const seen = new Set<string>();
  const waiting = () => { try { return readFileSync(`${gate}.waiting`, "utf8"); } catch { return ""; } };
  return {
    async pass(botId: string, revoke?: string) {
      await expect.poll(() => { const id = waiting(); return id !== "" && !seen.has(id); }, { timeout: 60000 }).toBe(true);
      seen.add(waiting());
      if (revoke) await api("PATCH", `/api/bots/${botId}`, { section: revoke });
      writeFileSync(gate, "");
    },
    /** True while no further send waits at its write. */
    idle: () => { const id = waiting(); return id === "" || seen.has(id); },
  };
};
type Gate = { pass(botId: string, threadId: string): Promise<void>; idle(): boolean };
/** Lets sends through until the thread has `want` replies: a revoke still being walked may refuse a send once more, and its rebuild is let through too. */
const passUntilReply = async (gate: Gate, botId: string, threadId: string, want: number) => {
  for (let attempt = 0; attempt < 4 && await replies(threadId) < want; attempt++) {
    if (attempt) console.log(`[drain-v2 late test] ${threadId}: send refused again, rebuild ${attempt} let through`);
    await gate.pass(botId, threadId);
    await expect.poll(async () => await replies(threadId) >= want || !gate.idle(), { timeout: 60000 }).toBe(true);
  }
  expect(await replies(threadId)).toBe(want);
};
const asGate = (late: ReturnType<typeof lateGates>): Gate => ({ pass: botId => late.pass(botId), idle: late.idle });

const pendingLegacy = () => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return Number((db.prepare(`SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id BETWEEN ? AND ? AND (state='active' OR (state='folded' AND revoke_id IN
    (SELECT f.old_id FROM memory_revoke_fold f JOIN memory_revoke_jobs b ON b.revoke_id=f.bulk_id WHERE b.state IN ('active','seeding'))))`).get(FIRST_LEGACY_ID, FIRST_LEGACY_ID + LEGACY_JOBS - 1) as { n: number }).n); }
  finally { db.close(); }
};
/** What 1.0.2 left for 122 receipt flips: audience-only jobs no walk can finish (as direct-rebuild-hold-api.test.ts leaves them). */
const ensureLegacyJobs = async () => {
  if (pendingLegacy() < LEGACY_JOBS) {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
    const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
    const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
    const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
    const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
    db.exec("BEGIN");
    for (let n = 0; n < LEGACY_JOBS; n++) { const id = FIRST_LEGACY_ID + n; job.run(id, root); audience.run(id); pending.run(id); frontier.run(id); }
    db.exec("COMMIT");
    db.close();
    await fixture.restart();
    await login();
  }
  expect(pendingLegacy()).toBe(LEGACY_JOBS);
};

const newBot = async (name: string, instanceId: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
/** A turn refused at its late write: resolved once the server logged its first rebuild and the refused turn waits to be rebuilt. */
const refuseLateAndWait = async (instance: string, gate: ReturnType<typeof lateGates>, botId: string, threadId: string, text: string) => {
  const warned = count(log(), `context revoked at a late submission on thread ${threadId}; re-preparing (1 of 3)`);
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text });
  await gate.pass(botId, `Revoke before the ${instance} write`);
  await expect.poll(() => count(log(), `context revoked at a late submission on thread ${threadId}; re-preparing (1 of 3)`), { timeout: 30000 }).toBe(warned + 1);
};

describe.skipIf(process.platform === "win32")("DELETION-DRAIN-V2: a routine's refused turn and a turn refused at its late write keep their thread", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const runs=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/independent-thread-runs.ts")).href)});
      const dir=process.env.MURAGE_DATA_DIR;
      // REFUSE_REBUILD_START: once <dir>/refuse-rebuild-start names a thread, the next admission check of that thread's rebuild
      // (startTurnAdmitting) finds its held run gone, as when a Stop lands in the writer-gate wait before admission (DirectRebuildCancelled)
      const proto=runs.IndependentThreadRuns.prototype, rebuilding=proto.rebuilding;
      // REBUILD_ADMISSIONS: every rebuild that reaches its admission check, by thread (<dir>/rebuild-admissions)
      if(rebuilding)proto.rebuilding=function(owner){
        const held=rebuilding.call(this,owner), flag=path.join(dir,'refuse-rebuild-start'), atAdmission=String(new Error().stack).includes('startTurnAdmitting');
        if(atAdmission)fs.appendFileSync(path.join(dir,'rebuild-admissions'),owner.threadId+'\\n');
        if(!held||!atAdmission||!fs.existsSync(flag)||fs.readFileSync(flag,'utf8')!==owner.threadId)return held;
        fs.rmSync(flag,{force:true});fs.writeFileSync(flag+'.taken',owner.threadId);
        return false;
      };
      const driver=makeLateTerminalDriver();
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        const env=input.environment;
        // INTERRUPTS: every engine interrupt the instance is asked for, by thread
        if(env.INTERRUPTS){const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);instance.adapter.interruptTurn=async threadId=>{fs.appendFileSync(env.INTERRUPTS,threadId+'\\n');return interrupt(threadId);};}
        // REDELIVER_REFUSED: a refused write's terminal event reaches every listener twice, as a redelivery does
        if(env.REDELIVER_REFUSED==='1'){const on=instance.adapter.onEvent.bind(instance.adapter);instance.adapter.onEvent=listener=>on(event=>{listener(event);if(event.type==='turn.completed'&&event.stopReason==='submission_refused'){fs.appendFileSync(path.join(dir,input.instanceId+'-redelivered'),event.turnId+'\\n');listener(event);}});}
        // HOLD_PREFIX: every sendTurn waits, after its prompt was built and before the engine submits it, for <prefix><n>
        if(env.HOLD_PREFIX){
          const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
          instance.adapter.sendTurn=async turn=>{
            const base=path.join(dir,env.HOLD_PREFIX+(++n));
            fs.writeFileSync(base+'.waiting',turn.threadId);
            await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
            return send(turn);
          };
        }
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const name of ${JSON.stringify(HELD)})cfg.instances[name]={driver:'fakeLateTerminal',environment:{HOLD_PREFIX:name+'-hold-',INTERRUPTS:path.join(dir,name+'-interrupts'),FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP:path.join(dir,name+'-dump')}};
      for(const name of ${JSON.stringify(LATE)})cfg.instances[name]={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,name+'-gate'),INTERRUPTS:path.join(dir,name+'-interrupts'),FAKE_LATE_DUMP:path.join(dir,name+'-dump'),...(name==='lbtwice'?{REDELIVER_REFUSED:'1'}:{})}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    await login();
    await ensureLegacyJobs();
  }, 120000);
  afterAll(async () => { await fixture?.close(); });

  // Follow-up 1: a routine's Stop cancels the run before its interrupt, and cancelDirectTurnDispatch moved the held run to "stopping"; the
  // interrupt then asked the engine to stop a thread with no provider turn, and the thread read as working until the settle ended.
  it("routine: a Stop of a routine turn waiting to be rebuilt frees the thread at once, starts nothing and asks the engine for no interrupt", async () => {
    const hold = holds("rbroutine");
    const bot = await newBot("Routine stopped in the wait", "rbroutine");
    const routine = (await api("POST", "/api/routines", { botId: bot.id, name: "Held routine", prompt: "Please answer briefly.", schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine as { id: string };
    const runsOf = async () => ((await api("GET", "/api/routines")).runs as Array<{ id: string; routineId: string; threadId?: string; status: string }>).filter(run => run.routineId === routine.id);
    // the first run answers in the routine's own conversation
    await api("POST", `/api/routines/${routine.id}/run`, {});
    await expect.poll(async () => (await runsOf()).some(run => Boolean(run.threadId)), { timeout: 30000 }).toBe(true);
    const threadId = (await runsOf()).find(run => run.threadId)!.threadId!;
    await passUntilReply(hold, bot.id, threadId, 1);
    await expect.poll(async () => (await runsOf()).every(run => run.status === "completed"), { timeout: 30000 }).toBe(true);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    // the second run, in the same conversation, is refused at its send and waits to be rebuilt
    const warned = count(log(), `context revoked during dispatch on thread ${threadId}; re-preparing (1 of 3)`);
    await api("POST", `/api/routines/${routine.id}/run`, {});
    await hold.pass(bot.id, threadId, "Revoke before the routine submission");
    await expect.poll(() => count(log(), `context revoked during dispatch on thread ${threadId}; re-preparing (1 of 3)`), { timeout: 30000 }).toBe(warned + 1);
    const sent = sends("rbroutine", threadId), asked = interrupts("rbroutine", threadId);
    await sleep(500);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    const live = (await runsOf()).find(run => run.status === "running");
    expect(live?.threadId).toBe(threadId);
    // the Stop the conversation's own button sends: the routine branch of the thread interrupt
    const stoppedAt = Date.now();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    // idle at once, well inside the settle the refused turn still waits for
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 1500, interval: 100 }).toBe(false);
    expect(Date.now() - stoppedAt).toBeLessThan(2500);
    expect((await runsOf()).find(run => run.id === live!.id)?.status).toBe("cancelled");
    // past the settle window: the rebuild never reached the engine, and the engine was never asked to stop this thread
    await sleep(7000);
    expect(hold.idle()).toBe(true);
    expect(sends("rbroutine", threadId)).toBe(sent);
    expect(interrupts("rbroutine", threadId)).toBe(asked);
    const all = await messages(threadId);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(await taskBusy(bot.id, threadId)).toBe(false);
  }, 180000);

  // Astra diff-confirm High: a redelivered fold of the refused write's terminal event found the run held for the rebuild and released it,
  // or started a second rebuild beside the first.
  it("late write: a redelivered terminal event of the refused write rebuilds it once, replies once and shows no card", async () => {
    const gate = lateGates("lbtwice");
    const bot = await newBot("Refused late, delivered twice", "lbtwice");
    const threadId = bot.threadId;
    await refuseLateAndWait("lbtwice", gate, bot.id, threadId, "the question refused at its late write");
    await expect.poll(() => linesOf("lbtwice-redelivered").length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
    // the redelivery released nothing: the thread still reads as working, and nothing new reached the engine in the wait
    await sleep(1000);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    expect(gate.idle()).toBe(true);
    await passUntilReply(asGate(gate), bot.id, threadId, 1);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    await sleep(1500);
    expect(gate.idle()).toBe(true);
    // one send per rebuild the server logged, and one rebuild per refusal: the redelivery started no second one (not even one that would
    // have died at its admission, the held run already taken over)
    expect(sends("lbtwice", threadId)).toBe(1 + rebuildsLogged(threadId));
    expect(linesOf("rebuild-admissions").filter(line => line === threadId)).toHaveLength(rebuildsLogged(threadId));
    const all = await messages(threadId);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(interrupts("lbtwice", threadId)).toBe(0);
  }, 180000);

  it("late write: a rebuild refused before its admission frees the thread quietly, and the send queued behind it then runs", async () => {
    const gate = lateGates("lbrefuse");
    const bot = await newBot("Refused late, rebuild refused", "lbrefuse");
    const threadId = bot.threadId;
    await refuseLateAndWait("lbrefuse", gate, bot.id, threadId, "the question whose rebuild is refused");
    writeFileSync(dataFile("refuse-rebuild-start"), threadId);
    await sleep(500);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    // a send in the wait queues behind the held turn
    const second = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "the question queued behind it" });
    expect(second.queued).toBe(true);
    // the rebuild meets its admission check with the hold gone: refused, the thread freed, and the queued send takes it
    await expect.poll(() => existsSync(dataFile("refuse-rebuild-start.taken")), { timeout: 30000 }).toBe(true);
    expect(readFileSync(dataFile("refuse-rebuild-start.taken"), "utf8")).toBe(threadId);
    await expect.poll(() => !gate.idle(), { timeout: 30000 }).toBe(true);
    // the queued send keeps the thread working while it runs
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    await passUntilReply(asGate(gate), bot.id, threadId, 1);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    // the refused rebuild never reached the engine: the refused send, then the queued one and its own rebuilds
    expect(sends("lbrefuse", threadId)).toBe(1 + rebuildsLogged(threadId));
    const all = await messages(threadId);
    // a quiet stop: the one reply is the queued question's, and no card
    expect(all.filter(isReply)).toHaveLength(1);
    const queuedAt = all.findIndex(message => message.role === "user" && message.text === "the question queued behind it");
    expect(queuedAt).toBeGreaterThanOrEqual(0);
    expect(all.slice(queuedAt + 1).some(isReply)).toBe(true);
    expect(errorLines(all)).toEqual([]);
    expect(count(log(), `late re-dispatch failed on thread ${threadId}`)).toBe(0);
  }, 180000);

  it("late write: a send in the wait stays queued behind the refused turn, which is rebuilt and answered first", async () => {
    const gate = lateGates("lbqueue");
    const bot = await newBot("Refused late, second send", "lbqueue");
    const threadId = bot.threadId;
    await refuseLateAndWait("lbqueue", gate, bot.id, threadId, "the question refused first");
    const second = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "a second question" });
    expect(second.queued).toBe(true);
    // nothing reached the engine for the second send while the first waits, and the thread reads as working throughout
    await sleep(1000);
    expect(gate.idle()).toBe(true);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    // the rebuild answers the first question before the queued one starts
    await passUntilReply(asGate(gate), bot.id, threadId, 1);
    const first = await messages(threadId);
    const firstAt = first.findIndex(message => message.role === "user" && message.text === "the question refused first");
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(first.slice(firstAt + 1).some(isReply)).toBe(true);
    // then the queued send, which keeps the thread working until it is answered
    await passUntilReply(asGate(gate), bot.id, threadId, 2);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    expect(sends("lbqueue", threadId)).toBe(2 + rebuildsLogged(threadId));
    expect(errorLines(await messages(threadId))).toEqual([]);
  }, 180000);
});
