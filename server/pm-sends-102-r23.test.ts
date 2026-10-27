// Astra r22 findings, closed together (the one fix round after DESIGN-r22): every finding has a test that reproduces it.
//  F1  a hand-off handed to the provider whose acceptance was not recorded is never run again; the owner is told and may send it again as a new hand-off
//  F2  shared work is stamped by its start (after the approval wait), never by its dispatch, and follows the same restart rules as every other origin
//  F3  imported and rebuilt rows find their room request / shared work by id
//  F4  deleting a hand-off's source conversation cancels the shared request in the same commit; shared dispatch checks the three tombstones
//  F5  a started-but-unsubmitted hand-off is exported with its request back at queued; a submitted one is never exported as runnable
//  F6  admission waits for the clean-up of the old stand-in records; a record that says "ran" stops its row
//  F7  the idle release looks at one bounded, rotating page per pass
//  F8  a grown 1.0.1 table is rebuilt from the executable original definition
//  F9  the single re-dispatch goes into the conversation that holds the prompt
//  F10 a deleted sender that no longer resolves still gets the cancelled receipt
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { closeDatabase, database } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import {
  DELETED_NOTE, IDLE_RELEASE_BATCH, RESTART_RECEIPT, _delegationQueueWrites, _drainingCount, _loadPending, _resetPending, _simulateRestart, dismissHeldDelegation,
  findDelegationReceipt, idleReleaseHasMore, onDelegationReceipt, queueDelegation, reconcileStartedDelegations, recordDelegationReceipt,
  releaseDelegationsWaitingOn, resendHeldDelegation, startedDelegation, uncertainHandoffText, type HeldDelegation,
} from "./delegations.ts";
import { configureHandoffDispatch, configureSharedHandoffs } from "./handoff-dispatch.ts";
import { drainDelegations, drainDelegationsRaw, fakeHost, rememberRun, runOf, startLikeIndex, writePrompt } from "./testing/handoff-turn.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { _resetOwnerMigration, delegationAdmissionHeld, ensureHandoffPairGuard, delegationTurnKey, initializePendingDelegations, onDelegationAdmissionOpen, runOwnerHandoffMigration } from "./pending-delegations-schema.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, markRequestDispatched, reconcileRoomRequestsAtBoot, roomRequest } from "./room-requests.ts";
import { configureSharedDrain, drainSharedWork, enqueueSharedWork, sharedRequestDeleted } from "./shared-work.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { Store } from "./store.ts";
import { haveV101, realV101 } from "./testing/pm-sends-v101.ts";
import { engineReply } from "./testing/provider-reply.ts";
import { released } from "./testing/released.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const legacyFile = () => join(DATA_DIR, "delegations.json");
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const pendingRows = () => count("SELECT COUNT(*) AS n FROM pending_delegations");
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at, accepted_turn_id, start_attempts, target_thread_id FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

type Origin = "owner" | "room";
const LINEAGE = (thread: string) => ({ rootThreadId: thread, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
function setup(origin: Origin = "owner") {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot(), target = store.createBot();
  store.patchBot(target.id, { name: "Helper" });
  let extra: Partial<CommsBus> = {};
  if (origin === "room") {
    insertRoomRequest(database(), { id: "root", groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: from.id, targetThreadId: from.threadId, admissionKey: "root", now: 1, lineage: LINEAGE(from.threadId) });
    markRequestDispatched(database(), "root", { now: 1 });
    // a room hand-off starts once the turn that made it has settled: that turn waits on its asks (F3: a turn still running at boot ends its whole subtree)
    database().prepare("UPDATE room_requests SET state='waiting_bot', waiting_since=1 WHERE id='root'").run();
    extra = { prepareDelegation: (fromBotId: string, to: string, source: string, _m: string, id: string) => {
      insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId, toBotId: to, parentId: "root", returnThreadId: source, returnBotId: fromBotId, admissionKey: `ask:delegation:${id}`, now: 2 });
      return "room" as const;
    } };
  }
  const b = { store, broadcast: () => {}, ...extra } as unknown as CommsBus;
  return { store, from, target, b, approvalBus: { store, broadcast: () => {} } as never };
}
type World = ReturnType<typeof setup>;
const promptsIn = (thread: string) => count("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id LIKE 'dlg-%'", thread);
const NEVER = () => new Promise<void>(() => { /* never returns: the kill */ });
/** What startTurn does for a hand-off's prompt: written under the row's key with the start in one commit, or the held re-dispatch. */
const stamp = (s: World, taskId: string, thread = s.target.threadId): void => writePrompt(s.b, runOf(taskId), thread);
async function drainAll(s: World, threadId: string, run: (taskId: string) => void | Promise<void>): Promise<void> {
  drainDelegationsRaw(s.b, s.approvalBus, threadId, (_to, _m, _d, _s, _c, taskId) => run(taskId));
  await until(() => _drainingCount() === 0);
  await tick();
}
const restart = (s: World, held: HeldDelegation[] = []) => {
  _simulateRestart(); _loadPending();
  const settled = reconcileStartedDelegations({ botName: () => s.target.name, notice: (h) => held.push(h) });
  reconcileRoomRequestsAtBoot(database(), 3);
  return settled;
};

// ── F1 ────────────────────────────────────────────────────────────────────────────────
describe("F1. a hand-off the provider took, whose acceptance was not recorded, never runs twice", () => {
  const WORDS = "Murage restarted while handing this to @Helper. It may have started. Check @Helper's conversation, or send it again.";
  it("acceptance write fails after the provider executed: the write is retried then surfaced; a restart runs it zero more times, tells the owner, and Send again runs it once as a new hand-off", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "do it exactly once", depth: 0 }, 2).id!;
    let executions = 0;
    await (async () => {
      drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
        stamp(s, taskId);
        runOf(taskId).submitted();                      // committed before the provider call
        executions++;                                   // the provider executes it
        database().exec("CREATE TRIGGER pd_noaccept BEFORE UPDATE OF accepted_turn_id ON pending_delegations WHEN NEW.accepted_turn_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'refused'); END");
        expect(() => runOf(taskId).accepted("turn-1")).toThrow("refused");     // surfaced, not swallowed
        return NEVER();
      });
      await until(() => executions === 1);
    })();
    database().exec("DROP TRIGGER pd_noaccept");
    expect(rowOf(id)).toMatchObject({ phase: "started", accepted_turn_id: null });
    expect(rowOf(id)!.submitted_at).toBeGreaterThan(0);
    const held: HeldDelegation[] = [];
    expect(restart(s, held)).toMatchObject({ held: 1, interrupted: 0, fresh: 0, redispatched: 0 });
    let again = 0;
    await drainAll(s, s.from.threadId, () => { again++; });
    expect(again).toBe(0);                                                       // not run again by itself
    expect(executions).toBe(1);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id, text: WORDS, sourceThreadId: s.from.threadId });
    expect(WORDS).not.toMatch(/[–—]/);                                 // no dashes
    expect(findDelegationReceipt(id)).toMatchObject({ status: "failed", result: WORDS });
    expect(uncertainHandoffText("Helper")).toBe(WORDS);
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });     // held, not deleted
    // a second restart leaves it held: nothing is held anew, the notice is repeated (the receipt is replaced by id and the owner's line has a stable id)
    const second: HeldDelegation[] = [];
    expect(restart(s, second)).toMatchObject({ held: 0 });
    expect(second.map((h) => h.id)).toEqual([id]);
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
    // Send again: a NEW hand-off (new id), the held one gone in the same commit, and it runs once
    const sent = resendHeldDelegation(s.b, id);
    expect(sent.result).toBe("ok");
    expect(sent.id).toBeTruthy();
    expect(sent.id).not.toBe(id);
    expect(rowOf(id)).toBeUndefined();
    expect(rowOf(sent.id!)).toMatchObject({ phase: "fresh", origin: "owner" });
    let third = 0;
    await drainAll(s, s.from.threadId, (taskId) => { third++; stamp(s, taskId); runOf(taskId).accepted("turn-2"); recordDelegationReceipt({ id: taskId, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("answer") }); });
    expect(third).toBe(1);
    expect(resendHeldDelegation(s.b, id).result).toBe("not_held");              // it cannot be sent twice
  });
  it("Dismiss lets a held hand-off go without running it", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "dismiss me", depth: 0 }, 2).id!;
    await drainAll(s, s.from.threadId, (taskId) => { stamp(s, taskId); runOf(taskId).submitted(); });
    restart(s);
    expect(dismissHeldDelegation(id)).toBe(true);
    expect(dismissHeldDelegation(id)).toBe(false);
    expect(pendingRows()).toBe(0);
  });
  it("the submit stamp that cannot be written stops the submission, and a restart then runs the hand-off once (the provider never saw it)", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "never submitted", depth: 0 }, 2).id!;
    let first = 0;
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
      first++; stamp(s, taskId);
      database().exec("CREATE TRIGGER pd_nosubmit BEFORE UPDATE OF submitted_at ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
      expect(() => runOf(taskId).submitted()).toThrow("refused");
      return NEVER();
    });
    await until(() => first === 1);
    database().exec("DROP TRIGGER pd_nosubmit");
    expect(restart(s)).toMatchObject({ redispatched: 1, held: 0 });
    let second = 0;
    await drainAll(s, s.from.threadId, (taskId) => { second++; stamp(s, taskId); runOf(taskId).accepted("turn-2"); });
    expect(second).toBe(1);
    expect(promptsIn(s.target.threadId)).toBe(1);
    expect(findDelegationReceipt(id)).toBeNull();
  });
  it("the target conversation shows output after the prompt: the hand-off is treated as accepted (interrupted receipt), not held", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "it ran", depth: 0 }, 2).id!;
    await drainAll(s, s.from.threadId, (taskId) => { stamp(s, taskId); runOf(taskId).submitted(); s.store.appendMessage(s.target.threadId, { role: "bot", kind: "text", text: "working on it", turnId: "provider-turn-1" }, undefined, undefined, engineReply(s.target.threadId, "provider-turn-1")); });
    expect(restart(s)).toMatchObject({ interrupted: 1, held: 0 });
    expect(findDelegationReceipt(id)).toMatchObject({ status: "failed", result: RESTART_RECEIPT });
    expect(pendingRows()).toBe(0);
  });
  it.each(["owner", "room"] as Origin[])("%s origin, crash after the submit and before the acceptance: zero more starts; a prompt but no submit: one more start", async (origin) => {
    const s = setup(origin);
    const sub = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "submitted", depth: 0 }, 9).id!;
    const plain = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "plain", depth: 0 }, 9).id!;
    await startLikeIndex(s.b, s.approvalBus, sub, { submit: true });
    await startLikeIndex(s.b, s.approvalBus, plain);
    restart(s);
    expect(rowOf(sub)).toMatchObject({ phase: "started", started_at: null });
    expect(rowOf(plain)).toMatchObject({ phase: "fresh", start_attempts: 1 });
    const ran: string[] = [];
    await drainAll(s, s.from.threadId, (taskId) => { ran.push(taskId); stamp(s, taskId); runOf(taskId).accepted("turn-3"); recordDelegationReceipt({ id: taskId, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("ok") }); });
    expect(ran).toEqual([plain]);
    expect(promptsIn(s.target.threadId)).toBe(2);      // one per hand-off, never two for one
    // BOOT-SETTLE-108 3: the sweep leaves a held hand-off's request to the hand-off's own settling (its receipt ends it; this world has no receipt listener)
    if (origin === "room") expect(roomRequest(database(), sub)!.state).not.toBe("unknown");
  });
});

// ── F2 ────────────────────────────────────────────────────────────────────────────────
/** Shared work for a team, and the server's side of the hand-off dispatch for it: a fake provider that records the start, and a shared run that records how a request ended. */
function sharedWorld() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const iris = store.createBot(); store.patchBot(iris.id, { name: "Iris", section: "Design", sharedWith: { mode: "all", teams: [] } });
  const sales = store.createBot(); store.patchBot(sales.id, { name: "Sales", section: "Sales", chiefOfStaff: true });
  const support = store.createBot(); store.patchBot(support.id, { name: "Support", section: "Support", chiefOfStaff: true });
  const started: string[] = [];         // plain shared requests the shared drain started (none of these is a hand-off)
  const closed: string[] = [];
  const turns: string[] = [];           // hand-off turns the fake provider was started for
  const finished: string[] = [];        // hand-off requests the completion bookkeeping ended
  const abandoned: string[] = [];       // shared runs given back because the turn never started
  const claims: Array<{ release(): void }> = [];   // what the arbiter handed out: a process that dies takes its claims with it
  const gate = { approval: undefined as Promise<"allow" | "deny" | "expired" | "cancelled"> | undefined, submit: new Set<string>(), beforeStamp: undefined as undefined | (() => void) };
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 3,
    rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 10 });
  configureSharedDrain({ admission, open: () => true, now: () => 10, changed: () => {}, closed: (row, line) => { closed.push(`${row.id}:${line}`); }, start: (row, claim) => { started.push(row.id); claim.release(); } });
  const b = { store, broadcast: () => {} } as unknown as CommsBus;
  const approvalBus = { store, broadcast: () => {} } as never;
  configureHandoffDispatch({
    ...fakeHost(b, () => {}, { stamp: false }),
    startTurn: async (_botId, text, turn) => {
      const run = turn.delegationRun;
      rememberRun(run);
      turns.push(run.id);
      gate.beforeStamp?.();
      writePrompt(b, run, turn.threadId, text);
      if (gate.submit.has(run.id)) run.submitted();
    },
  }, { bus: b, approvalBus });
  configureSharedHandoffs({
    begin: (request, claim) => { if (claim) claims.push(claim); return ({ sharedWorkRun: {}, finish: (_event, note) => { finished.push(`${request.id}:${note}`); claim?.release(); }, abandon: () => { abandoned.push(request.id); claim?.release(); } }); },
    needsApproval: () => gate.approval !== undefined,
    requestApproval: () => gate.approval!,
    mirror: () => {},
    turnOptions: () => ({}),
    text: (request) => request.payloadText ?? "",
  });
  const handoff = (id: string, sender = sales) => {
    const inserted = enqueueSharedWork(store, { fromBotId: sender.id, sourceThreadId: sender.threadId, toBotId: iris.id, message: "shared hand-off", admissionKey: `ask:delegation:${id}`, ownerAudience: true, now: 1, id });
    if (!inserted.ok) throw new Error(inserted.code);
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, sender.threadId, iris.id, sender.id, "fresh", null, JSON.stringify({ message: "shared hand-off", depth: 0, attempts: 0 }), "shared", delegationTurnKey(id), inserted.request.targetThreadId);
    return inserted.request;
  };
  const crash = () => { for (const claim of claims.splice(0)) claim.release(); _simulateRestart(); };
  return { store, iris, sales, support, started, closed, turns, finished, abandoned, gate, handoff, crash, b, approvalBus };
}
type SharedWorld = ReturnType<typeof sharedWorld>;
const turnsStarted = async (w: SharedWorld, n: number) => { await until(() => w.turns.length === n); await tick(); };
describe("F2. shared hand-offs are stamped by their start, after the approval wait", () => {
  it("dispatched, then the process dies while the owner's approval is pending: nothing is lost, the request and the row go back to waiting, and it runs once", async () => {
    const w = sharedWorld();
    w.handoff("sh-1");
    w.gate.approval = new Promise(() => { /* the owner has not answered */ });
    drainSharedWork(w.iris.id);
    expect(roomRequest(database(), "sh-1")!.state).toBe("waiting_owner");           // dispatched, now waiting for the owner
    expect(w.turns).toEqual([]);
    expect(rowOf("sh-1")).toMatchObject({ phase: "fresh", started_at: null });       // dispatch is not a start
    w.crash();                                                                       // the process dies while the approval card is open
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 0, held: 0 });
    expect(reconcileRoomRequestsAtBoot(database(), 20)).toMatchObject({ unknown: 0 });
    expect(roomRequest(database(), "sh-1")!.state).toBe("queued");
    expect(pendingRows()).toBe(1);
    expect(findDelegationReceipt("sh-1")).toBeNull();                               // no "interrupted" receipt: nothing ran
    w.gate.approval = undefined;
    drainSharedWork(w.iris.id);
    await turnsStarted(w, 1);
    const thread = roomRequest(database(), "sh-1")!.targetThreadId!;
    expect(rowOf("sh-1")).toMatchObject({ phase: "started", target_thread_id: thread, start_attempts: 1 });
    expect(promptsIn(thread)).toBe(1);
  });
  it("started but not submitted: re-run once and the request is queued again; submitted without acceptance: held, the request is interrupted, nothing runs", async () => {
    const w = sharedWorld();
    w.gate.submit.add("sh-b");
    const a = w.handoff("sh-a"), b = w.handoff("sh-b", w.support);
    drainSharedWork(w.iris.id);
    await turnsStarted(w, 2);
    w.crash();
    const held: HeldDelegation[] = [];
    // BOOT-SETTLE-108 3: the held one's request is ended by its own notice receipt (as the server's receipt listener does), not by the room sweep
    onDelegationReceipt((receipt) => { const row = roomRequest(database(), receipt.id); if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: "failed", now: 20 }); });
    try { expect(reconcileStartedDelegations({ notice: (h) => held.push(h) })).toMatchObject({ redispatched: 1, held: 1, interrupted: 0 }); }
    finally { onDelegationReceipt(undefined); }
    reconcileRoomRequestsAtBoot(database(), 20);
    expect(roomRequest(database(), "sh-a")!.state).toBe("queued");
    expect(rowOf("sh-a")).toMatchObject({ phase: "fresh", start_attempts: 1 });
    expect(roomRequest(database(), "sh-b")!.state).toBe("failed");
    expect(held.map((h) => h.id)).toEqual(["sh-b"]);
    // the re-run: the shared drain dispatches the request again, and its start is the held re-dispatch into the same thread with the same prompt
    drainSharedWork(w.iris.id);
    await turnsStarted(w, 3);
    expect(roomRequest(database(), "sh-a")!.state).toBe("running");
    const thread = roomRequest(database(), a.id)!.targetThreadId!;
    expect(rowOf("sh-a")!.target_thread_id).toBe(thread);                           // the stored destination
    expect(promptsIn(thread)).toBe(1);   // one prompt for sh-a, never two (sh-b's is in its own work thread)
    expect(promptsIn(roomRequest(database(), b.id)!.targetThreadId!)).toBe(1);
    expect(w.turns.slice(0, 2).sort()).toEqual(["sh-a", "sh-b"]);                    // both started (in the arbiter's fair order), then sh-a once more
    expect(w.turns[2]).toBe("sh-a");
  });
});

// ── F3 ────────────────────────────────────────────────────────────────────────────────
describe("F3. imported and rebuilt rows find the request that owns them", () => {
  function roomRequestFor(s: World, id: string) {
    insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: s.from.id, toBotId: s.target.id, parentId: "root", returnThreadId: s.from.threadId, returnBotId: s.from.id, admissionKey: `ask:delegation:${id}`, now: 2 });
  }
  const entry = (s: World, id: string) => ({ id, toBotId: s.target.id, message: "from the old build", depth: 0, attempts: 0, fromBotId: s.from.id });
  it("an imported room hand-off is room-owned: its start dispatches the request, and the request is where the room expects it", async () => {
    const s = setup("room");
    roomRequestFor(s, "imp-room");
    writeFileSync(legacyFile(), JSON.stringify({ [s.from.threadId]: [entry(s, "imp-room"), entry(s, "imp-none")] }));
    _loadPending();
    expect(rowOf("imp-room")).toMatchObject({ origin: "room" });
    expect(rowOf("imp-none")).toMatchObject({ origin: "legacy" });                // truly unbound stays legacy
    expect(roomRequest(database(), "imp-room")!.state).toBe("queued");
    await startLikeIndex(s.b, s.approvalBus, "imp-room", { accept: "turn-1" });
    expect(roomRequest(database(), "imp-room")!.state).toBe("running");
    // after the turn is accepted and the restart reconciles it, the request is not left queued or running behind the row
    restart(s);
    expect(pendingRows()).toBe(1);                                                // only the unbound one is left
    expect(roomRequest(database(), "imp-room")!.state).toBe("unknown");
  });
  it("an imported shared hand-off is shared-owned: the dispatch leaves it queued, the start stamps it, and a restart reconciles both records", async () => {
    const w = sharedWorld();
    const request = w.handoff("imp-shared");
    // (the fixture stands in for a 1.0.1 queue file that has no row yet: the row `handoff` made is taken away, the pair guard stepped aside for this one fixture write)
    database().exec("DROP TRIGGER pending_delegation_live_pair");
    database().prepare("DELETE FROM pending_delegations WHERE id='imp-shared'").run();
    ensureHandoffPairGuard(database());
    writeFileSync(legacyFile(), JSON.stringify({ [w.sales.threadId]: [{ id: "imp-shared", toBotId: w.iris.id, message: "shared hand-off", depth: 0, attempts: 0, fromBotId: w.sales.id }] }));
    database().prepare("DELETE FROM pending_delegations_import").run();
    _loadPending();
    expect(rowOf("imp-shared")).toMatchObject({ origin: "shared" });
    w.gate.submit.add("imp-shared");
    drainSharedWork(w.iris.id);
    await turnsStarted(w, 1);
    const thread = roomRequest(database(), request.id)!.targetThreadId!;
    expect(rowOf("imp-shared")).toMatchObject({ phase: "started", target_thread_id: thread });
    runOf("imp-shared").accepted("turn-9");
    _simulateRestart();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    reconcileRoomRequestsAtBoot(database(), 30);
    expect(roomRequest(database(), "imp-shared")!.state).toBe("unknown");
  });
  it("rebuilding an older development table resolves each row's owner the same way", () => {
    const s = setup("room");
    roomRequestFor(s, "old-room");
    const db = database();
    for (const name of ["pd_thread", "pd_due", "pd_phase", "pd_to", "pd_from", "pd_busy", "pd_started"]) db.exec(`DROP INDEX IF EXISTS ${name}`);
    db.exec("DROP TABLE pending_delegations");
    db.exec("CREATE TABLE pending_delegations (id TEXT PRIMARY KEY NOT NULL, source_thread_id TEXT NOT NULL, to_bot_id TEXT NOT NULL, from_bot_id TEXT, phase TEXT NOT NULL, retry_at INTEGER, item TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,?,?,?)");
    for (const id of ["old-room", "old-none"]) insert.run(id, s.from.threadId, s.target.id, s.from.id, "fresh", null, JSON.stringify({ message: "m", depth: 0, attempts: 0 }));
    initializePendingDelegations(db);
    expect(rowOf("old-room")).toMatchObject({ origin: "room" });
    expect(rowOf("old-none")).toMatchObject({ origin: "legacy" });
    expect(db.prepare("SELECT turn_key FROM pending_delegations WHERE id='old-room'").get()).toMatchObject({ turn_key: delegationTurnKey("old-room") });
    // the dev shape of the last build (origin, no submit stamp) is rebuilt too, keeping what it recorded
    db.exec("ALTER TABLE pending_delegations DROP COLUMN submitted_at");
    db.prepare("UPDATE pending_delegations SET origin='legacy', phase='started', started_at=5, accepted_turn_id='t' WHERE id='old-room'").run();
    initializePendingDelegations(db);
    expect(rowOf("old-room")).toMatchObject({ origin: "room", phase: "started", started_at: 5, accepted_turn_id: "t", submitted_at: null });
  });
});

// ── F4 ────────────────────────────────────────────────────────────────────────────────
describe("F4. the owner's deletion of a shared hand-off's source covers its request", () => {
  it("the deletion cancels the queued shared request in the same commit that removes the row", () => {
    const w = sharedWorld();
    w.handoff("del-1");
    const db = database();
    db.exec("BEGIN");
    recordOwnerDeletion(db, w.sales.threadId);
    expect(roomRequest(db, "del-1")!.state).toBe("cancelled");
    expect(pendingRows()).toBe(0);
    db.exec("ROLLBACK");                                                           // one commit: both go back, or neither
    expect(roomRequest(db, "del-1")!.state).toBe("queued");
    expect(pendingRows()).toBe(1);
    recordOwnerDeletion(db, w.sales.threadId);
    expect(roomRequest(db, "del-1")!.state).toBe("cancelled");
    drainSharedWork(w.iris.id);
    expect(w.turns).toEqual([]);
  });
  it("a tombstone the row does not know about still stops the dispatch: cancelled with the deletion wording, never running", () => {
    const w = sharedWorld();
    w.handoff("del-2");
    database().prepare("INSERT INTO owner_deleted_threads(thread_id, deleted_at) VALUES(?, 1)").run(w.sales.threadId);   // the row survives: only the tombstone is there
    drainSharedWork(w.iris.id);
    expect(w.turns).toEqual([]);
    expect(roomRequest(database(), "del-2")!.state).toBe("cancelled");
    expect(findDelegationReceipt("del-2")).toMatchObject({ status: "cancelled", result: DELETED_NOTE });
  });
  it.each(["source", "sender", "target"] as const)("the %s tombstone is enough, at dispatch, after the approval wait, and in the start transaction itself", async (key) => {
    const tombstone = (w: SharedWorld) => database().prepare("INSERT INTO owner_deleted_threads(thread_id, deleted_at) VALUES(?, 1)").run(key === "source" ? w.sales.threadId : key === "sender" ? `bot:${w.sales.id}` : `bot:${w.iris.id}`);
    // 1. after the approval wait: dispatched and waiting for the owner, the deletion lands, the owner says yes: it is cancelled, no turn, no prompt
    {
      const w = sharedWorld();
      const request = w.handoff(`wait-${key}`);
      expect(sharedRequestDeleted(request)).toBe(false);
      let answer!: (verdict: "allow") => void;
      w.gate.approval = new Promise((resolve) => { answer = resolve; });
      drainSharedWork(w.iris.id);                                                   // dispatched, now "waiting for approval"
      expect(roomRequest(database(), request.id)!.state).toBe("waiting_owner");
      tombstone(w);
      answer("allow");
      await until(() => roomRequest(database(), request.id)!.state === "cancelled");
      await tick();
      expect(w.turns).toEqual([]);
      expect(promptsIn(roomRequest(database(), request.id)!.targetThreadId!)).toBe(0);
      expect(findDelegationReceipt(request.id)).toMatchObject({ status: "cancelled", result: DELETED_NOTE });
    }
    // 2. in the start itself: the deletion lands after the dispatch's last look, so the stamp refuses and writes nothing; the hand-off is then settled as deleted
    {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending();
      const w = sharedWorld();
      const request = w.handoff(`start-${key}`);
      w.gate.beforeStamp = () => { tombstone(w); };
      drainSharedWork(w.iris.id);
      await until(() => roomRequest(database(), request.id)!.state === "cancelled");
      await tick();
      expect(promptsIn(roomRequest(database(), request.id)!.targetThreadId!)).toBe(0);
      expect(rowOf(request.id)).toBeUndefined();
      expect(findDelegationReceipt(request.id)).toMatchObject({ status: "cancelled", result: DELETED_NOTE });
    }
  });
});

// ── F5 ────────────────────────────────────────────────────────────────────────────────
describe("F5. what the downgrade exports is runnable by the real 1.0.1", () => {
  it("a started room hand-off that never reached the provider is exported with its request back at queued; a submitted one is not exported at all", async () => {
    const s = setup("room");
    const unsent = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "unsent", depth: 0 }, 9).id!;
    const sent = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "sent", depth: 0 }, 9).id!;
    const fresh = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "fresh", depth: 0 }, 9).id!;
    await startLikeIndex(s.b, s.approvalBus, unsent);
    await startLikeIndex(s.b, s.approvalBus, sent, { submit: true });
    expect(roomRequest(database(), unsent)!.state).toBe("running");
    closeDatabase(); await stopWalMaintenance(); /* closeDatabase stops the checkpointer without waiting (wal3); a second connection must wait for it */
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      const done = downgradeApplicationSchemaTo101(db, DATA_DIR);
      expect(done).toMatchObject({ exported: 2, interrupted: 1 });
      const exported = Object.values(JSON.parse(readFileSync(legacyFile(), "utf8")) as Record<string, Array<{ id: string }>>).flat().map((e) => e.id).sort();
      expect(exported).toEqual([fresh, unsent].sort());
      // 1.0.1 expects a waiting hand-off's request to be queued: its own boot sweep marks `running` ones unknown and then cancels the hand-off
      expect(db.prepare("SELECT state, dispatched_at FROM room_requests WHERE id=?").get(unsent)).toMatchObject({ state: "queued", dispatched_at: null });
      expect(db.prepare("SELECT state FROM room_requests WHERE id=?").get(fresh)).toMatchObject({ state: "queued" });
      expect(JSON.parse(readFileSync(join(DATA_DIR, "delegation-receipts.json"), "utf8"))).toEqual([expect.objectContaining({ id: sent, result: "interrupted by the reinstall" })]);
      // the 1.0.1 sweep (running/waiting_owner -> unknown) finds nothing of the exported hand-offs
      expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE id IN (?,?) AND state IN ('running','waiting_owner')").get(unsent, fresh)).toMatchObject({ n: 0 });
    } finally { db.close(); }
  });
});

// ── F6 ────────────────────────────────────────────────────────────────────────────────
describe("F6. a failed clean-up of the old stand-in records holds admission", () => {
  function standIn(s: World, state: "queued" | "running") {
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "owner hand-off", depth: 0 }, 9).id!;
    insertRoomRequest(database(), { id, groupId: "owner-handoff", verb: "ask", fromKind: "bot", admissionKey: `ask:delegation:${id}`, state, now: 1, lineage: LINEAGE(s.from.threadId) });
    return id;
  }
  it("a DELETE that fails during the migration holds admission; nothing starts; the retry succeeds, then the boot settling treats the running record as accepted and runs nothing", async () => {
    const s = setup("owner");
    const id = standIn(s, "running");
    const opened: number[] = [];
    onDelegationAdmissionOpen(() => { opened.push(1); });
    database().exec("CREATE TRIGGER rr_nodelete BEFORE DELETE ON room_requests BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(runOwnerHandoffMigration(database())).toBe(false);
    expect(delegationAdmissionHeld()).toBe(true);
    // while held: the drain admits nothing, a start is refused, reconcile touches nothing
    let ran = 0;
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { ran++; });
    await tick();
    expect(ran).toBe(0);
    await startLikeIndex(s.b, s.approvalBus, id);                                       // the dispatch waits at the gate: nothing is started
    expect(promptsIn(s.target.threadId)).toBe(0);
    expect(rowOf(id)).toMatchObject({ phase: "fresh", started_at: null });
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 0, fresh: 0 });
    expect(pendingRows()).toBe(1);
    database().exec("DROP TRIGGER rr_nodelete");
    expect(runOwnerHandoffMigration(database())).toBe(true);                      // the retry (in process: a timer; here called directly)
    expect(delegationAdmissionHeld()).toBe(false);
    expect(opened).toEqual([1]);
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    let after = 0;
    await drainAll(s, s.from.threadId, () => { after++; });
    expect(after).toBe(0);
    expect(findDelegationReceipt(id)).toMatchObject({ status: "failed", result: RESTART_RECEIPT });
  });
  it("even with admission open, a row whose unmigrated stand-in record says it ran is never started", async () => {
    const s = setup("owner");
    const id = standIn(s, "running");
    expect(delegationAdmissionHeld()).toBe(false);
    await startLikeIndex(s.b, s.approvalBus, id);                                       // the dispatch finds the record: interrupted, never started
    expect(promptsIn(s.target.threadId)).toBe(0);
    let ran = 0;
    await drainAll(s, s.from.threadId, () => { ran++; });
    expect(ran).toBe(0);
    expect(findDelegationReceipt(id)).toMatchObject({ result: RESTART_RECEIPT });
    // a record that is only queued does not stop its row
    const waiting = standIn(s, "queued");
    await startLikeIndex(s.b, s.approvalBus, waiting);
    expect(rowOf(waiting)).toMatchObject({ phase: "started" });
  });
});

// ── F7 ────────────────────────────────────────────────────────────────────────────────
describe("F7. the idle release looks at one bounded page per pass, whatever the backlog", () => {
  function waiting(n: number) {
    const db = database();
    const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) VALUES(?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < n; i++) insert.run(`w-${i}`, `thread-${String(i).padStart(7, "0")}`, "target", "from", "busy", Date.now() + 60_000, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), "owner", `dlg-w-${i}`);
    db.exec("COMMIT");
  }
  it.each([1_000, 100_000])("%s waiting hand-offs: one pass asks admission at most one page of times and writes nothing when none is admitted", (n) => {
    waiting(n);
    const asked: string[] = [];
    const before = _delegationQueueWrites();
    expect(releaseDelegationsWaitingOn("target", (thread) => { asked.push(thread); return false; })).toEqual([]);
    expect(asked).toHaveLength(IDLE_RELEASE_BATCH);
    expect(_delegationQueueWrites() - before).toBe(0);
    expect(idleReleaseHasMore("target")).toBe(true);
    // rotating: the next pass asks about the next page, so a page that cannot start does not hide the ones behind it
    const next: string[] = [];
    releaseDelegationsWaitingOn("target", (thread) => { next.push(thread); return false; });
    expect(next).toHaveLength(IDLE_RELEASE_BATCH);
    expect(next.some((thread) => asked.includes(thread))).toBe(false);
    if (n === 1_000) {
      for (let pass = 2; idleReleaseHasMore("target") && pass < 50; pass++) releaseDelegationsWaitingOn("target", (thread) => { next.push(thread); return false; });
      expect(new Set([...asked, ...next]).size).toBe(n);                           // every waiting thread was looked at, a page at a time
      expect(idleReleaseHasMore("target")).toBe(false);
    }
  });
  it("admitted hand-offs are released a page at a time, with at most one write per released thread", () => {
    waiting(250);
    const before = _delegationQueueWrites();
    const first = releaseDelegationsWaitingOn("target", () => true);
    expect(first).toHaveLength(IDLE_RELEASE_BATCH);
    expect(_delegationQueueWrites() - before).toBe(IDLE_RELEASE_BATCH);
    expect(idleReleaseHasMore("target")).toBe(true);
    const rest = [...releaseDelegationsWaitingOn("target", () => true), ...releaseDelegationsWaitingOn("target", () => true)];
    expect(rest).toHaveLength(150);
    expect(idleReleaseHasMore("target")).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='busy'")).toBe(0);
  });
  it("the page statement uses the busy index with a limit", () => {
    waiting(10);
    const plan = (database().prepare("EXPLAIN QUERY PLAN SELECT DISTINCT source_thread_id FROM pending_delegations INDEXED BY pd_busy WHERE to_bot_id=? AND phase='busy' AND source_thread_id>? ORDER BY source_thread_id LIMIT ?").all("target", "", 100) as Array<{ detail: string }>).map((r) => r.detail).join("|");
    expect(plan).toContain("pd_busy");
    expect(plan).not.toMatch(/\bSCAN pending_delegations\b(?! USING)/);
  });
});

// ── F8 ────────────────────────────────────────────────────────────────────────────────
describe("F8. a 1.0.1 table that 1.0.2 grew is rebuilt from the executable original", () => {
  it.skipIf(!haveV101)("room_requests with an appended column downgrades, keeps its rows, and the real 1.0.1 inspector accepts the file", async () => {
    const s = setup("room");
    queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "keep me", depth: 0 }, 9);
    const rows = count("SELECT COUNT(*) AS n FROM room_requests");
    database().exec("ALTER TABLE room_requests ADD COLUMN grown_by_a_later_build TEXT");
    closeDatabase();
    const result = downgradeInstallationMemorySchema(DATA_DIR, 6) as { status: string };
    expect(result.status).toBe("downgraded");
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests").get()).toMatchObject({ n: rows });
      expect((db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).some((c) => c.name === "grown_by_a_later_build")).toBe(false);
      const { inspectInstallationDatabase } = await realV101();
      expect(() => inspectInstallationDatabase(db)).not.toThrow();
    } finally { db.close(); }
  }, 120_000);
});

// ── F9 ────────────────────────────────────────────────────────────────────────────────
describe("F9. the single re-dispatch goes into the conversation that holds the prompt", () => {
  it("the first attempt wrote its prompt in A; the selected conversation is B at the restart: the re-dispatch resumes in A with one prompt in all", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "pin me", depth: 0 }, 2).id!;
    const A = s.target.threadId;
    await drainAll(s, s.from.threadId, (taskId) => { stamp(s, taskId, A); });                 // attempt 1: prompt in A, never submitted
    expect(promptsIn(A)).toBe(1);
    restart(s);
    // the target's selected conversation is B now (what a fresh resolution would pick); the stored destination is A
    const B = "task-b-thread";
    const seen: string[] = [];
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, () => {}, {
      destinationFor: () => B,
      startTurn: async (_bot, text, turn) => { seen.push(turn.threadId); rememberRun(turn.delegationRun); writePrompt(s.b, turn.delegationRun, turn.threadId, text); turn.delegationRun.accepted("turn-2"); },
    });
    await until(() => _drainingCount() === 0);
    await tick();
    expect(seen).toEqual([A]);                                                                 // the dispatch ran it in the stored conversation
    expect(promptsIn(A)).toBe(1);
    expect(promptsIn(B)).toBe(0);
    expect(startedDelegation(id)).toMatchObject({ targetThreadId: A, startAttempts: 2 });
  });
});

// ── F10 ───────────────────────────────────────────────────────────────────────────────
describe("F10. a deleted sender that no longer resolves still gets the cancelled receipt", () => {
  it("the tombstone is recorded, the sender is gone from the registry, the drain removes the row and the receipt reads cancelled with the deletion wording", async () => {
    const s = setup("owner");
    const insert = database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run("ghost-1", "ghost-thread", s.target.id, "ghost-bot", "fresh", null, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), "owner", delegationTurnKey("ghost-1"));
    insert.run("ghost-2", "ghost-thread", s.target.id, "ghost-bot", "fresh", null, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), "owner", delegationTurnKey("ghost-2"));
    database().prepare("INSERT INTO owner_deleted_threads(thread_id, deleted_at) VALUES('bot:ghost-bot', 1)").run();
    let ran = 0;
    await drainAll(s, "ghost-thread", () => { ran++; });
    expect(ran).toBe(0);
    expect(pendingRows()).toBe(0);
    for (const id of ["ghost-1", "ghost-2"]) expect(findDelegationReceipt(id)).toMatchObject({ status: "cancelled", result: DELETED_NOTE });
    expect(existsSync(legacyFile())).toBe(false);
  });
});
