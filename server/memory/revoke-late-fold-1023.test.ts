// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable D3 across a fold (ASTRA / OPUS / FABLE on 067e8a15c9: the fold's carry of late notes had no witness).
// Owners: the late note and its rescan (revoke-commit.ts inheritMarks / rescanLateChildren) and the two carries in revoke-fold.ts
// (runFold stage "holds"; moveMember) = q1023-denyfable; the fold itself and the marker = unchanged; rulings = MAIN.
//
// A child written under a revoke's window before its parent's mark is noted (a `late:` row) and looked up again at the job's hold step.
// A revoke folded into a bulk B in between loses its own rows: unless B looks the noted child up, B reaches its tidy with nothing to look
// up and the child reads SHOWN for good. Since q1023-leftout 25e4bdbb59 the note is ONE row in a shared list (LATE_REVOKE), not a row
// under each revoke: nothing is carried at a fold (revoke-fold.ts's two carries of per-job `late:` rows find none), and B reads the list
// from its own start at its hold step (revoke-marker.ts advance, lateWorkLeft / lateRescan).
// Entry points: the real commits (commitRevoke, walk left to the runner), the writers' inherit call (inheritMarks), the runner's slice
// (markerSlice: the fold's stages, B's walk, its hold step and rescan), repairFoldMap (moveMember) and the production reader (denyLookup,
// a room member's reader).
// RED on d2c1083fbc at each W row (no notes there: the child reads "shown" once B is done).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as commit from "./revoke-commit.ts";
import { repairFoldMap } from "./revoke-fold.ts";
import { denyLookup } from "./deny-read.ts";
import { MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
/** A room member's read (the revokes here are audience revokes: a receipt's disclosure taken back from its readers). */
const lineState = (db: Db, T: string, id: string) => denyLookup(db, { threadId: T, lines: [{ messageId: id, author: "generated" }] }, MEMBER).get(id)!.state;
const LATE = "thread_id>='late:' AND thread_id<'late;'";
const notesUnder = (db: Db, ids: readonly number[]) => n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE ${LATE} AND revoke_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
/** q1023-leftout 25e4bdbb59: a late child is noted ONCE, in the shared list under revoke-marker.ts LATE_REVOKE, however many revokes hold it. */
const notesShared = (db: Db) => n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE ${LATE} AND revoke_id=?`, (marker as { LATE_REVOKE?: number }).LATE_REVOKE ?? -8);
const notesLeft = (db: Db) => n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE ${LATE}`);
const foldJob = (db: Db) => db.prepare("SELECT revoke_id AS r,state,phase FROM memory_revoke_jobs WHERE json_valid(root) AND json_extract(root,'$.cause')='fold' ORDER BY revoke_id").all() as Array<{ r: number; state: string; phase: string }>;
const active = (db: Db) => n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')");

beforeEach(() => { marker.setScopeFlowEdgesRecorded(true); commit.INHERIT_CLOSE.inline = true; });
afterEach(() => { marker.setScopeFlowEdgesRecorded(false); });

/** `count` audience receipt revokes committed as their own jobs (the backlog a fold takes as one cohort), their walks left to the runner. */
function backlog(count: number): { fx: WritetimeFixture; db: Db; jobs: number[] } {
  const fx = storm(count);
  const db = fx.db;
  db.prepare("UPDATE memory_disclosures SET state='revoked'").run();
  db.exec("DELETE FROM memory_receipt_flips");
  const jobs = tx(db, () => Array.from({ length: count }, (_, i) => commit.commitRevoke(db, { kind: "receipt", bundleId: `b${i}`, cause: "receipt-revoked" }, { inline: false })));
  db.prepare("UPDATE memory_lsn SET next=max(next,5000) WHERE id=1").run();
  return { fx, db, jobs };
}
const foldUntilActive = (db: Db, rows: number) => { for (let k = 0; k < 20_000 && (!foldJob(db).length || foldJob(db)[0]!.state === "seeding"); k++) slice(db, rows); };

describe("D3 across a fold: a late child's note goes with its revoke into the fold bulk, whose hold step looks the child up", () => {
  for (const count of [6, 40]) {
    it(`W-FOLD-HOLDS (${count} jobs): a line carried from a line the folded revokes only hold so far is withheld once the bulk is done`, () => {
      const { fx, db, jobs } = backlog(count);
      try {
        // the gap: no walk has run, so the first receipt's output line (r0) is held by its job's window and has no mark yet
        expect(n(db, "SELECT count(*) AS n FROM memory_deny_point WHERE thread_id=? AND lsn=10", THREADS[0]!), "setup: the parent has no mark yet").toBe(0);
        // a line carried from that output is written now (the writers' inherit call), then the runner folds the backlog
        tx(db, () => {
          new WritetimeFixture(db).owner("C", "C-200", 5200).reply("C", "C-201", 5201, { turnLsn: 5200 });
          commit.inheritMarks(db, { kind: "line", threadId: "C", lsn: 5201 }, [], [{ threadId: THREADS[0]!, from: 10, to: 10 }]);
          db.prepare("UPDATE memory_lsn SET next=max(next,6000) WHERE id=1").run();
        });
        expect(lineState(db, "C", "C-201"), "held under the window from its write").not.toBe("shown");
        const noted = notesShared(db), notedUnderMembers = notesUnder(db, jobs);
        foldUntilActive(db, 8);
        const [B] = foldJob(db);
        expect(B?.state, "setup: the backlog was folded into one bulk").toBe("active");
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='folded'"), "setup: every job was folded").toBe(count);
        const carried = notesUnder(db, [B!.r]), leftUnderMembers = notesUnder(db, jobs);
        drainAll(db);
        expect(active(db)).toBe(0);
        expect(n(db, "SELECT count(*) AS n FROM memory_deny_point WHERE thread_id=? AND lsn=10", THREADS[0]!), "the bulk's walk marked the parent").toBeGreaterThan(0);
        expect(lineState(db, "C", "C-201"), "the line rests on a line the folded revokes deny").toBe("withheld");
        expect(noted, "the child was noted once, in the shared list").toBe(1);
        expect([notedUnderMembers, carried, leftUnderMembers], "no note sits under a job, so a fold has none to carry: the bulk reads the shared list from its own start").toEqual([0, 0, 0]);
        expect(notesLeft(db), "no note or payload row outlives the bulk").toBe(0);
      } finally { fx.close(); }
    });
  }

  it("W-FOLD-MOVE: a note written under a folded job while the fold map was gone moves to the bulk with its leftovers, and the child is withheld", () => {
    const { fx, db, jobs } = backlog(6);
    try {
      const M = jobs[2]!;
      // M had written every mark and was waiting at its hold step when the fold took it (an eligible phase, F1.1)
      tx(db, () => { db.prepare("UPDATE memory_revoke_jobs SET phase='hold',cursor='' WHERE revoke_id=?").run(M); db.prepare("DELETE FROM memory_revoke_frontier WHERE revoke_id=?").run(M); });
      foldUntilActive(db, 8);
      const [B] = foldJob(db);
      expect(B?.state, "setup: the backlog was folded into one bulk").toBe("active");
      // The round trip through 1.0.2 (REVOKE-FOLD-DESIGN r4): the step to v10 drops the map; 1.0.2 resolves no id, so a line P-1 carried
      // from M's marks is enqueued and held under M's own id and M (folded at its hold step) is set active again.
      tx(db, () => {
        new WritetimeFixture(db).owner("P", "P-0", 5099).reply("P", "P-1", 5100, { turnLsn: 5099 });
        db.exec("DELETE FROM memory_revoke_fold");
        db.prepare("UPDATE memory_revoke_jobs SET phase='mark',cursor='',state='active' WHERE revoke_id=?").run(M);
        db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,?)").run(M, JSON.stringify({ kind: "line", threadId: "P", lsn: 5100 }));
        db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('P',5100,?)").run(M);
        db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
        db.prepare("UPDATE memory_lsn SET next=max(next,5200) WHERE id=1").run();
      });
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_point WHERE thread_id='P' AND lsn=5100"), "setup: the parent line has no mark yet").toBe(0);
      // back on this build, before the map is rebuilt: a line carried from P-1 is written (the writers' inherit call)
      tx(db, () => {
        new WritetimeFixture(db).owner("C", "C-300", 5300).reply("C", "C-301", 5301, { turnLsn: 5300 });
        commit.inheritMarks(db, { kind: "line", threadId: "C", lsn: 5301 }, [], [{ threadId: "P", from: 5100, to: 5100 }]);
        db.prepare("UPDATE memory_lsn SET next=max(next,6000) WHERE id=1").run();
      });
      expect(lineState(db, "C", "C-301"), "held under the window from its write").not.toBe("shown");
      const noted = notesShared(db), notedUnderMember = notesUnder(db, [M]);
      expect(tx(db, () => repairFoldMap(db)), "setup: the map was rebuilt").toBe(6);
      const carried = notesUnder(db, [B!.r]), leftUnderMember = notesUnder(db, [M]);
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_point WHERE thread_id='P' AND lsn=5100"), "the bulk's walk marked the parent line").toBeGreaterThan(0);
      expect(lineState(db, "C", "C-301"), "the line rests on a line the bulk denies").toBe("withheld");
      expect(noted, "the child was noted once, in the shared list").toBe(1);
      expect([notedUnderMember, carried, leftUnderMember], "no note sits under the job 1.0.2 set active or under the bulk: the bulk reads the shared list from its own start").toEqual([0, 0, 0]);
      expect(notesLeft(db), "no note or payload row outlives the bulk").toBe(0);
    } finally { fx.close(); }
  });

  it("G-FOLD-CLEAN: a line carried from an untouched line, written in the same gap, is held, then shown, and its note does not outlive the bulk", () => {
    const { fx, db } = backlog(6);
    try {
      tx(db, () => {
        const w = new WritetimeFixture(db);
        w.owner("calm", "calm-0", 899).reply("calm", "calm-1", 900, { turnLsn: 899 });
        w.owner("D", "D-300", 5300).reply("D", "D-301", 5301, { turnLsn: 5300 });
        commit.inheritMarks(db, { kind: "line", threadId: "D", lsn: 5301 }, [], [{ threadId: "calm", from: 900, to: 900 }]);
        db.prepare("UPDATE memory_lsn SET next=max(next,6000) WHERE id=1").run();
      });
      expect(lineState(db, "D", "D-301"), "held under the window from its write").not.toBe("shown");
      drainAll(db);
      expect(active(db)).toBe(0);
      expect(lineState(db, "D", "D-301")).toBe("shown");
      expect(notesLeft(db)).toBe(0);
    } finally { fx.close(); }
  });
});
