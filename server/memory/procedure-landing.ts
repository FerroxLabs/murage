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

/** Writes the ledger row for a change that has landed. The chip needs a reply to sit under;
 * with none, the row still shows under Recent changes. */
export function recordAppliedChange(db: DatabaseSync, change: AppliedChange, now: number = Date.now()): string {
  const reply = latestBotReply(db, change.threadId);
  const group = "improved" as const;
  const id = recordLearningEvent(db, {
    kind: "guide-applied", scopeId: change.scopeId, botId: change.ownerId, now,
    detail: { procedure: 1, ...change, group, template: pickTemplate(group, previousTemplate(db, change.ownerId, group), seedFor(db, change.ownerId, now)), replyMessageId: reply },
  }) as unknown as string;
  // Announced after the surrounding write has committed; the listener re-reads the row, so a rollback announces nothing.
  if (change.via === "automatic" && reply) { const listener = improvedListener; if (listener) setTimeout(() => { try { listener(id); } catch { /* the chip is optional; the change is already recorded */ } }, 0); }
  return id;
}

/** Chips under this thread's replies for automatic skill and routine changes. */
export function procedureChipItemsForThread(db: DatabaseSync, input: { botId: string; threadId: string; now?: number }): ChipItem[] {
  const now = input.now ?? Date.now();
  const rows = db.prepare(`SELECT * FROM memory_learning_events WHERE bot_id=? AND kind='guide-applied' AND json_extract(detail,'$.procedure')=1
    AND json_extract(detail,'$.threadId')=? AND json_extract(detail,'$.replyMessageId') IS NOT NULL AND (undone_at IS NULL OR undone_at>=?)
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
  const event = db.prepare("SELECT * FROM memory_learning_events WHERE id=? AND kind='guide-applied' AND undone_at IS NULL").get(eventId) as Record<string, any> | undefined;
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
    return { kind: detail.kind === "routine" ? "routine" : "skill", label: String(detail.label ?? ""), via: String(detail.via ?? "automatic"), state: event.undone_at === null ? "active" : "undone" };
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

/** Undo or Keep for a procedure change. Called from changeLearningEvent. */
export function changeProcedureEvent(db: DatabaseSync, event: Record<string, any>, action: "undo" | "keep", now: number = Date.now()) {
  const eventId = String(event.id);
  if (action === "keep") {
    if (event.undone_at !== null) throw httpError("This learning item cannot be changed.", 409);
    if (event.kept_at === null) db.prepare("UPDATE memory_learning_events SET kept_at=? WHERE id=?").run(now, eventId);
    return { ok: true, eventId, kept: true };
  }
  if (event.undone_at !== null) return { ok: true, eventId, undone: true };
  const detail = safeDetail(event) as AppliedChange & Record<string, any>;
  if (!landingHost) throw httpError("This learning item cannot be changed.", 409);
  const result = landingHost.rollback(detail);
  if (!result.ok) throw httpError("This changed since it was updated. Open its history to review the current version.", 409);
  db.prepare("UPDATE memory_learning_events SET undone_at=? WHERE id=?").run(now, eventId);
  recordLearningEvent(db, { kind: "guide-undone", scopeId: String(event.scope_id), botId: event.bot_id === null ? null : String(event.bot_id), now, detail: { procedure: 1, kind: detail.kind, label: detail.label, appliedEventId: eventId } });
  return { ok: true, eventId, undone: true };
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

/** Apply: publishes exactly the words the owner was shown, if the skill or routine is still as it was. */
export function applyProcedureSuggestion(db: DatabaseSync, input: { botId: string; id: string; expectedVersion: number; proposedHash?: string; now?: number }): ProcedureSuggestionView {
  const now = input.now ?? Date.now();
  const row = pending(db, input.botId, input.id, input.expectedVersion);
  const text = finalText(row);
  if (input.proposedHash !== undefined && input.proposedHash !== sha256(text)) throw httpError("This suggestion changed elsewhere. Refresh and try again.", 409, "REVISION_CONFLICT");
  if (!landingHost) throw httpError("This cannot be applied right now.", 409, "CONFLICT");
  // A refused Apply rolls its transaction back, so nothing is written here: the card drops out of the list on its own (see listProcedureSuggestions).
  const stale = () => httpError("This changed since it was suggested, so it was not applied.", 409, "STALE");
  const current = landingHost.base(row.target);
  if (!current || current.revision !== row.target.baseRevision || current.sha256 !== row.beforeSha256) throw stale();
  const check = procedureHardCheck(row.beforeText, text);
  if (!check.ok) throw httpError("A change can only change how it works, not what it may do.", 422, "INVALID_CHANGE");
  const edited = row.editedText !== undefined;
  const receiptId = edited ? `owner-edit:${sha256(text)}` : row.receipt!.id;
  try {
    if (edited) landingHost.publishEdited(row.snapshot!, text, receiptId);
    else landingHost.publishEvaluated(row.snapshot!, row.receipt!);
  } catch { throw stale(); }
  recordAppliedChange(db, { ...landingHost.describe(row.snapshot!, text, receiptId, row.beforeSha256, row.label), via: edited ? "edit" : "suggestion" }, now);
  const next: Row = { ...row, state: "applied", decidedAt: now };
  writeRow(db, next);
  return view(next);
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
  if (second) {
    // thread_id stays empty so this never shows up as "recent feedback" in a conversation.
    db.prepare("INSERT OR IGNORE INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at) VALUES(?,?,NULL,NULL,NULL,NULL,?,'-',2,NULL,1,'detected','bot',NULL,?)")
      .run(`fb_${sha256(`${row.id}:${row.notNowCount + 1}`).slice(0, 24)}`, row.botId, `procedure-suggestion:${row.targetKind}`, now);
  }
  return { id: row.id, negativeFeedback: second };
}

