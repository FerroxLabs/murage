// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 A-5. Owners: ctxstop-lease builder owns the continuePending decision (send-fence.ts assertRetainedFence) and its direct-turn
// wiring (index.ts continueOwnerPending); the retained ledger (lineage-write.ts) and deny reader (deny-read.ts) are unchanged.
// A RUNNING owner turn (its prompt already written) whose later release re-checks the context the engine already holds and finds it
// still checking:pending (a revoke walk not finished) continues; the owner gets one left-out note. Fail-closed stays for everything else:
// no continuation hook (any non-owner audience), new prospective context, and a proven revoke. Real fence, real deny reader, real ledger.
import { afterEach, expect, it, vi } from "vitest";
import { openTurnLineage, closeTurnLineage, addTurnParents } from "./lineage-write.ts";
import { prepareRetainedFence, assertRetainedFence } from "./send-fence.ts";
import { refsLookup } from "./deny-read.ts";
import type { LineageRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
// the retained prefix the session already holds (the live refusal: "refused refs: prefix-shown 1; verdicts: checking:pending 1")
const held = (): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 90, held: 80, shown: ["safe"] });
const later = (): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 100, held: 95, shown: ["fresh"] });
/** A turn whose context ("safe") was shown and released; then a revoke opens a pending window over its thread. */
function running(continuePending?: () => boolean) {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.cert(true).ready("T", true).reply("T", "safe", 85, { turnLsn: 70 }).reply("T", "fresh", 95, { turnLsn: 90 });
  const refused = vi.fn();
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: `running-${fixtures.length}` });
  prepareRetainedFence(turn, CONTENT, refused, f.db, continuePending);
  addTurnParents(turn, [held()]);
  expect(() => assertRetainedFence(turn, f.db)).not.toThrow();
  f.job(1, 50).pending("*", 1);
  expect(refsLookup(f.db, [held()], CONTENT)).toMatchObject({ state: "checking", reason: "pending" });
  return { f, turn, refused, close: () => closeTurnLineage(turn) };
}

it("A-5 an owner turn's later release over held context still checking:pending continues, once noted, and stays open", () => {
  const told = vi.fn(() => true);
  const w = running(told);
  try {
    expect(() => assertRetainedFence(w.turn, w.f.db)).not.toThrow();
    expect(() => assertRetainedFence(w.turn, w.f.db)).not.toThrow();
    expect(w.refused).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledTimes(2);
  } finally { w.close(); }
});

it("A-5 guard: without the owner hook (a non-owner audience) the same release still refuses the turn", () => {
  const w = running();
  try {
    expect(() => assertRetainedFence(w.turn, w.f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.refused).toHaveBeenCalledTimes(1);
    expect(w.refused.mock.calls[0][0]).toMatchObject({ state: "checking", reason: "pending" });
  } finally { w.close(); }
});

it("A-5 guard: the hook declining (an unwritten turn takes the rebuild instead) refuses", () => {
  const w = running(() => false);
  try {
    expect(() => assertRetainedFence(w.turn, w.f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.refused).toHaveBeenCalledTimes(1);
  } finally { w.close(); }
});

it("A-5 guard: new prospective context under the pending window is never released, even for the owner", () => {
  const told = vi.fn(() => true);
  const w = running(told);
  try {
    expect(() => addTurnParents(w.turn, [later()])).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.refused).toHaveBeenCalledTimes(1);
    expect(told).not.toHaveBeenCalled();
  } finally { w.close(); }
});

it("A-5 guard: a proven revoke of the held context still stops the owner's running turn", () => {
  const told = vi.fn(() => true);
  const w = running(told);
  try {
    // the walk finished and proved the held line withdrawn: no longer pending, revoked
    w.f.db.exec("DELETE FROM memory_deny_pending");
    w.f.denyLine("T", 85);
    expect(refsLookup(w.f.db, [held()], CONTENT).state).not.toBe("shown");
    expect(() => assertRetainedFence(w.turn, w.f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.refused).toHaveBeenCalledTimes(1);
    expect(w.refused.mock.calls[0][0]).not.toMatchObject({ state: "checking", reason: "pending" });
  } finally { w.close(); }
});
