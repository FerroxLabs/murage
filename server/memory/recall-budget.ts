// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall is started early for every turn, in parallel with the mounts (PROPOSAL-v2 10.1 item 5), and the
// dispatch step waits for it only a short while. A recall that has not finished by then is dropped and the
// turn goes out with its pins, identity and kept memories, without excerpts: memory is never the reason a
// turn is late.

/** What dispatch waits for an overlapped recall (milliseconds). */
export const RECALL_WAIT_MS = 300;

export type RecallWait<T> = { value: T } | { skipped: "budget" };

/** `work` if it settles within `ms`, else `{skipped}`. A rejection still rejects: errors surface where the sequential build would have. */
export async function withRecallBudget<T>(work: Promise<T>, ms = RECALL_WAIT_MS): Promise<RecallWait<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ skipped: "budget" }>(resolve => { timer = setTimeout(() => resolve({ skipped: "budget" }), ms); });
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
