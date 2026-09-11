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
import { hostStoppedReason } from "../shared/host-stop.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let sessionGate: string, terminalGate: string, redispatchHold: string, browserHold: string, dumpPath: string, agentsEnvPath: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const chips = (thread: any[]) => thread.filter(message => typeof message.tool?.name === "string" && message.tool.name.startsWith("error:")).map(message => message.tool.name);
const stoppedNotices = (thread: any[]) => thread.filter(message => message.kind === "activity" && hostStoppedReason(message.tool?.name));
const dispatches = (): Array<{ turnId: string; threadId: string; skillAuthoring: boolean }> => existsSync(dumpPath) ? readFileSync(dumpPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const disclosures = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT state FROM memory_disclosures WHERE thread_id=? ORDER BY created_at").all(threadId).map(row => (row as { state: string }).state); }
  finally { db.close(); }
};
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const resetGates = () => { for (const path of [sessionGate, `${sessionGate}.waiting`, terminalGate, `${terminalGate}.emitted`, redispatchHold, `${redispatchHold}.waiting`, `${redispatchHold}.armed`, browserHold, `${browserHold}.waiting`, `${browserHold}.armed`, dumpPath, agentsEnvPath]) rmSync(path, { force: true }); };
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
  expect(dispatches()).toEqual([{ turnId: refusedTurnId, threadId, skillAuthoring: true }]);
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
  expect(rows[0]).toEqual({ turnId: refusedTurnId, threadId, skillAuthoring: true });
  // the re-dispatch took the claim its refused attempt handed back
  expect(rows[1]).toEqual({ turnId: expect.any(String), threadId, skillAuthoring: true });
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
      // Fixture hold on the browser capability's registration (RED2L): the
      // engine binary is the node executable (found, never run) and its
      // version check — the one await between a room member's busy claim
      // and its room claim — is held, one-shot, while <browser-hold>.armed
      // exists, and released by <browser-hold>. Same shape as
      // server/testing/unified-browser-fixture.mjs.
      process.env.MURAGE_AGENT_BROWSER_PATH=process.execPath;
      const { registerHooks } = await import('node:module');
      const browserHold=path.join(dataDir,'browser-hold');
      registerHooks({ load(url, context, nextLoad) {
        if(!url.endsWith('/browser-engine.ts'))return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const start=source.indexOf('export async function verifyAgentBrowserBinary(');
        const end=source.indexOf('export async function ensureChrome(',start);
        if(start<0||end<0)throw new Error('Browser version fixture anchor changed');
        return { format:'module-typescript', shortCircuit:true, source: source.slice(0,start)+\`
export async function verifyAgentBrowserBinary(binary, env) {
  const fs = await import('node:fs');
  const hold = \${JSON.stringify(browserHold)};
  if (!fs.existsSync(hold + '.armed')) return;
  fs.rmSync(hold + '.armed', { force: true });
  fs.writeFileSync(hold + '.waiting', env.AGENT_BROWSER_SESSION ?? '');
  await new Promise(resolve => { const poll = setInterval(() => { if (!fs.existsSync(hold)) return; clearInterval(poll); resolve(); }, 20); });
}
\`+source.slice(end) };
      } });
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // The skill recorder is on, so a hop-0 member turn takes the round's
      // skill-authoring claim (the fixture driver declares agentsMcp).
      cfg.features={...(cfg.features??{}),skillRecorder:true,browser:true};
      cfg.instances.late={driver:'fakeLateTerminal',displayName:'Late-terminal fixture',
        environment:{FAKE_LATE_SESSION_GATE:path.join(dataDir,'late-session-gate'),FAKE_LATE_TERMINAL_GATE:path.join(dataDir,'late-terminal-gate'),FAKE_LATE_DUMP:path.join(dataDir,'late-dump.jsonl'),FAKE_LATE_AGENTS_ENV:path.join(dataDir,'late-agents-env.json')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    sessionGate = join(fixture.info.dataDir, "late-session-gate");
    terminalGate = join(fixture.info.dataDir, "late-terminal-gate");
    redispatchHold = join(fixture.info.dataDir, "redispatch-hold");
    browserHold = join(fixture.info.dataDir, "browser-hold");
    dumpPath = join(fixture.info.dataDir, "late-dump.jsonl");
    agentsEnvPath = join(fixture.info.dataDir, "late-agents-env.json");
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

  // RED2J (RED2I verifier): runGroupMemberTurn checks that its internal
  // generation still owns the thread after the room claim and before the
  // dispatch. That generation can be revoked in that window by the harness
  // itself — the member's model or connected-app access changed, its thread
  // was stopped or deleted, the provider fleet reloaded — and the check used
  // to `return false` with the room's busyBotId still held, the member still
  // working, no chip and no reply: a silently stuck room. Every exit after
  // the claim now releases the room and the bot through the same path a
  // rejected dispatch takes, and a "stopped:" notice (shared/host-stop.ts)
  // says why. The window is held by the same fixture hold on waitForClear
  // (the last await before that check); the owner's access review for the
  // speaking member revokes the generation (revokeInternalBot) while held.
  it("room member path: a generation revoked between the claim and the dispatch releases the room with a stopped notice", async () => {
    const member = await createBot("Revoked owner member"), other = await createBot("Revoked owner other");
    const createdRoom = await api("POST", "/api/groups", { name: "Revoked owner room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    resetGates();
    // Turns run ungated here: the window under test is before sendTurn.
    writeFileSync(sessionGate, "");
    expect((await replies(room.threadId)).length).toBe(0);
    // The member turn of exactly this thread is held after the room claim,
    // before the owner check.
    writeFileSync(`${redispatchHold}.armed`, room.threadId);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn whose generation is revoked before dispatch" })).status).toBe(202);
    await expect.poll(() => existsSync(`${redispatchHold}.waiting`), { timeout: 15000 }).toBe(true);
    expect(readFileSync(`${redispatchHold}.waiting`, "utf8")).toBe(room.threadId);
    expect((await groupState(room.id)).busyBotId).toBe(member.id);
    expect((await botState(member.id)).busy).toBe(true);
    expect(dispatches()).toEqual([]);
    // Inside that window the owner reviews the member's connected-app
    // access: the harness revokes every internal turn of that bot.
    const view = await api("GET", `/api/bots/${member.id}/access`);
    expect(view.status).toBe(200);
    expect((await api("PUT", `/api/bots/${member.id}/access`, { action: "configure", revision: view.body.policy.revision, mode: "unrestricted", allowWrites: true, grants: [] })).status).toBe(200);
    writeFileSync(redispatchHold, "");

    // Without the release the room stays busy here: busyBotId held, the
    // member working, no chip, no reply, and no later message answered.
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    const thread = await messages(room.threadId);
    expect(chips(thread)).toEqual([]);
    expect((await replies(room.threadId)).length).toBe(0);
    expect(dispatches()).toEqual([]);
    const notices = stoppedNotices(thread);
    expect(notices).toHaveLength(1);
    expect(notices[0].from?.botId).toBe(member.id);
    expect(notices[0].tool.ok).toBe(false);
    expect(hostStoppedReason(notices[0].tool.name)).toBe("the bot's settings or access changed while its turn was being set up, so it was not started");
    // and the room is free: the next message runs to a reply.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "runs after the revoked room turn" })).status).toBe(202);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 15000 }).toBe(1);
    expect((await replies(room.threadId))[0].from.botId).toBe(member.id);
    expect((await replies(room.threadId))[0].text).toBe("Hello from late");
    expect(dispatches()).toEqual([{ turnId: expect.any(String), threadId: room.threadId, skillAuthoring: true }]);
    expect(chips(await messages(room.threadId))).toEqual([]);
    expect(stoppedNotices(await messages(room.threadId))).toHaveLength(1);
  }, 120000);

  // RED2K (RED2J verifier): the exit right after waitForClear — Stop landed,
  // or the claim is no longer this attempt's — released the room and the bot
  // through an inline copy of the release, which left the round's
  // skill-authoring claim taken and did not drain the queues: a continuation
  // queued for the member while it was held in the room (here a credential
  // card on its own thread answered in that window, parked because the bot
  // was busy) stayed parked, with no turn.completed ever coming to retry
  // it. Every unstarted exit now goes through releaseUnstartedRoomTurn. Held
  // by the same fixture hold on waitForClear; Stop lands while held.
  it("room member path: Stop inside the claim window drains a continuation queued for the member and hands back the skill-authoring claim", async () => {
    const member = await createBot("Stopped in window member"), other = await createBot("Stopped in window other");
    const createdRoom = await api("POST", "/api/groups", { name: "Stopped in window room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    resetGates();
    const directRepliesBefore = (await replies(member.threadId)).length;
    // A credential request card on the member's own thread, raised by the
    // member's turn there (the agents comms token of that turn, while the
    // session gate holds it before acceptance), then the turn completes.
    expect((await api("POST", `/api/bots/${member.id}/messages`, { threadId: member.threadId, text: "a turn that asks for a credential" })).status).toBe(202);
    await expect.poll(() => existsSync(`${sessionGate}.waiting`), { timeout: 15000 }).toBe(true);
    const agentsEnv = JSON.parse(readFileSync(agentsEnvPath, "utf8")) as Record<string, string>;
    expect(agentsEnv.MURAGE_THREAD_ID).toBe(member.threadId);
    const card = await fetch(`${fixture.info.url}/api/internal/request-credential`, { method: "POST", headers: { authorization: `Bearer ${agentsEnv.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: member.id, fromThreadId: member.threadId, credentialId: "openaiImageApiKey", reason: "queued continuation under test" }) });
    expect(card.status).toBe(201);
    const { messageId } = await card.json() as { messageId: string };
    writeFileSync(sessionGate, "");
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    await expect.poll(async () => (await replies(member.threadId)).length, { timeout: 15000 }).toBe(directRepliesBefore + 1);
    expect(dispatches()).toEqual([{ turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true }]);
    // The member turn of exactly this room thread is held after the room claim.
    writeFileSync(`${redispatchHold}.armed`, room.threadId);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn stopped while its claim was being set up" })).status).toBe(202);
    await expect.poll(() => existsSync(`${redispatchHold}.waiting`), { timeout: 15000 }).toBe(true);
    expect(readFileSync(`${redispatchHold}.waiting`, "utf8")).toBe(room.threadId);
    expect((await groupState(room.id)).busyBotId).toBe(member.id);
    expect((await botState(member.id)).busy).toBe(true);
    // Answered while the member is busy in the room: the continuation of
    // its own thread is queued for when the member settles.
    const dismissed = await api("POST", `/api/bots/${member.id}/secret-cards/${messageId}/dismiss`, { threadId: member.threadId });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ dismissed: true, resumed: true });
    expect((await messages(member.threadId)).find(message => message.id === messageId)?.secret).toMatchObject({ dismissed: true, resumed: true });
    expect(dispatches()).toHaveLength(1);
    // Stop the member while its room turn is held before dispatch.
    expect((await api("POST", `/api/bots/${member.id}/interrupt`, {})).status).toBe(200);
    writeFileSync(redispatchHold, "");

    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    // The queued continuation is not left behind: with no provider turn
    // there is no turn.completed to retry it, so the unstarted exit drains
    // it — it runs on the member's thread to a reply. Without the one
    // release path it stays queued here until some unrelated turn settles.
    await expect.poll(async () => (await replies(member.threadId)).length, { timeout: 15000 }).toBe(directRepliesBefore + 2);
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    expect((await replies(member.threadId)).at(-1)?.text).toBe("Hello from late");
    expect(chips(await messages(member.threadId))).toEqual([]);
    // The stopped room turn itself never dispatched and posted nothing.
    expect(dispatches()).toEqual([
      { turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true },
      { turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true },
    ]);
    expect(chips(await messages(room.threadId))).toEqual([]);
    expect((await replies(room.threadId)).length).toBe(0);
    // and the round's skill-authoring claim was handed back: the next room
    // turn on that member runs with the skill-authoring tools.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "/learn runs after the stopped room turn" })).status).toBe(202);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 15000 }).toBe(1);
    expect((await replies(room.threadId))[0].from.botId).toBe(member.id);
    expect(dispatches()).toHaveLength(3);
    expect(dispatches()[2]).toEqual({ turnId: expect.any(String), threadId: room.threadId, skillAuthoring: true });
    expect(chips(await messages(room.threadId))).toEqual([]);
    expect(chips(await messages(member.threadId))).toEqual([]);
  }, 120000);
  // RED2L (RED2K verifier): one exit sits BEFORE the room claim. A member
  // turn marks the bot working, then mints its browser capability — the one
  // await between that busy claim and the room claim — and re-checks; a
  // Stop landing inside that window used to idle the bot inline without
  // draining the queues. A continuation parked for the member while it was
  // busy there (a credential card on its own thread answered in that
  // window) stayed parked until some unrelated turn.completed. The exit now
  // releases through releaseUnclaimedRoomTurn (server/room-turn-release.ts):
  // the bot idle by the activity it set — never the room, which it does not
  // own — this attempt's browser capability released, the queues drained.
  // Held by a fixture hold on the browser engine's version check; the
  // member's browser is switched on only after its 1:1 turn, so the room
  // turn is the first to mint (and hold) its capability.
  it("room member path: Stop while the browser capability is minted, before the room claim, drains a continuation queued for the member and idles it", async () => {
    const member = await createBot("Stopped before claim member"), other = await createBot("Stopped before claim other");
    const createdRoom = await api("POST", "/api/groups", { name: "Stopped before claim room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    resetGates();
    const directRepliesBefore = (await replies(member.threadId)).length;
    // A credential request card on the member's own thread, raised by the
    // member's turn there while the session gate holds it; the turn completes.
    expect((await api("POST", `/api/bots/${member.id}/messages`, { threadId: member.threadId, text: "a turn that asks for a credential" })).status).toBe(202);
    await expect.poll(() => existsSync(`${sessionGate}.waiting`), { timeout: 15000 }).toBe(true);
    const agentsEnv = JSON.parse(readFileSync(agentsEnvPath, "utf8")) as Record<string, string>;
    expect(agentsEnv.MURAGE_THREAD_ID).toBe(member.threadId);
    const card = await fetch(`${fixture.info.url}/api/internal/request-credential`, { method: "POST", headers: { authorization: `Bearer ${agentsEnv.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: member.id, fromThreadId: member.threadId, credentialId: "openaiImageApiKey", reason: "queued continuation under test" }) });
    expect(card.status).toBe(201);
    const { messageId } = await card.json() as { messageId: string };
    writeFileSync(sessionGate, "");
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    await expect.poll(async () => (await replies(member.threadId)).length, { timeout: 15000 }).toBe(directRepliesBefore + 1);
    expect(dispatches()).toEqual([{ turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true }]);
    // The member's browser goes on now: its room turn is the first to mint
    // the capability, and the engine's version check is held.
    expect((await api("PATCH", `/api/bots/${member.id}`, { browser: true })).status).toBe(200);
    writeFileSync(`${browserHold}.armed`, "");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn stopped while its browser capability was being minted" })).status).toBe(202);
    await expect.poll(() => existsSync(`${browserHold}.waiting`), { timeout: 15000 }).toBe(true);
    // Inside the window: the member is busy (its activity), the room claim
    // is not yet taken, nothing dispatched.
    expect((await botState(member.id)).busy).toBe(true);
    expect((await groupState(room.id)).busyBotId ?? null).toBeNull();
    expect(dispatches()).toHaveLength(1);
    // Answered while the member is busy: the continuation of its own thread
    // is parked for when the member settles.
    const dismissed = await api("POST", `/api/bots/${member.id}/secret-cards/${messageId}/dismiss`, { threadId: member.threadId });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ dismissed: true, resumed: true });
    expect((await messages(member.threadId)).find(message => message.id === messageId)?.secret).toMatchObject({ dismissed: true, resumed: true });
    expect(dispatches()).toHaveLength(1);
    // Stop the member while its capability is still being minted, then let
    // the mint finish: the turn's own re-check sees the Stop.
    expect((await api("POST", `/api/bots/${member.id}/interrupt`, {})).status).toBe(200);
    writeFileSync(browserHold, "");

    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    // The parked continuation is drained by the unstarted exit itself — no
    // provider turn ran, so no turn.completed would ever retry it — and runs
    // on the member's thread to a reply. Without the drain it stays parked
    // here.
    await expect.poll(async () => (await replies(member.threadId)).length, { timeout: 15000 }).toBe(directRepliesBefore + 2);
    await expect.poll(async () => (await botState(member.id)).busy, { timeout: 15000 }).toBe(false);
    expect((await replies(member.threadId)).at(-1)?.text).toBe("Hello from late");
    expect(chips(await messages(member.threadId))).toEqual([]);
    // The stopped room turn never dispatched and posted nothing.
    expect(dispatches()).toEqual([
      { turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true },
      { turnId: expect.any(String), threadId: member.threadId, skillAuthoring: true },
    ]);
    expect(chips(await messages(room.threadId))).toEqual([]);
    expect((await replies(room.threadId)).length).toBe(0);
    expect(stoppedNotices(await messages(room.threadId))).toHaveLength(0);
    // and the room is free: the next message runs to a reply, with the
    // member's browser capability minted without a hold.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "runs after the room turn stopped before its claim" })).status).toBe(202);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 15000 }).toBe(1);
    expect((await replies(room.threadId))[0].from.botId).toBe(member.id);
    expect(dispatches()).toHaveLength(3);
    expect(dispatches()[2]).toEqual({ turnId: expect.any(String), threadId: room.threadId, skillAuthoring: true });
    expect(chips(await messages(room.threadId))).toEqual([]);
    expect(chips(await messages(member.threadId))).toEqual([]);
    expect(existsSync(`${browserHold}.armed`)).toBe(false);
  }, 120000);
});
