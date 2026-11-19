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
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = true;
});
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const result = settleRefusedFence(f.db, error, undefined, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
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
it("waits through a full writer minute plus measured polling margin, without spending rebuilds", async () => {
  const { error } = refusal(CONTENT);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(revocation, "wakeMemoryRevocation").mockImplementation(() => {});
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded").mockImplementation(() => {
    if (performance.now() >= REVOKE_WRITE_WINDOW_MS) f.db.exec("DELETE FROM memory_deny_pending");
    return performance.now() < REVOKE_WRITE_WINDOW_MS;
  });
  const started = performance.now();
  const result = settleRefusedFence(f.db, error);
  await vi.advanceTimersByTimeAsync(REVOKE_WRITE_WINDOW_MS + 25);
  expect(await result).toBe(true);
  expect(performance.now() - started).toBe(60_025);
  expect(PENDING_FENCE_WAIT_MS).toBe(65_000);
  expect(drain).toHaveBeenCalled();
});
it("Stop interrupts the wait without changing its pending row", async () => {
  const { error } = refusal(CONTENT);
  expect(await settleRefusedFence(f.db, error, () => true)).toBe(false);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
});
it("an obligation with no runnable checker exhausts the real 65-second bound once", async () => {
  f.db.exec("DELETE FROM memory_revoke_jobs");
  const { error, built } = refusal(CONTENT);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const result = settleRefusedFence(f.db, error);
  const directResult = settleDirectRefusal(f.db, error, () => false);
  await vi.advanceTimersByTimeAsync(65_000);
  expect(await result).toBe(false);
  expect(await directResult).toBe(false);
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const wake = vi.fn();
  const result = settleRefusedFence(f.db, error, undefined, 100, wake);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
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
  expect(await revocation.settleRevokesForTurn(f.db, 20)).toBe(false);
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded"), settle = vi.spyOn(revocation, "settleRevokesForTurn");
  const wake = vi.fn();
  setTimeout(() => f.db.exec("DELETE FROM memory_deny_pending"), 1_500);
  const result = awaitExactPendingCheck(f.db, error, undefined, 5_000, wake);
  await vi.advanceTimersByTimeAsync(1_600);
  expect(await result).toBe(true);
  expect(drain).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(wake.mock.calls.length).toBeGreaterThanOrEqual(2);
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const drain = vi.spyOn(revocation, "drainRevokeMarkerBounded"), wake = vi.fn();
  const result = awaitExactPendingCheck(f.db, error, undefined, 100, wake);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
  expect(drain).not.toHaveBeenCalled();
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  const settled = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: { state: "withheld", reason: "deny-line" } });
  const idle = vi.fn();
  expect(await awaitExactPendingCheck(f.db, settled, undefined, 100, idle)).toBe(true);
  expect(idle).not.toHaveBeenCalled();
});
