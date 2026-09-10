import { describe, expect, it } from "vitest";
import type { RoutineWatchState } from "../shared/routine-watch.ts";
import { completeRoutineWatchCheck, createRoutineWatchState, pauseRoutineWatch, readRoutineWatchState, reserveRoutineWatchCheck } from "./routine-watch-state.ts";

const A = "a".repeat(64), B = "b".repeat(64);
const definition = { id: "watch-1", source: { adapterId: "fake", sourceId: "fixture", scopeId: "owner-task" }, expiresAt: 1_000, maxChecks: 4 };
const fresh = () => createRoutineWatchState(definition, 0);
const restored = (state: RoutineWatchState) => readRoutineWatchState(JSON.parse(JSON.stringify(state)));
function check(state: RoutineWatchState, id: string, hash: string | null, now: number) {
  const reserved = reserveRoutineWatchCheck(state, id, now);
  expect(reserved.outcome).toBe("admitted");
  // Fake source completion only after the simulated persistence roundtrip.
  return completeRoutineWatchCheck(restored(reserved.state), id, hash === null ? null : { fingerprint: hash }, now);
}

describe("pure watch-state foundation (no source or scheduler integration)", () => {
  it("establishes a quiet baseline, ignores unchanged reads and reports relevant changes", () => {
    const baseline = check(fresh(), "one", A, 1);
    expect(baseline.outcome).toBe("baseline");
    const unchanged = check(baseline.state, "two", A, 2);
    expect(unchanged.outcome).toBe("unchanged");
    const changed = check(unchanged.state, "three", B, 3);
    expect(changed.outcome).toBe("changed");
    expect(changed.state.checkpoint).toBe(B);
    expect(check(changed.state, "four", A, 4).outcome).toBe("changed");
  });

  it("deduplicates pending and completed wakes after serialization and fences replayed results", () => {
    const pending = reserveRoutineWatchCheck(fresh(), "same", 1).state;
    expect(reserveRoutineWatchCheck(restored(pending), "same", 2).outcome).toBe("duplicate");
    expect(reserveRoutineWatchCheck(pending, "other", 2).outcome).toBe("busy");
    const complete = completeRoutineWatchCheck(pending, "same", { fingerprint: A }, 2).state;
    expect(reserveRoutineWatchCheck(restored(complete), "same", 3).outcome).toBe("duplicate");
    expect(completeRoutineWatchCheck(restored(complete), "same", { fingerprint: B }, 3).outcome).toBe("stale");
    expect(complete.checks).toHaveLength(1);
  });

  it("charges failed reads and enforces the cap before another admission", () => {
    const initial = createRoutineWatchState({ ...definition, maxChecks: 2 }, 0);
    const baseline = check(initial, "one", A, 1);
    const failed = check(baseline.state, "two", null, 2);
    expect(failed.outcome).toBe("failed");
    expect(failed.state.checkpoint).toBe(A);
    expect(reserveRoutineWatchCheck(failed.state, "three", 3).outcome).toBe("limit-reached");
    expect(reserveRoutineWatchCheck(pauseRoutineWatch(pauseRoutineWatch(failed.state, true, 3), false, 4), "four", 5).outcome).toBe("limit-reached");
  });

  it("does not turn a failed first read into a baseline", () => {
    const failed = check(fresh(), "one", null, 1);
    expect(failed.state.checkpoint).toBeUndefined();
    expect(check(failed.state, "two", B, 2).outcome).toBe("baseline");
  });

  it("expires at the exact boundary and abandons reads that finish after expiry", () => {
    const pending = reserveRoutineWatchCheck(fresh(), "one", 999).state;
    expect(reserveRoutineWatchCheck(fresh(), "two", 1_000).outcome).toBe("expired");
    const expired = completeRoutineWatchCheck(pending, "one", { fingerprint: A }, 1_000);
    expect(expired.outcome).toBe("abandoned");
    expect(expired.state.checkpoint).toBeUndefined();
    expect(reserveRoutineWatchCheck(pauseRoutineWatch(expired.state, false, 1_001), "two", 1_002).outcome).toBe("expired");
  });

  it("pause fences in-flight reads, preserves checkpoints and cannot revive a late completion", () => {
    const baseline = check(fresh(), "one", A, 1).state;
    const pending = reserveRoutineWatchCheck(baseline, "two", 2).state;
    const paused = pauseRoutineWatch(pending, true, 3);
    expect(reserveRoutineWatchCheck(paused, "three", 4).outcome).toBe("paused");
    const resumed = pauseRoutineWatch(restored(paused), false, 5);
    expect(completeRoutineWatchCheck(resumed, "two", { fingerprint: B }, 6).outcome).toBe("stale");
    expect(resumed.checkpoint).toBe(A);
    expect(resumed.checks).toHaveLength(2);
    expect(check(resumed, "three", B, 7).outcome).toBe("changed");
  });

  it("keeps a stranded reservation charged and blocked until explicitly abandoned", () => {
    const pending = restored(reserveRoutineWatchCheck(fresh(), "crashed", 1).state);
    expect(reserveRoutineWatchCheck(pending, "new", 2).outcome).toBe("busy");
    const recovered = pauseRoutineWatch(pauseRoutineWatch(pending, true, 3), false, 4);
    expect(reserveRoutineWatchCheck(recovered, "crashed", 5).outcome).toBe("duplicate");
    expect(check(recovered, "new", A, 5).state.checks).toHaveLength(2);
  });

  it("never mutates caller-owned state or source references", () => {
    const initial = fresh(), before = JSON.stringify(initial);
    const reserved = reserveRoutineWatchCheck(initial, "one", 1).state;
    reserved.definition.source.sourceId = "different";
    expect(JSON.stringify(initial)).toBe(before);
    const completed = check(initial, "two", A, 2).state;
    const saved = JSON.stringify(completed);
    pauseRoutineWatch(completed, true, 3);
    expect(JSON.stringify(completed)).toBe(saved);
    expect(definition.source.sourceId).toBe("fixture");
  });

  it("rejects malformed bounds, checkpoints, source identities and clock rollback", () => {
    expect(() => createRoutineWatchState({ ...definition, maxChecks: 0 }, 0)).toThrow();
    expect(() => createRoutineWatchState({ ...definition, maxChecks: 10_001 }, 0)).toThrow();
    expect(() => createRoutineWatchState({ ...definition, expiresAt: 0 }, 0)).toThrow();
    expect(() => createRoutineWatchState({ ...definition, source: { ...definition.source, scopeId: "" } }, 0)).toThrow();
    expect(() => readRoutineWatchState({ ...fresh(), checkpoint: A })).toThrow();
    const pending = reserveRoutineWatchCheck(fresh(), "one", 2).state;
    expect(() => reserveRoutineWatchCheck(pending, "two", 1)).toThrow("clock moved backwards");
    expect(() => completeRoutineWatchCheck(pending, "one", { fingerprint: "raw secret" }, 3)).toThrow();
    expect(() => readRoutineWatchState({ ...pending, checks: [...pending.checks, ...pending.checks] })).toThrow();
    expect(() => readRoutineWatchState({ ...pending, paused: true })).toThrow();
  });

  it("rejects a forged changed receipt without a preceding baseline", () => {
    expect(() => readRoutineWatchState({ ...fresh(), checkpoint: A, checks: [{ id: "fake", outcome: "changed", fingerprint: A }] })).toThrow();
    const baseline = check(fresh(), "one", A, 1).state;
    expect(() => readRoutineWatchState({ ...baseline, checkpoint: B })).toThrow();
    expect(completeRoutineWatchCheck(baseline, "unknown", null, 2).outcome).toBe("stale");
  });
});
