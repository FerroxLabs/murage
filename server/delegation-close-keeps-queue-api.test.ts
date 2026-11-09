// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A handoff queued by a turn that the SERVER'S CLOSE ends survives the restart; one the owner Stopped does not.
//
// STOP-NONACP (628bc2fab) makes a dispose end every live turn with the engine-closed line (ok:false). The turn's end used to discard its queued handoffs, so a
// quit or restart mid-turn dropped delegated work that nobody had stopped. While the server is closing, a shutdown ending (ok:false, not a Stop) keeps the queue
// on disk for the next start's boot drain; an asked Stop (ok:true "cancelled") still discards, even when its completion lands after the close began.
//
// Real server, real restart (SIGTERM), the isolated fake Claude CLI. Direct handoffs and a team room's (request-backed) handoffs.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { SERVER_SHUTDOWN_TIMEOUT_MS } from "./graceful-shutdown.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, headers: Record<string, string>, model: string;
const posixOnly = describe.skipIf(process.platform === "win32");

const signIn = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const text = (message: any) => String(message.text ?? message.tool?.name ?? "");
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
const onlyThese = async (...ids: string[]) => {
  for (const bot of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${bot.id}`, { hidden: !ids.includes(bot.id) });
};
const rows = (sql: string, ...args: string[]) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare(sql).all(...args) as any[]; } finally { db.close(); }
};
const receipt = (taskId: string): { status: string } | undefined => {
  const file = join(fixture.info.dataDir, "delegation-receipts.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; status: string }>).find(row => row.id === taskId) : undefined;
};
const promptReachedEngine = (tag: string) => expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(tag), { timeout: 20_000 }).toBe(true);
/** A held turn on `send` (a bot's or a room's message route) and the bearer its mounted agents server carries. */
const holdTurn = async (route: string, body: Record<string, unknown>, tag: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect([200, 202]).toContain((await api("POST", route, { ...body, text: `__fixture_hold_authority__ ${tag}` })).status);
  await promptReachedEngine(tag);
  const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
  const token = dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN as string;
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  return { pid: dump.pid as number, internal: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
};
const queueHandoff = async (turn: { internal: Record<string, string> }, from: { id: string; threadId: string }, to: { id: string }, message: string) => {
  const queued = await fetch(`${fixture.info.url}/api/internal/delegate-bot`, { method: "POST", headers: turn.internal, body: JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: to.id, message, depth: 0 }) });
  const body = await queued.json() as { taskId: string; queued?: boolean };
  expect(queued.status, JSON.stringify(body)).toBe(200);
  expect(body.queued).toBe(true);
  return body.taskId;
};
/** A clean close and a new server: the close must end by itself (exit 0), so a load spike cannot turn these cases into the crash case. */
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleanRestart = async (hooks: { before?: () => Promise<void>; duringClose?: () => Promise<void>; afterExit?: () => Promise<void> } = {}) => {
  await hooks.before?.();
  const closing = fixture.child;
  const ended = new Promise<[number | null, string | null]>(resolve => { closing.once("close", (code, signal) => resolve([code, signal])); });
  closing.kill("SIGTERM");
  await hooks.duringClose?.();
  expect(await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 2 * SERVER_SHUTDOWN_TIMEOUT_MS, "still running"))])).toEqual([0, null]);
  await hooks.afterExit?.();
  await fixture.restart();
  await signIn();
};
const ranOnTarget = (threadId: string, tag: string) => expect.poll(async () => (await messages(threadId)).some(message => text(message).includes(tag)), { timeout: 60_000 });

beforeAll(async () => {
  fixture = await launchVerificationServer({});
  await signIn();
  model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 90_000);
afterAll(async () => { await fixture?.close(); });

posixOnly("a handoff queued by a turn the server's close ends", () => {
  it("a direct handoff stays queued through the close and the boot drain runs it once on the new server", async () => {
    const source = await createBot("CloseKeepSource"), target = await createBot("CloseKeepTarget");
    await onlyThese(source.id, target.id);
    const turn = await holdTurn(`/api/bots/${source.id}/messages`, { threadId: source.threadId }, "DIRECT_HOLD");
    const taskId = await queueHandoff(turn, source, target, "DIRECT_KEPT_TAG please run after the restart");
    expect(rows("SELECT id FROM pending_delegations WHERE id=?", taskId)).toHaveLength(1);

    const oldLog = fixture.info.logPath;
    await cleanRestart({ afterExit: async () => {
      // the server's own trace: the close ended the source turn and kept its queue
      expect(readFileSync(oldLog, "utf8")).toContain(`the close ended the turn of thread=${source.threadId}; its queued handoffs stay for the next start`);
      // the old server is gone and it ran nothing: the row is still queued ("fresh", never started), so only the NEW server's boot drain can run it
      expect(rows("SELECT id, phase, started_at FROM pending_delegations WHERE id=?", taskId).map(row => [row.phase, row.started_at])).toEqual([["fresh", null]]);
    } });
    await ranOnTarget(target.threadId, "DIRECT_KEPT_TAG").toBe(true);
    await expect.poll(() => receipt(taskId)?.status, { timeout: 60_000 }).toBe("done");
    expect(rows("SELECT id FROM pending_delegations WHERE id=?", taskId)).toEqual([]);
    const heard = await messages(target.threadId);
    expect(heard.filter(message => message.role === "user" && text(message).includes("DIRECT_KEPT_TAG"))).toHaveLength(1);
    // the engine took it and answered: a bot reply follows the handoff's prompt
    const promptAt = heard.findIndex(message => message.role === "user" && text(message).includes("DIRECT_KEPT_TAG"));
    expect(heard.slice(promptAt + 1).some(message => message.role === "bot" && message.kind === "text")).toBe(true);
  }, 180_000);

  // A request-backed handoff is bound to the room request that asked for it (CANCEL-TREE-104 D1: a request that ends other than done closes what depends on its
  // answer). The close ends the lead's room turn, so that request ends and the handoff it was waiting on is closed with it, exactly as after a crash
  // (reconcileRoomRequestsAtBoot ends the running turn as unknown, with the same cancel). It is not lost silently: the request and the handoff row end together
  // and the room is told once. It is NOT run on the new server: nobody is left to receive its answer.
  it("a team room's request-backed handoff ends with the room turn the close ended: closed once and told, never run, never left behind", async () => {
    const lead = await createBot("CloseRoomLead"), helper = await createBot("CloseRoomHelper");
    await onlyThese(lead.id, helper.id);
    const made = await api("POST", "/api/groups", { name: "close-room", memberIds: [lead.id, helper.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const room = made.body.group as { id: string; threadId: string };
    const turn = await holdTurn(`/api/groups/${room.id}/messages`, {}, "ROOM_HOLD");
    const taskId = await queueHandoff(turn, { id: lead.id, threadId: room.threadId }, helper, "ROOM_ENDED_TAG must never run");
    expect(rows("SELECT origin FROM pending_delegations WHERE id=?", taskId).map(row => row.origin)).toEqual(["room"]);

    await cleanRestart();
    await expect.poll(() => rows("SELECT id FROM pending_delegations WHERE id=?", taskId).length, { timeout: 60_000 }).toBe(0);
    await pause(4_000);
    const detail = () => JSON.stringify(rows("SELECT id, verb, state, outcome_note FROM room_requests ORDER BY created_at"));
    // the asker's room turn ended with the close; the handoff's request ended with it, both written by the one completion
    expect(rows("SELECT verb, state, outcome_note FROM room_requests WHERE verb IN ('room_turn','ask') ORDER BY verb DESC").map(row => [row.verb, row.state, row.outcome_note]), detail())
      .toEqual([["room_turn", "failed", null], ["ask", "cancelled", "cancelled with the request that asked"]]);
    expect((await messages(helper.threadId)).filter(message => text(message).includes("ROOM_ENDED_TAG")), detail()).toEqual([]);
    expect(receipt(taskId)?.status, detail()).toBe("cancelled");
    // the room is told exactly once, on the new server too (a restart settles nothing a second time)
    const told = (await messages(room.threadId)).filter(message => text(message) === "Hand-off to @CloseRoomHelper cancelled because the request that asked ended");
    expect(told, JSON.stringify((await messages(room.threadId)).map(text))).toHaveLength(1);
  }, 180_000);

  it("a Stop racing the close still discards the handoff: it never runs on the new server", async () => {
    const source = await createBot("CloseStopSource"), target = await createBot("CloseStopTarget");
    await onlyThese(source.id, target.id);
    const turn = await holdTurn(`/api/bots/${source.id}/messages`, { threadId: source.threadId }, "STOP_RACE_HOLD");
    const taskId = await queueHandoff(turn, source, target, "STOP_RACE_TAG must never run");

    // The order is forced, not hoped for: the engine process is frozen (SIGSTOP), so the Stop is sent to it and cannot be answered; the server then begins to
    // close (the dispatch gate is shut); only then does the engine wake (SIGCONT) and settle its turn. The Stop was asked before the close, its completion lands after.
    let stop: Promise<{ status: number }> = Promise.resolve({ status: 0 });
    const oldLog = fixture.info.logPath;
    await cleanRestart({
      before: async () => {
        process.kill(turn.pid, "SIGSTOP");
        stop = api("POST", `/api/bots/${source.id}/interrupt`, { threadId: source.threadId });
        await pause(1_000);
        // the Stop is on its way to a frozen engine: nothing has settled, so the handoff is still queued and unreceipted when the close begins
        expect(rows("SELECT id FROM pending_delegations WHERE id=?", taskId)).toHaveLength(1);
        expect(receipt(taskId)).toBeUndefined();
      },
      duringClose: async () => { await pause(1_500); try { process.kill(turn.pid, "SIGCONT"); } catch { /* the close already reaped it */ } },
    });
    expect((await stop).status).toBe(200);
    await pause(6_000);
    // the server's own trace of the order: the Stop's cancelled completion was handled with the dispatch gate already shut, and it discarded
    const trace = readFileSync(oldLog, "utf8");
    expect(trace).toContain(`a Stop landed after the close began, thread=${source.threadId}; its queued handoffs are discarded`);
    expect(trace).not.toContain(`the close ended the turn of thread=${source.threadId}`);
    expect((await messages(target.threadId)).filter(message => text(message).includes("STOP_RACE_TAG"))).toEqual([]);
    expect(rows("SELECT id FROM pending_delegations WHERE id=?", taskId)).toEqual([]);
    expect(receipt(taskId)?.status).toBe("dropped");
  }, 180_000);

  it("a Stop while the server is open discards the handoff, and a restart afterwards finds nothing to run", async () => {
    const source = await createBot("OpenStopSource"), target = await createBot("OpenStopTarget");
    await onlyThese(source.id, target.id);
    const turn = await holdTurn(`/api/bots/${source.id}/messages`, { threadId: source.threadId }, "OPEN_STOP_HOLD");
    const taskId = await queueHandoff(turn, source, target, "OPEN_STOP_TAG must never run");
    expect((await api("POST", `/api/bots/${source.id}/interrupt`, { threadId: source.threadId })).status).toBe(200);
    await expect.poll(() => receipt(taskId)?.status, { timeout: 15_000 }).toBe("dropped");

    await cleanRestart();
    await new Promise(resolve => setTimeout(resolve, 4_000));
    expect((await messages(target.threadId)).filter(message => text(message).includes("OPEN_STOP_TAG"))).toEqual([]);
    expect(rows("SELECT id FROM pending_delegations WHERE id=?", taskId)).toEqual([]);
  }, 180_000);
});
