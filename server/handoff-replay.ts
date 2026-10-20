// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an event run's stored answer says when the same hand-off is asked again. This file keeps only the RECEIPT BINDING: which request a
// stored answer was written for, and whether that request is still this asker's own hand-off to this worker. The text itself goes back out
// only through the one result gate (server/result-egress.ts), asked again now.
import { releaseStoredResult, type EgressMessage, type ResultEgressDeps } from "./result-egress.ts";
import { status, type Outbound } from "./murage-status.ts";
import { ROOM_REPLY_CHECKING } from "./room-context.ts";

export interface StoredAnswerRef { threadId: string; messageId: string; requestId?: string }
export interface StoredAnswerWho { fromBotId: string; toBotId: string; fromThreadId: string }
export interface ReplayRequestRow { id: string; toBotId: string | null; rootThreadId: string; returnThreadId: string | null }
export interface StoredAnswerDeps extends ResultEgressDeps {
  request: (id: string) => ReplayRequestRow | null;
  requestSourceThread: (id: string) => string | undefined;
}
export type { EgressMessage };

/** The text to hand back for a stored answer, or undefined when it can no longer be read (the ask then counts as ended). */
export function storedAnswerText(deps: StoredAnswerDeps, answer: StoredAnswerRef, who: StoredAnswerWho, notOwnerAudience: boolean): Outbound | undefined {
  // a mirror that is itself the checking line (a synchronous ask answered while its reply was being checked, REPLY-WITHHELD-CONTRACT R9) replays as
  // the no-answer line the asker was given (NOHOLD-DELEGATION.md): never words, and never withheld (R10)
  const mirror = deps.message(answer.threadId, answer.messageId);
  if (mirror?.murageLine === true && mirror.text === `[${ROOM_REPLY_CHECKING}]`) return status("no_answer_checking");
  const bound = answer.requestId ? deps.request(answer.requestId) : null;
  // a found request that is not this asker's own hand-off to this worker is never trusted
  const sameWork = bound !== null && bound.toBotId === who.toBotId
    && (deps.requestSourceThread(bound.id) === who.fromThreadId || bound.returnThreadId === who.fromThreadId || bound.rootThreadId === who.fromThreadId);
  const released = releaseStoredResult({
    origin: { threadId: answer.threadId, messageIds: [answer.messageId] },
    ...(sameWork ? { requestId: bound!.id } : {}),
    ...(answer.requestId && !sameWork ? { binding: "mismatch" as const } : {}),
  }, who.toBotId, who.fromThreadId, { fromBotId: who.fromBotId }, notOwnerAudience, undefined, deps);
  return released.kind === "text" ? released.text : released.kind === "gone" ? undefined : released.kind === "status" ? status("request_finished")
    : released.kind === "checking" ? status("no_answer_checking") : released.line;
}
