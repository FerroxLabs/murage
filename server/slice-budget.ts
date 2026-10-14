// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A sweep that walks rows after the server listens must not hold the event loop (RC3 item 6: a 20,000-row slice cost 2.6 s on a cold disk, a
// 400-row one 8.1 s). A slice is bounded by the time it takes, not by a row count: the next slice's row count is sized from how long the last one
// took, so a slow disk walks fewer rows per slice and a fast one more, and each slice stays near `budgetMs` of loop time.
export const SWEEP_SLICE_MS = 8;
export interface SliceSizer { next(): number; took(rows: number, ms: number): void }
/** Row counts for successive slices: starts small (the first slice may be cold), grows at most 2x per slice while the last slice came in
 * under budget, and shrinks at once when it did not. Never below `min` (progress is guaranteed) or above `max`. */
export function sliceSizer(options: { budgetMs?: number; min?: number; max?: number; start?: number } = {}): SliceSizer {
  const budget = options.budgetMs ?? SWEEP_SLICE_MS, min = options.min ?? 16, max = options.max ?? 20_000;
  let size = Math.min(max, Math.max(min, options.start ?? 128));
  return {
    next: () => size,
    took(rows, ms) {
      const perRow = Math.max(ms, 0.01) / Math.max(rows, 1);
      const fit = Math.floor(budget / perRow);
      size = Math.min(max, Math.max(min, Math.min(fit, size * 2)));
    },
  };
}
