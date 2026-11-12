// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r1.2.1 deterministic reader bounds. No clock, payload execution, or I/O.
export const MAX_TEXT = 1_000_000;
export const MAX_WORK = 1_000_000;
export class ReaderCut extends Error {}
export class ReaderBudget {
  left = MAX_WORK;
  tick(cost = 1): void { if ((this.left -= cost) < 0) throw new ReaderCut("reader work budget exceeded"); }
}
export function boundedText(text: string): void {
  if (text.length < MAX_TEXT) return;
  // Python len(str) counts Unicode code points, not UTF-16 code units.
  let count = 0;
  for (const _ of text) if (++count >= MAX_TEXT) throw new ReaderCut("reader text size limit");
}
