// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Learning > Suggestions and the Unsure rows (bot-learning batch B5). Claims:
//
//   GET  /learning/suggestions                  lessons that wait for the owner's yes
//   POST /learning/suggestions/:id/apply        Apply: it becomes a lesson, from the next turn
//   POST /learning/suggestions/:id/edit         Edit: new words, still waiting ("Your edit, not checked")
//   POST /learning/suggestions/:id/not-now      Not now: gone, nothing learned
//   GET  /feedback                              Unsure rows: the owner's words the detector was not sure about
//   PATCH /feedback/:id                         Yes (it was feedback) / No (it was not)
//
// A suggestion names its lesson version; a stale one is a 409 with the current
// lesson. Guide suggestions (B7) join the same list by registering here later.
import { registerLearningRoute, type LearningRouteAnswer, type LearningRouteContext } from "./bot-learning-routes.ts";
import { DEFAULT_BOT_LEARNING, readBotLearning } from "./bot-learning.ts";
import { database, transaction } from "./database.ts";
import { confirmUnsureFeedback } from "./memory/feedback.ts";
import { applyLessonShare, botNameOf, chiefShareSuggestion, recipientViews } from "./memory/lesson-sharing.ts";
import { aboutApprovals, applySuggestedLesson, declineSuggestedLesson, editLesson, formLessonFromFeedback, listLessons, type Lesson } from "./memory/lessons.ts";
import { hasOutcomeBotLookup, lookupOutcomeBot } from "./memory/outcomes.ts";
import { applyProcedureSuggestion, editProcedureSuggestion, isProcedureSuggestionId, listProcedureSuggestions, notNowProcedureSuggestion } from "./memory/procedure-landing.ts";

const error = (status: number, message: string, code: string, extra: Record<string, unknown> = {}): LearningRouteAnswer => ({ status, body: { error: message, code, ...extra } });
const view = (lesson: Lesson) => ({
  id: lesson.id, version: lesson.version, kind: "lesson" as const, text: lesson.text, origin: lesson.origin, state: lesson.state,
  prospectDerived: lesson.prospectDerived, createdAt: lesson.createdAt,
  // A share suggestion (B11) names the bots it is for; the owner picks which ones get it.
  scope: lesson.scope, recipients: recipientViews(lesson.recipients), fromName: botNameOf(lesson.botId), where: lesson.where, threadId: lesson.threadId, lessonKind: lesson.kind, aboutApprovals: aboutApprovals(lesson),
});
const httpFail = (cause: unknown): LearningRouteAnswer => {
  const status = (cause as { status?: number }).status ?? 500;
  if (status >= 500) throw cause;
  return error(status, (cause as Error).message, status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_LESSON" : "CONFLICT");
};

// Skill and routine changes that wait for the owner (B7c) share the list with lesson suggestions.
const suggestions = (context: LearningRouteContext): LearningRouteAnswer => ({
  status: 200,
  body: { suggestions: [...listLessons(database(), context.botId, { states: ["suggested"] }).map(view), ...listProcedureSuggestions(database(), context.botId)] },
});

const procedureError = (cause: unknown): LearningRouteAnswer => {
  const status = (cause as { status?: number }).status ?? 500;
  if (status >= 500) throw cause;
  const code = (cause as { code?: string }).code ?? (status === 404 ? "NOT_FOUND" : status === 400 || status === 422 ? "INVALID_CHANGE" : "CONFLICT");
  return error(status, (cause as Error).message, code);
};
/** The same envelope a lesson answers with, for a skill or routine change. */
const procedureSettle = (context: LearningRouteContext, work: (db: ReturnType<typeof database>, id: string) => LearningRouteAnswer): LearningRouteAnswer => {
  const id = context.itemId ?? "";
  if (!Number.isInteger(context.expectedRevision)) return error(400, "expectedRevision must be a number", "INVALID_REVISION");
  try { return transaction(db => work(db, id)); } catch (cause) { return procedureError(cause); }
};

const settle = (context: LearningRouteContext, work: (lesson: Lesson, db: ReturnType<typeof database>) => LearningRouteAnswer): LearningRouteAnswer => transaction(db => {
  const lesson = listLessons(db, context.botId).find(item => item.id === context.itemId);
  if (!lesson) return error(404, "There is no such suggestion.", "NOT_FOUND");
  if (context.expectedRevision !== lesson.version) return error(409, "This suggestion changed elsewhere. Refresh and try again.", "REVISION_CONFLICT", { lesson: view(lesson) });
  return work(lesson, db);
});

const apply = (context: LearningRouteContext) => isProcedureSuggestionId(context.itemId) ? procedureSettle(context, (db, id) =>
  ({ status: 200, body: { change: applyProcedureSuggestion(db, { botId: context.botId, id, expectedVersion: Number(context.expectedRevision), ...(typeof context.body.proposedHash === "string" ? { proposedHash: context.body.proposedHash } : {}) }) } })) : settle(context, (lesson, db) => {
  try {
    if (lesson.scope === "bots" || lesson.scope === "team") {
      const picked = Array.isArray(context.body.recipients) ? context.body.recipients.map(String) : undefined;
      const result = applyLessonShare(db, { botId: context.botId, lessonId: lesson.id, recipients: picked });
      return { status: 200, body: { shared: { copies: result.copies.map(copy => copy.botId), team: result.team !== null } } };
    }
    const applied = applySuggestedLesson(db, { botId: context.botId, lessonId: lesson.id });
    chiefShareSuggestion(db, { botId: context.botId, lessonId: applied.id });
    return { status: 200, body: { lesson: view(applied) } };
  } catch (cause) { return httpFail(cause); }
});
const edit = (context: LearningRouteContext) => isProcedureSuggestionId(context.itemId) ? procedureSettle(context, (db, id) =>
  typeof context.body.text !== "string" ? error(400, "text must be a string", "INVALID_CHANGE")
    : { status: 200, body: { suggestion: editProcedureSuggestion(db, { botId: context.botId, id, expectedVersion: Number(context.expectedRevision), text: context.body.text }) } }) : settle(context, (lesson, db) => {
  if (typeof context.body.text !== "string") return error(400, "text must be a string", "INVALID_LESSON");
  if (lesson.state !== "suggested") return error(409, "This is not waiting for a decision.", "CONFLICT");
  try { return { status: 200, body: { lesson: view(editLesson(db, { botId: context.botId, lessonId: lesson.id, text: context.body.text })) } }; } catch (cause) { return httpFail(cause); }
});
const notNow = (context: LearningRouteContext) => isProcedureSuggestionId(context.itemId) ? procedureSettle(context, (db, id) =>
  ({ status: 200, body: { declined: id, ...notNowProcedureSuggestion(db, { botId: context.botId, id, expectedVersion: Number(context.expectedRevision) }) } })) : settle(context, (lesson, db) => {
  try { declineSuggestedLesson(db, { botId: context.botId, lessonId: lesson.id }); return { status: 200, body: { declined: lesson.id } }; } catch (cause) { return httpFail(cause); }
});

registerLearningRoute("suggestions.list", suggestions);
registerLearningRoute("suggestions.apply", apply);
registerLearningRoute("suggestions.edit", edit);
registerLearningRoute("suggestions.not-now", notNow);

// ── Unsure rows ───────────────────────────────────────────────────────────
const UNSURE_REVISION = 1;
const WORDS_MAX = 160;

registerLearningRoute("feedback.list", ({ botId }: LearningRouteContext): LearningRouteAnswer => {
  const rows = database().prepare(`SELECT f.id,f.thread_id,f.message_id,f.created_at,m.text FROM memory_feedback f
    LEFT JOIN messages m ON m.thread_id=f.thread_id AND m.id=f.message_id
    WHERE f.bot_id=? AND f.state='unsure' ORDER BY f.created_at DESC,f.rowid DESC LIMIT 20`).all(botId) as Array<Record<string, any>>;
  return { status: 200, body: { feedback: rows.map(row => ({
    id: String(row.id), threadId: row.thread_id === null ? null : String(row.thread_id), messageId: row.message_id === null ? null : String(row.message_id),
    text: String(row.text ?? "").replace(/\s+/g, " ").trim().slice(0, WORDS_MAX), createdAt: Number(row.created_at), revision: UNSURE_REVISION,
  })) } };
});

registerLearningRoute("feedback.answer", (context: LearningRouteContext): LearningRouteAnswer => {
  const answer = context.body.answer;
  if (answer !== "yes" && answer !== "no") return error(400, "answer must be yes or no", "INVALID_ANSWER");
  return transaction(db => {
    const row = db.prepare("SELECT * FROM memory_feedback WHERE id=? AND bot_id=?").get(context.itemId ?? "", context.botId) as Record<string, any> | undefined;
    if (!row) return error(404, "There is no such note.", "NOT_FOUND");
    if (context.expectedRevision !== UNSURE_REVISION || row.state !== "unsure") return error(409, "This was already answered.", "REVISION_CONFLICT");
    if (answer === "no") {
      db.prepare("UPDATE memory_feedback SET state='ignored',correction=NULL WHERE id=? AND state='unsure'").run(row.id);
      return { status: 200, body: { answer, id: String(row.id) } };
    }
    confirmUnsureFeedback(db, String(row.id));
    // The lesson it was holding, formed now by the same rules as any other feedback. Best effort: the answer stands either way.
    let lesson: Lesson | null = null;
    try {
      const bot = hasOutcomeBotLookup() ? lookupOutcomeBot(context.botId) : null;
      const formed = row.thread_id && row.target_message_id
        ? formLessonFromFeedback({ db, botId: context.botId, threadId: String(row.thread_id), replyMessageId: String(row.target_message_id), polarity: row.polarity, strength: row.strength,
            correction: row.correction, confidence: 1, learning: bot ? readBotLearning(bot) : DEFAULT_BOT_LEARNING })
        : null;
      if (formed && (formed.status === "formed" || formed.status === "suggested")) lesson = formed.lesson;
    } catch { /* the owner's Yes is already recorded */ }
    return { status: 200, body: { answer, id: String(row.id), ...(lesson ? { lesson: view(lesson) } : {}) } };
  });
});
