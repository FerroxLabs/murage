// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots/:id/learning/counts[?month=YYYY-MM][&since=<ms>] (bot-learning
// batch B5m). The numbers behind "This month: learned N, remembers M" on the
// Learning screen, the Overview sentence, and the settings-list badge:
//
//   counts  lessons, memories, wins and undone for the month (default: this one)
//   unseen  lessons and memories kept since `since` (the owner's last look); 0 without it
//
// Counts come from the learning ledger and the outcome marks. Nothing is
// invented, and nothing here changes anything.
import { registerLearningRoute, type LearningRouteAnswer, type LearningRouteContext } from "./bot-learning-routes.ts";
import { database } from "./database.ts";
import { learningCounts, newLearningSince } from "./memory/memory-moments.ts";

registerLearningRoute("counts.read", ({ botId, url }: LearningRouteContext): LearningRouteAnswer => {
  const month = url.searchParams.get("month") ?? undefined;
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw === null ? null : Number(sinceRaw);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) return { status: 400, body: { error: "since must be a time in milliseconds", code: "INVALID_SINCE" } };
  const db = database();
  try {
    return { status: 200, body: { counts: learningCounts(db, { botId, month }), unseen: since === null ? 0 : newLearningSince(db, botId, since) } };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 400) return { status, body: { error: (error as Error).message, code: "INVALID_MONTH" } };
    throw error;
  }
});
