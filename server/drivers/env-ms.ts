// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #1840 (Apache-2.0).

/** The longest delay a Node timer honours. A longer one (and Infinity) fires
 * at once, which would close an idle engine the moment it opens. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A millisecond setting from the environment: a finite number above zero and
 * within what a timer can hold. Anything else keeps the default instead of
 * disarming, or instantly firing, the timeout it controls. */
export function boundedEnvMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_TIMER_MS ? n : fallback;
}
