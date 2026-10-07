// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/bots/:id/lessons (bot-learning batch B3). Claims four routes from the
// B0 table; server/bot-learning-modules.ts imports this file.
//
//   GET    /lessons[?threadId=]  the bot's lessons, and with a thread the chips under its replies
//   POST   /lessons              "Tell it something": one owner-typed lesson, applied from the next turn
//   PATCH  /lessons/:id          edit the words (a new version)
//   DELETE /lessons/:id          Undo (Keep after Undo goes through the existing learning-keep action)
//
// A list read gives the list's own revision; an add names it. An edit or an
// undo names the lesson's version. A stale one is a 409 with the current
// lesson, never a silent overwrite.
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { registerLearningRoute, type LearningRouteAnswer, type LearningRouteContext } from "./bot-learning-routes.ts";
import { database, transaction } from "./database.ts";
import { changeLearningEvent } from "./memory/learning-history.ts";
import { procedureChipItemsForThread } from "./memory/procedure-landing.ts";
import { botNameOf, chiefShareSuggestion, recipientViews, suggestLessonShare } from "./memory/lesson-sharing.ts";
import { addLesson, chipItemsForThread, editLesson, latestLesson, lessonConflicts, lessonsRevision, listLessons, sharedLessonsFor, widenLessonScope, type Lesson } from "./memory/lessons.ts";

const view = (lesson: Lesson) => ({
  id: lesson.id, version: lesson.version, kind: lesson.kind, text: lesson.text, origin: lesson.origin, state: lesson.state,
  prospectDerived: lesson.prospectDerived, learningEventId: lesson.learningEventId, createdAt: lesson.createdAt, decidedAt: lesson.decidedAt,
  scope: lesson.scope, recipients: recipientViews(lesson.recipients), where: lesson.where, threadId: lesson.threadId,
});
/** Where a lesson that came from another bot came from, for the "Shared from ..." line. */
const sharedFrom = (db: ReturnType<typeof database>, lesson: Lesson, botId: string): { id: string; name: string } | null => {
  if (lesson.scope === "team" && lesson.botId !== botId) return { id: lesson.botId, name: botNameOf(lesson.botId) };
  const source = lesson.parentId && lesson.botId === botId ? latestLesson(db, lesson.parentId) : undefined;
  return source ? { id: source.botId, name: botNameOf(source.botId) } : null;
};
const error = (status: number, message: string, code: string, extra: Record<string, unknown> = {}): LearningRouteAnswer => ({ status, body: { error: message, code, ...extra } });
const REFUSALS: Record<string, string> = {
  empty: "Write what it should do.",
  "too-long": "Keep it under 280 characters.",
  "learning-off": "Learning is off for this bot.",
  "undone-before": "You undid this one before. Type it yourself if you want it back.",
};

function list(context: LearningRouteContext): LearningRouteAnswer {
  const db = database();
  // A share suggestion (scope "bots") is a card in Suggestions, not a lesson of this bot; team lessons that name this bot join the list.
  const own = listLessons(db, context.botId).filter(lesson => lesson.state !== "retired" && lesson.scope !== "bots");
  const reaching = sharedLessonsFor(db, context.botId).team;
  const conflicts = lessonConflicts(db, context.botId);
  const lessons = [...own, ...reaching].map(lesson => {
    const wins = conflicts.find(conflict => conflict.winner.id === lesson.id), loses = conflicts.find(conflict => conflict.other.id === lesson.id);
    return { ...view(lesson), sharedFrom: sharedFrom(db, lesson, context.botId),
      conflict: wins ? { role: "wins" as const, text: wins.other.text, fromName: botNameOf(wins.fromBotId) } : loses ? { role: "loses" as const, text: loses.winner.text, fromName: botNameOf(loses.fromBotId) } : null };
  });
  const threadId = context.url.searchParams.get("threadId");
  return { status: 200, body: { lessons, conflicts: conflicts.map(conflict => ({ winnerId: conflict.winner.id, otherId: conflict.other.id, via: conflict.via, fromBotId: conflict.fromBotId })), revision: lessonsRevision(db, context.botId), ...(threadId ? { chips: [...chipItemsForThread(db, { botId: context.botId, threadId }), ...procedureChipItemsForThread(db, { botId: context.botId, threadId })] } : {}) } };
}

function add(context: LearningRouteContext): LearningRouteAnswer {
  const text = context.body.text;
  if (typeof text !== "string") return error(400, "text must be a string", "INVALID_LESSON");
  return transaction(db => {
    const revision = lessonsRevision(db, context.botId);
    if (context.expectedRevision !== revision) return error(409, "Lessons changed elsewhere. Refresh and try again.", "REVISION_CONFLICT", { revision });
    // Typed by the owner: it applies whatever the bot's "Ask me first" says, since the owner just wrote it. It is the owner's own words for
    // their chats with this bot; "Use in every conversation" is a separate, deliberate step (widen).
    const result = addLesson(db, { botId: context.botId, text, origin: "typed", learning: DEFAULT_BOT_LEARNING });
    if (result.status === "refused") return error(422, REFUSALS[result.reason] ?? "That cannot be saved as a lesson.", result.reason);
    // A Chief of Staff's lesson about the owner is offered to the other bots, as a suggestion the owner decides on.
    if (result.status === "applied") chiefShareSuggestion(db, { botId: context.botId, lessonId: result.lesson.id });
    return { status: result.status === "duplicate" ? 200 : 201, body: { lesson: view(result.lesson), duplicate: result.status === "duplicate", revision: lessonsRevision(db, context.botId) } };
  });
}

const settle = (context: LearningRouteContext, work: (lesson: Lesson, db: ReturnType<typeof database>) => LearningRouteAnswer): LearningRouteAnswer => transaction(db => {
  const lesson = listLessons(db, context.botId).find(item => item.id === context.itemId);
  if (!lesson) return error(404, "There is no such lesson.", "NOT_FOUND");
  if (context.expectedRevision !== lesson.version) return error(409, "This lesson changed elsewhere. Refresh and try again.", "REVISION_CONFLICT", { lesson: view(lesson) });
  return work(lesson, db);
});

const edit = (context: LearningRouteContext) => settle(context, (lesson, db) => {
  if (typeof context.body.text !== "string") return error(400, "text must be a string", "INVALID_LESSON");
  try { return { status: 200, body: { lesson: view(editLesson(db, { botId: context.botId, lessonId: lesson.id, text: context.body.text })), revision: lessonsRevision(db, context.botId) } }; }
  catch (cause) { const status = (cause as { status?: number }).status ?? 500; if (status >= 500) throw cause; return error(status, (cause as Error).message, status === 400 ? "INVALID_LESSON" : "CONFLICT"); }
});

const undo = (context: LearningRouteContext) => settle(context, (lesson, db) => {
  if (!lesson.learningEventId) return error(409, "This lesson is waiting for your decision; there is nothing to undo.", "CONFLICT");
  try { changeLearningEvent(db, lesson.learningEventId, "undo"); }
  catch (cause) { const status = (cause as { status?: number }).status ?? 500; if (status >= 500) throw cause; return error(status, (cause as Error).message, "CONFLICT"); }
  const now = listLessons(db, context.botId).find(item => item.id === lesson.id)!;
  return { status: 200, body: { lesson: view(now), revision: lessonsRevision(db, context.botId), keepUntil: Date.now() + 30_000 } };
});

// Offer a lesson to named bots or the team. Only ever a suggestion: nothing reaches another bot until the owner applies it.
const share = (context: LearningRouteContext) => settle(context, (lesson, db) => {
  const recipients = context.body.recipients;
  try {
    const suggestion = recipients === undefined ? chiefShareSuggestion(db, { botId: context.botId, lessonId: lesson.id })
      : suggestLessonShare(db, { botId: context.botId, lessonId: lesson.id, recipients: recipients === "team" ? "team" : Array.isArray(recipients) ? recipients.map(String) : [] });
    if (!suggestion) return error(422, "There is nobody to offer this lesson to.", "NOT_SHAREABLE");
    return { status: 201, body: { suggestion: view(suggestion), revision: lessonsRevision(db, context.botId) } };
  } catch (cause) {
    const status = (cause as { status?: number }).status ?? 500;
    if (status >= 500) throw cause;
    return error(status, (cause as Error).message, (cause as { code?: string }).code ?? "CONFLICT");
  }
});

// Settings > Learning, "Use in every conversation": a deliberate owner step, never on the chip.
const widen = (context: LearningRouteContext) => settle(context, (lesson, db) => {
  try { return { status: 200, body: { lesson: view(widenLessonScope(db, { botId: context.botId, lessonId: lesson.id })), revision: lessonsRevision(db, context.botId) } }; }
  catch (cause) { const status = (cause as { status?: number }).status ?? 500; if (status >= 500) throw cause; return error(status, (cause as Error).message, "CONFLICT"); }
});

registerLearningRoute("lessons.share", share);
registerLearningRoute("lessons.widen", widen);
registerLearningRoute("lessons.list", list);
registerLearningRoute("lessons.add", add);
registerLearningRoute("lessons.edit", edit);
registerLearningRoute("lessons.undo", undo);
