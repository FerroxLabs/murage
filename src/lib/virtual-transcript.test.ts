import { describe, expect, it } from "vitest";

import {
  anchorAt,
  FALLBACK_VIEWPORT_PX,
  MAX_MOUNTED_ITEMS,
  MAX_PIN_DISTANCE,
  mountedRange,
  needsRefill,
  OVERSCAN_PX,
  ROW_ESTIMATE_PX,
  rowAt,
  rowOffsets,
  viewportTop,
} from "./virtual-transcript";

const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
const indexer = (keys: readonly string[]) => {
  const index = new Map(keys.map((key, i) => [key, i]));
  return (key: string) => index.get(key) ?? -1;
};

describe("virtual transcript arithmetic", () => {
  it("lays rows out by measured height, estimating the rest", () => {
    const offsets = rowOffsets(["a", "b", "c"], new Map([["b", 40]]));
    expect(offsets).toEqual([0, ROW_ESTIMATE_PX, ROW_ESTIMATE_PX + 40, 2 * ROW_ESTIMATE_PX + 40]);
  });

  it("finds the row under a pixel, skipping rows that take no room", () => {
    const offsets = [0, 100, 100, 250];
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 99)).toBe(0);
    expect(rowAt(offsets, 100)).toBe(2);
    expect(rowAt(offsets, 10_000)).toBe(2);
    expect(rowAt(offsets, -50)).toBe(0);
  });

  it("mounts a bounded slice of a 200,000-message thread at its live end", () => {
    const keys = keysOf(200_000);
    const offsets = rowOffsets(keys, new Map());
    const top = viewportTop(offsets, indexer(keys), null, FALLBACK_VIEWPORT_PX, 0);
    const range = mountedRange(offsets, top, FALLBACK_VIEWPORT_PX);
    expect(range.end).toBe(200_000);
    const mounted = range.end - range.start;
    expect(mounted).toBeLessThanOrEqual(Math.ceil((FALLBACK_VIEWPORT_PX + 2 * OVERSCAN_PX) / ROW_ESTIMATE_PX) + 2);
    expect(mounted).toBeGreaterThanOrEqual(Math.ceil(FALLBACK_VIEWPORT_PX / ROW_ESTIMATE_PX));
  });

  it("never mounts more than the cap, even when rows measure tiny", () => {
    const keys = keysOf(200_000);
    const heights = new Map(keys.map((key) => [key, 1]));
    const offsets = rowOffsets(keys, heights);
    const range = mountedRange(offsets, 100_000, FALLBACK_VIEWPORT_PX);
    expect(range.end - range.start).toBe(MAX_MOUNTED_ITEMS);
    // the rows in view are among them
    expect(range.start).toBeLessThanOrEqual(rowAt(offsets, 100_000));
  });

  it("keeps a pinned row mounted while it is near, and lets a far one go", () => {
    const keys = keysOf(1_000);
    const offsets = rowOffsets(keys, new Map());
    const top = offsets[500]!;
    const plain = mountedRange(offsets, top, 600);
    const near = mountedRange(offsets, top, 600, [plain.start - 10]);
    expect(near.start).toBe(plain.start - 10);
    const far = mountedRange(offsets, top, 600, [plain.start - MAX_PIN_DISTANCE - 5]);
    expect(far).toEqual(plain);
  });

  it("holds the reader's row where it was when rows above change height", () => {
    const keys = keysOf(400);
    const heights = new Map<string, number>();
    const before = rowOffsets(keys, heights);
    const top = before[250]! + 30;
    const anchor = anchorAt(before, keys, top)!;
    expect(anchor).toEqual({ key: "m250", offsetInView: -30 });
    // rows above measure in at their real heights
    for (let i = 200; i < 250; i++) heights.set(`m${i}`, 300);
    const after = rowOffsets(keys, heights);
    const nextTop = viewportTop(after, indexer(keys), anchor, 800, top);
    // the same row, the same distance from the top of the viewport
    expect(after[250]! - nextTop).toBe(-30);
    expect(nextTop - top).toBe(50 * (300 - ROW_ESTIMATE_PX));
  });

  it("holds the reader still while a reply grows below them (streaming)", () => {
    const keys = keysOf(300);
    const heights = new Map<string, number>();
    const offsets = rowOffsets(keys, heights);
    const top = offsets[100]!;
    const anchor = anchorAt(offsets, keys, top)!;
    // the newest row grows token by token, and new rows land after it
    heights.set("m299", 4_000);
    const grown = rowOffsets([...keys, "m300", "m301"], heights);
    const nextTop = viewportTop(grown, indexer([...keys, "m300", "m301"]), anchor, 800, top);
    expect(nextTop).toBe(top);
  });

  it("holds the reader's row when an older page lands above it", () => {
    const keys = keysOf(100);
    const offsets = rowOffsets(keys, new Map());
    const top = offsets[10]!;
    const anchor = anchorAt(offsets, keys, top)!;
    const paged = [...Array.from({ length: 100 }, (_, i) => `old${i}`), ...keys];
    const pagedOffsets = rowOffsets(paged, new Map());
    const nextTop = viewportTop(pagedOffsets, indexer(paged), anchor, 800, top);
    expect(nextTop).toBe(pagedOffsets[110]!);
    expect(mountedRange(pagedOffsets, nextTop, 800).start).toBeGreaterThan(100);
  });

  it("sits at the end with no anchor, and keeps the last place when the anchor row is gone", () => {
    const keys = keysOf(50);
    const offsets = rowOffsets(keys, new Map());
    expect(viewportTop(offsets, indexer(keys), null, 800, 0)).toBe(offsets[50]! - 800);
    expect(viewportTop(offsets, indexer(keys), { key: "gone", offsetInView: 0 }, 800, 1_000)).toBe(1_000);
  });

  it("refills only when the viewport nears an unmounted row", () => {
    const keys = keysOf(1_000);
    const offsets = rowOffsets(keys, new Map());
    const range = mountedRange(offsets, offsets[500]!, 800);
    expect(needsRefill(offsets, range, offsets[500]!, 800)).toBe(false);
    expect(needsRefill(offsets, range, offsets[range.start]! + 10, 800)).toBe(true);
    expect(needsRefill(offsets, { start: 0, end: 1_000 }, 0, 800)).toBe(false);
  });
});

describe("anchorScrollTarget (P2-1)", () => {
  it("keeps a scroll already in flight: only the rows above moving corrects it", async () => {
    const { anchorScrollTarget } = await import("./virtual-transcript");
    // anchor captured at scrollTop 1000; the smooth scroll has since reached 1400 and nothing above moved
    expect(anchorScrollTarget({ scrollTop: 1400, anchorOffset: 5000, placed: 5000, listTop: 0, offsetInView: 4000 })).toBeNull();
    // rows above grew 30px while the scroll sits at 1400: follow them from where it is NOW
    expect(anchorScrollTarget({ scrollTop: 1400, anchorOffset: 5030, placed: 5000, listTop: 0, offsetInView: 4000 })).toBe(1430);
  });

  it("places a freshly jumped-to row absolutely", async () => {
    const { anchorScrollTarget } = await import("./virtual-transcript");
    expect(anchorScrollTarget({ scrollTop: 0, anchorOffset: 5000, placed: null, listTop: 10, offsetInView: 300 })).toBe(4710);
  });
});
