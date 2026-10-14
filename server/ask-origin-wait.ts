// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A finished ask answers only once the reply it carries can name the stored message it came from. The turn's last text can be stored a moment
// after the completion event, so the answer waits for that row on the runtime's own events, and never releases early: if the row never shows up
// within the grace, the answer goes on without a link and the result gate withholds the text from the bot.

export type ReplyOrigin = { threadId: string; messageIds: string[] };

export interface OriginWait {
  /** The stored link now, or undefined while the reply's rows are not stored yet. */
  lookup: () => ReplyOrigin | undefined;
  /** Whether the answer carries worker text at all; with none there is no original to wait for. */
  needed: boolean;
  /** Calls back on each runtime event after the completion; returns the unsubscribe. */
  onSignal: (listener: () => void) => () => void;
  graceMs: number;
}

/** Calls `settle` exactly once, with the link when it is stored (at once, or on a later signal) or the last lookup when the grace ends. Returns a cancel. */
export function settleWithOrigin(wait: OriginWait, settle: (origin: ReplyOrigin | undefined) => void): () => void {
  const first = wait.lookup();
  if (!wait.needed || first) { settle(first); return () => undefined; }
  let done = false;
  let unsub: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (origin: ReplyOrigin | undefined) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    unsub();
    settle(origin);
  };
  unsub = wait.onSignal(() => { const found = wait.lookup(); if (found) end(found); });
  timer = setTimeout(() => end(wait.lookup()), wait.graceMs);
  return () => { done = true; if (timer) clearTimeout(timer); unsub(); };
}
