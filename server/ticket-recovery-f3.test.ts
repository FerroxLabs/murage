// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F3 02-4 (designs/F3.md section 1 "Ticket recovery", C3/C4/C5, tests 4 and 5): a synchronous ask that runs past its wait becomes a ticket that
// survives a restart. The ticket is an ordinary started `pending_delegations` row written in the wait's own timer tick (so a reply that already
// landed is returned, never turned into a ticket nobody settles), and its row stays until a PERSISTED receipt replaces it (receiptsPersisted).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import {
  HANDOFF_NOT_SETTLED, _loadPending, _resetPending, _simulateRestart, findDelegationReceipt, finishHandoff, onDelegationReceipt, onOwedHandoffReply,
  pendingDelegationInfo, reconcileStartedDelegations, resettleStranded,
} from "./delegations.ts";
import * as boundary from "./handoff-boundary.ts";
import { handoffReplyId, replayOwedReply } from "./handoff-reply.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, reconcileRoomRequestsAtBoot, roomRequest } from "./room-requests.ts";
import { Store } from "./store.ts";
import { resolveTask, taskStatusCode, type TaskResolutionDeps } from "./task-resolution.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { released } from "./testing/released.ts";

// what this lane adds, read off the module objects so that a base without them fails the one test that needs them, not the whole file
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lane = { ...delegations, ...boundary } as any;

const receiptsFile = () => join(DATA_DIR, "delegation-receipts.json");
/** The receipts file cannot be written: a directory (with something in it) stands where the file goes. */
const breakReceipts = () => { rmSync(receiptsFile(), { recursive: true, force: true }); mkdirSync(join(receiptsFile(), "blocker"), { recursive: true }); };
const mendReceipts = () => rmSync(receiptsFile(), { recursive: true, force: true });
const receiptsOnDisk = (): Array<{ id: string; status: string; result?: string }> => JSON.parse(readFileSync(receiptsFile(), "utf8"));
const startedRow = (id: string) => database().prepare("SELECT phase, origin, started_at, accepted_turn_id, submitted_at, turn_key, target_thread_id, item FROM pending_delegations WHERE id=?").get(id) as
  { phase: string; origin: string; started_at: number | null; accepted_turn_id: string | null; submitted_at: number | null; turn_key: string; target_thread_id: string; item: string } | undefined;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(() => { mendReceipts(); onOwedHandoffReply(undefined); onDelegationReceipt(undefined); _resetPending(); closeDatabase(); });

function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot(), target = store.createBot();
  store.patchBot(target.id, { name: "Helper" });
  // the server's writer of the owed line (index.ts onOwedHandoffReply) and its receipt listener's request completion (index.ts onDelegationReceipt)
  onOwedHandoffReply((receipt) => replayOwedReply(store, receipt));
  onDelegationReceipt((receipt) => {
    const request = roomRequest(database(), receipt.id);
    if (request && !isTerminalRoomRequestState(request.state)) completeRequest(database(), request.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now() });
  });
  return { store, from, target };
}
type Fixture = ReturnType<typeof setup>;
const deps = (): TaskResolutionDeps => ({
  receipt: findDelegationReceipt, pending: pendingDelegationInfo, watches: () => [], request: (id) => roomRequest(database(), id), requestSourceThread: () => null,
  delivered: "delivered", ...(lane.startedTicket ? { started: lane.startedTicket } : {}),
} as TaskResolutionDeps);
const roomAsk = (s: Fixture, id: string) => insertRoomRequest(database(), { id, groupId: "pair", verb: "ask", fromKind: "bot", fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId,
  admissionKey: `ask:${id}`, now: Date.now(), state: "running", lineage: { rootThreadId: s.from.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
/** An ordinary started row whose turn the provider took (what any hand-off's dispatch leaves while its turn runs). */
const acceptedStartedRow = (s: Fixture, id: string, origin: "owner" | "room") => database().prepare(`INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key,
  target_thread_id, started_at, accepted_turn_id, start_attempts, submitted_at) VALUES(?,?,?,?,'started',NULL,?,?,?,?,?,?,1,?)`)
  .run(id, s.from.threadId, s.target.id, s.from.id, JSON.stringify({ message: "look into it", depth: 0, attempts: 0 }), origin, `dlg-${id}`, s.target.threadId, Date.now(), "turn-1", Date.now());

describe("F3 02-4: the receipt that replaces a started row is a persisted one (C5, test 5)", () => {
  it("receipts file write fails twice (finalize, then the resettle), then a restart: the row is never removed, the request runs until boot, boot writes a persisted interrupted receipt, owed line, resolution 200", () => {
    const s = setup();
    roomAsk(s, "tk5");
    acceptedStartedRow(s, "tk5", "room");
    breakReceipts();
    // the live finalize: its receipt reaches memory only, so nothing is settled and the whole finalize rolls back
    let thrown: unknown;
    try {
      finishHandoff({ id: "tk5", sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("the answer"), lineage: true, requestId: "tk5" },
        () => completeRequest(database(), "tk5", { state: "done", now: Date.now() }));
    } catch (error) { thrown = error; }
    expect((thrown as { code?: string } | undefined)?.code).toBe(HANDOFF_NOT_SETTLED);
    expect(startedRow("tk5")?.phase).toBe("started");
    expect(roomRequest(database(), "tk5")?.state).toBe("running");
    // the 30 s resettle: the file still cannot be written, so it settles nothing
    expect(resettleStranded()).toBe(0);
    expect(startedRow("tk5")?.phase).toBe("started");
    expect(roomRequest(database(), "tk5")?.state).toBe("running");
    // restart: the process knew the receipt only in memory
    _simulateRestart();
    _loadPending();
    mendReceipts();
    reconcileRoomRequestsAtBoot(database(), Date.now());
    expect(roomRequest(database(), "tk5")?.state).toBe("running");             // the row is its partner: it decides
    expect(taskStatusCode(resolveTask("tk5", undefined, deps()))).toBe(200);   // answered from the store before the settling
    expect(reconcileStartedDelegations({ botName: (id) => s.store.bot(id)?.name })).toMatchObject({ interrupted: 1 });
    expect(startedRow("tk5")).toBeUndefined();
    expect(findDelegationReceipt("tk5")).toMatchObject({ status: "failed", result: "interrupted by a restart" });
    expect(receiptsOnDisk().filter((receipt) => receipt.id === "tk5")).toHaveLength(1);
    expect(s.store.messageById(s.from.threadId, handoffReplyId("tk5"))).toBeDefined();
    expect(roomRequest(database(), "tk5")?.state).toBe("failed");
    expect(taskStatusCode(resolveTask("tk5", { threadId: s.from.threadId, botId: s.from.id }, deps()))).toBe(200);
  });

  it("G: finalize, then the boot settling: no interrupted receipt, one receipt", () => {
    const s = setup();
    acceptedStartedRow(s, "tkg", "owner");
    finishHandoff({ id: "tkg", sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("the answer"), lineage: true }, () => undefined);
    expect(startedRow("tkg")).toBeUndefined();
    _simulateRestart();
    _loadPending();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 0, receipted: 0 });
    expect(findDelegationReceipt("tkg")).toMatchObject({ status: "done" });
    expect(receiptsOnDisk().filter((receipt) => receipt.id === "tkg")).toHaveLength(1);
  });
});

describe("F3 02-4: the ticket row (C3, C4)", () => {
  it("an owner-origin ticket is an ordinary started row, resolved 200 from the store before the first settling page, foreign to another conversation", () => {
    const s = setup();
    lane.recordAskTicket({ id: "tko", origin: "owner", sourceThreadId: s.from.threadId, fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId, acceptedTurnId: "turn-7", message: "look into it", depth: 0 });
    const row = startedRow("tko")!;
    expect(row).toMatchObject({ phase: "started", origin: "owner", accepted_turn_id: "turn-7", turn_key: "dlg-tko", target_thread_id: s.target.threadId });
    expect(row.started_at).not.toBeNull();
    expect(row.submitted_at).not.toBeNull();
    // item: the shape parsePendingItem reads, no new key
    expect(delegations.parsePendingItem({ ...JSON.parse(row.item), toBotId: s.target.id })).toMatchObject({ message: "look into it", depth: 0 });
    _simulateRestart();
    _loadPending();
    const resolved = resolveTask("tko", { threadId: s.from.threadId, botId: s.from.id }, deps());
    expect(taskStatusCode(resolved)).toBe(200);
    expect(resolved).toMatchObject({ kind: "running", threadId: s.target.threadId, watch: { toBotId: s.target.id } });
    expect(taskStatusCode(resolveTask("tko", { threadId: "another-thread", botId: s.from.id }, deps()))).toBe(403);
  });

  it("a room ask's ticket takes the ask's request id (origin room) and settles it at boot as interrupted", () => {
    const s = setup();
    roomAsk(s, "tkr");
    lane.recordAskTicket({ id: "tkr", origin: "room", sourceThreadId: s.from.threadId, fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId, acceptedTurnId: "turn-8", message: "look into it", depth: 0 });
    expect(startedRow("tkr")).toMatchObject({ phase: "started", origin: "room" });
    _simulateRestart();
    _loadPending();
    reconcileRoomRequestsAtBoot(database(), Date.now());
    expect(roomRequest(database(), "tkr")?.state).toBe("running");
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    expect(roomRequest(database(), "tkr")?.state).toBe("failed");
    expect(findDelegationReceipt("tkr")).toMatchObject({ status: "failed" });
  });

  it("a ticket row that cannot be written is no ticket: the insert throws and nothing is left", () => {
    const s = setup();
    expect(typeof lane.recordAskTicket).toBe("function");
    database().exec("CREATE TRIGGER pd_refuse BEFORE INSERT ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => lane.recordAskTicket({ id: "tkf", origin: "owner", sourceThreadId: s.from.threadId, fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId, message: "x", depth: 0 })).toThrow();
    expect(startedRow("tkf")).toBeUndefined();
    database().exec("DROP TRIGGER pd_refuse");
  });

  it("setup longer than the wait (no turn seen yet), then a restart: held for the owner, never run again; a turn seen later makes it interrupted", () => {
    const s = setup();
    lane.recordAskTicket({ id: "tkh", origin: "owner", sourceThreadId: s.from.threadId, fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId, message: "slow start", depth: 0 });
    expect(startedRow("tkh")?.accepted_turn_id).toBeNull();
    _simulateRestart();
    _loadPending();
    expect(reconcileStartedDelegations()).toMatchObject({ held: 1, redispatched: 0, fresh: 0, interrupted: 0 });
    expect(startedRow("tkh")).toMatchObject({ phase: "started", started_at: null });
    // the same ticket, its turn seen after the wait ended: the listener records it, and a restart reports it interrupted
    lane.recordAskTicket({ id: "tka", origin: "owner", sourceThreadId: s.from.threadId, fromBotId: s.from.id, toBotId: s.target.id, targetThreadId: s.target.threadId, message: "slow start", depth: 0 });
    lane.markAskTicketAccepted("tka", "turn-late");
    expect(startedRow("tka")?.accepted_turn_id).toBe("turn-late");
    _simulateRestart();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
  });
});

describe("F3 02-4: timeout vs completion in the wait's own timer tick (narrowest seam: the tick's verdict askBotAndWait runs)", () => {
  it("a completion that landed before the timer (the reply is settling) is returned: no ticket is made", () => {
    let made = 0;
    expect(lane.askTimeoutVerdict({ done: false, settling: true }, () => { made++; return "t"; })).toEqual({ kind: "settling" });
    expect(lane.askTimeoutVerdict({ done: true, settling: false }, () => { made++; return "t"; })).toEqual({ kind: "settling" });
    expect(made).toBe(0);
  });
  it("a turn still running: the ticket is written first, then the timeout carries it; a ticket that cannot be written is an error", () => {
    expect(lane.askTimeoutVerdict({ done: false, settling: false }, () => "tk-1")).toEqual({ kind: "timeout", ticket: "tk-1" });
    expect(lane.askTimeoutVerdict({ done: false, settling: false }, () => undefined)).toEqual({ kind: "timeout" });
    expect(lane.askTimeoutVerdict({ done: false, settling: false }, () => { throw new Error("disk full"); })).toEqual({ kind: "error" });
  });
});

// test 4: the real timeout path through the route and the fake engine, a crash, and the lookup after the restart
let fixture: VerificationServer | undefined, desktop: Record<string, string> = {};
const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture!.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const signIn = async () => {
  const secret = (await (await fetch(`${fixture!.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const turnFor = async (tag: string) => {
  for (const started = Date.now(); Date.now() - started < 30000; await new Promise(resolve => setTimeout(resolve, 100))) {
    try { const text = readFileSync(fixture!.fixtureDumpPath, "utf8"); if (text.includes(tag)) return withTurnSecrets(JSON.parse(text)) as { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } }; } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
};
const tokenOf = (turn: Awaited<ReturnType<typeof turnFor>>) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map(server => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;

describe.skipIf(process.platform === "win32")("F3 02-4 test 4: a ticket made by the real timeout survives a crash", () => {
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it("ask past its wait, Murage killed, restarted (store reopened, settling run): the lookup answers 200, not 404", async () => {
    // the shortest wait the server allows, so the real timer makes the ticket
    fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_ASK_BOT_TIMEOUT_MS: "5000" } as never });
    await signIn();
    const asker = (await post("/api/bots", { name: "Asker" })).body.bot as { id: string; threadId: string };
    const peer = (await post("/api/bots", { name: "Peer" })).body.bot as { id: string; threadId: string };
    const pids: number[] = [];
    try {
      await post(`/api/bots/${asker.id}/messages`, { text: "Hold on. __fixture_hold_authority__ TK_ASKER_ONE" });
      const askerTurn = await turnFor("TK_ASKER_ONE");
      pids.push(askerTurn.pid);
      const auth = { authorization: `Bearer ${tokenOf(askerTurn)}` };
      const asking = post("/api/internal/ask-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: "Take your time. __fixture_hold_authority__ TK_PEER_LONG" }, auth);
      pids.push((await turnFor("TK_PEER_LONG")).pid);
      const asked = await asking;
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      expect(asked.body.timeout).toBe(true);
      const taskId = String(asked.body.taskId);
      const check = (headers: Record<string, string>) => fetch(`${fixture!.info.url}/api/internal/delegations/${taskId}?fromBotId=${asker.id}&fromThreadId=${asker.threadId}`, { headers });
      expect((await check(auth)).status).toBe(200);
      // a crash, not a clean close: nothing settles the ticket on the way down
      const dead = new Promise((resolve) => fixture!.child.once("exit", resolve));
      fixture.child.kill("SIGKILL");
      await dead;
      await fixture.restart();
      await signIn();
      await post(`/api/bots/${asker.id}/messages`, { text: "Hold on. __fixture_hold_authority__ TK_ASKER_TWO" });
      const again = await turnFor("TK_ASKER_TWO");
      pids.push(again.pid);
      const auth2 = { authorization: `Bearer ${tokenOf(again)}` };
      let last: { status: number; body: any } = { status: 0, body: null }; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const until = Date.now() + 20_000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 250))) {
        const response = await check(auth2);
        last = { status: response.status, body: await response.json() };
        if (last.status !== 200 || last.body?.status === "failed") break;
      }
      expect(last.status, JSON.stringify(last.body)).toBe(200);
      // the peer's turn was accepted: the boot settling ended it as interrupted by the restart, never ran it again
      expect(last.body.status, JSON.stringify(last.body)).toBe("failed");
    } finally {
      for (const pid of pids) { try { writeFileSync(join(fixture!.fixtureFinishGateDir, String(pid)), "finish"); } catch { /* gone */ } }
    }
  }, 120000);
});
