import { describe, expect, it } from "vitest";
import { EarlyBundle, bundleFailureCause } from "./early-bundle.ts";

describe("bundleFailureCause", () => {
  it("names only the bundle's own codes, never text from the error", () => {
    expect(bundleFailureCause(new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch"))).toBe("MEMORY_PIN_UNAVAILABLE");
    expect(bundleFailureCause(new Error("MEMORY_PIN_BUDGET: 3/2"))).toBe("MEMORY_PIN_BUDGET");
    expect(bundleFailureCause(new Error("SECRETWORD is what the user typed"))).toBe("other");
    expect(bundleFailureCause(Object.assign(new Error("boom"), { name: "/home/me/private" }))).toBe("other");
    expect(bundleFailureCause("MEMORY_PIN_BUDGET")).toBe("other");
  });
});

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
    early.cancel("setup-failed"); // a mount failed or the turn was cancelled
    early.cancel("spent");
    expect(early.cancelledBy).toBe("setup-failed"); // the step that really stopped it
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
