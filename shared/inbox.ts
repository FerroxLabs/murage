// TWO DIFFERENT THINGS, AND THEY WERE ONE.
//
// "Needs you" used to mean any of eight statuses: pending, waiting,
// needs-input, blocked, limit-reached, failed, missed, paused. That put a
// request waiting for the owner's decision and a routine that failed
// overnight in the same list, under a heading that promised the first.
//
// They are not the same thing and they are not answered the same way.
//
//   A DECISION is owed. Something is stopped until the owner says yes, no or
//   here-is-the-answer. Reading it changes nothing, and marking it read is
//   the one thing that must never look like answering it.
//
//   SOMETHING TO READ has already happened. A routine failed, a run was
//   missed, a schedule paused. Nobody is waiting; the owner needs to know.
//   Reading it IS the action, and then it is done with.
//
// So the two are separate views, and the count in the sidebar counts
// decisions only. A "needs you" badge that included last night's failures
// was a number nobody could act on and therefore a number nobody read.
export type InboxView = "decisions" | "to-read" | "results" | "all";

/** Statuses where a person owes an answer. Shared so the query, the count and
 *  the tab can never disagree about what a decision is. */
export const INBOX_DECISION_STATUSES = ["pending", "waiting", "needs-input"] as const;

/** Statuses that are news rather than a question. */
export const INBOX_TO_READ_STATUSES = ["blocked", "limit-reached", "failed", "missed", "paused"] as const;

export interface InboxLink { threadId: string; messageId: string; runId?: string; artifactId?: string }
export interface InboxItem {
  id: string;
  version: string;
  kind: "request" | "connection" | "error" | "routine" | "goal" | "artifact";
  status: string;
  /** A decision is owed on this one. Was `needsYou`, which also covered the
   *  news; the two are separate fields now so neither can borrow the other's
   *  urgency. */
  decision: boolean;
  /** News worth reading, with nothing waiting on the answer. */
  toRead: boolean;
  title: string;
  summary: string;
  sourceLabel: string;
  botId?: string;
  at: number;
  read: boolean;
  snoozedUntil: number | null;
  duplicates: number;
  link: InboxLink;
}
export interface InboxQuery { view?: InboxView; query?: string; page?: number; pageSize?: number; includeSnoozed?: boolean }
export interface InboxPage {
  items: InboxItem[]; total: number; page: number; pageSize: number;
  unread: number;
  /** Decisions owed, across everything the owner can see, not just this page.
   *  This is the number the sidebar badge shows. */
  decisions: number;
  /** Unread news, on the same basis. */
  toRead: number;
}
export interface InboxStateUpdate { id: string; version: string; read?: boolean; snoozedUntil?: number | null }
