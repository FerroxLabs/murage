// SPDX-License-Identifier: AGPL-3.0-or-later
// A counter for "the messages table changed". The Inbox answer is memoised
// against it (inbox.ts), and the live-events stream announces it so the
// sidebar and tray stop asking every 5 s. Bumped by every writer in
// message-db.ts and by the Inbox's own read/snooze/clear marks.
let version = 0;
const listeners = new Set<() => void>();

export const messagesVersion = () => version;

export function bumpMessagesVersion(): void {
  version++;
  for (const listener of listeners) { try { listener(); } catch { /* a listener never blocks a write */ } }
}

/** Returns an unsubscribe function. Listeners run synchronously inside the write path: keep them to scheduling a timer. */
export function onMessagesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const INBOX_KINDS = new Set(["options", "secret", "connector", "mcpSignIn", "routine.run", "goal.run", "activity"]);

/** Bump only for a message the Inbox projection can read (inbox.ts raw). A
 *  streaming assistant reply is rewritten many times a second and is never an
 *  Inbox row, so it must not invalidate the cache or wake the pollers. */
export function bumpForMessage(message: { role?: unknown; kind?: unknown; artifactIds?: unknown }): void {
  if (message.role !== "bot" || typeof message.kind !== "string") return;
  if (INBOX_KINDS.has(message.kind) || (message.kind === "text" && Array.isArray(message.artifactIds) && message.artifactIds.length > 0)) bumpMessagesVersion();
}

/** Frames whose change moves an Inbox number without touching a message.
 *  Routine run RECORDS feed the roll-ups and the "connection to restore" rows,
 *  and those count in `decisions` (inbox.ts), so the badge must hear of them. */
export function frameChangesInbox(payload: Record<string, unknown>): boolean {
  return payload.kind === "routine.run" || payload.kind === "routine.deleted";
}
