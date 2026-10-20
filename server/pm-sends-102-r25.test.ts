// Round 25 (the fix round after DESIGN-r24): one test per finding of the r24 review, each reproducing the finding first (the failing behavior is what the assertion
// states as the right one) and each going through the production code.
//  1  normal boot makes no file in the data folder: the held notice lines live in the queue (held_notice_lines)
//  2  Murage's own dispatch-error line never proves the provider ran; the engine's reply, recorded as it is written, does
//  3  a plain shared request whose id is also a hand-off's goes only through the hand-off dispatch (and a wake is no different)
//  4  a start cut short before the provider again and again is held for the owner ("did not start"), never deleted
//  5  every recovery, release and drain loop does a bounded amount of work per event-loop pass (100,000 of each, one source thread included)
//  6  evidence does not depend on row order: a rewritten prompt row (new rowid) changes nothing
//  7  a held line that could not be cleared is retried by the next pass; the sweep walks only the queue's own list
//  8  an owner's drain does not start shared work ahead of the shared fair order
//  9  the held reason keeps the failure category, in the owner's words
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import {
  DRAIN_PAGE, IDLE_RELEASE_BATCH, RESTART_RECEIPT, SHARED_REQUEUE_ROWS, SETTLE_PAGE, _drainingCount, _resetPending, appendHeldLine, busyHandoffText, didNotStartText,
  dismissHeldDelegation, drainDelegations, findDelegationReceipt, heldLineId, idleReleaseHasMore, queueDelegation, reconcileStartedDelegations, registerHeldLine, releaseDelegationsWaitingOn,
  resendHeldDelegation, settleStartedDelegations, uncertainHandoffText, type HeldDelegation,
} from "./delegations.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { configureHandoffDispatch, dispatchHandoff, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { APP_SCHEMA_102_ADDITIONS } from "./installation-app-schema-downgrade.ts";
import { OLD_OWNER_HANDOFF_GROUP, OWNER_MIGRATION_PAGE, _resetOwnerMigration, delegationAdmissionHeld, handoffOutputExists, holdForReconcile, onDelegationAdmissionOpen, runOwnerHandoffMigration } from "./pending-delegations-schema.ts";
import { roomRequest } from "./room-requests.ts";
import { drainSharedWork, enqueueSharedWork } from "./shared-work.ts";
import { fakeHost, rememberRun, writePrompt } from "./testing/handoff-turn.ts";
import { ownerWorld, sharedWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { engineReply } from "./testing/provider-reply.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const settle = async (ms?: number): Promise<void> => { await until(() => _drainingCount() === 0, ms); await tick(); await tick(); };
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at, accepted_turn_id, start_attempts, target_thread_id, evidence_at, item FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
const heldReasonOf = (id: string): unknown => { const row = rowOf(id); return row ? (JSON.parse(String(row.item)) as { heldReason?: unknown }).heldReason : undefined; };

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

/** A server whose startTurn does what `steps` says, over an owner world: the prompt and the start commit together (writePrompt), then the test's own steps. */
function attach(w: OwnerWorld, steps: (turn: HandoffTurnOptions, text: string) => void | Promise<void>, held: HeldDelegation[] = [], options: { prompt?: boolean } = {}): void {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      rememberRun(turn.delegationRun);
      if (options.prompt !== false) writePrompt(w.bus, turn.delegationRun, turn.threadId, text);
      await steps(turn, text);
    },
    noticeHeld: (notice) => { held.push(notice); },
  }, { bus: w.bus, approvalBus: w.approvalBus });
}
const queued = (w: OwnerWorld, message = "do it once") => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message, depth: 0 }, 2).id!;

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. normal boot makes no file in the data folder, and the held lines are the queue's own", () => {
  it("an empty boot settling writes nothing to DATA_DIR, and every entry the data folder holds is one the backup inventory knows", async () => {
    const w = ownerWorld("owner");
    queued(w);
    const before = readdirSync(DATA_DIR).sort();
    await settleStartedDelegations({ store: w.store });
    reconcileStartedDelegations({ store: w.store });
    expect(existsSync(`${DATA_DIR}/held-lines-swept.json`)).toBe(false);
    expect(readdirSync(DATA_DIR).sort()).toEqual(before);                                // no file of Murage's own appeared
    for (const entry of readdirSync(DATA_DIR)) if (/held-lines/.test(entry)) expect(classifyDataDirEntry(entry), entry).toBeDefined();
  });
  it("held_notice_lines is a 1.0.2 object the downgrade drops and the snapshot knows", () => {
    ownerWorld("owner");
    expect(APP_SCHEMA_102_ADDITIONS.tables).toContain("held_notice_lines");
    expect(count("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='held_notice_lines'")).toBe(1);
  });
  it("the line and its registration commit together (a write that fails leaves neither), and a release deletes both in one commit", async () => {
    const w = ownerWorld("owner");
    const id = queued(w);
    const held: HeldDelegation = { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: uncertainHandoffText("Helper") };
    expect(() => w.store.appendMessage(w.from.threadId, { role: "bot", kind: "activity", tool: { name: "x", ok: false }, delegationHeld: { id } }, heldLineId(id), () => { registerHeldLine(held); throw new Error("the commit failed"); })).toThrow();
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id=?", w.from.threadId, heldLineId(id))).toBe(0);
    appendHeldLine(w.store, held);
    appendHeldLine(w.store, held);                                                      // repeated: nothing more
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id=?", w.from.threadId, heldLineId(id))).toBe(1);
  });
});

// ── 2 + 6 ─────────────────────────────────────────────────────────────────────────────
describe("2/6. evidence is the engine's reply, recorded as it is written", () => {
  it("2. the dispatch-error line Murage writes does not prove the provider ran: the submitted hand-off is HELD, never deleted", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      // the production failure handler: a bot activity that says what went wrong (no provider turn id), then the callback
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "activity", tool: { name: "error: connection lost", ok: false } });
      turn.onDispatchError("connection lost");
    }, held);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null, evidence_at: null });
    expect(handoffOutputExists(database(), id)).toBe(false);
    expect(held.map((notice) => notice.id)).toEqual([id]);
    expect(findDelegationReceipt(id)?.result).toBe(uncertainHandoffText("Helper"));
  });
  it("a line Murage wrote as an actor of its own (even with a turn id) is not evidence either", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "activity", tool: { name: "status" }, actorKind: "murage", turnId: "turn-x" });
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "a copy", copyOf: { threadId: "t", messageIds: ["m"] }, turnId: "turn-x" });
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)?.evidence_at).toBeNull();
  });
  it("6. the engine's reply to the prompt is evidence even after the prompt row was rewritten (a new rowid): recovery reports it interrupted, never held", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "on it", turnId: "provider-turn-1" }, undefined, undefined, engineReply(turn.threadId, "provider-turn-1"));
      // INSERT OR REPLACE gives the prompt row a new rowid, past the reply
      const prompt = database().prepare("SELECT thread_id, id, at, role, kind, text, json FROM messages WHERE thread_id=? AND id=?").get(turn.threadId, turn.delegationRun.turnKey) as Record<string, string | number | null>;
      database().prepare("INSERT OR REPLACE INTO messages(thread_id, id, at, role, kind, text, json) VALUES(?,?,?,?,?,?,?)").run(prompt.thread_id as string, prompt.id as string, prompt.at as number, prompt.role as string, prompt.kind as string, prompt.text as string, prompt.json as string);
      turn.onDispatchError("connection lost");
    }, held);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)).toBeUndefined();                                                  // interrupted, not held
    expect(held).toEqual([]);
    expect(findDelegationReceipt(id)).toMatchObject({ result: RESTART_RECEIPT });
  });
  it("6. a reply that arrives while the hand-off is held makes Send again refuse (it ran), and a rewritten prompt row changes nothing", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => { turn.delegationRun.submitted(); turn.onDispatchError("connection lost"); });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
    const thread = String(rowOf(id)!.target_thread_id);
    w.store.appendMessage(thread, { role: "bot", kind: "text", text: "late reply", turnId: "provider-turn-late" }, undefined, undefined, engineReply(thread, "provider-turn-late"));
    expect(rowOf(id)?.evidence_at).not.toBeNull();
    const prompt = database().prepare("SELECT at, role, kind, text, json FROM messages WHERE thread_id=? AND id=?").get(thread, `dlg-${id}`) as Record<string, string | number | null>;
    database().prepare("INSERT OR REPLACE INTO messages(thread_id, id, at, role, kind, text, json) VALUES(?,?,?,?,?,?,?)").run(thread, `dlg-${id}`, prompt.at as number, prompt.role as string, prompt.kind as string, prompt.text as string, prompt.json as string);
    expect(resendHeldDelegation(w.bus, id)).toMatchObject({ result: "already_ran" });
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase<>'started'")).toBe(0);   // no new hand-off
  });
  it("evidence is recorded in the reply's own transaction: a reply whose write fails leaves none", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      expect(() => w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "x", turnId: "t-1" }, undefined, () => { throw new Error("rolled back"); }, engineReply(turn.threadId, "t-1"))).toThrow();
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)?.evidence_at).toBeNull();
  });
  it("a reply of the provider that does not descend from this prompt (another owner message in between) is not evidence", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      w.store.appendMessage(turn.threadId, { role: "user", kind: "text", text: "and something else" });
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "an answer to that", turnId: "t-2" }, undefined, undefined, engineReply(turn.threadId, "t-2"));
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)?.evidence_at).toBeNull();
  });
});

// ── 3 + 8 ─────────────────────────────────────────────────────────────────────────────
describe("3. a plain shared request that has a hand-off row goes only through the hand-off dispatch", () => {
  it("the shared drain finds the partner by the row's existence for the request id (the key is not spelled ask:delegation:): with the gate closed nothing starts", () => {
    const w = sharedWorld();
    const inserted = enqueueSharedWork(w.store, { fromBotId: w.sales.id, sourceThreadId: w.sales.threadId, toBotId: w.iris.id, message: "plain", admissionKey: "plain-key-1", ownerAudience: true, now: 1, id: "plain-1" });
    if (!inserted.ok) throw new Error(inserted.code);
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("plain-1", w.sales.threadId, w.iris.id, w.sales.id, "fresh", null, JSON.stringify({ message: "plain", depth: 0, attempts: 0 }), "shared", "dlg-plain-1", inserted.request.targetThreadId);
    const release = holdForReconcile();                                                   // the reconciliation gate is closed
    drainSharedWork(w.iris.id);
    expect(w.started).toEqual([]);                                                        // the plain start was not called
    expect(w.turns).toEqual([]);
    expect(rowOf("plain-1")).toMatchObject({ phase: "fresh" });
    expect(roomRequest(database(), "plain-1")!.state).toBe("queued");
    release();
  });
  it("once the gate opens the request is the hand-off's by its id: one ticketed start through the dispatch, the partner is kept, and the plain starter is never called (r26: it used to end the hand-off and start the request plain)", async () => {
    const w = sharedWorld();
    const inserted = enqueueSharedWork(w.store, { fromBotId: w.sales.id, sourceThreadId: w.sales.threadId, toBotId: w.iris.id, message: "plain", admissionKey: "plain-key-2", ownerAudience: true, now: 1, id: "plain-2" });
    if (!inserted.ok) throw new Error(inserted.code);
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("plain-2", w.sales.threadId, w.iris.id, w.sales.id, "fresh", null, JSON.stringify({ message: "plain", depth: 0, attempts: 0 }), "shared", "dlg-plain-2", inserted.request.targetThreadId);
    drainSharedWork(w.iris.id);                                                           // through the dispatch: one ticketed start
    await until(() => w.turns.length >= 1);
    expect(w.started).toEqual([]);                                                        // zero plain starts
    expect(w.turns.map((turn) => turn.id)).toEqual(["plain-2"]);
    expect(rowOf("plain-2")).toMatchObject({ phase: "started" });                         // the partner was not deleted, it was started
    drainSharedWork(w.iris.id);                                                           // and nothing starts it a second time
    await settle();
    expect(w.started).toEqual([]);
    expect(w.turns).toHaveLength(1);
  });
});

describe("8. an owner's drain does not start shared work ahead of the shared fair order", () => {
  it("an older request of another team goes first: the newer one waits for the shared drain, which starts both in order", async () => {
    const w = sharedWorld();
    const older = w.handoff("old-b", w.support);
    const newer = w.handoff("new-a", w.sales);
    database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(1, older.id);
    database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(5, newer.id);
    drainDelegations(w.bus, w.approvalBus, w.sales.threadId);                             // the owner's drain of the NEWER request's source conversation
    await settle();
    await until(() => w.turns.length >= 2);
    expect(w.turns.map((turn) => turn.id)).toEqual(["old-b", "new-a"]);
  });
});

// ── 4 + 9 ─────────────────────────────────────────────────────────────────────────────
describe("4/9. a start cut short before the provider is held for the owner, never deleted, and says so", () => {
  it("4. prompt committed, preparation fails before the submission, twice: held (did not start), zero submissions, the row and a receipt kept", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    attach(w, () => { throw new Error("preparation failed"); }, held);
    const id = queued(w);
    const env = { bus: w.bus, approvalBus: w.approvalBus };
    expect(await dispatchHandoff(id, env)).toBe("waiting");                                // attempt 1 cut short: one more try is allowed
    expect(rowOf(id)).toMatchObject({ phase: "busy", start_attempts: 1 });
    expect(await dispatchHandoff(id, env)).toBe("settled");                                // attempt 2 cut short: held
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null, accepted_turn_id: null });   // held, not deleted; the provider was never handed the turn
    expect(heldReasonOf(id)).toBe("didNotStart");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id, reason: "didNotStart", text: "This didn't start for @Helper. Send again or dismiss it." });
    expect(findDelegationReceipt(id)).toMatchObject({ status: "failed", result: didNotStartText("Helper") });
    // the owner chooses: Send again queues a NEW hand-off without asking whether the original ran (it never could have), Dismiss lets it go
    appendHeldLine(w.store, held[0]!);
    expect(resendHeldDelegation(w.bus, id)).toMatchObject({ result: "ok" });
    expect(rowOf(id)).toBeUndefined();
  });
  it("Dismiss lets a did-not-start hand-off go with its control", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    attach(w, () => { throw new Error("preparation failed"); }, held);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    appendHeldLine(w.store, held[0]!);
    expect(dismissHeldDelegation(id, w.store)).toBe(true);
    expect(rowOf(id)).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
  });
  it("9. three failures before the prompt (credentials unavailable) end held as 'did not start', not as 'stayed busy'", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    configureHandoffDispatch({ ...fakeHost(w.bus, () => {}, { stamp: false }), startTurn: async () => { throw new Error("credentials unavailable"); }, noticeHeld: (notice) => { held.push(notice); } }, { bus: w.bus, approvalBus: w.approvalBus });
    const id = queued(w);
    for (let round = 0; round < 8 && held.length === 0; round++) {
      await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
      releaseDelegationsWaitingOn(w.target.id);
    }
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id, reason: "didNotStart", text: didNotStartText("Helper") });
    expect(held[0]!.text).not.toMatch(/busy/);
    expect(heldReasonOf(id)).toBe("didNotStart");
  });
  it("9. a teammate that stayed busy is still held as busy, in its own words, and neither wording has a dash or an internal code", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation[] = [];
    attach(w, () => undefined, held);
    w.knobs.busyThreads.add(w.target.threadId);
    const id = queued(w);
    for (let round = 0; round < 8 && held.length === 0; round++) {
      await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
      releaseDelegationsWaitingOn(w.target.id);
    }
    expect(held[0]).toMatchObject({ id, reason: "busy", text: busyHandoffText("Helper") });
    expect(busyHandoffText("Helper")).toBe("@Helper stayed busy, so this wasn't sent. Send again or dismiss it.");
    expect(didNotStartText("Helper")).toBe("This didn't start for @Helper. Send again or dismiss it.");
    for (const text of [busyHandoffText("Helper"), didNotStartText("Helper")]) expect(text).not.toMatch(/[–—]|[A-Z_]{4,}|didNotStart/);
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────
describe("5. every recovery, release and drain loop does a bounded amount of work per event-loop pass", () => {
  const ITEM = JSON.stringify({ message: "m", depth: 0, attempts: 0 });
  /** counts, per turn of the event loop, how much a counter moved */
  function worstPerPass(read: () => number, done: () => boolean): { worst: () => number; passes: () => number; finished: Promise<void> } {
    let last = read(), worst = 0, passes = 0;
    const finished = (async () => { for (;;) { await tick(); const now = read(); worst = Math.max(worst, now - last); last = now; passes++; if (done()) break; } })();
    return { worst: () => worst, passes: () => passes, finished };
  }

  it("idle release, one source thread holding 100,000 waiting hand-offs: at most one page is asked and written per pass, and every one is looked at", () => {
    const db = database();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key)
      SELECT 'w'||i, 'one-thread', 'target', 'from', 'busy', ${Date.now() + 60_000}, '${ITEM}', 'owner', 'dlg-w'||i FROM n`);
    const asked = new Set<string>();
    let worst = 0, passes = 0;
    for (;;) {
      let inPass = 0;
      releaseDelegationsWaitingOn("target", (_thread, id) => { inPass++; asked.add(id); return false; });
      worst = Math.max(worst, inPass); passes++;
      if (!idleReleaseHasMore("target")) break;
      if (passes > 5_000) throw new Error("the release does not progress");
    }
    expect(worst).toBeLessThanOrEqual(IDLE_RELEASE_BATCH);
    expect(asked.size).toBe(100_000);
    // admitted hand-offs: a page of releases per pass
    let released = 0;
    releaseDelegationsWaitingOn("target", (_t, id) => { released++; return id.length > 0; });
    expect(released).toBe(IDLE_RELEASE_BATCH);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'")).toBe(IDLE_RELEASE_BATCH);
  }, 120_000);

  it("the unstarted shared partners marked running (100,000): requeued a range per pass, never one statement for all", async () => {
    const db = database();
    ownerWorld("owner");
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO room_requests(id, root_id, group_id, verb, from_kind, to_bot_id, target_thread_id, state, created_at, root_thread_id, origin, audience_fingerprint, not_owner_audience, unattended, admission_key)
      SELECT 'r'||i, 'r'||i, 'g', 'ask', 'bot', 't', 'tt', 'running', 1, 'rt', 'desktop', 'fp', 0, 0, 'ask:delegation:r'||i FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key)
      SELECT 'r'||i, 'src', 't', 'f', 'fresh', NULL, '${ITEM}', 'shared', 'dlg-r'||i FROM n`);
    db.exec("CREATE TEMP TABLE requeued(n INTEGER); INSERT INTO requeued VALUES(0); CREATE TEMP TRIGGER requeue_count AFTER UPDATE OF state ON main.room_requests WHEN NEW.state='queued' AND OLD.state<>'queued' BEGIN UPDATE requeued SET n=n+1; END;");
    const read = () => Number((db.prepare("SELECT n FROM requeued").get() as { n: number }).n);
    let finishedSettling = false;
    const watch = worstPerPass(read, () => finishedSettling);
    await settleStartedDelegations();
    finishedSettling = true;
    await watch.finished;
    expect(read()).toBe(100_000);
    expect(watch.worst()).toBeLessThanOrEqual(SHARED_REQUEUE_ROWS);
    expect(watch.passes()).toBeGreaterThanOrEqual(100_000 / SHARED_REQUEUE_ROWS);
  }, 240_000);

  it("the owner-record clean-up of 100,000 stand-in records: a page per pass, admission held until the last page, and it opens once", async () => {
    const db = database();
    ownerWorld("owner");
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO room_requests(id, root_id, group_id, verb, from_kind, to_bot_id, target_thread_id, state, created_at, root_thread_id, origin, audience_fingerprint, not_owner_audience, unattended, admission_key)
      SELECT 'o'||i, 'o'||i, '${OLD_OWNER_HANDOFF_GROUP}', 'ask', 'bot', 't', 'tt', 'queued', 1, 'rt', 'desktop', 'fp', 0, 0, 'ask:delegation:o'||i FROM n`);
    db.exec("CREATE TEMP TABLE gone(n INTEGER); INSERT INTO gone VALUES(0); CREATE TEMP TRIGGER gone_count AFTER DELETE ON main.room_requests BEGIN UPDATE gone SET n=n+1; END;");
    const read = () => Number((db.prepare("SELECT n FROM gone").get() as { n: number }).n);
    let opened = 0;
    onDelegationAdmissionOpen(() => { opened++; });
    let over = false;
    const watch = worstPerPass(read, () => over);
    expect(runOwnerHandoffMigration(db)).toBe(false);                                     // a full page: more to do, admission held
    expect(delegationAdmissionHeld()).toBe(true);
    expect(read()).toBeLessThanOrEqual(OWNER_MIGRATION_PAGE);
    await until(() => !delegationAdmissionHeld());
    over = true;
    await watch.finished;
    expect(read()).toBe(100_000);
    expect(watch.worst()).toBeLessThanOrEqual(OWNER_MIGRATION_PAGE);
    expect(opened).toBe(1);
  }, 240_000);

  // Measured (whole drain): Linux 101 s on a hosted runner (nightly 39345477364), macOS 62-92 s, Windows up to 222 s for this file's
  // two nightly tests (CI 39357825825). The wait for the drain used to stop at 120 s, below the test's own limit, so a slower
  // runner failed inside the limit; it now waits as long as the test may run.
  it("a queue of 100,000 on ONE source conversation is drained a page per pass", { tags: ["nightly"], timeout: 600_000 }, async () => {
    const w = ownerWorld("owner");
    w.knobs.capacity = false;                                                             // every dispatch waits (capacity): no write, no turn
    let asks = 0;
    const original = w.bus.canDispatch!;
    w.bus.canDispatch = () => { asks++; return original(); };
    const item = JSON.stringify({ toBotId: w.target.id, message: "m", depth: 0, attempts: 0, fromBotId: w.from.id });
    database().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key)
      SELECT 'q'||i, '${w.from.threadId}', '${w.target.id}', '${w.from.id}', 'fresh', NULL, '${item}', 'owner', 'dlg-q'||i FROM n`);
    let over = false;
    const watch = worstPerPass(() => asks, () => over);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle(570_000);
    over = true;
    await watch.finished;
    expect(asks).toBe(100_000);                                                           // every hand-off was looked at
    expect(watch.worst()).toBeLessThanOrEqual(DRAIN_PAGE);                               // and never more than a page between two turns of the event loop
    expect(watch.passes()).toBeGreaterThanOrEqual(100_000 / DRAIN_PAGE);
    expect(w.turns).toEqual([]);
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────
describe("7. a held line that could not be cleared is tried again, and the sweep walks only the queue's own list", () => {
  it("the first attempt fails: the registration stays, the next pass clears the control", async () => {
    const w = ownerWorld("owner");
    const held: HeldDelegation = { id: "ghost", sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: uncertainHandoffText("Helper") };
    appendHeldLine(w.store, held);                                                        // a control with no row behind it
    let failing = true;
    const flaky = { patchMessage: (thread: string, id: string, patch: Partial<never>, within?: () => void) => { if (failing) throw new Error("the write failed"); return w.store.patchMessage(thread, id, patch, within); } };
    await settleStartedDelegations({ store: flaky as never });
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(1);                 // not skipped past: it stays on the list
    failing = false;
    await settleStartedDelegations({ store: flaky as never });
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    const line = database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(w.from.threadId, heldLineId("ghost")) as { json: string };
    expect((JSON.parse(line.json) as { delegationHeld?: unknown }).delegationHeld).toBeUndefined();
  });
  // Measured: Linux 42 s on a hosted runner (nightly 39345477364), macOS 14-31 s, Windows up to 222 s for this file's two nightly
  // tests (CI 39357825825); 240 s left no room on Windows.
  it("100,000 registered lines: a page of 100 per pass, and a control a held row still backs is left alone", { tags: ["nightly"], timeout: 480_000 }, async () => {
    const w = ownerWorld("owner");
    database().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO held_notice_lines(message_id, delegation_id, source_thread_id) SELECT 'held-g'||i, 'g'||i, 't'||(i%100) FROM n`);
    let released = 0, inPass = 0, worst = 0;
    const counting = { patchMessage: (_t: string, _i: string, _p: unknown, within?: () => void) => { within?.(); released++; inPass++; return null; } };
    let over = false;
    const ticker = (async () => { for (;;) { await tick(); worst = Math.max(worst, inPass); inPass = 0; if (over) break; } })();
    await settleStartedDelegations({ store: counting as never });
    over = true;
    await ticker;
    expect(released).toBe(100_000);
    expect(worst).toBeLessThanOrEqual(SETTLE_PAGE);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    void w;
  });
});
