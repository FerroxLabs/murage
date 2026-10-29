// Plan usage native reporter core (GAP-PLAN-LIMITS rev 1.2, PL-02, PL-04, PL-05, PL-06): the
// normalizer, the per-bucket merge, the bounded read queue and the Codex connection channel,
// against a fake clock and a fake app-server frame stream. No credential, network or engine.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CODEX_PLAN_USAGE_LEAN_READ_MIN,
  CODEX_PLAN_USAGE_MIN,
  CodexAccountChannel,
  PLAN_USAGE_BOUNDS,
  PlanReadError,
  PlanUsageService,
  codexPlanUsageLeanRead,
  codexPlanUsageSupported,
  limitCoversModel,
  normalizeCodexRateLimits,
  observedLimitDecision,
  type NativeUsageHandle,
  type PlanUsageClock,
} from "./plan-usage.ts";
import { DIRECT_USAGE_ADAPTERS, NATIVE_PLAN_USAGE_ENGINES, PLAN_USAGE_MATRIX, billsEachUse, planReportingFor } from "./plan-usage-adapters.ts";
import { LIMIT_NO_RESET_MS } from "./limit-state.ts";
import { planEpochSecondsToMs, planLabel, planMinutesToSeconds, planPercent } from "../shared/plan-usage.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** A manual clock: timers fire only on advance(). */
function fakeClock(start = 1_000_000): PlanUsageClock & { advance(ms: number): Promise<void>; t: number } {
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock = {
    t: start,
    now: () => clock.t,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: clock.t + ms, fn }); return id; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    random: () => 0,
    async advance(ms: number) {
      const end = clock.t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock.t = Math.max(clock.t, due[1].at);
        due[1].fn();
        await flush();
      }
      clock.t = end;
      await flush();
    },
  };
  return clock;
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const win = (usedPercent: unknown, windowDurationMins: unknown = 300, resetsAt: unknown = 1_900_000_000) => ({ usedPercent, windowDurationMins, resetsAt });
const report = (primary: unknown, secondary: unknown = null, extra: Record<string, unknown> = {}) => ({ rateLimits: { limitId: "codex", primary, secondary, ...extra }, rateLimitsByLimitId: null });

/** A handle whose reads the test answers by hand. */
function manualHandle(subjectKey: string, generation: number, credentialRevision = "rev-a") {
  const calls: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const handle: NativeUsageHandle = {
    subjectKey, credentialRevision, generation,
    read: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { handle, calls };
}

describe("plan usage units", () => {
  it("validates percentages, converts native minutes and epoch seconds, and bounds labels", () => {
    expect(planPercent(0)).toBe(0);
    expect(planPercent(100)).toBe(100);
    expect(planPercent(100.5)).toBeNull();
    expect(planPercent(-1)).toBeNull();
    expect(planPercent(Number.NaN)).toBeNull();
    expect(planPercent("50")).toBeNull();
    expect(planMinutesToSeconds(300)).toBe(18_000);
    expect(planMinutesToSeconds(0)).toBeNull();
    expect(planMinutesToSeconds(null)).toBeNull();
    expect(planEpochSecondsToMs(1_900_000_000)).toBe(1_900_000_000_000);
    expect(planEpochSecondsToMs(-5)).toBeNull();
    expect(planEpochSecondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(planLabel("  Work\u0000 plan\n ")).toBe("Work plan");
    expect(planLabel("x".repeat(500))).toHaveLength(80);
    expect(planLabel("")).toBeNull();
  });

  it("pins the Codex versions that serve every plan bucket and the lean read", () => {
    expect(CODEX_PLAN_USAGE_MIN).toEqual([0, 100, 0]);
    expect(CODEX_PLAN_USAGE_LEAN_READ_MIN).toEqual([0, 154, 0]);
    expect(codexPlanUsageSupported("codex-cli 0.99.4")).toBe(false);
    expect(codexPlanUsageSupported("codex-cli 0.100.0")).toBe(true);
    expect(codexPlanUsageSupported(undefined)).toBe(false);
    expect(codexPlanUsageLeanRead("codex-cli 0.153.9")).toBe(false);
    expect(codexPlanUsageLeanRead("codex-cli 0.165.0")).toBe(true);
  });
});

describe("normalizeCodexRateLimits (PL-02)", () => {
  it("reads primary and secondary windows with explicit units and drops every other field", () => {
    const r = normalizeCodexRateLimits(report(win(42), win(7, 10_080, 1_900_500_000), { planType: "plus", credits: { balance: "12" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.buckets.keys()]).toEqual(["codex"]);
    expect(r.buckets.get("codex")).toEqual([
      { bucketId: "codex", windowId: "primary", label: "Codex", scope: "account", model: null, usedPercent: 42, windowSeconds: 18_000, resetsAt: 1_900_000_000_000, enforcement: "unknown", limitKind: null },
      { bucketId: "codex", windowId: "secondary", label: "Codex", scope: "account", model: null, usedPercent: 7, windowSeconds: 604_800, resetsAt: 1_900_500_000_000, enforcement: "unknown", limitKind: null },
    ]);
    expect(JSON.stringify([...r.buckets.values()])).not.toMatch(/plus|balance|credits/);
  });

  it("keeps named buckets apart and marks a reached limit as hard", () => {
    const r = normalizeCodexRateLimits({
      rateLimits: { limitId: "codex", primary: win(100), rateLimitReachedType: "rate_limit_reached" },
      rateLimitsByLimitId: { codex: { limitId: "codex", primary: win(100), rateLimitReachedType: "rate_limit_reached" }, "codex_other": { limitId: "codex_other", limitName: "Other model", primary: win(3) } },
    });
    expect(r.ok && [...r.buckets.keys()].sort()).toEqual(["codex", "codex_other"]);
    expect(r.ok && r.hard).toBe(true);
    expect(r.ok && r.buckets.get("codex")![0]).toMatchObject({ enforcement: "hard", limitKind: "engine" });
    const credits = normalizeCodexRateLimits({ rateLimits: { primary: win(100), rateLimitReachedType: "workspace_member_credits_depleted" } });
    expect(credits.ok && credits.buckets.get("codex")![0]!.limitKind).toBe("credits");
    expect(r.ok && r.buckets.get("codex_other")![0]).toMatchObject({ label: "Other model", usedPercent: 3, enforcement: "unknown" });
  });

  it("keeps a missing window and a missing optional value unknown, never zero", () => {
    const r = normalizeCodexRateLimits(report(win(10, null, "soon"), undefined));
    expect(r.ok && r.buckets.get("codex")).toEqual([expect.objectContaining({ usedPercent: 10, windowSeconds: null, resetsAt: null })]);
    const none = normalizeCodexRateLimits(report(null, null));
    expect(none.ok && none.buckets.get("codex")).toEqual([]);
  });

  it("refuses invalid required data and over-capacity reports as schema, never as unused quota", () => {
    for (const bad of [
      null, "x", {}, { rateLimits: null },
      report(win(101)), report(win(-1)), report(win("42")), report({}), report(5),
      { rateLimits: { limitId: "bad id!", primary: win(1) } },
      { rateLimits: { primary: win(1) }, rateLimitsByLimitId: [] },
      { rateLimits: { primary: win(1) }, rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`b${i}`, { primary: win(1) }])) },
      { rateLimits: { primary: win(1) }, rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`b${i}`, { primary: win(1), secondary: win(1) }])) },
    ]) expect(normalizeCodexRateLimits(bad)).toEqual({ ok: false, reason: "schema" });
  });
});

describe("PlanUsageService (PL-02, PL-05, PL-06)", () => {
  it("an empty inventory completes, and an account that appears later gets a real read", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    svc.demand([], { owner: true });
    svc.demand(["codex:a:owner"], { owner: true });
    expect(svc.counters.reads).toBe(0);
    expect(svc.observation("codex:a:owner")).toMatchObject({ status: "unavailable", reason: "awaiting-session", windows: [] });
    const { handle, calls } = manualHandle("codex:a:owner", svc.nextGeneration());
    svc.register(handle);
    svc.demand(["codex:a:owner"], { owner: true });
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(report(win(42)));
    await flush();
    expect(svc.observation("codex:a:owner")).toMatchObject({ status: "current", source: "native-rpc", reason: null, windows: [expect.objectContaining({ usedPercent: 42 })] });
  });

  it("a notification after a read began wins for its bucket; a full read drops buckets nobody updated since", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const { handle, calls } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { limitId: "old", primary: win(5) } });
    svc.demand(["s"], { owner: true });
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { limitId: "codex", primary: win(90) } });
    calls[0]!.resolve(report(win(40)));
    await flush();
    const o = svc.observation("s");
    expect(o.windows.map((w) => [w.bucketId, w.usedPercent])).toEqual([["codex", 90]]);
    // an update names only its own bucket: the other stays
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { limitId: "second", primary: win(1) } });
    expect(svc.observation("s").windows.map((w) => w.bucketId).sort()).toEqual(["codex", "second"]);
  });

  it("an invalid notification changes nothing", () => {
    const svc = new PlanUsageService(fakeClock());
    const { handle } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(30) } });
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(300) } });
    expect(svc.observation("s").windows.map((w) => w.usedPercent)).toEqual([30]);
    expect(svc.counters.discarded).toBe(1);
  });

  it("a process that ends takes its readings with it, and its late reply is discarded", async () => {
    const svc = new PlanUsageService(fakeClock());
    const { handle, calls } = manualHandle("s", svc.nextGeneration());
    const release = svc.register(handle);
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(30) } });
    svc.demand(["s"], { owner: true });
    release();
    expect(svc.observation("s")).toMatchObject({ status: "unavailable", reason: "awaiting-session", windows: [] });
    calls[0]!.resolve(report(win(99)));
    await flush();
    expect(svc.observation("s").windows).toEqual([]);
    expect(svc.counters.discarded).toBe(1);
    // a frame from the ended process is not heard either
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(50) } });
    expect(svc.observation("s").windows).toEqual([]);
  });

  it("a changed account source retires every older reading and process; an account change notice does too", async () => {
    const svc = new PlanUsageService(fakeClock());
    const a = manualHandle("s", svc.nextGeneration(), "rev-a");
    svc.register(a.handle);
    svc.publishEvent("s", "rev-a", a.handle.generation, { rateLimits: { primary: win(30) } });
    const b = manualHandle("s", svc.nextGeneration(), "rev-b");
    svc.register(b.handle);
    expect(svc.observation("s")).toMatchObject({ credentialRevision: "rev-b", windows: [] });
    svc.publishEvent("s", "rev-a", a.handle.generation, { rateLimits: { primary: win(31) } });
    expect(svc.observation("s").windows).toEqual([]);
    svc.demand(["s"], { owner: true });
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    b.calls[0]!.resolve(report(win(12)));
    await flush();
    expect(svc.observation("s").windows.map((w) => w.usedPercent)).toEqual([12]);
    svc.accountChanged("s", b.handle.generation);
    expect(svc.observation("s")).toMatchObject({ windows: [], reason: "identity-unresolved" });
  });

  it("paces reads: owner Refresh coalesces in 30 s, normal demand waits five minutes, a notification satisfies demand", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const { handle, calls } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.demand(["s"]);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(report(win(1)));
    await flush();
    svc.demand(["s"]);
    await clock.advance(PLAN_USAGE_BOUNDS.normalIntervalMs - 1);
    svc.demand(["s"]);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    svc.demand(["s"]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(report(win(2)));
    await flush();
    svc.demand(["s"], { owner: true });
    svc.demand(["s"], { owner: true });
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(report(win(3)));
    await flush();
    svc.demand(["s"], { owner: true });
    expect(calls).toHaveLength(3);
    await clock.advance(PLAN_USAGE_BOUNDS.ownerIntervalMs);
    // a fresh notification resets normal demand
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(4) } });
    svc.demand(["s"]);
    expect(calls).toHaveLength(3);
  });

  it("never exceeds two concurrent reads or the start budget, and defers past the queue bound", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const handles = Array.from({ length: 140 }, (_, i) => manualHandle(`s${i}`, svc.nextGeneration()));
    for (const h of handles) svc.register(h.handle);
    const keys = handles.map((h) => h.handle.subjectKey);
    for (let i = 0; i < keys.length; i += 32) svc.demand(keys.slice(i, i + 32), { owner: true });
    const started = () => handles.reduce((n, h) => n + h.calls.length, 0);
    expect(started()).toBe(2);
    expect(svc.counters.deferred).toBe(140 - 2 - PLAN_USAGE_BOUNDS.queueMax);
    expect(svc.observation("s139")).toMatchObject({ status: "deferred", reason: "queue-budget" });
    // finishing both frees concurrency, but the burst is spent: the next start waits for a token
    for (const h of handles.slice(0, 2)) h.calls[0]!.resolve(report(win(1)));
    await flush();
    expect(started()).toBe(2);
    await clock.advance(60_000 / PLAN_USAGE_BOUNDS.startsPerMinute);
    expect(started()).toBe(3);
    // with every read answered at once, one more minute allows exactly eight more starts
    const answered = new Set<unknown>();
    const answerAll = () => { for (const h of handles) for (const c of h.calls) if (!answered.has(c)) { answered.add(c); c.resolve(report(win(1))); } };
    for (let s = 0; s < 8; s++) {
      answerAll();
      await flush();
      await clock.advance(60_000 / PLAN_USAGE_BOUNDS.startsPerMinute);
    }
    expect(started()).toBe(3 + 8);
  });

  it("a read past its deadline is a timeout with bounded retries; the prior reading stays, stale", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const { handle, calls } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.demand(["s"], { owner: true });
    calls[0]!.resolve(report(win(20)));
    await flush();
    await clock.advance(PLAN_USAGE_BOUNDS.ownerIntervalMs);
    svc.demand(["s"], { owner: true });
    await clock.advance(PLAN_USAGE_BOUNDS.deadlineMs);
    expect(svc.observation("s")).toMatchObject({ status: "stale", reason: "timeout", windows: [expect.objectContaining({ usedPercent: 20 })] });
    expect(svc.observation("s").retryAt).toBe(clock.t + 60_000);
    // the answer arriving after the deadline publishes nothing
    calls[1]!.resolve(report(win(99)));
    await flush();
    expect(svc.observation("s").windows[0]!.usedPercent).toBe(20);
    svc.demand(["s"], { owner: true });
    expect(calls).toHaveLength(2);
    await clock.advance(60_000);
    svc.demand(["s"], { owner: true });
    expect(calls).toHaveLength(3);
    calls[2]!.reject(new PlanReadError("offline"));
    await flush();
    expect(svc.observation("s").retryAt).toBe(clock.t + 5 * 60_000);
  });

  it("method absence means unavailable for that process, with no retry and no other source", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const { handle, calls } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.demand(["s"], { owner: true });
    calls[0]!.reject(new PlanReadError("unsupported"));
    await flush();
    expect(svc.observation("s")).toMatchObject({ status: "unavailable", reason: "unsupported", windows: [] });
    await clock.advance(60 * 60_000);
    svc.demand(["s"], { owner: true });
    expect(calls).toHaveLength(1);
    // a new process (a Codex update) is asked again
    const next = manualHandle("s", svc.nextGeneration());
    svc.register(next.handle);
    svc.demand(["s"], { owner: true });
    expect(next.calls).toHaveLength(1);
  });

  it("a reading goes stale after its fresh window, and says when it was checked", async () => {
    const clock = fakeClock();
    const svc = new PlanUsageService(clock);
    const { handle } = manualHandle("s", svc.nextGeneration());
    svc.register(handle);
    svc.publishEvent("s", "rev-a", handle.generation, { rateLimits: { primary: win(50) } });
    const at = clock.t;
    expect(svc.observation("s")).toMatchObject({ status: "current", observedAt: at, lastSuccessAt: at, freshUntil: at + PLAN_USAGE_BOUNDS.freshMs });
    await clock.advance(PLAN_USAGE_BOUNDS.freshMs);
    expect(svc.observation("s")).toMatchObject({ status: "stale", lastSuccessAt: at });
  });
});

describe("CodexAccountChannel (PL-02, PL-04)", () => {
  const setup = (binding: { subjectKey: string; credentialRevision: string } | null = { subjectKey: "codex:i:owner", credentialRevision: "r" }, leanRead = false) => {
    const clock = fakeClock();
    const service = new PlanUsageService(clock);
    const written: string[] = [];
    const channel = new CodexAccountChannel({ write: (line) => { written.push(line); }, service, binding, leanRead, clock });
    return { clock, service, written, channel };
  };

  it("passes every non-account frame through, server requests and turn replies included", () => {
    const { channel } = setup();
    for (const line of [
      JSON.stringify({ id: 3, result: { ok: true } }),
      JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "u", delta: "hi" } }),
      JSON.stringify({ id: -4, method: "execCommandApproval", params: {} }),
      JSON.stringify({ method: "item/completed", params: { item: { id: -1, type: "commandExecution", text: "{\"id\":-1}" } } }),
      "not json {\"id\":-1",
      "",
    ]) expect(channel.intercept(line)).toBe(false);
  });

  it("reads with a reserved negative id, unlogged, and answers from its own reply", async () => {
    const { written, channel, service } = setup(undefined, true);
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    expect(written).toHaveLength(1);
    const sent = JSON.parse(written[0]!);
    expect(sent).toEqual({ jsonrpc: "2.0", id: -1, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
    expect(channel.intercept(JSON.stringify({ id: -1, result: report(win(66)) }))).toBe(true);
    await flush();
    expect(service.observation("codex:i:owner")).toMatchObject({ status: "current", windows: [expect.objectContaining({ usedPercent: 66 })] });
    expect(channel.pendingReads).toBe(0);
  });

  it("an older Codex is read without the lean flag", () => {
    const { written, channel, service } = setup(undefined, false);
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: -1, method: "account/rateLimits/read" });
  });

  it("a late reply is discarded and leaves nothing behind; a timeout never touches the turn", async () => {
    const { clock, written, channel, service } = setup();
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    await clock.advance(PLAN_USAGE_BOUNDS.deadlineMs);
    expect(channel.pendingReads).toBe(0);
    expect(channel.intercept(JSON.stringify({ id: -1, result: report(win(1)) }))).toBe(true);
    expect(service.observation("codex:i:owner")).toMatchObject({ reason: "timeout", windows: [] });
    expect(written).toHaveLength(1);
  });

  it("maps a method-not-available answer to unsupported and any other error to a bounded retry", async () => {
    const { channel, service } = setup();
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    channel.intercept(JSON.stringify({ id: -1, error: { code: -32600, message: "unknown variant `account/rateLimits/read`" } }));
    await flush();
    expect(service.observation("codex:i:owner")).toMatchObject({ status: "unavailable", reason: "unsupported" });
    const other = setup();
    other.channel.ready();
    other.service.demand(["codex:i:owner"], { owner: true });
    other.channel.intercept(JSON.stringify({ id: -1, error: { code: -32000, message: "upstream said something private" } }));
    await flush();
    const o = other.service.observation("codex:i:owner");
    expect(o.reason).toBe("offline");
    expect(JSON.stringify(o)).not.toContain("private");
  });

  it("takes account notifications off the stream; with no binding it consumes them and records nothing", () => {
    const bound = setup();
    bound.channel.ready();
    const note = JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { primary: win(12) } } });
    expect(bound.channel.intercept(note)).toBe(true);
    expect(bound.service.observation("codex:i:owner").windows.map((w) => w.usedPercent)).toEqual([12]);
    expect(bound.channel.intercept(JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } }))).toBe(true);
    expect(bound.service.observation("codex:i:owner").windows).toEqual([]);
    const unbound = setup(null);
    unbound.channel.ready();
    expect(unbound.channel.intercept(note)).toBe(true);
    expect(unbound.service.subjectKeys()).toEqual([]);
    unbound.service.demand(["codex:i:owner"], { owner: true });
    expect(unbound.written).toEqual([]);
  });

  it("discards an oversized account frame without closing anything", async () => {
    const { channel, service } = setup();
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    const huge = JSON.stringify({ id: -1, result: { rateLimits: { primary: win(1) }, pad: "x".repeat(PLAN_USAGE_BOUNDS.frameMaxChars) } });
    expect(channel.intercept(huge)).toBe(true);
    await flush();
    expect(service.observation("codex:i:owner")).toMatchObject({ reason: "schema", windows: [] });
  });

  it("close fails pending reads and releases the handle; a write failure is offline", async () => {
    const { channel, service } = setup();
    channel.ready();
    service.demand(["codex:i:owner"], { owner: true });
    channel.close();
    await flush();
    expect(channel.pendingReads).toBe(0);
    expect(service.observation("codex:i:owner")).toMatchObject({ reason: "awaiting-session" });
    const svc = new PlanUsageService(fakeClock());
    const broken = new CodexAccountChannel({ write: () => { throw new Error("EPIPE"); }, service: svc, binding: { subjectKey: "k", credentialRevision: "r" }, clock: fakeClock() });
    broken.ready();
    svc.demand(["k"], { owner: true });
    await flush();
    expect(svc.observation("k").reason).toBe("offline");
  });
});

describe("credential boundary (PL-04, PL-12)", () => {
  it("registers no direct subscription-token reader; Codex is the only native reporter", () => {
    expect(DIRECT_USAGE_ADAPTERS).toEqual([]);
    expect(Object.isFrozen(DIRECT_USAGE_ADAPTERS)).toBe(true);
    expect(NATIVE_PLAN_USAGE_ENGINES).toEqual(["codex"]);
  });

  it("the plan usage modules open no file, keyring, network or process", () => {
    for (const file of ["plan-usage.ts", "plan-usage-adapters.ts", join("..", "shared", "plan-usage.ts")]) {
      const source = readFileSync(join(here, file), "utf8");
      const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${file} imports ${spec}`).not.toMatch(/^node:(fs|child_process|https?|net|tls)|keychain|keytar|credential|auth|fetch/);
      // the adapters file names the omitted readers in its comment; the others never mention them
      const code = file === "plan-usage-adapters.ts" ? source.replace(/^\s*\/\/.*$/gm, "") : source;
      expect(code, file).not.toMatch(/\bfetch\(|readFileSync|readFile\(|auth\.json|wham\/usage|cli-chat-proxy|oauth|keychain/i);
    }
  });
});

describe("limit kind, model windows and guessed resets (upstream 0.1.130 fold-in)", () => {
  it("a refusal with no named reset retries on Murage's fallback, marked as a guess and never as a reset", () => {
    const d = observedLimitDecision({ subjectKey: "engine:codex-a", entry: { resetsAt: null, at: 1_000 }, fallbackMs: LIMIT_NO_RESET_MS, now: 2_000 });
    expect(d).toMatchObject({ state: "limited", limitKind: "engine", scope: "account", resetsAt: null, resetGuessed: true, retryAt: 1_000 + LIMIT_NO_RESET_MS, evidence: "observed" });
    const named = observedLimitDecision({ subjectKey: "engine:codex-a", entry: { resetsAt: 50_000, at: 1_000 }, fallbackMs: LIMIT_NO_RESET_MS, now: 60_000 });
    // time passing alone never proves capacity: a due limit waits for a report or a working turn
    expect(named).toMatchObject({ state: "reset-due", resetsAt: 50_000, resetGuessed: false, retryAt: 50_000 });
  });

  it("a model's own window holds that model alone; an account or credits limit holds every model", () => {
    const model = observedLimitDecision({ subjectKey: "engine:claude", entry: { resetsAt: 9_000, at: 1 }, fallbackMs: LIMIT_NO_RESET_MS, limitKind: "model", model: "opus", now: 2 });
    expect(model).toMatchObject({ scope: "model", model: "opus", bucketId: "model:opus" });
    expect(limitCoversModel(model, "opus")).toBe(true);
    expect(limitCoversModel(model, "sonnet")).toBe(false);
    const account = observedLimitDecision({ subjectKey: "engine:claude", entry: { resetsAt: 9_000, at: 1 }, fallbackMs: LIMIT_NO_RESET_MS, limitKind: "credits", now: 2 });
    expect(account).toMatchObject({ scope: "account", limitKind: "credits", model: null });
    expect(limitCoversModel(account, "sonnet")).toBe(true);
    expect(limitCoversModel({ ...account, state: "reset-due" }, "sonnet")).toBe(false);
  });

  it("every route has a capability row; pay-per-use has no plan window and only Codex reports natively", () => {
    expect(PLAN_USAGE_MATRIX.map((r) => r.route).sort()).toEqual(["api", "connected-plan", "flux", "local", "native-plan", "service"]);
    for (const row of PLAN_USAGE_MATRIX) expect(row.why.length).toBeGreaterThan(10);
    expect(planReportingFor("codex", "native-plan")).toBe("native");
    expect(planReportingFor("claude", "native-plan")).toBe("observed");
    expect(planReportingFor("grok", "native-plan")).toBe("observed");
    expect(planReportingFor("codex", "api")).toBe("pay-per-use");
    expect(billsEachUse("api")).toBe(true);
    expect(billsEachUse("native-plan")).toBe(false);
    expect(billsEachUse("flux")).toBe(false);
  });
});
