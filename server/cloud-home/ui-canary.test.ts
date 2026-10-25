// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./browser-process.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./browser-process.ts")>()), spawnCanaryBrowser: vi.fn(() => null) }));
import { spawnCanaryBrowser } from "./browser-process.ts";
import { createUiCanary, domShowsUi, resetUiCanaryForTests, startUiCanary, uiHealth, UI_CANARY_USER_AGENT, type CanarySpawner, type UiCanaryRequest } from "./ui-canary.ts";
import { publicHealthBody, cloudHealthVersion } from "./health.ts";

const good = '<html lang="en" data-murage-mounted="1"><body><main class="x" data-murage-door="continue">hi</main></body></html>';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { resetUiCanaryForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("domShowsUi", () => {
  it("needs the mount mark and a finished, usable door (continue or other-device)", () => {
    expect(domShowsUi(good)).toBe(true);
    for (const v of ["continue", "other-device"]) expect(domShowsUi(good.replace("continue", v))).toBe(true);
    for (const v of ["working", "unavailable", "message", "bogus"]) expect(domShowsUi(good.replace("continue", v))).toBe(false);
    expect(domShowsUi(good.replace('data-murage-mounted="1"', ""))).toBe(false);
    expect(domShowsUi(good.replace('data-murage-mounted="1"', 'data-murage-mounted="0"'))).toBe(false);
    expect(domShowsUi(good.replace("<main", "<div").replace("</main>", "</div>"))).toBe(false);
    expect(domShowsUi("")).toBe(false);
  });
});

const flush = () => vi.advanceTimersByTimeAsync(0);
type FakeSpawner = CanarySpawner & { closed: boolean; drained: ReturnType<typeof vi.fn> };
function fakeSpawner(): FakeSpawner {
  const spawner = { closed: false, spawn: vi.fn(() => null), drained: vi.fn(async (_ms: number) => true) };
  return spawner as unknown as FakeSpawner;
}
/** A pending promise the test settles by hand. */
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((ok, bad) => { resolve = ok; reject = bad; }); return { promise, resolve, reject }; }
function rig(over: { cleanup?: () => Promise<void>; capMs?: number; publishInstance?: () => void; log?: (line: string) => void } = {}) {
  const spawners: FakeSpawner[] = [];
  const launches: { req: UiCanaryRequest; ok: (dom: string) => void; bad: (error: Error) => void }[] = [];
  const launcher = vi.fn((req: UiCanaryRequest) => new Promise<string>((ok, bad) => { launches.push({ req, ok, bad }); }));
  const cleanup = vi.fn(over.cleanup ?? (async () => {}));
  const makeSpawner = vi.fn(() => { const s = fakeSpawner(); spawners.push(s); return s as CanarySpawner; });
  const log = vi.fn(over.log ?? (() => {}));
  const publishInstance = vi.fn(over.publishInstance ?? (() => {}));
  const canary = createUiCanary({ launcher, cleanup, makeSpawner, publishInstance, log, ...(over.capMs ? { capMs: over.capMs } : {}) });
  return { canary, launcher, cleanup, makeSpawner, spawners, launches, publishInstance, log };
}

describe("controller: boot, ownership and the fence", () => {
  it("T1 boot tears down any earlier canary browser before the first launch", async () => {
    const r = rig();
    const run = r.canary.runOnce(); await flush();
    expect(r.cleanup).toHaveBeenCalledTimes(1);
    expect(r.launcher).toHaveBeenCalledTimes(1);
    expect(r.cleanup.mock.invocationCallOrder[0]!).toBeLessThan(r.launcher.mock.invocationCallOrder[0]!);
    r.launches[0]!.ok(good); await run;
    expect(r.canary.status()).toBe("ok");
  });
  it("r7 the new instance is written BEFORE boot cleanup, and cleanup runs before the first launch", async () => {
    const r = rig();
    const run = r.canary.runOnce(); await flush();
    expect(r.publishInstance).toHaveBeenCalledTimes(1);
    expect(r.publishInstance.mock.invocationCallOrder[0]!).toBeLessThan(r.cleanup.mock.invocationCallOrder[0]!);
    expect(r.cleanup.mock.invocationCallOrder[0]!).toBeLessThan(r.launcher.mock.invocationCallOrder[0]!);
    r.launches[0]!.ok(good); await run;
  });
  it("r7 if the instance cannot be written, nothing is cleaned or launched, the state is dirty, and the next tick retries", async () => {
    let fail = true;
    const r = rig({ publishInstance: () => { if (fail) throw new Error("disk"); } });
    expect(await r.canary.runOnce()).toBe("failed");
    expect(r.cleanup).not.toHaveBeenCalled(); expect(r.launcher).not.toHaveBeenCalled();
    expect(r.canary.snapshot()).toMatchObject({ phase: "dirty", verdict: { ui: "failed" } });
    fail = false;
    const retry = r.canary.runOnce(); await flush();
    expect(r.cleanup).toHaveBeenCalledTimes(1); expect(r.launcher).toHaveBeenCalledTimes(1);
    r.launches[0]!.ok(good); expect(await retry).toBe("ok");
  });
  it("r7 a launch the root launcher refused as stale is a plain failed check; teardown runs and the next cycle retries", async () => {
    const r = rig();
    const first = r.canary.runOnce(); await flush();
    r.launches[0]!.bad(new Error("Your Cloud restarted while this browser was starting. Try again.")); expect(await first).toBe("failed");
    expect(r.canary.snapshot().phase).toBe("clean");
    const second = r.canary.runOnce(); await flush();
    expect(r.launcher).toHaveBeenCalledTimes(2);
    r.launches[1]!.ok(good); expect(await second).toBe("ok");
  });
  it("r7 logs exactly one fixed-word [ui-canary] line per tick: launch gen and result, then unconfirmed teardown with busy exit 75", async () => {
    const r = rig({ cleanup: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("busy secret-token <html>"), { busy: true })) as never });
    const first = r.canary.runOnce(); await flush();
    r.launches[0]!.ok(good); await first;
    expect(r.log.mock.calls.map(c => c[0])).toEqual(["[ui-canary] launch gen=1 result=ok teardown-unconfirmed cleanup-busy-exit-75"]);
  });
  it("r7 overlapping calls share one tick (one line), and an instance-write failure logs one fixed line without the error text", async () => {
    const r = rig({ publishInstance: () => { throw new Error("disk /secret/path"); } });
    await Promise.all([r.canary.runOnce(), r.canary.runOnce(), r.canary.runOnce()]);
    expect(r.log.mock.calls.map(c => c[0])).toEqual(["[ui-canary] instance-write-failed"]);
    await r.canary.runOnce();
    expect(r.log).toHaveBeenCalledTimes(2);   // one line per tick, never more
    for (const [line] of r.log.mock.calls) expect(line).toMatch(/^\[ui-canary\] [a-z0-9= -]+$/);
  });
  it("r7 a stale-instance refusal (exit 76) of the canary's launch is named in that tick's one line", async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>; child.kill = vi.fn(); child.pid = 1;
    vi.mocked(spawnCanaryBrowser).mockReturnValueOnce(child as never);
    const log = vi.fn();
    const canary = createUiCanary({
      launcher: async req => { req.spawner.spawn([], {}); child.emit("close", 76); throw new Error("launch refused"); },
      cleanup: async () => {}, publishInstance: () => {}, log,
    });
    expect(await canary.runOnce()).toBe("failed");
    expect(log.mock.calls.map(c => c[0])).toEqual(["[ui-canary] stale-instance launch gen=1 result=failed error=other"]);
  });
  it("T1 a failed boot teardown is failed, launches nothing, and the next tick retries", async () => {
    const r = rig({ cleanup: vi.fn().mockRejectedValueOnce(new Error("scope survived")) as never });
    expect(await r.canary.runOnce()).toBe("failed");
    expect(r.launcher).not.toHaveBeenCalled();
    expect(r.canary.snapshot()).toMatchObject({ phase: "dirty", gen: 0, verdict: { ui: "failed", gen: 0 } });
    const retry = r.canary.runOnce(); await flush();
    expect(r.launcher).toHaveBeenCalledTimes(1);
    r.launches[0]!.ok(good); expect(await retry).toBe("ok");
  });
  it("T2 replay of the r5 race: a capped launch that settles late cannot disturb a newer launch", async () => {
    const r = rig();
    const a = r.canary.runOnce(); await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await a).toBe("failed");
    expect(r.canary.snapshot()).toMatchObject({ phase: "clean", gen: 1 });
    const b = r.canary.runOnce(); await flush();
    expect(r.launcher).toHaveBeenCalledTimes(2);
    const before = r.canary.snapshot();
    r.launches[0]!.ok(good); await flush();            // A resolves ok, late
    expect(r.canary.snapshot()).toEqual(before);
    r.launches[0]!.bad(new Error("late")); await flush();   // (settling twice is a no-op; the record is unchanged either way)
    expect(r.canary.snapshot()).toEqual(before);
    expect(r.canary.status()).toBe("failed");
    // B's cap drains B; it never returns to clean by A's doing, and nothing launches meanwhile.
    const hold = gate<void>(); r.cleanup.mockImplementationOnce(() => hold.promise);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.canary.snapshot()).toMatchObject({ phase: "draining", gen: 2 });
    expect(r.canary.runOnce()).toBe(b);
    expect(r.launcher).toHaveBeenCalledTimes(2);
    hold.resolve(); await b;
    expect(r.canary.snapshot()).toMatchObject({ phase: "clean", gen: 2 });
  });
  it("T2 a late throw from an old launch also writes nothing", async () => {
    const r = rig();
    const a = r.canary.runOnce(); await flush();
    await vi.advanceTimersByTimeAsync(20_000); await a;
    const b = r.canary.runOnce(); await flush();
    const before = r.canary.snapshot();
    r.launches[0]!.bad(new Error("late")); await flush();
    expect(r.canary.snapshot()).toEqual(before);
    r.launches[1]!.ok(good); expect(await b).toBe("ok");
  });
  it("T3 a cap fences the launch, drains its children and tears down before any next launch", async () => {
    const r = rig();
    const first = r.canary.runOnce(); await flush();
    const drain = gate<boolean>(); r.spawners[0]!.drained.mockImplementationOnce(() => drain.promise);
    const cleanupsBefore = r.cleanup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.launches[0]!.req.signal.aborted).toBe(true);             // fenced
    expect(r.canary.snapshot()).toMatchObject({ phase: "draining", gen: 1, verdict: { ui: "failed", gen: 1 } });
    expect(r.cleanup.mock.calls.length).toBe(cleanupsBefore);          // children not closed yet: no cleanup
    expect(r.canary.runOnce()).toBe(first);
    expect(r.launcher).toHaveBeenCalledTimes(1);
    drain.resolve(true); await first;
    expect(r.cleanup.mock.calls.length).toBe(cleanupsBefore + 1);
    const next = r.canary.runOnce(); await flush();
    expect(r.launcher).toHaveBeenCalledTimes(2);
    r.launches[1]!.ok(good); await next;
  });
  it("T4 a drain timeout leaves it dirty with no launch; the next tick retries and, once it succeeds, launches", async () => {
    const r = rig();
    const first = r.canary.runOnce(); await flush();
    r.spawners[0]!.drained.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(20_000); expect(await first).toBe("failed");
    expect(r.canary.snapshot()).toMatchObject({ phase: "dirty", gen: 1 });
    expect(r.cleanup).toHaveBeenCalledTimes(1);                         // the boot teardown only
    expect(r.launcher).toHaveBeenCalledTimes(1);
    const retry = r.canary.runOnce(); await flush();                    // drained is true now
    expect(r.cleanup).toHaveBeenCalledTimes(2);
    expect(r.launcher).toHaveBeenCalledTimes(2);
    r.launches[1]!.ok(good); expect(await retry).toBe("ok");
  });
  it("r6 a cleanup that finds the root lock held (busy) leaves boot dirty, launches nothing, and a later free lock cleans", async () => {
    const busy = Object.assign(new Error("busy"), { busy: true });
    const cleanup = vi.fn<() => Promise<void>>().mockRejectedValueOnce(busy).mockResolvedValue();
    const r = rig({ cleanup });
    expect(await r.canary.runOnce()).toBe("failed");
    expect(r.canary.snapshot()).toMatchObject({ phase: "dirty", gen: 0 });
    expect(r.launcher).not.toHaveBeenCalled();
    const retry = r.canary.runOnce(); await flush();
    expect(cleanup).toHaveBeenCalledTimes(2); expect(r.launcher).toHaveBeenCalledTimes(1);
    r.launches[0]!.ok(good); await retry;
  });
  it("T5 a rejected cleanup is dirty; the retry confirms it and the browser is launched again", async () => {
    const cleanup = vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockRejectedValueOnce(new Error("sudo")).mockResolvedValue();
    const r = rig({ cleanup });
    const first = r.canary.runOnce(); await flush();
    r.launches[0]!.ok(good); expect(await first).toBe("failed");        // the verdict is replaced by failed: the teardown was not confirmed
    expect(r.canary.snapshot()).toMatchObject({ phase: "dirty", verdict: { ui: "failed", gen: 1 } });
    const retry = r.canary.runOnce(); await flush();                   // the retry confirms, then launches in the same run
    expect(cleanup).toHaveBeenCalledTimes(3); expect(r.launcher).toHaveBeenCalledTimes(2);
    expect(r.canary.snapshot().phase).toBe("running");
    r.launches[1]!.ok(good); await retry;
    expect(r.canary.snapshot()).toMatchObject({ phase: "clean", gen: 2, verdict: { ui: "ok", gen: 2 } });
  });
  it("T6 a tick and a manual run while running or draining share one launch and one promise", async () => {
    const hold = gate<void>();
    const cleanup = vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockImplementationOnce(() => hold.promise).mockResolvedValue();
    const r = rig({ cleanup });
    r.canary.start(); await flush();                                    // the boot run is running(1)
    const manual = r.canary.runOnce();
    expect(r.canary.runOnce()).toBe(manual);
    expect(r.launcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);                          // capped: draining(1), teardown held
    expect(r.canary.snapshot().phase).toBe("draining");
    expect(r.canary.runOnce()).toBe(manual);
    expect(r.launcher).toHaveBeenCalledTimes(1);
    hold.resolve(); await manual;
    await vi.advanceTimersByTimeAsync(10 * 60_000);                     // the next tick launches exactly once
    expect(r.launcher).toHaveBeenCalledTimes(2);
    r.canary.stop();
  });
  it("T7 status and finishedAt come from one verdict whose generation is the launch's", async () => {
    vi.setSystemTime(1_000_000);
    const r = rig();
    const first = r.canary.runOnce(); await flush();
    r.launches[0]!.ok(good); await first;
    expect(r.canary.snapshot().verdict).toEqual({ ui: "ok", at: 1_000_000, gen: 1 });
    vi.setSystemTime(2_000_000);
    const hold = gate<void>(); r.cleanup.mockImplementationOnce(() => hold.promise);
    const second = r.canary.runOnce(); await flush();
    expect(r.canary.snapshot().verdict.gen).toBe(1); expect(r.canary.status()).toBe("ok"); expect(r.canary.finishedAt()).toBe(1_000_000);   // running(2): still the previous pair
    r.launches[1]!.ok("<html></html>"); await flush();
    expect(r.canary.snapshot()).toMatchObject({ phase: "draining", gen: 2 });
    expect([r.canary.status(), r.canary.finishedAt(), r.canary.snapshot().verdict.gen]).toEqual(["failed", 2_000_000, 2]);
    hold.resolve(); await second;
  });
  it("T8 stop while running fences, drains and tears down without writing a verdict", async () => {
    const r = rig();
    const run = r.canary.runOnce(); await flush();
    const cleanups = r.cleanup.mock.calls.length;
    r.canary.stop(); await flush();
    expect(r.launches[0]!.req.signal.aborted).toBe(true);
    expect(r.spawners[0]!.drained).toHaveBeenCalled();
    expect(r.cleanup.mock.calls.length).toBe(cleanups + 1);
    await run;
    expect(r.canary.snapshot()).toMatchObject({ phase: "clean", gen: 1, verdict: { ui: "pending", at: null, gen: 0 } });
  });
  it("T9 property: 200 random interleavings never run two browsers, and every launch follows a confirmed teardown with all earlier children closed", async () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let round = 0; round < 200; round++) {
      let browser = false;                                   // a canary browser exists from a launch until a confirmed cleanup
      const spawners: FakeSpawner[] = []; const drains: { spawner: FakeSpawner; resolve: (v: boolean) => void }[] = [];
      const cleanups: { resolve: () => void; reject: (e: Error) => void }[] = [];
      const launches: { ok: (d: string) => void; bad: (e: Error) => void }[] = [];
      const violations: string[] = [];
      const launcher = vi.fn((_req: UiCanaryRequest) => {
        if (browser) violations.push("launched with a browser still present");                       // not preceded by a confirmed teardown
        if (!spawners.slice(0, -1).every(s => s.closed)) violations.push("launched with an earlier child open");
        browser = true;
        return new Promise<string>((ok, bad) => launches.push({ ok, bad }));
      });
      const canary = createUiCanary({
        launcher,
        cleanup: () => new Promise<void>((resolve, reject) => cleanups.push({ resolve: () => { browser = false; resolve(); }, reject })),
        makeSpawner: () => {
          const s = fakeSpawner(); spawners.push(s);
          s.drained.mockImplementation((_ms: number) => s.closed ? Promise.resolve(true) : new Promise<boolean>(resolve => { drains.push({ spawner: s, resolve }); }));
          return s as CanarySpawner;
        },
      });
      for (let step = 0; step < 40; step++) {
        const pick = Math.floor(random() * 8);
        if (pick === 0 || pick === 1) void canary.runOnce();
        else if (pick === 2 && launches.length) launches[Math.floor(random() * launches.length)]!.ok(random() < 0.5 ? good : "<html></html>");
        else if (pick === 3 && launches.length) launches[Math.floor(random() * launches.length)]!.bad(new Error("x"));
        else if (pick === 4) await vi.advanceTimersByTimeAsync(20_000);
        else if (pick === 5 && cleanups.length) { const c = cleanups.splice(Math.floor(random() * cleanups.length), 1)[0]!; random() < 0.7 ? c.resolve() : c.reject(new Error("no")); }
        else if (pick === 6 && spawners.length) { const s = spawners[Math.floor(random() * spawners.length)]!; s.closed = true; for (const d of drains.filter(d => d.spawner === s)) d.resolve(true); }
        else if (pick === 7 && drains.length) drains.splice(Math.floor(random() * drains.length), 1)[0]!.resolve(false);
        await flush();
      }
      // Settle everything: every hung step resolves, then one more tick must be able to run.
      for (let i = 0; i < 8; i++) {
        void canary.runOnce();
        for (const s of spawners) { s.closed = true; }
        for (const d of drains.splice(0)) d.resolve(true);
        for (const c of cleanups.splice(0)) c.resolve();
        for (const l of launches.splice(0)) l.ok(good);
        await vi.advanceTimersByTimeAsync(20_000);
      }
      canary.stop();
      expect(violations).toEqual([]);
      expect(launcher.mock.calls.length).toBeGreaterThan(0);
    }
  });
  it("loads / only with the canary user agent, never /enter", async () => {
    const r = rig();
    const run = r.canary.runOnce(); await flush();
    expect(r.launcher.mock.calls[0]![0].path).toBe("/");
    expect(r.launcher.mock.calls[0]![0].userAgent).toBe(UI_CANARY_USER_AGENT);
    expect(UI_CANARY_USER_AGENT).toBe("murage-control-canary/1");
    expect(JSON.stringify(r.launcher.mock.calls.map(c => [c[0].path, c[0].userAgent]))).not.toContain("/enter");
    r.launches[0]!.ok(good); await run;
  });
  it("runs at boot and every 10 minutes, never overlapping", async () => {
    const r = rig();
    r.canary.start(); await flush();
    expect(r.launcher).toHaveBeenCalledTimes(1); r.launches[0]!.ok(good); await flush();
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000); expect(r.launcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(r.launcher).toHaveBeenCalledTimes(2);
    r.canary.stop();
    r.launches[1]!.ok(good); await vi.advanceTimersByTimeAsync(20 * 60_000); expect(r.launcher).toHaveBeenCalledTimes(2);
  });
});

describe("home only, and the health shape", () => {
  it("does nothing on a desktop", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const launcher = vi.fn(async () => good);
    expect(startUiCanary(launcher)).toBeUndefined();
    expect(launcher).not.toHaveBeenCalled();
    expect(uiHealth()).toBeUndefined();
    expect(publicHealthBody()).toEqual({ app: "murage", door: "v2", ownerFactor: 1 });
    expect(cloudHealthVersion()).not.toHaveProperty("ui");
  });
  it("on a home, public health is exactly app and ui", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const keys = ["app", "door", "instance", "ownerFactor", "ui", "uiAt"];
    const first = publicHealthBody();
    expect(Object.keys(first).sort()).toEqual(keys);
    expect(first).toMatchObject({ app: "murage", ui: "pending", uiAt: null });
    expect(first.instance).toMatch(/^[A-Za-z0-9_-]{22}$/);
    vi.setSystemTime(1_700_000_000_000);
    startUiCanary(async () => good, process.env, { cleanup: async () => {}, publishInstance: () => {}, makeSpawner: () => fakeSpawner() }); await vi.advanceTimersByTimeAsync(0);
    const second = publicHealthBody();
    expect(Object.keys(second).sort()).toEqual(keys);
    expect(second).toMatchObject({ ui: "ok", uiAt: 1_700_000_000_000, instance: first.instance });
    vi.setSystemTime(1_700_000_100_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(publicHealthBody().uiAt).toBeGreaterThan(1_700_000_000_000);
    expect(publicHealthBody().instance).toBe(first.instance);
  });
});
