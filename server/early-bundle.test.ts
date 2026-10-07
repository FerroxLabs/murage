import { describe, expect, it } from "vitest";
import { EarlyBundle } from "./early-bundle.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("EarlyBundle", () => {
  it("dispatch waits about max(mount, bundle), not the sum", async () => {
    const early = new EarlyBundle<string>(undefined);
    const began = Date.now();
    early.start(async () => { await sleep(150); return "bundle"; });
    await sleep(200); // the mounts
    const bundle = await early.take()!;
    const elapsed = Date.now() - began;
    expect(bundle).toBe("bundle");
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(330); // sum would be 350
  });

  it("builds once per dispatch", async () => {
    const early = new EarlyBundle<number>(undefined);
    let builds = 0;
    early.start(async () => ++builds);
    expect(() => early.start(async () => ++builds)).toThrow(/one bundle/);
    expect(await early.take()).toBe(1);
    expect(early.take()).toBeUndefined();
    expect(builds).toBe(1);
  });

  it("cancel aborts the build and a late failure is not unhandled", async () => {
    const early = new EarlyBundle<string>(undefined);
    let signal!: AbortSignal;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    early.start(async s => { signal = s; await sleep(30); s.throwIfAborted(); return "x"; });
    early.cancel(); // a mount failed or the turn was cancelled
    expect(signal.aborted).toBe(true);
    expect(early.take()).toBeUndefined();
    await sleep(80);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("a bundle failure surfaces at take(), where the sequential build threw", async () => {
    const early = new EarlyBundle<string>(undefined);
    early.start(async () => { throw new Error("MEMORY_PIN_OVERFLOW"); });
    await sleep(20); // mounts still running, nothing thrown yet
    await expect(early.take()!).rejects.toThrow("MEMORY_PIN_OVERFLOW");
  });
});
