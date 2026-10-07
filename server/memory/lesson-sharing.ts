// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sharing a lesson with other bots or the team (bot-learning batch B11, design 14).
//
// Copying a lesson is always a suggestion the owner approves; nothing here
// runs on its own. A share suggestion is one memory_lessons row on the SOURCE
// bot (scope "bots" or "team", state "suggested", recipients named, parent_id =
// the source lesson). Applying it:
//   - "bots": one active copy per picked bot (scope "bot", parent_id = source,
//     its own ledger row, so it shows in that bot's "What it learned" and has
//     its own Undo);
//   - "team": the same row becomes the active team lesson that renders as
//     "Learned for this team" in every member's learned block.
// Only the words and the kind travel. Evidence, feedback, outcomes, examples
// and anything prospect-derived never do: a prospect-derived or outcome-derived
// lesson is refused, and a copy is never shared on.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { httpError, inTransaction, insertLesson, latestLesson, learnedEvent, listLessons, type Lesson } from "./lessons.ts";

export { lessonConflicts, sharedLessonsFor, type LessonConflict } from "./lessons.ts";

/** What the app tells this module about the bots; the host registers it (the store lives outside memory/). */
export interface LessonRosterBot { id: string; name?: string; chiefOfStaff?: boolean; chiefScope?: "workspace"; section?: string }
type Roster = () => readonly LessonRosterBot[];
let roster: Roster | null = null;
export function setLessonRoster(next: Roster | null): void { roster = next; }
const bots = (): readonly LessonRosterBot[] => roster ? roster() : [];

/** Who "the team" is for a bot: the others in its section; a workspace Chief of Staff reaches everyone. */
export function teamMembersOf(botId: string): string[] {
  const all = bots(), me = all.find(bot => bot.id === botId);
  if (!me) return [];
  const workspace = me.chiefOfStaff === true && me.chiefScope === "workspace";
  return all.filter(bot => bot.id !== botId && (workspace || (me.section !== undefined && bot.section === me.section))).map(bot => bot.id);
}

/** A bot's display name for the Learning screen; the id when the host has not said. */
export const botNameOf = (botId: string): string => bots().find(bot => bot.id === botId)?.name ?? botId;
export const recipientViews = (ids: readonly string[] | null): Array<{ id: string; name: string }> => (ids ?? []).map(id => ({ id, name: botNameOf(id) }));

const refuse = (message: string, status: number, code: string) => Object.assign(httpError(message, status), { code });
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/g, "").trim();
const MAX_RECIPIENTS = 50;

function shareableSource(db: DatabaseSync, botId: string, lessonId: string): Lesson {
  const source = latestLesson(db, lessonId);
  if (!source || source.botId !== botId) throw refuse("There is no such lesson.", 404, "NOT_FOUND");
  // Learned from customer or audience words: never leaves the bot it was learned for.
  if (source.prospectDerived) throw refuse("This was learned from customer messages, so it stays with this bot.", 422, "prospect-derived");
  if (source.scope !== "bot" && source.scope !== "owner") throw refuse(source.scope === "thread" ? "This note belongs to one conversation, so it stays there." : "This lesson was already shared.", 409, source.scope === "thread" ? "thread-scoped" : "already-shared");
  if (source.parentId !== null) throw refuse("This lesson was already shared.", 409, "already-shared");
  // Outcomes never transfer, and neither does what was learned from marking one.
  if (source.origin === "mark") throw refuse("This was learned from an outcome you marked, so it stays with this bot.", 422, "outcome-derived");
  if (source.state !== "active") throw refuse("This lesson is not in use, so it cannot be shared.", 409, "CONFLICT");
  return source;
}

const existingShare = (db: DatabaseSync, sourceId: string): Lesson | undefined => {
  const row = db.prepare("SELECT id FROM memory_lessons WHERE parent_id=? AND scope IN ('bots','team') AND state='suggested' LIMIT 1").get(sourceId);
  return row ? latestLesson(db, String(row.id)) : undefined;
};

function pickRecipients(botId: string, recipients: readonly string[] | "team"): { scope: "bots" | "team"; ids: string[] } {
  const known = new Set(bots().map(bot => bot.id));
  const ids = [...new Set(recipients === "team" ? teamMembersOf(botId) : recipients)];
  if (!ids.length) throw refuse(recipients === "team" ? "This bot has no team to share with." : "Choose at least one bot.", 400, "INVALID_RECIPIENTS");
  if (ids.length > MAX_RECIPIENTS || ids.some(id => typeof id !== "string" || id === botId || !known.has(id))) throw refuse("Choose other bots from this workspace.", 400, "INVALID_RECIPIENTS");
  return { scope: recipients === "team" ? "team" : "bots", ids };
}

/** Offer one lesson to named bots or the team. Nothing is copied until the owner applies it. */
export function suggestLessonShare(db: DatabaseSync, input: { botId: string; lessonId: string; recipients: readonly string[] | "team"; now?: number }): Lesson {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const source = shareableSource(db, input.botId, input.lessonId);
    const waiting = existingShare(db, source.id);
    if (waiting) return waiting;
    const { scope, ids } = pickRecipients(input.botId, input.recipients);
    const share: Lesson = { id: randomUUID(), version: 1, botId: source.botId, scope, kind: source.kind, text: source.text, spec: source.spec, where: source.where, threadId: null, sourceMessageId: null, targetMessageId: null, origin: "suggested", state: "suggested",
      evidence: null, prospectDerived: false, learningEventId: null, createdAt: now, decidedAt: null, parentId: source.id, recipients: ids };
    insertLesson(db, share);
    return share;
  });
}

/** The Chief of Staff's lessons about the owner (format, timing, tone, priorities) are offered to every
 * other bot by name in one suggestion; the owner picks the recipients. Null when this is not one. */
export function chiefShareSuggestion(db: DatabaseSync, input: { botId: string; lessonId: string; now?: number }): Lesson | null {
  const chief = bots().find(bot => bot.id === input.botId);
  if (!chief?.chiefOfStaff) return null;
  const others = bots().filter(bot => bot.id !== input.botId).map(bot => bot.id);
  if (!others.length) return null;
  try {
    const source = shareableSource(db, input.botId, input.lessonId);
    return suggestLessonShare(db, { botId: input.botId, lessonId: source.id, recipients: others, now: input.now });
  } catch (cause) {
    if ((cause as { status?: number }).status && (cause as { status: number }).status < 500) return null;
    throw cause;
  }
}

export interface AppliedShare { copies: Lesson[]; team: Lesson | null }

/** The owner said yes (to all the named bots, or to the ones they picked). */
export function applyLessonShare(db: DatabaseSync, input: { botId: string; lessonId: string; recipients?: readonly string[]; now?: number }): AppliedShare {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const share = latestLesson(db, input.lessonId);
    if (!share || share.botId !== input.botId || share.scope === "bot") throw refuse("There is no such suggestion.", 404, "NOT_FOUND");
    if (share.state !== "suggested") throw refuse("This suggestion is not waiting for a decision.", 409, "CONFLICT");
    const source = share.parentId ? latestLesson(db, share.parentId) : undefined;
    if (!source || source.state !== "active" || source.prospectDerived) {
      db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, share.id, share.version);
      throw refuse("The lesson this came from is gone, so there is nothing to share.", 409, "CONFLICT");
    }
    const named = share.recipients ?? [];
    const chosen = [...new Set(input.recipients ?? named)];
    if (!chosen.length || chosen.some(id => !named.includes(id))) throw refuse("Choose from the bots this suggestion names.", 400, "INVALID_RECIPIENTS");
    if (share.scope === "team") {
      const eventId = learnedEvent(db, share, now, undefined, { sharedWith: "team" });
      db.prepare("UPDATE memory_lessons SET state='active',recipients=?,learning_event_id=?,decided_at=? WHERE id=? AND version=?").run(JSON.stringify(chosen), eventId, now, share.id, share.version);
      return { copies: [], team: { ...share, state: "active", recipients: chosen, learningEventId: eventId, decidedAt: now } };
    }
    const key = normalized(share.text);
    const copies: Lesson[] = [];
    for (const botId of chosen) {
      if (listLessons(db, botId).some(lesson => (lesson.scope === "bot" || lesson.scope === "owner") && (lesson.state === "active" || lesson.state === "suggested") && normalized(lesson.text) === key)) continue;
      const copy: Lesson = { id: randomUUID(), version: 1, botId, scope: "bot", kind: share.kind, text: share.text, spec: share.spec, where: share.where, threadId: null, sourceMessageId: null, targetMessageId: null, origin: "suggested", state: "active",
        evidence: null, prospectDerived: false, learningEventId: null, createdAt: now, decidedAt: now, parentId: source.id, recipients: null };
      copy.learningEventId = learnedEvent(db, copy, now, undefined, { sharedFrom: source.botId, sharedFromLessonId: source.id });
      insertLesson(db, copy);
      copies.push(copy);
    }
    db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, share.id, share.version);
    return { copies, team: null };
  });
}
