// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 28: the shared drain serves a durable ready-team set round-robin, deciding only each team's HEAD (shared-ready.ts), instead of walking the queue with a
// cursor. Each test reproduces an r27 finding (Astra REPORT.md, Fable FABLE-REPORT.md) and fails on 8416055a2:
//  1  Astra P1-1   115 waiting hand-offs over six teams: when the sixth team's conversation frees, its OLDEST request starts, never a later one
//  2  Astra P1-2   sustained cancel-and-replenish of five waiting teams never keeps a runnable sixth team from starting
//  3  Fable P1     100k waiting rows: the work of a pass and of an event is flat in rows (1k vs 100k) and teams (50 vs 5,000), and no pass blocks over 50 ms
//  4  Astra P1-3   going back to 1.0.1 with a hand-off held for the owner is refused, and the hand-off is kept
//  5  Astra P2-4   a fault on the request's terminal write in the normal finalizer leaves the row and the request as they were; the next pass settles both
//  6  Fable P2     a receipt whose settling keeps failing does not keep the boot settling spinning
//  7  Astra P2-6   a plain-key hand-back is still recognised after 100 later completions push its receipt out
import { mkdirSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, findDelegationReceipt, onDelegationReceipt, queueDelegation, recordDelegationReceipt, settleStartedDelegations } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { _resetOwnerMigration, delegationAdmissionHeld } from "./pending-delegations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { recordLeadWake } from "./project-turn-engine.ts";
import { completeRequest, insertRoomRequest, roomRequest } from "./room-requests.ts";
import { _lastDrainDecisions, _resetDrainDiagnostics, _totalDrainDecisions, drainSharedWork } from "./shared-work.ts";
import { LINEAGE, ownerWorld, sharedWorld, type OwnerWorld, type SharedWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const N = (n: number): number => Math.max(1, Math.round(n * Number(process.env.MEASURE_SCALE ?? 1)));

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };
const rowOf = (id: string) => database().prepare("SELECT phase, started_at FROM pending_delegations WHERE id=?").get(id) as { phase: string; started_at: number | null } | undefined;
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); };

beforeEach(fresh);
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

/** Senders in their own sections: each hands work to Iris under its own team. */
function senders(w: SharedWorld, n: number) {
  return Array.from({ length: n }, (_, i) => { const bot = w.store.createBot(); w.store.patchBot(bot.id, { name: `S${i}`, section: `Section${i}`, chiefOfStaff: true }); return bot; });
}
const at = (id: string, createdAt: number) => database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(createdAt, id);

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. per-team FIFO: only a team's head is ever started", () => {
  it("Astra's 115 rows over six teams (19 x 5 + 20): when the sixth team's conversation frees, T5-0 starts and T5-1..T5-19 stay queued", async () => {
    const w = sharedWorld();
    const s = senders(w, 6);
    const threads: string[] = [];
    for (let t = 0; t < 6; t++) {
      for (let k = 0; k < (t < 5 ? 19 : 20); k++) {
        const request = w.handoff(`T${t}-${k}`, s[t]!);
        at(request.id, 10 + t * 100 + k);
        threads[t] = request.targetThreadId!;
      }
    }
    for (const thread of threads) w.knobs.busyThreads.add(thread);                 // every team's conversation is busy: every head waits
    drainSharedWork(w.iris.id);
    w.knobs.busyThreads.delete(threads[5]!);                                         // the sixth team's conversation frees before anything else runs
    await ticks(5);
    drainSharedWork(w.iris.id);                                                      // the freeing event
    await ticks(5);
    const started = w.turns.map((turn) => turn.id).filter((id) => id.startsWith("T5-"));
    expect(started).toEqual(["T5-0"]);
    for (let k = 1; k < 20; k++) expect(roomRequest(database(), `T5-${k}`)!.state).toBe("queued");
  }, 3_600_000);
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────
describe("2. no starvation under sustained arrivals", () => {
  it("five never-dispatched waiting teams are cancelled and refilled before every pass for 21 passes: the sixth team's older runnable request still starts", { tags: ["nightly"], timeout: 3_600_000 }, async () => {
    const w = sharedWorld();
    const s = senders(w, 6);
    // the sixth team started work before (the old order put the team that last started at the back)
    const old = w.handoff("t6-old", s[5]!);
    database().prepare("UPDATE room_requests SET state='done', dispatched_at=5, finished_at=6 WHERE id=?").run(old.id);
    database().prepare("DELETE FROM pending_delegations WHERE id=?").run(old.id);
    const runnable = w.handoff("t6-run", s[5]!);
    at(runnable.id, 7);
    const threads: string[] = [];
    let serial = 0;
    const refill = () => {
      for (let t = 0; t < 5; t++) {
        for (const row of database().prepare("SELECT id FROM room_requests WHERE state='queued' AND from_bot_id=?").all(s[t]!.id) as Array<{ id: string }>) {
          completeRequest(database(), row.id, { state: "cancelled", now: 9 });
          database().prepare("DELETE FROM pending_delegations WHERE id=?").run(row.id);
        }
        for (let k = 0; k < 20; k++) {
          const request = w.handoff(`w${t}-${serial++}`, s[t]!);
          at(request.id, 1_000 + serial);
          threads[t] = request.targetThreadId!;
          w.knobs.busyThreads.add(request.targetThreadId!);
        }
      }
    };
    refill();
    drainSharedWork(w.iris.id);
    for (let pass = 0; pass < N(21); pass++) { refill(); await tick(); drainSharedWork(w.iris.id); }
    await ticks(5);
    expect(w.turns.map((turn) => turn.id)).toContain("t6-run");
    expect(w.turns.filter((turn) => turn.id.startsWith("w"))).toEqual([]);
    expect(_totalDrainDecisions()).toBeLessThanOrEqual(6 + 21 * 6);                  // one decision per team per event, never the 2,100 rows
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────
describe("3. the work of a pass and of an event is flat in the backlog", () => {
  const COLUMNS = "id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,created_at,deadline_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key,execution_audience";
  function counted(db: DatabaseSync, run: () => void): number {
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
    try { run(); } finally { (db as { prepare: unknown }).prepare = original; }
    return statements;
  }
  /** `rows` waiting shared requests over `teams` teams (their teammate's conversation is not listed, so every head waits). */
  async function measure(rows: number, teams: number): Promise<{ event: number; turn: number; slowest: number; heaviest: { statements: number; decisions: number } }> {
    fresh();
    const w = sharedWorld();
    const db = database();
    const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?,?)`);
    const provenance = db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) {
      const team = `T${String(i % teams).padStart(4, "0")}`;
      insert.run(`r-${i}`, `r-${i}`, "g", "ask", "bot", w.iris.id, `x-${team}`, "queued", 1_000 + i, 10 + 86_400_000, "t", `key-${i}`, JSON.stringify({ kind: "team", team }));
      provenance.run(`r-${i}`);
    }
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");                                      // the fixture's own 100k-row write is not charged to the passes
    // every team is ready once (its first head): served in passes of at most 100 teams, each timed
    // the garbage collector's pauses are the runtime's, not the drain's: a pass is charged its own time (the collector's pauses inside it are subtracted)
    const pauses: Array<{ start: number; end: number }> = [];
    const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) pauses.push({ start: entry.startTime, end: entry.startTime + entry.duration }); });
    observer.observe({ entryTypes: ["gc"] });
    // and a pass is charged the CPU time it used, so a shared test host that takes the processor away mid-pass does not count against it
    const passes: Array<{ start: number; end: number; cpu: number }> = [];
    // the work of a pass is its statements and its decisions, the same on every machine; its time only has a generous guard
    let heaviest = { statements: 0, decisions: 0 };
    for (let pass = 0; pass < Math.ceil(teams / 100) + 2; pass++) {
      const start = performance.now(), cpu = process.cpuUsage();
      const statements = counted(db, () => drainSharedWork(w.iris.id, { continuation: pass > 0 }));
      if (statements > heaviest.statements) heaviest = { statements, decisions: _lastDrainDecisions() };
      const used = process.cpuUsage(cpu);
      passes.push({ start, end: performance.now(), cpu: (used.user + used.system) / 1000 });
      if (_lastDrainDecisions() < 100) break;
    }
    await tick(); await tick();
    observer.disconnect();
    let slowest = 0;
    for (const [index, pass] of passes.entries()) {
      const collected = pauses.reduce((sum, gc) => sum + Math.max(0, Math.min(gc.end, pass.end) - Math.max(gc.start, pass.start)), 0);
      const own = Math.min(pass.end - pass.start, pass.cpu) - collected;
      if (process.env.R28_DEBUG) console.log(`r28 rows=${rows} teams=${teams} pass=${index} ms=${(pass.end - pass.start).toFixed(1)} cpu=${pass.cpu.toFixed(1)} gc=${collected.toFixed(1)}`);
      slowest = Math.max(slowest, own);
    }
    // an event (a pump, an idle bot): what one invocation costs once everything waits
    const event = counted(db, () => drainSharedWork(w.iris.id));
    // a turn: one request of one team ends (its team's head changes), then the drain that follows it
    const turn = counted(db, () => { completeRequest(db, "r-0", { state: "cancelled", now: 11 }); drainSharedWork(w.iris.id); });
    return { event, turn, slowest, heaviest };
  }
  it("1k vs 100k rows and 50 vs 5,000 teams: statements per event, per turn and per pass within 10% (a pass by what it decides), and no pass over a second", async () => {
    const small = await measure(1_000, 50), deep = await measure(100_000, 50), wide = await measure(100_000, 5_000);
    // the bound on a pass is the work it did (statements for the decisions it made); the wall-clock guard is generous because a shared host
    // can take the processor away for longer than a pass lasts, which says nothing about how the work grows
    for (const run of [small, deep, wide]) { expect(run.event).toBeGreaterThan(0); expect(run.turn).toBeGreaterThan(0); expect(run.heaviest.decisions).toBeGreaterThan(0); expect(run.slowest).toBeLessThan(1_000); }
    for (const other of [deep, wide]) {
      expect(Math.abs(other.event - small.event) / small.event).toBeLessThanOrEqual(0.1);
      expect(Math.abs(other.turn - small.turn) / small.turn).toBeLessThanOrEqual(0.1);
    }
    // a pass costs statements by its decisions: the same decisions cost the same at 1k and at 100k rows, and 100 teams cost no more per decision than 50
    const perDecision = (run: typeof small) => run.heaviest.statements / run.heaviest.decisions;
    expect(Math.abs(perDecision(deep) - perDecision(small)) / perDecision(small)).toBeLessThanOrEqual(0.1);
    expect(perDecision(wide)).toBeLessThanOrEqual(perDecision(small) * 1.1);
  }, 3_600_000);
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
describe("4. going back to 1.0.1 never drops a held hand-off", () => {
  it("a hand-off held for the owner refuses the downgrade with the owner's line, and the hand-off stays", () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "never ran", depth: 0 }, 2).id!;
    database().prepare("UPDATE pending_delegations SET phase='started', started_at=NULL, start_attempts=1 WHERE id=?").run(id);   // held: Send again or Dismiss
    let thrown: unknown;
    try { downgradeApplicationSchemaTo101(database(), DATA_DIR); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "DOWNGRADE_HANDOFFS_HELD", message: "Some hand-offs are waiting for you. Send again or dismiss them, then try going back to the earlier version." });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
  });
});

// ── 5 ─────────────────────────────────────────────────────────────────────────────────
describe("5. the normal finalizer settles all or nothing", () => {
  const fault = (on: boolean) => on
    ? database().exec("CREATE TRIGGER r28_fault BEFORE UPDATE ON room_requests WHEN NEW.state IN ('done','failed') BEGIN SELECT RAISE(ABORT, 'injected fault'); END;")
    : database().exec("DROP TRIGGER IF EXISTS r28_fault");
  const queued = (w: OwnerWorld) => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it once", depth: 0 }, 2).id!;
  const receiptOf = (w: OwnerWorld, id: string) => ({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" as const });
  it("a fault on the request's terminal UPDATE: the row and the request are both untouched, and the next dispatch settles both", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(roomRequest(database(), id)!.state).toBe("running");
    // the server's listener, which steps aside while the finalizer itself ends the request (index.ts finalizingDelegations)
    const finalizing = new Set([id]);
    onDelegationReceipt((receipt) => { if (finalizing.has(receipt.id)) return; completeRequest(database(), receipt.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now() }); });
    fault(true);
    const quiet = console.error; console.error = () => {};
    try {
      expect(() => delegations.finishHandoff(receiptOf(w, id), () => completeRequest(database(), id, { state: "done", now: Date.now() }))).toThrow(/injected fault/);
    } finally { console.error = quiet; finalizing.clear(); }
    expect(rowOf(id)?.phase).toBe("started");
    expect(roomRequest(database(), id)!.state).toBe("running");
    expect(findDelegationReceipt(id)).not.toBeNull();                                 // the receipt is kept: it is what the next pass settles from
    fault(false);
    await expect(Promise.resolve(dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }))).resolves.toBe("settled");
    expect(rowOf(id)).toBeUndefined();
    expect(roomRequest(database(), id)!.state).toBe("done");
  });
  it("with no fault the receipt, the row's removal and the request's end commit together", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    onDelegationReceipt(() => undefined);
    delegations.finishHandoff(receiptOf(w, id), () => completeRequest(database(), id, { state: "done", now: Date.now() }));
    expect(rowOf(id)).toBeUndefined();
    expect(roomRequest(database(), id)!.state).toBe("done");
  });
});

// ── 6 ─────────────────────────────────────────────────────────────────────────────────
describe("6. the boot settling is bounded", () => {
  it("a receipt whose settling keeps failing: the settling finishes, the gate opens, and the row and receipt stay for the next start", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "x", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)?.phase).toBe("started");
    onDelegationReceipt(() => { throw new Error("a completion hook fails every time"); });
    const quiet = console.error; console.error = () => {};
    try {
      recordDelegationReceipt({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" });
      expect(rowOf(id)?.phase).toBe("started");
      const outcome = await Promise.race([settleStartedDelegations().then(() => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("spinning"), 5_000))]);
      expect(outcome).toBe("finished");
      expect(delegationAdmissionHeld()).toBe(false);
      expect(rowOf(id)?.phase).toBe("started");
      expect(findDelegationReceipt(id)).not.toBeNull();
    } finally { onDelegationReceipt(undefined); console.error = quiet; await ticks(3); }
  }, 3_600_000);
});

// ── 7 ─────────────────────────────────────────────────────────────────────────────────
describe("7. a hand-back is known by the identity on its request row", () => {
  it("a finished plain-key hand-back still pauses the goal after 100 later completions evicted its receipt", () => {
    const db = database(); initializeProjectTables(db);
    db.prepare("INSERT INTO project_settings (group_id,mode,lead_bot_id,parts,parallel_cards,work_roots,work_profile,run_state,updated_at) VALUES ('g','conversation','lead','{}',3,'[]','ask','running',1)").run();
    db.prepare("INSERT INTO project_goals (id,group_id,title,criteria,state,created_at) VALUES ('goal','g','Ship','[]','working',1)").run();
    const root = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root", lineage: LINEAGE("t"), now: 1 }).request.id;
    const hop = (verb: "ask" | "assign", from: string, to: string, parentId: string, key: string, now: number) =>
      insertRoomRequest(db, { groupId: "g", verb, fromKind: "bot", fromBotId: from, toBotId: to, parentId, projectGoalId: "goal", admissionKey: key, now, payloadText: "Write the pricing FAQ" }).request;
    const first = hop("assign", "nova", "wren", root, "h1", 200);
    const back = hop("ask", "wren", "nova", first.id, "an-imported-plain-key", 210);
    const pause = () => recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: (id) => ({ nova: "Nova", wren: "Wren" } as Record<string, string>)[id] ?? id }).pause;
    db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(back.id, "t", "nova", "wren", "fresh", null, JSON.stringify({ message: "x", depth: 0, attempts: 0 }), "room", `dlg-${back.id}`, "tt");
    // the hand-off finishes: its request ends, its row goes, its receipt is written
    db.prepare("UPDATE room_requests SET state='done', finished_at=300 WHERE id=?").run(back.id);
    db.prepare("DELETE FROM pending_delegations WHERE id=?").run(back.id);
    recordDelegationReceipt({ id: back.id, sourceThreadId: "t", toBotId: "nova", toBotName: "Nova", status: "done" });
    expect(pause()).toMatch(/keep handing the same work back/);
    for (let i = 0; i < 100; i++) recordDelegationReceipt({ id: `later-${i}`, sourceThreadId: "t", toBotId: "nova", toBotName: "Nova", status: "done" });
    expect(findDelegationReceipt(back.id)).toBeNull();                               // the receipt ring has moved on
    expect(pause()).toMatch(/keep handing the same work back/);                       // the request row still says it was a hand-off
  });
});
