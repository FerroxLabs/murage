// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B1 outcomes: the routes (claimed from here, listed in bot-learning-modules.ts)
// and the watch on the decision site. The logic is in outcomes.ts.
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { registerLearningRoute, type LearningRouteAnswer, type LearningRouteContext } from "../bot-learning-routes.ts";
import { onDecisionAppended } from "../decision-log.ts";
import {
  OutcomeError, answerProposal, captureApprovalDecision, changeOutcome, conversationIsBots, familyCount, familyKey, hasOutcomeBotLookup, idOk, listOutcomes,
  lookupOutcomeBot, markOutcome, messageOfKey, messageRevision, outcomeCounts, rowById,
} from "./outcomes.ts";
import { recordWinChip } from "./learning-wiring.ts";
import { botReplyFor, latestBotReply } from "./memory-moments.ts";

// ---------------------------------------------------------------- decision site

/** One decision-log row reduced to what capture needs. */
onDecisionAppended((dataDir, row) => {
  if (row.source !== "user" || (row.decision !== "user-approved" && row.decision !== "user-denied") || !row.botId || !row.requestId || dataDir !== DATA_DIR) return;
  const bot = lookupOutcomeBot(row.botId);
  if (!bot) return;
  captureApprovalDecision(database(), { botId: row.botId, threadId: row.threadId, requestId: row.requestId, tool: row.tool, approved: row.decision === "user-approved" }, bot);
});

// ---------------------------------------------------------------- routes

const answerError = (error: unknown): LearningRouteAnswer => {
  if (error instanceof OutcomeError) return { status: error.status, body: { error: error.message, code: error.code } };
  throw error;
};
const conflict = (db: DatabaseSync, botId: string, messageId: string, current: number): LearningRouteAnswer =>
  ({ status: 409, body: { error: "That mark changed elsewhere. Refresh and try again.", code: "REVISION_CONFLICT", revision: current, outcomes: listOutcomes(db, { botId }).filter(item => item.messageId === messageId) } });

registerLearningRoute("outcomes.list", ({ botId, url }: LearningRouteContext) => {
  const state = url.searchParams.get("state");
  const threadId = url.searchParams.get("threadId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const db = database();
  return { status: 200, body: { outcomes: listOutcomes(db, { botId, threadId, limit: Number.isFinite(limit) ? limit : 200, state: state === "proposed" || state === "confirmed" || state === "all" ? state : "live" }), counts: outcomeCounts(db, botId) } };
});
registerLearningRoute("outcomes.add", ({ botId, body, expectedRevision }: LearningRouteContext) => {
  const db = database();
  try {
    const threadId = idOk(body.threadId, "threadId"), messageId = idOk(body.messageId, "messageId");
    // A room's reply is still the bot's own; markOutcome checks who sent it.
    if (hasOutcomeBotLookup()) {
      const owner = lookupOutcomeBot(botId);
      if (!owner) return { status: 404, body: { error: "no such bot" } };
      if (!conversationIsBots(db, owner, threadId, messageId)) return { status: 404, body: { error: "no such message for this bot", code: "MESSAGE_NOT_FOUND" } };
    }
    const current = messageRevision(db, botId, messageId);
    if (expectedRevision !== current) return conflict(db, botId, messageId, current);
    const outcome = markOutcome(db, { botId, threadId, messageId, kind: body.kind, reason: body.reason, value: body.value, currency: body.currency });
    recordWinChip(db, outcome);
    return { status: 200, body: { outcome } };
  } catch (error) { return answerError(error); }
});
registerLearningRoute("outcomes.change", ({ botId, itemId, body, expectedRevision }: LearningRouteContext) => {
  const db = database();
  try {
    const row = rowById(db, botId, itemId!);
    const key = familyKey(row.source_event_key);
    const current = key ? familyCount(db, botId, key) : 1;
    if (expectedRevision !== current) return conflict(db, botId, messageOfKey(row.source_event_key) ?? "", current);
    const unknown = Object.keys(body).filter(name => !["expectedRevision", "idempotencyKey", "answer", "revoke", "kind", "reason", "value", "currency"].includes(name));
    if (unknown.length) return { status: 400, body: { error: `unknown field: ${unknown[0]}` } };
    const proposal = !row.confirmed_by;
    const outcome = proposal
      ? answerProposal(db, { botId, id: row.id, answer: body.answer, reason: body.reason, value: body.value, currency: body.currency })
      : changeOutcome(db, { botId, id: row.id, change: body.revoke === true ? { revoke: true } : { kind: body.kind, reason: body.reason, value: body.value, currency: body.currency } });
    // A won or good answer on the card is a win like any other: the same chip, under the bot's reply.
    if (proposal && outcome.state === "confirmed") {
      const anchor = messageOfKey(row.source_event_key);
      const reply = (anchor ? botReplyFor(db, String(outcome.threadId), anchor) : null) ?? (outcome.threadId ? latestBotReply(db, outcome.threadId) : null);
      recordWinChip(db, { ...outcome, messageId: reply });
    }
    return { status: 200, body: { outcome } };
  } catch (error) { return answerError(error); }
});
