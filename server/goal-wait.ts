export const DEFAULT_GOAL_WAIT_MS = 5 * 60_000;
export const MIN_GOAL_WAIT_MS = 1_000;
// Node turns larger setTimeout delays into 1 ms instead of saturating them.
export const MAX_GOAL_WAIT_MS = 2_147_483_647;

/** Parse MURAGE_GOAL_WAIT_MAX_MS without overflowing Node's timer range.
 * Missing, malformed, nonfinite and nonpositive values use five minutes.
 * Positive values clamp to one second through Node's maximum delay; fractional
 * milliseconds truncate just as setTimeout does. No value disables the cap. */
export function goalWaitMaxMs(raw: string | undefined): number {
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_GOAL_WAIT_MS;
  return Math.min(MAX_GOAL_WAIT_MS, Math.max(MIN_GOAL_WAIT_MS, Math.trunc(configured)));
}
