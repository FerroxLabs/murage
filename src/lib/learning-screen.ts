// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Learning screen's side of the harness (design section 16): one typed
// client over the bot learning routes, and the small decisions the screen
// makes (which lessons show, what the Results line says, what Forget does).
// Everything here is plain functions over an injected request, so the screen
// reads only what the harness stored and a test can watch every call.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { KEEP_WINDOW_MS } from "../../shared/learned-chip";
import type { LearningEvent, LearningPage, MemoryLearning } from "./memory-learning";
import { requestLearningAction } from "./memory-learning";

export type Request = (path: string, init?: RequestInit) => Promise<any>;

export { KEEP_WINDOW_MS };
/** Fewer marked outcomes than this and "Check for improvements" has nothing to look at. */
export const MIN_OUTCOMES_FOR_CHECK = 3;
export const LESSON_MAX = 280;
export const MEMORY_MAX = 1000;
export const LESSONS_SHOWN = 5;
export const MEMORIES_SHOWN = 3;
export const CHANGES_SHOWN = 10;
export const HISTORY_LIMIT = 50;

const key = (name: string) => `learningScreen.${name}` as LocaleKey;
export const screenText = (name: string, params?: Record<string, string | number>) => t(key(name), params);

// ── shapes the harness answers with ──────────────────────────────────────
export interface LearningSettingsState { enabled: boolean; askFirst: boolean; prospectLearning: boolean; prospectThreadIds: string[] }
export interface LearningState { settings: LearningSettingsState; revision: number; readiness: { ready: boolean; outcomes: number; examples: number } }
export type LessonOrigin = "feedback" | "edit" | "mark" | "typed" | "suggested";
export interface Lesson { id: string; version: number; kind: string; text: string; origin: LessonOrigin; state: "active" | "undone" | "suggested" | "unsupported" | "stale"; createdAt: number; learningEventId: string;
  /** Teams (B11): where a lesson that another bot taught came from, and a clash with the bot's own lesson. */
  scope?: "thread" | "owner" | "bot" | "bots" | "team"; sharedFrom?: { id: string; name: string } | null; conflict?: { role: "wins" | "loses"; text: string; fromName: string } | null }
export interface LessonList { lessons: Lesson[]; revision: number }
/** A suggestion to share a lesson (B11): the bots it names, and who learned it. Absent or "bot" = an ordinary lesson. */
interface ShareFields { scope?: "thread" | "owner" | "bot" | "bots" | "team"; recipients?: Array<{ id: string; name: string }>; fromName?: string }
export interface LessonSuggestion extends ShareFields { id: string; version: number; kind: "lesson"; /** The suggestion is about approvals: it points to Permissions instead of offering Apply. */ aboutApprovals?: boolean; /** "style" is code-written and cannot be edited; "note" is the owner's own words. */ lessonKind?: "style" | "note"; text: string; origin: LessonOrigin; prospectDerived: boolean; createdAt: number }
/** A change to a skill or a routine that waits for the owner's yes (B7c). */
export interface ProcedureSuggestion extends ShareFields {
  id: string; version: number; kind: "procedure"; targetKind: "skill" | "routine"; label: string; text: string; summary: string;
  reasons: Array<"ask-first" | "outbound" | "prospect-derived">; origin: LessonOrigin; prospectDerived: boolean; edited: boolean; proposedHash: string; createdAt: number;
}
export type Suggestion = LessonSuggestion | ProcedureSuggestion;
/** A skill can be long; its words are not held to a lesson's 280 characters. */
export const PROCEDURE_EDIT_MAX = 20000;
export const suggestionEditMax = (s: Pick<Suggestion, "kind">) => s.kind === "procedure" ? PROCEDURE_EDIT_MAX : LESSON_MAX;
/** The sentence a suggestion card opens with. */
export const suggestionLine = (s: Suggestion): string => s.kind === "procedure"
  ? screenText(s.targetKind === "routine" ? "procedure.routine" : "procedure.skill", { name: s.label, change: s.summary })
  : s.text;
export interface FeedbackRow { id: string; text: string; threadId: string; createdAt: number; revision: number }
export interface OutcomeCounts { won: number; lost: number; good: number; bad: number; proposed: number }
export interface MemoryStatusView { mode: string; learning?: MemoryLearning }

// ── requests ─────────────────────────────────────────────────────────────
export const newKey = () => `ls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const base = (botId: string) => `/api/bots/${encodeURIComponent(botId)}`;
const mutate = (request: Request, method: string, path: string, body: unknown) =>
  request(path, { method, headers: { "Idempotency-Key": newKey() }, body: JSON.stringify(body) });

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

export function readLearningState(answer: any): LearningState {
  const s = answer?.settings ?? {};
  return {
    settings: { enabled: s.enabled !== false, askFirst: s.askFirst === true, prospectLearning: s.prospectLearning === true, prospectThreadIds: list<string>(s.prospectThreadIds).filter(id => typeof id === "string") },
    revision: num(answer?.revision),
    readiness: { ready: answer?.readiness?.ready === true, outcomes: num(answer?.readiness?.outcomes), examples: num(answer?.readiness?.examples) },
  };
}

export const fetchLearning = async (request: Request, botId: string) => readLearningState(await request(`${base(botId)}/learning`));
export type SettingsPatch = Partial<Pick<LearningSettingsState, "enabled" | "askFirst" | "prospectLearning" | "prospectThreadIds">>;
/** Toggling a switch sends only that switch: the chat list is never changed by a toggle. */
export const patchLearning = async (request: Request, botId: string, expectedRevision: number, patch: SettingsPatch) =>
  readLearningState(await mutate(request, "PATCH", `${base(botId)}/learning`, { expectedRevision, ...patch }));

export async function fetchLessons(request: Request, botId: string): Promise<LessonList> {
  const answer = await request(`${base(botId)}/lessons`);
  return { lessons: list<Lesson>(answer?.lessons).filter(item => item?.id), revision: num(answer?.revision) };
}
/** `expectedRevision` is the list revision. A refusal (422) carries a plain sentence in the error message. */
export const addLesson = async (request: Request, botId: string, listRevision: number, text: string) =>
  mutate(request, "POST", `${base(botId)}/lessons`, { expectedRevision: listRevision, text });
export const editLesson = (request: Request, botId: string, lesson: Pick<Lesson, "id" | "version">, text: string) =>
  mutate(request, "PATCH", `${base(botId)}/lessons/${encodeURIComponent(lesson.id)}`, { expectedRevision: lesson.version, text });
export const undoLesson = (request: Request, botId: string, lesson: Pick<Lesson, "id" | "version">) =>
  mutate(request, "DELETE", `${base(botId)}/lessons/${encodeURIComponent(lesson.id)}`, { expectedRevision: lesson.version });
/** "Use in every conversation": a kept note reaches every conversation the bot has. Only the owner does this, on a note. */
export const widenLesson = (request: Request, botId: string, lesson: Pick<Lesson, "id" | "version">) =>
  mutate(request, "POST", `${base(botId)}/lessons/${encodeURIComponent(lesson.id)}/widen`, { expectedRevision: lesson.version });
/** A note kept for one conversation or the owner's chats can be widened; a style already applies everywhere it should. */
export const canWiden = (lesson: Pick<Lesson, "kind" | "scope" | "state">): boolean => lesson.kind === "note" && lesson.state === "active" && (lesson.scope === "thread" || lesson.scope === "owner");
/** A style is code-written: it is changed by saying the new one, and Undo puts the old back. */
export const canEditLesson = (lesson: Pick<Lesson, "kind">): boolean => lesson.kind !== "style";
/** Keep: bring an undone lesson back within the window. */
export const keepLesson = (request: Request, lesson: Pick<Lesson, "learningEventId">) =>
  requestLearningAction(request as any, { action: "learning-keep", eventId: lesson.learningEventId });

export async function fetchSuggestions(request: Request, botId: string): Promise<Suggestion[]> {
  return list<Suggestion>((await request(`${base(botId)}/learning/suggestions`))?.suggestions).filter(item => item?.id);
}
const suggestionPath = (botId: string, s: Pick<Suggestion, "id">, verb: string) => `${base(botId)}/learning/suggestions/${encodeURIComponent(s.id)}/${verb}`;
/** `recipients` is the owner's pick on a share suggestion; absent applies it to everyone it names. Apply names the version and, for a skill or routine change, the exact words shown. */
export const applySuggestion = (request: Request, botId: string, s: Pick<Suggestion, "id" | "version"> & { proposedHash?: string }, recipients?: readonly string[]) =>
  mutate(request, "POST", suggestionPath(botId, s, "apply"), { expectedRevision: s.version, ...(s.proposedHash ? { proposedHash: s.proposedHash } : {}), ...(recipients ? { recipients } : {}) });
export const editSuggestion = (request: Request, botId: string, s: Pick<Suggestion, "id" | "version">, text: string) => mutate(request, "POST", suggestionPath(botId, s, "edit"), { expectedRevision: s.version, text });
export const notNowSuggestion = (request: Request, botId: string, s: Pick<Suggestion, "id" | "version">) => mutate(request, "POST", suggestionPath(botId, s, "not-now"), { expectedRevision: s.version });

export async function fetchFeedback(request: Request, botId: string): Promise<FeedbackRow[]> {
  return list<FeedbackRow>((await request(`${base(botId)}/feedback`))?.feedback).filter(item => item?.id);
}
export const answerFeedback = (request: Request, botId: string, row: Pick<FeedbackRow, "id" | "revision">, answer: "yes" | "no") =>
  mutate(request, "PATCH", `${base(botId)}/feedback/${encodeURIComponent(row.id)}`, { expectedRevision: row.revision, answer });

export async function fetchOutcomes(request: Request, botId: string): Promise<OutcomeCounts> {
  const c = (await request(`${base(botId)}/outcomes`))?.counts ?? {};
  return { won: num(c.won), lost: num(c.lost), good: num(c.good), bad: num(c.bad), proposed: num(c.proposed) };
}
/** Tier 2 is not built yet, so the server normally answers with a plain refusal; the caller shows it. */
export const startRun = (request: Request, botId: string) => mutate(request, "POST", `${base(botId)}/learning/runs`, { expectedRevision: 0 });

export async function fetchHistory(request: Request, botId: string, limit = HISTORY_LIMIT): Promise<LearningPage> {
  const answer = await requestLearningAction(request as any, { action: "learning-history", botId, limit }) as any;
  return { events: list<LearningEvent>(answer?.events), nextCursor: typeof answer?.nextCursor === "string" ? answer.nextCursor : null };
}
export async function fetchMemoryStatus(request: Request): Promise<MemoryStatusView> {
  const answer = await request("/api/memory/status");
  return { mode: typeof answer?.mode === "string" ? answer.mode : "off", learning: answer?.learning };
}

// ── what the screen shows ────────────────────────────────────────────────
/** A plain sentence for the owner: the harness's own words for a refusal, a fixed line for anything else. */
export function plainError(error: unknown, fallback = screenText("error.save"), anyStatus = false): string {
  const e = error as { status?: number; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message.trim() : "";
  return (anyStatus || e?.status === 422) && message && message.length <= 240 && !/\n/.test(message) ? message : fallback;
}

export interface LessonRow { lesson: Lesson; undone: boolean; keepUntil: number | null }
export interface LocalUndo { lesson: Lesson; until: number }
/** Active lessons, plus a lesson the owner just undid for as long as Keep is on offer. Newest first. */
export function lessonRows(lessons: readonly Lesson[], undone: Readonly<Record<string, LocalUndo>>, now: number): LessonRow[] {
  const rows = new Map<string, LessonRow>();
  for (const lesson of lessons) {
    const local = undone[lesson.id];
    if (lesson.state === "active") rows.set(lesson.id, { lesson, undone: false, keepUntil: null });
    else if (local && now <= local.until) rows.set(lesson.id, { lesson, undone: true, keepUntil: local.until });
  }
  for (const [id, local] of Object.entries(undone)) {
    if (!rows.has(id) && now <= local.until && !lessons.some(item => item.id === id && item.state === "active")) rows.set(id, { lesson: local.lesson, undone: true, keepUntil: local.until });
  }
  return [...rows.values()].sort((a, b) => b.lesson.createdAt - a.lesson.createdAt);
}
/** The When the Keep offer ends, from the server's answer or the Keep window. */
export function keepDeadline(answer: unknown, now: number): number {
  const until = (answer as { keepUntil?: unknown } | null)?.keepUntil;
  return typeof until === "number" && Number.isFinite(until) && until > now ? Math.min(until, now + KEEP_WINDOW_MS) : now + KEEP_WINDOW_MS;
}
export const activeCount = (rows: readonly LessonRow[]) => rows.filter(row => !row.undone).length;
export const shownRows = <T,>(rows: readonly T[], expanded: boolean, limit = LESSONS_SHOWN): T[] => (expanded ? [...rows] : rows.slice(0, limit));

/** "today", else the weekday within the last week, else the date. */
export function whenLabel(at: number, now: number): string {
  const day = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return screenText("when.today");
  const date = new Date(at);
  return days < 7 ? date.toLocaleDateString(undefined, { weekday: "short" }) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function lessonFrom(origin: string, createdAt: number, now: number): string {
  const name = ["feedback", "edit", "mark", "typed", "suggested"].includes(origin) ? origin : "suggested";
  return screenText(`from.${name}`, { when: whenLabel(createdAt, now) });
}
export const isShareSuggestion = (s: Pick<Suggestion, "scope">) => s.scope === "bots" || s.scope === "team";
/** The bots a share suggestion names, minus the ones the owner switched off. */
export const sharePicked = (s: Pick<Suggestion, "recipients">, skipped: readonly string[] = []) => (s.recipients ?? []).map(r => r.id).filter(id => !skipped.includes(id));
/** The small line under a lesson: where it came from, naming the bot when another bot taught it. */
export function lessonSource(lesson: Pick<Lesson, "origin" | "createdAt" | "scope" | "sharedFrom">, now: number): string {
  if (lesson.sharedFrom && lesson.scope === "team") return screenText("from.team", { name: lesson.sharedFrom.name, when: whenLabel(lesson.createdAt, now) });
  if (lesson.sharedFrom) return screenText("from.shared", { name: lesson.sharedFrom.name, when: whenLabel(lesson.createdAt, now) });
  return lessonFrom(lesson.origin, lesson.createdAt, now);
}
/** Precedence made visible: the bot's own lesson wins over a shared one, and both rows say so. */
export function conflictLine(lesson: Pick<Lesson, "conflict">): string | null {
  const c = lesson.conflict;
  if (!c) return null;
  return c.role === "wins" ? screenText("conflict.wins", { text: c.text, name: c.fromName }) : screenText("conflict.loses", { text: c.text, name: c.fromName });
}
export function suggestionWhy(s: Pick<Suggestion, "origin" | "prospectDerived"> & Partial<Pick<Suggestion, "scope" | "recipients" | "fromName">> & { reasons?: readonly string[] }): string {
  if (s.prospectDerived) return screenText("why.prospect");
  if (s.scope === "team") return screenText("why.shareTeam", { from: s.fromName ?? "" });
  if (s.scope === "bots") return screenText("why.shareBots", { from: s.fromName ?? "", names: (s.recipients ?? []).map(r => r.name).join(", ") });
  if (s.reasons?.includes("outbound")) return screenText("why.outbound");
  if (s.reasons?.includes("ask-first")) return screenText("why.askFirst");
  return screenText(s.origin === "feedback" ? "why.feedback" : s.origin === "edit" ? "why.edit" : s.origin === "mark" ? "why.mark" : "why.other");
}
export const unsureText = (row: Pick<FeedbackRow, "text">) => screenText("unsure.row", { text: row.text });

export const markedCount = (c: OutcomeCounts) => c.won + c.lost + c.good + c.bad;
export const outcomesStillNeeded = (c: OutcomeCounts) => Math.max(0, MIN_OUTCOMES_FOR_CHECK - markedCount(c));
/** "12 marked: 3 won, 2 lost, 7 good." Zero kinds are left out; null when nothing is marked. */
export function marksLine(c: OutcomeCounts): string | null {
  const total = markedCount(c);
  if (total <= 0) return null;
  const parts = (["won", "lost", "good", "bad"] as const).filter(kind => c[kind] > 0).map(kind => screenText(`kind.${kind}`, { count: c[kind] }));
  return screenText("results.marked", { count: total, parts: parts.join(", ") });
}
/** "Not enough examples yet. Confirm 3 more outcomes." or null when there are enough. */
export function needMoreLine(c: OutcomeCounts): string | null {
  const n = outcomesStillNeeded(c);
  return n <= 0 ? null : screenText(n === 1 ? "results.needOne" : "results.needMany", { count: n });
}
/** The check button shows only when the server says it is ready. */
export const canCheck = (state: Pick<LearningState, "readiness"> | null) => state?.readiness.ready === true;

export function monthWithUndone(line: string, undone: number): string {
  return undone > 0 ? `${line}${screenText("month.undone", { count: undone })}` : line;
}

// ── the memory half ──────────────────────────────────────────────────────
export interface MemoryEntry { eventId: string; recordId: string; recordVersion: number; eventRecordVersion: number | null; text: string; createdAt: number }
/** What the bot remembers: activated, not undone, still active, with words, one per record, newest first. */
export function memoryEntries(events: readonly LearningEvent[]): MemoryEntry[] {
  const out = new Map<string, MemoryEntry>();
  for (const event of [...events].sort((a, b) => b.created_at - a.created_at)) {
    const record = event.record;
    const text = record?.text?.trim();
    if (event.kind !== "activated" || event.undone_at !== null || !record || record.state !== "active" || !text || out.has(record.id)) continue;
    out.set(record.id, { eventId: event.id, recordId: record.id, recordVersion: record.version, eventRecordVersion: event.record_version, text, createdAt: event.created_at });
  }
  return [...out.values()];
}
/** Forget: undo the activation while it still matches; archive what is there if the owner has edited it since. */
export function forgetBody(entry: Pick<MemoryEntry, "eventId" | "recordId" | "recordVersion" | "eventRecordVersion">) {
  return entry.eventRecordVersion === entry.recordVersion
    ? { action: "learning-undo" as const, eventId: entry.eventId }
    : { action: "archive" as const, id: entry.recordId, version: entry.recordVersion };
}
export const editMemoryBody = (entry: Pick<MemoryEntry, "recordId" | "recordVersion">, text: string) => ({ action: "correct" as const, id: entry.recordId, version: entry.recordVersion, text });
const memoryAction = (request: Request, body: unknown) => request("/api/memory/action", { method: "POST", body: JSON.stringify(body) });
export const forgetMemory = (request: Request, entry: MemoryEntry) => memoryAction(request, forgetBody(entry));
export const editMemory = (request: Request, entry: MemoryEntry, text: string) => memoryAction(request, editMemoryBody(entry, text));
export const undoEvent = (request: Request, eventId: string) => memoryAction(request, { action: "learning-undo", eventId });

/** "See all 27 in Memory": the number only when this page is all of it. */
export function seeAllLabel(entries: number, nextCursor: string | null): string {
  return nextCursor === null && entries > 0 ? screenText("remembers.seeAll", { count: entries }) : screenText("remembers.seeAllNoCount");
}
export const memoryIsOff = (status: MemoryStatusView | null) => status?.mode === "off";

/** A skill or routine change: "Improved automatically", "Applied by you", "Suggested" or "Undone", with its name. */
function procedureChange(event: LearningEvent): ChangeRow {
  const p = event.procedure!;
  const how = event.kind === "guide-suggested" ? "suggested" : event.kind === "guide-undone" ? "undone" : p.via === "automatic" ? "auto" : "applied";
  return {
    id: event.id, label: screenText(`recent.procedure.${how}`), text: screenText(p.kind === "routine" ? "recent.procedure.routine" : "recent.procedure.skill", { name: p.label }),
    canUndo: event.kind === "guide-applied" && event.undone_at === null, undone: event.kind === "guide-applied" && event.undone_at !== null,
  };
}
export interface ChangeRow { id: string; label: string; text: string; canUndo: boolean; undone: boolean }
const UNDOABLE = new Set(["activated", "superseded", "lesson-learned", "guide-applied"]);
/** Recent changes: every kind, newest first, with the words from the lesson or the record. */
export function recentChanges(events: readonly LearningEvent[], label: (kind: string) => string, limit = CHANGES_SHOWN): ChangeRow[] {
  return [...events].sort((a, b) => b.created_at - a.created_at).slice(0, limit).map(event => event.procedure ? procedureChange(event) : ({
    id: event.id, label: label(event.kind), text: (event.lesson?.text ?? event.record?.text ?? "").trim(),
    canUndo: event.undone_at === null && UNDOABLE.has(event.kind), undone: event.undone_at !== null,
  }));
}

/** The usage line, from what memory status really reports (today's share of the allowance); null when it reports nothing. */
export function usageLine(status: MemoryStatusView | null): string | null {
  const allowance = status?.learning?.allowance;
  if (!allowance || typeof allowance.usedPercent !== "number") return null;
  return screenText("usage.today", { percent: Math.round(allowance.usedPercent) });
}

/** Forget this learning data: the server removes lessons, results, feedback, examples, ledger snippets and learning-local notes for this bot. */
export const forgetLearningData = (request: Request, botId: string) => mutate(request, "DELETE", `${base(botId)}/learning/data`, { expectedRevision: 0 });

/** Restore original behavior: undo every active lesson of this bot, then switch Ask first and customer learning off. */
export async function restoreOriginal(request: Request, botId: string): Promise<number> {
  const { lessons } = await fetchLessons(request, botId);
  const active = lessons.filter(lesson => lesson.state === "active");
  for (const lesson of active) await undoLesson(request, botId, lesson);
  const state = await fetchLearning(request, botId);
  await patchLearning(request, botId, state.revision, { askFirst: false, prospectLearning: false });
  return active.length;
}
