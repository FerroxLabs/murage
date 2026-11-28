// SPDX-License-Identifier: AGPL-3.0-or-later
// The server says "the Inbox changed" on the live-events stream
// (`inbox.changed`, server/index.ts). Whoever shows an Inbox number listens
// here instead of asking every 5 s. The frame also carries the server's poll
// scale (server/io-budget.ts): 1 normally, higher when the process is writing
// or spinning too hard and the fallback polls should back off.
type Listener = (scale: number) => void;
const listeners = new Set<Listener>();
let scale = 1;

export const FALLBACK_POLL_MS = 60_000;

export function inboxPollScale(): number { return scale; }

export function emitInboxChanged(next = 1): void {
  scale = Number.isFinite(next) && next >= 1 ? next : 1;
  for (const listener of [...listeners]) { try { listener(scale); } catch { /* one listener never starves another */ } }
}

/** A resolve (approve, answer, snooze, keep, dismiss) just changed what is owed: every Inbox number re-reads now, through
 *  the same listeners the server's `inbox.changed` frame reaches, without waiting for the frame, the slow poll or a focus.
 *  The poll scale is the server's to say, so it is left as it is. */
export function refreshInboxCounts(): void {
  for (const listener of [...listeners]) { try { listener(scale); } catch { /* one listener never starves another */ } }
}

export function onInboxChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One read at a time, and none lost. A call while a read is out does not
 *  start a second one beside it; it asks for exactly one more read after it,
 *  because the read already out may have been answered before the change it
 *  was told about. */
export function serialRefresh(read: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null, again = false;
  const run = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => {
      try { await read(); }
      finally {
        running = null;
        if (again) { again = false; void run(); }
      }
    })();
    return running;
  };
  return run;
}
