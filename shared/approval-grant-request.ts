// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a pending permission card carries so the owner can see EVERY action it
// would run and what "Always allow" would remember (APP-GRANT-AMEND-13
// .AGREED-r2.md Rules 78, 80b, 81c, 82). The server writes it once, when the
// request opens, from the engine's own call; the client only reads it. The
// grant routes reread it from the stored card and never take keys a client
// sends in its place (Rule 81).
//
// Grant keys appear here only so the server can match a decision to what it
// offered; the card speaks in actions and places, never in keys.

/** One finding a row produced (server/stop-line.ts StopHit, in plain words). */
export interface ApprovalRowFinding {
  kind: "delete" | "pay" | "message";
  /** the card's plain-words line, e.g. "Message someone it has not written to before: bob@example.com" */
  what: string;
  /** the stop key that would remember this one finding, when it has a place */
  key?: string;
}

/** One operation of the request, in call order. */
export interface ApprovalActionRow {
  /** position in the call, from 0 */
  index: number;
  /** "action" for an execute row, "lookup" for a connector lookup */
  kind: "action" | "lookup";
  /** the operation slug (`GMAIL_CREATE_EMAIL_DRAFT`) or the lookup's service id (`COMPOSIO_SEARCH_TOOLS`) */
  operation: string;
  /** the app in plain words ("Gmail"); "Connected apps" for a lookup */
  app: string;
  /** the action in plain words ("create email draft", "find app tools") */
  action: string;
  /** the connected account the row names, when it names one */
  account?: string;
  /** every recipient or destination the stop line reads for this row */
  destinations: string[];
  /** the row's stop findings; empty when it crosses no stop line */
  findings: ApprovalRowFinding[];
  /** the row's own arguments as the engine sent them, to inspect */
  arguments: unknown;
}

/** A stop finding the owner may also remember for the routine, separately
 * from the actions (Rules 80b, 81c). */
export interface RoutineStopOffer {
  key: string;
  /** plain words for what it remembers */
  what: string;
  /** the one recipient it names, for a message finding */
  recipient?: string;
}

/** "Always allow for this routine" as the server offers it on this card. */
export interface RoutineGrantOffer {
  routineId: string;
  routineName: string;
  /** whether the choice is offered at all */
  eligible: boolean;
  /** why not, in plain words, when it is not */
  reason?: string;
  /** the exact actions and lookups the choice saves (one per distinct
   * action; for a command card, its exact command key) */
  actionKeys: string[];
  /** findings that may be remembered too, each named on its own */
  stopKeys: RoutineStopOffer[];
  /** findings that can never be remembered, in plain words: while any is
   * listed, the choice does not cover the whole call on future runs */
  notRemembered: string[];
}

/** The data a pending card carries for Rule 82's rendering. */
export interface ApprovalGrantRequest {
  /** every operation in call order; empty for a tool that is not a connected-app call */
  rows: ApprovalActionRow[];
  /** present on a card a routine run raised */
  routine?: RoutineGrantOffer;
}
