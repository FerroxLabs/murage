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
export { MEMORY_WAITING_EVENT };

export type Request = (path: string, init?: RequestInit) => Promise<any>;
export const memoryAction = (request: Request, body: Record<string, unknown>) => request("/api/memory/action", { method: "POST", body: JSON.stringify(body) });

/** A client action id: one per press, reused only by a retry of that same press. */
export function newActionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Words ────────────────────────────────────────────────────────────────
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const cardTitle = (name: string, waiting: number) => `${name} would like to remember ${waiting} ${plural(waiting, "thing", "things")}`;
export const headline = (waiting: number) => (waiting > 0 ? `${waiting} waiting for you` : "Nothing waiting for you.");
export function keepTogetherLine(everyday: number, waiting: number): string {
  if (waiting <= 0) return "";
  const oneByOne = Math.max(0, waiting - everyday);
  if (everyday > 0 && oneByOne > 0) return `${everyday} everyday ${plural(everyday, "thing", "things")} can be kept together. ${oneByOne} ${plural(oneByOne, "needs", "need")} you one by one.`;
  if (everyday > 0) return `${everyday} everyday ${plural(everyday, "thing", "things")} can be kept together.`;
  return "Each of these needs you one by one.";
}
export const keepAllLabel = (everyday: number) => `Keep all ${everyday}`;
export const newArrivals = (n: number) => `${n} new`;

/** What a Keep all press said, in plain words. */
export function batchSentence(results: ReadonlyArray<ItemResult>): string {
  const kept = results.filter(item => item.status === "kept").length;
  const changed = results.filter(item => item.status === "changed" || item.status === "gone").length;
  const needs = results.filter(item => item.status === "needs-you").length;
  const parts: string[] = [];
  if (kept) parts.push(`${kept} kept.`);
  if (changed) parts.push(`${changed} changed while you were looking, so ${plural(changed, "it is", "they are")} still here.`);
  if (needs && kept) parts.push(`${needs} ${plural(needs, "needs", "need")} you one by one.`);
  if (!kept && needs && !changed) return "Each of these needs you one by one.";
  if (!parts.length) return "Nothing changed.";
  return parts.join(" ");
}

/** The day a memory was noted: a weekday for the last week, a date after that. */
export function dayLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (now - at < 6 * 86_400_000 && now - at > -86_400_000) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The plain reason shown under a memory. Asks come first; otherwise where it came from. */
export function reasonSentence(item: Pick<ReviewItem, "reasons" | "origin" | "at" | "correction">, botName: string, now = Date.now()): string {
  const reasons = item.reasons;
  if (reasons.includes("source-gone")) return "No longer available: the message it came from was deleted.";
  if (reasons.includes("replaces-pinned")) return item.correction ? `Would replace something you pinned: "${item.correction.targetText}".` : "Would replace something you pinned.";
  if (reasons.includes("correction")) return `${botName} would like to update an earlier memory.`;
  if (reasons.includes("edited")) return "You changed the words, so it waits for your final yes.";
  if (reasons.includes("identity")) return `About ${botName} itself, so it asks you first.`;
  if (reasons.includes("sensitive-money")) return `About money, so ${botName} asks you first.`;
  if (reasons.includes("sensitive-health")) return `About health, so ${botName} asks you first.`;
  if (reasons.includes("sensitive-secret")) return `Could include a password or key, so ${botName} asks you first.`;
  if (reasons.includes("sensitive-person")) return `About another person, so ${botName} asks you first.`;
  if (reasons.includes("shared-space")) return "Several bots or people could use this, so it asks you first.";
  const day = dayLabel(item.at, now);
  if (item.origin === "owner-said") return `You said this on ${day}.`;
  if (item.origin === "tool-result") return `From a finished action on ${day}.`;
  if (item.origin === "imported") return "From notes you imported.";
  return `${botName} worked this out from ${day}'s chat.`;
}

/** A failed call, in words. The server's codes and messages never reach the screen. */
export function errorSentence(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = (error as { status?: number } | null)?.status;
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(text)) return "Reconnect to keep this. Nothing has been changed.";
  if (/MEMORY_VERSION_CONFLICT|MEMORY_NOT_FOUND/.test(text)) return "This changed while you were looking. Here is the latest.";
  if (/MEMORY_ACTION_REUSED/.test(text)) return "That did not go through. Try again.";
  if (/MEMORY_LATER_FULL/.test(text)) return "Later is full. Decide on a few of those first.";
  if (/MEMORY_UNDO_UNAVAILABLE/.test(text)) return "This can no longer be undone here.";
  if (/MEMORY_(EVIDENCE|SOURCE)_UNAVAILABLE/.test(text)) return "The message this came from is no longer available.";
  if (/MEMORY_CORRECTION_PIN/.test(text)) return "This would replace something you pinned. Choose what happens to the pin.";
  if (/MEMORY_CORRECTION/.test(text)) return "The memory this updates has changed. Review it again.";
  if (/MEMORY_PIN_MUST_BE_UNPINNED/.test(text)) return "Unpin it first.";
  if (/INVALID_MEMORY_TEXT/.test(text)) return "Write a few words to keep.";
  if (status === 403) return "Memory can only be reviewed in the desktop app.";
  return "That did not go through. Nothing was changed.";
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
