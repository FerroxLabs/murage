// RED2I (RED2H verifier): a turn refused at acceptance (MEMORY_CONTEXT_REVOKED)
// is stopped and re-dispatched once (RED2G direct, RED2H room). The stop
// awaits interruptTurn, and pi/ACP resolve that only after the provider
// process closed, so the refused child's terminal event has always landed
// before the re-dispatch began. The adapter contract still allows a
// "requested, not observed" stop (Claude, Antigravity, BoxAgent): then the
// refused child's turn.completed can arrive AFTER the re-dispatch began its
// own internal generation but BEFORE that generation minted its memory
// token. The bus fold that clears a thread's internalTurnOwners entry used to
// do so on ANY terminal event carrying a turnId when the owner had no
// resolvable token — which is exactly the re-dispatch's state in that
// window — so the re-dispatch failed before memory dispatch and the person's
// message (or the room turn) was lost after all. The fold is owner-aware
// now: only the generation the provider turn was bound to is cleared.
//
// Deterministic through the real server with an in-process fixture driver
// (server/testing/fake-late-terminal-driver.ts) whose interruptTurn resolves
// at once and emits the stopped turn's terminal event only when the test
// releases FAKE_LATE_TERMINAL_GATE. The re-dispatch is held inside its window
// by a fixture hold on pendingCancelledProviderHandshakes.waitForClear — the
// last await both the direct path (startTurn) and the room path
// (runGroupMemberTurn) take before minting the memory token — armed for one
// thread and released by the test after the late terminal event was emitted.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let sessionGate: string, terminalGate: string, redispatchHold: string, dumpPath: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const chips = (thread: any[]) => thread.filter(message => typeof message.tool?.name === "string" && message.tool.name.startsWith("error:")).map(message => message.tool.name);
const dispatches = (): Array<{ turnId: string; threadId: string }> => existsSync(dumpPath) ? readFileSync(dumpPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const disclosures = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT state FROM memory_disclosures WHERE thread_id=? ORDER BY created_at").all(threadId).map(row => (row as { state: string }).state); }
  finally { db.close(); }
};
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const resetGates = () => { for (const path of [sessionGate, `${sessionGate}.waiting`, terminalGate, `${terminalGate}.emitted`, redispatchHold, `${redispatchHold}.waiting`, `${redispatchHold}.armed`, dumpPath]) rmSync(path, { force: true }); };
const createBot = async (name: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "late").models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "late", model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

/** Refuse the held attempt, let the re-dispatch begin and hold it before its
 * token mint, land the refused child's terminal event inside that window,
 * then release the re-dispatch. Returns the refused child's turn id. */
const refuseThenLandLateTerminal = async (threadId: string, revoke: () => Promise<void>, revokedLine: string) => {
  await expect.poll(() => existsSync(`${sessionGate}.waiting`), { timeout: 15000 }).toBe(true);
  const refusedTurnId = readFileSync(`${sessionGate}.waiting`, "utf8");
  expect(dispatches().map(row => row.turnId)).toEqual([refusedTurnId]);
  // Inside the handshake window the roster changes: the memory policy
  // revision moves and the prepared disclosure is no longer current.
  await revoke();
  // The re-dispatch of exactly this thread is held before its token mint.
  writeFileSync(`${redispatchHold}.armed`, threadId);
  writeFileSync(sessionGate, "");
  // Acceptance refuses the turn; interruptTurn returned without a terminal
  // event; the re-dispatch began its own generation and is now held.
  await expect.poll(() => serverLog().includes(revokedLine), { timeout: 15000 }).toBe(true);
  await expect.poll(() => existsSync(`${redispatchHold}.waiting`), { timeout: 15000 }).toBe(true);
  expect(readFileSync(`${redispatchHold}.waiting`, "utf8")).toBe(threadId);
  expect(existsSync(`${terminalGate}.emitted`)).toBe(false);
  // The refused child's terminal event lands now: after the re-dispatch
  // began, before it minted a token.
  writeFileSync(terminalGate, "");
  await expect.poll(() => existsSync(`${terminalGate}.emitted`), { timeout: 15000 }).toBe(true);
  expect(readFileSync(`${terminalGate}.emitted`, "utf8")).toBe(refusedTurnId);
  writeFileSync(redispatchHold, "");
  return refusedTurnId;
};
/** The refused child's terminal event was folded as a stale one for the
 * re-dispatch's owner (its leases were still released); the thread saw
 * exactly two dispatches — the refused child and its re-dispatch — and the
 * reply ran on a disclosure prepared and delivered under the moved
 * authority while the refused one stayed revoked. */
const expectStaleFoldAndTwoDispatches = (threadId: string, refusedTurnId: string) => {
  expect(serverLog()).toContain(`[turns] turn.completed for provider turn ${refusedTurnId} on thread ${threadId} is not bound to the current internal turn owner`);
  const rows = dispatches();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ turnId: refusedTurnId, threadId });
  expect(rows[1]).toEqual({ turnId: expect.any(String), threadId });
  expect(rows[1].turnId).not.toBe(refusedTurnId);
  expect(disclosures(threadId)).toEqual(["revoked", "delivered"]);
};

posixOnly("a refused child's late terminal event does not stop the re-dispatch", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeLateTerminalDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const dataDir=process.env.MURAGE_DATA_DIR;
      // Fixture hold on the last await before the memory token mint, for the
      // one thread named in <hold>.armed; one-shot, released by <hold>.
      const { PendingTurnCancellations } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "turn-dispatch-guard.ts")).href)});
      const hold=path.join(dataDir,'redispatch-hold');
      const waitForClear=PendingTurnCancellations.prototype.waitForClear;
      PendingTurnCancellations.prototype.waitForClear=async function(threadId){
        await waitForClear.call(this,threadId);
        if(!fs.existsSync(hold+'.armed')||fs.readFileSync(hold+'.armed','utf8')!==threadId)return;
        fs.rmSync(hold+'.armed',{force:true});
        fs.writeFileSync(hold+'.waiting',threadId);
        await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(hold))return;clearInterval(poll);resolve();},20);});
      };
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.late={driver:'fakeLateTerminal',displayName:'Late-terminal fixture',
        environment:{FAKE_LATE_SESSION_GATE:path.join(dataDir,'late-session-gate'),FAKE_LATE_TERMINAL_GATE:path.join(dataDir,'late-terminal-gate'),FAKE_LATE_DUMP:path.join(dataDir,'late-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    sessionGate = join(fixture.info.dataDir, "late-session-gate");
    terminalGate = join(fixture.info.dataDir, "late-terminal-gate");
    redispatchHold = join(fixture.info.dataDir, "redispatch-hold");
    dumpPath = join(fixture.info.dataDir, "late-dump.jsonl");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("direct path: the re-dispatched user turn still runs and exactly one reply lands", async () => {
    const bot = await createBot("Late terminal direct");
    resetGates();
    const repliesBefore = (await replies(bot.threadId)).length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "held, refused, re-dispatched under a late terminal event" })).status).toBe(202);
    const refusedTurnId = await refuseThenLandLateTerminal(bot.threadId, async () => {
      expect((await api("POST", "/api/bots", { name: "Roster change during direct dispatch", modelSelection: { instanceId: "late", model: "late-1" } })).status).toBe(201);
    }, `[memory] context revoked during dispatch on thread ${bot.threadId}; re-preparing once`);

    // Without the owner-aware fold the re-dispatch dies here with
    // "error: internal turn is no longer active" and no reply.
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 15000 }).toBe(repliesBefore + 1);
    const thread = await messages(bot.threadId);
    expect(chips(thread)).toEqual([]);
    expect(thread.filter(message => message.role === "user" && message.kind === "text").map(message => message.text)).toEqual(["held, refused, re-dispatched under a late terminal event"]);
    expect((await replies(bot.threadId)).at(-1)?.text).toBe("Hello from late");
    expectStaleFoldAndTwoDispatches(bot.threadId, refusedTurnId);
    // and the thread is free: a later turn runs to a reply.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "runs after the re-dispatched turn" })).status).toBe(202);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 15000 }).toBe(repliesBefore + 2);
    expect(chips(await messages(bot.threadId))).toEqual([]);
  }, 90000);

  it("room member path: the re-dispatched member turn still runs and exactly one reply lands", async () => {
    const member = await createBot("Late terminal member"), other = await createBot("Late terminal other");
    const createdRoom = await api("POST", "/api/groups", { name: "Late terminal room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    resetGates();
    expect((await replies(room.threadId)).length).toBe(0);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn held, refused, re-dispatched under a late terminal event" })).status).toBe(202);
    const refusedTurnId = await refuseThenLandLateTerminal(room.threadId, async () => {
      // A task created for the speaking member inside that window moves the
      // policy revision and revokes the room turn's prepared disclosure.
      const task = await api("POST", `/api/bots/${member.id}/tasks`, { title: "Created mid room dispatch" });
      expect(task.status).toBe(201);
    }, `[memory] context revoked during dispatch on thread ${room.threadId}; re-preparing once (room member Late terminal member)`);

    // Without the owner-aware fold the room settles with
    // "error: internal turn is no longer active" and no reply.
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 15000 }).toBe(1);
    const thread = await messages(room.threadId);
    expect(chips(thread)).toEqual([]);
    const reply = (await replies(room.threadId))[0];
    expect(reply.text).toBe("Hello from late");
    expect(reply.from.botId).toBe(member.id);
    expectStaleFoldAndTwoDispatches(room.threadId, refusedTurnId);
    // and the room is free for the next message.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "runs after the re-dispatched room turn" })).status).toBe(202);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 15000 }).toBe(2);
    expect((await replies(room.threadId))[1].from.botId).toBe(member.id);
    expect(chips(await messages(room.threadId))).toEqual([]);
  }, 120000);
});
