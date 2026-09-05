// The double-fire guard behind the model picker's refresh control.
//
// Pinned here because the picker itself cannot be driven: the repo's
// component tests render to static markup on a node environment, so the
// sweep's verifier correctly reported that item #6 shipped with ZERO
// coverage — every test in its acceptance path passed with the production
// change reverted.
import { describe, expect, it, vi } from "vitest";

import { singleFlight } from "./single-flight.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("singleFlight", () => {
  it("ignores a second call made in the same tick", () => {
    // The whole point: two opens in one tick must not both read a stale false.
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const fire = singleFlight(run);

    fire();
    fire();
    fire();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once the first call settles", async () => {
    const first = deferred();
    const run = vi.fn(() => first.promise);
    const fire = singleFlight(run);

    fire();
    first.resolve();
    await first.promise;
    await Promise.resolve();
    fire();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears the gate when the action REJECTS, so the control cannot wedge", async () => {
    // An offline refresh must not disable the button forever.
    const failing = deferred();
    const run = vi.fn(() => failing.promise);
    const fire = singleFlight(run);

    fire();
    failing.reject(new Error("offline"));
    await failing.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    fire();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports busy true then false, including on rejection", async () => {
    const failing = deferred();
    const busy: boolean[] = [];
    const fire = singleFlight(() => failing.promise, (value) => busy.push(value));

    fire();
    expect(busy).toEqual([true]);

    failing.reject(new Error("offline"));
    await failing.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(busy).toEqual([true, false]);
  });
});
