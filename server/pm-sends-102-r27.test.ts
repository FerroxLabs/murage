// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 27 (the one fix round after DESIGN-r26 / the r26b review). Each finding is reproduced first, then closed:
//  1  the shared drain's walk persists, so a long run of waiting (or skipped) requests never keeps the rest of the queue from being reached
//  2  a repeated hand-off tool call is answered from the earlier request's own outcome, whatever state it is in (never started twice)
//  3  a finished hand-off's request ending and its row's removal are one transaction; a failure leaves both for the next pass
//  5  a hand-back is recognised by the hand-off's durable identity (a row of its id, or its receipt), not by how its key is spelled
//  6  the start guard checks the CURRENT row and its stored destination
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { DELEGATION_NOT_STARTABLE, _resetPending, handoffRow, onDelegationReceipt, recordDelegationReceipt, repeatedHandoffReply } from "./delegations.ts";
import { assertHandoffStartable, configureHandoffDispatch, dispatchHandoff, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { recordLeadWake } from "./project-turn-engine.ts";
import { completeRequest, findRoomAskDuplicate, insertRoomRequest, roomRequest } from "./room-requests.ts";
import { SHARED_DRAIN_DECISIONS, _resetDrainDiagnostics, _totalDrainDecisions, drainSharedWork } from "./shared-work.ts";
import { fakeHost, rememberRun, runOf, writePrompt } from "./testing/handoff-turn.ts";
import { LINEAGE, ownerWorld, sharedWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { queueDelegation } from "./delegations.ts";
import { MurageStatus, botName } from "./murage-status.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const rowOf = (id: string) => database().prepare("SELECT phase FROM pending_delegations WHERE id=?").get(id) as { phase: string } | undefined;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); });
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

function attach(w: OwnerWorld): void {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => { rememberRun(turn.delegationRun); writePrompt(w.bus, turn.delegationRun, turn.threadId, text); },
    noticeHeld: (notice) => { w.held.push({ id: notice.id, text: notice.text }); },
  }, { bus: w.bus, approvalBus: w.approvalBus });
}
const queued = (w: OwnerWorld, message = "do it once") => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message, depth: 0 }, 2).id!;
const receiptOf = (w: OwnerWorld, id: string, status: "done" | "failed" = "done") => ({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status });
/** What the server's listener does for a hand-off's request (index.ts onDelegationReceipt): ends it, inside the settling transaction. */
const endsRequest = () => onDelegationReceipt((receipt) => { completeRequest(database(), receipt.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now() }); });

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. the shared drain's walk persists: waiting and skipped requests never hold back the rest of the queue", () => {
  // r28: the drain no longer walks rows; it decides each ready team's HEAD once (shared-ready.ts), so the 6th team starts in the FIRST pass, after 6 decisions
  it("100 waiting hand-offs over 5 teams, then a runnable 6th team: the 6th starts in the first pass (only heads are decided)", async () => {
    const w = sharedWorld();
    const senders = [1, 2, 3, 4, 5, 6].map((n) => { const bot = w.store.createBot(); w.store.patchBot(bot.id, { name: `S${n}`, section: `Section${n}`, chiefOfStaff: true }); return bot; });
    const waitingThreads = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const request = w.handoff(`wait-${String(i).padStart(3, "0")}`, senders[i % 5]!);
      database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(10 + i, request.id);
      waitingThreads.add(request.targetThreadId!);
    }
    const tail = w.handoff("tail-runnable", senders[5]!);
    database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(10_000, tail.id);
    for (const thread of waitingThreads) w.knobs.busyThreads.add(thread);            // the first five teams' conversations are busy: their hand-offs wait
    drainSharedWork(w.iris.id);
    await until(() => w.turns.some((turn) => turn.id === "tail-runnable"));           // the first pass reached the 6th team's head
    expect(_totalDrainDecisions()).toBe(6);                                           // one decision per team: the 95 rows behind the five heads were never looked at
    for (let i = 0; i < 5; i++) await tick();
    expect(_totalDrainDecisions()).toBe(6);                                           // and the waiting teams are not looked at again until an event wakes them
    expect(SHARED_DRAIN_DECISIONS).toBe(100);
  }, 120_000);
  // r28: rows that are not shared work are never walked: each team's head is decided once, and the team then waits for its event
  it("rows the drain cannot start cost one decision per team, never one per row, and are not looked at again", async () => {
    const w = sharedWorld();
    const db = database();
    const COLUMNS = "id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,created_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key,execution_audience";
    const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?,?)`);
    // not shared work (no provenance): each is only looked at and moved past
    for (let i = 0; i < 250; i++) insert.run(`skip-${i}`, `skip-${i}`, "g", "ask", "bot", w.iris.id, `tt${i}`, "queued", 1_000 + i, "t", `key-${i}`, JSON.stringify({ kind: "team", team: `T${i % 3}` }));
    drainSharedWork(w.iris.id);
    expect(_totalDrainDecisions()).toBe(3);                                           // three teams, three heads
    for (let i = 0; i < 5; i++) await tick();
    expect(_totalDrainDecisions()).toBe(3);                                           // no continuation: nothing ready is left
  }, 120_000);
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────
describe("2. a repeated hand-off call is answered from the earlier request's outcome, whatever its state", () => {
  it("queue and start, finish, then repeat the same words under the same parent: the earlier (done) request is found and answered; nothing is queued", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    database().prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run("do it once", id);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(roomRequest(database(), id)!.state).toBe("running");
    const running = findRoomAskDuplicate(database(), "root", w.target.id, "do it once")!;
    expect(running.id).toBe(id);
    expect(repeatedHandoffReply(running, botName({ name: "Helper" }))).toMatchObject({ queued: true, taskId: id });
    expect(repeatedHandoffReply(running, botName({ name: "Helper" }))).not.toHaveProperty("done");
    endsRequest();
    recordDelegationReceipt(receiptOf(w, id));
    expect(rowOf(id)).toBeUndefined();                                                 // the pending row is gone: its existence says nothing about whether this ran
    const repeated = findRoomAskDuplicate(database(), "root", w.target.id, "do it once")!;
    expect(repeated.id).toBe(id);
    expect(repeated.state).toBe("done");
    const reply = repeatedHandoffReply(repeated, botName({ name: "Helper" }));
    expect(reply).toMatchObject({ queued: true, taskId: id, done: true, status: "done" });
    expect(MurageStatus.words(reply.message)).toMatch(/not sent again/);
    expect(database().prepare("SELECT COUNT(*) AS n FROM room_requests WHERE verb='ask'").get()).toEqual({ n: 1 });
  });
  it("the delegate endpoint and the busy fallback no longer condition the reuse on a pending row", () => {
    // the delegate endpoint moved to the hand-off boundary (evhand); its reply is the same, sent through the bot egress
    const index = readFileSync(join(serverDir, "index.ts"), "utf8");
    const boundary = readFileSync(join(serverDir, "handoff-boundary.ts"), "utf8");
    expect(boundary).toMatch(/if \(repeated\) \{\n\s*const again = repeatedHandoffReply\(repeated, botName\(target\)\);\n\s*return sendBot\(res, 200, botBody\(\{ queued: true, taskId: again\.taskId, message: again\.message, \.\.\.\(again\.done \? \{ done: true, status: again\.status \} : \{\}\) \}\)\);/);
    for (const source of [index, boundary]) {
      expect(source).not.toMatch(/repeated && handoffRow\(repeated\.id\)/);
      expect(source).not.toMatch(/twin && handoffRow\(twin\.id\)/);
    }
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────
describe("3. a finished hand-off settles all-or-nothing", () => {
  const fault = (on: boolean) => on
    ? database().exec("CREATE TRIGGER r27_fault BEFORE UPDATE ON room_requests WHEN NEW.state IN ('done','failed') BEGIN SELECT RAISE(ABORT, 'injected fault'); END;")
    : database().exec("DROP TRIGGER IF EXISTS r27_fault");
  it("the request's terminal write fails: the row is NOT deleted, the request is untouched, and the next pass settles both", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    endsRequest();
    fault(true);
    const quiet = console.error; console.error = () => {};
    try { recordDelegationReceipt(receiptOf(w, id)); } finally { console.error = quiet; }
    expect(rowOf(id)?.phase).toBe("started");                                          // the partner stays: the retry obligation is the row itself
    expect(roomRequest(database(), id)!.state).toBe("running");
    fault(false);
    await expect(Promise.resolve(dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }))).resolves.toBe("settled");
    expect(rowOf(id)).toBeUndefined();
    expect(roomRequest(database(), id)!.state).toBe("done");
  });
  it("with no fault both happen in the one call, and the follow-up the listener returns runs after the commit", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const seen: string[] = [];
    onDelegationReceipt((receipt) => { completeRequest(database(), receipt.id, { state: "done", now: Date.now() }); return () => { seen.push(`after:${rowOf(receipt.id) === undefined}:${roomRequest(database(), receipt.id)!.state}`); }; });
    recordDelegationReceipt(receiptOf(w, id));
    expect(seen).toEqual(["after:true:done"]);
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
// (the Box placeholder: server/drivers/boxagent.test.ts)

// ── 5 ─────────────────────────────────────────────────────────────────────────────────
describe("5. the hand-back loop is recognised by the hand-off's durable identity, not by its key's spelling", () => {
  const names: Record<string, string> = { nova: "Nova", wren: "Wren" };
  const PAUSE = "Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.";
  function world(): { backId: string; db: DatabaseSync } {
    const db = database(); initializeProjectTables(db);
    db.prepare("INSERT INTO project_settings (group_id,mode,lead_bot_id,parts,parallel_cards,work_roots,work_profile,run_state,updated_at) VALUES ('g','conversation','lead','{}',3,'[]','ask','running',1)").run();
    db.prepare("INSERT INTO project_goals (id,group_id,title,criteria,state,created_at) VALUES ('goal','g','Ship','[]','working',1)").run();
    const root = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root", lineage: LINEAGE("t"), now: 1 }).request.id;
    const hop = (verb: "ask" | "assign", from: string, to: string, parentId: string, key: string, now: number) =>
      insertRoomRequest(db, { groupId: "g", verb, fromKind: "bot", fromBotId: from, toBotId: to, parentId, projectGoalId: "goal", admissionKey: key, now, payloadText: "Write the pricing FAQ" }).request;
    const first = hop("assign", "nova", "wren", root, "h1", 200);
    const back = hop("ask", "wren", "nova", first.id, "an-imported-plain-key", 210);                  // a plain key, not ask:delegation:<id>
    return { backId: back.id, db };
  }
  const pause = (db: DatabaseSync) => recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: (id) => names[id] ?? id }).pause;
  it("a plain-key return hand-off with its pending row of the same id is a hand-back: pause", () => {
    const { backId, db } = world();
    expect(pause(db)).toBeUndefined();                                                  // (a plain question with no hand-off identity is still just a question)
    db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(backId, "t", "nova", "wren", "fresh", null, JSON.stringify({ message: "x", depth: 0, attempts: 0 }), "room", `dlg-${backId}`, "tt");
    expect(pause(db)).toBe(PAUSE);
  });
  it("and so is one that has finished: its row is gone, its receipt is the identity that survives", () => {
    const { backId, db } = world();
    expect(pause(db)).toBeUndefined();
    recordDelegationReceipt({ id: backId, sourceThreadId: "t", toBotId: "nova", toBotName: "Nova", status: "done" });
    expect(db.prepare("SELECT 1 AS x FROM pending_delegations WHERE id=?").get(backId)).toBeUndefined();
    expect(pause(db)).toBe(PAUSE);
  });
});

// ── 6 ─────────────────────────────────────────────────────────────────────────────────
describe("6. the start guard checks the current row and its stored destination", () => {
  it("a destination other than the stored one is refused, for a started ticket re-run with its own prompt", async () => {
    const w = ownerWorld("owner");
    attach(w);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const run = runOf(id);
    const stored = handoffRow(id)!.target_thread_id!;
    expect(() => assertHandoffStartable({ delegationRun: run, threadId: stored, userMessage: { id: run.turnKey } })).not.toThrow();
    for (const elsewhere of ["another-existing-task", w.from.threadId, undefined]) {
      expect(() => assertHandoffStartable({ delegationRun: run, threadId: elsewhere, userMessage: { id: run.turnKey } }), String(elsewhere)).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    }
  });
  it("a completed or removed ticket is refused: the guard looks at the row that exists now", async () => {
    const w = ownerWorld("owner");
    attach(w);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const run = runOf(id);
    const stored = handoffRow(id)!.target_thread_id!;
    recordDelegationReceipt(receiptOf(w, id));
    expect(rowOf(id)).toBeUndefined();
    expect(() => assertHandoffStartable({ delegationRun: run, threadId: stored, userMessage: { id: run.turnKey } })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
  });
});
