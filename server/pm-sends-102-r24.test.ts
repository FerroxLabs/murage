// DESIGN-r24: every queued hand-off starts through ONE path (server/handoff-dispatch.ts). One test per r23 finding, each through the production dispatch:
//  r23#1  a migration fault holds shared work too: it is kept, never failed, and starts once after the gate opens (real retry timer)
//  r23#2  a pinned hand-off is admitted against the conversation it will run in: busy there waits, and starts there later
//  r23#3  an earlier reply never proves a hand-off ran: evidence is association (the reply descends from the prompt), not time
//  r23#4  a held line and its row change together (Send again, Dismiss, expiry, late acceptance), and a leftover line is swept
//  r23#6  recovery reads one page of 100 per event-loop pass
//  Send again asks whether the original ran; a teammate that stayed busy is held for the owner, never dropped
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import {
  MAX_BUSY_ATTEMPTS, RESTART_RECEIPT, SETTLE_PAGE, _drainingCount, _loadPending, _resetPending, _simulateRestart, alreadyPickedUpText, busyHandoffText, dismissHeldDelegation, drainDelegations,
  findDelegationReceipt, heldLineId, queueDelegation, registerHeldLine, reconcileStartedDelegations, releaseDelegationsWaitingOn, resendHeldDelegation, settleStartedDelegations, uncertainHandoffText,
} from "./delegations.ts";
import { admit, dispatchHandoff } from "./handoff-dispatch.ts";
import { handoffOutputExists, _resetOwnerMigration, onDelegationAdmissionOpen, runOwnerHandoffMigration, delegationAdmissionHeld } from "./pending-delegations-schema.ts";
import { insertRoomRequest, roomRequest } from "./room-requests.ts";
import { drainSharedWork } from "./shared-work.ts";
import { runOf, startLikeIndex } from "./testing/handoff-turn.ts";
import { LINEAGE, ownerWorld, sharedWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { engineReply } from "./testing/provider-reply.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const settle = async (): Promise<void> => { await until(() => _drainingCount() === 0); await tick(); await tick(); };
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at, accepted_turn_id, start_attempts, target_thread_id, retry_at FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
const promptsIn = (thread: string) => count("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id LIKE 'dlg-%'", thread);
const pendingRows = () => count("SELECT COUNT(*) AS n FROM pending_delegations");

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

/** Queues a hand-off in an owner world, runs its first attempt to "prompt written, handed to the provider, not accepted" and restarts: it is held. */
async function heldHandoff(w: OwnerWorld, options: { submit?: boolean } = { submit: true }): Promise<string> {
  const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it exactly once", depth: 0 }, 2).id!;
  await startLikeIndex(w.bus, w.approvalBus, id, { submit: options.submit ?? true });
  _simulateRestart(); _loadPending();
  w.attach();
  const held: string[] = [];
  reconcileStartedDelegations({ botName: () => "Helper", notice: (n) => { held.push(n.id); }, store: w.store });
  expect(rowOf(id)).toMatchObject(options.submit === false ? { phase: "fresh" } : { phase: "started", started_at: null });
  return id;
}
/** The held line the server writes for a held hand-off (index.ts noticeHeldHandoff). */
function writeHeldLine(w: OwnerWorld, id: string, text = uncertainHandoffText("Helper")): void {
  w.store.appendMessage(w.from.threadId, { role: "bot", kind: "activity", tool: { name: text, ok: false }, delegationHeld: { id } }, heldLineId(id), () => registerHeldLine({ id, sourceThreadId: w.from.threadId }));
}
const lineOf = (w: OwnerWorld, id: string) => database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(w.from.threadId, heldLineId(id)) as { json: string } | undefined;
const controlOf = (w: OwnerWorld, id: string): unknown => { const row = lineOf(w, id); return row ? (JSON.parse(row.json) as { delegationHeld?: unknown }).delegationHeld : "no line"; };

// ── r23#1 ─────────────────────────────────────────────────────────────────────────────
describe("r23#1. a migration fault holds shared work too: kept while held, started once after the gate opens", () => {
  it("shared dispatch during the fault: the request stays queued and the row is kept; the real retry timer reopens the gate and exactly one prompt is written", async () => {
    const w = sharedWorld();
    w.handoff("sh-gate");
    // the clean-up of an earlier build's stand-in record fails: nothing is admitted
    insertRoomRequest(database(), { id: "stand-in", groupId: "owner-handoff", verb: "ask", fromKind: "bot", admissionKey: "ask:delegation:stand-in", state: "queued", now: 1, lineage: LINEAGE(w.sales.threadId) });
    database().exec("CREATE TRIGGER rr_nodelete BEFORE DELETE ON room_requests BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(runOwnerHandoffMigration(database())).toBe(false);
    expect(delegationAdmissionHeld()).toBe(true);
    // what the server does when the gate reopens: settle, then drain the shared work again
    onDelegationAdmissionOpen(() => { void settleStartedDelegations().then(() => drainSharedWork(w.iris.id)); });
    drainSharedWork(w.iris.id);
    await tick();
    expect(w.turns).toEqual([]);
    expect(roomRequest(database(), "sh-gate")!.state).toBe("queued");              // never failed, never running
    expect(rowOf("sh-gate")).toMatchObject({ phase: "fresh" });
    expect(findDelegationReceipt("sh-gate")).toBeNull();
    // the fault is cured; the migration's own one second retry timer opens the gate and the listener drains
    database().exec("DROP TRIGGER rr_nodelete");
    await until(() => w.turns.length === 1, 20_000);
    await tick();
    expect(delegationAdmissionHeld()).toBe(false);
    const thread = roomRequest(database(), "sh-gate")!.targetThreadId!;
    expect(promptsIn(thread)).toBe(1);
    expect(rowOf("sh-gate")).toMatchObject({ phase: "started", start_attempts: 1 });
    expect(roomRequest(database(), "sh-gate")!.state).toBe("running");
  }, 40_000);
});

// ── r23#2 ─────────────────────────────────────────────────────────────────────────────
describe("r23#2. a pinned hand-off is admitted against the conversation it will run in", () => {
  it("prompt written in A, B selected at the restart, A busy and B idle: it waits (kept), and starts in A when A is free", async () => {
    const w = ownerWorld("owner");
    const A = w.target.threadId, B = "selected-b";
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "pin me", depth: 0 }, 2).id!;
    await startLikeIndex(w.bus, w.approvalBus, id);                                    // attempt 1: prompt in A, never submitted
    _simulateRestart(); _loadPending(); w.attach();
    reconcileStartedDelegations();
    expect(rowOf(id)).toMatchObject({ phase: "fresh", start_attempts: 1, target_thread_id: A });
    w.knobs.destination = B;                                                           // a fresh resolution would pick B now
    w.knobs.busyThreads.add(A);                                                        // and A is taken
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns).toEqual([]);                                                       // nothing started in B, nothing failed in A
    expect(rowOf(id)).toMatchObject({ phase: "busy", target_thread_id: A });
    expect(findDelegationReceipt(id)).toBeNull();                                      // kept: not ended
    expect(promptsIn(B)).toBe(0);
    // A frees up: the idle release asks the dispatch's own question about THE stored conversation, wakes it, and it runs there
    w.knobs.busyThreads.delete(A);
    const woke = releaseDelegationsWaitingOn(w.target.id, (_thread, handoff) => admit(handoff, { bus: w.bus, approvalBus: w.approvalBus }, { probe: true }).kind !== "wait");
    expect(woke).toEqual([w.from.threadId]);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.thread)).toEqual([A]);
    expect(promptsIn(A)).toBe(1);
    expect(promptsIn(B)).toBe(0);
    expect(rowOf(id)).toMatchObject({ phase: "started", start_attempts: 2, target_thread_id: A });
  });
  it("a thread that is busy only on the OTHER side is not a reason to wait: the same question asked of the stored destination", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "go", depth: 0 }, 2).id!;
    w.knobs.busyThreads.add("some-other-thread");
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.id)).toEqual([id]);
  });
});

// ── r23#3 ─────────────────────────────────────────────────────────────────────────────
describe("r23#3. an earlier reply never proves a hand-off ran: output is a descendant of the prompt, not a later timestamp", () => {
  it("a bot reply written in the same millisecond BEFORE the prompt is not evidence: the submitted hand-off is held", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "the earlier reply is another matter", depth: 0 }, 2).id!;
    const at = Date.now();
    w.store.appendMessage(w.target.threadId, { role: "bot", kind: "text", text: "an earlier reply to something else", at });     // the reply comes first
    await startLikeIndex(w.bus, w.approvalBus, id, { submit: true });                  // then the prompt, handed to the provider
    database().prepare("UPDATE messages SET at=? WHERE thread_id=? AND id=?").run(at, w.target.threadId, runOf(id).turnKey);   // the same millisecond
    expect(handoffOutputExists(database(), id)).toBe(false);
    _simulateRestart(); _loadPending();
    const result = reconcileStartedDelegations({ botName: () => "Helper" });
    expect(result).toMatchObject({ held: 1, interrupted: 0 });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
  });
  it("a reply that follows the prompt in the same conversation is evidence (interrupted), and so does a reply after a line Murage wrote about the exchange", async () => {
    for (const interleaved of [false, true]) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending();
      const w = ownerWorld("owner");
      const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "it ran", depth: 0 }, 2).id!;
      await startLikeIndex(w.bus, w.approvalBus, id, { submit: true });
      if (interleaved) w.store.appendMessage(w.target.threadId, { role: "bot", kind: "activity", tool: { name: "Message from @Someone" }, comm: { groupId: "g", withBotId: "x", withName: "Someone", withColor: "#000" } });
      expect(handoffOutputExists(database(), id)).toBe(false);    // nothing of the provider's yet
      w.store.appendMessage(w.target.threadId, { role: "bot", kind: "text", text: "working on it", turnId: "provider-turn-1" }, undefined, undefined, engineReply(w.target.threadId, "provider-turn-1"));
      expect(handoffOutputExists(database(), id)).toBe(true);
      _simulateRestart(); _loadPending();
      expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1, held: 0 });
      expect(findDelegationReceipt(id)).toMatchObject({ result: RESTART_RECEIPT });
    }
  });
  it("the walk is bounded and stops at the next owner message", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "bounded", depth: 0 }, 2).id!;
    await startLikeIndex(w.bus, w.approvalBus, id, { submit: true });
    const chip = { role: "bot" as const, kind: "activity" as const, tool: { name: "Message from @Someone" }, comm: { groupId: "g", withBotId: "x", withName: "Someone", withColor: "#000" } };
    // 70 lines Murage wrote about other exchanges, then a reply far past the window
    for (let i = 0; i < 70; i++) w.store.appendMessage(w.target.threadId, chip);
    w.store.appendMessage(w.target.threadId, { role: "bot", kind: "text", text: "late", turnId: "provider-turn-1" }, undefined, undefined, engineReply(w.target.threadId, "provider-turn-1"));
    expect(handoffOutputExists(database(), id)).toBe(false);
    // a reply that comes after the NEXT owner message belongs to that message, not to this prompt
    const other = ownerWorld("owner");
    const second = queueDelegation(other.bus, other.from, { toBotId: other.target.id, message: "second", depth: 0 }, 2).id!;
    await startLikeIndex(other.bus, other.approvalBus, second, { submit: true });
    other.store.appendMessage(other.target.threadId, { role: "user", kind: "text", text: "and now something else" });
    other.store.appendMessage(other.target.threadId, { role: "bot", kind: "text", text: "an answer to the owner's newer message", turnId: "provider-turn-2" }, undefined, undefined, engineReply(other.target.threadId, "provider-turn-2"));
    expect(handoffOutputExists(database(), second)).toBe(false);
  });
});

// ── r23#4 ─────────────────────────────────────────────────────────────────────────────
describe("r23#4. a held line and its row change in ONE commit", () => {
  it("Dismiss and Send again clear the control and the row together", async () => {
    const w = ownerWorld("owner");
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    expect(controlOf(w, id)).toEqual({ id });
    expect(dismissHeldDelegation(id, w.store)).toBe(true);
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
    expect(dismissHeldDelegation(id, w.store)).toBe(false);
    // Send again on a second one
    const other = await heldHandoff(w);
    writeHeldLine(w, other);
    const sent = resendHeldDelegation(w.bus, other);
    expect(sent.result).toBe("ok");
    expect(rowOf(other)).toBeUndefined();
    expect(controlOf(w, other)).toBeUndefined();
    expect(rowOf(sent.id!)).toMatchObject({ phase: "fresh" });
  });
  it("expiry (30 days) removes the row and the control together", async () => {
    const w = ownerWorld("owner");
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    database().prepare("UPDATE pending_delegations SET submitted_at=? WHERE id=?").run(Date.now() - 31 * 24 * 60 * 60 * 1000, id);
    await settleStartedDelegations({ store: w.store, botName: () => "Helper" });
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
  });
  it("a failure of the row change rolls the line's own write back (and the other way round): both as they were, then the retry changes both; a reload agrees", async () => {
    const w = ownerWorld("owner");
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    // the line is written first inside the transaction, the row change last; the row change is refused, so the line's write must not survive
    database().exec("CREATE TRIGGER pd_nodelete BEFORE DELETE ON pending_delegations BEGIN SELECT RAISE(ABORT, 'crash before commit'); END");
    expect(() => dismissHeldDelegation(id, w.store)).toThrow("crash before commit");
    database().exec("DROP TRIGGER pd_nodelete");
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });           // the row is still held ...
    expect(controlOf(w, id)).toEqual({ id });                                           // ... and so is its control
    expect(w.store.messagesFor(w.from.threadId).find((m) => m.id === heldLineId(id))?.delegationHeld).toEqual({ id });   // the cache agrees with the database
    expect(dismissHeldDelegation(id, w.store)).toBe(true);
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
    expect(w.store.messagesFor(w.from.threadId).find((m) => m.id === heldLineId(id))?.delegationHeld).toBeUndefined();
    // the reload reads the database: no control without a row
    closeDatabase();
    const reloaded = database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(w.from.threadId, heldLineId(id)) as { json: string };
    expect((JSON.parse(reloaded.json) as { delegationHeld?: unknown }).delegationHeld).toBeUndefined();
  });
  it("late acceptance of a held hand-off releases the line with the row", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "late", depth: 0 }, 2).id!;
    await startLikeIndex(w.bus, w.approvalBus, id, { submit: true });
    const run = runOf(id);
    // the failure that held it comes first (this process), the provider's acceptance after it
    expect(reconcileStartedDelegations({ botName: () => "Helper", store: w.store })).toMatchObject({ held: 1 });
    writeHeldLine(w, id);
    run.accepted("turn-late");
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
    expect(findDelegationReceipt(id)).toMatchObject({ result: RESTART_RECEIPT });
  });
  it("a leftover control whose row is gone is swept from the queue's own list of held lines, a bounded page at a time", async () => {
    const w = ownerWorld("owner");
    writeHeldLine(w, "ghost-1");                                                       // a line an earlier build left: no row behind it
    writeHeldLine(w, "ghost-2");
    expect(controlOf(w, "ghost-1")).toEqual({ id: "ghost-1" });
    await settleStartedDelegations({ store: w.store });
    expect(controlOf(w, "ghost-1")).toBeUndefined();
    expect(controlOf(w, "ghost-2")).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);               // the registration went with the control, in the same commit
    // a control that a held row still backs is left alone
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    await settleStartedDelegations({ store: w.store, botName: () => "Helper" });
    expect(controlOf(w, id)).toEqual({ id });
  });
  it("the endpoint's self-repair: a click on a row that is no longer held leaves nothing to click (the control is cleared by the caller, the row is not invented)", async () => {
    const w = ownerWorld("owner");
    writeHeldLine(w, "gone-1");
    expect(dismissHeldDelegation("gone-1", w.store)).toBe(false);
    expect(resendHeldDelegation(w.bus, "gone-1")).toEqual({ result: "not_held" });
  });
});

// ── r23#6 ─────────────────────────────────────────────────────────────────────────────
describe("r23#6. recovery reads one page per event-loop pass", () => {
  it("100,000 held rows: at most one page of 100 per pass, with the event loop yielding between pages", { tags: ["perf-budget"], timeout: 120_000 }, async () => {
    const db = database();
    // What this measures is the paging and the yielding, not the disk: each released row is its own commit, and with the product's
    // synchronous=FULL that is one fsync per row (about 1.7 ms on a build host cpx62 volume, so 100,000 rows took 195 s against the 120 s
    // timeout, every run; 14 s without the fsync). The fixture's file is thrown away, so durability is switched off for it alone.
    db.exec("PRAGMA synchronous=OFF");
    const w = ownerWorld("owner");
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at)
      SELECT 'h'||i, 't'||(i%100), 'peer', 'sender', 'started', NULL, '{"message":"m","depth":0,"attempts":0}', 'owner', 'dlg-h'||i, 1, NULL FROM n`);
    // every row is long expired, so each one is released through the store (which counts them per pass)
    let released = 0, inPass = 0, worst = 0, passes = 0;
    const counting = { patchMessage: (_thread: string, _id: string, _patch: unknown, within?: () => void) => { within?.(); released++; inPass++; return null; } };
    let ticks = 0;
    const ticker = (async () => { for (;;) { await tick(); ticks++; worst = Math.max(worst, inPass); inPass = 0; passes++; if (released >= 100_000) break; } })();
    await settleStartedDelegations({ store: counting as never });
    await ticker;
    expect(released).toBe(100_000);
    expect(worst).toBeLessThanOrEqual(SETTLE_PAGE);                                    // never more than a page between two turns of the event loop
    expect(ticks).toBeGreaterThanOrEqual(100_000 / SETTLE_PAGE);                       // and the loop did turn, page after page
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(w.turns).toEqual([]);
  });
  it("the gate stays closed until the last page of the boot settling is done, so settling still comes before any drain", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "waits for the settling", depth: 0 }, 2).id!;
    const settling = settleStartedDelegations({ botName: () => "Helper" });
    expect(delegationAdmissionHeld()).toBe(true);                                      // a settling in progress closes the gate
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);                           // a drain that comes in meanwhile admits nothing
    await tick();
    expect(w.turns).toEqual([]);
    await settling;
    expect(delegationAdmissionHeld()).toBe(false);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.id)).toEqual([id]);
  });
});

// ── Send again asks whether the original ran ─────────────────────────────────────────
describe("Send again: the original is checked first, and nothing is sent twice", () => {
  const copy = (name: string) => `@${name} already picked this up. Check @${name}'s conversation for the reply. It was not sent again.`;
  it("the exact wording has no dash", () => {
    expect(alreadyPickedUpText("Helper")).toBe(copy("Helper"));
    expect(alreadyPickedUpText("Helper")).not.toMatch(/[–—]/);
    expect(busyHandoffText("Helper")).toBe("@Helper stayed busy, so this wasn't sent. Send again or dismiss it.");
    expect(busyHandoffText("Helper")).not.toMatch(/[–—]|\bsafe\b|\bunsafe\b/i);
  });
  it.each(["accepted", "output", "live run"])("%s: no new hand-off, an interrupted receipt, the held line released, and the answer says it was not sent again", async (how) => {
    const w = ownerWorld("owner");
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    const before = pendingRows();
    if (how === "accepted") database().prepare("UPDATE pending_delegations SET accepted_turn_id='turn-late' WHERE id=?").run(id);
    if (how === "output") w.store.appendMessage(w.target.threadId, { role: "bot", kind: "text", text: "on it", turnId: "provider-turn-late" }, undefined, undefined, engineReply(w.target.threadId, "provider-turn-late"));
    if (how === "live run") w.bus.handoffRunning = (_thread, handoff) => handoff === id;
    if (how === "output") expect(handoffOutputExists(database(), id)).toBe(true);
    const sent = resendHeldDelegation(w.bus, id);
    expect(sent).toMatchObject({ result: "already_ran", toBotName: "Helper" });
    expect(pendingRows()).toBe(before - 1);                                            // the held row is released; no new row
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
    expect(findDelegationReceipt(id)).toMatchObject({ status: "failed", result: RESTART_RECEIPT });
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase<>'started'")).toBe(0);
  });
  it("when nothing shows it ran, Send again queues a NEW hand-off and removes the held one in the same commit", async () => {
    const w = ownerWorld("owner");
    const id = await heldHandoff(w);
    writeHeldLine(w, id);
    const sent = resendHeldDelegation(w.bus, id);
    expect(sent.result).toBe("ok");
    expect(sent.id).not.toBe(id);
    expect(rowOf(id)).toBeUndefined();
    expect(controlOf(w, id)).toBeUndefined();
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.id)).toEqual([sent.id]);                          // the original's first start was another process's
  });
});

// ── a teammate that stays busy is held for the owner, never dropped ──────────────────
describe("a teammate that stays busy through every retry: held with Send again and Dismiss, never silent", () => {
  it("after the last retry the hand-off is held (not deleted), the owner is told in words, and Send again or Dismiss resolves it", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "later", depth: 0 }, 2).id!;
    w.knobs.busyThreads.add(w.target.threadId);
    for (let round = 1; round < MAX_BUSY_ATTEMPTS; round++) {
      drainDelegations(w.bus, w.approvalBus, w.from.threadId);
      await settle();
      expect(rowOf(id)).toMatchObject({ phase: "busy" });
      expect(releaseDelegationsWaitingOn(w.target.id)).toEqual([w.from.threadId]);     // the target settled; it is still busy when asked again
    }
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns).toEqual([]);
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });           // held, kept
    expect(w.held).toEqual([{ id, text: "@Helper stayed busy, so this wasn't sent. Send again or dismiss it." }]);
    expect(findDelegationReceipt(id)).toMatchObject({ status: "busy_gave_up", toBotName: "Helper" });
    // a restart repeats the same words; Send again queues it as a new hand-off that runs once the teammate is free
    _simulateRestart(); _loadPending(); w.attach();
    await settleStartedDelegations({ botName: () => "Helper", notice: (n) => { w.held.push({ id: n.id, text: n.text }); } });
    expect(w.held.at(-1)).toEqual({ id, text: busyHandoffText("Helper") });
    w.knobs.busyThreads.clear();
    const sent = resendHeldDelegation(w.bus, id);
    expect(sent.result).toBe("ok");
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.id)).toEqual([sent.id]);
    expect(rowOf(id)).toBeUndefined();
  });
  it("Dismiss lets a busy-held hand-off go", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "later", depth: 0 }, 2).id!;
    w.knobs.busyThreads.add(w.target.threadId);
    for (let round = 1; round < MAX_BUSY_ATTEMPTS; round++) { drainDelegations(w.bus, w.approvalBus, w.from.threadId); await settle(); releaseDelegationsWaitingOn(w.target.id); }
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(dismissHeldDelegation(id, w.store)).toBe(true);
    expect(rowOf(id)).toBeUndefined();
    expect(w.turns).toEqual([]);
  });
});

// ── a start that fails is a wait, decided by the row ─────────────────────────────────
describe("a start that fails is classified by the row, never by the error", () => {
  it("a provider that refuses before anything began: the hand-off waits (kept, retried), whatever the error says", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "refused once", depth: 0 }, 2).id!;
    let refusals = 0;
    w.knobs.beforeStamp = () => { refusals++; throw Object.assign(new Error("this bot is already running three threads"), { status: 409 }); };
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(refusals).toBe(1);
    expect(rowOf(id)).toMatchObject({ phase: "busy" });
    expect(findDelegationReceipt(id)).toBeNull();
    // and with an error whose text means nothing to anyone: the same
    w.knobs.beforeStamp = () => { throw new Error("ECONNRESET"); };
    expect(releaseDelegationsWaitingOn(w.target.id)).toEqual([w.from.threadId]);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(rowOf(id)).toMatchObject({ phase: "busy" });
    expect(findDelegationReceipt(id)).toBeNull();
    // it runs once when the provider takes it
    w.knobs.beforeStamp = undefined;
    expect(releaseDelegationsWaitingOn(w.target.id)).toEqual([w.from.threadId]);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map((turn) => turn.id)).toEqual([id]);
  });
  it("the dispatch finds a second caller for the same hand-off taken, and a hand-off the queue no longer holds settled", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "once", depth: 0 }, 2).id!;
    const [first, second] = [dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }), dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus })];
    expect(await second).toBe("waiting");
    expect(await first).toBe("started");
    expect(w.turns).toHaveLength(1);
    expect(await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus })).toBe("settled");
    expect(await dispatchHandoff("nope", { bus: w.bus, approvalBus: w.approvalBus })).toBe("settled");
    expect(w.turns).toHaveLength(1);
  });
});
