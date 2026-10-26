// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reviewing what bots would like to remember (PROPOSAL-v2 sections 3, 8, 9.2,
// 9.3). Pure helpers and one tiny shared store: the words people read (typed
// codes from the server are mapped HERE, never shown), the counts every
// surface agrees on, and the shapes of the review requests. Nothing in this
// file renders or fetches, so the screens, the Inbox card and the tests all
// speak through it.

export type SubjectKind = "bot" | "room" | "other";
export interface ReviewSubject { kind: SubjectKind; id: string; name: string }
export type AskReason =
  | "identity" | "correction" | "replaces-pinned" | "edited" | "shared-space"
  | "sensitive-money" | "sensitive-health" | "sensitive-secret" | "sensitive-person" | "source-gone";
export type Origin = "owner-said" | "bot-worked-out" | "tool-result" | "imported";
export interface ReviewItem {
  id: string; version: number; text: string; group: "everyday" | "one-by-one"; rank: number; reasons: AskReason[];
  origin: Origin; at: number; later: boolean; scopeLabel: string;
  correction?: { targetText: string; targetPinned: boolean };
}
export interface SubjectCount extends ReviewSubject { waiting: number; later: number; everyday: number }
export interface WaitingSummary { subjects: SubjectCount[]; total: number; later: number; boot: string; revision: number }
export interface ItemResult { id: string; version: number; status: "kept" | "changed" | "needs-you" | "gone"; reasons?: AskReason[] }
export type PinChoice = "transfer" | "unpin";

/** The window event the live stream's `memory.waiting` frame becomes (src/state/store.tsx). */
import { MEMORY_WAITING_EVENT } from "./memory-waiting-event";
import { indexBuildingSentence } from "./memory-words";
import { localeCode, t } from "./i18n";
import type { LocaleKey } from "@/locales";
export { MEMORY_WAITING_EVENT };

export type Request = (path: string, init?: RequestInit) => Promise<any>;
export const memoryAction = (request: Request, body: Record<string, unknown>) => request("/api/memory/action", { method: "POST", body: JSON.stringify(body) });

/** A client action id: one per press, reused only by a retry of that same press. */
export function newActionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Words ────────────────────────────────────────────────────────────────
// Every sentence is a catalogue key (memoryReview.*), so the person reads their own language.
const w = (name: string, params?: Record<string, string | number>) => t(`memoryReview.${name}` as LocaleKey, params);
const plural = (n: number, name: string, params?: Record<string, string | number>) => w(`${name}.${n === 1 ? "one" : "other"}`, { count: n, ...params });

export const cardTitle = (name: string, waiting: number) => plural(waiting, "cardTitle", { name });
export const headline = (waiting: number) => (waiting > 0 ? w("headline.waiting", { count: waiting }) : w("headline.none"));
export function keepTogetherLine(everyday: number, waiting: number): string {
  if (waiting <= 0) return "";
  const oneByOne = Math.max(0, waiting - everyday);
  if (everyday > 0 && oneByOne > 0) return `${plural(everyday, "everyday")} ${plural(oneByOne, "needs")}`;
  if (everyday > 0) return plural(everyday, "everyday");
  return w("eachNeeds");
}
export const keepAllLabel = (everyday: number) => w("keepAll", { count: everyday });
export const newArrivals = (n: number) => w("newArrivals", { count: n });

/** What a Keep all press said, in plain words. */
export function batchSentence(results: ReadonlyArray<ItemResult>): string {
  const kept = results.filter(item => item.status === "kept").length;
  const changed = results.filter(item => item.status === "changed" || item.status === "gone").length;
  const needs = results.filter(item => item.status === "needs-you").length;
  const parts: string[] = [];
  if (kept) parts.push(w("batch.kept", { count: kept }));
  if (changed) parts.push(plural(changed, "batch.changed"));
  if (needs && kept) parts.push(plural(needs, "needs"));
  if (!kept && needs && !changed) return w("eachNeeds");
  if (!parts.length) return w("batch.nothing");
  return parts.join(" ");
}

/** The day a memory was noted: a weekday for the last week, a date after that, in the language in use. */
export function dayLabel(at: number, now = Date.now()): string {
  const date = new Date(at), locale = localeCode();
  if (now - at < 6 * 86_400_000 && now - at > -86_400_000) return date.toLocaleDateString(locale, { weekday: "long" });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The plain reason shown under a memory. Asks come first; otherwise where it came from. */
export function reasonSentence(item: Pick<ReviewItem, "reasons" | "origin" | "at" | "correction">, botName: string, now = Date.now()): string {
  const reasons = item.reasons, name = botName;
  if (reasons.includes("source-gone")) return w("reason.sourceGone");
  if (reasons.includes("replaces-pinned")) return item.correction ? w("reason.replacesPinnedText", { text: item.correction.targetText }) : w("reason.replacesPinned");
  if (reasons.includes("correction")) return w("reason.correction", { name });
  if (reasons.includes("edited")) return w("reason.edited");
  if (reasons.includes("identity")) return w("reason.identity", { name });
  if (reasons.includes("sensitive-money")) return w("reason.money", { name });
  if (reasons.includes("sensitive-health")) return w("reason.health", { name });
  if (reasons.includes("sensitive-secret")) return w("reason.secret", { name });
  if (reasons.includes("sensitive-person")) return w("reason.person", { name });
  if (reasons.includes("shared-space")) return w("reason.shared");
  const day = dayLabel(item.at, now);
  if (item.origin === "owner-said") return w("reason.ownerSaid", { day });
  if (item.origin === "tool-result") return w("reason.toolResult", { day });
  if (item.origin === "imported") return w("reason.imported");
  return w("reason.workedOut", { name, day });
}

/** A failed call, in words. The server's codes and messages never reach the screen. */
export function errorSentence(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = (error as { status?: number } | null)?.status;
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(text)) return w("error.reconnect");
  if (/MEMORY_IMPORT_INDEX_BUILDING/.test(text)) return indexBuildingSentence();
  if (/MEMORY_VERSION_CONFLICT|MEMORY_NOT_FOUND/.test(text)) return w("error.conflict");
  if (/MEMORY_ACTION_REUSED/.test(text)) return w("error.reused");
  if (/MEMORY_LATER_FULL/.test(text)) return w("error.laterFull");
  if (/MEMORY_UNDO_UNAVAILABLE/.test(text)) return w("error.undoUnavailable");
  if (/MEMORY_(EVIDENCE|SOURCE)_UNAVAILABLE/.test(text)) return w("error.sourceUnavailable");
  if (/MEMORY_CORRECTION_PIN/.test(text)) return w("error.correctionPin");
  if (/MEMORY_CORRECTION/.test(text)) return w("error.correction");
  if (/MEMORY_PIN_MUST_BE_UNPINNED/.test(text)) return w("error.unpin");
  // A pin the share has no room for (409, 1.0.4): how much the pins would take and how much they have, in bytes.
  const room = /MEMORY_PIN_BUDGET:\s*(\d+)\/(\d+)/.exec(text);
  if (room) return w("error.pinBudget", { used: Number(room[1]).toLocaleString(), allowed: Number(room[2]).toLocaleString() });
  if (/MEMORY_PIN_BUDGET/.test(text)) return w("error.pinBudgetPlain");
  if (/INVALID_MEMORY_TEXT/.test(text)) return w("error.writeWords");
  if (status === 403) return w("error.desktopOnly");
  return w("error.generic");
}

// ── What a press does to the list on screen (pure) ───────────────────────
export const withoutItems = (items: readonly ReviewItem[], ids: ReadonlySet<string>) => items.filter(item => !ids.has(item.id));
/** The exact (id, version) list a Keep all would send: everyday items the owner is looking at, not parked in Later. */
export const keepAllTargets = (items: readonly ReviewItem[]) => items.filter(item => item.group === "everyday" && !item.later).map(item => ({ id: item.id, version: item.version }));
/** Put back what a failed or partly refused press removed, in its old place. */
export function restoreItems(current: readonly ReviewItem[], before: readonly ReviewItem[], ids: ReadonlySet<string>): ReviewItem[] {
  const have = new Set(current.map(item => item.id));
  const back = before.filter(item => ids.has(item.id) && !have.has(item.id));
  if (!back.length) return [...current];
  const order = new Map(before.map((item, position) => [item.id, position]));
  return [...current, ...back].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}
/** Rows on screen by tab. */
export const itemsForTab = (items: readonly ReviewItem[], tab: "waiting" | "later") => items.filter(item => item.later === (tab === "later"));

// ── The counts every surface agrees on ───────────────────────────────────
export interface WaitingSnapshot { subjects: SubjectCount[]; total: number; later: number; boot: string | null; revision: number; loaded: boolean }
let snapshot: WaitingSnapshot = { subjects: [], total: 0, later: 0, boot: null, revision: 0, loaded: false };
const listeners = new Set<() => void>();
const publish = (next: WaitingSnapshot) => { snapshot = next; for (const listener of [...listeners]) listener(); };
export const getWaiting = () => snapshot;
export function subscribeWaiting(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function resetWaiting(): void { publish({ subjects: [], total: 0, later: 0, boot: null, revision: 0, loaded: false }); }
/** An answer that is older than one already shown (same run, smaller counter) is dropped. */
const stale = (boot: string | null | undefined, revision: number | undefined) => boot !== undefined && boot !== null && boot === snapshot.boot && typeof revision === "number" && revision < snapshot.revision;
const keyOf = (item: ReviewSubject) => `${item.kind}:${item.id}`;

export function applyWaitingSummary(summary: Pick<WaitingSummary, "subjects" | "total" | "later"> & Partial<Pick<WaitingSummary, "boot" | "revision">>): void {
  if (stale(summary.boot, summary.revision)) return;
  publish({ subjects: summary.subjects.map(item => ({ ...item })), total: summary.total, later: summary.later, boot: summary.boot ?? snapshot.boot, revision: summary.revision ?? snapshot.revision, loaded: true });
}

export interface WaitingFrame { kind?: string; subject?: SubjectKind; botId?: string; groupId?: string; waiting: number; total: number; revision?: number; boot?: string }
/** One live frame: counts only. The subject's number moves at once; the everyday count follows from the next summary. */
export function applyWaitingFrame(frame: WaitingFrame): void {
  if (stale(frame.boot, frame.revision)) return;
  const kind = frame.subject ?? (frame.botId ? "bot" : frame.groupId ? "room" : "other");
  const id = frame.botId ?? frame.groupId ?? "shared";
  const subjects = snapshot.subjects.map(item => ({ ...item }));
  const found = subjects.find(item => keyOf(item) === `${kind}:${id}`);
  if (found) { found.waiting = frame.waiting; if (frame.waiting === 0) found.everyday = 0; }
  else if (frame.waiting > 0) subjects.push({ kind, id, name: "", waiting: frame.waiting, later: 0, everyday: 0 });
  publish({ ...snapshot, subjects: subjects.filter(item => item.waiting > 0 || item.later > 0), total: frame.total, boot: frame.boot ?? snapshot.boot, revision: frame.revision ?? snapshot.revision, loaded: true });
}

/** The Inbox answer carries the cards; they seed the counts until a summary arrives. */
export function applyInboxWaiting(rows: ReadonlyArray<{ kind: SubjectKind; id: string; name: string; waiting: number; everyday: number }>): void {
  const before = new Map(snapshot.subjects.map(item => [keyOf(item), item]));
  const subjects = rows.map(row => ({ ...row, later: before.get(keyOf(row))?.later ?? 0 }));
  publish({ ...snapshot, subjects, total: rows.reduce((sum, row) => sum + row.waiting, 0), loaded: true });
}

export const subjectCount = (snap: WaitingSnapshot, subject: Pick<ReviewSubject, "kind" | "id">): SubjectCount | undefined => snap.subjects.find(item => item.kind === subject.kind && item.id === subject.id);

/** Where a Review press from the Inbox should land when the bot's Memory screen opens. */
let expandRequest: string | null = null;
export const requestExpand = (subject: ReviewSubject) => { expandRequest = keyOf(subject); };
export function takeExpandRequest(subject: ReviewSubject): boolean {
  if (expandRequest !== keyOf(subject)) return false;
  expandRequest = null;
  return true;
}
