// SPDX-License-Identifier: AGPL-3.0-or-later
// Shadow invariant producer and test observer owner: new3-g5.
// Shared across module resets in a test worker, so resetting imports cannot
// erase a divergence before the independently installed afterEach observes it.
const stateKey = Symbol.for("murage.replay.shadow");
const shared = globalThis as typeof globalThis & { [stateKey]?: { divergences: number } };
const state = shared[stateKey] ??= { divergences: 0 };
export function failReplayShadow(): never {
  if (process.env.VITEST) state.divergences++;
  throw new Error("REPLAY_SHADOW_DIVERGED: SEND_REPLAY_CHANGED");
}
export function rethrowReplayShadow(error: unknown): void {
  if (error instanceof Error && error.message.startsWith("REPLAY_SHADOW_DIVERGED")) throw error;
}
/** Consumed by the test harness, independently of any caller's error handling. */
export function takeReplayShadowDivergencesForTest(): number {
  const count = state.divergences; state.divergences = 0; return count;
}
