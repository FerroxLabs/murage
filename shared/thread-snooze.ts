// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A SNOOZED CONVERSATION IS QUIET, NOT HIDDEN, AND NEVER HIDES A DECISION.
//
// The Inbox already snoozes single items. This is the same "not now" for a
// whole conversation: it stops asking for the owner's eye (the bold unread
// name, the unread count in a collapsed section, the Unread filter) until a
// time the owner chose, and then comes back marked unread.
//
// One rule outranks the clock: anything OWED to the owner (an approval or a
// question waiting on them) wakes it at once. A snooze may quiet news; it
// may never sit on top of somebody's work that is stopped waiting for an
// answer. For the same reason a conversation that is already waiting on the
// owner cannot be snoozed at all, exactly as the Inbox refuses to snooze its
// owed items (INBOX_OWED_VIEWS in src/components/Inbox.tsx).

/** One snoozed conversation. `until` is epoch ms. */
export interface ThreadSnooze {
  threadId: string;
  until: number;
}

/** The longest a conversation may sleep. Matches the Inbox item limit. */
export const THREAD_SNOOZE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Every snooze that is still in effect, for the desktop app. */
export interface ThreadSnoozeList {
  snoozes: ThreadSnooze[];
}
