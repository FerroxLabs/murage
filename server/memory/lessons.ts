// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lessons (bot-learning batch B3, design sections 5, 7, 12, 12a and 15).
//
// A lesson is one thing the owner taught a bot. Two kinds exist (design note
// TIER1-ALLOWLIST.md): a STYLE lesson is one value from a closed, typed set
// (lesson-spec.ts) and its prompt line is written by code, so it applies on
// its own; a NOTE is free text and never applies on its own, it waits for one
// tap ("Keep it?"). Only text the owner types themselves ("Tell it something")
// is active at once. Approvals, permissions and tools are host state that
// never reads this file (import fence, lesson-fence.test.ts).
//
// Every active lesson owns one row in memory_learning_events (the ledger row
// is written first, in the same transaction), so the existing "What it
// learned" list and the existing changeLearningEvent Undo and Keep serve
// lessons with no second mechanism. The text itself lives only in
// memory_lessons, so forgetting a lesson never leaves words behind in the
// ledger.
//
// The chip under a reply is built from these ledger rows and from nothing
// else: no stored event, no chip (section 12a, rule 1).
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { BotLearning } from "../bot-learning.ts";
import {
  KEEP_WINDOW_MS, KEPT_CHIP_TURNS, chipClause, groupOf, pickTemplate,
  type ChipItem, type TemplateGroup,
} from "../../shared/learned-chip.ts";
import { parseStyleSpec, parseWhere, renderStyleLine, specKey, supersedeKey, type StyleSpec, type Where } from "./lesson-spec.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { cascadeLineageRestore, cascadeLineageUndo, lessonsConflict } from "./lesson-lineage.ts";

export const LESSON_KINDS = ["style", "note"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];
export type LessonOrigin = "feedback" | "edit" | "mark" | "typed" | "suggested";
export type LessonState = "active" | "suggested" | "undone" | "retired" | "unsupported" | "stale";
export type LessonScope = "thread" | "owner" | "bot" | "bots" | "team";
/** A suggestion stays under its reply this long; after that it waits in Settings > Learning. */
export const SUGGESTION_CHIP_WINDOW_MS = 10 * 60_000;
export const LESSON_MAX_CHARS = 280;
/** The learned block carries the newest lessons only, and a bounded amount of text. */
export const LEARNED_BLOCK_MAX_LESSONS = 25;
const LEARNED_BLOCK_MAX_CHARS = 4000;
/** Recent feedback rows live for 20 turns or until they become a lesson. */
export const RECENT_FEEDBACK_TURNS = 20;
const RECENT_FEEDBACK_ROWS = 3;

export interface Lesson {
  id: string; version: number; botId: string; scope: LessonScope; kind: LessonKind; text: string;
  /** Style lessons: the typed effect and where it applies. The text of a style lesson is the code-written line. */
  spec: StyleSpec | null; where: Where | null;
  /** The conversation, the owner message and the bot reply it was formed from. A thread note renders only in its own thread. */
  threadId: string | null; sourceMessageId: string | null; targetMessageId: string | null;
  origin: LessonOrigin; state: LessonState; evidence: unknown; prospectDerived: boolean;
  learningEventId: string | null; createdAt: number; decidedAt: number | null;
  /** The lesson this one was shared from (B11): a copy for a named bot, the team lesson, or a share suggestion. */
  parentId: string | null;
  /** Bot ids a shared lesson (scope bots or team) is for. */
  recipients: string[] | null;
}

export const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

// ── text check ────────────────────────────────────────────────────────────
// Nothing here reads the words for intent. A note cannot reach a tool, a permission or an approval because lessons are prompt
// text only and host state never reads them (lesson-fence.test.ts). The length and emptiness limits are all that remain.
export type LessonTextCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "too-long" };
export function checkLessonText(raw: string): LessonTextCheck {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > LESSON_MAX_CHARS) return { ok: false, reason: "too-long" };
  return { ok: true, text };
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/g, "").trim();

// ── plumbing ──────────────────────────────────────────────────────────────
let savepoints = 0;
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction;
  const point = `lessons_tx_${++savepoints}`;
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec(nested ? `RELEASE ${point}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK");
    throw error;
  }
}

export function ensureBotScope(db: DatabaseSync, botId: string): string {
  const row = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(botId);
  if (row) return String(row.id);
  const id = randomUUID();
  db.prepare("INSERT INTO memory_scopes VALUES(?,'bot',?,'[]',0)").run(id, botId);
  return id;
}

const parseStored = (raw: unknown): StyleSpec | null => { try { return raw ? parseStyleSpec(JSON.parse(String(raw))) : null; } catch { return null; } };
const optionalText = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const lessonOf = (row: Record<string, any>): Lesson => ({
  id: String(row.id), version: Number(row.version), botId: String(row.bot_id), scope: row.scope, kind: row.kind, text: String(row.text),
  spec: parseStored(row.spec), where: parseWhere(row.where_), threadId: optionalText(row.thread_id), sourceMessageId: optionalText(row.source_message_id), targetMessageId: optionalText(row.target_message_id),
  origin: row.origin, state: row.state, evidence: row.evidence ? JSON.parse(String(row.evidence)) : null, prospectDerived: row.prospect_derived === 1,
  learningEventId: row.learning_event_id === null ? null : String(row.learning_event_id), createdAt: Number(row.created_at), decidedAt: row.decided_at === null ? null : Number(row.decided_at),
  parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
  recipients: row.recipients ? (JSON.parse(String(row.recipients)) as unknown[]).map(String) : null,
});

const LATEST = "version=(SELECT MAX(version) FROM memory_lessons m WHERE m.id=memory_lessons.id)";

/** Each lesson's current version, oldest first. */
export function listLessons(db: DatabaseSync, botId: string, options: { states?: readonly LessonState[] } = {}): Lesson[] {
  const rows = db.prepare(`SELECT * FROM memory_lessons WHERE bot_id=? AND ${LATEST} ORDER BY created_at,rowid`).all(botId) as Record<string, any>[];
  return rows.map(lessonOf).filter(lesson => !options.states || options.states.includes(lesson.state));
}

export const latestLesson = (db: DatabaseSync, id: string): Lesson | undefined => {
  const row = db.prepare(`SELECT * FROM memory_lessons WHERE id=? AND ${LATEST}`).get(id);
  return row ? lessonOf(row) : undefined;
};

/** Moves on every lesson change, for the expected-revision rule on the routes. */
export function lessonsRevision(db: DatabaseSync, botId: string): number {
  const rows = Number(db.prepare("SELECT COUNT(*) c FROM memory_lessons WHERE bot_id=?").get(botId)?.c ?? 0);
  const events = Number(db.prepare(`SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=? AND (kind IN ('lesson-learned','lesson-edited','lesson-undone') OR (kind='owner-keep' AND json_extract(detail,'$.lessonId') IS NOT NULL))`).get(botId)?.c ?? 0);
  return rows + events;
}

export const previousTemplate = (db: DatabaseSync, botId: string, group: TemplateGroup): number | null => {
  const row = db.prepare(`SELECT json_extract(detail,'$.template') t FROM memory_learning_events WHERE bot_id=? AND json_extract(detail,'$.group')=? AND json_extract(detail,'$.template') IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(botId, group);
  return row && row.t !== null ? Number(row.t) : null;
};
export const seedFor = (db: DatabaseSync, botId: string, now: number) => Number(db.prepare("SELECT COUNT(*) c FROM memory_learning_events WHERE bot_id=?").get(botId)?.c ?? 0) * 7 + (now % 997);

// ── admission (B4's single gate, injected) ────────────────────────────────
/** What the gate says about a candidate lesson text. Same shape as B4's
 * admitLessonText (memory/learnable.ts), which the integrator wires in with
 * setLessonAdmitter. Prospect wording is refused outright when the bot's
 * opt-in is off; with it on, it is a suggestion kept under learning-local/ and
 * never in messages.db. Contact details and secrets come back redacted. */
export type LessonAdmission =
  | { ok: true; text: string; prospectDerived: boolean; destination: "messages-db" | "learning-local"; mustSuggest: boolean }
  | { ok: false; reason: "prospect-text" | "empty" };
export type LessonAdmitter = (bot: { id?: string; learning?: unknown }, candidate: string, prospectTexts: readonly string[]) => LessonAdmission;
const admitAll: LessonAdmitter = (_bot, candidate) => ({ ok: true, text: candidate.trim(), prospectDerived: false, destination: "messages-db", mustSuggest: false });
let admitter: LessonAdmitter = admitAll;
/** Wire B4's admitLessonText here. The default allows everything and keeps it in messages.db. */
export function setLessonAdmitter(next: LessonAdmitter | null): void { admitter = next ?? admitAll; }

/** Where a prospect-derived lesson goes instead of messages.db (lessons-local.ts). */
export type LearningLocalLessonSink = (lesson: Lesson) => void;
let localSink: LearningLocalLessonSink | null = null;
export function setLearningLocalLessonSink(next: LearningLocalLessonSink | null): void { localSink = next; }

/** Evidence the forgetting sweep (B4) can match: [{kind:"source", id}] (also
 * {sourceId} and {messageId} are read). Anything else is dropped. */
export type EvidenceRef = { kind: "source"; id: string; revision?: number } | { messageId: string };
/** What B2's lesson plan carries (planFeedbackLesson): stored unchanged, so
 * suppressedPhrases and isBlockedLesson read `phrase`, and forgetting finds `messageId`. */
export interface FeedbackEvidence { feedbackId?: string; phrase?: string | null; messageId?: string; action?: string | null; editKind?: string; /** The classifier tagged it as about approvals: it shows the Access link, never Keep. */ aboutApprovals?: boolean }
const isFeedbackEvidence = (input: unknown): input is FeedbackEvidence =>
  Boolean(input) && typeof input === "object" && !Array.isArray(input) && ("feedbackId" in (input as object) || "editKind" in (input as object));
export function normalizeEvidence(input: unknown): EvidenceRef[] | FeedbackEvidence {
  if (isFeedbackEvidence(input)) {
    const keep: FeedbackEvidence = {};
    for (const name of ["feedbackId", "messageId", "editKind"] as const) if (typeof input[name] === "string") keep[name] = input[name];
    if (input.aboutApprovals === true) keep.aboutApprovals = true;
    for (const name of ["phrase", "action"] as const) if (typeof input[name] === "string" || input[name] === null) keep[name] = input[name];
    return keep;
  }
  const list = Array.isArray(input) ? input : input && typeof input === "object" ? Object.values(input) : [];
  const out: EvidenceRef[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const ref = item as Record<string, unknown>;
    const id = typeof ref.id === "string" && (ref.kind === undefined || ref.kind === "source") ? ref.id : typeof ref.sourceId === "string" ? ref.sourceId : "";
    if (id) out.push(Number.isSafeInteger(ref.revision) ? { kind: "source", id, revision: ref.revision as number } : { kind: "source", id });
    else if (typeof ref.messageId === "string" && ref.messageId) out.push({ messageId: ref.messageId });
    if (out.length >= 20) break;
  }
  return out;
}

// ── adding ────────────────────────────────────────────────────────────────
export interface AddLessonInput {
  botId: string; origin: LessonOrigin; learning: BotLearning;
  /** A note's words (typed by the owner, or the owner's own clause inside a suggestion). Not used when `spec` is given. */
  text?: string;
  /** A style lesson's typed effect. It is parsed again here by the strict parser; anything else is refused. */
  spec?: unknown; where?: Where;
  /** The feedback layer's verdict that every auto-apply condition held (design 3.1). Only a style lesson can use it. */
  auto?: boolean;
  /** thread: only the conversation it came from. owner: the owner's chats with this bot. bot: widened by the owner in Settings. */
  scope?: "thread" | "owner" | "bot";
  threadId?: string | null; sourceMessageId?: string | null; targetMessageId?: string | null;
  prospectDerived?: boolean;
  /** The sources the lesson rests on: [{kind:"source", id}], so forgetting a source can find it. */
  evidence?: unknown;
  /** Wording the owner's audience (prospects, customers) said, so the gate can tell a quote from the owner's own words. */
  prospectTexts?: readonly string[];
  /** The words are backed by something new since the owner last undid them. */
  newEvidence?: boolean;
  /** Where the chip goes: the reply the lesson came from. Typed lessons have none. */
  chip?: { threadId: string; replyMessageId: string };
  now?: number;
}
export type AddLessonResult =
  | { status: "applied"; lesson: Lesson }
  | { status: "suggested"; lesson: Lesson }
  | { status: "duplicate"; lesson: Lesson }
  | { status: "refused"; reason: "empty" | "too-long" | "invalid-spec" | "learning-off" | "undone-before" | "prospect-text" | "learning-local-unavailable" };

export function insertLesson(db: DatabaseSync, lesson: Omit<Lesson, "version" | "parentId" | "recipients" | "spec" | "where" | "threadId" | "sourceMessageId" | "targetMessageId"> & { version?: number; parentId?: string | null; recipients?: string[] | null; spec?: StyleSpec | null; where?: Where | null; threadId?: string | null; sourceMessageId?: string | null; targetMessageId?: string | null }) {
  db.prepare(`INSERT INTO memory_lessons(id,version,parent_id,bot_id,scope,recipients,kind,text,origin,state,evidence,prospect_derived,learning_event_id,created_at,decided_at,spec,where_,thread_id,source_message_id,target_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(lesson.id, lesson.version ?? 1, lesson.parentId ?? null, lesson.botId, lesson.scope, lesson.recipients ? JSON.stringify(lesson.recipients) : null, lesson.kind, lesson.text, lesson.origin, lesson.state,
      lesson.evidence === null || lesson.evidence === undefined ? null : JSON.stringify(lesson.evidence), lesson.prospectDerived ? 1 : 0, lesson.learningEventId, lesson.createdAt, lesson.decidedAt,
      lesson.spec ? JSON.stringify(lesson.spec) : null, lesson.where ?? null, lesson.threadId ?? null, lesson.sourceMessageId ?? null, lesson.targetMessageId ?? null);
}

/** The ledger row for a lesson that is now active. Written before the lesson row. */
export function learnedEvent(db: DatabaseSync, lesson: { id: string; botId: string; kind: LessonKind; origin: LessonOrigin }, now: number, chip?: AddLessonInput["chip"], extra: Record<string, unknown> = {}): string {
  const group: TemplateGroup = "lesson";
  const detail: Record<string, unknown> = { lessonId: lesson.id, lessonVersion: 1, lessonKind: lesson.kind, origin: lesson.origin, ...extra };
  if (chip) Object.assign(detail, { threadId: chip.threadId, replyMessageId: chip.replyMessageId, group, template: pickTemplate(group, previousTemplate(db, lesson.botId, group), seedFor(db, lesson.botId, now)) });
  return recordLearningEvent(db, { kind: "lesson-learned", scopeId: ensureBotScope(db, lesson.botId), botId: lesson.botId, detail, now });
}

/** A newer style lesson replaces the older one for the same (kind, where), and per `insteadOf` for a term. Returns the ids it retired. */
function supersedeStyle(db: DatabaseSync, next: Pick<Lesson, "id" | "botId" | "spec" | "where">, now: number): string[] {
  if (!next.spec) return [];
  const key = supersedeKey(next.spec, next.where ?? "everywhere");
  const retired: string[] = [];
  for (const old of listLessons(db, next.botId, { states: ["active"] })) {
    if (old.id === next.id || old.scope !== "bot" || old.parentId !== null || !old.spec || supersedeKey(old.spec, old.where ?? "everywhere") !== key) continue;
    db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, old.id, old.version);
    retired.push(old.id);
  }
  return retired;
}
/** Undo of a style lesson puts back the value it replaced. */
function restoreSuperseded(db: DatabaseSync, ids: unknown, now: number): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids.map(String)) {
    const old = latestLesson(db, id);
    // Only a style that is still exactly what it was: forgotten or off-branch ones were set to stale and stay that way.
    if (old && old.state === "retired" && old.spec && old.text) db.prepare("UPDATE memory_lessons SET state='active',decided_at=? WHERE id=? AND version=?").run(now, old.id, old.version);
  }
}
function resupersede(db: DatabaseSync, ids: unknown, now: number): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids.map(String)) {
    const old = latestLesson(db, id);
    if (old && old.state === "active" && old.spec) db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, old.id, old.version);
  }
}

export function addLesson(db: DatabaseSync, input: AddLessonInput): AddLessonResult {
  const now = input.now ?? Date.now();
  const typed = input.origin === "typed";
  if (!typed && !input.learning.enabled) return { status: "refused", reason: "learning-off" };
  // A style lesson is a typed value; a typed-by-the-owner lesson is always a note.
  let spec: StyleSpec | null = null, where: Where | null = null;
  if (!typed && input.spec !== undefined && input.spec !== null) {
    spec = parseStyleSpec(input.spec);
    if (!spec) return { status: "refused", reason: "invalid-spec" };
    where = spec.kind === "term" ? "with-me" : parseWhere(input.where) ?? "everywhere";
  }
  let text: string, mustSuggest = false, admittedProspect = false;
  if (spec) text = renderStyleLine(spec, where!)!;
  else {
    // B4's gate first: it redacts, and refuses prospect wording the bot may not learn from.
    const admission = admitter({ id: input.botId, learning: input.learning }, String(input.text ?? ""), input.prospectTexts ?? []);
    if (!admission.ok) return { status: "refused", reason: admission.reason };
    const checked = checkLessonText(admission.text);
    if (!checked.ok) return { status: "refused", reason: checked.reason };
    text = checked.text; mustSuggest = admission.mustSuggest; admittedProspect = admission.prospectDerived;
  }
  const prospectDerived = admittedProspect || input.prospectDerived === true;
  // Prospect-derived text never reaches messages.db: it goes to learning-local/ or nowhere.
  if (prospectDerived && !localSink) return { status: "refused", reason: "learning-local-unavailable" };
  const scope: "thread" | "owner" | "bot" = spec ? "bot" : input.scope === "thread" && input.threadId ? "thread" : input.scope === "bot" && typed ? "bot" : "owner";
  return inTransaction(db, () => {
    const key = normalized(text);
    const same = listLessons(db, input.botId).filter(lesson => spec
      ? lesson.spec !== null && lesson.where !== null && specKey(lesson.spec, lesson.where) === specKey(spec, where!)
      : lesson.kind === "note" && lesson.scope === scope && (scope !== "thread" || (lesson.threadId ?? null) === (input.threadId ?? null)) && normalized(lesson.text) === key);
    const live = same.find(lesson => lesson.state === "active" || lesson.state === "suggested");
    if (live) return { status: "duplicate" as const, lesson: live };
    if (!typed && !input.newEvidence && same.some(lesson => lesson.state === "undone")) return { status: "refused" as const, reason: "undone-before" as const };
    // Active only for a typed note, or a style value the feedback layer vouched for. Everything else waits for one tap.
    const auto = typed || (spec !== null && input.auto === true && !input.learning.askFirst && !prospectDerived && !mustSuggest);
    const base = {
      id: randomUUID(), botId: input.botId, scope, parentId: null, recipients: null, kind: (spec ? "style" : "note") as LessonKind, text, spec, where, origin: input.origin, evidence: normalizeEvidence(input.evidence), prospectDerived, createdAt: now,
      threadId: input.threadId ?? null, sourceMessageId: input.sourceMessageId ?? null, targetMessageId: input.targetMessageId ?? input.chip?.replyMessageId ?? null,
    };
    if (!auto) {
      const lesson: Lesson = { ...base, version: 1, state: "suggested", learningEventId: null, decidedAt: null };
      if (prospectDerived) localSink!(lesson); else insertLesson(db, lesson);
      return { status: "suggested" as const, lesson };
    }
    const superseded = supersedeStyle(db, base, now);
    const eventId = learnedEvent(db, base, now, input.chip, superseded.length ? { supersedes: superseded } : {});
    const lesson: Lesson = { ...base, version: 1, state: "active", learningEventId: eventId, decidedAt: now };
    insertLesson(db, lesson);
    return { status: "applied" as const, lesson };
  });
}

/** Where a kept suggestion will apply, so the confirmation says it truthfully: this conversation, the owner's chats, customers, or everywhere. */
function keepScopeOf(lesson: Pick<Lesson, "scope" | "kind" | "where">): NonNullable<import("../../shared/learned-chip.ts").ChipItem["keepScope"]> {
  if (lesson.scope === "thread") return "thread";
  if (lesson.kind === "style") return lesson.where === "with-me" ? "owner" : lesson.where === "with-others" ? "customers" : "everywhere";
  return "owner";
}

/** The suggestion is about approvals or permissions: it is never kept as a lesson, because no lesson can change either. */
export const aboutApprovals = (lesson: Pick<Lesson, "evidence">): boolean => Boolean(lesson.evidence) && !Array.isArray(lesson.evidence) && (lesson.evidence as { aboutApprovals?: unknown }).aboutApprovals === true;

/** A suggestion the owner accepted (the chip's "Keep it", or Learning > Waiting for you). */
export function applySuggestedLesson(db: DatabaseSync, input: { botId: string; lessonId: string; now?: number }): Lesson {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const lesson = latestLesson(db, input.lessonId);
    if (!lesson || lesson.botId !== input.botId) throw httpError("There is no such lesson.", 404);
    if (lesson.state !== "suggested") throw httpError("This lesson is not waiting for a decision.", 409);
    if (lesson.scope === "bots" || lesson.scope === "team") throw httpError("Choose which bots get this lesson, then apply it.", 409);
    if (aboutApprovals(lesson)) throw httpError("Approvals follow your Access settings. Change them in Access.", 409);
    const superseded = supersedeStyle(db, lesson, now);
    const eventId = learnedEvent(db, lesson, now, undefined, superseded.length ? { supersedes: superseded } : {});
    db.prepare("UPDATE memory_lessons SET state='active',learning_event_id=?,decided_at=? WHERE id=? AND version=?").run(eventId, now, lesson.id, lesson.version);
    return { ...lesson, state: "active" as const, learningEventId: eventId, decidedAt: now };
  });
}

/** "Not now": the suggestion goes away and nothing is learned. Retired, so the same words can come back
 * only with new evidence (addLesson's duplicate and undone-before rules decide that). */
export function declineSuggestedLesson(db: DatabaseSync, input: { botId: string; lessonId: string; now?: number }): Lesson {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const lesson = latestLesson(db, input.lessonId);
    if (!lesson || lesson.botId !== input.botId) throw httpError("There is no such lesson.", 404);
    if (lesson.state !== "suggested") throw httpError("This lesson is not waiting for a decision.", 409);
    db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
    return { ...lesson, state: "retired" as const, decidedAt: now };
  });
}

/** Settings > Learning, "Use in every conversation": a kept note that was scoped to one conversation or to the owner's chats now
 * reaches every conversation this bot has. Only the owner does this, and only to a note. */
export function widenLessonScope(db: DatabaseSync, input: { botId: string; lessonId: string; now?: number }): Lesson {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const lesson = latestLesson(db, input.lessonId);
    if (!lesson || lesson.botId !== input.botId) throw httpError("There is no such lesson.", 404);
    if (lesson.kind !== "note" || lesson.state !== "active" || lesson.prospectDerived || (lesson.scope !== "thread" && lesson.scope !== "owner")) throw httpError("This note cannot be used in every conversation.", 409);
    db.prepare("UPDATE memory_lessons SET scope='bot',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
    const original = db.prepare("SELECT scope_id FROM memory_learning_events WHERE id=?").get(lesson.learningEventId);
    recordLearningEvent(db, { kind: "lesson-edited", scopeId: String(original?.scope_id ?? ensureBotScope(db, lesson.botId)), botId: lesson.botId, detail: { lessonId: lesson.id, lessonVersion: lesson.version, lessonEventId: lesson.learningEventId, widened: true }, now });
    return { ...lesson, scope: "bot", decidedAt: now };
  });
}

// ── editing ───────────────────────────────────────────────────────────────
export function editLesson(db: DatabaseSync, input: { botId: string; lessonId: string; text: string; now?: number }): Lesson {
  const now = input.now ?? Date.now();
  const checked = checkLessonText(input.text);
  if (!checked.ok) throw httpError(checked.reason === "empty" ? "Write what it should do." : `Keep it under ${LESSON_MAX_CHARS} characters.`, 400);
  return inTransaction(db, () => {
    const current = latestLesson(db, input.lessonId);
    if (!current || current.botId !== input.botId) throw httpError("There is no such lesson.", 404);
    if (current.state !== "active" && current.state !== "suggested") throw httpError("This lesson is not in use, so it cannot be edited.", 409);
    if (current.kind === "style") throw httpError("A style is changed by saying the new one. Undo this one if it is not right.", 409);
    const next: Lesson = { ...current, version: current.version + 1, text: checked.text, decidedAt: now };
    db.prepare("UPDATE memory_lessons SET state='retired',decided_at=? WHERE id=? AND version=?").run(now, current.id, current.version);
    insertLesson(db, next);
    if (current.state === "active") {
      const original = db.prepare("SELECT scope_id FROM memory_learning_events WHERE id=?").get(current.learningEventId);
      recordLearningEvent(db, { kind: "lesson-edited", scopeId: String(original?.scope_id ?? ensureBotScope(db, current.botId)), botId: current.botId, detail: { lessonId: current.id, lessonVersion: next.version, lessonEventId: current.learningEventId }, now });
    }
    return next;
  });
}

// ── undo and keep (called from changeLearningEvent) ───────────────────────
let keptUndoHook: ((moment: { botId: string; eventId: string; exemplarKey: string; variant: "praise" | "win" }) => void) | null = null;
/** B1, B2 and B6 register what really removes a stored exemplar or outcome mark.
 * Without it a praise or win chip cannot honestly say "Undone", so it refuses. */
export function setKeptMomentUndoHook(hook: typeof keptUndoHook): void { keptUndoHook = hook; }

export const LESSON_EVENT_KINDS = ["lesson-learned", "lesson-edited"] as const;
const KEPT_EVENT_KINDS = ["feedback-detected", "outcome-marked"] as const;
export const isLessonEvent = (kind: unknown): boolean => (LESSON_EVENT_KINDS as readonly string[]).includes(String(kind));
export const isKeptMomentEvent = (event: Record<string, any>): boolean => (KEPT_EVENT_KINDS as readonly string[]).includes(String(event.kind)) && JSON.parse(String(event.detail ?? "{}")).chip === 1;

/** Caller owns owner authorization; this runs in its own savepoint. */
export function changeLessonEvent(db: DatabaseSync, event: Record<string, any>, action: "undo" | "keep", now: number = Date.now()) {
  return inTransaction(db, () => {
    if (isKeptMomentEvent(event)) return changeKeptMoment(db, event, action, now);
    const detail = JSON.parse(String(event.detail ?? "{}"));
    const lessonId = String(detail.lessonId ?? "");
    const lesson = latestLesson(db, lessonId);
    const eventId = String(lesson?.learningEventId ?? event.id);
    const original = db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(eventId);
    if (!lesson || !original) throw httpError("This learning item cannot be changed.", 409);
    if (action === "undo") {
      if (lesson.state === "undone") return { ok: true, eventId, undone: true };
      if (lesson.state !== "active") throw httpError("This learning item cannot be changed.", 409);
      db.prepare("UPDATE memory_lessons SET state='undone',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
      db.prepare("UPDATE memory_learning_events SET undone_at=?,kept_at=NULL WHERE id=?").run(now, eventId);
      recordLearningEvent(db, { kind: "lesson-undone", scopeId: String(original.scope_id), botId: lesson.botId, detail: { lessonId: lesson.id, lessonEventId: eventId }, now });
      cascadeLineageUndo(db, lesson.id, now);
      restoreSuperseded(db, JSON.parse(String(original.detail ?? "{}")).supersedes, now);
      return { ok: true, eventId, undone: true };
    }
    if (lesson.state === "undone") {
      const undoneAt = Number(original.undone_at ?? 0);
      if (now - undoneAt > KEEP_WINDOW_MS) throw httpError("This lesson can no longer be restored. Add it again if you still want it.", 409);
      db.prepare("UPDATE memory_lessons SET state='active',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
      db.prepare("UPDATE memory_learning_events SET undone_at=NULL WHERE id=?").run(eventId);
      recordLearningEvent(db, { kind: "owner-keep", scopeId: String(original.scope_id), botId: lesson.botId, detail: { lessonId: lesson.id, lessonEventId: eventId, restored: true }, now });
      cascadeLineageRestore(db, lesson.id, undoneAt, now);
      resupersede(db, JSON.parse(String(original.detail ?? "{}")).supersedes, now);
      return { ok: true, eventId, kept: true };
    }
    if (lesson.state !== "active") throw httpError("This learning item cannot be changed.", 409);
    if (original.kept_at === null) db.prepare("UPDATE memory_learning_events SET kept_at=? WHERE id=?").run(now, eventId);
    return { ok: true, eventId, kept: true };
  });
}

function changeKeptMoment(db: DatabaseSync, event: Record<string, any>, action: "undo" | "keep", now: number) {
  const detail = JSON.parse(String(event.detail ?? "{}"));
  if (action === "keep") {
    if (event.kept_at === null && event.undone_at === null) db.prepare("UPDATE memory_learning_events SET kept_at=? WHERE id=?").run(now, event.id);
    else if (event.undone_at !== null) throw httpError("This learning item cannot be changed.", 409);
    return { ok: true, eventId: String(event.id), kept: true };
  }
  if (event.undone_at !== null) return { ok: true, eventId: String(event.id), undone: true };
  if (!keptUndoHook) throw httpError("This learning item cannot be changed.", 409);
  keptUndoHook({ botId: String(event.bot_id), eventId: String(event.id), exemplarKey: String(detail.exemplarKey ?? ""), variant: detail.variant === "win" ? "win" : "praise" });
  db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(now, event.id);
  recordLearningEvent(db, { kind: "owner-undo", scopeId: String(event.scope_id), botId: event.bot_id === null ? null : String(event.bot_id), detail: { momentEventId: event.id }, now });
  return { ok: true, eventId: String(event.id), undone: true };
}

/** What the history list adds to a lesson event: the lesson itself. */
export function lessonForEvent(db: DatabaseSync, event: Record<string, any>) {
  if (!isLessonEvent(event.kind)) return null;
  const lessonId = String(JSON.parse(String(event.detail ?? "{}")).lessonId ?? "");
  const lesson = latestLesson(db, lessonId);
  return lesson ? { id: lesson.id, version: lesson.version, text: lesson.text, kind: lesson.kind, state: lesson.state, origin: lesson.origin } : null;
}

// ── the learned block ─────────────────────────────────────────────────────
export type TurnsSince = (botId: string, sinceMs: number, threadId?: string) => number;
/** Bot turns since a moment, from the captured sources (one per final bot reply). */
export const turnsSinceFromSources = (db: DatabaseSync): TurnsSince => (botId, sinceMs, threadId) => {
  // A direct-chat reply is captured as speaker "assistant" (capture.ts); only room replies carry the bot id.
  // Without a thread, "assistant" counts only in threads this bot has learning rows in.
  const base = `FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id WHERE s.kind='text' AND v.revision=1 AND v.created_at>?`;
  if (threadId) return Number(db.prepare(`SELECT COUNT(*) c ${base} AND s.speaker IN (?,'assistant') AND s.thread_id=?`).get(sinceMs, botId, threadId)?.c ?? 0);
  return Number(db.prepare(`SELECT COUNT(*) c ${base} AND (s.speaker=? OR (s.speaker='assistant' AND s.thread_id IN (
    SELECT thread_id FROM memory_feedback WHERE bot_id=? UNION SELECT json_extract(detail,'$.threadId') FROM memory_learning_events WHERE bot_id=?)))`).get(sinceMs, botId, botId, botId)?.c ?? 0);
};

const inline = (text: string) => text.replace(/<\/?what-it-learned>/gi, " ").replace(/\s+/g, " ").trim();

// ── lessons that reach a bot from elsewhere (B11, design 14) ──────────────
/** Copies shared to this bot, and team lessons that name it. Active only. */
export function sharedLessonsFor(db: DatabaseSync, botId: string): { inherited: Lesson[]; team: Lesson[] } {
  const inherited = listLessons(db, botId, { states: ["active"] }).filter(lesson => lesson.scope === "bot" && lesson.parentId !== null);
  const rows = db.prepare(`SELECT * FROM memory_lessons WHERE scope='team' AND state='active' AND ${LATEST} ORDER BY created_at,rowid`).all() as Record<string, any>[];
  const team = rows.map(lessonOf).filter(lesson => lesson.botId !== botId && lesson.recipients?.includes(botId));
  return { inherited, team };
}

export interface LessonConflict { winner: Lesson; other: Lesson; via: "shared" | "team"; fromBotId: string }
/** Precedence: a bot's own lesson beats one it inherited, and the pair is reported so the Learning screen can show it. */
export function lessonConflicts(db: DatabaseSync, botId: string): LessonConflict[] {
  const own = listLessons(db, botId, { states: ["active"] }).filter(lesson => (lesson.scope === "bot" || lesson.scope === "owner") && lesson.parentId === null);
  const { inherited, team } = sharedLessonsFor(db, botId);
  const out: LessonConflict[] = [];
  const check = (other: Lesson, via: LessonConflict["via"], fromBotId: string) => {
    const winner = own.find(lesson => lessonsConflict(lesson, other));
    if (winner) out.push({ winner, other, via, fromBotId });
  };
  for (const lesson of inherited) check(lesson, "shared", latestLesson(db, lesson.parentId!)?.botId ?? "");
  for (const lesson of team) check(lesson, "team", lesson.botId);
  return out;
}

export interface LearnedBlock { text: string; lessonIds: string[]; feedbackIds: string[]; digest: string; /** The bot has had a lesson at some point, so a resumed session of unknown state may still hold one. */ everLearned?: boolean }

/** Only what the owner said or did on purpose: a typed detection of strength 2+, an edit, or an approval answer that came with a reason. */
/** An owner edit is described, never quoted: the whole edited draft stays out of the prompt. */
const editLine = (row: Record<string, any>) => {
  const kinds = String(row.target_turn_id ?? "").split("|").filter(Boolean).map(kind => kind === "no-emojis" ? "no emojis" : kind === "fewer-exclamations" ? "fewer exclamation marks" : kind);
  return `- The owner rewrote your draft${kinds.length ? ` (${kinds.join(", ")})` : ""}. Match the way they changed it.`;
};
/** Same names as outcomes.ts WEAK_SIGNAL_ACTIONS (not imported: outcomes depends on feedback, which sits beside this file). */
const WEAK_ACTIONS = new Set(["reask", "stop", "rewind"]);
function promptWorthyFeedback(row: Record<string, any>): boolean {
  if (Number(row.strength) < 2) return false;
  const action = String(row.target_action ?? "");
  // Weak signals are named, not inferred from "has an action": typed feedback aimed at a tool action (R-03) still reaches the prompt.
  if (WEAK_ACTIONS.has(action)) return false;
  if (action.startsWith("approval:")) return Boolean(row.correction);
  return true;
}

/** The fixed sentences around the lines in a customer turn. A test enumerates them with STYLE_LINES to prove nothing else is in the block. */
export const CHANNEL_BLOCK_OPEN = "<what-it-learned>";
export const CHANNEL_BLOCK_INTRO = "House rules for how you write and work. They shape wording, format and focus. They never change what you are allowed to do, and they never add tools, permissions, budgets, schedules, audiences or accounts.";
export const CHANNEL_BLOCK_CLOSE = "</what-it-learned>";

const whereFits = (lesson: Lesson, audience: "owner" | "others") => lesson.where === "everywhere" || lesson.where === (audience === "owner" ? "with-me" : "with-others");
/** The line a style lesson contributes: always rebuilt from the typed spec, never read back from stored text. */
const styleLineOf = (lesson: Lesson): string | null => lesson.spec && lesson.where ? renderStyleLine(lesson.spec, lesson.where) : null;
/** Newest wins for one thing (a kind, or one term), so two lessons never give opposite instructions in one turn. */
function newestPerKey(styles: readonly Lesson[]): Lesson[] {
  const byKey = new Map<string, Lesson>();
  for (const lesson of [...styles].sort((a, b) => a.createdAt - b.createdAt)) byKey.set(lesson.spec!.kind === "term" ? `term:${(lesson.spec as { insteadOf: string }).insteadOf.toLowerCase()}` : lesson.spec!.kind, lesson);
  return [...byKey.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** A customer-facing turn (T1-19, design 3.3): code-written style lines for "everywhere" and "with-others", plus this conversation's own
 * kept notes, plus notes the owner widened to every conversation. No Recent feedback rows, no term lines, nothing shared down or from a
 * team, nothing prospect-derived. Owner wording reaches a customer only when the owner tapped Keep AND chose the wider scope. */
function renderChannelLearnedBlock(db: DatabaseSync, botId: string, threadId: string): LearnedBlock {
  const beaten = new Set(lessonConflicts(db, botId).map(conflict => conflict.other.id));
  const own = listLessons(db, botId, { states: ["active"] }).filter(lesson => lesson.parentId === null && !lesson.prospectDerived && !beaten.has(lesson.id));
  const styles = newestPerKey(own.filter(lesson => lesson.kind === "style" && lesson.scope === "bot" && lesson.spec !== null && lesson.spec.kind !== "term" && whereFits(lesson, "others") && styleLineOf(lesson) !== null));
  const notes = own.filter(lesson => lesson.kind === "note" && ((lesson.scope === "thread" && lesson.threadId === threadId) || lesson.scope === "bot")).sort((a, b) => b.createdAt - a.createdAt);
  const render = (kept: Lesson[]) => [CHANNEL_BLOCK_OPEN, CHANNEL_BLOCK_INTRO,
    ...kept.map(lesson => `- ${lesson.kind === "style" ? styleLineOf(lesson) : inline(lesson.text)}`), CHANNEL_BLOCK_CLOSE].join("\n");
  // Newest notes first when trimming; the code-written style lines are short and always kept ahead of them.
  let keptNotes = notes.slice(0, Math.max(0, LEARNED_BLOCK_MAX_LESSONS - styles.length));
  let kept = [...styles, ...keptNotes.sort((a, b) => a.createdAt - b.createdAt)];
  if (!kept.length) return { text: "", lessonIds: [], feedbackIds: [], digest: "" };
  let text = render(kept);
  while (text.length > LEARNED_BLOCK_MAX_CHARS && keptNotes.length) { keptNotes = keptNotes.slice(1); kept = [...styles, ...keptNotes]; text = render(kept); }
  while (text.length > LEARNED_BLOCK_MAX_CHARS && kept.length > 1) { kept = kept.slice(0, -1); text = render(kept); }
  return { text, lessonIds: kept.map(lesson => lesson.id), feedbackIds: [], digest: kept.map(lesson => `${lesson.id}:${lesson.version}`).sort().join("|") };
}

export interface RenderLearnedInput {
  botId: string; threadId: string; ownerAudience: boolean; now?: number; turnsSince?: TurnsSince;
  /** Is this message on the conversation's active branch? Recent feedback from an abandoned branch is left out (design 3.6). Absent: every row counts. */
  onPath?: (messageId: string) => boolean;
}
export function renderLearnedBlock(db: DatabaseSync, input: RenderLearnedInput): LearnedBlock {
  const block = renderLearnedBlockInner(db, input);
  return block.text ? block : { ...block, everLearned: Boolean(db.prepare("SELECT 1 FROM memory_lessons WHERE bot_id=? LIMIT 1").get(input.botId)) };
}
function renderLearnedBlockInner(db: DatabaseSync, input: RenderLearnedInput): LearnedBlock {
  const empty: LearnedBlock = { text: "", lessonIds: [], feedbackIds: [], digest: "" };
  if (!input.ownerAudience) return renderChannelLearnedBlock(db, input.botId, input.threadId);
  const beaten = new Set(lessonConflicts(db, input.botId).map(conflict => conflict.other.id));
  const usable = (lesson: Lesson) => !beaten.has(lesson.id) && (lesson.scope === "bot" || lesson.scope === "owner" || (lesson.scope === "thread" && lesson.threadId === input.threadId));
  const active = listLessons(db, input.botId, { states: ["active"] }).filter(usable);
  const team = sharedLessonsFor(db, input.botId).team.filter(lesson => !beaten.has(lesson.id));
  const budget = (list: Lesson[]) => list.sort((a, b) => b.createdAt - a.createdAt).slice(0, LEARNED_BLOCK_MAX_LESSONS);
  let styles = newestPerKey(active.filter(lesson => lesson.kind === "style" && lesson.scope === "bot" && styleLineOf(lesson) !== null && whereFits(lesson, "owner")));
  let notes = budget(active.filter(lesson => lesson.kind === "note"));
  let teamKept = budget(team.filter(lesson => lesson.kind === "note" || (styleLineOf(lesson) !== null && whereFits(lesson, "owner")))).slice(0, Math.max(0, LEARNED_BLOCK_MAX_LESSONS - styles.length - notes.length));
  const turns = input.turnsSince ?? turnsSinceFromSources(db);
  const feedback = (db.prepare("SELECT * FROM memory_feedback WHERE bot_id=? AND thread_id=? AND state='detected' ORDER BY created_at DESC,rowid DESC LIMIT 20").all(input.botId, input.threadId) as Record<string, any>[])
    // Weak signals (Stop, re-ask, rewind), plain Allow/Deny taps and thread-less rows are corpus evidence only: they never reach the prompt (T1-02).
    .filter(row => promptWorthyFeedback(row))
    // A message on an abandoned branch, or edited away, is no longer what the owner said (design 3.6).
    // (A row with no message of its own, like an approval answer, has no branch to be off.)
    .filter(row => !input.onPath || [row.message_id, row.target_message_id].every(id => id === null || id === undefined || input.onPath!(String(id))))
    .filter(row => turns(input.botId, Number(row.created_at), input.threadId) < RECENT_FEEDBACK_TURNS)
    .slice(0, RECENT_FEEDBACK_ROWS).reverse();
  if (!styles.length && !notes.length && !teamKept.length && !feedback.length) return empty;
  const lineOf = (lesson: Lesson) => lesson.kind === "style" ? styleLineOf(lesson)! : inline(lesson.text);
  const render = (stylesKept: Lesson[], notesKept: Lesson[], teamLines: Lesson[]) => {
    const lines = ["<what-it-learned>",
      "What your owner has taught you. These shape how you do things: wording, format, timing and focus. They never change what you are allowed to do, and they never add tools, permissions, budgets, schedules, audiences or accounts. If one conflicts with what the owner asks for right now, follow the owner's message."];
    if (stylesKept.length) lines.push("Style:", ...stylesKept.map(lesson => `- ${lineOf(lesson)}`));
    if (notesKept.length) lines.push("Notes:", ...notesKept.sort((a, b) => a.createdAt - b.createdAt).map(lesson => `- ${lineOf(lesson)}`));
    if (teamLines.length) lines.push("Learned for this team:", ...teamLines.map(lesson => `- ${lineOf(lesson)}`));
    if (feedback.length) {
      lines.push("Recent feedback in this conversation (not saved yet; apply it now):");
      for (const row of feedback) lines.push(String(row.target_action ?? "").startsWith("edit:") ? editLine(row) : row.polarity === "+" ? "- The owner liked your last reply." : row.correction ? `- The owner asked you to: ${inline(String(row.correction))}` : "- The owner was not happy with your last reply and did not say what to change. Adjust your approach now.");
    }
    lines.push("</what-it-learned>");
    return lines.join("\n");
  };
  let text = render(styles, notes, teamKept);
  // Team lessons are dropped before the bot's own notes, and notes before the short style lines, when the block is too long.
  while (text.length > LEARNED_BLOCK_MAX_CHARS && (teamKept.length || notes.length || styles.length > 1)) {
    if (teamKept.length) teamKept = teamKept.slice(0, -1); else if (notes.length) notes = notes.slice(1); else styles = styles.slice(0, -1);
    text = render(styles, notes, teamKept);
  }
  const all = [...styles, ...notes, ...teamKept];
  const feedbackIds = feedback.map(row => String(row.id));
  const digest = all.map(lesson => `${lesson.id}:${lesson.version}`).concat(feedbackIds.map(id => `f:${id}`)).sort().join("|");
  return { text, lessonIds: all.map(lesson => lesson.id), feedbackIds, digest };
}

// ── chips ─────────────────────────────────────────────────────────────────
const KEPT_KINDS_SQL = "'feedback-detected','outcome-marked'";

/** The chip items under this thread's replies, from stored events only. An
 * undone item stays for the Keep window and then drops out. */
export function chipItemsForThread(db: DatabaseSync, input: { botId: string; threadId: string; now?: number }): ChipItem[] {
  const now = input.now ?? Date.now();
  const rows = db.prepare(`SELECT * FROM memory_learning_events WHERE bot_id=? AND json_extract(detail,'$.threadId')=? AND json_extract(detail,'$.replyMessageId') IS NOT NULL
    AND ((kind='lesson-learned') OR (kind IN (${KEPT_KINDS_SQL},'activated') AND json_extract(detail,'$.chip')=1))
    AND (undone_at IS NULL OR (undone_at>=? AND kind='lesson-learned')) ORDER BY created_at DESC,rowid DESC LIMIT 200`).all(input.botId, input.threadId, now - KEEP_WINDOW_MS) as Record<string, any>[];
  const firstEvent = db.prepare(`SELECT id FROM memory_learning_events WHERE bot_id=? AND kind='lesson-learned' AND json_extract(detail,'$.replyMessageId') IS NOT NULL ORDER BY created_at,rowid LIMIT 1`).get(input.botId)?.id;
  const items: ChipItem[] = [];
  for (const event of rows.reverse()) {
    const detail = JSON.parse(String(event.detail));
    if (event.kind === "lesson-learned") {
      const lesson = latestLesson(db, String(detail.lessonId));
      if (!lesson || (lesson.state !== "active" && lesson.state !== "undone")) continue;
      items.push({ eventId: String(event.id), kind: "lesson", group: "lesson", template: Number(detail.template), text: lesson.text, state: lesson.state === "undone" ? "undone" : "active",
        undoneAt: event.undone_at === null ? null : Number(event.undone_at), replyMessageId: String(detail.replyMessageId), first: event.id === firstEvent, lessonId: lesson.id, lessonVersion: lesson.version,
        // A style is code-written: it is changed by saying the new one, so Edit and Not quite are for notes only.
        actions: { edit: lesson.kind !== "style", undo: true, forget: false, notQuite: lesson.kind !== "style", notExample: false, restorable: true } });
    } else if (event.kind === "activated") {
      // A memory the worker stored. Forget is the existing undo while the entry is as it was learned;
      // after the owner edits it (a new version), Forget archives the current version. Edit is the Memory view's own correct.
      const record = db.prepare("SELECT id,version,text,state FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(String(event.record_id));
      if (!record || record.state !== "active") continue;
      items.push({ eventId: String(event.id), kind: "remembered", group: "remembered", template: Number(detail.template), text: String(record.text), state: "active", undoneAt: null,
        replyMessageId: String(detail.replyMessageId), recordId: String(record.id), recordVersion: Number(record.version), edited: Number(record.version) !== Number(event.record_version),
        actions: { edit: true, undo: false, forget: true, notQuite: false, notExample: false, restorable: false } });
    } else {
      items.push({ eventId: String(event.id), kind: "kept", group: detail.variant === "win" ? "win" : "praise", template: Number(detail.template), text: String(detail.label ?? ""), state: "active", undoneAt: null,
        replyMessageId: String(detail.replyMessageId), actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: true, restorable: false } });
    }
  }
  // A suggestion waits under the reply it came from for a while, then only under Settings > Learning > Waiting for you.
  // Its stored row is what the chip stands for (the honesty rule), so the lesson id is the item id.
  for (const lesson of listLessons(db, input.botId, { states: ["suggested"] })) {
    if (lesson.threadId !== input.threadId || !lesson.targetMessageId || (lesson.scope !== "thread" && lesson.scope !== "owner" && lesson.scope !== "bot")) continue;
    if (now - lesson.createdAt > SUGGESTION_CHIP_WINDOW_MS) continue;
    items.push({ eventId: lesson.id, kind: "lesson", group: "lesson", template: 1, text: lesson.text, state: "suggested", undoneAt: null, replyMessageId: lesson.targetMessageId,
      lessonId: lesson.id, lessonVersion: lesson.version, keepScope: keepScopeOf(lesson), ...(aboutApprovals(lesson) ? { aboutApprovals: true } : {}),
      actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: false, restorable: false, keepIt: !aboutApprovals(lesson) } });
  }
  return items;
}

/** The branch changed (a different leaf, or an edit forked the conversation). What was learned from words that are no longer on the
 * visible branch is set aside: pending feedback rows expire, waiting suggestions go stale, and a style lesson still in its chip
 * window that the owner has not kept is withdrawn. No clock decides which messages count; only branch membership does (design 3.6). */
export function sweepOffPathLearning(db: DatabaseSync, input: { threadId: string; onPath: (messageId: string) => boolean; now?: number }): { feedback: number; lessons: number } {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    let feedback = 0, lessons = 0;
    const offPath = (row: Record<string, any>) => (row.message_id !== null && !input.onPath(String(row.message_id))) || (row.target_message_id !== null && !input.onPath(String(row.target_message_id)));
    const rows = db.prepare("SELECT id,message_id,target_message_id FROM memory_feedback WHERE thread_id=? AND state IN ('detected','unsure')").all(input.threadId) as Array<Record<string, any>>;
    for (const row of rows) {
      if (!offPath(row)) continue;
      db.prepare("UPDATE memory_feedback SET state='expired',correction=NULL WHERE id=?").run(String(row.id));
      feedback++;
    }
    // A style formed from repeated owner edits rests on every one of them, not only the edit that triggered it (that one is its
    // source message, checked below). When an earlier edit leaves the branch, recount the edits still standing: fewer than two
    // and a fresh, unkept style is withdrawn, wherever the lesson itself was formed.
    const edits = db.prepare("SELECT bot_id,message_id,target_message_id FROM memory_feedback WHERE thread_id=? AND target_action LIKE 'edit:%'").all(input.threadId) as Array<Record<string, any>>;
    const editBots = new Set(edits.filter(offPath).map(row => String(row.bot_id)));
    for (const botId of editBots) for (const lesson of listLessons(db, botId, { states: ["active"] })) {
      const editKind = lesson.origin === "edit" && lesson.evidence && !Array.isArray(lesson.evidence) ? (lesson.evidence as { editKind?: unknown }).editKind : undefined;
      if (typeof editKind !== "string") continue;
      const standing = (db.prepare("SELECT thread_id,message_id,target_message_id FROM memory_feedback WHERE bot_id=? AND target_action LIKE 'edit:%' AND target_turn_id LIKE ? AND state NOT IN ('ignored','expired') AND created_at<=?")
        .all(botId, `%|${editKind}|%`, lesson.createdAt) as Array<Record<string, any>>).filter(row => row.thread_id !== input.threadId || !offPath(row));
      if (standing.length < 2 && withdrawFreshLesson(db, lesson, now)) lessons++;
    }
    const botIds = (db.prepare("SELECT DISTINCT bot_id FROM memory_lessons WHERE thread_id=?").all(input.threadId) as Array<Record<string, any>>).map(row => String(row.bot_id));
    for (const botId of botIds) for (const lesson of listLessons(db, botId, { states: ["retired", "suggested", "active"] }).sort((a, b) => (a.state === "retired" ? 0 : 1) - (b.state === "retired" ? 0 : 1))) {
      if (lesson.threadId !== input.threadId || lesson.origin !== "feedback" && lesson.origin !== "edit") continue;
      const off = (lesson.sourceMessageId !== null && !input.onPath(lesson.sourceMessageId)) || (lesson.targetMessageId !== null && !input.onPath(lesson.targetMessageId));
      if (!off) continue;
      // A style that was replaced and is waiting to come back on Undo must not come back from words that left the branch.
      if (lesson.state === "retired") {
        if (lesson.spec) { db.prepare("UPDATE memory_lessons SET state='stale',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version); lessons++; }
        continue;
      }
      if (lesson.state === "suggested") {
        db.prepare("UPDATE memory_lessons SET state='stale',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
        lessons++;
        continue;
      }
      if (withdrawFreshLesson(db, lesson, now)) lessons++;
    }
    return { feedback, lessons };
  });
}
/** An active lesson still in its chip window that the owner has neither kept nor undone is set aside, and the style it replaced comes back. */
function withdrawFreshLesson(db: DatabaseSync, lesson: Lesson, now: number): boolean {
  const event = lesson.learningEventId ? db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(lesson.learningEventId) : undefined;
  if (lesson.state !== "active" || !event || event.kept_at !== null || event.undone_at !== null || now - Number(lesson.decidedAt ?? lesson.createdAt) > SUGGESTION_CHIP_WINDOW_MS) return false;
  db.prepare("UPDATE memory_lessons SET state='stale',decided_at=? WHERE id=? AND version=?").run(now, lesson.id, lesson.version);
  db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(now, String(event.id));
  restoreSuperseded(db, JSON.parse(String(event.detail ?? "{}")).supersedes, now);
  return true;
}

export interface KeptMomentInput { botId: string; threadId: string; replyMessageId: string; label: string; variant: "praise" | "win"; exemplarKey: string; now?: number }
export type KeptMomentResult = { shown: true; eventId: string } | { shown: false; reason: "rate-limited" | "same-exemplar" | "empty" };

/** Call after the exemplar or the won/good outcome is really stored (B1, B2,
 * B6). Records the chip's ledger row, subject to the rates in design 12a: at
 * most one praise or win chip per 10 turns per bot, never twice for the same
 * exemplar. A suppressed moment writes nothing. */
export function recordKeptMoment(db: DatabaseSync, input: KeptMomentInput, options: { turnsSince?: TurnsSince } = {}): KeptMomentResult {
  const now = input.now ?? Date.now();
  const label = chipClause(input.label);
  if (!label || !input.exemplarKey) return { shown: false, reason: "empty" };
  const turns = options.turnsSince ?? turnsSinceFromSources(db);
  return inTransaction(db, () => {
    if (db.prepare(`SELECT 1 FROM memory_learning_events WHERE bot_id=? AND kind IN (${KEPT_KINDS_SQL}) AND json_extract(detail,'$.chip')=1 AND json_extract(detail,'$.exemplarKey')=? LIMIT 1`).get(input.botId, input.exemplarKey)) return { shown: false as const, reason: "same-exemplar" as const };
    const last = db.prepare(`SELECT created_at FROM memory_learning_events WHERE bot_id=? AND kind IN (${KEPT_KINDS_SQL}) AND json_extract(detail,'$.chip')=1 ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(input.botId);
    if (last && turns(input.botId, Number(last.created_at)) < KEPT_CHIP_TURNS) return { shown: false as const, reason: "rate-limited" as const };
    const group = groupOf("kept", input.variant);
    const eventId = recordLearningEvent(db, {
      kind: input.variant === "win" ? "outcome-marked" : "feedback-detected", scopeId: ensureBotScope(db, input.botId), botId: input.botId, now,
      detail: { chip: 1, variant: input.variant, group, template: pickTemplate(group, previousTemplate(db, input.botId, group), seedFor(db, input.botId, now)), label, exemplarKey: input.exemplarKey, threadId: input.threadId, replyMessageId: input.replyMessageId },
    });
    return { shown: true as const, eventId };
  });
}

// ── the B2 trigger, behind an interface ───────────────────────────────────
/** What feedback detection (B2) hands over when a message looks like feedback. */
export interface FormLessonFromFeedbackInput {
  /** Defaults to the installation's database. */
  db?: DatabaseSync;
  botId: string; threadId: string; replyMessageId: string;
  polarity: "+" | "-"; strength: 1 | 2 | 3; correction: string | null; confidence: number;
  learning: BotLearning; now?: number;
}
export type FormLessonFromFeedbackResult =
  | { status: "formed"; lesson: Lesson }
  | { status: "suggested"; lesson: Lesson }
  | { status: "none"; reason: string }
  | { status: "unavailable" };
export type FeedbackLessonFormer = (input: FormLessonFromFeedbackInput) => FormLessonFromFeedbackResult;

const unavailable: FeedbackLessonFormer = () => ({ status: "unavailable" });
let former: FeedbackLessonFormer = unavailable;
/** B2 plugs its formation rules in here; null puts the stub back. */
export function setFeedbackLessonFormer(next: FeedbackLessonFormer | null): void { former = next ?? unavailable; }
/** The one entry point B2 calls. The stub forms nothing and stores nothing. */
export function formLessonFromFeedback(input: FormLessonFromFeedbackInput): FormLessonFromFeedbackResult { return former(input); }
