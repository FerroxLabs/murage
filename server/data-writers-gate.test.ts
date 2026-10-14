import { describe, expect, it, vi } from "vitest";

import { createDataWriterGate } from "./data-writers.ts";
import { createGracefulShutdown } from "./graceful-shutdown.ts";

/** The server releases its delegated lease from process "exit" only when this flag is set (server/index.ts). */
function harness(stopWriters: () => Promise<boolean>, cleanup: Array<() => void | Promise<void>> = []) {
  let dataWritersStopped = false;
  const release = vi.fn();
  const gate = createDataWriterGate(stopWriters, () => { dataWritersStopped = true; });
  const exits: number[] = [];
  const done = new Promise<void>((resolve) => {
    const shutdown = createGracefulShutdown({
      cleanup: [...cleanup, async () => { await gate.stop(); }],
      exit: (code) => { void gate.stop().finally(() => { exits.push(code); if (dataWritersStopped) release(); resolve(); }); },
      timeoutMs: 1_000,
    });
    shutdown();
  });
  return { done, release, exits, gate };
}

describe("data writer gate", () => {
  it("a stop before the writers started still releases the lease and exits 0", async () => {
    const stop = vi.fn(async () => true);
    // An earlier cleanup job fails (the app is stopped mid-start); the writer job still ran.
    const run = harness(stop, [async () => { throw new Error("not initialised yet"); }]);
    await run.done;
    expect(run.exits).toEqual([0]);
    expect(run.release).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("retries the stop on exit when the cleanup step never reached the writers", async () => {
    const stop = vi.fn(async () => true);
    let dataWritersStopped = false;
    const gate = createDataWriterGate(stop, () => { dataWritersStopped = true; });
    expect(dataWritersStopped).toBe(false);
    await gate.stop();
    expect(dataWritersStopped).toBe(true);
    await gate.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps the lease when a writer is stalled, and allows a later retry", async () => {
    const stop = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const run = harness(stop);
    await run.done;
    expect(run.exits).toEqual([0]);
    expect(run.release).not.toHaveBeenCalled();
    expect(await run.gate.stop()).toBe(true);
  });

  it("shares one in-flight stop between concurrent callers", async () => {
    let finish!: (ok: boolean) => void;
    const stop = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const gate = createDataWriterGate(stop, () => {});
    const a = gate.stop();
    const b = gate.stop();
    finish(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(stop).toHaveBeenCalledOnce();
  });
});
