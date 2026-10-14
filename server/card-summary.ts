// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A member's saved card summary (its own earlier result, kept for its next card) as the next card's prompt quotes it.
//
// The summary is the member's released result words, but it is read back from the member's state row long after, so it is released again at
// every prompt that quotes it, through the same gate as the result it was made from: one the owner withheld, forgot or deleted since is left
// out. The row keeps the id of the message it was made from; the message is found among the member's own desk threads.
import type { DatabaseSync } from "node:sqlite";
import { requestSourceThread } from "./execution-audience.ts";
import { partitionSourcesAllowed } from "./partition-sources.ts";
import { WorkerText, type ReleasedText } from "./released-text.ts";
import { releaseStoredResult } from "./result-egress.ts";
import type { Message } from "./store.ts";

export interface CardSummaryRow { last_card_summary: string | null; last_card_summary_sources: string }

export function releasedCardSummary(
  db: DatabaseSync, store: { messageById(threadId: string, id: string): Message | undefined },
  input: { groupId: string; botId: string; request: { fromBotId?: string | null }; threadId: string; ownerAudience: boolean; prior: CardSummaryRow },
): ReleasedText | undefined {
  const { prior, botId } = input;
  if (!prior.last_card_summary) return undefined;
  try {
    const parsed: unknown = JSON.parse(prior.last_card_summary_sources);
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    if (!ids.length || !partitionSourcesAllowed(db, botId, input.threadId, ids)) return undefined;
    const desks = db.prepare("SELECT DISTINCT desk_thread_id AS id FROM project_work_items WHERE group_id=? AND assignee_bot_id=? AND desk_thread_id IS NOT NULL").all(input.groupId, botId) as Array<{ id: string }>;
    const home = desks.find(desk => ids.every(id => store.messageById(desk.id, id)));
    if (!home) return undefined;
    // delivered as the earlier run's result would be: to where that run returned to
    const earlier = store.messageById(home.id, ids[0]!)?.requestId;
    const destination = earlier ? requestSourceThread(earlier, db) : undefined;
    if (!earlier || destination === undefined) return undefined;
    const released = releaseStoredResult({ origin: { threadId: home.id, messageIds: ids }, requestId: earlier }, botId, destination, { fromBotId: input.request.fromBotId ?? "" }, !input.ownerAudience, new WorkerText(prior.last_card_summary));
    return released.kind === "text" ? released.text : undefined;
  } catch { return undefined; }
}
