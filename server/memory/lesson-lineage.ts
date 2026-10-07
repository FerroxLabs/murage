// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lineage and conflicts for shared lessons (bot-learning batch B11, design 14).
//
// A lesson the owner shared keeps its source in memory_lessons.parent_id: every
// copy for a named bot, the team lesson, and a share suggestion still waiting
// all point at the source lesson. That one link is how Undo or Forget on the
// source reaches the recipients. This file works on rows only and does not
// import lessons.ts, so lessons.ts can call it from its own Undo path.
//
// Outcomes, feedback and examples never travel: a copy carries the words, a
// kind, and the link back, and nothing else.
import type { DatabaseSync } from "node:sqlite";
import { recordLearningEvent } from "./learning-ledger.ts";
import type { StyleSpec } from "./lesson-spec.ts";

const LATEST = "version=(SELECT MAX(version) FROM memory_lessons m WHERE m.id=memory_lessons.id)";
type Row = Record<string, any>;

const children = (db: DatabaseSync, parentId: string): Row[] =>
  db.prepare(`SELECT * FROM memory_lessons WHERE parent_id=? AND ${LATEST}`).all(parentId) as Row[];

/** Undo on the source: copies and team lessons are undone, waiting suggestions are withdrawn.
 * Returns how many live copies were removed. */
export function cascadeLineageUndo(db: DatabaseSync, parentId: string, now: number): number {
  let removed = 0;
  for (const child of children(db, parentId)) {
    if (child.state === "suggested") {
      db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, child.id, child.version);
      continue;
    }
    if (child.state !== "active") continue;
    db.prepare("UPDATE memory_lessons SET state='undone',decided_at=? WHERE id=? AND version=?").run(now, child.id, child.version);
    if (child.learning_event_id) {
      const event = db.prepare("SELECT scope_id FROM memory_learning_events WHERE id=?").get(child.learning_event_id);
      db.prepare("UPDATE memory_learning_events SET undone_at=?,kept_at=NULL WHERE id=?").run(now, child.learning_event_id);
      if (event) recordLearningEvent(db, { kind: "lesson-undone", scopeId: String(event.scope_id), botId: String(child.bot_id), detail: { lessonId: child.id, lessonEventId: child.learning_event_id, cascadedFrom: parentId }, now });
    }
    removed++;
  }
  return removed;
}

/** Keep after Undo on the source, inside the window: the copies the cascade removed come back.
 * A copy the owner undid on its own earlier is left undone. */
export function cascadeLineageRestore(db: DatabaseSync, parentId: string, undoneAt: number, now: number): number {
  let restored = 0;
  for (const child of children(db, parentId)) {
    if (child.state !== "undone" || Number(child.decided_at) !== undoneAt) continue;
    db.prepare("UPDATE memory_lessons SET state='active',decided_at=? WHERE id=? AND version=?").run(now, child.id, child.version);
    if (child.learning_event_id) {
      const event = db.prepare("SELECT scope_id FROM memory_learning_events WHERE id=?").get(child.learning_event_id);
      db.prepare("UPDATE memory_learning_events SET undone_at=NULL WHERE id=?").run(child.learning_event_id);
      if (event) recordLearningEvent(db, { kind: "owner-keep", scopeId: String(event.scope_id), botId: String(child.bot_id), detail: { lessonId: child.id, lessonEventId: child.learning_event_id, restored: true, cascadedFrom: parentId }, now });
    }
    restored++;
  }
  return restored;
}

/** Forget on the source: every copy leaves the recipients at their next turn and its words are erased. */
export function cascadeLineageForget(db: DatabaseSync, parentId: string, now: number): number {
  let removed = 0;
  for (const child of children(db, parentId)) {
    if (child.state !== "active" && child.state !== "suggested") continue;
    db.prepare("UPDATE memory_lessons SET state='stale',kind='note',spec=NULL,where_=NULL,text='',evidence=NULL,decided_at=? WHERE id=? AND version=?").run(now, child.id, child.version);
    if (child.learning_event_id) db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=? AND undone_at IS NULL").run(now, child.learning_event_id);
    removed++;
  }
  return removed;
}

/** "Forget this learning data" for a bot: the copies it handed to other bots go with it. */
export function forgetLineageOfBot(db: DatabaseSync, botId: string, now: number): number {
  let removed = 0;
  const sources = db.prepare("SELECT DISTINCT id FROM memory_lessons WHERE bot_id=?").all(botId) as Row[];
  for (const source of sources) removed += cascadeLineageForget(db, String(source.id), now);
  return removed;
}

// ── conflicts ─────────────────────────────────────────────────────────────
const NEGATORS = new Set(["no", "not", "never", "dont", "don't", "avoid", "without", "stop", "skip", "nothing", "cant", "can't", "wont", "won't", "shouldnt", "shouldn't"]);
const FILLER = new Set([
  "a", "an", "the", "in", "on", "at", "to", "of", "for", "with", "and", "or", "my", "our", "your", "it", "its", "is", "are", "be", "do", "does", "that", "this", "any", "all",
  "use", "using", "add", "include", "always", "please", "make", "keep", "put", "send", "write", "when", "from", "by", "as", "i", "me", "we", "you", "should", "must", "need", "want", "like", "more", "ever",
]);
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);

/** Two different values for the same setting: the same sentence with one slot changed, where the slot is a number
 * ("under 3 sentences" and "under 5 sentences"), a day, a language or a register. Cheap and exact; the rest is left to the owner. */
const VALUE_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "weekdays", "weekends", "daily", "weekly", "monthly"]),
  new Set(["english", "french", "spanish", "german", "italian", "portuguese", "japanese", "chinese", "hindi", "dutch", "korean", "arabic"]),
  new Set(["formal", "casual", "friendly", "professional", "warm", "playful", "direct", "blunt", "polite", "concise", "detailed", "brief", "short", "long"]),
  new Set(["morning", "afternoon", "evening", "midday"]),
];
const isNumber = (word: string) => /^\d+([.:]\d+)?(am|pm|st|nd|rd|th|k|%)?$/.test(word);
function differentValue(wa: string[], wb: string[]): boolean {
  if (wa.length !== wb.length || wa.length < 3) return false;
  const at = wa.map((word, index) => word === wb[index] ? -1 : index).filter(index => index >= 0);
  if (at.length !== 1) return false;
  const x = wa[at[0]], y = wb[at[0]];
  if (isNumber(x) && isNumber(y)) return true;
  return VALUE_GROUPS.some(group => group.has(x) && group.has(y));
}

/** Known contradictions only: the same kind of lesson, one saying yes and one no, about the same subject
 * (most of the subject words are shared). Everything else is left to the owner's eyes. */
export function lessonsConflict(a: { kind: string; text: string; spec?: StyleSpec | null }, b: { kind: string; text: string; spec?: StyleSpec | null }): boolean {
  if (a.kind !== b.kind) return false;
  // Two style values are compared as values: the same thing set two ways conflicts, different things never do.
  if (a.spec || b.spec) {
    if (!a.spec || !b.spec || a.spec.kind !== b.spec.kind) return false;
    if (a.spec.kind === "term" && b.spec.kind === "term") return a.spec.insteadOf.toLowerCase() === b.spec.insteadOf.toLowerCase() && a.spec.use.toLowerCase() !== b.spec.use.toLowerCase();
    return (a.spec as { value: string }).value !== (b.spec as { value: string }).value;
  }
  const wa = words(a.text), wb = words(b.text);
  if (differentValue(wa, wb)) return true;
  const negative = (list: string[]) => list.filter(word => NEGATORS.has(word)).length % 2 === 1;
  if (negative(wa) === negative(wb)) return false;
  const subject = (list: string[]) => new Set(list.filter(word => !NEGATORS.has(word) && !FILLER.has(word)));
  const sa = subject(wa), sb = subject(wb);
  if (!sa.size || !sb.size) return false;
  let shared = 0;
  for (const word of sa) if (sb.has(word)) shared++;
  return shared / Math.min(sa.size, sb.size) >= 0.6;
}
