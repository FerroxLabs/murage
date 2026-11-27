// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall is started early for every turn, in parallel with the mounts (PROPOSAL-v2 10.1 item 5), and the
// dispatch step waits for it only a short while. A recall that has not finished by then is dropped and the
// turn goes out with its pins, identity and kept memories, without excerpts: memory is never the reason a
// turn is late.

/** What dispatch waits for an overlapped recall: milliseconds of recall's OWN elapsed work (MEMORY-V2-DESIGN 4.2 A9, audit F10), counted
 * in steps of RECALL_WAIT_STEP_MS during which this thread was free to run recall's continuations. 1.0.22 (mem-strict): 3,000, was 300;
 * a loaded box missed 300 daily and the turn went out with no excerpts. */
export const RECALL_WAIT_MS = 3000;
/** One step of the wait. A step charges exactly its own length, however late it comes back: the lateness is time this thread spent in
 * other work (another turn, view upkeep, a collection), during which recall could not have finished whatever it had left to do. So a
 * recall is given RECALL_WAIT_MS / RECALL_WAIT_STEP_MS turns of the event loop at least, and on a free thread the wait is RECALL_WAIT_MS
 * of wall clock as before. */
export const RECALL_WAIT_STEP_MS = 10;
/** The wall-clock ceiling of the wait, for a thread that is held again and again: RECALL_WAIT_CEILING_FACTOR x the budget (24,000 ms for
 * the default). Past it the recall is dropped whatever was charged. Memory is never why a turn is late by more than this, and while the
 * thread is held the dispatch step could not have gone on either. */
export const RECALL_WAIT_CEILING_FACTOR = 8;

export type RecallWait<T> = { value: T } | { skipped: "budget" };

/** `work` if it settles within `ms` of its own elapsed work (and the wall-clock ceiling), else `{skipped}`. A rejection still rejects:
 * errors surface where the sequential build would have. */
export async function withRecallBudget<T>(work: Promise<T>, ms = RECALL_WAIT_MS): Promise<RecallWait<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ skipped: "budget" }>(resolve => {
    const started = performance.now(), ceiling = ms * RECALL_WAIT_CEILING_FACTOR;
    let charged = 0;
    const arm = () => {
      const step = Math.min(RECALL_WAIT_STEP_MS, ms - charged);
      timer = setTimeout(() => {
        // The step is charged by its length, not by the clock: a timer never fires early, and what it fired late is not recall's work.
        charged += step;
        if (charged >= ms || performance.now() - started >= ceiling) resolve({ skipped: "budget" });
        else arm();
      }, step);
    };
    if (ms > 0) arm(); else timer = setTimeout(() => resolve({ skipped: "budget" }), 0);
  });
  try { return await Promise.race([work.then(value => ({ value })), late]); }
  finally { if (timer) clearTimeout(timer); work.catch(() => {}); }
}

/** The last search's mode for a thread, for the `[memory] turn` line. */
const modes = new Map<string, "lexical" | "hybrid">();
export function noteRecallMode(threadId: string, mode: "lexical" | "hybrid"): void {
  if (modes.size >= 512 && !modes.has(threadId)) modes.delete(modes.keys().next().value!);
  modes.set(threadId, mode);
}
export function takeRecallMode(threadId: string): "lexical" | "hybrid" | undefined {
  const mode = modes.get(threadId); modes.delete(threadId); return mode;
}
