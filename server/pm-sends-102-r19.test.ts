// Astra r18 review (7 findings), resolved within the r18 model (DESIGN-r18.md): provenance classification, one retention mechanism, indexed bounded queries.
//  1. delegation retries: a bounded due structure and one queue write per pass, so a retry window costs the due items, never the backlog;
//  2. a restore's room_request holds are retired once the recovery they kept is settled, so restored requests age out like any other;
//  3. a tombstone never clears delivery debt while the requester's conversation is still live;
//  4. the per-bot runnable question reads that bot's runnable rows only (room_requests_runnable_bot);
//  5. the multi-team fairness lookup is one index seek (room_requests_team_dispatch), flat in history;
//  6. a held owed row is checked for terminal settlement before it is postponed, and its hold is removed with it;
//  7. the dismissal receipt is a durable obligation retried until it reaches disk.
// The scaling tests count the rows the production statements visit (a SQL function called on every row the plan walks) and the queue-file writes, at 1k and 100k rows.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import type { CommsBus } from "./comms-visibility.ts";
import {
  DUE_PARKED_BATCH, _delegationPassLooked, _delegationQueueWrites, _loadPending, _pendingCount, _resetPending, findDelegationReceipt,
  hasActiveDelegationWork, recordDelegationReceipt, releaseParkedDelegations,
} from "./delegations.ts";
import { drainDelegations } from "./testing/handoff-turn.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { fenceRestoredSql, restoreHoldFor } from "./restore-fence.ts";
import { dismissOwedSharedResult, settleDismissalReceipts, settleOwedSharedResults } from "./room-request-owed.ts";
import { pruneTerminalRoomRequests, retireSettledRoomRequestHolds, roomRequest, runnableRoomRequestIdsSql } from "./room-requests.ts";
import { LAST_TEAM_DISPATCH_SQL } from "./shared-work.ts";
import { requestSourceThread } from "./execution-audience.ts";

const DAY = 86_400_000;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(() => { _resetPending(); closeDatabase(); });

const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,created_at,deadline_at,finished_at,root_thread_id,return_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
type Row = { id: string; verb?: string; state?: string; to?: string | null; target?: string | null; at?: number; deadline?: number | null; finished?: number | null; refusal?: string | null;
  payload?: string | null; shared?: boolean; returnThread?: string | null; note?: string | null };
function inserter(db: DatabaseSync) {
  const stmt = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
  const provenance = db.prepare("INSERT OR REPLACE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  return (o: Row) => {
    if (o.shared) provenance.run(o.id);
    const verb = o.verb ?? "ask", state = o.state ?? "queued";
    stmt.run(o.id, o.id, null, "g", verb, verb === "owner_send" ? "owner" : "bot", o.to === undefined ? "b0" : o.to, o.target ?? "tt0", state, o.payload ?? null, o.refusal ?? null, o.at ?? 1,
      o.deadline ?? null, o.finished ?? (state === "queued" || state === "running" ? null : o.at ?? 1), "t", o.returnThread ?? null, `key-${o.id}`);
    if (o.note) db.prepare("UPDATE room_requests SET outcome_note=? WHERE id=?").run(o.note, o.id);
  };
}
const fill = (db: DatabaseSync, n: number, each: (i: number) => void) => { db.exec("BEGIN"); try { for (let i = 0; i < n; i++) each(i); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } };
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const planOf = (db: DatabaseSync, sql: string, args: unknown[] = []) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map(row => row.detail).join(" | ");

/** Runs the production statement with a counting SQL function as its first condition: the number of rows the plan walks (one call per row visited). */
function rowsVisited(db: DatabaseSync, sql: string, args: unknown[]): number {
  let visited = 0;
  db.function("visit", (_rowid: unknown) => { visited++; return 1; });
  db.prepare(sql.replace(/\bWHERE /, "WHERE visit(rowid) AND ")).all(...(args as never[]));
  return visited;
}

// ── 1 ─────────────────────────────────────────────────────────────────────────────
describe("1. delegation retries cost the due items, never the backlog of parked ones", () => {
  const bus = { store: { bot: () => null, botByThread: () => null, groupByThread: () => undefined, appendMessage: () => ({ id: "line" }), patchMessage: () => {}, messagesFor: () => [] }, broadcast: () => {} } as unknown as CommsBus;
  const approvalBus = { store: bus.store, broadcast: () => {} } as never;
  const pass = (now: number) => {
    for (const thread of releaseParkedDelegations(() => false, now)) drainDelegations(bus, approvalBus, thread, () => {});
  };
  function scenario(parked: number, due: number) {
    const now = Date.now();
    const queue: Record<string, unknown[]> = {};
    for (let i = 0; i < parked; i++) queue[`src-${i}`] = [{ id: `d-${i}`, toBotId: "peer", message: "work", depth: 0, attempts: 0, fromBotId: "sender-not-listed", unknownTarget: true, unknownAttempts: 1, unknownRetryAt: i < due ? 1 : now + 3_600_000 }];
    writeFileSync(join(DATA_DIR, "delegations.json"), JSON.stringify(queue));
    _loadPending();
    return now;
  }
  const results: Array<{ parked: number; looked: number; writes: number; idleLooked: number; idleWrites: number }> = [];
  for (const parked of [1_000, 100_000]) {
    it(`${parked} parked unresolved items, 100 due: one row written per due item and 100 items looked at; inside the backoff nothing is read or written`, () => {
      const now = scenario(parked, 100);
      expect(hasActiveDelegationWork()).toBe(false);
      const before = _delegationQueueWrites();
      pass(now);
      const looked = _delegationPassLooked(), writes = _delegationQueueWrites() - before;
      expect(looked).toBe(DUE_PARKED_BATCH);
      expect(writes).toBe(DUE_PARKED_BATCH);                    // one row per due item, never a rewrite of the backlog
      // every due item was parked again with a longer wait: a pass inside the backoff looks at nothing and writes nothing
      const idleBefore = _delegationQueueWrites();
      expect(releaseParkedDelegations(() => false, now)).toEqual([]);
      const idleLooked = _delegationPassLooked(), idleWrites = _delegationQueueWrites() - idleBefore;
      expect(idleWrites).toBe(0);
      results.push({ parked, looked, writes, idleLooked, idleWrites });
      expect(_pendingCount("src-0")).toBe(1);                   // still parked, never settled by a retry
    }, 300_000);
  }
  it("the work is the same at 1k and 100k parked items", () => {
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ...results[1]!, parked: 1_000 });
    expect(results[0]!.idleLooked).toBe(0);
  });
  it("a backlog of due items is taken a bounded batch per pass: 150 due take two passes, one row write per due item", () => {
    const now = scenario(1_000, 150);
    const before = _delegationQueueWrites();
    pass(now);
    expect(_delegationPassLooked()).toBe(DUE_PARKED_BATCH);
    pass(now);
    expect(_delegationPassLooked()).toBe(50);
    expect(_delegationQueueWrites() - before).toBe(150);
    pass(now);
    expect(_delegationPassLooked()).toBe(0);
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────
describe("2. a restore's room_request holds are retired when their recovery is settled", () => {
  it("restored requests age out after retention, repeated restores do not accumulate, and a request that still owes its owner's words is kept", () => {
    const db = database(); initializeProjectTables(db);
    const insert = inserter(db);
    const holds = () => count(db, "SELECT COUNT(*) AS n FROM restore_holds WHERE kind='room_request'");
    for (let cycle = 0; cycle < 5; cycle++) {
      insert({ id: `ask-${cycle}`, verb: "ask", state: "running", at: cycle + 1 });
      insert({ id: `send-${cycle}`, verb: "owner_send", state: "queued", payload: `words ${cycle}`, at: cycle + 1 });
      expect(fenceRestoredSql(db, `gen-${cycle}`).some(note => /waiting room request/.test(note.action))).toBe(true);
      // the restore expires what was open; the owner's words come back as a chip (the durable mark), the ask owed nothing
      db.prepare("UPDATE room_requests SET state='expired', finished_at=?, outcome_note='restored' WHERE id IN (?,?)").run(cycle + 10, `ask-${cycle}`, `send-${cycle}`);
      if (cycle > 0) db.prepare("UPDATE room_requests SET refusal='owner_words_kept' WHERE id=?").run(`send-${cycle}`);
    }
    expect(holds()).toBe(10);
    // send-0 never became a chip: its words are still owed, so it and its hold stay
    expect(pruneTerminalRoomRequests(db, 40 * DAY)).toBe(9);
    expect(roomRequest(db, "send-0")).toBeTruthy();
    expect(holds()).toBe(1);
    expect(restoreHoldFor(db, "room_request", "send-0")).toBeTruthy();
    // once the chip exists the hold goes at the next pass and the request ages out
    db.prepare("UPDATE room_requests SET refusal='owner_words_kept' WHERE id='send-0'").run();
    expect(pruneTerminalRoomRequests(db, 41 * DAY)).toBe(1);
    expect(holds()).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_requests")).toBe(0);
  });
  it("a hold whose finished card result is still owed to its room stays; a hold whose request is gone is retired", () => {
    const db = database(); initializeProjectTables(db);
    const insert = inserter(db);
    insert({ id: "card", verb: "assign", state: "expired", finished: 5, note: "restored" });
    db.prepare("INSERT INTO project_card_delivery_owed(request_id, created_at) VALUES('card', 1)").run();
    fenceRestoredSql(db, "g");
    db.prepare("INSERT OR REPLACE INTO restore_holds(kind,row_id,generation) VALUES('room_request','card','g'),('room_request','vanished','g')").run();
    expect(retireSettledRoomRequestHolds(db)).toBe(1);
    expect(restoreHoldFor(db, "room_request", "card")).toBeTruthy();
    expect(restoreHoldFor(db, "room_request", "vanished")).toBeNull();
    db.prepare("DELETE FROM project_card_delivery_owed").run();
    expect(retireSettledRoomRequestHolds(db)).toBe(1);
  });
});

// ── 3 and 6 ───────────────────────────────────────────────────────────────────────
describe("3 and 6. delivery debt survives a tombstone while the requester is live, and a held row is settled by a confirmed deletion", () => {
  const deps = (db: DatabaseSync, state: { live: boolean; deleted: boolean; held: boolean; now: number; delivered: string[] }) => ({
    held: () => state.held, load: (id: string) => roomRequest(db, id) ?? undefined, destination: (r: { id: string }) => requestSourceThread(r.id, db),
    live: () => state.live, deleted: () => state.deleted, delivered: () => false, now: () => state.now,
    deliver: (r: { id: string }) => { state.delivered.push(r.id); db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=? AND state IN ('done','failed')").run(r.id); },
  });
  const owed = (db: DatabaseSync) => count(db, "SELECT COUNT(*) AS n FROM room_request_owed WHERE kind='shared_delivery'");
  it("3. the crash between the thread tombstone and the registry change: the live requester still gets its result", () => {
    const db = database(); initializeProjectTables(db);
    inserter(db)({ id: "s", verb: "ask", state: "done", shared: true, returnThread: "requester" });
    recordOwnerDeletion(db, "requester");                       // the tombstone was committed; the bot and its conversation are still in the registry on restart
    const state = { live: true, deleted: true, held: false, now: 1_000_000, delivered: [] as string[] };
    settleOwedSharedResults(db, deps(db, state));
    expect(state.delivered).toEqual(["s"]);                      // delivered, not erased
    expect(owed(db)).toBe(0);
  });
  it("3. with the destination really gone the tombstone settles the debt, as before", () => {
    const db = database(); initializeProjectTables(db);
    inserter(db)({ id: "s", verb: "ask", state: "done", shared: true, returnThread: "requester" });
    const state = { live: false, deleted: true, held: false, now: 1_000_000, delivered: [] as string[] };
    settleOwedSharedResults(db, deps(db, state));
    expect(state.delivered).toEqual([]);
    expect(owed(db)).toBe(0);
  });
  it("6. a held row whose requester was deleted is settled and its hold removed; a held row whose requester is live stays held", () => {
    const db = database(); initializeProjectTables(db);
    const insert = inserter(db);
    insert({ id: "dead", verb: "ask", state: "done", shared: true, returnThread: "gone" });
    insert({ id: "alive", verb: "ask", state: "done", shared: true, returnThread: "here" });
    fenceRestoredSql(db, "gen-1");
    expect(count(db, "SELECT COUNT(*) AS n FROM restore_holds WHERE kind='shared_result'")).toBe(2);
    const state = { live: false, deleted: true, held: true, now: 1_000_000, delivered: [] as string[] };
    const base = deps(db, state);
    settleOwedSharedResults(db, { ...base, live: thread => thread === "here", deleted: thread => thread === "gone" });
    expect(db.prepare("SELECT request_id AS id FROM room_request_owed").all()).toEqual([{ id: "alive" }]);
    expect(restoreHoldFor(db, "shared_result", "dead")).toBeNull();
    expect(restoreHoldFor(db, "shared_result", "alive")).toBeTruthy();
    expect(state.delivered).toEqual([]);                          // the held live result waits for the owner's release
    expect(db.prepare("SELECT retry_at AS at FROM room_request_owed WHERE request_id='alive'").get()).toEqual({ at: 1_000_000 + 3_600_000 });
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────
describe("4. the per-bot runnable question reads that bot's runnable rows only", () => {
  const results: Array<{ parked: number; history: number; quiet: number; busy: number }> = [];
  for (const history of [1_000, 100_000]) {
    for (const parked of [0, 10_000]) {
      it(`${history} terminal rows, ${parked} parked across 10 bots: a bot with nothing runnable visits 0 rows, a bot with 20 visits 20`, () => {
        const db = database(); initializeProjectTables(db);
        const insert = inserter(db);
        fill(db, history, i => insert({ id: `h-${i}`, verb: "ask", state: "done", to: `b${i % 10}`, at: 1_000 + i }));
        fill(db, parked, i => insert({ id: `p-${i}`, verb: "ask", state: "queued", to: `b${i % 10}`, target: `x${i}`, at: 8 * DAY + i, refusal: "retained_unresolved" }));
        fill(db, 20, i => insert({ id: `run-${i}`, verb: "ask", state: "queued", to: "b3", target: `rt-${i}`, at: 9 * DAY + i }));
        const sql = runnableRoomRequestIdsSql({ toBotId: "b3" });
        expect(planOf(db, sql, ["b3"])).toMatch(/USING (COVERING )?INDEX room_requests_runnable_bot/);
        const quiet = rowsVisited(db, runnableRoomRequestIdsSql({ toBotId: "b7" }), ["b7"]);
        const busy = rowsVisited(db, sql, ["b3"]);
        expect(quiet).toBe(0);
        expect(busy).toBe(20);
        results.push({ parked, history, quiet, busy });
      }, 300_000);
    }
  }
  it("is flat across every history size and parked count", () => {
    expect(results).toHaveLength(4);
    for (const r of results) expect({ quiet: r.quiet, busy: r.busy }).toEqual({ quiet: 0, busy: 20 });
  });
});

// ── 5 ─────────────────────────────────────────────────────────────────────────────
describe("5. the multi-team fairness lookup is one index seek, whatever the history", () => {
  const visits: number[] = [];
  for (const history of [1_000, 100_000]) {
    it(`${history} terminal rows for 10 bots: MAX(dispatched_at) for one bot and team visits a constant number of rows`, () => {
      const db = database(); initializeProjectTables(db);
      const insert = inserter(db);
      fill(db, history, i => insert({ id: `h-${i}`, verb: "ask", state: "done", to: `b${i % 10}`, at: 1_000 + i }));
      db.prepare("UPDATE room_requests SET dispatched_at=created_at, execution_audience=json_object('team','T'||(rowid%3)) WHERE state='done'").run();
      expect(planOf(db, LAST_TEAM_DISPATCH_SQL, ["b3", "T1"])).toMatch(/USING (COVERING )?INDEX room_requests_team_dispatch/);
      const row = db.prepare(LAST_TEAM_DISPATCH_SQL).get("b3", "T1") as { at: number | null };
      const expected = db.prepare("SELECT MAX(dispatched_at) AS at FROM room_requests WHERE to_bot_id='b3' AND json_extract(execution_audience,'$.team')='T1'").get() as { at: number | null };
      expect(row.at).toBe(expected.at);                               // the same answer as the unindexed question
      expect(row.at).not.toBeNull();
      const visited = rowsVisited(db, LAST_TEAM_DISPATCH_SQL, ["b3", "T1"]);
      visits.push(visited);
      expect(visited).toBe(1);
    }, 300_000);
  }
  it("is the same at 1k and 100k", () => { expect(visits).toHaveLength(2); expect(visits[0]).toBe(visits[1]); });
});

// ── 7 ─────────────────────────────────────────────────────────────────────────────
describe("7. a dismissal keeps its receipt as a durable obligation until the receipt reaches disk", () => {
  it("a receipt that could not be written is retried by the sweep; the bot then reads 'dismissed by you'", () => {
    const db = database(); initializeProjectTables(db);
    inserter(db)({ id: "s", verb: "ask", state: "done", shared: true, returnThread: "requester" });
    let disk = false;
    const written: string[] = [];
    const deps = { load: (id: string) => roomRequest(db, id) ?? undefined, receipt: (r: { id: string }) => { if (!disk) return false; written.push(r.id); return true; } };
    expect(dismissOwedSharedResult(db, "s", deps)).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_owed")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_dismissal_receipts")).toBe(1);   // the debt moved to the receipt obligation, it did not vanish
    expect(roomRequest(db, "s")!.refusal).toBe("delivered");
    expect(settleDismissalReceipts(db, deps)).toBe(1);                                         // the disk is still full: kept
    disk = true;
    expect(settleDismissalReceipts(db, deps)).toBe(0);
    expect(written).toEqual(["s"]);
    expect(count(db, "SELECT COUNT(*) AS n FROM room_request_dismissal_receipts")).toBe(0);
    // it also survives pruning while owed, and a repeat dismissal changes nothing
    expect(dismissOwedSharedResult(db, "s", deps)).toBe(false);
  });
  it("the production receipt writer reports a failed write (ENOSPC stand-in) and succeeds once the disk recovers", () => {
    const blocker = join(DATA_DIR, "delegation-receipts.json");
    mkdirSync(blocker);                                           // the atomic replace cannot land on a directory
    const receipt = { id: "r1", sourceThreadId: "t", toBotId: "b", toBotName: "B", status: "cancelled" as const, result: "dismissed by you", lineage: true };
    expect(recordDelegationReceipt(receipt)).toBe(false);
    expect(findDelegationReceipt("r1")).toBeTruthy();             // visible in memory, not on disk
    rmSync(blocker, { recursive: true, force: true });
    expect(recordDelegationReceipt(receipt)).toBe(true);
  });
  it("a request that still owes its dismissal receipt is never pruned", () => {
    const db = database(); initializeProjectTables(db);
    inserter(db)({ id: "s", verb: "ask", state: "done", shared: true, returnThread: "requester" });
    expect(dismissOwedSharedResult(db, "s", { load: id => roomRequest(db, id) ?? undefined, receipt: () => false })).toBe(true);
    expect(pruneTerminalRoomRequests(db, 400 * DAY)).toBe(0);
    expect(roomRequest(db, "s")).toBeTruthy();
  });
});
