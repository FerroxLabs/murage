// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable (FABLE 60fe2e2655 HIGH-4 / OPUS 60fe2e2655 HIGH-4, carried FABLE :7899 H-2, ASTRA :7900).
// Owners: the queue's job selection (revoke-marker.ts queuedJobs, read by walkerSlice and markerSliceDetailed) = q1023-denyfable; the
// backoff itself (V10, revoke-marker.ts served / backedOff) = lane C, unchanged; rulings = MAIN.
//
// The paced runner is the only path that ends a walk or an undo (MAIN-RULING 2026-11-26T22:27:29Z D2: no settle at open). Its selectors
// read the oldest 16 jobs and only then passed over the ones sitting out a failure, so 16 failing undo jobs hid every healthy job behind
// them: an owner's undo of a forget never took effect. Invariant: a job sitting out never takes a healthy job's place in a slice.
// Entry point: marker.markerSlice (the runner's own step, memory-revocation.ts), both selection sites (SITES.md Q1 walkerSlice, the
// cover walker's undo class; Q2 markerSliceDetailed, the plain queue), over revokes the real commitRevoke wrote and the real undoRevoke
// withdrew. The failing undo is a real failed step: its delete of the revoke's mark aborts in SQLite.
// RED on d2c1083fbc at each W-Q row (the healthy undo's line still reads withheld); the guards are green on both sides.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as commit from "./revoke-commit.ts";
import { denyLookup } from "./deny-read.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db) => tx(db, () => marker.markerSlice(db, 256, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db) => { for (let k = 0; k < 200_000; k++) if (!slice(db)) return; throw new Error("unbounded"); };
const state = (db: Db, T: string) => denyLookup(db, { threadId: T, lines: [{ messageId: `${T}-2`, author: "generated" }] }, CONTENT).get(`${T}-2`)!.state;
const jobState = (db: Db, id: number) => String(db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.state);

const COVER = marker.REVOKE_COVER.enabled;
beforeEach(() => { marker.setScopeFlowEdgesRecorded(true); vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); marker.REVOKE_COVER.enabled = COVER; });

/** `failing` + 1 conversations, each with one reply the owner had removed (a real line revoke, walked to its end), then every removal
 * undone by the owner (undoRevoke). The undo of the first `failing` fails at its first step, every time; the last one is healthy. */
function world(failing: number): { fx: WritetimeFixture; db: Db; ids: number[] } {
  const fx = new WritetimeFixture(); fx.cert(true);
  const db = fx.db, ids: number[] = [];
  for (let k = 0; k <= failing; k++) fx.owner(`T${k}`, `T${k}-1`, 10 * k + 1).reply(`T${k}`, `T${k}-2`, 10 * k + 2, { turnLsn: 10 * k + 1 });
  db.prepare("UPDATE memory_lsn SET next=100000 WHERE id=1").run();
  for (let k = 0; k <= failing; k++) ids.push(tx(db, () => commit.commitRevoke(db, { kind: "line", threadId: `T${k}`, messageIds: [`T${k}-2`], cause: "edit" }, { inline: false })));
  drainAll(db);
  for (let k = 0; k <= failing; k++) expect(state(db, `T${k}`), "setup: every removed reply is withheld").toBe("withheld");
  db.exec(`CREATE TEMP TRIGGER undo_fault BEFORE DELETE ON main.memory_deny_point WHEN OLD.revoke_id<=${ids[failing - 1]!} BEGIN SELECT RAISE(ABORT,'undo fault'); END`);
  tx(db, () => { for (const id of ids) commit.undoRevoke(db, id); });
  return { fx, db, ids };
}
/** The runner's slices, as it runs them: a slice that throws is rolled back and the next one follows (inside one backoff, the clock held). */
function run(db: Db, slices: number): number {
  let failed = 0;
  for (let k = 0; k < slices; k++) { try { slice(db); } catch { failed++; } }
  return failed;
}

describe("the queue pages past jobs sitting out a failure", () => {
  const sites = [["Q1 walkerSlice (cover walker, undo class)", true], ["Q2 markerSliceDetailed (plain queue)", false]] as const;
  for (const [site, cover] of sites) for (const failing of [16, 40]) {
    it(`W-Q ${site}, ${failing} failing undo jobs ahead: the healthy undo behind them takes effect`, () => {
      marker.REVOKE_COVER.enabled = cover;
      const { fx, db, ids } = world(failing);
      try {
        const failed = run(db, failing * 3 + 20);
        expect(failed, "setup: failing undo jobs really failed their steps").toBeGreaterThanOrEqual(16);
        // fail closed: a failing undo keeps its marks
        expect(state(db, "T0")).toBe("withheld");
        expect(jobState(db, ids[0]!)).toBe("undoing");
        // the healthy undo behind them is served: the owner's reply is shown again
        expect(state(db, `T${failing}`), "the healthy undo took effect").toBe("shown");
      } finally { fx.close(); }
    });
  }
  it("G-Q: with fewer failing jobs than a page the healthy undo is served, as on 1.0.22", () => {
    const { fx, db } = world(3);
    try {
      run(db, 30);
      expect(state(db, "T0")).toBe("withheld");
      expect(state(db, "T3")).toBe("shown");
    } finally { fx.close(); }
  });
});
