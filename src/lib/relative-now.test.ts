// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RELATIVE_TICK_MS, readRelativeNow, resetRelativeNowForTests, subscribeRelativeNow } from "./relative-now";

describe("the shared clock behind relative times", () => {
  let visibility = "visible";
  const listeners = new Set<() => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    visibility = "visible";
    listeners.clear();
    vi.stubGlobal("document", {
      get visibilityState() { return visibility; },
      addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
      removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler),
    });
    resetRelativeNowForTests();
  });
  afterEach(() => { resetRelativeNowForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("ticks every 30 seconds with one timer for every subscriber, and stops with the last", () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeRelativeNow(a), offB = subscribeRelativeNow(b);
    expect(RELATIVE_TICK_MS).toBe(30_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(listeners.size).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(readRelativeNow()).toBe(1_030_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("rests while the window is hidden and catches up when it shows again", () => {
    const seen = vi.fn();
    subscribeRelativeNow(seen);
    visibility = "hidden";
    vi.advanceTimersByTime(90_000);
    expect(seen).not.toHaveBeenCalled();
    expect(readRelativeNow()).toBe(1_000_000);
    visibility = "visible";
    for (const listener of listeners) listener();
    expect(readRelativeNow()).toBe(1_090_000);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("never hands a first render a time from long ago", () => {
    vi.setSystemTime(5_000_000);
    expect(readRelativeNow()).toBe(5_000_000);
    vi.setSystemTime(5_010_000);
    // within one tick, reads agree with each other
    expect(readRelativeNow()).toBe(5_000_000);
  });
});

describe("sidebar rows", () => {
  it("show how long ago on the shared clock, with the full time on hover", () => {
    const sidebar = readFileSync(new URL("../components/Sidebar.tsx", import.meta.url), "utf8");
    expect(sidebar.match(/title=\{formatTaskMoment\(last\.at\)\}[^>]*>\s*\{formatRelativeListTime\(last\.at, clockNow\)\}\s*<\/time>/g)).toHaveLength(2);
    expect(sidebar.match(/const clockNow = useRelativeNow\(\);/g)).toHaveLength(2);
    expect(sidebar).not.toContain("formatListTime(");
  });
});
