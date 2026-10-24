// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-DRAIN-V2 Option B (1.0.4): a late child of a denied parent takes its deny_line row at its write (2.3), writeRange keeps the larger
// cap (2.4). T3: a turn child written after a job's cap, whose parent the job denied, read "shown" after the job's tidy on the active-in-mark
// and done-retained paths (the walk skipped the node, or capped the turn's range below the output); every path now withholds it, the line
// child and the patched output too, across a restart mid-drain and under the vendored 1.0.3 marker (F11, T4d).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as commit from "./revoke-commit.ts";
import * as m103 from "./testing/legacy-lineage/revoke-marker-103.ts";
import { denyLookup } from "./deny-read.ts";
import { CARRY_CHILD_CODE, lineChildRef, turnChildRef } from "./lineage-types.ts";
import { CONTENT, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const verdict = (db: Db, T: string, id: string, author: "owner" | "generated" = "generated") => denyLookup(db, { threadId: T, lines: [{ messageId: id, author }] }, CONTENT).get(id)!.state;
const jobRow = (db: Db, id: number) => db.prepare("SELECT state,phase,started_lsn FROM memory_revoke_jobs WHERE revoke_id=?").get(id) as { state: string; phase: string; started_lsn: number } | undefined;

function carry(db: Db, P: string, from: number, to: number, child: { line: [string, number] } | { turn: [string, number] }): void {
  const row = "line" in child ? [CARRY_CHILD_CODE.line, lineChildRef(child.line[1]), testThreadNo(db, child.line[0])] : [CARRY_CHILD_CODE.turn, turnChildRef(child.turn[1]), testThreadNo(db, child.turn[0])];
  db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)").run(testThreadNo(db, P), to, from, row[0]!, row[1]!, row[2]!);
}

beforeEach(() => { marker.setScopeFlowEdgesRecorded(true); m103.setScopeFlowEdgesRecorded(true); });
afterEach(() => { marker.setScopeFlowEdgesRecorded(true); });

describe("T3: a late child of a deleted conversation is withheld whatever job row marked its parent (2.3)", () => {
  // T (deleted) carried its reply 2 into T2's reply 11; later T2's turn at head 200 quotes line 11 (its prompt carried [11, 11]) and
  // replies at 201; a clean turn at 300 / 301 follows. 201 rests on the deleted conversation; 301 does not.
  function store(): { fx: WritetimeFixture; db: Db } {
    const fx = new WritetimeFixture(); fx.cert(true);
    const db = fx.db;
    fx.owner("T", "T-1", 1).reply("T", "T-2", 2, { turnLsn: 1 }).owner("T", "T-3", 3).reply("T", "T-4", 4, { turnLsn: 3 });
    fx.owner("T2", "T2-10", 10).reply("T2", "T2-11", 11, { turnLsn: 10 });
    fx.owner("T3", "T3-20", 20).reply("T3", "T3-21", 21, { turnLsn: 20 });
    carry(db, "T", 2, 2, { line: ["T2", 11] });
    db.prepare("UPDATE memory_lsn SET next=100 WHERE id=1").run();
    return { fx, db };
  }
  type Shape = "turn" | "patched" | "line";
  /** The late turn in T2 as lineage-write.ts writes it: the reply row, the turn's carry from [11, 11], then inheritMarks for the turn
   * (`turn`: a fresh output, holdFrom; `patched`: a reply patched in place, no holdFrom, the line's own lsn; `line`: the reply itself
   * carries [11, 11] as a line child). */
  function lateTurn(db: Db, shape: Shape = "turn"): void {
    tx(db, () => {
      db.prepare("UPDATE memory_lsn SET next=max(next,200) WHERE id=1").run();
      const fx = new WritetimeFixture(db);
      fx.owner("T2", "T2-200", 200).reply("T2", "T2-201", 201, { turnLsn: 200 });
      if (shape === "line") {
        carry(db, "T2", 11, 11, { line: ["T2", 201] });
        commit.inheritMarks(db, { kind: "line", threadId: "T2", lsn: 201 }, [], [{ threadId: "T2", from: 11, to: 11 }]);
      } else {
        carry(db, "T2", 11, 11, { turn: ["T2", 200] });
        commit.inheritMarks(db, { kind: "turn", threadId: "T2", lsn: 200, line: 201, ...(shape === "turn" ? { holdFrom: 201 } : {}) }, [], [{ threadId: "T2", from: 11, to: 11 }]);
      }
    });
    tx(db, () => {
      db.prepare("UPDATE memory_lsn SET next=max(next,300) WHERE id=1").run();
      const fx = new WritetimeFixture(db);
      fx.owner("T2", "T2-300", 300).reply("T2", "T2-301", 301, { turnLsn: 300 });
    });
  }
  const paths = ["active-mark", "done-retained", "done-pruned"] as const;
  type Path = typeof paths[number];
  /** The deletion of T on one job-row path, then 11 withheld: the walk entered T2 (active-mark, J still marking), J done (done-retained), or J
   * done and pruned by a later revoke (done-pruned, revoke-marker.ts pruneFinished keeps only the newest). */
  function deleteT(db: Db, path: Path): number {
    const J = tx(db, () => commit.commitRevoke(db, { kind: "thread", threadId: "T", cause: "delete-conversation" }, { inline: false }));
    expect(J).toBeGreaterThan(0);
    if (path === "active-mark") {
      for (let k = 0; k < 400 && !db.prepare("SELECT 1 FROM memory_revoke_reached WHERE revoke_id=? AND thread_id='T2'").get(J); k++) slice(db, 4);
      expect(db.prepare("SELECT 1 FROM memory_revoke_reached WHERE revoke_id=? AND thread_id='T2'").get(J)).toBeTruthy();
      expect(jobRow(db, J)?.phase).toBe("mark");
    } else {
      drainAll(db);
      expect(jobRow(db, J)?.state).toBe("done");
      if (path === "done-pruned") {
        tx(db, () => commit.commitRevoke(db, { kind: "line", threadId: "T3", messageIds: ["T3-21"], cause: "forget" }, { inline: false }));
        drainAll(db);
        expect(jobRow(db, J)).toBeUndefined();
      } else expect(jobRow(db, J)).toBeTruthy();
    }
    expect(verdict(db, "T2", "T2-11")).toBe("withheld");
    return J;
  }
  const settled = (db: Db) => {
    expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')")).toBe(0);
    expect(verdict(db, "T2", "T2-11")).toBe("withheld");
    expect(verdict(db, "T2", "T2-301")).toBe("shown");
    expect(verdict(db, "T2", "T2-201")).toBe("withheld");
  };
  for (const path of paths) for (const shape of ["turn", "patched", "line"] as const) {
    it(`path ${path}, ${shape} child: 201 withheld after every job is done, 301 shown, 11 withheld`, () => {
      const { fx, db } = store();
      try {
        deleteT(db, path);
        lateTurn(db, shape);
        expect(verdict(db, "T2", "T2-201")).toBe("withheld"); // from its write on (2.3), not only held
        drainAll(db);
        settled(db);
      } finally { fx.close(); }
    });
  }
  for (const path of paths) {
    it(`path ${path}: a restart mid-drain (the file reopened between slices) changes nothing`, () => {
      const { fx, db } = store();
      const file = (db as unknown as { location(): string }).location();
      try {
        deleteT(db, path);
        lateTurn(db);
        for (let k = 0; k < 3; k++) slice(db, 4);
        db.close();
        const again = new DatabaseSync(file);
        try { drainAll(again, 8); settled(again); } finally { again.close(); }
      } finally { fx.close(); }
    });
    it(`path ${path}: a downgrade to the 1.0.3 marker after the write drains to done with 201 withheld (F11)`, () => {
      const { fx, db } = store();
      try {
        deleteT(db, path);
        lateTurn(db);
        for (let k = 0; k < 2; k++) slice(db, 4);
        // the released 1.0.3 marker resumes the 1.0.4 file: its own pops, its own rows; the deny row written at 201's write stays
        let k = 0;
        for (; k < 200_000 && tx(db, () => m103.markerSlice(db, 64, Number.POSITIVE_INFINITY, null)); k++) { /* 1.0.3 slices */ }
        expect(k).toBeLessThan(200_000);
        settled(db);
        // and a 1.0.4 resuming the file afterwards finds nothing to do
        expect(drainAll(db)).toBe(0);
        settled(db);
      } finally { fx.close(); }
    });
  }
  it("Astra r4 residual: a late prefix child of T after T's range rows coalesced and its job row was pruned opens ONE inherit walk", () => {
    const { fx, db } = store();
    try {
      const J = deleteT(db, "done-pruned");
      // T was reached by many earlier revokes: with the deletion's own range row it holds 64 and they merge into one row of revoke -1
      tx(db, () => { for (let k = 1; k < 64; k++) marker.writeRange(db, 100_000 + k, "T", 1000 + k, 2000 + k, "forget"); });
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='T'")).toBe(1);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='T' AND revoke_id=-1")).toBe(1);
      // the deletion's receipt (a line row at FIRST_LSN under J) survives both
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='T' AND lsn=? AND revoke_id=?", Number.MIN_SAFE_INTEGER, J)).toBe(1);
      const jobsBefore = n(db, "SELECT count(*) AS n FROM memory_revoke_jobs");
      // T2's turn at 200 carries T's whole prefix (FIRST_LSN .. 4) and replies at 201
      tx(db, () => {
        db.prepare("UPDATE memory_lsn SET next=max(next,200) WHERE id=1").run();
        new WritetimeFixture(db).owner("T2", "T2-200", 200).reply("T2", "T2-201", 201, { turnLsn: 200 });
        carry(db, "T", Number.MIN_SAFE_INTEGER, 4, { turn: ["T2", 200] });
        commit.inheritMarks(db, { kind: "turn", threadId: "T2", lsn: 200, line: 201, holdFrom: 201 }, [], [{ threadId: "T", from: Number.MIN_SAFE_INTEGER, to: 4 }]);
      });
      // one walk, as the base opened for a coalesced parent: the receipt is not a denied line, so J is not re-created beside the fresh job
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs") - jobsBefore).toBe(1);
      expect(jobRow(db, J)).toBeUndefined();
      expect(verdict(db, "T2", "T2-201")).toBe("withheld");
      drainAll(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')")).toBe(0);
      expect(verdict(db, "T2", "T2-201")).toBe("withheld");
    } finally { fx.close(); }
  });
  for (const coalesced of [false, true]) {
    it(`Astra r5: a late prefix child carrying only T's owner line (no range row matches it) is still denied by the receipt${coalesced ? ", after coalescing" : ""}`, () => {
      const { fx, db } = store();
      try {
        const J = deleteT(db, "done-pruned");
        if (coalesced) tx(db, () => { for (let k = 1; k < 64; k++) marker.writeRange(db, 100_000 + k, "T", 1000 + k, 2000 + k, "forget"); });
        const jobsBefore = n(db, "SELECT count(*) AS n FROM memory_revoke_jobs");
        // T2's turn at 200 carries [FIRST_LSN, 1] of T: owner line T-1 alone (no turn_lsn, so the range rows' line test passes over it)
        tx(db, () => {
          db.prepare("UPDATE memory_lsn SET next=max(next,200) WHERE id=1").run();
          new WritetimeFixture(db).owner("T2", "T2-200", 200).reply("T2", "T2-201", 201, { turnLsn: 200 });
          carry(db, "T", Number.MIN_SAFE_INTEGER, 1, { turn: ["T2", 200] });
          commit.inheritMarks(db, { kind: "turn", threadId: "T2", lsn: 200, line: 201, holdFrom: 201 }, [], [{ threadId: "T", from: Number.MIN_SAFE_INTEGER, to: 1 }]);
        });
        // denied, through one walk: the deletion's revoke re-opened from its receipt
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs") - jobsBefore).toBe(1);
        expect(jobRow(db, J)).toBeTruthy();
        expect(verdict(db, "T2", "T2-201")).toBe("withheld");
        drainAll(db);
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')")).toBe(0);
        expect(verdict(db, "T2", "T2-201")).toBe("withheld");
      } finally { fx.close(); }
    });
  }
  for (const path of ["done-retained", "done-pruned"] as const) for (const coalesced of [false, true]) {
    it(`Grok r2 High: a late turn whose parent is one mid-thread owner line of T (a point range, no range row matches it) is denied by the receipt, path ${path}${coalesced ? ", after coalescing" : ""}`, () => {
      const { fx, db } = store();
      try {
        deleteT(db, path);
        if (coalesced) tx(db, () => { for (let k = 1; k < 64; k++) marker.writeRange(db, 100_000 + k, "T", 1000 + k, 2000 + k, "forget"); });
        // T2's turn at 200 quotes owner line T-3 alone: resolveRefs carries the point range [3, 3] (lineage-write.ts resolveRefs)
        tx(db, () => {
          db.prepare("UPDATE memory_lsn SET next=max(next,200) WHERE id=1").run();
          new WritetimeFixture(db).owner("T2", "T2-200", 200).reply("T2", "T2-201", 201, { turnLsn: 200 });
          carry(db, "T", 3, 3, { turn: ["T2", 200] });
          commit.inheritMarks(db, { kind: "turn", threadId: "T2", lsn: 200, line: 201, holdFrom: 201 }, [], [{ threadId: "T", from: 3, to: 3 }]);
        });
        expect(verdict(db, "T2", "T2-201")).toBe("withheld");
        drainAll(db);
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')")).toBe(0);
        expect(verdict(db, "T2", "T2-201")).toBe("withheld");
      } finally { fx.close(); }
    });
  }
});

describe("T4: writeRange is monotone (2.4)", () => {
  it("a second unbounded write at the same (revoke, thread, from) keeps the larger cap; a bounded write keeps its own", () => {
    const fx = new WritetimeFixture(); fx.cert(true);
    const db = fx.db;
    try {
      const until = () => Number((db.prepare("SELECT until_turn_lsn AS u FROM memory_deny_range WHERE revoke_id=7 AND thread_id='T' AND from_lsn=5").get() as { u: number }).u);
      tx(db, () => marker.writeRange(db, 7, "T", 5, 50, "thread-delete"));
      expect(until()).toBe(50);
      tx(db, () => marker.writeRange(db, 7, "T", 5, 30, "thread-delete"));
      expect(until()).toBe(50);
      tx(db, () => marker.writeRange(db, 7, "T", 5, 80, "thread-delete"));
      expect(until()).toBe(80);
      tx(db, () => marker.writeRange(db, 7, "T", 5, 20, "forget" + marker.BOUNDED_RANGE));
      expect(until()).toBe(20);
      tx(db, () => marker.writeRange(db, 7, "T", 5, 90, "thread-delete"));
      expect(until()).toBe(20); // a proven bound is never widened (the base's rule)
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='T'")).toBe(1);
    } finally { fx.close(); }
  });
});
