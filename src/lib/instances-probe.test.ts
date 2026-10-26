// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { probeInstances } from "./instances-probe";

describe("one engine probe in flight at a time (item 167)", () => {
  it("two callers at once share one request", async () => {
    let release!: (value: string) => void;
    const request = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const a = probeInstances("/api/instances", request);
    const b = probeInstances("/api/instances", request);
    release("engines");
    await expect(Promise.all([a, b])).resolves.toEqual(["engines", "engines"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a later call after it settles asks again, and a fresh probe is its own request", async () => {
    const request = vi.fn(async (path: string) => path);
    await probeInstances("/api/instances", request);
    await probeInstances("/api/instances", request);
    expect(request).toHaveBeenCalledTimes(2);
    let release!: () => void;
    const slow = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve("x"); }));
    const first = probeInstances("/api/instances", slow);
    const fresh = probeInstances("/api/instances?fresh=1", request);
    release();
    await Promise.all([first, fresh]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("a failure reaches every waiter and the next call starts fresh", async () => {
    const failing = vi.fn(async () => { throw new Error("offline"); });
    await expect(Promise.all([
      probeInstances("/api/instances", failing).catch((e: Error) => e.message),
      probeInstances("/api/instances", failing).catch((e: Error) => e.message),
    ])).resolves.toEqual(["offline", "offline"]);
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(probeInstances("/api/instances", async () => "ok")).resolves.toBe("ok");
  });
});
