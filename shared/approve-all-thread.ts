// SPDX-License-Identifier: AGPL-3.0-or-later
// NOLIM-1019 Rev 3.3 (designs/NOLIM-DO-EVERYTHING-1019.md U4, V3): the chat's Approve all, thread scoped. The chat sends
// the request ids of the cards it shows, in windows of THREAD_WINDOW, and the server answers for that thread alone: every
// requested id lands in exactly one of eligible / later / excluded / closed. This file is the pure half the client
// shares with its tests: the one chat key, the windows, the request body, and the check of a preview against what was
// asked. It words nothing; src/lib/approve-all.ts and the button turn the outcomes into sentences.

/** The most ids one thread preview carries (the server's requestIds bound). */
export const THREAD_WINDOW = 200;

/** The ONE chat key: the thread and the card's own request id. The stored message id is not a key here (it need not
 *  follow the request id), and never is for a card the preview answers by request. */
export function chatRequestKey(threadId: string, pending: { requestId: string }): string {
  return `${threadId}\u0000${pending.requestId}`;
}

/** The request id inside a `chatRequestKey` of this thread, or null for a key of another thread or a malformed one. */
export function requestIdOfKey(threadId: string, key: string): string | null {
  const prefix = `${threadId}\u0000`;
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
}

/** The shown ids in the chat's order, cut into windows of THREAD_WINDOW (the last may be shorter). */
export function threadWindows(requestIds: readonly string[]): string[][] {
  const windows: string[][] = [];
  for (let at = 0; at < requestIds.length; at += THREAD_WINDOW) windows.push(requestIds.slice(at, at + THREAD_WINDOW));
  return windows;
}

/** The preview request body for one window. */
export function threadPreviewBody(threadId: string, requestIds: readonly string[]): string {
  return JSON.stringify({ thread: { threadId, requestIds } });
}

/** The fields of a thread preview entry this file reads (the full cards are src/lib/approve-all.ts's). */
export interface ThreadEntry { threadId: string; requestId: string }
export interface ThreadPreviewShape<E extends ThreadEntry = ThreadEntry, X extends ThreadEntry = ThreadEntry> {
  scope?: unknown;
  threadId?: unknown;
  batchId: string | null;
  eligible: readonly E[];
  later: readonly ThreadEntry[];
  excluded: readonly X[];
  closed: readonly ThreadEntry[];
}

/** What one window's preview means. `protocol` is a preview that does not answer what was asked (a failed preview, never
 *  "changed"); `cards` has eligible cards to apply; `empty` has none, so the press goes on to the next window. */
export type ThreadBound<E extends ThreadEntry> =
  | { at: "protocol" }
  | { at: "cards"; cards: E[]; excluded: number; later: number }
  | { at: "empty"; excluded: number; closed: number };

/** Check a thread preview against the window that was asked (`shownKeys`, `chatRequestKey`s of this thread) and read it.
 *  A protocol error: another scope or thread, an entry of another thread, an id in two lists, an asked id in none, an
 *  eligible id that was not asked, eligible cards without a batch, an entry in ANY list (not only eligible) that was not asked, a response that is not an object, or `later` cards with nothing eligible (the cap is
 *  above zero, so that cannot happen). */
export function boundToThread<E extends ThreadEntry, X extends ThreadEntry>(preview: ThreadPreviewShape<E, X>, threadId: string, shownKeys: readonly string[]): ThreadBound<E> {
  if (!preview || typeof preview !== "object") return { at: "protocol" };
  const asked = new Set<string>();
  for (const key of shownKeys) {
    const id = requestIdOfKey(threadId, key);
    if (id === null) return { at: "protocol" };
    asked.add(id);
  }
  if (preview.scope !== "thread" || preview.threadId !== threadId) return { at: "protocol" };
  const lists = [preview.eligible, preview.later, preview.excluded, preview.closed] as const;
  if (lists.some((list) => !Array.isArray(list))) return { at: "protocol" };
  const placed = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      if (!item || item.threadId !== threadId || typeof item.requestId !== "string" || !asked.has(item.requestId) || placed.has(item.requestId)) return { at: "protocol" };
      placed.add(item.requestId);
    }
  }
  for (const id of asked) if (!placed.has(id)) return { at: "protocol" };
  if (preview.eligible.some((card) => !asked.has(card.requestId))) return { at: "protocol" };
  if (preview.eligible.length > 0) {
    if (typeof preview.batchId !== "string" || preview.batchId === "") return { at: "protocol" };
    return { at: "cards", cards: [...preview.eligible], excluded: preview.excluded.length, later: preview.later.length };
  }
  if (preview.later.length > 0) return { at: "protocol" };
  return { at: "empty", excluded: preview.excluded.length, closed: preview.closed.length };
}

/** How a press ends once every window it needed was read and none had an eligible card: "each own" when any card is
 *  excluded (they need their own Allow), "none" only when every asked card is closed. */
export function noEligibleOutcome(totals: { excluded: number; closed: number }): "eachOwn" | "none" {
  return totals.excluded > 0 ? "eachOwn" : "none";
}

/** The server's refusals of an apply that mean the batch no longer matches the list (U4 e): the batch is gone, used or
 *  does not hold what was ticked (409), or the signed answer no longer matches (403). Anything else is an error line. */
export function applyRefusalMeansChanged(error: unknown): boolean {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: { code?: unknown } };
  const code = typeof body?.code === "string" ? body.code : "";
  return (status === 409 && (code === "batch_unknown" || code === "batch_used" || code === "bad_selection")) || (status === 403 && code === "fresh_auth_changed");
}

/** What one window's answer means, in the one order that is allowed (Rev 3.3 U4 M-order): the press snapshot FIRST
 *  (`stillPressed` false: the list moved while the preview loaded, so the press is "changed", whatever the preview holds,
 *  even one that would be a protocol error), and only then the check of the preview against the window that was asked.
 *  The button calls this once per window after the await; it never reads the preview before the snapshot. */
export function judgeThreadWindow<E extends ThreadEntry, X extends ThreadEntry>(
  stillPressed: boolean, preview: ThreadPreviewShape<E, X>, threadId: string, shownKeys: readonly string[],
): { at: "changed" } | ThreadBound<E> {
  if (!stillPressed) return { at: "changed" };
  return boundToThread(preview, threadId, shownKeys);
}
