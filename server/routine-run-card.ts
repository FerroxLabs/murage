// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The durable lifecycle card of a routine run in its source chat (moved out of server/index.ts so it can be tested; boot tolerance, ACCEPTANCE.md E2).
// ORDER: the unread mark is written BEFORE the card. Whether the status changed is read from the card already there, so a card written first and an unread
// write that then fails would lose the unread for good (the retry finds the card, sees no change, marks nothing). Unread first: a failure leaves no card
// and the retry does both.
import { routineRunCard, type RoutineRun } from "./routines.ts";
import { routineRunFallbackText } from "./routine-delivery.ts";
import type { Message } from "./store.ts";

export const ROUTINE_UNREAD_STATUSES: readonly RoutineRun["status"][] = ["waiting", "needs-you", "completed", "failed", "missed"];

export interface RoutineCardSource {
  threadId: string;
  bot: { id: string; name: string; color: string };
  group?: { id: string };
}
export interface RoutineCardDeps {
  /** The card written after the run was made: the rows since then, never the thread. */
  newestSince(threadId: string, at: number, test: (message: Message) => boolean): Message | undefined;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): unknown;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): unknown;
  patchGroup(groupId: string, patch: { unread: true }): unknown;
  patchTask(botId: string, threadId: string, patch: { unread: true }): unknown;
  /** The "file changed" notice of a watch run, sent once with the first card. */
  notifyChanged(source: RoutineCardSource, summary: string): void;
}

/** Upsert the run's one card in its source chat; replaying a transition (restart recovery included) patches the card instead of adding another. */
export function writeRoutineRunCard(run: RoutineRun, source: RoutineCardSource, deps: RoutineCardDeps): string {
  const card = routineRunCard(run);
  const text = routineRunFallbackText(card);
  const existing = deps.newestSince(source.threadId, Math.max(0, run.createdAt - 60_000), (message) => message.kind === "routine.run" && message.routineRun?.runId === run.id);
  const statusChanged = existing?.routineRun?.status !== run.status;
  // Merely queueing/running is ambient progress; attention and terminal states become unread in the conversation where the user asked for them.
  // THAT conversation, not the bot: patchBot's unread reaches a task only when the bot has one (upstream b34ac3ba6).
  if (statusChanged && ROUTINE_UNREAD_STATUSES.includes(run.status)) {
    if (source.group) deps.patchGroup(source.group.id, { unread: true });
    else deps.patchTask(source.bot.id, source.threadId, { unread: true });
  }
  if (existing) {
    deps.patchMessage(source.threadId, existing.id, { text, routineRun: card });
  } else {
    const message: Omit<Message, "id" | "at"> = { role: "bot", kind: "routine.run", text, routineRun: card };
    if (source.group) message.from = { botId: source.bot.id, name: source.bot.name, color: source.bot.color };
    deps.appendMessage(source.threadId, message);
  }
  if (!existing && run.watch?.outcome === "changed") deps.notifyChanged(source, card.summary ?? "The selected file changed.");
  return source.threadId;
}
