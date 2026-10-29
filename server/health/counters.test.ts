// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS, encodeWindowLine, parseOperationalWindow, type OperationalWindow } from "../../shared/health-protocol.mjs";
import { CORRELATION_ENTRIES, CORRELATION_EXPIRY_MS, EXTRACTION_STREAK_SOURCES, HealthCounters, KEYED_ROWS_PER_WINDOW, KEYED_TURN_ROWS_PER_WINDOW } from "./counters.ts";

const INSTALL = "a".repeat(32);
const T0 = Date.parse("2026-10-27T10:00:00Z");
const MIN = 60_000;

function counters(detectors?: ("backup" | "io-pressure" | "send-fence" | "dispatch-exhausted" | "resets" | "extraction")[]) {
  let now = T0;
  const c = new HealthCounters({ producer: "server", now: () => now, ...(detectors ? { detectors } : {}) });
  return { c, at: (value: number) => { now = value; }, tick: (ms = MIN) => { now += ms; return now; }, now: () => now };
}
/** Starts an epoch and rolls past the incomplete baseline window. */
function started(detectors?: Parameters<typeof counters>[0]) {
  const h = counters(detectors);
  h.c.startEpoch(INSTALL);
  const baseline = h.c.rollUp(h.tick());
  return { ...h, baseline };
}
const valid = (windows: OperationalWindow[]) => {
  for (const window of windows) {
    expect(parseOperationalWindow(window).ok, JSON.stringify(parseOperationalWindow(window))).toBe(true);
    const line = encodeWindowLine(window);
    expect(line.ok).toBe(true);
    if (line.ok) expect(Buffer.byteLength(line.value)).toBeLessThanOrEqual(HEALTH_LIMITS.recordBytes);
  }
  return windows;
};

describe("minute counters", () => {
  it("the first window of an epoch is an incomplete baseline that says boot; epochs only go up", () => {
    const h = counters();
    const epoch = h.c.startEpoch(INSTALL, 9_999_999_999);
    expect(epoch).toBe(10_000_000_000);
    const [baseline] = valid(h.c.rollUp(h.tick()));
    expect(baseline!.complete).toBe(false);
    expect(baseline!.seq).toBe(0);
    expect(baseline!.counters).toContainEqual({ detector: "coverage", engineKind: "none", code: "boot", value: 1 });
    expect(Object.values(baseline!.coverageByDetector).every(value => value === "partial")).toBe(true);
    expect(counters().c.startEpoch(INSTALL, 0)).toBe(Math.floor(T0 / 1000));
  });

  it("refuses an installation id that is not an opaque token", () => {
    expect(() => counters().c.startEpoch("Sean's Mac")).toThrow("HEALTH_INSTALLATION_ID_INVALID");
  });

  it("adds into fixed (detector, code, engine) slots; unknown names fall into the contract's other members", () => {
    const h = started();
    h.c.recordCounter("extraction", "complete", "claude");
    h.c.recordCounter("extraction", "complete", "claude", undefined, 2);
    h.c.recordCounter("extraction", "made-up-code", "claude");
    h.c.recordCounter("not-a-detector", "complete", "claude");
    h.c.recordCounter("extraction", "unusable", "some-new-engine");
    h.c.recordCounter("extraction", "complete", "claude", undefined, -5); // ignored, never subtracts
    h.c.recordCounter("extraction", "complete", "claude", undefined, Number.NaN);
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(window!.complete).toBe(true);
    expect(window!.counters).toEqual(expect.arrayContaining([
      { detector: "extraction", engineKind: "claude", code: "complete", value: 3 },
      { detector: "extraction", engineKind: "claude", code: "other", value: 1 },
      { detector: "other", engineKind: "claude", code: "other", value: 1 },
      { detector: "extraction", engineKind: "other", code: "unusable", value: 1 },
    ]));
    expect(window!.counters).toHaveLength(4);
    // Drained: the next window starts at zero.
    expect(h.c.rollUp(h.tick())).toEqual([]);
  });

  it("keeps the window's longest duration per slot", () => {
    const h = started();
    h.c.recordCounter("send-fence", "rebuild", "codex", undefined, 1, 300);
    h.c.recordCounter("send-fence", "rebuild", "codex", undefined, 1, 1200);
    h.c.recordCounter("send-fence", "rebuild", "codex", undefined, 1, 50);
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(window!.counters).toEqual([{ detector: "send-fence", engineKind: "codex", code: "rebuild", value: 3, maxDurationMs: 1200 }]);
  });

  it(`keeps ${KEYED_ROWS_PER_WINDOW} source-keyed rows per window and folds the rest into the exact aggregate; a key that is not a token is never written`, () => {
    const h = started();
    const keys = Array.from({ length: KEYED_ROWS_PER_WINDOW + 1 }, (_, index) => index.toString(16).padStart(16, "0"));
    for (const key of keys) h.c.recordCounter("extraction", "complete", "pi", key);
    h.c.recordCounter("extraction", "complete", "pi", "Work account");
    const [window] = valid(h.c.rollUp(h.tick()));
    const keyed = window!.counters.filter(row => row.sourceKey);
    expect(keyed).toHaveLength(KEYED_ROWS_PER_WINDOW);
    const unkeyed = window!.counters.filter(row => !row.sourceKey);
    expect(unkeyed).toEqual([{ detector: "extraction", engineKind: "pi", code: "complete", value: 2 }]);
    expect(JSON.stringify(window)).not.toContain("Work account");
    expect(window!.counters.reduce((sum, row) => sum + row.value, 0)).toBe(KEYED_ROWS_PER_WINDOW + 2);
  });

  it(`per-scope turn rows take at most ${KEYED_TURN_ROWS_PER_WINDOW} keyed rows, leaving the rest for per-source rows`, () => {
    const h = started();
    const key = (index: number) => index.toString(16).padStart(16, "0");
    for (let index = 0; index <= KEYED_TURN_ROWS_PER_WINDOW; index++) h.c.recordCounter("dispatch-exhausted", "completed", "claude", key(100 + index));
    for (let index = 0; index < KEYED_ROWS_PER_WINDOW - KEYED_TURN_ROWS_PER_WINDOW; index++) h.c.recordCounter("extraction", "complete", "pi", key(index));
    const [window] = valid(h.c.rollUp(h.tick()));
    const keyed = (detector: string) => window!.counters.filter(row => row.sourceKey && row.detector === detector);
    expect(keyed("dispatch-exhausted")).toHaveLength(KEYED_TURN_ROWS_PER_WINDOW);
    expect(keyed("extraction")).toHaveLength(KEYED_ROWS_PER_WINDOW - KEYED_TURN_ROWS_PER_WINDOW);
    expect(window!.counters.filter(row => !row.sourceKey)).toEqual([{ detector: "dispatch-exhausted", engineKind: "claude", code: "completed", value: 1 }]);
  });

  it("combines exactly five quiet minutes into one window with explicit complete coverage", () => {
    const h = started(["backup", "io-pressure"]);
    const start = h.now();
    for (let minute = 1; minute <= 4; minute++) expect(h.c.rollUp(h.tick())).toEqual([]);
    const [quiet] = valid(h.c.rollUp(h.tick()));
    expect(quiet).toMatchObject({ startAt: start, endAt: start + 5 * MIN, activeMs: 5 * MIN, complete: true, counters: [], facts: [], coverageByDetector: { backup: "complete", "io-pressure": "complete" } });
  });

  it("a busy minute first publishes the quiet run it ends, then itself, in order", () => {
    const h = started();
    h.c.rollUp(h.tick()); h.c.rollUp(h.tick()); // two quiet minutes held
    h.c.recordCounter("backup", "verified", "none");
    const out = valid(h.c.rollUp(h.tick()));
    expect(out).toHaveLength(2);
    expect(out[0]!.counters).toEqual([]);
    expect(out[0]!.endAt - out[0]!.startAt).toBe(2 * MIN);
    expect(out[1]!.counters).toHaveLength(1);
    expect(out[1]!.seq).toBe(out[0]!.seq + 1);
  });

  it(`at most ${HEALTH_LIMITS.factsPerRecord} facts per window; one more is counted as omitted and its detectors are partial`, () => {
    const h = started(["io-pressure", "backup"]);
    const fact = { kind: "io-minute" as const, idle: true, intervalMs: MIN, osBytes: 0, applicationBytes: 0, plannedBytesAllowed: 0, chargedBytes: 0, budgetBytes: 1, cpuFraction: 0, pollScale: 1, sourceClass: "other" as const, discontinuity: false };
    for (let index = 0; index < HEALTH_LIMITS.factsPerRecord; index++) h.c.recordFact(fact);
    const [full] = valid(h.c.rollUp(h.tick()));
    expect(full).toMatchObject({ complete: true, omitted: 0 });
    expect(full!.facts).toHaveLength(HEALTH_LIMITS.factsPerRecord);
    for (let index = 0; index <= HEALTH_LIMITS.factsPerRecord; index++) h.c.recordFact(fact);
    const [over] = valid(h.c.rollUp(h.tick()));
    expect(over).toMatchObject({ complete: false, omitted: 1, coverageByDetector: { "io-pressure": "partial", backup: "complete" } });
  });

  it("a window longer than the contract's span is cut to it and marked as a gap", () => {
    const h = started();
    h.c.recordCounter("backup", "verified", "none");
    const end = h.tick(HEALTH_LIMITS.maxWindowSpanMs + 1);
    const [window] = valid(h.c.rollUp(end));
    expect(window!.endAt - window!.startAt).toBe(HEALTH_LIMITS.maxWindowSpanMs);
    expect(window!.complete).toBe(false);
    expect(window!.counters).toContainEqual({ detector: "coverage", engineKind: "none", code: "gap", value: 1 });
  });

  it("a minute of 90 s is still complete; 90 s and 1 ms is not", () => {
    const h = started();
    h.c.recordCounter("backup", "off", "none");
    expect(valid(h.c.rollUp(h.tick(HEALTH_LIMITS.ioSampleMaxMs)))[0]!.complete).toBe(true);
    h.c.recordCounter("backup", "off", "none");
    expect(valid(h.c.rollUp(h.tick(HEALTH_LIMITS.ioSampleMaxMs + 1)))[0]!.complete).toBe(false);
  });

  it("suspend time is not active time, and an IO minute that spans it is marked discontinuous", () => {
    const h = started();
    h.tick(10_000);
    h.c.setLifecycle("suspending");
    h.tick(30_000);
    h.c.setLifecycle("resumed");
    h.c.recordFact({ kind: "io-minute", idle: true, intervalMs: MIN, osBytes: 0, applicationBytes: 0, plannedBytesAllowed: 0, chargedBytes: 0, budgetBytes: 1, cpuFraction: 0, pollScale: 1, sourceClass: "other", discontinuity: false });
    const [window] = valid(h.c.rollUp(h.tick(20_000)));
    expect(window).toMatchObject({ activeMs: 30_000, complete: false, lifecycle: "resumed" });
    expect(window!.facts[0]).toMatchObject({ kind: "io-minute", discontinuity: true });
    expect(window!.counters).toEqual(expect.arrayContaining([
      { detector: "coverage", engineKind: "none", code: "suspend", value: 1 }, { detector: "coverage", engineKind: "none", code: "resume", value: 1 }]));
    h.c.recordCounter("backup", "off", "none");
    expect(valid(h.c.rollUp(h.tick()))[0]).toMatchObject({ complete: true, lifecycle: "running" });
  });

  it("an orderly stop flushes the open window and the held quiet run", () => {
    const h = started();
    h.c.rollUp(h.tick());
    h.c.setLifecycle("stopping");
    const out = valid(h.c.flush(h.tick()));
    expect(out.map(window => window.lifecycle)).toEqual(["running", "stopping"]);
    expect(out[1]!.counters).toContainEqual({ detector: "coverage", engineKind: "none", code: "shutdown", value: 1 });
  });
});

describe("turn correlation", () => {
  it("emits per-minute deltas with keyed tokens, and the final outcome exactly once", () => {
    const h = started();
    h.c.noteTurn("thread-123", "message-456", "claude", { refusal: 1, rebuildMs: 200 });
    h.c.noteTurn("thread-123", "message-456", "claude", { refusal: 1 });
    const [first] = valid(h.c.rollUp(h.tick()));
    const fact = first!.facts[0] as Extract<OperationalWindow["facts"][number], { kind: "turn-window" }>;
    expect(fact).toMatchObject({ kind: "turn-window", engineKind: "claude", refusalDelta: 2, rebuildMsDelta: 200, resetDelta: 0, final: null });
    expect(JSON.stringify(first)).not.toMatch(/thread-123|message-456/);
    h.c.noteTurn("thread-123", "message-456", "claude", { final: "exhausted" });
    h.c.noteTurn("thread-123", "message-456", "claude", { final: "completed" }); // the first final stands
    const [second] = valid(h.c.rollUp(h.tick()));
    expect(second!.facts).toEqual([{ ...fact, at: expect.any(Number), refusalDelta: 0, rebuildMsDelta: 0, final: "exhausted" }]);
    expect(h.c.correlationSize).toBe(0);
    expect(h.c.rollUp(h.tick())).toEqual([]);
  });

  it("a plain completed or cancelled turn sends no fact, so busy rooms never fill the 16-fact record", () => {
    const h = started(["send-fence", "dispatch-exhausted", "resets"]);
    for (let index = 0; index < HEALTH_LIMITS.factsPerRecord + 4; index++) h.c.noteTurn(`thread-${index}`, `turn-${index}`, "claude", { final: index % 2 ? "cancelled" : "completed" });
    h.c.noteTurn("thread-x", "turn-x", "claude", { reset: 1, final: "completed" }); // a reset is still a fact
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(window!.facts).toEqual([expect.objectContaining({ kind: "turn-window", resetDelta: 1, final: "completed" })]);
    expect(window!.complete).toBe(true);
    expect(window!.coverageByDetector).toMatchObject({ "send-fence": "complete", "dispatch-exhausted": "complete", resets: "complete" });
    expect(h.c.correlationSize).toBe(0);
  });

  it(`holds at most ${CORRELATION_ENTRIES} turns; evicting an open one makes the turn detectors partial`, () => {
    const h = started(["send-fence", "dispatch-exhausted", "resets", "backup"]);
    for (let index = 0; index < CORRELATION_ENTRIES; index++) h.c.noteTurn("scope", `turn-${index}`, "codex", { reset: 1 });
    expect(h.c.correlationSize).toBe(CORRELATION_ENTRIES);
    // Drain the deltas (16 facts per window), in seconds so nothing expires.
    for (let pass = 0; pass <= CORRELATION_ENTRIES / HEALTH_LIMITS.factsPerRecord; pass++) h.c.rollUp(h.tick(1_000));
    h.c.noteTurn("scope", "turn-5", "codex", { reset: 1 }); // an existing turn: no eviction
    const [kept] = valid(h.c.rollUp(h.tick(1_000)));
    expect(kept!.coverageByDetector).toMatchObject({ "send-fence": "complete", resets: "complete", backup: "complete" });
    h.c.noteTurn("scope", "turn-new", "codex", { reset: 1 });
    expect(h.c.correlationSize).toBe(CORRELATION_ENTRIES);
    const [evicted] = valid(h.c.rollUp(h.tick(1_000)));
    expect(evicted!.coverageByDetector).toMatchObject({ "send-fence": "partial", "dispatch-exhausted": "partial", resets: "partial", backup: "complete" });
  });

  it("expires a turn untouched for more than 30 minutes, not one at exactly 30", () => {
    const h = started();
    h.c.noteTurn("scope", "older", "pi", {});
    h.c.rollUp(h.tick(1));
    h.c.noteTurn("scope", "newer", "pi", {});
    const newerAt = h.now();
    h.c.rollUp(h.tick(1));
    h.at(newerAt + CORRELATION_EXPIRY_MS);
    h.c.rollUp();
    expect(h.c.correlationSize).toBe(1);
    h.tick(1);
    h.c.rollUp();
    expect(h.c.correlationSize).toBe(0);
  });

  it("the keyed derivation is stable inside an epoch, changes with the next, and never shows its input", () => {
    const h = counters();
    h.c.startEpoch(INSTALL);
    const token = h.c.deriveToken("scope", "thread-123");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(h.c.deriveToken("scope", "thread-123")).toBe(token);
    expect(h.c.deriveToken("turn", "thread-123")).not.toBe(token);
    h.c.startEpoch(INSTALL, h.c.currentEpoch);
    expect(h.c.deriveToken("scope", "thread-123")).not.toBe(token);
  });

  it("scope tokens use the installation key: the same scope has the same token after a new epoch and after a restart", () => {
    const key = Buffer.alloc(32, 7);
    const scopeOf = (h: ReturnType<typeof started>) => {
      h.c.noteTurn("thread-123", `turn-${h.now()}`, "claude", { reset: 1 });
      const [window] = valid(h.c.rollUp(h.tick()));
      return (window!.facts[0] as Extract<OperationalWindow["facts"][number], { kind: "turn-window" }>).scopeToken;
    };
    const first = counters();
    first.c.setInstallationKey(key);
    first.c.startEpoch(INSTALL);
    first.c.rollUp(first.tick());
    const before = scopeOf({ ...first, baseline: [] });
    first.c.startEpoch(INSTALL, first.c.currentEpoch); // a new epoch in the same process
    first.c.rollUp(first.tick());
    expect(scopeOf({ ...first, baseline: [] })).toBe(before);
    const restarted = counters(); // a new process with the same persisted key
    restarted.c.setInstallationKey(key);
    restarted.c.startEpoch(INSTALL, first.c.currentEpoch);
    restarted.c.rollUp(restarted.tick());
    expect(scopeOf({ ...restarted, baseline: [] })).toBe(before);
    expect(restarted.c.deriveStableToken("extractor", "x")).toBe(first.c.deriveStableToken("extractor", "x"));
    expect(before).not.toBe(restarted.c.deriveToken("scope", "thread-123"));
  });
});

describe("extraction streaks", () => {
  const KEY = "b".repeat(32);
  const streakOf = (window: OperationalWindow | undefined) => window!.facts.filter(fact => fact.kind === "extraction-streak");
  it("one fact per extractor per window: leading, trailing and longest unusable runs; an all-unusable window has them all equal", () => {
    const h = started(["extraction"]);
    for (const outcome of ["unusable", "unusable", "complete", "unusable", "unusable", "unusable", "cancelled", "unusable"] as const) {
      h.c.extractionAdmitted(KEY, "gateway");
      h.c.extractionSettled(KEY, "gateway", outcome, "schema");
    }
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(streakOf(window)).toEqual([{ kind: "extraction-streak", sourceKey: KEY, engineKind: "gateway", leadingUnusable: 2, trailingUnusable: 1, maxConsecutiveUnusable: 3, settledCount: 8, orderComplete: true }]);
    expect(window!.counters).toContainEqual({ detector: "extraction", engineKind: "gateway", code: "schema", value: 6, sourceKey: KEY });
    for (let i = 0; i < 3; i++) { h.c.extractionAdmitted(KEY, "gateway"); h.c.extractionSettled(KEY, "gateway", "unusable", "length"); }
    const [next] = valid(h.c.rollUp(h.tick()));
    expect(streakOf(next)).toEqual([expect.objectContaining({ leadingUnusable: 3, trailingUnusable: 3, maxConsecutiveUnusable: 3, settledCount: 3 })]);
    // a window with nothing settled says nothing about the streak
    expect(h.c.rollUp(h.tick())).toEqual([]);
  });

  it("two attempts of one extractor in flight at once cannot prove an order", () => {
    const h = started(["extraction"]);
    h.c.extractionAdmitted(KEY, "codex"); h.c.extractionAdmitted(KEY, "codex");
    h.c.extractionSettled(KEY, "codex", "unusable"); h.c.extractionSettled(KEY, "codex", "unusable");
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(streakOf(window)).toEqual([expect.objectContaining({ settledCount: 2, orderComplete: false })]);
    expect(window!.counters).toContainEqual({ detector: "extraction", engineKind: "codex", code: "other", value: 2, sourceKey: KEY });
  });

  it("an attempt still in flight at an orderly stop settles as interrupted, and one admitted in a window settles in the next", () => {
    const h = started(["extraction"]);
    h.c.extractionAdmitted(KEY, "claude");
    const [admitted] = valid(h.c.rollUp(h.tick()));
    expect(streakOf(admitted)).toEqual([]);
    h.c.setLifecycle("stopping");
    const out = valid(h.c.flush(h.tick()));
    const counters = out.flatMap(window => window.counters);
    expect(counters).toContainEqual({ detector: "extraction", engineKind: "claude", code: "interrupted", value: 1, sourceKey: KEY });
    expect(out.flatMap(window => window.facts)).toContainEqual(expect.objectContaining({ kind: "extraction-streak", settledCount: 1, trailingUnusable: 0 }));
  });

  it(`follows at most ${EXTRACTION_STREAK_SOURCES} extractors at once; one more makes extraction partial, never a guessed streak`, () => {
    const h = started(["extraction", "backup"]);
    const keys = Array.from({ length: EXTRACTION_STREAK_SOURCES + 1 }, (_, index) => index.toString(16).padStart(32, "0"));
    for (const key of keys) { h.c.extractionAdmitted(key, "gateway"); h.c.extractionSettled(key, "gateway", "complete"); }
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(streakOf(window)).toHaveLength(EXTRACTION_STREAK_SOURCES);
    expect(window!.coverageByDetector).toMatchObject({ extraction: "partial", backup: "complete" });
    expect(window!.counters.filter(row => row.code === "complete").reduce((sum, row) => sum + row.value, 0)).toBe(keys.length);
  });

  it("a source key that is not an opaque token is never written", () => {
    const h = started(["extraction"]);
    h.c.extractionAdmitted("PRIVATE-CONNECTION", "gateway");
    h.c.extractionSettled("PRIVATE-CONNECTION", "gateway", "complete");
    const [window] = valid(h.c.rollUp(h.tick()));
    expect(JSON.stringify(window)).not.toContain("PRIVATE-CONNECTION");
    expect(window!.coverageByDetector.extraction).toBe("partial");
  });
});
