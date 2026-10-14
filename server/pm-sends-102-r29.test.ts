// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 29: each test reproduces an r28 finding (Astra REPORT.md, Fable FABLE-REPORT.md) and fails on 28ff1c01e:
//  1  Astra P1-1   a ready set whose fill was cut short (table made, not filled) is filled again by the next start: the queued team is served
//  2  Astra P1-2   a shared start that fails before its first wait (the mirror throws) puts the request back AND keeps its team in the round
//  3  Astra P1-3   a source turn's end does the same work with 1k or 100k waiting shared hand-offs (one page, one shared drain)
//  4  Astra P2     a first boot page that cannot be settled does not keep the 101st started row from being settled
//  5  Astra P3     an ordinary (not hand-off) return ask is not even a hand-back candidate: no hand-off probe
//  6  Fable P1     a teammate's room ask, or a card run waiting on a dependency, in the same (bot, team) never heads the shared FIFO
//  7  Fable P2     a finished hand-off whose final commit failed is settled in this process by the parked sweep, not at the next start
//  8  Fable P2     an event for a team already decided in the current pass (its conversation freed) is not overwritten by the pass's decision
//  9  Fable P3     parking a team's head while other work is runnable makes the team ready again
// 10  Fable gap    the conversation-freed wake (sharedThreadFreed) alone brings a waiting team back, oldest request first
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, findDelegationReceipt, onDelegationReceipt, queueDelegation, recordDelegationReceipt, reconcileStartedDelegations } from "./delegations.ts";
import { configureSharedHandoffs, dispatchHandoff } from "./handoff-dispatch.ts";
import { _resetOwnerMigration, delegationTurnKey } from "./pending-delegations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { recordLeadWake } from "./project-turn-engine.ts";
import { completeRequest, insertRoomRequest, roomRequest } from "./room-requests.ts";
import * as ready from "./shared-ready.ts";
import { _resetDrainDiagnostics, _totalDrainDecisions, drainSharedWork, sharedThreadFreed } from "./shared-work.ts";
import { LINEAGE, ownerWorld, sharedWorld, type SharedWorld } from "./testing/handoff-worlds.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };
const fresh = () => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); };
const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => { const error = console.error; console.error = () => {}; try { return await run(); } finally { console.error = error; } };

beforeEach(fresh);
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

function senders(w: SharedWorld, n: number) {
  return Array.from({ length: n }, (_, i) => { const bot = w.store.createBot(); w.store.patchBot(bot.id, { name: `S${i}`, section: `Section${i}`, chiefOfStaff: true }); return bot; });
}
const at = (id: string, createdAt: number) => database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(createdAt, id);
const columns = () => (database().prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).map((column) => column.name);
/** A copy of a request row under a new id, with some columns changed (the marks the database writes are left to it). */
function cloneRequest(fromId: string, id: string, overrides: Record<string, unknown>): void {
  const db = database();
  const names = columns();
  const row = db.prepare("SELECT * FROM room_requests WHERE id=?").get(fromId) as Record<string, unknown>;
  const all: Record<string, unknown> = { ...row, id, root_id: id, admission_key: `clone:${id}`, handoff: null, shared_work: null, ...overrides };
  db.prepare(`INSERT INTO room_requests(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...(names.map((name) => all[name] ?? null) as never[]));
}
/** The world's shared side, with a mirror the test controls (the server's mirror of the exchange, run as the turn starts). */
function withMirror(w: SharedWorld, mirror: (requestId: string) => void): void {
  configureSharedHandoffs({
    begin: (_request, claim) => ({ sharedWorkRun: {}, finish: () => { claim?.release(); }, abandon: () => { w.abandoned.push(_request.id); claim?.release(); } }),
    needsApproval: () => false,
    requestApproval: () => Promise.resolve("allow" as const),
    mirror: (request) => mirror(request.id),
    turnOptions: () => ({}),
    text: (request) => request.payloadText ?? "",
  });
}

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. the ready set is derived from the queue on every start", () => {
  it("the table was made but its fill never committed: the next start fills it, and the queued hand-off is served", async () => {
    const w = sharedWorld();
    w.handoff("a");
    const db = database();
    db.exec("DELETE FROM shared_ready_teams");                                          // the interrupted first start: the table exists, empty
    expect(ready.nextReadyTeam(db, w.iris.id)).toBeNull();
    ready.initializeSharedReady(db);                                                    // the next start
    expect(ready.nextReadyTeam(db, w.iris.id)).not.toBeNull();
    drainSharedWork(w.iris.id);
    await ticks(5);
    expect(w.turns.map((turn) => turn.id)).toEqual(["a"]);
  });
  it("a team already in the set keeps its place and its state at the next start", () => {
    const w = sharedWorld();
    const request = w.handoff("b");
    w.knobs.busyThreads.add(request.targetThreadId!);
    drainSharedWork(w.iris.id);
    const before = database().prepare("SELECT seq, waiting FROM shared_ready_teams").all();
    ready.initializeSharedReady(database());
    expect(database().prepare("SELECT seq, waiting FROM shared_ready_teams").all()).toEqual(before);
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────
describe("2. a start cut short before its first wait keeps the team's scheduling", () => {
  it("the mirror throws once: the request is queued again, the team stays in the round, and with the fault gone the hand-off starts", async () => {
    const w = sharedWorld();
    let fail = true;
    withMirror(w, () => { if (fail) throw new Error("injected mirror fault"); });
    const request = w.handoff("m");
    await quietly(async () => { drainSharedWork(w.iris.id); await ticks(5); });
    expect(roomRequest(database(), "m")!.state).toBe("queued");
    expect(w.turns).toEqual([]);
    expect(database().prepare("SELECT 1 AS x FROM shared_ready_teams WHERE bot_id=?").get(w.iris.id)).toBeDefined();
    fail = false;
    sharedThreadFreed(request.targetThreadId!);
    drainSharedWork(w.iris.id);
    await ticks(5);
    expect(w.turns.map((turn) => turn.id)).toEqual(["m"]);
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────
describe("3. a source turn's end does work bounded by one page, never by the waiting shared backlog", () => {
  function counting(db: DatabaseSync): { stop(): number } {
    let statements = 0;
    const original = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (sql: string) => {
      const statement = original(sql);
      for (const key of ["all", "get", "run", "iterate"] as const) {
        const fn = (statement[key] as (...a: unknown[]) => unknown).bind(statement);
        (statement as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => { statements++; return fn(...args); };
      }
      return statement;
    };
    return { stop: () => { (db as { prepare: unknown }).prepare = original; return statements; } };
  }
  async function measure(rows: number): Promise<{ visits: number; decisions: number; statements: number }> {
    fresh();
    const w = sharedWorld();
    const teams = senders(w, 10);
    const source = teams[0]!;
    const templates = teams.map((sender, t) => { const request = w.handoff(`tpl-${t}`, sender); w.knobs.busyThreads.add(request.targetThreadId!); return request; });
    const db = database();
    const names = columns();
    const select = names.map((name) => name === "id" || name === "root_id" ? "?1" : name === "admission_key" ? "'bulk:'||?1" : name === "created_at" ? "?2"
      : name === "execution_audience" ? "json_set(execution_audience,'$.rootRequestId',?1)" : name === "handoff" || name === "shared_work" ? "NULL" : name).join(",");
    const clone = db.prepare(`INSERT INTO room_requests(${names.join(",")}) SELECT ${select} FROM room_requests WHERE id=?3`);
    const provenance = db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
    const handoff = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) {
      const template = templates[i % templates.length]!;
      const id = `q-${i}`;
      clone.run(id, 10_000 + i, template.id);
      provenance.run(id);
      handoff.run(id, source.threadId, w.iris.id, null, "fresh", null, JSON.stringify({ message: "shared hand-off", depth: 0, attempts: 0 }), "shared", delegationTurnKey(id), template.targetThreadId);
    }
    db.exec("COMMIT");
    drainSharedWork(w.iris.id);                                                         // every team's head is found waiting (its conversation is busy)
    await ticks(3);
    _resetDrainDiagnostics(); delegations._resetSourceDrainVisits();
    const counter = counting(db);
    delegations.drainDelegations(w.bus, w.approvalBus, source.threadId);                // the source turn ends
    await ticks(10);
    const statements = counter.stop();
    expect(w.turns).toEqual([]);
    return { visits: delegations._sourceDrainVisits(), decisions: _totalDrainDecisions(), statements };
  }
  it("1,000 vs 100,000 waiting: the same hand-offs looked at (one page), the same shared decisions, statements within 10%", async () => {
    const small = await measure(1_000), deep = await measure(100_000);
    expect(small.visits).toBeLessThanOrEqual(delegations.DRAIN_PAGE);
    expect(deep.visits).toBe(small.visits);
    expect(deep.decisions).toBe(small.decisions);
    expect(small.decisions).toBeLessThanOrEqual(ready.SHARED_WAKE_PAGE * 2);
    expect(Math.abs(deep.statements - small.statements) / small.statements).toBeLessThanOrEqual(0.1);
  }, 600_000);
  it("the source drain's statements use their own indexes (never a walk of the thread's shared rows)", () => {
    const db = database();
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    expect(plan(delegations.PENDING_SQL.ownOfThread, "t", 0, 100)).toMatch(/pd_thread_own/);
    expect(plan(delegations.PENDING_SQL.sharedOfThread, "t", 0, 100)).toMatch(/pd_thread_shared/);
    expect(plan(delegations.PENDING_SQL.startedAfter, -1, 0)).toMatch(/pd_started/);
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
describe("4. the boot settling goes past rows it cannot settle", () => {
  it("101 started hand-offs, the first 100 fail to settle: the 101st is still settled, the 100 stay for the next start", async () => {
    const w = ownerWorld("owner");
    const db = database();
    const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id, started_at, start_attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)");
    for (let i = 0; i <= 100; i++) insert.run(`s-${i}`, w.from.threadId, w.target.id, w.from.id, "started", null, JSON.stringify({ message: "x", depth: 0, attempts: 0, toBotId: w.target.id }), "owner", delegationTurnKey(`s-${i}`), w.target.threadId, 1_000 + i);
    onDelegationReceipt(() => { throw new Error("a completion hook fails every time"); });
    await quietly(() => {
      for (let i = 0; i < 100; i++) recordDelegationReceipt({ id: `s-${i}`, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" });
      reconcileStartedDelegations();
    });
    const startedAt = (id: string) => (db.prepare("SELECT started_at FROM pending_delegations WHERE id=?").get(id) as { started_at: number | null } | undefined)?.started_at;
    expect(startedAt("s-100")).toBeFalsy();                                            // looked at and settled (reset to run again)
    for (let i = 0; i < 100; i++) expect(startedAt(`s-${i}`)).toBe(1_000 + i);         // kept, with their receipts, for the next start
    expect(findDelegationReceipt("s-0")).not.toBeNull();
  });
});

// ── 5 ─────────────────────────────────────────────────────────────────────────────────
describe("5. the hand-back prefilter reads hand-offs only", () => {
  it("a plain return ask (not a hand-off) is not a candidate: no hand-off probe, no pause", () => {
    const db = database(); initializeProjectTables(db);
    db.prepare("INSERT INTO project_settings (group_id,mode,lead_bot_id,parts,parallel_cards,work_roots,work_profile,run_state,updated_at) VALUES ('g','conversation','lead','{}',3,'[]','ask','running',1)").run();
    db.prepare("INSERT INTO project_goals (id,group_id,title,criteria,state,created_at) VALUES ('goal','g','Ship','[]','working',1)").run();
    const root = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root", lineage: LINEAGE("t"), now: 1 }).request.id;
    const hop = (verb: "ask" | "assign", from: string, to: string, parentId: string, key: string, now: number) =>
      insertRoomRequest(db, { groupId: "g", verb, fromKind: "bot", fromBotId: from, toBotId: to, parentId, projectGoalId: "goal", admissionKey: key, now, payloadText: "Write the pricing FAQ" }).request;
    const first = hop("assign", "nova", "wren", root, "h1", 200);
    hop("ask", "wren", "nova", first.id, "a-plain-question", 210);
    let probes = 0;
    const original = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (sql: string) => {
      const statement = original(sql);
      if (/FROM pending_delegations WHERE id=\?/.test(sql)) { const get = statement.get.bind(statement); (statement as unknown as { get: unknown }).get = (...args: unknown[]) => { probes++; return get(...(args as never[])); }; }
      return statement;
    };
    let pause: string | undefined;
    try { pause = recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: (id) => id }).pause; } finally { (db as { prepare: unknown }).prepare = original; }
    expect(pause).toBeUndefined();
    expect(probes).toBe(0);
  });
});

// ── 6 ─────────────────────────────────────────────────────────────────────────────────
describe("6. a team's FIFO is its shared work only", () => {
  for (const kind of ["a card run waiting on its dependency", "a teammate's room ask"] as const) {
    it(`${kind} queued ahead in the same (bot, team) does not hold back the shared hand-off`, async () => {
      const w = sharedWorld();
      const handoff = w.handoff("h");
      // C1 depends on C2, and C2's run is waiting on this hand-off: if the card run headed the team, neither could ever finish
      cloneRequest(handoff.id, "blocker", kind === "a card run waiting on its dependency" ? { verb: "assign", refusal: "dependency", created_at: 0, deadline_at: null } : { verb: "ask", created_at: 0 });
      expect(roomRequest(database(), "blocker")!.state).toBe("queued");
      drainSharedWork(w.iris.id);
      await ticks(5);
      expect(w.turns.map((turn) => turn.id)).toEqual(["h"]);
      expect(roomRequest(database(), "blocker")!.state).toBe("queued");             // not shared work: never started from here
    });
  }
});

// ── 7 ─────────────────────────────────────────────────────────────────────────────────
describe("7. a failed final commit is settled again in this process", () => {
  it("the request's terminal write faults once: the parked sweep's re-settle ends the request and removes the row from the kept receipt", async () => {
    const w = ownerWorld("room");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it once", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(roomRequest(database(), id)!.state).toBe("running");
    const finalizing = new Set([id]);
    onDelegationReceipt((receipt) => { if (finalizing.has(receipt.id)) return; completeRequest(database(), receipt.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now() }); });
    database().exec("CREATE TRIGGER r29_fault BEFORE UPDATE ON room_requests WHEN NEW.state IN ('done','failed') BEGIN SELECT RAISE(ABORT, 'injected fault'); END;");
    await quietly(() => {
      expect(() => delegations.finishHandoff({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" }, () => completeRequest(database(), id, { state: "done", now: Date.now() }))).toThrow(/injected fault/);
    });
    finalizing.clear();
    expect(roomRequest(database(), id)!.state).toBe("running");
    database().exec("DROP TRIGGER r29_fault");
    expect(delegations.resettleStranded()).toBe(1);                                   // what retryParkedDelegations (index.ts) runs every 30 s
    expect(database().prepare("SELECT 1 AS x FROM pending_delegations WHERE id=?").get(id)).toBeUndefined();
    expect(roomRequest(database(), id)!.state).toBe("done");
    expect(delegations.resettleStranded()).toBe(0);
  });
});

// ── 8 ─────────────────────────────────────────────────────────────────────────────────
describe("8. an event during a pass is never overwritten by the pass", () => {
  it("team A is decided 'waiting', then its conversation frees while the same pass starts team B: A stays ready and starts on the next pass", async () => {
    const w = sharedWorld();
    const [a, b] = senders(w, 2);
    const first = w.handoff("A1", a!); at(first.id, 10);
    const second = w.handoff("B1", b!); at(second.id, 20);
    w.knobs.busyThreads.add(first.targetThreadId!);
    withMirror(w, (requestId) => { if (requestId === "B1") { w.knobs.busyThreads.delete(first.targetThreadId!); sharedThreadFreed(first.targetThreadId!); } });
    drainSharedWork(w.iris.id);
    await ticks(3);
    expect(w.turns.map((turn) => turn.id)).toEqual(["B1"]);
    drainSharedWork(w.iris.id, { continuation: true });                                  // a pass with no waking of its own
    await ticks(3);
    expect(w.turns.map((turn) => turn.id)).toEqual(["B1", "A1"]);
  });
});

// ── 9 ─────────────────────────────────────────────────────────────────────────────────
describe("9. parking a head with other runnable work wakes the team", () => {
  it("the waiting head is parked: the team is ready again (its next request is the head now)", () => {
    const w = sharedWorld();
    const head = w.handoff("p1"); at(head.id, 10);
    const next = w.handoff("p2"); at(next.id, 20);
    w.knobs.busyThreads.add(head.targetThreadId!);
    drainSharedWork(w.iris.id);
    expect((database().prepare("SELECT waiting FROM shared_ready_teams WHERE bot_id=?").get(w.iris.id) as { waiting: number }).waiting).toBe(1);
    database().prepare("UPDATE room_requests SET refusal='retained_unresolved' WHERE id=?").run("p1");
    expect((database().prepare("SELECT waiting FROM shared_ready_teams WHERE bot_id=?").get(w.iris.id) as { waiting: number }).waiting).toBe(0);
  });
});

// ── 10 ────────────────────────────────────────────────────────────────────────────────
describe("10. the conversation-freed wake on its own", () => {
  it("twenty waiting teams: freeing the last team's conversation (sharedThreadFreed) and a pass with no wake page of its own start that team's OLDEST request only", async () => {
    const w = sharedWorld();
    const s = senders(w, 20);
    const threads: string[] = [];
    for (let t = 0; t < 20; t++) for (let k = 0; k < 3; k++) { const request = w.handoff(`T${t}-${k}`, s[t]!); at(request.id, 10 + t * 10 + k); threads[t] = request.targetThreadId!; }
    for (const thread of threads) w.knobs.busyThreads.add(thread);
    drainSharedWork(w.iris.id);
    await ticks(3);
    expect(w.turns).toEqual([]);
    w.knobs.busyThreads.delete(threads[19]!);
    sharedThreadFreed(threads[19]!);
    drainSharedWork(w.iris.id, { continuation: true });
    await ticks(3);
    expect(w.turns.map((turn) => turn.id)).toEqual(["T19-0"]);
  });
});
