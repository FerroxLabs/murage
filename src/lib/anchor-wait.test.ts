// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ANCHOR_WAIT_MS, waitForAnchor } from "./anchor-wait";

/** A clock and a frame scheduler the test drives by hand (a frame is 16 ms). */
function rig() {
  let time = 0, queued: Array<() => void> = [];
  return {
    now: () => time,
    schedule: (callback: () => void) => { queued.push(callback); return () => { queued = queued.filter(item => item !== callback); }; },
    run(ms: number) { const end = time + ms; while (time < end) { time += 16; const batch = queued; queued = []; for (const item of batch) item(); } },
  };
}

describe("waiting for a deep link's anchor", () => {
  it("lands on a card that mounts after a slow status answer (3 s, well past the old 120 frames)", () => {
    const r = rig(), onFound = vi.fn(), onGiveUp = vi.fn();
    let mounted: object | null = null;
    waitForAnchor({ find: () => mounted, onFound, onGiveUp, now: r.now, schedule: r.schedule });
    r.run(3000);
    expect(onFound).not.toHaveBeenCalled();
    mounted = {};
    r.run(32);
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
  it("gives up once the bound passes when the anchor never mounts, and then stops looking", () => {
    const r = rig(), onFound = vi.fn(), onGiveUp = vi.fn(), find = vi.fn(() => null);
    waitForAnchor({ find, onFound, onGiveUp, now: r.now, schedule: r.schedule });
    r.run(ANCHOR_WAIT_MS - 100);
    expect(onGiveUp).not.toHaveBeenCalled();
    r.run(300);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    const looks = find.mock.calls.length;
    r.run(1000);
    expect(find.mock.calls.length).toBe(looks);
    expect(onFound).not.toHaveBeenCalled();
  });
  it("keeps the original start when it is re-run, so a re-render does not extend the wait", () => {
    const r = rig(), onGiveUp = vi.fn();
    r.run(4000);
    const cancel = waitForAnchor({ find: () => null, onFound: vi.fn(), onGiveUp, startedAt: 0, now: r.now, schedule: r.schedule });
    r.run(1100);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    cancel();
  });
  it("stops when cancelled", () => {
    const r = rig(), onGiveUp = vi.fn(), onFound = vi.fn();
    let mounted: object | null = null;
    const cancel = waitForAnchor({ find: () => mounted, onFound, onGiveUp, now: r.now, schedule: r.schedule });
    cancel(); mounted = {};
    r.run(ANCHOR_WAIT_MS + 100);
    expect(onFound).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
  it("is what the Settings opener uses, with the page top as the fallback", () => {
    const src = readFileSync(new URL("../components/SettingsModal.tsx", import.meta.url), "utf8");
    expect(src).toContain("waitForAnchor(");
    expect(src).not.toMatch(/\+\+frames < 120/);
    expect(src).toMatch(/onGiveUp: \(\) => \{[^}]*scrollTo\?\.\(\{ top: 0 \}\)/);
  });
});
