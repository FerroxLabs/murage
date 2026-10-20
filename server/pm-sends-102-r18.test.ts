// Astra r17 (P1 + 3 x P2), resolved by the r18 design (DESIGN-r18.md):
//  - shared work is classified by the provenance written when it was created, never by the live registry (a): ordinary channel turns owe nothing;
//  - an unresolved item is parked (inactive, persisted retry time with backoff) and settled only by a delivery, a tombstone or the owner (b);
//  - the queue questions Q1-Q4 are served by named partial indexes, so a sweep costs the same at 1k and 100k terminal rows (c);
//  - `deadline_at` is the only upper lifetime, and a backlog of overdue parked rows clears a batch per tick (d);
//  - asks follow the same retention as wakes (e); the older release's data is reclassified once (f); new objects pass snapshot inspection (g).
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { InstallationSnapshotError } from "./installation-snapshot-error.ts";
import { botDeletionKey, recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { fenceRestoredSql } from "./restore-fence.ts";
import { BACKFILL_NAME, CLASSIFY_NAME, OWED_HELD_RECHECK_MS, OWED_SETTLE_BATCH, dismissOwedSharedResult, initializeRoomRequestOwed, reclassifyOwedV1, settleOwedSharedResults, wakeOwedSharedResults } from "./room-request-owed.ts";
import { createRoomDispatcher, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import {
  clearRetainedRoomRequest, completeRequest, deferRetainedRoomRequest, dueRetainedRoomRequests, markRequestDispatched, pruneTerminalRoomRequests, queuedRoomRequests, recordRoomRequestRefusal,
  roomRequest, RETAINED_SWEEP_BATCH, RETAINED_UNRESOLVED, wakeRetainedRoomRequests,
} from "./room-requests.ts";
import { configureSharedDrain, drainSharedWork, sharedByProvenance, sharedDispatchOrder, sharedResolution } from "./shared-work.ts";
import { requestSourceThread } from "./execution-audience.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const N = (n: number): number => Math.max(1, Math.round(n * Number(process.env.MEASURE_SCALE ?? 1)));

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setExecutionStore(undefined as never); });
afterEach(() => closeDatabase());

const DAY = 86_400_000;
const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,created_at,deadline_at,finished_at,root_thread_id,return_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
type Row = { id: string; verb?: string; state?: string; to?: string | null; target?: string | null; parent?: string | null; at?: number; deadline?: number | null; finished?: number | null;
  rootThread?: string; returnThread?: string | null; refusal?: string | null; payload?: string | null; shared?: boolean };
/** Raw rows: the fixtures here are thousands of rows, so they skip the insert helper's lineage work. */
function inserter(db: DatabaseSync) {
  const stmt = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
  const provenance = db.prepare("INSERT OR REPLACE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  return (o: Row) => {
    if (o.shared) provenance.run(o.id);   // what enqueueSharedWork writes in the same savepoint as the request
    const verb = o.verb ?? "ask", state = o.state ?? "queued";
    stmt.run(o.id, o.id, o.parent ?? null, "g", verb, verb === "owner_send" ? "owner" : "bot", o.to ?? "b0", o.target ?? "tt0", state, o.payload ?? null, o.refusal ?? null, o.at ?? 1,
      o.deadline ?? null, o.finished ?? (state === "queued" || state === "running" ? null : o.at ?? 1), o.rootThread ?? "t", o.returnThread ?? null, `key-${o.id}`);
  };
}
const fill = (db: DatabaseSync, n: number, each: (i: number) => void) => { db.exec("BEGIN"); try { for (let i = 0; i < n; i++) each(i); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } };
const owedRows = (db: DatabaseSync) => db.prepare("SELECT request_id AS id, shared, destination_thread_id AS destination, attempts, retry_at AS retryAt FROM room_request_owed WHERE kind='shared_delivery' ORDER BY request_id").all() as Array<{ id: string; shared: number | null; destination: string | null; attempts: number; retryAt: number }>;
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

type Rec = { sql: string; args: unknown[]; rows: number };
/** Every statement the code under test runs, with its arguments, and how many rows it handed back. */
function record(db: DatabaseSync, run: () => void): { issued: Rec[]; rows: number; requests: number } {
  const issued: Rec[] = [];
  const out = { rows: 0 };
  const original = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql);
    const wrap = <K extends "all" | "get" | "run">(key: K) => {
      const fn = (statement[key] as (...a: unknown[]) => unknown).bind(statement);
      (statement as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
        const result = fn(...args);
        const rows = key === "all" ? (result as unknown[]).length : key === "get" && result ? 1 : 0;
        issued.push({ sql, args, rows });
        out.rows += rows;
        return result;
      };
    };
    wrap("all"); wrap("get"); wrap("run");
    return statement;
  };
  try { run(); } finally { delete (db as { prepare?: unknown }).prepare; }
  // the request rows a pass materialized: whole `room_requests` rows (the id lists and counters are not requests)
  const requests = issued.filter(item => /^\s*SELECT \* FROM room_requests\b/.test(item.sql)).reduce((sum, item) => sum + item.rows, 0);
  return { issued, rows: out.rows, requests };
}
const planOf = (db: DatabaseSync, sql: string, args: unknown[] = []) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map(row => row.detail);
const programOf = (db: DatabaseSync, sql: string, args: unknown[] = []) => (db.prepare(`EXPLAIN ${sql}`).all(...(args as never[])) as Array<{ opcode: string }>).map(row => row.opcode).join(",");
/** A scan that walks the table itself. "SCAN t USING INDEX i" walks a partial index, which holds only the queued rows: that is the index, not the history. */
const scansTable = (plan: string[], ...names: string[]) => plan.some(line => names.some(name => new RegExp(`^SCAN ${name}( AS \\w+)?( (?!USING)|$)`).test(line) && !/ USING /.test(line)));

function harness(clock: { t: number }, over: Partial<RoomDispatcherDeps> = {}) {
  const db = database();
  initializeProjectTables(db);
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false,
    directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false,
    reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => clock.t });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const closed: string[] = [], words: Array<{ id: string; inTransaction: boolean }> = [];
  const deps: RoomDispatcherDeps = { db: () => db, admission, now: () => clock.t, open: () => true, roomUsable: () => false, roomBusy: () => false, projectContext: () => undefined,
    memberIds: () => [], audienceStillValid: () => true, ownerOrigin: () => true, startOwnerSend: () => {}, startMemberTurn: () => {}, onClosed: (r, l) => { closed.push(`${r.id}:${l}`); },
    keepOwnerWords: request => { words.push({ id: request.id, inTransaction: db.isTransaction }); }, onStillWaiting: () => {}, changed: () => {}, ...over };
  const sharedClosed: string[] = [];
  configureSharedDrain({ admission, open: () => true, start: () => {}, closed: (row, line) => { sharedClosed.push(`${row.id}:${line}`); }, changed: () => {}, now: () => clock.t });
  return { db, admission, closed, words, sharedClosed, dispatcher: createRoomDispatcher(deps) };
}

describe("(a) classification is by provenance recorded at creation: ordinary channel work owes nothing", () => {
  it("10k finished channel turns and bot asks without provenance: zero owed rows, none held by a restore, all pruned at day 31; a provenance ask owes exactly one", () => {
    const db = database(), insert = inserter(db);
    const finished = 1_000;
    fill(db, 10_000, i => insert(i % 2 ? { id: `turn-${i}`, verb: "room_turn", state: i % 4 === 1 ? "done" : "failed", at: finished, target: "t-room" } : { id: `ask-${i}`, verb: "ask", state: "done", at: finished }));
    insert({ id: "shared-ask", verb: "ask", state: "done", at: finished, shared: true, returnThread: "requester-thread" });
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_owed WHERE kind='shared_delivery'")).toBe(1);
    expect(owedRows(db)).toMatchObject([{ id: "shared-ask", shared: 1, destination: "requester-thread" }]);
    expect(fenceRestoredSql(db, "gen-1").some(note => /finished shared result/.test(note.action))).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM restore_holds WHERE kind='shared_result'")).toBe(1);   // the shared one only, never a channel turn
    db.prepare("DELETE FROM restore_holds").run();
    expect(pruneTerminalRoomRequests(db, finished + 31 * DAY)).toBe(10_000);                           // every channel row ages out; the owed result stays
    expect(roomRequest(db, "shared-ask")).toBeTruthy();
  });
  it("the same holds through the one-time backfill and reclassification of an older release's broad rows", () => {
    const db = database(), insert = inserter(db);
    fill(db, 3_000, i => insert({ id: `turn-${i}`, verb: i % 2 ? "room_turn" : "ask", state: "done", target: "t-room" }));
    insert({ id: "shared-ask", verb: "ask", state: "done", shared: true, target: "tt0", returnThread: "requester" });
    // the database an earlier build left: broad owed rows (every channel turn), no classify trigger, v1 marker complete, no reclassification
    db.exec("DROP TRIGGER room_request_owed_classify");
    db.exec("DELETE FROM room_request_owed");
    db.exec("INSERT INTO room_request_owed(kind, request_id) SELECT 'shared_delivery', id FROM room_requests");
    db.exec(`DELETE FROM room_request_backfills WHERE name='${CLASSIFY_NAME}'`);
    db.prepare("INSERT OR REPLACE INTO room_request_backfills(name,cursor,completed) VALUES(?,0,1)").run(BACKFILL_NAME);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_owed")).toBe(3_001);
    initializeRoomRequestOwed(db);
    expect(owedRows(db)).toMatchObject([{ id: "shared-ask", shared: 1, destination: "requester" }]);
    expect(db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(CLASSIFY_NAME)).toEqual({ completed: 1 });
    expect(reclassifyOwedV1(db)).toBe(0);                                                                // never runs again
  });
  it("the backfill from nothing classifies as it seeds (a database with no owed set at all)", () => {
    const db = database(), insert = inserter(db);
    fill(db, 500, i => insert({ id: `c-${i}`, verb: "ask", state: "done" }));
    insert({ id: "s", verb: "ask", state: "done", shared: true });
    db.exec("DELETE FROM room_request_owed; DELETE FROM room_request_backfills");
    initializeRoomRequestOwed(db);
    expect(owedRows(db).map(row => row.id)).toEqual(["s"]);
  });
  it("sharedByProvenance: an ask or message with a provenance row, or a wake whose parent has one; nothing else", () => {
    const db = database(), insert = inserter(db);
    insert({ id: "p", verb: "ask", shared: true });
    insert({ id: "m", verb: "message", shared: true });
    insert({ id: "w", verb: "wake", parent: "p" });
    insert({ id: "w2", verb: "wake", parent: "plain" });
    insert({ id: "plain", verb: "ask" });
    insert({ id: "turn", verb: "room_turn" });
    insert({ id: "owner", verb: "owner_send" });
    insert({ id: "routine", verb: "routine" });
    const is = (id: string) => sharedByProvenance(db, roomRequest(db, id)!);
    expect([is("p"), is("m"), is("w"), is("w2"), is("plain"), is("turn"), is("owner"), is("routine")]).toEqual([true, true, true, false, false, false, false, false]);
  });
  it("the stamped destination is the SQL twin of requestSourceThread (parent's thread, return thread, root thread)", () => {
    const db = database(), insert = inserter(db);
    insert({ id: "parent", verb: "assign", state: "running", target: "parent-thread" });
    insert({ id: "a", verb: "ask", state: "done", shared: true, parent: "parent", returnThread: "ret" });
    insert({ id: "b", verb: "ask", state: "done", shared: true, returnThread: "ret-b" });
    insert({ id: "c", verb: "ask", state: "done", shared: true, rootThread: "root-c" });
    for (const row of owedRows(db)) expect(row.destination, row.id).toBe(requestSourceThread(row.id, db));
    expect(owedRows(db).map(row => row.destination)).toEqual(["parent-thread", "ret-b", "root-c"]);
  });
});

describe("(b) unresolved work is parked, never settled; only a delivery, a tombstone or the owner settles it", () => {
  const deps = (db: DatabaseSync, state: { live: boolean; deleted: boolean; now: number; delivered: string[] }) => ({
    held: () => false, load: (id: string) => roomRequest(db, id) ?? undefined, destination: (r: { id: string }) => requestSourceThread(r.id, db),
    live: () => state.live, deleted: () => state.deleted, delivered: () => false, now: () => state.now,
    deliver: (r: { id: string }) => { state.delivered.push(r.id); db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=? AND state IN ('done','failed')").run(r.id); },
  });
  it("with an empty registry a provenance ask is never settled; it is delivered once the registry loads", () => {
    const db = database(), insert = inserter(db);
    insert({ id: "s", verb: "ask", state: "done", shared: true });
    const state = { live: false, deleted: false, now: 1_000_000, delivered: [] as string[] };
    for (let i = 0; i < 5; i++) { settleOwedSharedResults(db, deps(db, state)); state.now += 2 * 3_600_000; }
    expect(owedRows(db)).toMatchObject([{ id: "s", shared: 1, attempts: 5 }]);
    expect(state.delivered).toEqual([]);
    state.live = true;
    settleOwedSharedResults(db, deps(db, state));
    expect(state.delivered).toEqual(["s"]);
    expect(owedRows(db)).toEqual([]);
  });
  it("a recorded tombstone of the requester's thread settles it at once (the owed row is made due by the deletion)", () => {
    const db = database(), insert = inserter(db);
    insert({ id: "s", verb: "ask", state: "done", shared: true, returnThread: "gone-thread" });
    const state = { live: false, deleted: false, now: 1_000_000, delivered: [] as string[] };
    settleOwedSharedResults(db, deps(db, state));
    expect(owedRows(db)[0]!.retryAt).toBeGreaterThan(state.now);
    recordOwnerDeletion(db, "gone-thread");
    expect(owedRows(db)[0]!.retryAt).toBe(0);
    state.deleted = true;
    settleOwedSharedResults(db, deps(db, state));
    expect(owedRows(db)).toEqual([]);
    expect(state.delivered).toEqual([]);
  });
  it("the owner's dismissal removes the row, stamps it delivered so nothing records it again, and writes the receipt", () => {
    const db = database(), insert = inserter(db);
    insert({ id: "s", verb: "ask", state: "done", shared: true });
    const receipts: string[] = [];
    expect(dismissOwedSharedResult(db, "s", { load: id => roomRequest(db, id) ?? undefined, receipt: r => { receipts.push(r.id); return true; } })).toBe(true);
    expect(receipts).toEqual(["s"]);
    expect(owedRows(db)).toEqual([]);
    expect(roomRequest(db, "s")!.refusal).toBe("delivered");
    db.prepare("UPDATE room_requests SET outcome_note='again' WHERE id='s'").run();
    db.prepare("UPDATE room_requests SET state='failed' WHERE id='s'").run();
    expect(owedRows(db)).toEqual([]);
    expect(dismissOwedSharedResult(db, "s", { load: id => roomRequest(db, id) ?? undefined, receipt: () => { throw new Error("nothing is owed"); } })).toBe(false);
  });
  it("a held row is pushed an hour out instead of being skipped, and its release makes it due", () => {
    const db = database(), insert = inserter(db);
    for (let i = 0; i < 300; i++) insert({ id: `h-${i}`, verb: "ask", state: "done", shared: true });
    insert({ id: "z-free", verb: "ask", state: "done", shared: true });
    const state = { live: true, deleted: false, now: 1_000_000, delivered: [] as string[] };
    const base = deps(db, state);
    const held = new Set(Array.from({ length: 300 }, (_, i) => `h-${i}`));
    for (let i = 0; i < 4; i++) settleOwedSharedResults(db, { ...base, held: id => held.has(id) });   // 4 passes: held rows never starve the free one
    expect(state.delivered).toEqual(["z-free"]);
    expect(owedRows(db).find(row => row.id === "h-0")!.retryAt).toBe(state.now + OWED_HELD_RECHECK_MS);
    expect(wakeOwedSharedResults(db, { requestId: "h-0" })).toBe(1);
    expect(owedRows(db).find(row => row.id === "h-0")!.retryAt).toBe(0);
    expect(OWED_SETTLE_BATCH).toBe(100);
  });
  it("a shared ask with the registry empty is parked inactive by the sweep, runnable again when the bot is listed, cancelled with a receipt by a tombstone", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher, sharedClosed } = harness(clock);
    const insert = inserter(db);
    insert({ id: "a", verb: "ask", state: "queued", shared: true, to: "bot-x", target: "task-x", deadline: clock.t + DAY });
    dispatcher.pump();
    expect(roomRequest(db, "a")).toMatchObject({ state: "queued", refusal: RETAINED_UNRESOLVED });
    expect(queuedRoomRequests(db)).toEqual([]);                                  // parked rows are outside the runnable set
    expect(db.prepare("SELECT attempts FROM room_request_retry WHERE request_id='a'").get()).toEqual({ attempts: 1 });
    recordOwnerDeletion(db, botDeletionKey("bot-x"));
    dispatcher.pump();
    expect(roomRequest(db, "a")!.state).toBe("cancelled");
    expect(sharedClosed.join("|")).toContain("a:");
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id='a'").get()).toBeUndefined();
  });
  it("resolution: resolved when the bot lists the task, tombstoned only with a recorded deletion, otherwise unresolved", () => {
    const db = database();
    const row = { toBotId: "b", targetThreadId: "tt", groupId: "g" };
    const store = (tasks: Array<{ threadId: string }>) => ({ bot: () => ({ tasks }) }) as never;
    expect(sharedResolution(row, store([{ threadId: "tt" }]), db)).toBe("resolved");
    expect(sharedResolution(row, store([]), db)).toBe("unresolved");
    expect(sharedResolution(row, undefined, db)).toBe("unresolved");
    recordOwnerDeletion(db, botDeletionKey("b"));
    expect(sharedResolution(row, store([]), db)).toBe("tombstoned");
  });
});

describe("the parked marker and the retry time are one mechanism", () => {
  it("parking sets the marker with the retry row; no refusal can overwrite it; clearing or dispatching takes it off; boot keeps the attempts", () => {
    const clock = { t: 1_000_000 };
    const { db } = harness(clock);
    const insert = inserter(db);
    insert({ id: "a", verb: "ask", shared: true });
    deferRetainedRoomRequest(db, "a", clock.t);
    expect(roomRequest(db, "a")!.refusal).toBe(RETAINED_UNRESOLVED);
    recordRoomRequestRefusal(db, "a", "thread_running");
    expect(roomRequest(db, "a")!.refusal).toBe(RETAINED_UNRESOLVED);
    deferRetainedRoomRequest(db, "a", clock.t);
    deferRetainedRoomRequest(db, "a", clock.t);
    expect(db.prepare("SELECT attempts FROM room_request_retry WHERE request_id='a'").get()).toEqual({ attempts: 3 });
    expect(wakeRetainedRoomRequests(db, clock.t)).toBe(1);
    expect(db.prepare("SELECT retry_at AS at, attempts FROM room_request_retry WHERE request_id='a'").get()).toEqual({ at: clock.t, attempts: 3 });
    expect(clearRetainedRoomRequest(db, "a")).toBe(true);
    expect(roomRequest(db, "a")!.refusal).toBeNull();
    deferRetainedRoomRequest(db, "a", clock.t);
    expect(markRequestDispatched(db, "a", { now: clock.t })).toBe(true);
    expect(roomRequest(db, "a")!.refusal).toBeNull();
    deferRetainedRoomRequest(db, "a", clock.t);                                   // a running row is not parked
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id='a'").get()).toBeUndefined();
    insert({ id: "b", verb: "ask", shared: true });
    deferRetainedRoomRequest(db, "b", clock.t);
    completeRequest(db, "b", { state: "cancelled", now: clock.t });
    expect(roomRequest(db, "b")!.refusal).toBeNull();                            // a terminal row does not carry the marker
  });
  it("a retry row left by an earlier build (no marker) is dropped and the request is runnable", () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    const insert = inserter(db);
    insert({ id: "w", verb: "room_turn", state: "queued", to: "bot-x", target: "tt-x", payload: "hi" });
    db.prepare("INSERT INTO room_request_retry(request_id, retry_at, attempts) VALUES('w', 0, 4)").run();
    dispatcher.pump();
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id='w'").get()).toBeUndefined();
    expect(roomRequest(db, "w")!.state).toBe("cancelled");                        // a channel turn in a room that is gone is not shared work
  });
  it("sharedDispatchOrder asks for each team's history only when the runnable rows span more than one team", () => {
    const db = database();
    const { sharedClosed } = harness({ t: 1 });
    void sharedClosed;
    const insert = inserter(db);
    const store = (threads: string[]) => ({ bot: () => ({ id: "b0", tasks: threads.map(threadId => ({ threadId, sharedWork: {} })) }) }) as never;
    setExecutionStore(store(["tt0"]));
    const withTag = (id: string, team: string) => { insert({ id, verb: "ask", shared: true, at: Number(id.slice(1)) }); db.prepare("UPDATE room_requests SET execution_audience=? WHERE id=?").run(JSON.stringify({ v: 1, human: "owner", rootRequestId: id, kind: "team", team }), id); };
    withTag("x1", "A"); withTag("x2", "A");
    const one = record(db, () => { expect(sharedDispatchOrder("b0").map(r => r.id)).toEqual(["x1", "x2"]); });
    expect(one.issued.some(item => /MAX\(dispatched_at\)/.test(item.sql))).toBe(false);
    withTag("x3", "B");
    const two = record(db, () => { sharedDispatchOrder("b0"); });
    expect(two.issued.filter(item => /MAX\(dispatched_at\)/.test(item.sql))).toHaveLength(2);
  });
});

describe("(c) the queue questions are served by named indexes: flat from 1k to 100k terminal rows, with 0 or 10k parked", () => {
  const Q = {
    Q1: "SELECT id FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' ORDER BY created_at, id",
    Q1_BOT: "SELECT id FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? ORDER BY created_at, id",
    Q2: "SELECT request_id, attempts FROM room_request_retry WHERE retry_at<=? ORDER BY retry_at, request_id LIMIT ?",
    Q3: "SELECT id FROM room_requests WHERE state='queued' AND deadline_at IS NOT NULL AND deadline_at<? ORDER BY deadline_at, id LIMIT ?",
    Q4: "SELECT request_id, destination_thread_id, attempts FROM room_request_owed WHERE kind='shared_delivery' AND retry_at<=? ORDER BY retry_at, request_id LIMIT ?",
  };
  type Run = { plans: Record<string, string[]>; programs: Record<string, string>; passPlans: string[]; phases: Record<string, number>; rows: number; runnable: number; parked: number };
  function scenario(history: number, parked: number): Run {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const clock = { t: 10 * DAY };
    const { db, dispatcher } = harness(clock, { roomUsable: () => true, roomBusy: () => true });
    const insert = inserter(db);
    fill(db, history, i => insert({ id: `h-${i}`, verb: i % 2 ? "room_turn" : "ask", state: i % 3 ? "done" : "cancelled", to: `b${i % 10}`, at: 1_000 + i, deadline: i % 5 === 0 ? 5_000 + i : null }));
    fill(db, 20, i => insert({ id: `run-${i}`, verb: "owner_send", state: "queued", to: null, target: `rt-${i}`, payload: "words", at: 9 * DAY + i }));
    fill(db, parked, i => insert({ id: `p-${i}`, verb: "ask", state: "queued", shared: true, to: `b${i % 10}`, target: `x${i}`, at: 8 * DAY + i, deadline: clock.t + DAY }));
    dispatcher.pump();                                                         // parks every unresolved shared ask
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_retry")).toBe(parked);
    const runnable = queuedRoomRequests(db).length;
    const plans: Record<string, string[]> = {}, programs: Record<string, string> = {};
    const args: Record<string, unknown[]> = { Q1: [], Q1_BOT: ["b3"], Q2: [clock.t, RETAINED_SWEEP_BATCH], Q3: [clock.t, RETAINED_SWEEP_BATCH], Q4: [clock.t, OWED_SETTLE_BATCH] };
    for (const [name, sql] of Object.entries(Q)) { plans[name] = planOf(db, sql, args[name]); programs[name] = programOf(db, sql, args[name]); }
    const sweep = () => settleOwedSharedResults(db, { held: () => false, load: () => undefined, destination: () => undefined, live: () => false, deleted: () => false, delivered: () => false, deliver: () => {}, now: () => clock.t });
    const phases: Record<string, ReturnType<typeof record>> = {
      once: record(db, () => dispatcher.pump()), tick: record(db, () => dispatcher.tick()), settle: record(db, sweep),
      drain: record(db, () => { for (let i = 0; i < 10; i++) drainSharedWork(`b${i}`); }),
    };
    const passPlans = [...new Set(Object.values(phases).flatMap(pass => pass.issued).filter(item => /^\s*SELECT/i.test(item.sql) && /room_requests\b/.test(item.sql)).map(item => planOf(db, item.sql, item.args).join(" | ")))].sort();
    return { plans, programs, passPlans, phases: Object.fromEntries(Object.entries(phases).map(([name, pass]) => [name, pass.requests])), rows: Object.values(phases).reduce((sum, pass) => sum + pass.rows, 0), runnable, parked };
  }
  const results: Array<{ history: number; parked: number; run: Run }> = [];
  for (const history of [1_000, 100_000]) {
    for (const parked of [0, 10_000]) {
      it(`${history} terminal rows, ${parked} parked, 10 bots: Q1 to Q4 use their indexes and a full pass reads at most runnable + 100 rows`, { tags: ["nightly"], timeout: 3_600_000 }, () => {
        const run = scenario(history, parked);
        results.push({ history, parked, run });
        expect(run.plans.Q1!.join(" | ")).toMatch(/USING (COVERING )?INDEX room_requests_runnable/);
        expect(run.plans.Q2!.join(" | ")).toMatch(/USING (COVERING )?INDEX room_request_retry_due/);
        expect(run.plans.Q3!.join(" | ")).toMatch(/USING (COVERING )?INDEX room_requests_queued_deadline/);
        expect(run.plans.Q4!.join(" | ")).toMatch(/USING (COVERING )?INDEX room_request_owed_due/);
        expect(run.plans.Q1_BOT!.join(" | ")).toMatch(/USING (COVERING )?INDEX room_requests_(runnable|to_bot)/);
        for (const [name, plan] of Object.entries(run.plans)) expect(scansTable(plan, "room_requests", "r"), `${name}: ${plan.join(" | ")}`).toBe(false);
        for (const plan of run.passPlans) expect(scansTable(plan.split(" | "), "room_requests", "r"), plan).toBe(false);
        for (const [phase, requests] of Object.entries(run.phases)) expect(requests, phase).toBeLessThanOrEqual(run.runnable + RETAINED_SWEEP_BATCH);
        expect(run.runnable).toBe(20);
      });
    }
  }
  // Reads what the four sized runs above recorded, so it runs where they run.
  it("the plans, the compiled programs and the rows materialized per pass are the same at every history size and parked count", { tags: ["nightly"] }, () => {
    expect(results).toHaveLength(4);
    const first = results[0]!.run;
    for (const { run } of results) {
      expect(run.plans).toEqual(first.plans);
      expect(run.programs).toEqual(first.programs);
      for (const [phase, requests] of Object.entries(run.phases)) expect(requests, phase).toBeLessThanOrEqual(run.runnable + RETAINED_SWEEP_BATCH);
    }
    const byHistory = (history: number, parked: number) => results.find(r => r.history === history && r.parked === parked)!.run;
    for (const parked of [0, 10_000]) {
      expect(byHistory(100_000, parked).phases).toEqual(byHistory(1_000, parked).phases);
      expect(byHistory(100_000, parked).rows).toBe(byHistory(1_000, parked).rows);
    }
  });
});

describe("(d) deadline_at is the only upper lifetime: an overdue parked backlog clears a batch per tick, then costs nothing", () => {
  it("10k overdue parked shared asks clear within ceil(10k/100) ticks, each with a receipt line, then a tick reads nothing", { tags: ["nightly"], timeout: 3_600_000 }, () => {
    const clock = { t: 5 * DAY };
    const { db, dispatcher, sharedClosed } = harness(clock);
    const insert = inserter(db);
    fill(db, 10_000, i => insert({ id: `p-${i}`, verb: "ask", state: "queued", shared: true, to: `b${i % 10}`, target: `x${i}`, at: 1_000 + i, deadline: 1_000 + DAY }));
    dispatcher.pump();
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_retry")).toBe(10_000);
    clock.t = 3 * DAY;                                                         // past every deadline, inside every backoff
    let ticks = 0;
    while (count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE state='queued'") > 0 && ticks < 200) { dispatcher.tick(); ticks++; }
    expect(ticks).toBe(Math.ceil(10_000 / RETAINED_SWEEP_BATCH));
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE state='expired'")).toBe(10_000);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_retry")).toBe(0);
    expect(sharedClosed).toHaveLength(10_000);
    expect(record(db, () => dispatcher.tick()).rows).toBe(0);
  });
  it("an owner send that expires keeps its words as a chip inside the same transaction as the closure", () => {
    const clock = { t: 5 * DAY };
    const { db, dispatcher, words, closed } = harness(clock, { roomUsable: () => true, roomBusy: () => true });
    const insert = inserter(db);
    insert({ id: "send", verb: "owner_send", state: "queued", to: null, payload: "my words", deadline: 1_000 });
    dispatcher.tick();
    expect(roomRequest(db, "send")!.state).toBe("expired");
    expect(words).toEqual([{ id: "send", inTransaction: true }]);
    expect(closed).toEqual(["send:Not answered in time. Ask again."]);
  });
});

describe("(e) shared asks follow the same retention as wakes", () => {
  it("40k unresolved shared asks are parked, and are not read again inside their backoff window", { tags: ["nightly"], timeout: 3_600_000 }, () => {
    const clock = { t: 1_000_000 };
    const { db, dispatcher } = harness(clock);
    const insert = inserter(db);
    fill(db, N(40_000), i => insert({ id: `a-${i}`, verb: i % 4 ? "ask" : "message", state: "queued", shared: true, to: `b${i % 10}`, target: `x${i}`, at: 1 + i, deadline: clock.t + DAY }));
    dispatcher.pump();
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_retry")).toBe(N(40_000));
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests WHERE refusal='retained_unresolved'")).toBe(N(40_000));
    clock.t += 20_000;                                                          // inside the first 30 s
    const pass = record(db, () => { dispatcher.pump(); dispatcher.tick(); for (let i = 0; i < 10; i++) drainSharedWork(`b${i}`); });
    expect(pass.rows).toBe(0);
    expect(pass.requests).toBe(0);
    clock.t += 20_000;                                                          // the wait is over: a bounded batch, longer wait afterwards
    const due = record(db, () => dispatcher.pump());
    expect(due.requests).toBeLessThanOrEqual(RETAINED_SWEEP_BATCH);
    expect(db.prepare("SELECT attempts FROM room_request_retry WHERE request_id='a-0'").get()).toEqual({ attempts: 2 });
  });
});

describe("(g) the new objects are accepted by snapshot inspection, and an older archive still passes", () => {
  it("a current database, an older archive without the new objects, and a tampered classify trigger", () => {
    const db = database();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    for (const name of ["room_request_owed_classify"]) db.exec(`DROP TRIGGER ${name}`);
    for (const name of ["room_requests_runnable", "room_requests_queued_deadline", "room_request_owed_due"]) db.exec(`DROP INDEX ${name}`);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();                // an archive from before this release
    initializeProjectTables(db);
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='room_request_owed_classify'").get()).toBeTruthy();
    db.exec("DROP TRIGGER room_request_owed_classify");
    db.exec("CREATE TRIGGER room_request_owed_classify AFTER INSERT ON room_request_owed BEGIN DELETE FROM messages; END");
    expect(() => inspectInstallationDatabase(db)).toThrow(InstallationSnapshotError);
    db.exec("DROP TRIGGER room_request_owed_classify");
    db.exec("DROP INDEX room_requests_runnable; CREATE INDEX room_requests_runnable ON room_requests(created_at)");
    expect(() => inspectInstallationDatabase(db)).toThrow(InstallationSnapshotError);
  });
  it("the initializer is idempotent and a restart finds the markers complete", () => {
    const db = database();
    initializeProjectTables(db); initializeProjectTables(db);
    for (const name of [BACKFILL_NAME, CLASSIFY_NAME]) expect(db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(name)).toEqual({ completed: 1 });
    expect(dueRetainedRoomRequests(db, Date.now())).toEqual([]);
  });
});
