// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (b): the rows one integrity statement covers follow PagedScan's rule: halved as soon as a statement takes longer than the 20 ms
// target, doubled when it takes under a quarter of it, kept otherwise (rc13 real-data run: integrity slices of 23 to 149 ms, each one statement that
// the old rule let run long: it halved only past 40 ms and grew toward the target from anything shorter).
import { describe, expect, it } from "vitest";
import { adaptiveWindow, adaptWindow, INTEGRITY_FIRST_WINDOW, INTEGRITY_MIN_WINDOW, INTEGRITY_SHAPE_SLICE, INTEGRITY_SLICE_TARGET_MS, nextWindowSize } from "./integrity-pass.ts";

describe("integrity statement windows (rc13 round 2)", () => {
  it("a statement just over the target halves the next window", () => {
    expect(nextWindowSize(1_000, INTEGRITY_SLICE_TARGET_MS + 1, 5_000, 16)).toBe(500);
    expect(nextWindowSize(1_000, 3 * INTEGRITY_SLICE_TARGET_MS, 5_000, 16)).toBe(500);
  });
  it("a statement inside the target but not well inside keeps the window (it no longer grows toward the target)", () => {
    expect(nextWindowSize(1_000, INTEGRITY_SLICE_TARGET_MS / 2, 5_000, 16)).toBe(1_000);
    expect(nextWindowSize(1_000, INTEGRITY_SLICE_TARGET_MS, 5_000, 16)).toBe(1_000);
  });
  it("a quick statement doubles the window, up to the cap", () => {
    expect(nextWindowSize(1_000, 1, 5_000, 16)).toBe(2_000);
    expect(nextWindowSize(4_000, 1, 5_000, 16)).toBe(5_000);
  });
  it("never goes below the floor (or the cap, when the cap is smaller)", () => {
    expect(nextWindowSize(20, 500, 5_000, 16)).toBe(16);
    expect(nextWindowSize(8, 500, 8, 16)).toBe(8);
  });
  it("a check whose statements take time in proportion to their rows settles at the floor instead of staying near the first window", () => {
    const owner = {}, key = "shape:x";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    expect(size).toBe(INTEGRITY_FIRST_WINDOW);
    // 2 ms a row: every window over the floor runs past the target
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 2 * size, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); }
    expect(size).toBe(INTEGRITY_MIN_WINDOW);
  });
});

// 1.0.3 lane 3 (stall r2 L3): a statement whose 25 ms are its own fixed cost took as long over half the rows; halving went on to the 16-row floor
// and stayed there, so the check crawled at 16 rows a statement while no statement got any shorter.
describe("integrity statement windows with a fixed-cost statement (1.0.3)", () => {
  it("stops shrinking where halving stopped shortening the statement, and holds there", () => {
    const owner = {}, key = "shape:fixed";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    const sizes: number[] = [];
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 25, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); sizes.push(size); }
    // one halving (256 to 128) that bought nothing, then back to 256 and held
    expect(sizes[0]).toBe(INTEGRITY_FIRST_WINDOW / 2);
    expect(sizes.slice(1).every(s => s === INTEGRITY_FIRST_WINDOW)).toBe(true);
  });
  it("a fixed cost on top of a per-row cost still halves while halving helps", () => {
    const owner = {}, key = "shape:mixed";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    // 10 ms fixed + 0.1 ms a row: 256 rows = 35.6 ms, 128 = 22.8 ms (shorter by more than a fifth: keep halving), 64 = 16.4 ms (inside the target)
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 10 + 0.1 * size, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); }
    expect(size).toBe(64);
  });
  it("the floor goes when the rows cost again: a statement there far past the target and its last time halves once more", () => {
    const owner = {}, key = "shape:changed";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    for (let n = 0; n < 4; n++) { adaptWindow(owner, key, size, 25, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); }
    expect(size).toBe(INTEGRITY_FIRST_WINDOW);
    // now 1 ms a row (a cold file): 256 ms over 256 rows
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, size, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); }
    expect(size).toBe(INTEGRITY_MIN_WINDOW);
  });
  it("two noisy slow readings after a hot region do not pin a large window (Fable r1: 5,000 rows at 150 ms, then 2,500 at 130 ms)", () => {
    const owner = {}, key = "shape:noisy";
    let size = adaptiveWindow(owner, key, 5_000);
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 1, 5_000); size = adaptiveWindow(owner, key, 5_000); }
    expect(size).toBe(5_000); // grown on a hot region
    adaptWindow(owner, key, 5_000, 150, 5_000); size = adaptiveWindow(owner, key, 5_000);
    expect(size).toBe(2_500);
    adaptWindow(owner, key, 2_500, 130, 5_000); size = adaptiveWindow(owner, key, 5_000);
    expect(size, "no floor granted to a statement over twice the target").toBe(1_250);
    // the cold region costs 0.03 ms a row from here: the window settles where a statement is within twice the target
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 0.03 * size, 5_000); size = adaptiveWindow(owner, key, 5_000); }
    expect(0.03 * size).toBeLessThanOrEqual(2 * INTEGRITY_SLICE_TARGET_MS);
  });
  it("guard: whatever the cost (fixed, per row, noisy), no window or floor settles at a size whose statements exceed twice the target", () => {
    const models: Array<(rows: number, n: number) => number> = [];
    for (const fixed of [0, 5, 15, 25, 35, 60]) for (const perRow of [0, 0.001, 0.01, 0.03, 0.1, 1]) for (const noise of [0, 0.3]) {
      models.push((rows, n) => (fixed + perRow * rows) * (1 + (n % 2 ? noise : -noise)));
    }
    for (const [m, cost] of models.entries()) {
      const owner = {}, key = `guard:${m}`;
      let size = adaptiveWindow(owner, key, 5_000);
      // start from a large window (a hot region), then the model
      for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 1, 5_000); size = adaptiveWindow(owner, key, 5_000); }
      for (let n = 0; n < 60; n++) {
        const took = cost(size, n);
        if (n >= 30 && took > 2 * INTEGRITY_SLICE_TARGET_MS) expect(size, `model ${m} step ${n}: ${took.toFixed(1)} ms over ${size} rows`).toBe(INTEGRITY_MIN_WINDOW);
        adaptWindow(owner, key, size, took, 5_000); size = adaptiveWindow(owner, key, 5_000);
      }
    }
  });
  it("statements that keep getting slower are not held at a floor (Astra r1: 25, 25, 40, 60, 90, 90 ms)", () => {
    const owner = {}, key = "shape:worsening";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    const sizes: number[] = [];
    for (const took of [25, 25, 40, 60, 90, 90, 90, 90, 90, 90, 90, 90]) { adaptWindow(owner, key, size, took, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); sizes.push(size); }
    expect(sizes.slice(0, 4)).toEqual([128, 256, 256, 128]);
    expect(size).toBe(INTEGRITY_MIN_WINDOW);
  });
});
