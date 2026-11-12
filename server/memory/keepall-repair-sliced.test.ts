// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250 (design ELD250-KEEPALL-R3 r3.1, tests 6.1-6.7, 6.10, 6.11, 6.15): the one-time keep-all repair after listen. Its deletes run in
// background slices (a thread never split), with the loop free between them; the drain, the cursor judgment, the clear, the flush and the
// flag are one synchronous task, run only on a drained marker; a session still "checking" keeps its cursor; a live turn's cursor is left to
// the turn; every wait races the stop latch. Each test names the mutation it rejects. Real app database (DATA_DIR) and a real Store.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelCoalesced, flushCoalesced } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { createDataWriterGate } from "../data-writers.ts";
import { closeDatabase, database } from "../database.ts";
import * as dbBusy from "../db-busy.ts";
import { createGracefulShutdown } from "../graceful-shutdown.ts";
import { ioBudget } from "../io-budget.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { AUDIENCE_SESSION_READER, CONTENT_SESSION_READER, memorySessionRevoked, writetimeSessionVerdict } from "./dispatch.ts";
import {
  createKeepAllRepairGate, joinKeepAllRepair, judgeKeepAllCursors, KEEPALL_UNWEDGE, keepAllRepairBarrier, keepAllUnwedged, launchKeepAllRepair, MEMORY_REPAIRS_FILE,
  ownerAudienceSessions, startKeepAllRepair, wakeAfterKeepAllRepair, type KeepAllOutcome, type KeepAllRepairDeps, type KeepAllRepairGate,
} from "./keepall-unwedge.ts";
import { runAfterListen, type AfterListenStep } from "../after-listen.ts";
import { CARRY_CHILD_CODE, recordChildRef } from "./lineage-types.ts";
import { drainRevokeMarkerBounded } from "./memory-revocation.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { markerWorkPending } from "./revoke-marker.ts";
import { flipAll } from "./testing/revoke-storm-fixture.ts";
import { testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

vi.mock("../db-busy.ts", async (original) => {
  const real = await original<typeof import("../db-busy.ts")>();
  return { ...real, beginBackground: vi.fn(real.beginBackground) };
});

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); try { flushCoalesced(); } catch { /* gone */ } closeDatabase(); });

const AUDIENCE_ONLY = 4, FORGET = 9, INST = "fuigo";
// the owner line that makes write-time lineage live on the file, at an lsn no Store-written line holds
let lineLsn = 100_000;
const nextLsn = () => (lineLsn += 10);
const app = () => new WritetimeFixture(database());
const store = () => new Store(() => ({ instanceId: INST, model: "m", effort: "medium", connectionId: "c" }));
const marks = (thread: string) => (database().prepare("SELECT native_session AS s, revoke_id AS r FROM memory_deny_session WHERE thread_id=? ORDER BY 1,2").all(thread) as Array<{ s: string; r: number }>).map(row => `${row.s}@${row.r}`);
const flagged = () => existsSync(join(DATA_DIR, MEMORY_REPAIRS_FILE)) && Boolean(JSON.parse(readFileSync(join(DATA_DIR, MEMORY_REPAIRS_FILE), "utf8"))[KEEPALL_UNWEDGE]);
const verdict = (thread: string, session: string, reader = CONTENT_SESSION_READER) => writetimeSessionVerdict(thread, INST, session, reader);

/** The repair as index.ts wires it, over a real Store: judged and cleared in one task, then the bots file flushed. */
function deps(s: Store, ownerThreads: ReadonlySet<string>, over: Partial<KeepAllRepairDeps> & { live?: Set<string> } = {}): KeepAllRepairDeps & { lines: string[] } {
  const lines: string[] = [];
  const ownerDirectThread = (thread: string) => ownerThreads.has(thread);
  return {
    lines,
    ownerSessions: () => ownerAudienceSessions(s.bots, ownerDirectThread),
    drain: () => false,
    markerPending: () => false,
    judgeAndClear: () => {
      const judged = judgeKeepAllCursors(s.bots, { ownerDirectThread, verdict: (t, i, session, reader) => writetimeSessionVerdict(t, i, session, reader === "content" ? CONTENT_SESSION_READER : AUDIENCE_SESSION_READER), revoked: memorySessionRevoked, liveThreads: over.live ?? new Set() });
      return { ...s.clearResumeCursors(judged.clears), keptChecking: judged.keptChecking, keptLive: judged.keptLive };
    },
    flush: () => flushCoalesced(join(DATA_DIR, "bots.json")),
    log: line => lines.push(line),
    warn: line => lines.push(`warn ${line}`),
    firstPauseMs: 1,
    ...over,
  };
}
const run = (s: Store, owners: ReadonlySet<string>, over: Parameters<typeof deps>[2] = {}, gate: KeepAllRepairGate = createKeepAllRepairGate(false)) => {
  const d = deps(s, owners, over);
  return { d, gate, done: startKeepAllRepair(database(), DATA_DIR, gate, d) };
};
/** An owner direct chat with a stored owner-audience cursor whose session holds an audience-only mark. */
function ownerChat(s: Store, f: WritetimeFixture, session = "s-1") {
  const bot = s.createBot();
  f.owner(bot.threadId, `o-${bot.id}`, nextLsn()).sessionLineage(bot.threadId, INST, session, 1, 4).ready(bot.threadId, true).denySession(bot.threadId, INST, session, AUDIENCE_ONLY);
  s.setResumeCursor(bot.id, INST, session, bot.threadId, "owner");
  return bot;
}

describe("the keep-all repair, sliced (ALL.eld250)", () => {
  it("6.1 the High: a session still 'checking' keeps its valid cursor; cursors wait for a drained marker", async () => {
    // rejects: clearing on anything but "shown" (index.ts before), and judging cursors with marker work left
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), bot = ownerChat(s, f);
    // a revoke whose marker work is more than one drain allowance: its pending window covers the session's last line
    f.job(7, 2).pending(bot.threadId, 2, 7);
    expect(verdict(bot.threadId, "s-1")).toEqual({ state: "checking", reason: "pending" });
    // an otherwise clearable cursor on another chat (a forget's mark): with marker work left it must stay too, and nothing is judged (Astra F2)
    const other = s.createBot();
    f.owner(other.threadId, "o-other", nextLsn()).ready(other.threadId, true).sessionLineage(other.threadId, INST, "gone", 1, 4).denySession(other.threadId, INST, "gone", FORGET);
    s.setResumeCursor(other.id, INST, "gone", other.threadId, "owner");
    expect(verdict(other.threadId, "gone").state).toBe("withheld");
    const owners = new Set([bot.threadId, other.threadId]);
    const judged = vi.fn();
    const real = deps(s, owners).judgeAndClear;
    const first = run(s, owners, { drain: () => true, judgeAndClear: () => { judged(); return real(); } });
    expect(await first.done).toBe("cursors-deferred");
    expect(judged).not.toHaveBeenCalled();
    expect(s.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBe("s-1");
    expect(s.taskByThread(other.id, other.threadId)?.resumeCursors[INST]).toBe("gone");
    expect(flagged()).toBe(false);
    expect(first.d.lines.at(-1)).toMatch(/drainLeft=true .*\(continues next start\)$/);
    // the runner finishes the marker: the next start judges the session "shown", keeps the cursor and flags
    f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=7").run(); f.db.prepare("UPDATE memory_revoke_jobs SET state='done' WHERE revoke_id=7").run();
    expect(verdict(bot.threadId, "s-1").state).toBe("shown");
    expect(await run(s, owners).done).toBe("repaired");
    expect(s.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBe("s-1");
    // judged on the drained marker: the withheld session's cursor goes now
    expect(s.taskByThread(other.id, other.threadId)?.resumeCursors[INST]).toBeUndefined();
    expect(flagged()).toBe(true);
  });

  it("6.1 (B11) a drained marker and a 'thread-not-ready' session (current door stamp, live lineage): the cursor stays", async () => {
    const f = app();
    const s = store(), bot = s.createBot();
    f.owner(bot.threadId, "o1", nextLsn()).sessionLineage(bot.threadId, INST, "s-1", 1, 4).ready(bot.threadId, false);
    s.setResumeCursor(bot.id, INST, "s-1", bot.threadId, "owner");
    // the session also holds a revoked receipt (current revision and epoch): "checking" must keep it before the clear predicate is read
    const meta = database().prepare("SELECT policy_revision AS p, deletion_epoch AS e FROM memory_meta WHERE id=1").get() as { p: number; e: number };
    f.receipt("rb", bot.threadId, INST, "s-1", { state: "revoked", policyRevision: meta.p, deletionEpoch: meta.e });
    expect(verdict(bot.threadId, "s-1")).toEqual({ state: "checking", reason: "thread-not-ready" });
    expect(memorySessionRevoked(bot.threadId, INST, "s-1")).toBe(true);
    const r = run(s, new Set([bot.threadId]));
    expect(await r.done).toBe("repaired");
    expect(s.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBe("s-1");
    expect(r.d.lines.at(-1)).toMatch(/cursors-cleared=0 .*cursorsKeptChecking=1 /);
  });

  it("6.2 (B13) withheld sessions are cleared and counted by slot; a slot changed between judgment and clear is skipped, counted apart", async () => {
    // rejects: a predicate that never clears, logging candidates instead of slots, and a clear that ignores the judged value
    const f = app();
    const s = store(), bot = s.createBot();
    f.owner(bot.threadId, "o1", nextLsn()).ready(bot.threadId, true);
    for (const [inst, session] of [["a", "x-1"], ["b", "x-2"], ["c", "x-3"]] as const) {
      f.sessionLineage(bot.threadId, inst, session, 1, 4).denySession(bot.threadId, inst, session, FORGET);
      s.setResumeCursor(bot.id, inst, session, bot.threadId, "owner");
    }
    expect(writetimeSessionVerdict(bot.threadId, "a", "x-1", CONTENT_SESSION_READER).state).toBe("withheld");
    // between the judgment and the clear, engine c moves to a new session (through the compare guard)
    const r = run(s, new Set([bot.threadId]), { judgeAndClear: () => {
      const judged = judgeKeepAllCursors(s.bots, { ownerDirectThread: () => true, verdict: (t, i, session) => writetimeSessionVerdict(t, i, session, CONTENT_SESSION_READER), revoked: memorySessionRevoked, liveThreads: new Set() });
      s.setResumeCursor(bot.id, "c", "x-new", bot.threadId, "owner");
      return { ...s.clearResumeCursors(judged.clears), keptChecking: judged.keptChecking, keptLive: judged.keptLive };
    } });
    expect(await r.done).toBe("repaired");
    const task = s.taskByThread(bot.id, bot.threadId)!;
    expect([task.resumeCursors.a, task.resumeCursors.b, task.resumeCursors.c]).toEqual([undefined, undefined, "x-new"]);
    expect(r.d.lines.at(-1)).toMatch(/cursors-cleared=2 .*cursorsSkippedChanged=1$/);
  });

  it("6.3 a live turn keeps a withheld cursor: a busy task, or its thread with work in flight", async () => {
    // rejects: dropping keep rule (b)
    const f = app();
    const s = store(), busy = s.createBot(), running = s.createBot();
    for (const bot of [busy, running]) {
      f.owner(bot.threadId, `o-${bot.id}`, nextLsn()).ready(bot.threadId, true).sessionLineage(bot.threadId, INST, "w", 1, 4).denySession(bot.threadId, INST, "w", FORGET);
      s.setResumeCursor(bot.id, INST, "w", bot.threadId, "owner");
    }
    s.taskByThread(busy.id, busy.threadId)!.busy = true;
    const r = run(s, new Set([busy.threadId, running.threadId]), { live: new Set([running.threadId]) });
    expect(await r.done).toBe("repaired");
    expect(s.taskByThread(busy.id, busy.threadId)?.resumeCursors[INST]).toBe("w");
    expect(s.taskByThread(running.id, running.threadId)?.resumeCursors[INST]).toBe("w");
    expect(r.d.lines.at(-1)).toMatch(/cursors-cleared=0 .*cursorsKeptLive=2 /);
  });

  it("6.4 slices: each its own commit, the loop runs between every pair and before Part B, the counters are cumulative", async () => {
    // rejects: one transaction for all threads, a missing yield, and a per-slice counter reset
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), owners = new Set<string>();
    for (let n = 0; n < 10; n++) owners.add(ownerChat(s, f, `s-${n}`).threadId);
    // a clock that ends each slice after 2 threads (each read moves it 10 ms; the budget is 20)
    let clock = 0;
    const order: string[] = [];
    let immediates = 0;
    const r = run(s, owners, {
      now: () => (clock += 10),
      nextTask: () => new Promise<void>(resolve => setImmediate(() => { immediates++; order.push("loop"); resolve(); })),
      onSlice: () => order.push("commit"),
      judgeAndClear: () => { order.push("partB"); return { cleared: 0, botsMoved: 0, skipped: 0, keptChecking: 0, keptLive: 0 }; },
    });
    expect(await r.done).toBe("repaired");
    expect(order).toEqual([...Array.from({ length: 5 }, () => ["loop", "commit"]).flat(), "loop", "partB"]);
    expect(immediates).toBe(6);
    expect(r.d.lines.at(-1)).toMatch(/removed=10 threads=10 .*slices=5 /);
    for (const thread of owners) expect(marks(thread)).toEqual([]);
  });

  it("6.5 the row bound is cumulative across slices: 'bounded', no flag, and the next run finishes and flags", async () => {
    // rejects: resetting the row count per slice
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), threads: string[] = [];
    for (let n = 0; n < 3; n++) {
      const bot = ownerChat(s, f, `a-${n}`);
      // a second owner-audience session on the thread: 2 rows each
      s.setResumeCursor(bot.id, "other", `b-${n}`, bot.threadId, "owner");
      f.sessionLineage(bot.threadId, "other", `b-${n}`, 1, 4).denySession(bot.threadId, "other", `b-${n}`, AUDIENCE_ONLY);
      threads.push(bot.threadId);
    }
    const owners = new Set(threads);
    const first = run(s, owners, { maxRows: 3, sliceMs: 0 });
    expect(await first.done).toBe("bounded");
    expect(flagged()).toBe(false);
    expect(threads.map(t => marks(t).length).sort()).toEqual([0, 0, 2]);
    expect(first.d.lines.at(-1)).toMatch(/removed=4 threads=2 .*\(continues next start\)$/);
    expect(await run(s, owners, { maxRows: 3, sliceMs: 0 }).done).toBe("repaired");
    expect(threads.map(t => marks(t).length)).toEqual([0, 0, 0]);
    expect(flagged()).toBe(true);
  });

  it("6.6 every slice runs under the startup source after an await, and opens its transaction with beginBackground", async () => {
    // rejects: launching outside withSource (r2 A2), and a bare BEGIN
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), bot = ownerChat(s, f);
    const begin = vi.mocked(dbBusy.beginBackground);
    begin.mockClear();
    const sources: Array<string | undefined> = [];
    const real = begin.getMockImplementation()!;
    begin.mockImplementation((db, op) => { sources.push(ioBudget.currentSource()); return real(db, op); });
    expect(ioBudget.currentSource()).toBeUndefined();
    expect(await run(s, new Set([bot.threadId])).done).toBe("repaired");
    expect(begin).toHaveBeenCalledWith(database(), "keepall-unwedge");
    expect(sources).toEqual(["startup"]);
    begin.mockImplementation(real);
  });

  it("6.7 a held lock after a DELETE and before COMMIT: the slice rolls back, is retried, and counts once; 8 in a row give up with no flag", async () => {
    // rejects: no rollback, a counter bumped before commit, and a missing end (the runner wake waits on `done`, any outcome)
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), bot = ownerChat(s, f);
    const db = database(), realExec = db.exec.bind(db);
    let busyCommits = 1, seenAtRetry: string[] | undefined;
    const exec = vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql === "COMMIT" && busyCommits > 0) { busyCommits--; throw Object.assign(new Error("database is locked"), { errcode: 5 }); }
      return realExec(sql);
    });
    const r = run(s, new Set([bot.threadId]), { writerGate: () => { seenAtRetry ??= marks(bot.threadId); return Promise.resolve(); } });
    expect(await r.done).toBe("repaired");
    // the rolled-back slice's row was still there when the retry waited
    expect(seenAtRetry).toEqual([`s-1@${AUDIENCE_ONLY}`]);
    expect(marks(bot.threadId)).toEqual([]);
    expect(r.d.lines.at(-1)).toMatch(/removed=1 threads=1 /);
    // every commit held: the eighth attempt gives up, nothing flagged, `done` resolves
    rmSync(join(DATA_DIR, MEMORY_REPAIRS_FILE), { force: true });
    f.denySession(bot.threadId, INST, "s-1", AUDIENCE_ONLY);
    busyCommits = 100;
    const gate = createKeepAllRepairGate(false);
    const second = run(s, new Set([bot.threadId]), {}, gate);
    expect(await second.done).toBe("gave-up");
    expect(await gate.done).toBe("gave-up");
    expect(gate.pending).toBe(false);
    expect(flagged()).toBe(false);
    expect(marks(bot.threadId)).toEqual([`s-1@${AUDIENCE_ONLY}`]);
    expect(second.d.lines.some(line => /met a held lock 8 times/.test(line))).toBe(true);
    exec.mockRestore();
  });

  it("6.8 the barrier: a pending gate holds an admission until the repair ends or once at the ceiling; a flagged gate never waits", async () => {
    // rejects: a gate made at the step (it would not be pending before listen) and two ceilings per admission
    vi.useFakeTimers();
    const gate = createKeepAllRepairGate(false);
    expect(gate.pending).toBe(true);
    let through = false;
    void keepAllRepairBarrier(gate).then(() => { through = true; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(through).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(through).toBe(true);
    // the repair ends: a later admission goes on at once
    let second = false;
    void keepAllRepairBarrier(gate).then(() => { second = true; });
    gate.finish("repaired");
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(true);
    const repaired = createKeepAllRepairGate(true);
    expect(repaired.pending).toBe(false);
    expect(await repaired.done).toBe("already");
    // finish and stop are idempotent
    repaired.finish("gave-up"); expect(await repaired.done).toBe("already");
    gate.stop(); gate.stop(); expect(gate.stopping).toBe(true);
  });

  it("6.1 (real drain, Astra F2) a real revoke marker bigger than one bounded drain pass: the pass leaves work, nothing is judged, the withheld cursor stays and no flag; once the runner finishes the marker the next pass judges once, clears and flags", async () => {
    // rejects: judging/clearing above the drainLeft return, a flag written while marker work remains, and ignoring marker work left
    const f = app(); f.cert(true);
    const s = store();
    const bot = s.createBot();
    f.owner(bot.threadId, "o-real", nextLsn()).ready(bot.threadId, true).sessionLineage(bot.threadId, INST, "gone", 1, 4).denySession(bot.threadId, INST, "gone", FORGET);
    s.setResumeCursor(bot.id, INST, "gone", bot.threadId, "owner");
    expect(verdict(bot.threadId, "gone").state).toBe("withheld");
    // a real forget of a record a delivered receipt cites 1500 times, then the install-wide flip: the marker has many slices of work
    const X = { kind: "record" as const, id: "rec-x", version: 1 };
    f.record(X.id, 1, "s-room");
    const T = "flip-t";
    f.owner(T, "u0", 9_999_000).reply(T, "r0", 9_999_001, { turnLsn: 9_999_000 });
    f.receipt("b0", T, INST, "sf");
    f.sessionLineage(T, INST, "sf", 9_999_000, 9_999_001);
    noteReceiptOutput(f.db, "b0", T, 9_999_001, { driverInstance: INST, nativeSession: "sf" });
    f.db.prepare("INSERT INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,0)")
      .run(testThreadNo(f.db, T), 9_999_001, 9_999_001, CARRY_CHILD_CODE.record, recordChildRef(X));
    f.db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id='b0'").run(JSON.stringify([{ id: X.id, version: 1 }, ...Array.from({ length: 1500 }, (_, i) => ({ id: `b0-cited-${i}`, version: 1 }))]));
    f.db.exec("BEGIN IMMEDIATE"); try { commitRevoke(f.db, { kind: "memory", ref: X, cause: "forget" }, { inline: false }); } finally { f.db.exec("COMMIT"); }
    flipAll(f);
    expect(markerWorkPending(f.db)).toBe(true);
    s.setResumeCursor(bot.id, INST, "gone", bot.threadId, "owner");
    const judged = vi.fn();
    const base = deps(s, new Set([bot.threadId]));
    const over: Partial<KeepAllRepairDeps> = {
      drain: file => drainRevokeMarkerBounded(file, { rows: 256, ms: 1_000_000 }, { background: true }),
      markerPending: markerWorkPending,
      judgeAndClear: () => { judged(); return base.judgeAndClear(); },
    };
    const first = run(s, new Set([bot.threadId]), over);
    expect(await first.done).toBe("cursors-deferred");
    expect(markerWorkPending(f.db)).toBe(true);
    expect(judged).not.toHaveBeenCalled();
    expect(s.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBe("gone");
    expect(flagged()).toBe(false);
    expect(first.d.lines.at(-1)).toMatch(/drainLeft=true .*\(continues next start\)$/);
    // the runner finishes the marker (the real bounded drain, a pass at a time)
    for (let n = 0; drainRevokeMarkerBounded(f.db, { rows: 1_000_000, ms: 1_000_000 }); n++) expect(n).toBeLessThan(1000);
    expect(markerWorkPending(f.db)).toBe(false);
    expect(verdict(bot.threadId, "gone").state).toBe("withheld");
    const second = run(s, new Set([bot.threadId]), over);
    expect(await second.done).toBe("repaired");
    expect(judged).toHaveBeenCalledTimes(1);
    expect(s.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBeUndefined();
    expect(flagged()).toBe(true);
  });

  it("6.9 through the real runAfterListen: the runner wakes once, only after the repair ends (repaired, gave-up, a launch that throws), at once for a repaired file, and never once stopping", async () => {
    // rejects: a wake before the repair (Astra F1: through the step coordinator, every outcome)
    const steps = (gate: KeepAllRepairGate, start: () => Promise<KeepAllOutcome>, wake: () => void): AfterListenStep[] => [
      { name: "keepallUnwedge", run: () => launchKeepAllRepair(gate, start, () => {}) },
      { name: "memoryRevocation", run: () => wakeAfterKeepAllRepair(gate, wake) },
    ];
    const opts = { first: Promise.resolve(), fallbackMs: 10, busyMs: 5, maxWaitMs: 2_000 };
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
    // a repair that ends later, with each end it can have
    for (const outcome of ["repaired", "gave-up", "stopped"] as const) {
      const gate = createKeepAllRepairGate(false), wake = vi.fn();
      let end!: () => void;
      const start = () => new Promise<KeepAllOutcome>(resolve => { end = () => { gate.finish(outcome); resolve(outcome); }; });
      await runAfterListen(steps(gate, start, wake), opts);
      await settle();
      expect(wake, outcome).not.toHaveBeenCalled();
      if (outcome === "stopped") gate.stop();
      end();
      await settle();
      expect(wake, outcome).toHaveBeenCalledTimes(outcome === "stopped" ? 0 : 1);
    }
    // a repaired file: no repair, the wake at once
    const flaggedGate = createKeepAllRepairGate(true), wakeNow = vi.fn(), never = vi.fn(() => new Promise<KeepAllOutcome>(() => {}));
    await runAfterListen(steps(flaggedGate, never, wakeNow), opts);
    expect(never).not.toHaveBeenCalled();
    expect(wakeNow).toHaveBeenCalledTimes(1);
    // the launch throws before the repair starts: the gate ends ("gave-up") and the wake follows
    const thrown = createKeepAllRepairGate(false), wakeAfterThrow = vi.fn();
    await runAfterListen(steps(thrown, () => { throw new Error("no database"); }, wakeAfterThrow), opts);
    await settle();
    expect(await thrown.done).toBe("gave-up");
    expect(wakeAfterThrow).toHaveBeenCalledTimes(1);
  });

  it("6.10 a shutdown during a retry pause: the repair ends 'stopped' before the database closes, writes nothing after stop, on the cleanup path and on the exit fallback", async () => {
    // rejects: a join outside the writer stop (r2 item 9), a wait not raced with stopping, and a stopping check placed only before a wait
    for (const path of ["cleanup", "exit"] as const) {
      flushCoalesced(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
      const s = store(), bot = ownerChat(s, f), other = ownerChat(s, f, "s-2");
      const db = database(), realExec = db.exec.bind(db);
      const events: string[] = [];
      let paused!: () => void;
      const atPause = new Promise<void>(resolve => { paused = resolve; });
      let repairing = false;
      // Every repair commit is held. The independent search reset (5d5a791f19) must not be faulted or counted here.
      // The repair sits in its retry pause (a long one: only the stop latch ends it)
      const exec = vi.spyOn(db, "exec").mockImplementation((sql: string) => { if (sql === "COMMIT" && repairing) { repairing = false; events.push("commit-try"); throw Object.assign(new Error("database is locked"), { errcode: 5 }); } return realExec(sql); });
      const gate = createKeepAllRepairGate(false);
      const r = run(s, new Set([bot.threadId, other.threadId]), { begin: (db, op) => { dbBusy.beginBackground(db, op); repairing = true; }, firstPauseMs: 60_000, writerGate: () => { if (events.includes("commit-try")) setTimeout(paused, 20); return Promise.resolve(); } }, gate);
      await atPause;
      // An unrelated serving transaction during the pause must neither receive the repair's fault nor inflate its attempts.
      expect(repairing).toBe(false);
      expect(() => { db.exec("BEGIN"); db.exec("COMMIT"); }).not.toThrow();
      expect(events.filter(e => e === "commit-try")).toHaveLength(1);
      void gate.done.then(outcome => events.push(`done:${outcome}`));
      // the runner's wake is registered behind the repair (B7): no wake may follow stop() (Astra F1)
      const wake = vi.fn();
      wakeAfterKeepAllRepair(gate, wake);
      const closeDb = vi.fn(() => { events.push("closeDatabase"); });
      const writers = createDataWriterGate(async () => { await joinKeepAllRepair(gate); closeDb(); return true; }, () => {});
      let exited!: () => void;
      const exitedP = new Promise<void>(resolve => { exited = resolve; });
      const shutdown = createGracefulShutdown({
        onStart: () => gate.stop(),
        cleanup: path === "cleanup" ? [async () => { await writers.stop(); }] : [() => new Promise<void>(() => {})],
        exit: () => { if (path === "exit") void writers.stop().finally(exited); else exited(); },
        timeoutMs: path === "exit" ? 50 : 6_000,
      });
      shutdown();
      expect(gate.stopping).toBe(true);
      await exitedP;
      expect(await r.done).toBe("stopped");
      for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(wake).not.toHaveBeenCalled();
      expect(events.indexOf("done:stopped")).toBeGreaterThan(-1);
      expect(events.indexOf("done:stopped")).toBeLessThan(events.indexOf("closeDatabase"));
      // nothing after stop: one held commit try, no flag, the marks untouched
      expect(events.filter(e => e === "commit-try")).toHaveLength(1);
      expect(flagged()).toBe(false);
      exec.mockRestore();
      expect(marks(bot.threadId).length + marks(other.threadId).length).toBe(2);
    }
  });

  it("6.10 a stop that lands inside the yield before Part B: Part B never runs, nothing is cleared, flushed or flagged", async () => {
    // rejects: a stopping check placed only before a wait (Part B would start on the stale check)
    const s = store(), bot = s.createBot();
    s.setResumeCursor(bot.id, INST, "w", bot.threadId, "owner");
    const gate = createKeepAllRepairGate(false);
    const ran: string[] = [];
    const r = run(s, new Set([bot.threadId]), {
      nextTask: () => { gate.stop(); return Promise.resolve(); },
      judgeAndClear: () => { ran.push("judge"); return { cleared: 0, botsMoved: 0, skipped: 0, keptChecking: 0, keptLive: 0 }; },
      flush: () => { ran.push("flush"); },
    }, gate);
    expect(await r.done).toBe("stopped");
    expect(ran).toEqual([]);
    expect(flagged()).toBe(false);
  });

  it("6.11 a flush failure: 'gave-up' and no flag; a fresh Store shows the pre-repair cursors; a second run clears and flags, and a fresh Store shows both", async () => {
    // rejects: flag before flush (r2 item 10)
    const f = app();
    const s = store(), bot = s.createBot();
    f.owner(bot.threadId, "o1", nextLsn()).ready(bot.threadId, true).sessionLineage(bot.threadId, INST, "w", 1, 4).denySession(bot.threadId, INST, "w", FORGET);
    s.setResumeCursor(bot.id, INST, "w", bot.threadId, "owner");
    flushCoalesced();
    const r = run(s, new Set([bot.threadId]), { flush: () => { throw new Error("disk full"); } });
    expect(await r.done).toBe("gave-up");
    expect(flagged()).toBe(false);
    // the process dies here: its deferred bots.json write is lost with it
    cancelCoalesced(join(DATA_DIR, "bots.json"));
    expect(keepAllUnwedged(database(), DATA_DIR)).toBe(false);
    // the cleared cursor never reached disk (a crash here: the next start judges again)
    expect(store().taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBe("w");
    const again = store();
    expect(await run(again, new Set([bot.threadId])).done).toBe("repaired");
    const fresh = store();
    expect(fresh.taskByThread(bot.id, bot.threadId)?.resumeCursors[INST]).toBeUndefined();
    expect(flagged()).toBe(true);
  });

  it("6.15 (B12) only an owner-audience cursor's audience-only mark goes; a non-owner session's mark on the same thread stays, its audience verdict unchanged", async () => {
    // rejects: the thread-wide delete for a non-owner session
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), bot = ownerChat(s, f, "own");
    // a channel person's session on the same thread (another audience), and a session with no stored cursor
    s.setResumeCursor(bot.id, "member", "theirs", bot.threadId, "person-1:b:1|x2:0:home:general:000000000000");
    f.sessionLineage(bot.threadId, "member", "theirs", 1, 4).denySession(bot.threadId, "member", "theirs", AUDIENCE_ONLY).denySession(bot.threadId, INST, "uncursored", AUDIENCE_ONLY);
    const before = writetimeSessionVerdict(bot.threadId, "member", "theirs", AUDIENCE_SESSION_READER);
    expect(before.state).toBe("withheld");
    expect(await run(s, new Set([bot.threadId])).done).toBe("repaired");
    expect(marks(bot.threadId)).toEqual([`theirs@${AUDIENCE_ONLY}`, `uncursored@${AUDIENCE_ONLY}`]);
    expect(writetimeSessionVerdict(bot.threadId, "member", "theirs", AUDIENCE_SESSION_READER)).toEqual(before);
  });

  it("6.15 (B12 a) a thread whose rows sit at a slice edge goes wholly in one slice", async () => {
    // rejects: a slice that splits a thread
    const f = app(); f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_ONLY);
    const s = store(), first = ownerChat(s, f, "a"), edge = ownerChat(s, f, "b");
    for (const n of [1, 2, 3]) { s.setResumeCursor(edge.id, `e${n}`, `b${n}`, edge.threadId, "owner"); f.sessionLineage(edge.threadId, `e${n}`, `b${n}`, 1, 4).denySession(edge.threadId, `e${n}`, `b${n}`, AUDIENCE_ONLY); }
    const seen: number[][] = [];
    // the budget runs out right after the first thread, so the second thread starts the next slice and all four of its rows go there
    let clock = 0;
    const r = run(s, new Set([first.threadId, edge.threadId]), { now: () => (clock += 10), sliceMs: 10, onSlice: () => seen.push([marks(first.threadId).length, marks(edge.threadId).length]) });
    expect(await r.done).toBe("repaired");
    // two slices, one thread each; after every commit the edge thread holds all four rows or none
    expect(seen).toHaveLength(2);
    expect(seen.every(([, e]) => e === 0 || e === 4)).toBe(true);
    expect(seen.at(-1)).toEqual([0, 0]);
  });
});
