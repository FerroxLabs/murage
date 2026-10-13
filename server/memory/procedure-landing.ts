// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a learned change to a skill or a routine lands (bot-learning batch B7c,
// design section 12): on its own with a visible, undoable notice, or as a
// suggestion the owner decides on.
//
//   automatic  -> a ledger row (guide-applied), a chip under the bot's latest
//                 reply ("improved how it does X"), a row under Recent
//                 changes, and one-tap Undo through the scoped skill rollback
//                 or the routine rollback.
//   suggestion -> a card in Learning > Suggestions (Apply / Edit / Not now)
//                 unless every context that can run the skill or routine is
//                 structurally contained (asks first, nothing always-allowed,
//                 owner only, no room, no channel), when anything in it came
//                 from customer or audience messages, or when the bot's
//                 "Ask me first" is on. The text is never read for intent.
//
// The hard check is structural only: skill front matter must not change. A
// change that fails is dropped, not offered.
//
// The suggestion rows live in memory_scope_bindings under the same subject as
// finished procedure reviews, so forgetting an evidence message reaches them
// through the existing sweep (evolution-forgetting.ts).
import { assertMemoryGate, memoryGate } from "./memory-gate.ts";
import { noteIdentityEpoch } from "./provenance-stamp.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chipClause, pickTemplate, KEEP_WINDOW_MS, type ChipItem } from "../../shared/learned-chip.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { previousTemplate, seedFor } from "./lessons.ts";
import { latestBotReply } from "./memory-moments.ts";
import { classifyPastedText } from "./prospect-text.ts";
import type { ProcedureEvaluationReceipt, ProcedureReviewSnapshot, ProcedureReviewTarget } from "./procedure-review.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const httpError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// ── the landing decision ──────────────────────────────────────────────────
export type LandingReason = "ask-first" | "outbound" | "prospect-derived";
export type LandingDecision =
  | { mode: "auto"; beforeSha256: string; label: string }
  | { mode: "suggest"; reasons: LandingReason[]; beforeSha256: string; beforeText: string; label: string }
  | { mode: "refuse"; reason: string };

/** Why a change must wait for the owner. Empty means it may land on its own. */
export function landingReasons(input: { askFirst: boolean; outbound: boolean; prospectDerived: boolean }): LandingReason[] {
  const out: LandingReason[] = [];
  if (input.askFirst) out.push("ask-first");
  if (input.outbound) out.push("outbound");
  if (input.prospectDerived) out.push("prospect-derived");
  return out;
}

// ── hard checks ───────────────────────────────────────────────────────────
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export type HardCheck = { ok: true } | { ok: false; reason: "frontmatter-changed" | "empty" };
/** Skill front matter other than the description must stay exactly as it was (a structural check). The added lines are NOT read for intent:
 * whether a change may land on its own is decided by structure alone (procedure-review-host.ts landing), and anything that can reach
 * outside still stops at run time on the approval the owner already controls. */
export function procedureHardCheck(before: string, after: string): HardCheck {
  if (!after.trim()) return { ok: false, reason: "empty" };
  const beforeFront = FRONT.exec(before), afterFront = FRONT.exec(after);
  const rule = (front: RegExpExecArray | null) => (front?.[1] ?? "").split(/\r?\n/).filter(line => !/^description:/.test(line));
  if (JSON.stringify(rule(beforeFront)) !== JSON.stringify(rule(afterFront)) || Boolean(beforeFront) !== Boolean(afterFront)) return { ok: false, reason: "frontmatter-changed" };
  return { ok: true };
}

/** Was any of the evidence said by someone other than the owner (or pasted from them)? */
export function procedureEvidenceProspectDerived(db: DatabaseSync, snapshot: ProcedureReviewSnapshot, prospectThreadIds: readonly string[] = []): boolean {
  const sources: Array<{ speaker: string; text: string; threadId: string | null }> = [];
  for (const item of snapshot.evidence) {
    if (item.kind === "source") {
      const thread = db.prepare("SELECT thread_id FROM memory_sources WHERE id=?").get(item.id)?.thread_id;
      sources.push({ speaker: item.speaker, text: item.text, threadId: thread === undefined || thread === null ? null : String(thread) });
    } else {
      for (const row of db.prepare("SELECT s.speaker,s.thread_id,v.payload FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=e.source_revision WHERE e.record_id=? AND e.record_version=?").all(item.id, item.revision)) {
        let text = ""; try { text = String(JSON.parse(String(row.payload)).text ?? ""); } catch { /* no text */ }
        sources.push({ speaker: String(row.speaker), text, threadId: row.thread_id === null ? null : String(row.thread_id) });
      }
    }
  }
  return sources.some(source => source.speaker.startsWith("person:")
    || (source.threadId !== null && prospectThreadIds.includes(source.threadId))
    || (source.speaker === "owner" && classifyPastedText(source.text).some(segment => segment.party === "third-party")));
}

// ── automatic changes: ledger row, chip, history ──────────────────────────
export interface AppliedChange {
  kind: "skill" | "routine"; artifactId: string; label: string; ownerId: string; threadId: string; scopeId: string; bundleId: string;
  /** What Undo goes back to, and what it expects to find now. */
  baseRevision: string; beforeRevision: string; afterRevision: string; beforeSha256: string; afterSha256: string; receiptId: string;
  via: "automatic" | "suggestion" | "edit";
}
const PROCEDURE_KINDS = ["guide-applied"] as const;
export const isProcedureEvent = (event: Record<string, any>): boolean => (PROCEDURE_KINDS as readonly string[]).includes(String(event.kind)) && safeDetail(event).procedure === 1;
function safeDetail(event: Record<string, any>): Record<string, any> { try { return JSON.parse(String(event.detail ?? "{}")); } catch { return {}; } }

/** How far a change got. A change is written as "publishing" BEFORE the skill or routine is touched and marked "applied" only after it landed (the
 * outbox pattern): a failure or a crash between the two leaves a row that reconcilePublishing resolves by looking at what is actually there. "failed"
 * means nothing landed; "held" means the text is neither the intended nor the previous one and the owner is told. Rows from earlier builds have no state
 * and are applied. */
export type PublishState = "publishing" | "applied" | "failed" | "held";
const OUTBOX_SUBJECT = "procedure-outbox", OUTBOX_PREFIX = "procedure-outbox:";
const publishStateOf = (detail: Record<string, any>): PublishState => (["publishing", "failed", "held"].includes(detail.publishState) ? detail.publishState : "applied") as PublishState;

/** Writes the ledger row for a change. With `publishing` the row is the outbox entry written ahead of the external change (nothing is announced yet);
 * otherwise it is a change that has landed. The chip needs a reply to sit under; with none, the row still shows under Recent changes. */
export function recordAppliedChange(db: DatabaseSync, change: AppliedChange, now: number = Date.now(), options: { publishing?: boolean; suggestionId?: string } = {}): string {
  const reply = latestBotReply(db, change.threadId);
  const group = "improved" as const;
  const id = recordLearningEvent(db, {
    kind: "guide-applied", scopeId: change.scopeId, botId: change.ownerId, now,
    detail: { procedure: 1, ...change, group, template: pickTemplate(group, previousTemplate(db, change.ownerId, group), seedFor(db, change.ownerId, now)), replyMessageId: reply,
      ...(options.publishing ? { publishState: "publishing" } : {}), ...(options.suggestionId ? { suggestionId: options.suggestionId } : {}) },
  }) as unknown as string;
  if (options.publishing) {
    // the pointer the boot and idle sweeps find (a range on the primary key, never a scan of the ledger)
    db.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(`${OUTBOX_PREFIX}${id}`, change.scopeId, OUTBOX_SUBJECT, JSON.stringify({ eventId: id, at: now }));
  } else announceApplied(change.via, reply, id);
  return id;
}
/** Announced after the surrounding write has committed; the listener re-reads the row, so a rollback announces nothing. */
function announceApplied(via: string, reply: string | null | undefined, id: string): void {
  if (via === "automatic" && reply) { const listener = improvedListener; if (listener) setTimeout(() => { try { listener(id); } catch { /* the chip is optional; the change is already recorded */ } }, 0); }
}
const patchDetail = (db: DatabaseSync, eventId: string, patch: Record<string, unknown>): void => {
  const done = db.prepare("UPDATE memory_learning_events SET detail=json_patch(detail,?) WHERE id=?").run(JSON.stringify(patch), eventId);
  if (Number(done.changes) !== 1) throw new Error("MEMORY_LEDGER_ROW_MISSING");
};
const dropOutboxPointer = (db: DatabaseSync, eventId: string): void => { db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`${OUTBOX_PREFIX}${eventId}`); };

/** Second commit of an Apply: the change landed. One update of a row the first commit wrote, plus the suggestion's own state. */
export function settleAppliedChange(db: DatabaseSync, eventId: string, afterRevision: string, now: number = Date.now()): void {
  const event = db.prepare("SELECT detail FROM memory_learning_events WHERE id=?").get(eventId) as { detail: string } | undefined;
  if (!event) throw new Error("MEMORY_LEDGER_ROW_MISSING");
  const detail = safeDetail(event);
  patchDetail(db, eventId, { publishState: null, afterRevision });
  dropOutboxPointer(db, eventId);
  // announced after the surrounding write has committed (the listener re-reads the row, so a rollback announces nothing)
  announceApplied(String(detail.via ?? ""), typeof detail.replyMessageId === "string" ? detail.replyMessageId : null, eventId);
  if (typeof detail.suggestionId === "string") { const row = readRow(db, detail.suggestionId); if (row && row.state === "suggested") writeRow(db, { ...row, state: "applied", decidedAt: now }); }
}

type Observed = { sha256: string; revision: string } | null;
/** What the skill or routine is right now, from its own host (null when it cannot be read). */
function observe(detail: Record<string, any>): Observed {
  if (!landingHost) return null;
  const target: ProcedureReviewTarget = { kind: detail.kind, scopeId: String(detail.scopeId), ownerId: String(detail.ownerId), artifactId: String(detail.artifactId), baseRevision: String(detail.baseRevision), threadId: String(detail.threadId), bundleId: String(detail.bundleId) };
  try {
    const now = landingHost.base(target);
    if (!now) return null;
    return { sha256: now.sha256, revision: detail.kind === "routine" ? String(JSON.parse(now.revision)[0]) : now.revision };
  } catch { return null; }
}

/** Resolves a change left "publishing" by a failure or a crash, by comparing what is there with the intended and the previous text. Matches the intended
 * text: it is applied. Matches the previous text: it failed and the suggestion stays suggested. Anything else (or unreadable): held, shown to the owner,
 * nothing is hidden. Returns "pending" when it could not decide or write right now (the sweeps try again). */
export function reconcilePublishing(db: DatabaseSync, eventId: string, now: number = Date.now()): "applied" | "failed" | "held" | "pending" | "none" {
  const event = db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(eventId) as Record<string, any> | undefined;
  if (!event) return "none";
  const detail = safeDetail(event);
  if (publishStateOf(detail) !== "publishing") return "none";
  if (!landingHost) return "pending";
  const seen = observe(detail);
  try {
    return atomically(db, () => {
      if (seen && seen.sha256 === detail.afterSha256) { settleAppliedChange(db, eventId, seen.revision, now); return "applied" as const; }
      if (seen && seen.sha256 === detail.beforeSha256) { patchDetail(db, eventId, { publishState: "failed" }); dropOutboxPointer(db, eventId); return "failed" as const; }
      patchDetail(db, eventId, { publishState: "held" }); dropOutboxPointer(db, eventId); return "held" as const;
    });
  } catch { return "pending"; }
}
/** An Undo left "undoing": the text is back (complete it), still as it was (clear it), or something else (held). */
export function reconcileUndoing(db: DatabaseSync, eventId: string, now: number = Date.now()): "undone" | "kept" | "held" | "pending" | "none" {
  const event = db.prepare("SELECT * FROM memory_learning_events WHERE id=?").get(eventId) as Record<string, any> | undefined;
  if (!event) return "none";
  const detail = safeDetail(event);
  if (detail.undoState !== "undoing") return "none";
  if (!landingHost) return "pending";
  const seen = observe(detail);
  try {
    return atomically(db, () => {
      if (seen && seen.sha256 === detail.beforeSha256) { finishUndo(db, event, now); return "undone" as const; }
      if (seen && seen.sha256 === detail.afterSha256) { patchDetail(db, eventId, { undoState: null }); dropOutboxPointer(db, eventId); return "kept" as const; }
      patchDetail(db, eventId, { undoState: "held" }); dropOutboxPointer(db, eventId); return "held" as const;
    });
  } catch { return "pending"; }
}
function finishUndo(db: DatabaseSync, event: Record<string, any>, now: number): void {
  const detail = safeDetail(event), eventId = String(event.id);
  db.prepare("UPDATE memory_learning_events SET undone_at=?,detail=json_patch(detail,'{\"undoState\":null}') WHERE id=?").run(now, eventId);
  dropOutboxPointer(db, eventId);
  recordLearningEvent(db, { kind: "guide-undone", scopeId: String(event.scope_id), botId: event.bot_id === null ? null : String(event.bot_id), now, detail: { procedure: 1, kind: detail.kind, label: detail.label, appliedEventId: eventId } });
}
/** Boot, idle and the recovery scheduler: every change an earlier run (or a failed commit) left half done. Bounded; the pointers are a primary-key range.
 * `after` is the id of the last pointer the previous pass looked at: a pass looks at the `limit` pointers that follow it and hands back where it got to
 * (`next`, null when the end of the range was reached, so the next pass begins again at the start), so a pointer that cannot settle yet never starves the
 * ones behind it. `pending` counts the ones left for a later pass. */
export function reconcileOutstandingChangesPass(db: DatabaseSync, after: string | null, limit = 20): { settled: number; examined: number; pending: number; next: string | null } {
  let settled = 0, pending = 0, last: string | null = null;
  const rows = (after === null
    ? db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE id>=? AND id<? ORDER BY id LIMIT ?").all(OUTBOX_PREFIX, "procedure-outbox;", limit)
    : db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE id>? AND id<? ORDER BY id LIMIT ?").all(after, "procedure-outbox;", limit)) as Array<{ id: string; intent: string }>;
  for (const row of rows) {
    last = String(row.id);
    let eventId = ""; try { eventId = String(JSON.parse(row.intent).eventId ?? ""); } catch { continue; }
    if (!eventId) continue;
    const a = reconcilePublishing(db, eventId), b = reconcileUndoing(db, eventId);
    if (a !== "pending" && b !== "pending") { settled++; if (a === "none" && b === "none") dropOutboxPointer(db, eventId); }
    else pending++;
  }
  return { settled, examined: rows.length, pending, next: rows.length < limit ? null : last };
}
/** One pass from the start of the range (the boot pass, and the idle call that older callers make). */
export function reconcileOutstandingChanges(db: DatabaseSync, limit = 20): number {
  return reconcileOutstandingChangesPass(db, null, limit).settled;
}

/** Chips under this thread's replies for automatic skill and routine changes. */
export function procedureChipItemsForThread(db: DatabaseSync, input: { botId: string; threadId: string; now?: number }): ChipItem[] {
  const now = input.now ?? Date.now();
  const rows = db.prepare(`SELECT * FROM memory_learning_events WHERE bot_id=? AND kind='guide-applied' AND json_extract(detail,'$.procedure')=1
    AND json_extract(detail,'$.threadId')=? AND json_extract(detail,'$.replyMessageId') IS NOT NULL AND json_extract(detail,'$.publishState') IS NULL AND (undone_at IS NULL OR undone_at>=?)
    ORDER BY created_at DESC,rowid DESC LIMIT 50`).all(input.botId, input.threadId, now - KEEP_WINDOW_MS) as Record<string, any>[];
  return rows.reverse().map(chipItemOf);
}
function chipItemOf(event: Record<string, any>): ChipItem {
  const detail = safeDetail(event);
  return {
    eventId: String(event.id), kind: "improved" as const, group: "improved" as const, template: Number(detail.template) || 1, text: chipClause(String(detail.label ?? "")),
    state: event.undone_at === null ? "active" as const : "undone" as const, undoneAt: event.undone_at === null ? null : Number(event.undone_at),
    replyMessageId: String(detail.replyMessageId), procedureKind: detail.kind === "routine" ? "routine" as const : "skill" as const,
    actions: { edit: false, undo: true, forget: false, notQuite: false, notExample: false, restorable: false },
  };
}

/** The live frame for a change that just landed on its own (the same idea as B5m's learning.remembered):
 * the open chat shows the "improved how it does X" chip without a reload. Null when the row is gone
 * (the write rolled back) or has no reply to sit under. */
export interface ImprovedMoment { eventId: string; botId: string; threadId: string; replyMessageId: string; template: number; text: string; procedureKind: "skill" | "routine" }
export function improvedMomentForEvent(db: DatabaseSync, eventId: string): ImprovedMoment | null {
  const event = db.prepare("SELECT * FROM memory_learning_events WHERE id=? AND kind='guide-applied' AND undone_at IS NULL AND json_extract(detail,'$.publishState') IS NULL").get(eventId) as Record<string, any> | undefined;
  if (!event || !event.bot_id) return null;
  const detail = safeDetail(event);
  if (detail.procedure !== 1 || detail.via !== "automatic" || typeof detail.threadId !== "string" || !detail.threadId || typeof detail.replyMessageId !== "string" || !detail.replyMessageId) return null;
  const item = chipItemOf(event);
  return { eventId: item.eventId, botId: String(event.bot_id), threadId: detail.threadId, replyMessageId: item.replyMessageId, template: item.template, text: item.text, procedureKind: item.procedureKind! };
}
let improvedListener: ((eventId: string) => void) | null = null;
/** The host registers who hears of an automatic change (server/index.ts broadcasts it). */
export function setImprovedListener(listener: ((eventId: string) => void) | null): void { improvedListener = listener; }

/** What the history list adds to a procedure event: what changed and how it landed. */
export function procedureForEvent(_db: DatabaseSync, event: Record<string, any>) {
  if (event.kind === "guide-applied") {
    const detail = safeDetail(event);
    if (detail.procedure !== 1) return null;
    const published = publishStateOf(detail);
    // held (and still-publishing) changes are shown as needing a look; a change that never landed is not shown at all
    if (published === "failed") return null;
    const state = published !== "applied" || detail.undoState === "held" ? "held" : event.undone_at === null ? "active" : "undone";
    return { kind: detail.kind === "routine" ? "routine" : "skill", label: String(detail.label ?? ""), via: String(detail.via ?? "automatic"), state };
  }
  if (event.kind === "guide-undone") {
    const detail = safeDetail(event);
    return detail.procedure === 1 ? { kind: detail.kind === "routine" ? "routine" : "skill", label: String(detail.label ?? ""), via: "undo", state: "undone" } : null;
  }
  if (event.kind === "guide-suggested") {
    const detail = safeDetail(event);
    return detail.procedure === 1 ? { kind: detail.kind === "routine" ? "routine" : "skill", label: String(detail.label ?? ""), via: "suggestion", state: "suggested" } : null;
  }
  return null;
}

// ── undo: the host is the only thing that can touch a skill or a routine ──
export interface ProcedureLandingHost {
  /** Puts the text back the way it was; `{ok:false}` when it changed since (nothing is touched). */
  rollback(change: AppliedChange): { ok: true } | { ok: false };
  /** Is the target still at the revision the change was made against, and what is its text hash now? */
  base(target: ProcedureReviewTarget): { revision: string; sha256: string } | null;
  publishEvaluated(snapshot: ProcedureReviewSnapshot, receipt: ProcedureEvaluationReceipt): void;
  /** The owner's edited words, published as an owner edit after hard checks. */
  publishEdited(snapshot: ProcedureReviewSnapshot, text: string, receiptId: string): void;
  /** What a change made right now looks like to Undo. */
  describe(snapshot: ProcedureReviewSnapshot, text: string, receiptId: string, beforeSha256: string, label: string): Omit<AppliedChange, "via">;
}
let landingHost: ProcedureLandingHost | null = null;
/** The review host registers itself when it is built. */
export function setProcedureLandingHost(host: ProcedureLandingHost | null): void { landingHost = host; }

const OUTBOX_NESTED = "PROCEDURE_OUTBOX_NEEDS_OWN_TRANSACTION";
/** Apply and Undo commit twice around the external change, so they cannot run inside a caller's transaction (the first commit must be durable before the
 * files change). Callers do not wrap them. */
const requireOwnTransaction = (db: DatabaseSync): void => { if (db.isTransaction) throw new Error(OUTBOX_NESTED); };
const stillLanding = () => httpError("This change is still being finished. Try again in a moment.", 409, "CONFLICT");

/** Undo or Keep for a procedure change. Called from changeLearningEvent. Undo is an outbox too: the intent is committed, then the text goes back, then
 * the undone state is committed; a failure between them is reconciled from what the text actually is. */
export function changeProcedureEvent(db: DatabaseSync, event: Record<string, any>, action: "undo" | "keep", now: number = Date.now()) {
  const eventId = String(event.id);
  const detail = safeDetail(event) as AppliedChange & Record<string, any>;
  if (action === "keep") {
    if (event.undone_at !== null) throw httpError("This learning item cannot be changed.", 409);
    if (publishStateOf(detail) !== "applied") throw stillLanding();
    // The gate first, before the acknowledgement is written: a hold refuses every ledger write.
    assertMemoryGate(db, "ledger-write");
    if (event.kept_at === null) db.prepare("UPDATE memory_learning_events SET kept_at=? WHERE id=?").run(now, eventId);
    return { ok: true, eventId, kept: true };
  }
  if (event.undone_at !== null) return { ok: true, eventId, undone: true };
  requireOwnTransaction(db);
  if (publishStateOf(detail) !== "applied") { reconcilePublishing(db, eventId, now); throw stillLanding(); }
  if (detail.undoState === "undoing") {
    const settled = reconcileUndoing(db, eventId, now);
    if (settled === "undone") return { ok: true, eventId, undone: true };
    if (settled !== "kept") throw stillLanding();
  } else if (detail.undoState === "held") throw httpError("This changed since it was updated. Open its history to review the current version.", 409);
  // The gate first: a hold (or a pass still going over earlier memory, for a change made before it began) refuses before anything is touched.
  assertMemoryGate(db, "rollback-procedure", { eventId });
  if (!landingHost) throw httpError("This learning item cannot be changed.", 409);
  const host = landingHost;
  // commit 1: the intent, durable before the text moves
  atomically(db, () => {
    assertMemoryGate(db, "rollback-procedure", { eventId });
    patchDetail(db, eventId, { undoState: "undoing" });
    db.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)").run(`${OUTBOX_PREFIX}${eventId}`, String(event.scope_id), OUTBOX_SUBJECT, JSON.stringify({ eventId, at: now }));
  });
  let thrown: unknown, result: { ok: boolean } | undefined;
  try { assertMemoryGate(db, "rollback-procedure", { eventId }); result = host.rollback(detail); } catch (error) { thrown = error; }
  if (!thrown && result?.ok === true) {
    try { atomically(db, () => finishUndo(db, event, now)); return { ok: true, eventId, undone: true }; } catch (error) { thrown = error; }
  }
  // a refused rollback ({ok:false}), a throw, or a failed second commit: look at what the text is now
  const settled = reconcileUndoing(db, eventId, now);
  if (settled === "undone") return { ok: true, eventId, undone: true };
  if (thrown) throw thrown;
  throw httpError("This changed since it was updated. Open its history to review the current version.", 409);
}

let atomicSavepoints = 0;
/** Runs the work as one unit: inside the caller's transaction it is a savepoint, so a throw undoes its rows even when the caller catches it. */
function atomically<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction, point = `procedure_landing_${++atomicSavepoints}`;
  if (!nested) noteIdentityEpoch(db);
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try { const result = work(); db.exec(nested ? `RELEASE ${point}` : "COMMIT"); return result; }
  catch (error) { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); throw error; }
}

// ── suggestions ───────────────────────────────────────────────────────────
/** Short enough for the route's item pattern ([\w-]{1,64}). */
export const PROCEDURE_SUGGESTION_PREFIX = "psug-";
export const isProcedureSuggestionId = (id: unknown): boolean => typeof id === "string" && id.startsWith(PROCEDURE_SUGGESTION_PREFIX);
type State = "suggested" | "retired" | "hidden" | "applied" | "stale";
interface Row {
  schema: 1; id: string; kind: "suggestion"; status: "complete" | "cancelled"; scopeId: string; botId: string; state: State; version: number; notNowCount: number;
  reasons: LandingReason[]; label: string; targetKind: "skill" | "routine"; target: ProcedureReviewTarget; evidence: Array<{ kind: string; id: string; revision: number }>;
  evidenceDigest: string; proposedText: string; proposedHash: string; beforeText: string; beforeSha256: string; editedText?: string;
  snapshot?: ProcedureReviewSnapshot; receipt?: ProcedureEvaluationReceipt; createdAt: number; decidedAt: number | null;
  policyRevision: number; deletionEpoch: number; learningRevision: number;
}
const readRow = (db: DatabaseSync, id: string): Row | undefined => {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-review'").get(id);
  if (!row) return undefined;
  try { const value = JSON.parse(String(row.intent)); return value?.kind === "suggestion" ? value as Row : undefined; } catch { return undefined; }
};
const writeRow = (db: DatabaseSync, row: Row) => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','procedure-review',?,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent,revision=excluded.revision")
  .run(row.id, row.scopeId, row.policyRevision, JSON.stringify(row));
const firstChange = (before: string, after: string) => {
  const known = new Set(before.split(/\r?\n/).map(line => line.trim()));
  return chipClause(after.split(/\r?\n/).map(line => line.trim()).find(line => line && line !== "---" && !known.has(line)) ?? "");
};

export interface ProcedureSuggestionView {
  id: string; version: number; kind: "procedure"; targetKind: "skill" | "routine"; label: string; text: string; before: string; summary: string;
  reasons: LandingReason[]; prospectDerived: boolean; edited: boolean; proposedHash: string; origin: "suggested";
  scores: { baseline: number; candidate: number; cases: number } | null; createdAt: number;
}
const finalText = (row: Row) => row.editedText ?? row.proposedText;
const view = (row: Row): ProcedureSuggestionView => ({
  id: row.id, version: row.version, kind: "procedure", targetKind: row.targetKind, label: row.label, text: finalText(row), before: row.beforeText,
  summary: firstChange(row.beforeText, finalText(row)), reasons: row.reasons, prospectDerived: row.reasons.includes("prospect-derived"), edited: row.editedText !== undefined,
  proposedHash: sha256(finalText(row)), origin: "suggested",
  // "Your edit, not checked": an edit has no scores.
  scores: row.editedText === undefined && row.receipt ? { baseline: row.receipt.heldout.baseline, candidate: row.receipt.heldout.candidate, cases: row.receipt.heldout.cases } : null,
  createdAt: row.createdAt,
});

/** A reviewed change that must wait for the owner. A same-words suggestion already waiting is left alone;
 * one the owner put off once comes back (new base), one put off twice stays hidden until new evidence. */
export function recordProcedureSuggestion(db: DatabaseSync, input: { snapshot: ProcedureReviewSnapshot; receipt: ProcedureEvaluationReceipt; landing: Extract<LandingDecision, { mode: "suggest" }>; now?: number }): string {
  const { snapshot, receipt, landing } = input, now = input.now ?? Date.now(), target = snapshot.target;
  const id = `${PROCEDURE_SUGGESTION_PREFIX}${sha256(JSON.stringify([target.ownerId, target.kind, target.artifactId, receipt.candidateHash])).slice(0, 32)}`;
  const existing = readRow(db, id);
  const base: Row = {
    schema: 1, id, kind: "suggestion", status: "complete", scopeId: snapshot.scopeId, botId: target.ownerId, state: "suggested", version: 1, notNowCount: 0,
    reasons: landing.reasons, label: landing.label, targetKind: target.kind === "routine" ? "routine" : "skill", target: structuredClone(target),
    evidence: snapshot.evidence.map(({ kind, id: evidenceId, revision }) => ({ kind, id: evidenceId, revision })), evidenceDigest: snapshot.evidenceDigest,
    proposedText: receipt.candidate, proposedHash: receipt.candidateHash, beforeText: landing.beforeText, beforeSha256: landing.beforeSha256,
    snapshot: structuredClone(snapshot), receipt: structuredClone(receipt), createdAt: now, decidedAt: null,
    policyRevision: snapshot.policyRevision, deletionEpoch: snapshot.deletionEpoch, learningRevision: snapshot.learningRevision,
  };
  if (existing) {
    if (existing.state === "suggested" && existing.snapshot) return id;
    if (existing.state === "hidden" && existing.evidenceDigest === snapshot.evidenceDigest) return id;
    if (existing.state === "applied" && existing.beforeSha256 === landing.beforeSha256) return id;
    base.version = existing.version + 1;
    base.notNowCount = existing.state === "retired" ? existing.notNowCount : 0;
  }
  writeRow(db, base);
  recordLearningEvent(db, { kind: "guide-suggested", scopeId: snapshot.scopeId, botId: target.ownerId, now, detail: { procedure: 1, kind: base.targetKind, label: base.label, reasons: base.reasons, suggestionId: id } });
  return id;
}

export function listProcedureSuggestions(db: DatabaseSync, botId: string): ProcedureSuggestionView[] {
  return (db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='procedure-review' AND id LIKE ? AND state='granted' ORDER BY rowid").all(`${PROCEDURE_SUGGESTION_PREFIX}%`) as Array<{ intent: string }>)
    .flatMap(row => { try { return [JSON.parse(row.intent) as Row]; } catch { return []; } })
    .filter(row => row.kind === "suggestion" && row.botId === botId && row.state === "suggested" && row.status === "complete" && row.snapshot)
    // A card whose skill or routine has changed since is no longer an offer: it would be refused as stale.
    .filter(row => { const now = landingHost?.base(row.target); return !landingHost || (now !== null && now !== undefined && now.revision === row.target.baseRevision && now.sha256 === row.beforeSha256); })
    .map(view);
}

const pending = (db: DatabaseSync, botId: string, id: string, expectedVersion: number): Row => {
  const row = readRow(db, id);
  if (!row || row.botId !== botId || row.status !== "complete" || !row.snapshot) throw httpError("There is no such suggestion.", 404, "NOT_FOUND");
  if (row.state !== "suggested") throw httpError("This is not waiting for a decision.", 409, "CONFLICT");
  if (row.version !== expectedVersion) throw httpError("This suggestion changed elsewhere. Refresh and try again.", 409, "REVISION_CONFLICT");
  return row;
};

/** Apply: publishes exactly the words the owner was shown, if the skill or routine is still as it was. Written as an outbox: the intent (the ledger row
 * in state "publishing", naming the intended text) is committed first, then the skill or routine changes, then a second commit marks it applied. A failure
 * or a crash between them is reconciled from the text itself (reconcilePublishing): the intended text means applied, the previous text means failed and the
 * suggestion stays suggested, anything else is shown to the owner as needing a look. */
export function applyProcedureSuggestion(db: DatabaseSync, input: { botId: string; id: string; expectedVersion: number; proposedHash?: string; now?: number }): ProcedureSuggestionView {
  const now = input.now ?? Date.now();
  requireOwnTransaction(db);
  // The gate first, before the card is even read: nothing below can publish while memory is held or still being gone over.
  assertMemoryGate(db, "publish-procedure");
  // A change this card left half done by an earlier failure is settled before another is started.
  const left = readRow(db, input.id);
  if (left) for (const pointer of outboxFor(db, left)) reconcilePublishing(db, pointer, now);
  const row = pending(db, input.botId, input.id, input.expectedVersion);
  const text = finalText(row);
  if (input.proposedHash !== undefined && input.proposedHash !== sha256(text)) throw httpError("This suggestion changed elsewhere. Refresh and try again.", 409, "REVISION_CONFLICT");
  if (!landingHost) throw httpError("This cannot be applied right now.", 409, "CONFLICT");
  const stale = () => httpError("This changed since it was suggested, so it was not applied.", 409, "STALE");
  const current = landingHost.base(row.target);
  if (!current || current.revision !== row.target.baseRevision || current.sha256 !== row.beforeSha256) throw stale();
  const check = procedureHardCheck(row.beforeText, text);
  if (!check.ok) throw httpError("A change can only change how it works, not what it may do.", 422, "INVALID_CHANGE");
  const edited = row.editedText !== undefined;
  const receiptId = edited ? `owner-edit:${sha256(text)}` : row.receipt!.id;
  const host = landingHost;
  // commit 1: the intent, durable before the files change
  const ledgerId = atomically(db, () => {
    assertMemoryGate(db, "publish-procedure");
    return recordAppliedChange(db, { ...host.describe(row.snapshot!, text, receiptId, row.beforeSha256, row.label), via: edited ? "edit" : "suggestion" }, now, { publishing: true, suggestionId: row.id });
  });
  let thrown: unknown;
  try {
    assertMemoryGate(db, "publish-procedure");
    try {
      if (edited) host.publishEdited(row.snapshot!, text, receiptId);
      else host.publishEvaluated(row.snapshot!, row.receipt!);
    } catch (error) { if ((error as { code?: string }).code === "MEMORY_HELD" || (error as { code?: string }).code === "MEMORY_PENDING") throw error; throw stale(); }
    // commit 2: it landed
    const landed = host.describe(row.snapshot!, text, receiptId, row.beforeSha256, row.label);
    atomically(db, () => settleAppliedChange(db, ledgerId, landed.afterRevision, now));
    return view({ ...row, state: "applied", decidedAt: now });
  } catch (error) { thrown = error; }
  // a refused or failed publication, or a failed second commit: settle the row from what the text is now, before the error leaves
  const settled = reconcilePublishing(db, ledgerId, now);
  if (settled === "applied") return view({ ...row, state: "applied", decidedAt: now });
  throw thrown;
}
/** The outbox entries (ledger rows still publishing) of one suggestion card. */
function outboxFor(db: DatabaseSync, row: Row): string[] {
  const out: string[] = [];
  for (const pointer of db.prepare("SELECT intent FROM memory_scope_bindings WHERE id>=? AND id<? ORDER BY id LIMIT 50").all(OUTBOX_PREFIX, "procedure-outbox;") as Array<{ intent: string }>) {
    try {
      const eventId = String(JSON.parse(pointer.intent).eventId ?? "");
      const event = db.prepare("SELECT detail FROM memory_learning_events WHERE id=?").get(eventId) as { detail: string } | undefined;
      if (event && safeDetail(event).suggestionId === row.id) out.push(eventId);
    } catch { /* an unreadable pointer is the sweep's to drop */ }
  }
  return out;
}

/** Edit: new words, scores dropped, still waiting. */
export function editProcedureSuggestion(db: DatabaseSync, input: { botId: string; id: string; expectedVersion: number; text: string; now?: number }): ProcedureSuggestionView {
  const row = pending(db, input.botId, input.id, input.expectedVersion);
  const text = String(input.text ?? "");
  const check = procedureHardCheck(row.beforeText, text);
  if (!check.ok) throw httpError(check.reason === "empty" ? "Write what it should do." : "A change can only change how it works, not what it may do.", 400, "INVALID_CHANGE");
  const next: Row = { ...row, editedText: text, version: row.version + 1, receipt: undefined };
  writeRow(db, next);
  return view(next);
}

/** Not now: the first only puts it away; a second on the same suggestion hides it until new evidence arrives
 * and records the owner's no as negative feedback. */
export function notNowProcedureSuggestion(db: DatabaseSync, input: { botId: string; id: string; expectedVersion: number; now?: number }): { id: string; negativeFeedback: boolean } {
  const now = input.now ?? Date.now();
  const row = pending(db, input.botId, input.id, input.expectedVersion);
  const second = row.notNowCount >= 1;
  writeRow(db, { ...row, state: second ? "hidden" : "retired", notNowCount: row.notNowCount + 1, decidedAt: now });
  if (second && memoryGate(db, "feedback-write") === "ok") {
    // thread_id stays empty so this never shows up as "recent feedback" in a conversation.
    db.prepare("INSERT OR IGNORE INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at) VALUES(?,?,NULL,NULL,NULL,NULL,?,'-',2,NULL,1,'detected','bot',NULL,?)")
      .run(`fb_${sha256(`${row.id}:${row.notNowCount + 1}`).slice(0, 24)}`, row.botId, `procedure-suggestion:${row.targetKind}`, now);
  }
  return { id: row.id, negativeFeedback: second };
}

