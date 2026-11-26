// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, pending recovery producer and dispatch consumer.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertSendFence, pendingFenceCheck } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { awaitExactPendingCheck, settleDirectRefusal, settleRefusedFence, PENDING_FENCE_WAIT_MS } from "./fence-pending.ts";
import * as revocation from "./memory-revocation.ts";
import { resetRevokeWriteBudget, revokePaceTestHooks, REVOKE_WRITE_WINDOW_MS } from "./revoke-budget.ts";
import { CONTENT, MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { LineageReader } from "./lineage-types.ts";
import { holdRevoke } from "./revoke-marker.ts";

let f: WritetimeFixture;
beforeEach(() => {
  f = new WritetimeFixture().cert(true).reply("target", "delegated", 20, { turnLsn: 10 }).job(1, 30).pending("target", 1);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = true; revocation.resetWaitedPendingAllowance();
});
// MEMORY V2 V14 (test mechanics only): the wait is no longer a 25 ms setTimeout poll. It sits on the `window` wake and one deadline. The
// wake bus keeps its deadlines on the wall clock (Date.now) and runs a subscriber on a later turn of the event loop (setImmediate), which
// the fake clock does not own. So the fake clock owns Date too, and simulated time moves in small steps with one real turn between
// (the same helper as memv2-c-pace-1021.test.ts).
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
const loopTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function advance(ms: number, step = 4): Promise<void> {
  await loopTurn();
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await loopTurn(); }
  // the bus runs one subscriber a turn: a few more turns, with the clock standing still, deliver everything raised at the last step
  for (let turn = 0; turn < 6; turn++) await loopTurn();
}
/** The wait's answer once it has one (null while it waits), and the simulated time it answered at. */
function watch(wait: Promise<boolean>): { settled: boolean | null; at: number | null } {
  const seen: { settled: boolean | null; at: number | null } = { settled: null, at: null };
  void wait.then(value => { seen.settled = value; seen.at = performance.now(); });
  return seen;
}
/** What the checker does when its walk is proven: the revoke has written every mark (phase tidy, no frontier) and the existing proof site
 * deletes the turn's pending row and moves the deny generation, which raises the `window` wake. */
function checkerCloses(): boolean {
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  return revocation.closeWaitedPending(f.db, ["target"], []);
}
afterEach(() => { revocation.stopMemoryRevocation(); vi.restoreAllMocks(); vi.useRealTimers(); f.close(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false; });
function refusal(reader: LineageReader, listed = false) {
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [
    { kind: "prefix", threadId: "target", headLsn: 20, ...(listed ? { shown: ["delegated"] } : {}) },
  ])]);
  try { assertSendFence(built, reader, f.db); } catch (error) { return { error, built }; }
  throw new Error("fixture must refuse");
}
for (const reader of [CONTENT, MEMBER]) {
  it(`settles a carried delegated prefix for the ${reader === CONTENT ? "content" : "audience"} reader before rebuilding`, async () => {
    const { error, built } = refusal(reader);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
    expect(await settleRefusedFence(f.db, error, undefined, 2000)).toBe(true);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "shown" });
    expect(() => assertSendFence(built, reader, f.db)).not.toThrow();
  });
  it(`an orphan stays closed for the complete bound (${reader === CONTENT ? "content" : "audience"})`, async () => {
    f.db.exec("DELETE FROM memory_revoke_jobs");
    const { error, built } = refusal(reader);
    fakeClock();
    const result = watch(settleRefusedFence(f.db, error, undefined, 100));
    await advance(99, 1);
    expect(result.settled).toBeNull();
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
    await advance(1, 1);
    expect(result.settled).toBe(false);
    expect(() => assertSendFence(built, reader, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()?.n).toBe(1);
  });
}
it("schedules an audience-only obligation without borrowing the content reader's clearance", async () => {
  f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(1)");
  const { error, built } = refusal(MEMBER);
  expect(() => assertSendFence(built, CONTENT, f.db)).not.toThrow();
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  expect(await settleRefusedFence(f.db, error, undefined, 2000)).toBe(true);
  expect(() => assertSendFence(built, MEMBER, f.db)).not.toThrow();
});
// MEMORY V2 V14 changes two assertions of this test on purpose (design 4.3): "Waiters wait on the `window` wake. `fence-pending` and the
// turn-start settle resolve when a pending row they are under is deleted or the generation moves; the 65 s bound and "a timeout never
// authorises a resend" stay; no poll, no drain in the waiter". The scenario is kept: the checker can only finish once the spent writer
// minute has aged out, and the wait must still be there for it. Changed: (1) the waiter no longer calls the marker drain itself (was
// `expect(drain).toHaveBeenCalled()`): the drain spy here would close the window at once, and it must never run; (2) there is no polling
// margin left to measure (was 60_025 ms = the minute plus one 25 ms poll): the wait answers in the event-loop turn the row is deleted.
it("waits through a full writer minute and answers in the turn its row is deleted (no polling margin), without spending rebuilds", async () => {
  const { error } = refusal(CONTENT);
  fakeClock();
  vi.spyOn(revocation, "wakeMemoryRevocation").mockImplementation(() => {});
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded").mockImplementation(() => { f.db.exec("DELETE FROM memory_deny_pending"); return false; });
  const started = performance.now();
  let closed: boolean | null = null;
  setTimeout(() => { closed = checkerCloses(); }, REVOKE_WRITE_WINDOW_MS);
  const result = watch(settleRefusedFence(f.db, error));
  await advance(REVOKE_WRITE_WINDOW_MS - 20, 20);
  expect(result.settled).toBeNull();
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  await advance(20, 20);
  expect(closed).toBe(true);
  expect(result.settled).toBe(true);
  expect(result.at! - started).toBe(REVOKE_WRITE_WINDOW_MS);
  expect(REVOKE_WRITE_WINDOW_MS).toBe(60_000);
  expect(PENDING_FENCE_WAIT_MS).toBe(65_000);
  expect(drain).not.toHaveBeenCalled();
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "shown" });
});
it("Stop interrupts the wait without changing its pending row", async () => {
  const { error } = refusal(CONTENT);
  expect(await settleRefusedFence(f.db, error, () => true)).toBe(false);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
});
it("an obligation with no runnable checker exhausts the real 65-second bound once", async () => {
  f.db.exec("DELETE FROM memory_revoke_jobs");
  const { error, built } = refusal(CONTENT);
  fakeClock();
  const result = watch(settleRefusedFence(f.db, error));
  const directResult = watch(settleDirectRefusal(f.db, error, () => false));
  await advance(64_980, 20);
  expect(result.settled).toBeNull();
  expect(directResult.settled).toBeNull();
  await advance(20, 20);
  expect(result.settled).toBe(false);
  expect(directResult.settled).toBe(false);
  expect(result.at).toBe(65_000);
  expect(directResult.at).toBe(65_000);
  expect(performance.now()).toBe(65_000);
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
});
it("a real refusal that settles stays refused at the final fence", async () => {
  const { error, built } = refusal(CONTENT, true);
  f.denyLine("target", 20);
  expect(await settleRefusedFence(f.db, error)).toBe(true);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "withheld", reason: "deny-line" });
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
});
it("adapter wrapping retains the exact obligation and another database cannot settle it", () => {
  const { error } = refusal(CONTENT);
  const wrapped = { verdict: (error as { fence: object }).fence };
  expect(pendingFenceCheck(wrapped)).toBe(pendingFenceCheck(error));
  const other = new WritetimeFixture().cert(true);
  try { expect(pendingFenceCheck(wrapped)?.(other.db)).toEqual({ state: "checking", reason: "lookup-error" }); }
  finally { other.close(); }
});
it("an unavailable authority refuses recovery without clearing pending evidence", async () => {
  const { error, built } = refusal(CONTENT);
  const prepare = vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("fixture reader unavailable"); });
  expect(await settleRefusedFence(f.db, error, undefined, 2000)).toBe(false);
  prepare.mockRestore();
  expect(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()?.n).toBe(1);
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
});
it("honors the caller's startup scheduling gate while retaining the owed check", async () => {
  const { error, built } = refusal(CONTENT);
  revocation.createRevocationJob(f.db, { v: 2, id: "fixture-gated-job", phases: ["done"], c: null });
  holdRevoke(f.db, 1, "fixture-gated-job");
  f.db.exec("UPDATE memory_revoke_jobs SET phase='hold'");
  revocation.stopMemoryRevocation();
  fakeClock();
  const wake = vi.fn();
  const result = watch(settleRefusedFence(f.db, error, undefined, 100, wake));
  await advance(99, 1);
  expect(result.settled).toBeNull();
  await advance(1, 1);
  expect(result.settled).toBe(false);
  expect(wake).toHaveBeenCalledTimes(1);
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
});
it.each([CONTENT, MEMBER])("reschedules durable bookkeeping work after its runner stopped (%j)", async reader => {
  const { error } = refusal(reader);
  revocation.createRevocationJob(f.db, { v: 2, id: "fixture-held-job", phases: ["done"], c: null });
  holdRevoke(f.db, 1, "fixture-held-job");
  f.db.exec("UPDATE memory_revoke_jobs SET phase='hold'");
  revocation.stopMemoryRevocation();
  // The old recovery drain reports failure with the same obligation still
  // owed: it never schedules the bookkeeping job that owns this marker hold.
  // MEMORY V2 V14 (design 4.3): "no poll, no drain in the waiter". settleRevokesForTurn no longer runs that drain (it is a waiter that
  // wakes the runner, so it is no longer a control for "the drain alone"). The control is now the drain itself, called directly: the same
  // bounded marker drain the old settle looped over, with the same answer (work is still pending).
  expect(revocation.drainRevokeMarkerBounded(f.db)).toBe(true);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  expect(f.db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-revocation:fixture-held-job'").get()).toBeTruthy();
  resetRevokeWriteBudget(); // isolate scheduling from the control drain's measured writes
  expect(await settleRefusedFence(f.db, error, undefined, 2000)).toBe(true);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "shown" });
  expect(f.db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-revocation:fixture-held-job'").get()).toBeUndefined();
});
// MAIN Q2: an input still checking:pending waits for its own obligation only. No foreground or global drain, ever.
it("the exact pending wait never borrows foreground revoke work and only re-wakes the scheduled runner", async () => {
  const { error } = refusal(CONTENT);
  fakeClock();
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded"), settle = vi.spyOn(revocation, "settleRevokesForTurn");
  const wake = vi.fn();
  // the checker proves its walk at 1.5 s (was a bare DELETE the 25 ms poll would find; a real delete site also moves the generation,
  // which is what the waiter hears now)
  setTimeout(() => { f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run(); revocation.closeWaitedPending(f.db, ["target"], []); }, 1_500);
  const result = watch(awaitExactPendingCheck(f.db, error, undefined, 5_000, wake));
  await advance(1_496);
  expect(result.settled).toBeNull();
  await advance(104);
  expect(result.settled).toBe(true);
  expect(result.at).toBe(1_500);
  expect(drain).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  // MEMORY V2 V14 (design 4.3): "Waiters wait on the `window` wake ... no poll, no drain in the waiter". The runner is woken once, at
  // entry, and keeps its own deadlines (was: re-woken every second by the poll, `wake.mock.calls.length >= 2`).
  expect(wake).toHaveBeenCalledTimes(1);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "shown" });
});
it("Stop ends the exact pending wait before any wake, leaving its obligation owed", async () => {
  const { error } = refusal(CONTENT);
  const wake = vi.fn(), drain = vi.spyOn(revocation, "drainRevokeMarkerBounded");
  expect(await awaitExactPendingCheck(f.db, error, () => true, 2_000, wake)).toBe(false);
  expect(wake).not.toHaveBeenCalled();
  expect(drain).not.toHaveBeenCalled();
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
});
it("the exact pending wait never authorizes an attempt when its bound runs out, and does no work for a settled refusal", async () => {
  f.db.exec("DELETE FROM memory_revoke_jobs");
  const { error, built } = refusal(CONTENT);
  fakeClock();
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded"), wake = vi.fn();
  const result = watch(awaitExactPendingCheck(f.db, error, undefined, 100, wake));
  await advance(99, 1);
  expect(result.settled).toBeNull();
  await advance(1, 1);
  expect(result.settled).toBe(false);
  expect(drain).not.toHaveBeenCalled();
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  const settled = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: { state: "withheld", reason: "deny-line" } });
  const idle = vi.fn();
  expect(await awaitExactPendingCheck(f.db, settled, undefined, 100, idle)).toBe(true);
  expect(idle).not.toHaveBeenCalled();
});
