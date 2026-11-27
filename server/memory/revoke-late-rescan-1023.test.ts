// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable D3 (MAIN-RULING 2026-11-26T22:27:29Z "late-child rescan = part of the same background settle";
// 2026-11-27T01:12:43Z "the owner turn reads durable rows only, the background runner does the rescan").
// Owners: the note at write (revoke-commit.ts inheritMarks, lateNote) and the rescan (revoke-commit.ts rescanLateChildren, run by
// revoke-marker.ts advance at the hold step) = q1023-denyfable; the walk and its handlers = revoke-marker.ts, unchanged; rulings = MAIN.
//
// The gap (FABLE c096551b81 H2, OPUS H3): a source with an anchor line takes no row of its own; its mark is its line's row, written when
// the line node pops, after the source's own evidence scan has ended. A record extracted from that source in between finds no revoke at
// its write (it is only held under the window), the scan has passed it, and so nothing walks it: what was derived from it, and a reply
// that read it, in the same write are held until the job's tidy and then read SHOWN to every reader, for good.
// Entry points: the real commit (commitRevoke, walk left to the runner), the real marker slices (markerSlice, the paced runner's step),
// the writers' own inherit calls (inheritEdges, the copy sites' call; inheritMarks, lineage-write.ts carryOnto's call) and the production
// readers a room turn uses (memoryLookup, denyLookup with the content reader).
// RED on d2c1083fbc at each W-D3 row (the child reads "shown" once the job is done); the G rows are green on both sides.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as commit from "./revoke-commit.ts";
import { denyLookup, memoryLookup } from "./deny-read.ts";
import { closeWaitedPending } from "./memory-revocation.ts";
import { memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const SCOPE = "s-late";
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const rec = (id: string): MemoryRef => ({ kind: "record", id, version: 1, scopeId: SCOPE });
const recordState = (db: Db, id: string) => memoryLookup(db, [rec(id)], CONTENT).get(memoryRefKey(rec(id)))!.state;
const lineState = (db: Db, T: string, id: string) => denyLookup(db, { threadId: T, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)!.state;
const notes = (db: Db) => n(db, "SELECT count(*) AS n FROM memory_revoke_reached WHERE thread_id>='late:' AND thread_id<'late;'");
const active = (db: Db) => n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')");

beforeEach(() => { marker.setScopeFlowEdgesRecorded(true); commit.INHERIT_CLOSE.inline = true; });
afterEach(() => { marker.setScopeFlowEdgesRecorded(true); });

/** "orig" (anchored at owner line A-1) was brought into "copy" (anchored at owner line B-10), which record "rec" rests on. `extra`
 * more copies of "orig" follow "copy" in the walk (N: the walk is long, the gap wide). The owner forgets "orig"; the walk is left to
 * the runner and stepped a row at a time until "copy" has been walked (its evidence scan ended) and its line's row is not written yet. */
function gap(extra = 0): { fx: WritetimeFixture; db: Db; R: number } {
  const fx = new WritetimeFixture(); fx.cert(true);
  const db = fx.db;
  fx.scope(SCOPE).owner("A", "A-1", 1).owner("B", "B-10", 10).owner("Z", "Z-20", 20);
  fx.source("orig", SCOPE, { thread: "A", message: "A-1" }).source("copy", SCOPE, { thread: "B", message: "B-10" }).source("clean-src", SCOPE, { thread: "Z", message: "Z-20" });
  db.prepare("INSERT OR IGNORE INTO memory_source_origins(origin_id,bring_in_id) VALUES('orig','copy')").run();
  for (let k = 0; k < extra; k++) {
    fx.owner("B", `B-x${k}`, 30 + k).source(`copy-${String(k).padStart(4, "0")}`, SCOPE, { thread: "B", message: `B-x${k}` });
    db.prepare("INSERT OR IGNORE INTO memory_source_origins(origin_id,bring_in_id) VALUES('orig',?)").run(`copy-${String(k).padStart(4, "0")}`);
  }
  fx.record("rec", 1, SCOPE, ["copy"]);
  db.exec("INSERT OR REPLACE INTO memory_late_build(name,ready,cursor) VALUES('evidence',1,NULL),('origins',1,NULL)");
  db.prepare("UPDATE memory_lsn SET next=5000 WHERE id=1").run();
  const R = tx(db, () => commit.commitRevoke(db, { kind: "memory", ref: { kind: "source", id: "orig" }, cause: "forget" }, { inline: false }));
  expect(R).toBeGreaterThan(0);
  const walked = () => Boolean(db.prepare("SELECT 1 FROM memory_revoke_reached WHERE revoke_id=? AND thread_id='s:copy'").get(R))
    && !db.prepare("SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%\"kind\":\"source\",\"id\":\"copy\"}'").get(R);
  for (let k = 0; k < 20_000 && !walked(); k++) slice(db, 1);
  // the gap, as the finding states it: "copy" walked, its mark (its anchor line's row) not written, the job still marking
  expect(walked(), "setup: the walk passed the copy").toBe(true);
  expect(n(db, "SELECT count(*) AS n FROM memory_deny_point WHERE thread_id='B' AND lsn=10"), "setup: the copy's line is not marked yet").toBe(0);
  expect(String(db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.phase), "setup: the job is still marking").toBe("mark");
  return { fx, db, R };
}
/** One extraction's write in the gap, as its writers make it: record "late" extracted from "copy", "derived" derived from "late", a reply
 * C-201 of a turn that read "late", and (guards) "clean" extracted from an untouched source with a reply D-301 that read it. */
function lateWrite(db: Db): void {
  tx(db, () => {
    const fx = new WritetimeFixture(db);
    fx.record("late", 1, SCOPE, ["copy"]);
    commit.inheritEdges(db, { id: "late", version: 1 });
    fx.record("derived", 1, SCOPE, []).derive("late", 1, "derived", 1);
    commit.inheritEdges(db, { id: "derived", version: 1 });
    fx.owner("C", "C-200", 5200).reply("C", "C-201", 5201, { turnLsn: 5200 });
    commit.inheritMarks(db, { kind: "turn", threadId: "C", lsn: 5200, line: 5201, holdFrom: 5201 }, [{ kind: "memory", ref: rec("late") }]);
    fx.record("clean", 1, SCOPE, ["clean-src"]);
    commit.inheritEdges(db, { id: "clean", version: 1 });
    fx.owner("D", "D-300", 5300).reply("D", "D-301", 5301, { turnLsn: 5300 });
    commit.inheritMarks(db, { kind: "turn", threadId: "D", lsn: 5300, line: 5301, holdFrom: 5301 }, [{ kind: "memory", ref: rec("clean") }]);
    db.prepare("UPDATE memory_lsn SET next=max(next,6000) WHERE id=1").run();
  });
}

describe("D3: a child written under a revoke's window before its parent's mark is looked up again by the background job", () => {
  for (const extra of [0, 10, 1000]) {
    it(`W-D3 (N=${extra} more copies): what was derived from a record extracted in the gap is withheld from a room reader once the job is done`, () => {
      const { fx, db } = gap(extra);
      try {
        lateWrite(db);
        // never shown on the way: held under the window from its write
        expect(recordState(db, "derived")).not.toBe("shown");
        drainAll(db);
        expect(active(db)).toBe(0);
        expect(recordState(db, "rec")).toBe("withheld");
        expect(recordState(db, "derived"), "derived from a record that rests on the forgotten source").toBe("withheld");
      } finally { fx.close(); }
    });
    it(`W-D3-REPLY (N=${extra} more copies): a reply of a turn that read a record extracted in the gap is withheld from a room reader once the job is done`, () => {
      const { fx, db } = gap(extra);
      try {
        lateWrite(db);
        expect(lineState(db, "C", "C-201")).not.toBe("shown");
        drainAll(db);
        expect(active(db)).toBe(0);
        expect(lineState(db, "C", "C-201"), "the reply rests on the forgotten source").toBe("withheld");
      } finally { fx.close(); }
    });
  }
  it("W-D3-RESTART: the notes are durable: the file reopened between slices, the job still marks the late children", () => {
    const { fx, db } = gap(10);
    const file = (db as unknown as { location(): string }).location();
    try {
      lateWrite(db);
      for (let k = 0; k < 3; k++) slice(db, 2);
      db.close();
      const again = new DatabaseSync(file);
      try {
        drainAll(again, 8);
        expect(active(again)).toBe(0);
        expect(lineState(again, "C", "C-201")).toBe("withheld");
        expect(recordState(again, "derived")).toBe("withheld");
      } finally { again.close(); }
    } finally { fx.close(); }
  });
  it("G-D3-CLEAN: a child of an untouched parent written in the same gap is held, then shown, and no note outlives the job", () => {
    const { fx, db } = gap(10);
    try {
      lateWrite(db);
      expect(notes(db), "the children were noted under the revoke in flight").toBeGreaterThan(0);
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(recordState(db, "clean")).toBe("shown");
      expect(lineState(db, "D", "D-301")).toBe("shown");
      expect(notes(db), "no note or payload row is left").toBe(0);
    } finally { fx.close(); }
  });
  // q1023-leftout (real copy fe46050e8c: 4474 revokes in flight, 5-23 MiB written by each appended line, 78-110 MiB in a turn minute):
  // a child is noted ONCE at its write however many revokes hold it; each job reads the one list at its hold step from its own cursor.
  // K more forgets are committed over the same scope and left to the runner, so each of them holds the children written next.
  const moreInFlight = (db: Db, K: number): void => {
    for (let k = 0; k < K; k++) {
      const id = `held-${String(k).padStart(4, "0")}`;
      new WritetimeFixture(db).owner("H", `H-${k}`, 100 + k).source(id, SCOPE, { thread: "H", message: `H-${k}` });
      expect(tx(db, () => commit.commitRevoke(db, { kind: "memory", ref: { kind: "source", id }, cause: "forget" }, { inline: false }))).toBeGreaterThan(0);
    }
  };
  for (const K of [10, 1000]) {
    it(`W-LATE-ONE (K=${K} more revokes in flight): one write notes each child once, not once per revoke that holds it`, () => {
      const { fx, db } = gap(0);
      try {
        moreInFlight(db, K);
        expect(active(db), "setup: the revokes are in flight").toBe(K + 1);
        lateWrite(db);
        // lateWrite writes five children (late, derived, the C turn, clean, the D turn): at most one row each, whatever K is
        expect(notes(db), "setup: the children were noted").toBeGreaterThan(0);
        expect(notes(db), "late rows written by one extraction's write").toBeLessThanOrEqual(5);
      } finally { fx.close(); }
    });
  }
  it("W-LATE-MANY (K=10 more revokes in flight): every job reads the shared notes; the late children of the forgotten source are withheld, the clean ones shown, no note left", () => {
    const { fx, db } = gap(0);
    try {
      moreInFlight(db, 10);
      lateWrite(db);
      expect(recordState(db, "derived")).not.toBe("shown");
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(recordState(db, "derived"), "derived from a record that rests on the forgotten source").toBe("withheld");
      expect(lineState(db, "C", "C-201"), "the reply rests on the forgotten source").toBe("withheld");
      expect(recordState(db, "clean")).toBe("shown");
      expect(lineState(db, "D", "D-301")).toBe("shown");
      expect(notes(db), "no note is left").toBe(0);
    } finally { fx.close(); }
  });
  it("W-LATE-ORDER: the notes are kept in write order, so a job's place in them is never ahead of a later write (a child with an older lsn of its own is still read)", () => {
    const { fx, db } = gap(0);
    try {
      moreInFlight(db, 3);
      // two turns that read "rec" (held under the forget in flight, its mark not written yet); the second turn's own lsn is the older one
      tx(db, () => {
        const w = new WritetimeFixture(db);
        w.owner("C", "C-200", 5200).reply("C", "C-201", 5201, { turnLsn: 5200 });
        commit.inheritMarks(db, { kind: "turn", threadId: "C", lsn: 5200, line: 5201, holdFrom: 5201 }, [{ kind: "memory", ref: rec("rec") }]);
      });
      tx(db, () => {
        const w = new WritetimeFixture(db);
        w.owner("D", "D-300", 300).reply("D", "D-301", 301, { turnLsn: 300 });
        commit.inheritMarks(db, { kind: "turn", threadId: "D", lsn: 300, line: 301, holdFrom: 301 }, [{ kind: "memory", ref: rec("rec") }]);
      });
      const order = (db.prepare("SELECT thread_id FROM memory_revoke_reached WHERE thread_id>='late:' AND thread_id<'late;' ORDER BY thread_id").all() as Array<{ thread_id: string }>)
        .map(row => /^late:\d{16}:\d{8}:[0-9a-f]{32}:(\{[\s\S]*)$/.exec(row.thread_id)?.[1]).filter((body): body is string => body !== undefined).map(body => (JSON.parse(body) as { c: { lsn: number } }).c.lsn);
      expect(order, "the notes in key order are the writes in the order they were made").toEqual([5200, 300]);
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(lineState(db, "C", "C-201")).toBe("withheld");
      expect(lineState(db, "D", "D-301"), "the reply written second, with the older lsn, rests on the forgotten source too").toBe("withheld");
      expect(notes(db)).toBe(0);
    } finally { fx.close(); }
  });
  it("W-LATE-LAST: the last revoke in flight removes the notes it has read, and a note written next under the same lsn head (its key taken again) is still looked up before it goes", () => {
    const { fx, db, R } = gap(0);
    const judged = () => Number((marker.LATE_RESCAN as { judged?: number }).judged ?? 0);
    const head = () => Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()?.next);
    // a write that takes no lsn (a record's edges), held under the revoke: its note is counted under the store's lsn head as it stands
    const noted = (id: string) => tx(db, () => { new WritetimeFixture(db).record(id, 1, SCOPE, ["clean-src"]); commit.inheritEdges(db, { id, version: 1 }); });
    try {
      const at = head();
      noted("clean-a"); noted("clean-b");
      expect(notes(db), "setup: two children noted").toBe(2);
      // step the only revoke in flight until it has read and removed both notes and still stands at its hold step (not tidied)
      for (let k = 0; k < 50_000 && !(notes(db) === 0 && String(db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.phase) === "hold"); k++) slice(db, 1);
      expect(notes(db), "setup: the notes are read and removed").toBe(0);
      expect(String(db.prepare("SELECT phase||'/'||state AS s FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.s), "setup: the revoke still stands at its hold step").toBe("hold/active");
      noted("clean-c");
      expect(head(), "setup: no write took an lsn, so the third note is the first under the same head again").toBe(at);
      expect(notes(db), "setup: the child was noted").toBe(1);
      const before = judged();
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(notes(db)).toBe(0);
      expect(judged() - before, "the note written after the removal was looked up, not removed unread").toBe(1);
      expect(recordState(db, "clean-c")).toBe("shown");
    } finally { fx.close(); }
  });
  // The waiters' early close (memory-revocation.ts closeWaitedPending, READY_REVOKE; callers fence-pending.ts and the runner) took "no
  // frontier row, no hold row" for "every mark written". A job whose walk has ended with late notes it has not looked up yet matches that,
  // so the close deleted the pending rows that hold the late children and a room reader read them shown until the rescan. (The witness is
  // q1023-denyfable's W-D3-CLOSE, 75fdd87f1b, on the shared list: the notes are counted under LATE_REVOKE, not under the job.)
  it("W-D3-CLOSE: a waiter's early close does not take the pending rows of a job whose late notes are not looked up yet", () => {
    const { fx, db, R } = gap(0);
    const pendingRows = () => n(db, "SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=?1)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=?1) AS n", R);
    const frontier = () => n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=?", R);
    const close = () => closeWaitedPending(db, ["A", "B", "C", "D", "Z"], [SCOPE]);
    try {
      lateWrite(db);
      // the walk's own marks, a row at a time, up to its last: nothing left to walk, the late children not looked up again yet
      for (let k = 0; k < 20_000 && frontier(); k++) slice(db, 1);
      expect(frontier(), "setup: the walk has written its last mark").toBe(0);
      expect(String(db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.state), "setup: the job is not done").toBe("active");
      expect(notes(db), "setup: the late children are noted and not looked up yet").toBeGreaterThan(0);
      const held = pendingRows();
      expect(held, "setup: the job's window is open").toBeGreaterThan(0);
      expect(lineState(db, "C", "C-201"), "setup: the late reply is held under the window").not.toBe("shown");
      close();
      expect(pendingRows(), "the early close leaves the window of a job that still owes its late children a lookup").toBe(held);
      expect(lineState(db, "C", "C-201"), "the late reply is not shown to a room reader before its lookup").not.toBe("shown");
      expect(recordState(db, "derived"), "nor what was derived from the late record").not.toBe("shown");
      // the lookup done and the marks it owed walked: the same close is allowed again, and the children are withheld by their own marks
      for (let k = 0; k < 20_000 && (frontier() || notes(db)); k++) slice(db, 1);
      expect(notes(db), "the late notes were looked up").toBe(0);
      if (pendingRows()) expect(close(), "with no note left the early close is taken").toBe(true);
      expect(pendingRows(), "the window is closed once nothing is owed").toBe(0);
      expect(lineState(db, "C", "C-201")).toBe("withheld");
      expect(recordState(db, "derived")).toBe("withheld");
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(lineState(db, "C", "C-201")).toBe("withheld");
    } finally { fx.close(); }
  });
  it("G-D3-QUIET: a write with no revoke in flight notes nothing", () => {
    const fx = new WritetimeFixture(); fx.cert(true);
    const db = fx.db;
    try {
      fx.scope(SCOPE).owner("Z", "Z-20", 20).source("clean-src", SCOPE, { thread: "Z", message: "Z-20" });
      tx(db, () => { new WritetimeFixture(db).record("clean", 1, SCOPE, ["clean-src"]); commit.inheritEdges(db, { id: "clean", version: 1 }); });
      expect(notes(db)).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_reached")).toBe(0);
    } finally { fx.close(); }
  });
});
