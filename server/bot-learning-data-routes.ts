// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETE /api/bots/:id/learning/data: "Forget this learning data". Removes
// everything the bot learned (lessons, results, feedback, examples, runs, the
// ledger and learning-local/<bot>). The conversations themselves stay.
import { registerLearningRoute, type LearningRouteAnswer, type LearningRouteContext } from "./bot-learning-routes.ts";
import { DATA_DIR } from "./config.ts";
import { database, transaction } from "./database.ts";
import { forgetBotLearningData } from "./memory/evolution-forgetting.ts";

registerLearningRoute("data.forget", ({ botId }: LearningRouteContext): LearningRouteAnswer => {
  database();
  const result = transaction(db => forgetBotLearningData(db, DATA_DIR, botId));
  return { status: 200, body: { ok: true, ...result } };
});
