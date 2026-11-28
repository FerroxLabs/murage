// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memory V2 lane C (revoke engine). V15 (MEMORY-V2-DESIGN 4.3, F4): the deny generation moves only when a mark or a window row
// was really written. Every cached read verdict is keyed on it (deny-read.ts), so a bump that wrote nothing re-walks every held fence.
// These are the witnesses for the two sites that bumped on a no-op at 97777a6678 (both RED there, pinned with `it.fails` until the fix):
//   activateBulkRevoke (revoke-commit.ts): bumped for a job that was not seeding. Fixed: the bump is inside the `state='seeding'` test.
//   undoRevoke (revoke-commit.ts): bumped again for a job already 'undoing'. Fixed: an undo under way returns before the UPDATE.
import { afterEach, beforeEach, expect, it } from "vitest";
import { INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke, undoRevoke } from "./revoke-commit.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";

const inline = { ...INLINE_REVOCATION };
let f: WritetimeFixture;
beforeEach(() => { f = storm(4); INLINE_REVOCATION.ms = 0; });
afterEach(() => { stopMemoryRevocation(); f.close(); Object.assign(INLINE_REVOCATION, inline); resetRevokeWriteBudget(); });

const TABLES = ["memory_deny_point", "memory_deny_range", "memory_deny_session", "memory_deny_object", "memory_deny_pending", "memory_deny_pending_scope"];
/** Every mark and window row, as text: equal before and after means none was written or deleted. */
const rows = () => JSON.stringify(TABLES.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all()));
const tx = <T>(run: () => T): T => { f.db.exec("BEGIN IMMEDIATE"); try { const out = run(); f.db.exec("COMMIT"); return out; } catch (error) { f.db.exec("ROLLBACK"); throw error; } };
/** Generation moves across `run`, with the proof that `run` changed no mark or window row. */
function noopBumps(label: string, run: () => void): number {
  const before = rows(), generation = f.generation();
  tx(run);
  expect(rows(), `${label}: the call was meant to write no mark or window row`).toBe(before);
  const bumps = f.generation() - generation;
  console.log(`MEMV2C V15 ${label}: deny generation bumps with no mark or window row written = ${bumps}`);
  return bumps;
}

it("V15 control: a revoke that writes its window rows moves the generation", () => {
  const generation = f.generation(), before = rows();
  tx(() => commitRevoke(f.db, { kind: "line", threadId: THREADS[0]!, messageIds: ["r0"], cause: "forget" }));
  expect(rows()).not.toBe(before);
  expect(f.generation()).toBeGreaterThan(generation);
});
it("V15-W1: activating a bulk revoke that is already active moves no generation (RED at 97777a6678: revoke-commit.ts activateBulkRevoke)", () => {
  const bulk = tx(() => { const B = openBulkRevoke(f.db, "seed", false); commitRevoke(f.db, { kind: "line", threadId: THREADS[1]!, messageIds: ["r1"], cause: "hide" }, { into: B }); activateBulkRevoke(f.db, B); return B; });
  expect(String(f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(bulk)!.state)).toBe("active");
  expect(noopBumps("activateBulkRevoke on an active job", () => activateBulkRevoke(f.db, bulk))).toBe(0);
});
it("V15-W2: undoing a revoke that is already being undone moves no generation (RED at 97777a6678: revoke-commit.ts undoRevoke)", () => {
  const R = tx(() => commitRevoke(f.db, { kind: "line", threadId: THREADS[0]!, messageIds: ["r0"], cause: "hide" }));
  tx(() => undoRevoke(f.db, R));
  expect(String(f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R)!.state)).toBe("undoing");
  expect(noopBumps("undoRevoke on an undoing job", () => undoRevoke(f.db, R))).toBe(0);
});
