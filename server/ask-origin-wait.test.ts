// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleWithOrigin, type ReplyOrigin } from "./ask-origin-wait.ts";

const ORIGIN: ReplyOrigin = { threadId: "peer", messageIds: ["m1"] };

function rig(needed = true) {
  let stored: ReplyOrigin | undefined;
  const listeners = new Set<() => void>();
  const settled: Array<ReplyOrigin | undefined> = [];
  const cancel = settleWithOrigin({ lookup: () => stored, needed, onSignal: (l) => { listeners.add(l); return () => listeners.delete(l); }, graceMs: 1000 }, (o) => settled.push(o));
  return { settled, listeners, cancel, store: (o: ReplyOrigin) => { stored = o; }, signal: () => [...listeners].forEach((l) => l()) };
}

describe("an ask waits for its reply row", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("delivers with the link when the row arrives a moment after the completion, not before", () => {
    vi.useFakeTimers();
    const r = rig();
    expect(r.settled).toEqual([]);
    r.signal();
    expect(r.settled).toEqual([]);
    r.store(ORIGIN);
    r.signal();
    expect(r.settled).toEqual([ORIGIN]);
    vi.advanceTimersByTime(5000);
    expect(r.settled).toEqual([ORIGIN]);
    expect(r.listeners.size).toBe(0);
  });

  it("settles at once when the row is already stored, or when there is no worker text to link", () => {
    expect(rig(false).settled).toEqual([undefined]);
    let found = false;
    settleWithOrigin({ lookup: () => ORIGIN, needed: true, onSignal: () => { found = true; return () => undefined; }, graceMs: 10 }, () => undefined);
    expect(found).toBe(false);
  });

  it("goes on without a link only when the grace ends, so the gate can withhold the text", () => {
    vi.useFakeTimers();
    const r = rig();
    vi.advanceTimersByTime(999);
    expect(r.settled).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(r.settled).toEqual([undefined]);
    r.store(ORIGIN);
    r.signal();
    expect(r.settled).toEqual([undefined]);
  });
});
