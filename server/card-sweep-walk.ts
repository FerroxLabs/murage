// SPDX-License-Identifier: AGPL-3.0-or-later
/** The history walk for peer and computer-consent cards of a dead run, for a file whose open-card index is not complete yet (index.ts
 * sweepCardsOfDeadRun). Rows written since the last walk are read first; a file never walked reads ONE newest slice (a crashed run's cards are the
 * newest rows) and stops: the older history is the open-card index's, built by the message walk, and read once from the list when it is ready, so
 * no second pass repeats that IO. The mark covers exactly what was read, so a restart carries on from it. */
export interface ToolCardWalkDeps {
  high: number;
  range: { floor: number; top: number };
  indexDone: () => boolean;
  /** Rows the next slice may read (time-budgeted by the caller's sizer). */
  sliceRows: () => number;
  /** Reads rows in (after, upTo]. */
  walk: (after: number, upTo: number) => Promise<void>;
  keep: (floor: number, top: number) => void;
}
export async function walkStaleToolCards({ high, range: { floor, top }, indexDone, sliceRows, walk, keep }: ToolCardWalkDeps): Promise<void> {
  for (let to = high; to > top && !indexDone();) { const from = Math.max(top, to - sliceRows()); await walk(from, to); to = from; }
  if (indexDone()) return;
  if (top >= high) {
    const from = Math.max(0, high - sliceRows());
    await walk(from, high);
    try { keep(from, high); } catch { /* idempotent: the next start repeats it */ }
  } else {
    try { keep(floor, high); } catch { /* idempotent: the next start repeats it */ }
  }
}
