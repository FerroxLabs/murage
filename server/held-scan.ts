// SPDX-License-Identifier: AGPL-3.0-or-later
// The held-item walk (index.ts drainHeldContinuations) visits every thread of a bot, and the roomQueue start step walks every bot at once
// (rc13 real-data run, cand/rc13 9b2d0469c: `[loop] stall blocked=2106ms holder=startup.roomQueue:2027ms`). Walks share one budget of
// HELD_SCAN_SLICE_MS of synchronous time per turn of the event loop; past it a walk hands the loop back, and the walks that did resume one
// per turn, in the order they yielded. A walk that fits in the budget runs as before, in one go.

export const HELD_SCAN_SLICE_MS = 10;

let sliceStart: number | null = null;
let turn: Promise<void> = Promise.resolve();

/** Whether the shared budget of this turn of the loop has time left (the first walk of a turn opens it; it closes at the next turn). */
function sliceOpen(now: () => number): boolean {
  if (sliceStart === null) { sliceStart = now(); setImmediate(() => { sliceStart = null; }); }
  return now() - sliceStart < HELD_SCAN_SLICE_MS;
}

/** Called before each thread of a walk. Resolves false at once while the budget lasts; otherwise hands the loop back and resolves true once
 * this walk's turn has come (the caller looks at the bot again: it may have started a turn meanwhile). */
export async function heldScanYield(now: () => number = () => performance.now()): Promise<boolean> {
  if (sliceOpen(now)) return false;
  const mine = turn.then(() => new Promise<void>(resolve => setImmediate(resolve)));
  turn = mine;
  await mine;
  sliceStart = null;
  sliceOpen(now);
  return true;
}
