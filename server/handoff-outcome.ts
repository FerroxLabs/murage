// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one presenter of a hand-off's outcome (server/event-limit.ts HandoffOutcome) for the two routes that can ask it: `ask` (the caller waits)
// and `delegate` (the caller goes on). A hand-off made one way and asked again the other way, later or at the same time, gets the first outcome
// in the shape its own route speaks, with no second execution or charge. Answer text arrives only through the one result gate
// (server/result-egress.ts) via `answerText`.
import type { HandoffOutcome } from "./event-limit.ts";
import { botReply, type BotReply } from "./bot-egress.ts";
import { status, type BotName, type Outbound } from "./murage-status.ts";

export type HandoffVia = "ask" | "delegate";
export type HandoffReply = BotReply;
export interface HandoffPresenter {
  targetName: BotName;
  /** Can the server still answer for this ticket (server/task-resolution.ts)? */
  resolvable: (taskId: string) => boolean;
  /** The stored answer as the result gate releases it now; undefined when it can no longer be read. */
  answerText: (answer: Extract<HandoffOutcome, { kind: "answer" }>) => Outbound | undefined;
}

/** `joined`: the call was running at the same time as the first, so an ended outcome is answered (not charged again); a call made later treats an
 * ended hand-off as a new attempt, so it gets undefined here. Undefined also means a ticket nothing can answer, or an answer that can no longer be read. */
export function formatHandoff(outcome: HandoffOutcome, via: HandoffVia, who: HandoffPresenter, joined = false): HandoffReply | undefined {
  const reply = (input: Parameters<typeof botReply>[1]): HandoffReply => botReply(200, input);
  const { targetName } = who;
  switch (outcome.kind) {
    case "queued":
      return via === "ask" ? reply({ busy: true, taskId: outcome.taskId, toBotName: targetName, note: status("asked_in_run_note") })
        : reply({ queued: true, taskId: outcome.taskId, message: status("handed_over_run", { name: targetName }) });
    case "timeout":
      if (!who.resolvable(outcome.taskId)) return undefined;
      return via === "ask" ? reply({ timeout: true, taskId: outcome.taskId, toBotName: targetName })
        : reply({ queued: true, taskId: outcome.taskId, message: status("handed_over_run_working", { name: targetName }) });
    case "ended": {
      if (!joined) return undefined;
      const line = status("ended_in_run", { name: targetName, reason: outcome.reason });
      return via === "ask" ? reply({ botName: targetName, text: line }) : reply({ message: line });
    }
    case "no_answer": {
      // final for the request: the same line again, whatever the originals read now (NOHOLD-DELEGATION.md)
      const line = status("answered_in_run", { name: targetName, answer: status(outcome.why === "checking" ? "no_answer_checking" : "withheld") });
      return via === "ask" ? reply({ botName: targetName, text: line }) : reply({ message: line });
    }
    case "answer": {
      const answer = who.answerText(outcome);
      if (answer === undefined) return undefined;
      const line = status("answered_in_run", { name: targetName, answer });
      return via === "ask" ? reply({ botName: targetName, text: line }) : reply({ message: line });
    }
  }
}
