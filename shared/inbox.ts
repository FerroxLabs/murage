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
export type InboxView = "decisions" | "approvals" | "questions" | "connections" | "routines" | "to-read" | "results" | "all";

// THREE KINDS OF THING REQUIRE A PERSON, AND THEY ARE NOT INTERCHANGEABLE.
//
// The split above separated "a decision is owed" from "this is news", which
// was right and did not go far enough: everything owed was still one bucket
// and one number. The owner drew the line that was missing — an APPROVAL, a
// DECISION and a CONNECTION are asked differently, answered differently, and
// cost differently when missed.
//
//   APPROVAL   permission to perform a specific act. "Send these four
//              emails." Concrete, already drafted, waiting on a yes.
//   QUESTION   a judgement only the owner can make. "Should this become a
//              routine?" Nothing is drafted; an opinion is wanted.
//   CONNECTION something that needs the owner's hands. A credential has
//              gone; no amount of waiting or answering brings it back.
//
// And the fourth thing, which is the one that filled his Inbox with thirty
// six rows: A ROUTINE RUN IS A NOTIFICATION, NEVER A REQUEST. It happened.
// It may be worth knowing. It is never owed, however badly it went — a
// routine stuck on an overloaded provider needs patience, not a person. See
// server/inbox-rollup.ts, where the runs are grouped and a dead connection
// under them is raised as the CONNECTION it really is.
// `decisions` REMAINS THE UMBRELLA, and that is not timidity. The sidebar
// badge asks for it by name and means "how many things are waiting on me",
// which is still exactly right — the three below are how that total is BROKEN
// DOWN, not a replacement for it. Redefining `decisions` to mean only the
// questions would have left the badge silently undercounting every approval
// and every dead connection, which is the failure mode this Inbox already had
// once.
export type InboxSegment = "approval" | "question" | "connection" | "routine" | "result";

/** The segments that may put a number in front of the owner. Routines and
 *  results are told, never counted: a badge they can reach is a badge that
 *  fills up on its own, which is the defect this whole split exists for. */
export const INBOX_BADGED_SEGMENTS = ["approval", "question", "connection"] as const;

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
  /** Which of the five lists this belongs in. `kind` says what shape the
   *  message is; this says what it costs the owner to ignore it. */
  segment: InboxSegment;
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
  /** Everything owed, across all the owner can see, not just this page. This
   *  is the number the sidebar badge shows, and it is the sum of `approvals`,
   *  `questions` and `connections`. */
  decisions: number;
  /** Unread news, on the same basis. */
  toRead: number;
  /** Permission owed on a specific drafted act. */
  approvals: number;
  /** Judgements wanted, with nothing drafted yet. */
  questions: number;
  /** Connections that need the owner's hands, including ones raised by
   *  routines that keep failing on a dead credential. */
  connections: number;
}
export interface InboxStateUpdate { id: string; version: string; read?: boolean; snoozedUntil?: number | null }
