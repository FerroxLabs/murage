// How many threads a bot may run at once, and how many the whole home may run (U4 S1; upstream D29 fc839de38, #4212 b6d45fa27
// cap part). Both are read live on every admission and every slot pump: a saved change applies to the next start, without a restart.
//
// - The home guard is sized from this machine's memory: total GB less 2, at least 1 (MurageMain 11-03: a 4 GB server runs 2 at
//   once, 8 GB runs 6, 16 GB runs 14, 32 GB runs 30). Total memory is read to the nearest whole GB, so a 4 GB server whose kernel
//   keeps a little back still counts as 4. It is one total across every bot's running threads. No Cloud plan sets it.
// - A bot's own limit is the owner's saved `features.threadsPerBot` (1 to 16) when that is lower than the home guard, else the
//   home guard. The saved number only ever narrows: a bot never runs more than the home guard allows, whatever is saved.
// - A value that is missing, not a whole number or out of range reads as unset (fail closed to the computed guard).
// Lowering either number stops nothing that is running; new starts wait for a slot.

export const THREADS_PER_BOT_MIN = 1;
export const THREADS_PER_BOT_MAX = 16;
const GIB = 1024 ** 3;
/** Memory kept back for the system and Murage itself before threads are counted, in GB. */
const RESERVED_GB = 2;

/** The saved per-bot number, or undefined when it is unset or unusable. */
export function savedThreadsPerBot(features: { threadsPerBot?: unknown } | undefined | null): number | undefined {
  const value = features?.threadsPerBot;
  return typeof value === "number" && Number.isInteger(value) && value >= THREADS_PER_BOT_MIN && value <= THREADS_PER_BOT_MAX ? value : undefined;
}

/** Threads the whole home may run at once on a machine with `totalMemBytes` of memory. */
export function homeThreadGuard(totalMemBytes: number): number {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return THREADS_PER_BOT_MIN;
  return Math.max(THREADS_PER_BOT_MIN, Math.round(totalMemBytes / GIB) - RESERVED_GB);
}

/** Threads one bot may run at once: the saved number when it is lower than the home guard, else the guard. */
export function botThreadCap(features: { threadsPerBot?: unknown } | undefined | null, totalMemBytes: number): number {
  const guard = homeThreadGuard(totalMemBytes);
  const saved = savedThreadsPerBot(features);
  return saved === undefined ? guard : Math.min(saved, guard);
}
