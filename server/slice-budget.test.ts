// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { SWEEP_SLICE_MS, sliceSizer } from "./slice-budget.ts";

it("a slice is sized by time: a slow disk walks fewer rows, a fast one more, never below the minimum", () => {
  const s = sliceSizer({ max: 20_000 });
  const first = s.next();
  s.took(first, 1_000); // a cold slice 100x over budget
  expect(s.next()).toBeLessThan(first);
  expect(s.next()).toBeGreaterThanOrEqual(16);
  const fast = sliceSizer({ max: 20_000, start: 100 });
  fast.took(100, 0.1);
  expect(fast.next()).toBe(200); // grows at most 2x per slice
  for (let i = 0; i < 20; i++) fast.took(fast.next(), 0.1);
  expect(fast.next()).toBe(20_000);
  // a steady 0.01 ms per row settles near the budget
  const steady = sliceSizer({ max: 1_000_000, start: 100 });
  for (let i = 0; i < 30; i++) { const n = steady.next(); steady.took(n, n * 0.01); }
  expect(steady.next() * 0.01).toBeLessThanOrEqual(SWEEP_SLICE_MS);
});
