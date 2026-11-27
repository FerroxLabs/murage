import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { source as serverSource, wiring } from "../decision-wiring/fixture.ts";
import { EngineInputRevoked } from "../drivers/engine-input.ts";
import { DirectRebuildCancelled } from "../independent-thread-runs.ts";
import { MemoryRefusalCauses, memoryRefusalCause, sessionCheckRefusal, turnRefusedLine } from "./dispatch.ts";
import { awaitExactPendingCheck as settleRefusedFence } from "./fence-pending.ts";

const checking = new EngineInputRevoked({ state: "checking", reason: "pending" });
const withheld = new EngineInputRevoked({ state: "withheld", reason: "deny-line" });
const raw = (fence: unknown, extra = {}) => Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence, ...extra });
describe("MEMSTART B / T10 cause selection", () => {
  it.each([checking, raw({ state: "checking", reason: "pending" }), sessionCheckRefusal({ reason: "lineage-warming" }), Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { unproven: "memory-frame-checking" }), ...["no-lineage", "thread-not-ready", "footprint-wide", "lookup-error", "not-built"].map(reason => raw({ state: "checking", reason }))])("recognizes supported unfinished checks %#", error => {
    expect(memoryRefusalCause(error)).toBe("checking");
  });
  it.each([withheld, raw({ state: "withheld", reason: "tombstone" }, { unproven: "memory-frame-checking" }), Object.assign(new EngineInputRevoked({ state: "withheld", reason: "deny-line" }), { unproven: "lineage-warming", fence: { state: "checking", reason: "pending" } })])("withheld wins over checking %#", error => {
    expect(memoryRefusalCause(error)).toBe("changed");
  });
  it.each([new Error("MEMORY_CONTEXT_REVOKED"), null, raw(null), raw({ state: "checking" }), raw({ state: "checking", reason: "new-reason" }), raw({ state: "withheld", reason: "pending" }), raw({ state: "shown" }, { unproven: "lineage-warming" }), raw({ state: "checking", reason: "pending" }, { verdict: { state: "checking", reason: "lookup-error" } }), raw({ state: "checking", reason: "pending" }, { unproven: 1 }), Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { unproven: "unexpected" })])("unknown or inconsistent tags remain conservative %#", error => {
    expect(memoryRefusalCause(error)).toBe("unknown");
  });
  it("retains mixed history through marker consumption and both orders of refusal sites", () => {
    for (const sequence of [[checking, withheld, checking], [withheld, checking, checking], [checking, checking, checking]]) {
      const history = new MemoryRefusalCauses();
      sequence.forEach((error, i) => history.record("message", error, i === 0));
      const marker = new Set(["message"]); marker.delete("message");
      expect(history.kind("message")).toBe(sequence.includes(withheld) ? "without-memory" : "without-memory-checking");
      const selected = history.kind("message"); history.delete("message");
      expect(history.kind("message")).toBe("without-memory-unknown");
      expect(turnRefusedLine("Claude", selected)).toMatch(/remembered context/);
    }
  });
  it("eviction mid-retry cannot turn earlier change into checking-only", () => {
    const history = new MemoryRefusalCauses(2);
    history.record("old", withheld, true);
    history.record("other", checking, true); history.record("third", checking, true);
    history.record("old", checking, false);
    expect(history.kind("old")).toBe("without-memory-unknown");
    history.delete("old"); history.record("old", checking, true);
    expect(history.kind("old")).toBe("without-memory-checking");
  });
  it("unknown history stays neutral; separate messages never share causes", () => {
    const history = new MemoryRefusalCauses();
    history.record("a", new Error("MEMORY_CONTEXT_REVOKED"), true); history.record("a", checking, false);
    history.record("b", checking, true);
    expect(history.kind("a")).toBe("without-memory-unknown");
    expect(history.kind("b")).toBe("without-memory-checking");
    expect(turnRefusedLine("Claude", history.kind("a"))).toBe("This reply ran without remembered context.");
    expect(turnRefusedLine("Claude", history.kind("b"))).toBe("Murage prepared this reply from your message, with remembered context left out.");
    expect(turnRefusedLine("Claude", "without-memory")).toBe("This reply went ahead without remembered context after memory changed.");
  });
});

// Exercise the production rebuild helper, including admission that returns without launching (a held continuation).
function rebuildFixture(active = true, refusal = withheld) {
  const causes = new MemoryRefusalCauses(); causes.record("message", withheld, true);
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  const markers = new Set<string>(), free = vi.fn(), wake = vi.fn();
  const { rebuildRefusedDirectTurn } = wiring(["rebuildRefusedDirectTurn"], {
    settleRefusedFence, database: () => db, directRuns: { rebuilding: () => active },
    memoryRefusalCauses: causes, freeThreadAfterRebuild: free, markLastResort: (id: string) => markers.add(id),
    lastResortMessages: markers, DirectRebuildCancelled, schedulePendingFenceCheck: wake,
  });
  const held = { generation: "generation" }, owner = { held: () => active };
  return { causes, markers, free, wake, run: (start: () => Promise<unknown>) =>
    rebuildRefusedDirectTurn(held, owner, "message", { attempt: 1, lastResort: true }, start, refusal, true) };
}
describe("MEMSTART B direct admission cleanup", () => {
  it("keeps history when a rebuild is admitted, until its eventual notice", async () => {
    const f = rebuildFixture(); expect(await f.run(async () => ({ id: "message" }))).toEqual({ kind: "started" });
    expect(f.causes.kind("message")).toBe("without-memory"); expect(f.free).not.toHaveBeenCalled();
  });
  it("cleans history when admission returns without launching, preserving the existing return and marker", async () => {
    const f = rebuildFixture(); expect(await f.run(async () => undefined)).toEqual({ kind: "started" });
    expect(f.causes.kind("message")).toBe("without-memory-unknown");
    expect(f.free).not.toHaveBeenCalled(); expect(f.markers.has("message")).toBe(true);
  });
  it("cleans a stopped settle before calling admission", async () => {
    const f = rebuildFixture(false, checking), start = vi.fn(async () => ({}));
    expect(await f.run(start)).toEqual({ kind: "stopped" });
    expect(f.wake).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled(); expect(f.free).toHaveBeenCalledTimes(1); expect(f.causes.kind("message")).toBe("without-memory-unknown");
  });
  it("cleans a failed admission and returns the same error to the owner for reporting", async () => {
    const f = rebuildFixture(), error = new Error("admission failed");
    const result = await f.run(async () => { throw error; });
    expect(result.kind).toBe("rejected"); expect(result.error).toBe(error);
    expect(f.causes.kind("message")).toBe("without-memory-unknown"); expect(f.markers.size).toBe(0); expect(f.free).not.toHaveBeenCalled();
  });
  it("cleans a cancelled admission with a stopped result", async () => {
    const f = rebuildFixture(); expect(await f.run(async () => { throw new DirectRebuildCancelled(); })).toEqual({ kind: "stopped" });
    expect(f.causes.kind("message")).toBe("without-memory-unknown"); expect(f.markers.size).toBe(0); expect(f.free).toHaveBeenCalledTimes(1);
  });
});

// C11's released-submission ticket also owns MEMSTART's retained cause.
describe("MEMSTART cleanup after a released submission", () => {
  it.each(["none", "card"])("settles %s once, clears cause history, and never redispatches", outcome => {
    const start = serverSource.indexOf("const releasedTicket: LateMemoryTicket =");
    const end = serverSource.indexOf("registerLateTicket(accepted.turnId, releasedTicket)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const ticketJS = ts.transpile(serverSource.slice(start, end), { target: ts.ScriptTarget.ES2022 });
    const causes = new MemoryRefusalCauses(); causes.record("message", withheld, true);
    const card = vi.fn(), settleDispatch = vi.fn(), routineToken = {};
    const ticket = new Function("memoryRefusalCauses", "userMessage", "routineToken", "routines", "ROUTINE_REBUILD_STOPPED", "card", ticketJS + ";return releasedTicket;")(
      causes, { id: "message" }, routineToken, { settleDispatch }, "stopped", card,
    );
    expect(ticket.redispatch).toBe(false);
    expect(ticket.afterSubmission).toBe(true);
    ticket.take(outcome); ticket.take(outcome);
    expect(ticket.owed).toBe(false);
    expect(causes.kind("message")).toBe("without-memory-unknown");
    expect(card).toHaveBeenCalledTimes(outcome === "card" ? 1 : 0);
    expect(settleDispatch).toHaveBeenCalledTimes(outcome === "none" ? 1 : 0);
  });
});
