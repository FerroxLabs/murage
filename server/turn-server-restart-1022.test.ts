// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 (the owner's own Mac, 2026-11-22T02:15Z: "[turn] dispatch preparation failed ... This bot's AI connection is unavailable",
// one second before the next server start): an owner's own turn that is still being prepared when the SERVER PROCESS closes for a
// restart is never failed. Its send goes back to waiting with the line it already has, and the next server runs it: the owner reads
// the reply, never a failure row and never a silence.
// Real server process, real HTTP send route (POST /api/bots/:id/messages), a real SIGTERM (the graceful close the desktop asks for)
// and a real second start on the same data folder. The only fixture hooks send the server its own SIGTERM at a named moment of the
// send (while the turn is being prepared, while the send is still on its way in) and hold one engine's submit so
// that a second message waits in the queue; every hook calls the real method.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const INSTANCE = "srvrestart";
const FENCED = "srvrestartfenced"; // an engine that declares fenced writes: a setup failure before its first write is proven unwritten and is prepared once more
const LATEFENCE = "srvrestartlate"; // the engine hands its turn id back, waits at its write gate, and the memory fence refuses that late write (proven unwritten): the turn is held for its rebuild
const LATEFENCE2 = "srvrestartlateb"; // the same engine for the second late cell, with its own gate (a message a wrong keep leaves waiting must not wait at the next cell's gate)
const HELD = "srvrestartheld"; // the same engine, each submit held while the hold file exists (so a second message waits in the queue)
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lines = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const replies = async (threadId: string) => (await lines(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length;
const file = (name: string) => join(fixture.info.dataDir, `${INSTANCE}-${name}`);
/** How many times the engine was handed a turn of this thread (the fixture engine's own record, kept across the restart). */
const dispatches = (threadId: string) => existsSync(file("dump")) ? readFileSync(file("dump"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.threadId === threadId).length : 0;
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const exited = (child: VerificationServer["child"]) => child.exitCode !== null || child.signalCode !== null;
const QUESTION = "the question sent as the server closes";

describe.skipIf(process.platform === "win32")("an owner turn started while the server closes for a restart", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const dir=process.env.MURAGE_DATA_DIR;
      let rebuildCloseThread=null,rebuildCloseWait=0,rebuildDelayOnly=false;
      const arm=name=>{const f=path.join(dir,'${INSTANCE}-arm-'+name);if(!fs.existsSync(f))return false;fs.rmSync(f,{force:true});return true;};
      const runs=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/independent-thread-runs.ts")).href)});
      const driver=makeLateTerminalDriver({fencedDefaults:true});
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        if(input.environment.FAKE_LATE_FENCED_WRITES==='1'){
          // "rebuilding": the armed turn's submit fails in Murage's own setup before anything is written (the one code the server re-prepares),
          // as the real delete-check start does inside the exec driver's sendTurn; the turn is held for its rebuild and the close lands in that hold
          const submit=instance.adapter.sendTurn.bind(instance.adapter);
          instance.adapter.sendTurn=async turn=>{
            const wait=arm('rebuilding')?40:arm('rebuilding-now')?0:-1;
            if(wait>=0){rebuildCloseThread=turn.threadId;rebuildCloseWait=wait;throw new Error('instance_not_attached');}
            return submit(turn);
          };
        }
        if(!input.environment.HOLD_PREFIX)return instance;
        // the held instance: a submit waits while the hold file exists (none after the cell let it go, so the next server holds nothing)
        const send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{
          const hold=path.join(dir,input.environment.HOLD_PREFIX+'on');
          if(fs.existsSync(hold)){
            fs.writeFileSync(path.join(dir,input.environment.HOLD_PREFIX+'waiting'),turn.threadId);
            await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(hold))return;clearInterval(poll);resolve();},20);});
          }
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
      const dump=path.join(dir,'${INSTANCE}-dump');
      cfg.computer={...cfg.computer,defaultForNewBots:'off'};
      cfg.instances.${INSTANCE}={driver:'fakeLateTerminal',environment:{FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_DUMP:dump}};
      cfg.instances.${FENCED}={driver:'fakeLateTerminal',environment:{FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_DUMP:dump}};
      cfg.instances.${LATEFENCE}={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'${INSTANCE}-gate'),FAKE_LATE_DUMP:dump}};
      cfg.instances.${LATEFENCE2}={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'${INSTANCE}-gateb'),FAKE_LATE_DUMP:dump}};
      cfg.instances.${HELD}={driver:'fakeLateTerminal',environment:{HOLD_PREFIX:'${INSTANCE}-hold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_DUMP:dump}};
      fs.writeFileSync(cfgFile,JSON.stringify(cfg));
      // The restart is a real SIGTERM the server sends itself (the graceful close), at one of three moments of the owner's send.
      // Nothing of the send, the turn or the close is replaced: each hook calls the real method.
      const {Store}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/store.ts")).href)});
      // this listener is registered before the server's own, so when it has run the server's close begins in the same signal delivery
      let signalled=()=>{};
      process.on('SIGTERM',()=>signalled());
      // "latehold" / "latestart": the turn is refused at its late write and held for its rebuild (the real holdForRebuild ran and kept it); the close
      // begins right there ("latehold": the rebuild's start then waits 300 ms, so the close lands while the run is held) or at the rebuild's own start
      // ("latestart": the prepareThread hook below)
      const hold=runs.IndependentThreadRuns.prototype.holdForRebuild;
      runs.IndependentThreadRuns.prototype.holdForRebuild=function(run,...rest){
        const held=hold.call(this,run,...rest);
        if(held&&arm('latehold')){void close(run.threadId);rebuildCloseThread=run.threadId;rebuildCloseWait=300;rebuildDelayOnly=true;}
        else if(held&&arm('latestart')){rebuildCloseThread=run.threadId;rebuildCloseWait=40;}
        return held;
      };
      const close=threadId=>{fs.writeFileSync(path.join(dir,'${INSTANCE}-closed-at'),threadId);const seen=new Promise(resolve=>{signalled=resolve;});process.kill(process.pid,'SIGTERM');return seen;};
      // "prepared": at the moment the turn's thread turns to working: inside the turn's preparation, after its admission
      const setTaskActivity=Store.prototype.setTaskActivity;
      Store.prototype.setTaskActivity=function(botId,threadId,activity,...rest){
        if(activity==='working'&&arm('prepared'))void close(threadId);
        return setTaskActivity.call(this,botId,threadId,activity,...rest);
      };
      // "arriving": while the send is still on its way in, at the thread fill every turn start waits on; the start goes on 40 ms
      // after the close began, when the closing server's engines are gone.
      // (only at a turn start's own wait on the fill: the queued start's bounded wait, or startTurn's; never another reader of the thread)
      const startWaits=()=>{const at=String(new Error('at').stack);return at.includes('runQueuedStart')||at.includes('startTurn');};
      const prepareThread=Store.prototype.prepareThread;
      Store.prototype.prepareThread=async function(threadId,...rest){
        if(!startWaits())return prepareThread.call(this,threadId,...rest);
        // "rebuilding": the same wait of the REBUILD's own start (the refused turn's run is held, phase "rebuilding", until its start takes it over):
        // the close begins there and the start goes on 40 ms later ("rebuilding": the closing server's engines are gone) or in the very same tick
        // ("rebuilding-now": nothing but the server's own rule keeps the rebuild from being admitted there)
        if(rebuildCloseThread===threadId){rebuildCloseThread=null;if(rebuildDelayOnly)rebuildDelayOnly=false;else await close(threadId);if(rebuildCloseWait>0)await new Promise(resolve=>setTimeout(resolve,rebuildCloseWait));}
        else if(arm('arriving')){await close(threadId);await new Promise(resolve=>setTimeout(resolve,40));}
        // "admitting": the same moment with no wait: the start goes on in the very tick the close began, before the closing
        // server's engines are gone, so nothing but the server's own rule keeps it from admitting the turn there
        else if(arm('admitting'))await close(threadId);
        return prepareThread.call(this,threadId,...rest);
      };
    ` });
    await login();
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  const newBot = async (name: string, instanceId: string) => {
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    return bot;
  };
  const idle = (bot: { id: string; threadId: string }) => expect.poll(async () => (await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).task?.busy === true, { timeout: 15_000 }).toBe(false);
  /** The closing server ends, the next one starts on the same data folder, and what the owner then reads on the thread. */
  const afterRestart = async (threadId: string, closing: VerificationServer["child"], closingLog: string, sent: { status: number; body: any }) => {
    for (let waited = 0; waited < 20_000 && !exited(closing); waited += 50) await sleep(50);
    const closedAtThisThread = existsSync(file("closed-at")) && readFileSync(file("closed-at"), "utf8") === threadId;
    const handedBeforeRestart = dispatches(threadId);
    // which of the closing server's keeps took the turn (its own log line), so a cell cannot pass through another cell's path
    const closeLog = existsSync(closingLog) ? readFileSync(closingLog, "utf8") : "";
    const quietAfterHold = closeLog.includes(`[turn] held turn kept at close: no failure card, banner or error for thread ${threadId}`);
    const keptAt = /waits? for the next start \(kept at (\w+)\)/.exec(existsSync(closingLog) ? readFileSync(closingLog, "utf8") : "")?.[1] ?? "none";
    await fixture.restart();
    await login();
    for (let waited = 0; waited < 60_000 && await replies(threadId) < 2; waited += 200) await sleep(200);
    const after = await lines(threadId);
    // every not-ok activity row written after the owner's line (a failure, a "stopped: Murage closed" line, a "no answer" note)
    const from = after.findIndex(message => message.role === "user" && message.text === QUESTION);
    const failureRows = after.slice(from < 0 ? 0 : from).filter(message => message.role === "bot" && message.kind === "activity" && message.tool?.ok === false).map(message => String(message.tool?.name));
    return {
      exited: exited(closing), closedAtThisThread, keptAt, quietAfterHold, heldAt: /\[turn\] held for rebuild \((\S+)\) on thread/.exec(closeLog)?.[1] ?? "none", handedBeforeRestart, handedAfterRestart: dispatches(threadId),
      ownerLines: after.filter(message => message.role === "user" && message.text === QUESTION).length,
      failureRows,
      replies: after.filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length,
      sendAnswer: sent.status === 202 || sent.status === 0 /* the close cut the connection first */ ? "accepted" : `status ${sent.status}: ${JSON.stringify(sent.body)}`,
    };
  };
  /** One answered turn, then the owner's send with the close armed at `moment`. */
  const sendAsServerCloses = async (name: string, moment: "prepared" | "rebuilding" | "rebuilding-now" | "arriving" | "admitting") => {
    const bot = await newBot(name, moment.startsWith("rebuilding") ? FENCED : INSTANCE);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "an earlier question" });
    await expect.poll(() => replies(bot.threadId), { timeout: 60_000 }).toBe(1);
    await idle(bot);
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file(`arm-${moment}`), "");
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: QUESTION }).catch(() => ({ status: 0, body: {} as any }));
    return afterRestart(bot.threadId, closing, closingLog, sent);
  };
  // the owner's line is there once, the next server handed it to the engine once and answered it, and nothing not-ok was written
  const KEPT = { heldAt: "none", quietAfterHold: false, exited: true, closedAtThisThread: true, handedBeforeRestart: 1, handedAfterRestart: 2, ownerLines: 1, failureRows: [], replies: 2, sendAnswer: "accepted" };

  it("SERVER-RESTART: a turn being prepared when the close begins is kept for the next server and answered there; no stopped or failure row", async () => {
    // SERVER-RESTART:prepared (base 027bb2e2a3: "stopped: Murage closed while this was running", and the turn never runs)
    expect(await sendAsServerCloses("Server restart", "prepared")).toEqual({ ...KEPT, keptAt: "close" });
  }, 240_000);

  it("SERVER-RESTART-REBUILDING: a turn held for its rebuild (phase rebuilding, nothing handed to the engine) when the close begins is kept for the next server and answered there; no stopped or failure row", async () => {
    // SERVER-RESTART:rebuilding (base bf7afba786: "stopped: Murage closed while this was running", and the turn never runs)
    expect(await sendAsServerCloses("Server restart rebuilding", "rebuilding")).toEqual({ ...KEPT, heldAt: "setup", quietAfterHold: true, keptAt: "close" });
  }, 240_000);

  it("SERVER-RESTART-REBUILDING-ADMITTING: the rebuild of a held turn reaches its start in the tick the close began: the closing server does not admit it; the next server answers it once", async () => {
    // SERVER-RESTART:rebuilding-now (without startsKeptAtClose the closing server admits the rebuild: the kept line runs twice, or a refusal card is written)
    expect(await sendAsServerCloses("Server restart rebuilding now", "rebuilding-now")).toEqual({ ...KEPT, heldAt: "setup", quietAfterHold: true, keptAt: "close" });
  }, 240_000);

  it("SERVER-RESTART-LATE: a send that reaches its start after the closing server's engines are gone waits in the queue and is answered by the next server", async () => {
    // SERVER-RESTART:arriving (base 027bb2e2a3: the send is answered 409 "This bot's AI connection is unavailable", the logged line)
    expect(await sendAsServerCloses("Server restart late", "arriving")).toEqual({ ...KEPT, keptAt: "send" });
  }, 240_000);

  /** The first turn of this bot is at the engine and held there, so the owner's next message waits in the queue. */
  const holdFirstTurn = async (bot: { id: string; threadId: string }) => {
    rmSync(file("hold-waiting"), { force: true });
    writeFileSync(file("hold-on"), "");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "an earlier question" });
    await expect.poll(() => existsSync(file("hold-waiting")) && readFileSync(file("hold-waiting"), "utf8") === bot.threadId, { timeout: 60_000 }).toBe(true);
  };
  it("SERVER-RESTART-QUEUED: a waiting message started from the queue and still being prepared when the close begins is kept and answered by the next server", async () => {
    const bot = await newBot("Server restart queued", HELD);
    const threadId = bot.threadId;
    // the first turn is at the engine (held), so the owner's next message waits in the queue
    await holdFirstTurn(bot);
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId, text: QUESTION });
    expect({ status: sent.status, queued: sent.body?.queued === true }, JSON.stringify(sent.body)).toEqual({ status: 202, queued: true });
    // the first turn is let through and answers; the queue starts the waiting line, and the close lands in that turn's preparation
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file("arm-prepared"), "");
    rmSync(file("hold-on"));
    // SERVER-RESTART:queued (base 027bb2e2a3: "stopped: Murage closed while this was running", and the line never runs)
    expect(await afterRestart(threadId, closing, closingLog, sent)).toEqual({ ...KEPT, keptAt: "close" });
  }, 240_000);

  /** A message accepted as waiting (202 queued) behind a running turn; the queue starts it and the close lands at `moment` of that start, before its turn is admitted. */
  const queuedStartAsServerCloses = async (name: string, moment: "arriving" | "admitting") => {
    const bot = await newBot(name, HELD);
    const threadId = bot.threadId;
    await holdFirstTurn(bot);
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId, text: QUESTION });
    expect({ status: sent.status, queued: sent.body?.queued === true }, JSON.stringify(sent.body)).toEqual({ status: 202, queued: true });
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file(`arm-${moment}`), "");
    rmSync(file("hold-on"));
    return afterRestart(threadId, closing, closingLog, sent);
  };

  it("SERVER-RESTART-QUEUED-REFUSED: a waiting message whose start the closing server refuses before admission (its engines are gone) is kept and answered by the next server", async () => {
    // SERVER-RESTART:queued-refused (base feb735eb8e: the accepted message gets "stopped: Murage closed while this was running" and never runs)
    expect(await queuedStartAsServerCloses("Server restart queued refused", "arriving")).toEqual({ ...KEPT, keptAt: "queue" });
  }, 240_000);

  it("SERVER-RESTART-QUEUED-ADMITTING: a waiting message whose start reaches admission in the tick the close began is not admitted by the closing server; the next server answers it once", async () => {
    // SERVER-RESTART:queued-admitting
    expect(await queuedStartAsServerCloses("Server restart queued admitting", "admitting")).toEqual({ ...KEPT, keptAt: "queue" });
  }, 240_000);

  it("SERVER-RESTART-ADMITTING: a send that reaches admission in the tick the close began is not admitted by the closing server; it waits and the next server answers it once", async () => {
    // SERVER-RESTART:admitting
    expect(await sendAsServerCloses("Server restart admitting", "admitting")).toEqual({ ...KEPT, keptAt: "send" });
  }, 240_000);

  it("SERVER-RESTART-QUEUED-MIXED: the owner's waiting message is kept when a line sent without the app's proof waits with it in the same start", async () => {
    const bot = await newBot("Server restart queued mixed", HELD);
    const threadId = bot.threadId;
    await holdFirstTurn(bot);
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId, text: QUESTION });
    // a second waiting line from a caller with no app proof (its origin is unproven): the queue starts both lines as one turn
    const other = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, text: "a line sent without the app's proof" }) });
    const otherBody = await other.json().catch(() => ({})) as any;
    expect({ owner: sent.status, ownerQueued: sent.body?.queued === true, other: other.status, otherQueued: otherBody?.queued === true }, JSON.stringify([sent.body, otherBody])).toEqual({ owner: 202, ownerQueued: true, other: 202, otherQueued: true });
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file("arm-arriving"), "");
    rmSync(file("hold-on"));
    // SERVER-RESTART:queued-mixed (base feb735eb8e and 6305656e28: "stopped: Murage closed while this was running", neither line runs)
    // (both lines are one start: the next server hands the engine one turn and the owner reads one answer)
    expect(await afterRestart(threadId, closing, closingLog, sent)).toEqual({ ...KEPT, keptAt: "queue" });
  }, 240_000);

  it("SERVER-RESTART-QUEUED-MIXED-PREPARED: the same two lines, their turn admitted and still being prepared when the close begins, are kept and answered by the next server", async () => {
    const bot = await newBot("Server restart queued mixed prepared", HELD);
    const threadId = bot.threadId;
    await holdFirstTurn(bot);
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId, text: QUESTION });
    // a second waiting line from a caller with no app proof (its origin is unproven): the queue starts both lines as one turn
    const other = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, text: "a line sent without the app's proof" }) });
    const otherBody = await other.json().catch(() => ({})) as any;
    expect({ owner: sent.status, ownerQueued: sent.body?.queued === true, other: other.status, otherQueued: otherBody?.queued === true }, JSON.stringify([sent.body, otherBody])).toEqual({ owner: 202, ownerQueued: true, other: 202, otherQueued: true });
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file("arm-prepared"), "");
    rmSync(file("hold-on"));
    // SERVER-RESTART:queued-mixed-prepared (base feb735eb8e and 1ea9c33624: "stopped: Murage closed while this was running", neither line runs)
    // (both lines are one start: the next server hands the engine one turn and the owner reads one answer)
    expect(await afterRestart(threadId, closing, closingLog, sent)).toEqual({ ...KEPT, keptAt: "close" });
  }, 240_000);

  const ownerSendStatuses = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return (db.prepare("SELECT status FROM owner_sends WHERE text = ?").all(QUESTION) as Array<{ status: string }>).map(row => row.status); }
    finally { db.close(); }
  };
  const SITE_LOG = (site: string, threadId: string) => `[turn] held for rebuild (${site}) on thread ${threadId}`;
  /** One answered turn, then the owner's send is refused by the fence at its late write (a revoke lands in the engine's write gate), the held turn is
   * kept at `moment` by a real SIGTERM, and the next server starts on the same folder. What the owner reads and what ran where. */
  const lateRefusedAsServerCloses = async (name: string, moment: "latehold" | "latestart") => {
    const bot = await newBot(name, moment === "latehold" ? LATEFENCE : LATEFENCE2);
    const gate = file(moment === "latehold" ? "gate" : "gateb"), seen = new Set<string>();
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    const waiting = () => { try { return readFileSync(`${gate}.waiting`, "utf8"); } catch { return ""; } };
    const pass = async (revoke?: Record<string, unknown>) => {
      await expect.poll(() => { const id = waiting(); return id !== "" && !seen.has(id); }, { timeout: 60_000 }).toBe(true);
      seen.add(waiting());
      if (revoke) await api("PATCH", `/api/bots/${bot.id}`, revoke);
      writeFileSync(gate, "");
    };
    // the bot has a past (one answered turn), so a role change is an audience change: the memory fence refuses the next write at its gate
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "an earlier question" });
    await pass();
    await expect.poll(() => replies(bot.threadId), { timeout: 60_000 }).toBe(1);
    await idle(bot);
    const closing = fixture.child, closingLog = fixture.info.logPath;
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file(`arm-${moment}`), "");
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: QUESTION });
    await pass({ individual: true });
    for (let waited = 0; waited < 20_000 && !exited(closing); waited += 50) await sleep(50);
    const closeLog = existsSync(closingLog) ? readFileSync(closingLog, "utf8") : "";
    const handedBeforeRestart = dispatches(bot.threadId);
    await fixture.restart();
    await login();
    // the next server gets time to run the message if the close wrongly left it waiting (a rerun would be a second dispatch and a second reply)
    await sleep(8_000);
    const after = await lines(bot.threadId);
    const from = after.findIndex(message => message.role === "user" && message.text === QUESTION);
    const rows = after.slice(from < 0 ? 0 : from).filter(message => message.role === "bot" && message.kind === "activity");
    return {
      exited: exited(closing), closedAtThisThread: existsSync(file("closed-at")) && readFileSync(file("closed-at"), "utf8") === bot.threadId,
      siteLines: ["late-lease", "late-fold", "setup"].filter(site => closeLog.includes(SITE_LOG(site, bot.threadId))),
      sendAnswer: sent.status,
      ownerLines: after.filter(message => message.role === "user" && message.text === QUESTION).length,
      stoppedRows: rows.filter(message => message.tool?.name === "stopped: Murage closed while this was running").length,
      errorRows: rows.filter(message => String(message.tool?.name ?? "").startsWith("error:")).length,
      sendStatuses: ownerSendStatuses().filter(status => status === "queued" || status === "started"),
      keptAt: /waits? for the next start \(kept at (\w+)\)/.exec(closeLog)?.[1] ?? "none",
      handedAfterRestart: dispatches(bot.threadId) - handedBeforeRestart,
      replies: after.filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length,
    };
  };
  // a late-write refusal hold (the engine accepted a provider turn) is not kept: the close line, once, and the message never runs again
  const expectClosedWithItsLine = (late: Awaited<ReturnType<typeof lateRefusedAsServerCloses>>) => {
    expect(late.stoppedRows, "exactly one close line").toBe(1);
    expect(late.errorRows, "no error row").toBe(0);
    expect(late.sendStatuses, "its send row is neither waiting nor started").toEqual([]);
    expect({ keptAt: late.keptAt, handedAfterRestart: late.handedAfterRestart, replies: late.replies }, "never run again").toEqual({ keptAt: "none", handedAfterRestart: 0, replies: 1 });
    expect({ exited: late.exited, closedAtThisThread: late.closedAtThisThread, sendAnswer: late.sendAnswer, ownerLines: late.ownerLines }).toEqual({ exited: true, closedAtThisThread: true, sendAnswer: 202, ownerLines: 1 });
    expect(late.siteLines, "the hold site this cell went through (the terminal fold)").toEqual(["late-fold"]);
  };
  it("LATE-HOLD: a turn refused at its late write and held for its rebuild when the close begins gets the close line once, is not kept and never runs again", async () => {
    // LATE-HOLD (13de5e8117: the turn is kept at the close, its dying rebuild is refused, and settleWithCard marks the requeued row failed: no row, no answer)
    expectClosedWithItsLine(await lateRefusedAsServerCloses("Late hold", "latehold"));
  }, 240_000);
  it("LATE-START: the same turn, the close beginning at its rebuild's own start, gets the close line once and never runs again", async () => {
    expectClosedWithItsLine(await lateRefusedAsServerCloses("Late start", "latestart"));
  }, 240_000);
});
