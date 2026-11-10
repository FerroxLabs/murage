// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CONTRACTS-B 1.5 R23': "settled" is a fact the native side only REPORTS (anchorEnd returns a boolean and never waits). This loop observes it:
// one bounded poll on the JS thread with an absolute deadline. No native promise, thread or timer exists on its behalf.

export interface SettleClock { now(): number; sleep(ms: number): Promise<void> }
export const SETTLE_DEADLINE_MS = 2000;
export const SETTLE_STEPS_MS = [0, 1, 2, 4, 8, 16, 32, 50] as const; // the last step repeats
export const realSettleClock: SettleClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => { if (ms === 0) setImmediate(r); else setTimeout(r, ms).unref(); }),
};

/** Polls until `poll()` returns literal true or the absolute deadline passes. The FIRST poll runs synchronously (before the first await), so
 * the end is posted at once. Never rejects under a conforming clock (its sleep always settles). */
export async function settleLoop(poll: () => unknown, clock: SettleClock = realSettleClock): Promise<boolean> {
  try {
    let deadline: number;
    try {
      deadline = clock.now() + SETTLE_DEADLINE_MS;
    } catch {
      return poll() === true; // the end is still posted synchronously when the first clock read fails
    }
    for (let i = 0; ; i++) {
      if (poll() === true) return true;
      const now = clock.now();
      if (now >= deadline) return false;
      await clock.sleep(Math.min(SETTLE_STEPS_MS[Math.min(i, SETTLE_STEPS_MS.length - 1)]!, deadline - now));
    }
  } catch {
    return false; // a throwing poll, a throwing now() or a rejecting sleep() all mean "not observed"
  }
}

let override: SettleClock | null = null;
/** Tests only: replaces the clock AnchoredImport.end uses; null restores the real one. */
export function setSettleClockForTest(clock: SettleClock | null): void { override = clock; }
export const currentSettleClock = (): SettleClock => override ?? realSettleClock;
