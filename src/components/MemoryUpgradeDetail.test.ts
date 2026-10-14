// SPDX-License-Identifier: AGPL-3.0-or-later
// lanes/upgui-review r3-4: the storage state is looked at again, a bounded number of times, while the conversion is known to be running
// and the health feed is not the one reporting it.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryStorageReclaimView, reclaimSizeKnown, storageNeedsOwnRefresh, watchStorageWhileConverting, type LineageStorage } from "./MemoryUpgradeDetail";

describe("storage refresh without a usable health report", () => {
  it("needs its own refresh only while converting and the feed does not say converting", () => {
    expect(storageNeedsOwnRefresh({ state: "converting" }, "unknown")).toBe(true);
    expect(storageNeedsOwnRefresh({ state: "converting" }, "idle")).toBe(true);
    expect(storageNeedsOwnRefresh({ state: "converting" }, "converting")).toBe(false);
    expect(storageNeedsOwnRefresh({ state: "reclaim-available" }, "unknown")).toBe(false);
    expect(storageNeedsOwnRefresh(null, "unknown")).toBe(false);
  });

  it("converting with no usable health contract: the next read shows the offer, and the reads are bounded", async () => {
    let server: LineageStorage = { state: "converting" };
    let reads = 0, cleared = 0; const ticks: Array<() => void> = [];
    const seen: LineageStorage[] = [];
    const stop = watchStorageWhileConverting(async () => { reads += 1; return server; }, next => seen.push(next), {
      intervalMs: 10, maxTries: 3, setTick: fn => { ticks.push(fn); return ticks.length; }, clearTick: () => { cleared += 1; },
    });
    expect(ticks.length, "an interval is running").toBe(1);
    server = { state: "reclaim-available", freeBytes: 5_000_000 };
    const tickOnce = async () => { ticks[0]!(); for (let i = 0; i < 4; i++) await Promise.resolve(); };
    await tickOnce();
    expect(reads).toBe(1);
    expect(seen.at(-1)?.state).toBe("reclaim-available");
    for (let i = 0; i < 6; i++) await tickOnce();
    expect(reads, "no more than maxTries reads").toBe(3);
    expect(cleared, "the interval ends itself").toBeGreaterThan(0);
    stop();
  });
});


describe("the hand-back offer names a size only when one was measured (r4 P3)", () => {
  const html = (storage: LineageStorage) => renderToStaticMarkup(createElement(MemoryStorageReclaimView, { storage, running: false, failed: false, onReclaim: () => {} })).replaceAll("&#x27;", "'");
  it("an index still waiting to be dropped with no free page says no amount", () => {
    const storage: LineageStorage = { state: "reclaim-available", freeBytes: 0, legacyIndexPending: true };
    expect(reclaimSizeKnown(storage)).toBe(false);
    const out = html(storage);
    expect(out).toContain("You can hand back disk space that the upgrade no longer needs.");
    expect(out).not.toMatch(/\d+ ?(MB|GB)/);
    expect(out).toContain("Hand back disk space");
  });
  it("free pages with an index still pending is also unmeasured; free pages alone is a measured amount", () => {
    expect(reclaimSizeKnown({ state: "reclaim-available", freeBytes: 5_000_000, legacyIndexPending: true })).toBe(false);
    expect(reclaimSizeKnown({ state: "reclaim-available", freeBytes: 5_000_000, legacyIndexPending: false })).toBe(true);
    expect(html({ state: "reclaim-available", freeBytes: 5_000_000 })).toContain("about 5 MB");
  });
});
