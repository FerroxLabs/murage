// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CANCEL-TREE-104 R1 v2 (lanes/release104/designs/CANCEL-TREE-104.md, R1): before its claim a room member turn reads its own request row at every
// setup step, so a cancel that lands while the turn is still being set up never reaches the provider; after the claim only the turn bound to the
// request is interrupted. These run the real server with the fixture engine (server/testing/fake-late-terminal-driver.ts). The preload holds a
// member turn's prepareThread on demand (a deterministic cancel point in the setup), can refuse one submission with MEMORY_CONTEXT_REVOKED before
// anything is written (the real re-dispatch path), and records every interruptTurn. Each sendTurn is one line in the dump: a provider submission.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { insertRoomRequest, type RoomRequestLineage } from "./room-requests.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const at = (name: string) => join(fixture.info.dataDir, name);
const href = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (method: string, path: string, body?: unknown) => {
  const res = await api(method, path, body);
  if (res.status < 200 || res.status > 299) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
};
const lines = (name: string) => existsSync(at(name)) ? readFileSync(at(name), "utf8").split("\n").filter(Boolean) : [];
/** Provider submissions on a thread: one dump line per sendTurn. */
const submissions = (threadId: string) => lines("dump").map(line => JSON.parse(line)).filter(row => row.threadId === threadId && !row.prompt).length;
/** Prompt writes on a thread: one line each time the adapter's beforeSubmit passed (what the engine would actually be sent). */
const writes = (threadId: string) => lines("writes").filter(line => line === threadId).length;
const interrupts = (threadId: string) => lines("interrupts").filter(line => line === threadId).length;
const replies = async (threadId: string) => ((await ok("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[])
  .filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length;
const botIdle = async (botId: string) => (await ok("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy !== true;
const withDb = <T>(run: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=10000"); return run(db); } finally { db.close(); }
};
const rowState = (id: string) => withDb(db => (db.prepare("SELECT state FROM room_requests WHERE id=?").get(id) as { state: string } | undefined)?.state);
const lineage = (threadId: string): RoomRequestLineage => ({ rootThreadId: threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
/** An asker waiting on its ask (the room's root, `waiting_bot`), so the owner may cancel it; optionally a child room turn for the member. */
const tree = (room: { id: string; threadId: string }, botId: string, child?: "queued" | "running") => withDb(db => {
  const tag = Math.random().toString(36).slice(2);
  const root = insertRoomRequest(db, { groupId: room.id, verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:${room.id}:t-${tag}`, lineage: lineage(room.threadId),
    targetThreadId: room.threadId, payloadText: "please look at this", now: Date.now() }).request;
  db.prepare("UPDATE room_requests SET state='waiting_bot' WHERE id=?").run(root.id);
  const turn = child ? insertRoomRequest(db, { groupId: room.id, verb: "room_turn", fromKind: "owner", toBotId: botId, targetThreadId: room.threadId, parentId: root.id,
    admissionKey: `room_turn:t-${tag}:${botId}`, payloadText: "please look at this", priority: "coordinator", state: child, now: Date.now() }).request : undefined;
  return { rootId: root.id, turnId: turn?.id };
});
/** Wake the room dispatcher the way the owner does: cancelling a spare waiting root pumps it (POST .../cancel). */
const pump = async (room: { id: string; threadId: string }, botId: string) => { const spare = tree(room, botId); await ok("POST", `/api/groups/${room.id}/requests/${spare.rootId}/cancel`); };
const cancel = async (room: { id: string }, rootId: string) => { await ok("POST", `/api/groups/${room.id}/requests/${rootId}/cancel`); };
/** Hold the member turn's prepareThread on `threadId` after `pass` calls have gone through; resolves once one is held. */
const holdPrepare = (threadId: string, pass: number) => { rmSync(at("prep-go"), { force: true }); rmSync(at("prep-held"), { force: true }); writeFileSync(at("prep-arm"), JSON.stringify({ id: Math.random(), threadId, pass })); };
const releasePrepare = () => writeFileSync(at("prep-go"), "");
const newBot = async (name: string) => {
  const bot = (await ok("POST", "/api/bots", { name, modelSelection: { instanceId: "late", model: "late-1" } })).bot as { id: string; threadId: string };
  await ok("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const newRoom = async (name: string, botId: string) => (await ok("POST", "/api/groups", { name, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).group as { id: string; threadId: string };
/** Everything the cancelled setup could still do has had its chance: the row is ended, the member is idle, and a moment more has passed. */
const settled = async (botId: string, turnId: string) => {
  await expect.poll(() => rowState(turnId), { timeout: 30000 }).toBe("cancelled");
  await expect.poll(async () => await botIdle(botId), { timeout: 30000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1500));
};

describe.skipIf(process.platform === "win32")("CANCEL-TREE R1 v2: a room setup reads its own row before the claim", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${href("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${href("server/testing/fake-late-terminal-driver.ts")});
      const {Store}=await import(${href("server/store.ts")});
      const {TurnSubmissionBoundary}=await import(${href("server/turn-dispatch-guard.ts")});
      const dir=process.env.MURAGE_DATA_DIR; const at=name=>path.join(dir,name);
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input); const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
        instance.adapter.interruptTurn=async threadId=>{fs.appendFileSync(at('interrupts'),threadId+'\\n');return interrupt(threadId);};
        // a write is a beforeSubmit that passed: counted apart from sendTurn calls
        const send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{const check=turn.beforeSubmit;return send({...turn,beforeSubmit:()=>{check?.();fs.appendFileSync(at('writes'),turn.threadId+'\\n');}});};
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      // prep-arm {id, threadId, pass}: a member turn's prepareThread on that thread lets 'pass' calls through, then holds one until prep-go exists
      const prepare=Store.prototype.prepareThread; const seen=new Map();
      Store.prototype.prepareThread=async function(threadId){
        if(fs.existsSync(at('prep-arm'))&&/runGroupMemberTurn/.test(new Error().stack??'')){
          const want=JSON.parse(fs.readFileSync(at('prep-arm'),'utf8'));
          if(want.threadId===threadId){
            const n=(seen.get(want.id)??0)+1; seen.set(want.id,n);
            if(n>want.pass){
              fs.rmSync(at('prep-arm'),{force:true}); fs.writeFileSync(at('prep-held'),String(n));
              await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(at('prep-go')))return;clearInterval(poll);resolve();},20);});
            }
          }
        }
        return prepare.call(this,threadId);
      };
      // refuse-once: the next submission's checks refuse with MEMORY_CONTEXT_REVOKED before anything is written (canRetry: the real re-dispatch)
      const before=TurnSubmissionBoundary.prototype.beforeSubmit;
      TurnSubmissionBoundary.prototype.beforeSubmit=function(validate){
        if(fs.existsSync(at('refuse-once'))){fs.rmSync(at('refuse-once'),{force:true});return before.call(this,()=>{throw new Error('MEMORY_CONTEXT_REVOKED');});}
        return before.call(this,validate);
      };
      const file=at('config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.late={driver:'fakeLateTerminal',environment:{FAKE_LATE_DUMP:at('dump'),FAKE_LATE_SESSION_GATE:at('session-gate')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    writeFileSync(at("session-gate"), "");   // the engine answers at once unless a test takes the gate away
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("a queued room turn cancelled while its setup awaits prepareThread never reaches the provider", async () => {
    const bot = await newBot("Setup one");
    const room = await newRoom("Setup room one", bot.id);
    const queued = tree(room, bot.id, "queued");
    holdPrepare(room.threadId, 0);
    await pump(room, bot.id);
    await expect.poll(() => existsSync(at("prep-held")), { timeout: 30000 }).toBe(true);
    await cancel(room, queued.rootId);
    releasePrepare();
    await settled(bot.id, queued.turnId!);
    expect(submissions(room.threadId)).toBe(0);
    expect(writes(room.threadId)).toBe(0);
    expect(await replies(room.threadId)).toBe(0);
  }, 120000);

  it("the re-dispatch after a refused memory context is cancelled in its setup: no second submission", async () => {
    const bot = await newBot("Setup two");
    const room = await newRoom("Setup room two", bot.id);
    const queued = tree(room, bot.id, "queued");
    // the first attempt passes prepareThread, claims, and its submission is refused before the write; the re-dispatch is held in prepareThread
    writeFileSync(at("refuse-once"), "");
    holdPrepare(room.threadId, 1);
    await pump(room, bot.id);
    await expect.poll(() => existsSync(at("prep-held")), { timeout: 30000 }).toBe(true);
    expect(existsSync(at("refuse-once"))).toBe(false);   // the first attempt's submission was the refused one
    expect(submissions(room.threadId)).toBe(1);
    expect(rowState(queued.turnId!)).toBe("running");     // claimed: the re-dispatch holds the row in roomTurnRequests, with no generation yet
    await cancel(room, queued.rootId);
    releasePrepare();
    await settled(bot.id, queued.turnId!);
    expect(submissions(room.threadId)).toBe(1);
    expect(writes(room.threadId)).toBe(0);
    expect(await replies(room.threadId)).toBe(0);
    // the refusal left no key behind: the next owner message in this room is answered as usual
    await ok("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "a new question after the cancel" });
    await expect.poll(async () => await replies(room.threadId), { timeout: 30000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 30000 }).toBe(true);
  }, 120000);

  it("an uncancelled re-dispatch after a refused memory context answers once", async () => {
    const bot = await newBot("Setup retry");
    const room = await newRoom("Setup room retry", bot.id);
    const queued = tree(room, bot.id, "queued");
    writeFileSync(at("refuse-once"), "");
    await pump(room, bot.id);
    await expect.poll(async () => await replies(room.threadId), { timeout: 30000 }).toBe(1);
    await expect.poll(() => rowState(queued.turnId!), { timeout: 30000 }).toBe("done");
    expect(submissions(room.threadId)).toBe(2);
    expect(writes(room.threadId)).toBe(1);
  }, 120000);

  it("a claimed turn cancelled before its engine registered it writes nothing (memory off)", async () => {
    const mode = withDb(db => (db.prepare("SELECT mode FROM memory_meta WHERE id=1").get() as { mode: string }).mode);
    withDb(db => db.prepare("UPDATE memory_meta SET mode='off' WHERE id=1").run());
    try {
      const bot = await newBot("Setup four");
      const room = await newRoom("Setup room four", bot.id);
      const queued = tree(room, bot.id, "queued");
      // the engine holds sendTurn before it registers the turn, so an interrupt there is not heard
      rmSync(at("session-gate"), { force: true }); rmSync(at("session-gate.waiting"), { force: true });
      await pump(room, bot.id);
      await expect.poll(() => existsSync(at("session-gate.waiting")), { timeout: 30000 }).toBe(true);
      expect(rowState(queued.turnId!)).toBe("running");
      await cancel(room, queued.rootId);
      writeFileSync(at("session-gate"), "");
      await settled(bot.id, queued.turnId!);
      expect(submissions(room.threadId)).toBe(1);
      expect(writes(room.threadId)).toBe(0);
      expect(await replies(room.threadId)).toBe(0);
    } finally {
      writeFileSync(at("session-gate"), "");
      withDb(db => db.prepare("UPDATE memory_meta SET mode=? WHERE id=1").run(mode));
    }
  }, 120000);

  it("an ordinary room turn is not interrupted when another request on its thread is cancelled", async () => {
    const bot = await newBot("Setup three");
    const room = await newRoom("Setup room three", bot.id);
    rmSync(at("session-gate"), { force: true }); rmSync(at("session-gate.waiting"), { force: true });
    await ok("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "an ordinary question" });
    await expect.poll(() => existsSync(at("session-gate.waiting")), { timeout: 30000 }).toBe(true);   // bound to its own row, held in the provider handshake
    // another request on the same thread and member, running but bound to no turn: its asker is cancelled
    const other = tree(room, bot.id, "running");
    await cancel(room, other.rootId);
    expect(rowState(other.turnId!)).toBe("cancelled");
    writeFileSync(at("session-gate"), "");
    await expect.poll(async () => await replies(room.threadId), { timeout: 30000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 30000 }).toBe(true);
    expect(interrupts(room.threadId)).toBe(0);
    expect(submissions(room.threadId)).toBe(1);
    expect(writes(room.threadId)).toBe(1);
  }, 120000);
});
