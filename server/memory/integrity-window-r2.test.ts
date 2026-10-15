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
  it("a check whose statements keep taking 25 ms settles at the floor instead of staying near the first window", () => {
    const owner = {}, key = "shape:x";
    let size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE);
    expect(size).toBe(INTEGRITY_FIRST_WINDOW);
    for (let n = 0; n < 10; n++) { adaptWindow(owner, key, size, 25, INTEGRITY_SHAPE_SLICE); size = adaptiveWindow(owner, key, INTEGRITY_SHAPE_SLICE); }
    expect(size).toBe(INTEGRITY_MIN_WINDOW);
  });
});
