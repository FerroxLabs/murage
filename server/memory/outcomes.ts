// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot learning, batch B1: outcomes and the signals around them (design
// sections 6, 8 and 16). What lives here:
//   - the outcome mark: one tap on a bot's reply (Won / Lost for a selling bot,
//     Good / Bad for the others), then an optional value and reason;
//   - the proposed outcome: an agent may only PROPOSE ("This looks closed.
//     Won?"); it counts for nothing until the owner answers, and "Not yet"
//     records nothing;
//   - passive signals, each stored as a memory_feedback row: an approval or
//     refusal at the decision site (the owner's own answer only), an owner edit
//     of a bot draft (with a word diff), and the weak negatives (re-ask,
//     stop, rewind) that can never form a lesson alone;
//   - expiry of proposals and weak signals.
// Rows live in the B0 tables (memory_outcomes, memory_feedback). This file is
// the logic and has no side effects; outcomes-routes.ts claims the routes and
// watches the decision site. Nothing here edits server/index.ts or
// memory/schema.ts; what must live in index.ts is in INTEGRATOR-PATCHES/b1.md.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redactSecretsInText } from "../redact.ts";
import { isOutcomeKind, type OutcomeKind, type OutcomeState, type OutcomeView } from "../../shared/outcome-choices.ts";
export type { OutcomeState, OutcomeView };
import { readBotLearning } from "../bot-learning.ts";
import { classifyEdit, planEditLesson, type EditKind, type LessonPlan } from "./feedback.ts";
import type { LearningRouteAnswer } from "../bot-learning-routes.ts";

export const PROPOSAL_TTL_MS = 14 * 24 * 3600_000;
export const WEAK_SIGNAL_TTL_MS = 30 * 24 * 3600_000;
const PROPOSALS_PER_DAY = 1;
/** After the owner taps Not yet, the bot does not ask about that conversation again for a week. */
export const NOT_YET_QUIET_MS = 7 * 24 * 3600_000;
const REASON_MAX = 280;
const NOTE_MAX = 140;
const EDIT_TEXT_MAX = 2000;
const VALUE_MAX = 1e12;

export class OutcomeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new OutcomeError(message, status, code); };

// ---------------------------------------------------------------- shapes

export type OutcomeRow = {
  id: string; bot_id: string; thread_id: string | null; kind: string; label: string | null; reason: string | null;
  value_num: number | null; currency: string | null; proposed_by: "owner" | "bot" | "app"; confirmed_by: "owner" | null;
  source_event_key: string | null; superseded_by: string | null; expires_at: number | null; created_at: number; revoked_at: number | null;
};

/** The bot the caller belongs to. Only the fields read here. */
export interface LearningBotLike {
  id: string; name?: string; title?: string; description?: string; learning?: unknown; threadId?: string;
  tasks?: Array<{ threadId: string }>;
}
let botLookup: ((botId: string) => LearningBotLike | null | undefined) | undefined;
/** index.ts hands over the bot lookup once (INTEGRATOR-PATCHES/b1.md). Without
 * it no passive signal is kept: the decision site cannot tell whether the bot
 * learns, so it learns nothing. */
export function setOutcomeBotLookup(lookup: ((botId: string) => LearningBotLike | null | undefined) | undefined): void { botLookup = lookup; }
export const lookupOutcomeBot = (botId: string): LearningBotLike | null | undefined => botLookup?.(botId);
export const hasOutcomeBotLookup = (): boolean => botLookup !== undefined;

// ---------------------------------------------------------------- helpers

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  const nested = db.isTransaction;
  const point = `outcomes_${randomUUID().replace(/-/g, "")}`;
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec(nested ? `RELEASE ${point}` : "COMMIT");
    return result;
  } catch (error) {
    try { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); } catch { /* keep the first error */ }
    throw error;
  }
}

const cleanText = (value: unknown, max: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return fail(400, "OUTCOME_INVALID", `${field} must be text`);
  const text = redactSecretsInText(value.trim());
  if (!text) return null;
  if (text.length > max) return fail(400, "OUTCOME_INVALID", `${field} can be at most ${max} characters`);
  return text;
};
function cleanValue(value: unknown, currency: unknown): { value: number | null; currency: string | null } {
  if (value === undefined || value === null || value === "") return { value: null, currency: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > VALUE_MAX) return fail(400, "OUTCOME_INVALID", "value must be a number from 0 up");
  if (currency === undefined || currency === null || currency === "") return { value, currency: null };
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return fail(400, "OUTCOME_INVALID", "currency must be a three letter code such as USD");
  return { value, currency: currency.toUpperCase() };
}
export const idOk = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^[\w.:-]{1,128}$/.test(value)) return fail(400, "OUTCOME_INVALID", `${field} is required`);
  return value;
};

const markKey = (messageId: string) => `mark:${messageId}`;
const proposalKey = (anchorId: string) => `proposal:${anchorId}`;
/** A superseded or undone row gives its key back so the message can be marked again. */
const retiredKey = (key: string, id: string) => `${key}#${id}`;
export const messageOfKey = (key: string | null): string | null => {
  const match = key ? /^(?:mark|proposal):([^#]+)/.exec(key) : null;
  return match ? match[1]! : null;
};
export const familyKey = (key: string | null) => (key ? key.split("#")[0]! : null);

export function familyCount(db: DatabaseSync, botId: string, key: string): number {
  return Number(db.prepare("SELECT COUNT(*) n FROM memory_outcomes WHERE bot_id=? AND (source_event_key=? OR substr(source_event_key,1,?)=?)")
    .get(botId, key, key.length + 1, `${key}#`)?.n ?? 0);
}
/** The revision of one message's outcome (0 when it has none). */
export function messageRevision(db: DatabaseSync, botId: string, messageId: string): number {
  return familyCount(db, botId, markKey(messageId)) + familyCount(db, botId, proposalKey(messageId));
}

function stateOf(row: OutcomeRow, now: number): OutcomeState {
  if (row.superseded_by) return "superseded";
  if (row.confirmed_by) return row.revoked_at ? "revoked" : "confirmed";
  if (row.revoked_at) return row.reason === "not-yet" ? "dismissed" : row.reason === "expired" ? "expired" : "revoked";
  return row.expires_at !== null && row.expires_at <= now ? "expired" : "proposed";
}
function view(db: DatabaseSync, row: OutcomeRow, now: number): OutcomeView {
  const key = familyKey(row.source_event_key);
  const proposal = !row.confirmed_by;
  return {
    id: row.id, botId: row.bot_id, threadId: row.thread_id, messageId: messageOfKey(row.source_event_key),
    kind: row.kind as OutcomeView["kind"], state: stateOf(row, now),
    reason: proposal && (row.reason === "not-yet" || row.reason === "expired") ? null : row.reason,
    value: row.value_num, currency: row.currency, note: proposal ? row.label : null,
    proposedBy: row.proposed_by, confirmedBy: row.confirmed_by,
    createdAt: row.created_at, expiresAt: row.expires_at,
    revision: key ? familyCount(db, row.bot_id, key) : 1,
  };
}
export const rowById = (db: DatabaseSync, botId: string, id: string): OutcomeRow => {
  const row = db.prepare("SELECT * FROM memory_outcomes WHERE id=? AND bot_id=?").get(id, botId) as OutcomeRow | undefined;
  return row ?? fail(404, "OUTCOME_NOT_FOUND", "no such outcome");
};

type MessageRow = { thread_id: string; role: string; kind: string; json: string };
function botReply(db: DatabaseSync, botId: string, threadId: string, messageId: string): void {
  const row = db.prepare("SELECT thread_id,role,kind,json FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId) as MessageRow | undefined;
  if (!row) return fail(404, "MESSAGE_NOT_FOUND", "no such message in that conversation");
  if (row.role !== "bot" || row.kind !== "text") return fail(422, "NOT_A_REPLY", "only a bot's reply can be marked");
  let from: string | undefined;
  try { from = (JSON.parse(row.json) as { from?: { botId?: string } }).from?.botId; } catch { /* a damaged row has no sender */ }
  if (from && from !== botId) fail(404, "MESSAGE_NOT_FOUND", "no such message for this bot");
}

/** Is this bot's conversation (its chat or one of its tasks), or a room message this bot wrote? */
export function conversationIsBots(db: DatabaseSync, bot: LearningBotLike, threadId: string, messageId: string): boolean {
  if (bot.threadId === threadId || bot.tasks?.some(task => task.threadId === threadId)) return true;
  const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId) as { json: string } | undefined;
  try { return Boolean(row) && (JSON.parse(row!.json) as { from?: { botId?: string } }).from?.botId === bot.id; } catch { return false; }
}

// ---------------------------------------------------------------- the mark

export interface MarkInput { botId: string; threadId: string; messageId: string; kind: unknown; reason?: unknown; value?: unknown; currency?: unknown; now?: number }

function insertOutcome(db: DatabaseSync, row: {
  id: string; botId: string; threadId: string | null; kind: string; label?: string | null; reason?: string | null; value?: number | null; currency?: string | null;
  proposedBy: "owner" | "bot" | "app"; confirmedBy: "owner" | null; key: string; expiresAt?: number | null; now: number;
}): void {
  db.prepare(`INSERT INTO memory_outcomes(id,bot_id,thread_id,kind,label,reason,value_num,currency,proposed_by,confirmed_by,source_event_key,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.botId, row.threadId, row.kind, row.label ?? null, row.reason ?? null, row.value ?? null, row.currency ?? null,
    row.proposedBy, row.confirmedBy, row.key, row.expiresAt ?? null, row.now);
}
function retire(db: DatabaseSync, row: OutcomeRow, supersededBy: string | null, now: number): void {
  db.prepare("UPDATE memory_outcomes SET source_event_key=?,superseded_by=?,revoked_at=COALESCE(revoked_at,?) WHERE id=?")
    .run(row.source_event_key ? retiredKey(row.source_event_key, row.id) : null, supersededBy, now, row.id);
  // The win chip said "kept as a win". That mark is gone, so the chip goes with it. A replacement
  // that is still a win earns its own chip from the route.
  db.prepare(`UPDATE memory_learning_events SET undone_at=? WHERE bot_id=? AND kind='outcome-marked' AND undone_at IS NULL
    AND json_extract(detail,'$.chip')=1 AND json_extract(detail,'$.exemplarKey')=?`).run(now, row.bot_id, `outcome:${row.id}`);
}
const liveMark = (db: DatabaseSync, botId: string, messageId: string) =>
  db.prepare("SELECT * FROM memory_outcomes WHERE bot_id=? AND source_event_key=? AND revoked_at IS NULL AND superseded_by IS NULL").get(botId, markKey(messageId)) as OutcomeRow | undefined;

/** One tap. The mark is the owner's own act, so it is the confirmation. */
export function markOutcome(db: DatabaseSync, input: MarkInput): OutcomeView {
  const now = input.now ?? Date.now();
  const botId = idOk(input.botId, "botId"), threadId = idOk(input.threadId, "threadId"), messageId = idOk(input.messageId, "messageId");
  if (!isOutcomeKind(input.kind)) fail(400, "OUTCOME_INVALID", "kind must be won, lost, good or bad");
  const kind = input.kind as OutcomeKind;
  const reason = cleanText(input.reason, REASON_MAX, "reason");
  const { value, currency } = cleanValue(input.value, input.currency);
  botReply(db, botId, threadId, messageId);
  return inTransaction(db, () => {
    const current = liveMark(db, botId, messageId);
    if (current && current.kind === kind && current.reason === reason && current.value_num === value && current.currency === currency) return view(db, current, now);
    const id = randomUUID();
    if (current) retire(db, current, id, now);
    insertOutcome(db, { id, botId, threadId, kind, reason, value, currency, proposedBy: "owner", confirmedBy: "owner", key: markKey(messageId), now });
    // The owner just answered the question a proposal in this conversation asks.
    for (const open of db.prepare("SELECT * FROM memory_outcomes WHERE bot_id=? AND thread_id=? AND confirmed_by IS NULL AND revoked_at IS NULL").all(botId, threadId) as OutcomeRow[]) retire(db, open, id, now);
    return view(db, rowById(db, botId, id), now);
  });
}

export type OutcomeChange = { revoke: true } | { kind?: unknown; reason?: unknown; value?: unknown; currency?: unknown };
/** Edit the details of a confirmed mark (a new row supersedes the old one) or undo it. */
export function changeOutcome(db: DatabaseSync, input: { botId: string; id: string; change: OutcomeChange; now?: number }): OutcomeView {
  const now = input.now ?? Date.now();
  const row = rowById(db, input.botId, input.id);
  if (!row.confirmed_by || row.superseded_by || row.revoked_at) return fail(409, "OUTCOME_NOT_CURRENT", "that mark was already changed");
  const change = input.change as Record<string, unknown>;
  return inTransaction(db, () => {
    if (change.revoke === true) { retire(db, row, null, now); return view(db, rowById(db, input.botId, row.id), now); }
    const kind = change.kind === undefined ? row.kind : change.kind;
    if (!isOutcomeKind(kind)) return fail(400, "OUTCOME_INVALID", "kind must be won, lost, good or bad");
    const reason = change.reason === undefined ? row.reason : cleanText(change.reason, REASON_MAX, "reason");
    const { value, currency } = change.value === undefined && change.currency === undefined
      ? { value: row.value_num, currency: row.currency }
      : cleanValue(change.value === undefined ? row.value_num : change.value, change.currency === undefined ? row.currency : change.currency);
    if (kind === row.kind && reason === row.reason && value === row.value_num && currency === row.currency) return view(db, row, now);
    const id = randomUUID();
    const key = familyKey(row.source_event_key)!;
    retire(db, row, id, now);
    insertOutcome(db, { id, botId: row.bot_id, threadId: row.thread_id, kind, reason, value, currency, label: row.label, proposedBy: row.proposed_by, confirmedBy: "owner", key, now });
    return view(db, rowById(db, input.botId, id), now);
  });
}

// ---------------------------------------------------------------- proposals

/** The agent's tool lands here. It can only propose: the row has no
 * confirmation, and nothing reads it as an outcome until the owner answers. */
export function proposeOutcomeFromAgent(db: DatabaseSync, input: { botId: string; threadId: string; note?: unknown; now?: number }): LearningRouteAnswer {
  const now = input.now ?? Date.now();
  try {
    const botId = idOk(input.botId, "botId"), threadId = idOk(input.threadId, "threadId");
    const note = cleanText(input.note, NOTE_MAX, "note");
    expireOutcomes(db, now);
    const anchor = db.prepare("SELECT id FROM messages WHERE thread_id=? AND role='user' AND kind='text' ORDER BY at DESC,rowid DESC LIMIT 1").get(threadId) as { id: string } | undefined;
    if (!anchor) return { status: 422, body: { error: "There is nothing to propose an outcome for yet.", code: "NOTHING_TO_PROPOSE" } };
    return inTransaction(db, () => {
      const existing = db.prepare("SELECT * FROM memory_outcomes WHERE bot_id=? AND source_event_key=?").get(botId, proposalKey(anchor.id)) as OutcomeRow | undefined;
      if (existing) return { status: 200, body: { created: false, outcome: view(db, existing, now) } };
      const open = db.prepare("SELECT * FROM memory_outcomes WHERE bot_id=? AND thread_id=? AND confirmed_by IS NULL AND revoked_at IS NULL AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 1").get(botId, threadId, now) as OutcomeRow | undefined;
      if (open) return { status: 200, body: { created: false, outcome: view(db, open, now) } };
      if (db.prepare("SELECT 1 FROM memory_outcomes WHERE bot_id=? AND thread_id=? AND reason='not-yet' AND revoked_at>? LIMIT 1").get(botId, threadId, now - NOT_YET_QUIET_MS)) return { status: 429, body: { error: "The owner said not yet about this conversation. Do not ask again for a few days.", code: "ASKED_RECENTLY" } };
      const today = Number(db.prepare("SELECT COUNT(*) n FROM memory_outcomes WHERE bot_id=? AND thread_id=? AND proposed_by='bot' AND created_at>?").get(botId, threadId, now - 24 * 3600_000)?.n ?? 0);
      if (today >= PROPOSALS_PER_DAY) return { status: 429, body: { error: "You have asked about this conversation enough for today.", code: "TOO_MANY_PROPOSALS" } };
      const id = randomUUID();
      insertOutcome(db, { id, botId, threadId, kind: "open", label: note, proposedBy: "bot", confirmedBy: null, key: proposalKey(anchor.id), expiresAt: now + PROPOSAL_TTL_MS, now });
      return { status: 200, body: { created: true, outcome: view(db, rowById(db, botId, id), now) } };
    });
  } catch (error) {
    if (error instanceof OutcomeError) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}

/** The owner's tap on the card: Won, Lost (or Good, Bad) or Not yet. */
export function answerProposal(db: DatabaseSync, input: { botId: string; id: string; answer: unknown; reason?: unknown; value?: unknown; currency?: unknown; now?: number }): OutcomeView {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const row = rowById(db, input.botId, input.id);
    if (row.confirmed_by || row.superseded_by) return fail(409, "ALREADY_ANSWERED", "that question was already answered");
    if (row.revoked_at) return fail(409, "ALREADY_ANSWERED", row.reason === "expired" ? "that question has expired" : "that question was already answered");
    if (row.expires_at !== null && row.expires_at <= now) return fail(410, "PROPOSAL_EXPIRED", "that question has expired");
    if (input.answer === "not-yet") {
      db.prepare("UPDATE memory_outcomes SET revoked_at=?,reason='not-yet' WHERE id=?").run(now, row.id);
      return view(db, rowById(db, input.botId, row.id), now);
    }
    if (!isOutcomeKind(input.answer)) return fail(400, "OUTCOME_INVALID", "answer must be won, lost, good, bad or not-yet");
    const reason = cleanText(input.reason, REASON_MAX, "reason");
    const { value, currency } = cleanValue(input.value, input.currency);
    db.prepare("UPDATE memory_outcomes SET kind=?,confirmed_by='owner',reason=?,value_num=?,currency=?,expires_at=NULL WHERE id=?").run(input.answer, reason, value, currency, row.id);
    return view(db, rowById(db, input.botId, row.id), now);
  });
}

// ---------------------------------------------------------------- reads, counts, expiry

export function listOutcomes(db: DatabaseSync, input: { botId: string; threadId?: string; state?: "live" | "proposed" | "confirmed" | "all"; limit?: number; now?: number }): OutcomeView[] {
  const now = input.now ?? Date.now();
  expireOutcomes(db, now);
  const rows = db.prepare(`SELECT * FROM memory_outcomes WHERE bot_id=? ${input.threadId ? "AND thread_id=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT ?`)
    .all(...(input.threadId ? [input.botId, input.threadId] : [input.botId]), Math.min(Math.max(input.limit ?? 200, 1), 500)) as OutcomeRow[];
  const wanted = input.state ?? "live";
  return rows.map(row => view(db, row, now)).filter(item =>
    wanted === "all" ? true : wanted === "confirmed" ? item.state === "confirmed" : wanted === "proposed" ? item.state === "proposed" : item.state === "confirmed" || item.state === "proposed");
}

export function outcomeCounts(db: DatabaseSync, botId: string): { won: number; lost: number; good: number; bad: number; proposed: number } {
  const counts = { won: 0, lost: 0, good: 0, bad: 0, proposed: 0 };
  for (const row of db.prepare("SELECT kind,COUNT(*) n FROM memory_outcomes WHERE bot_id=? AND confirmed_by='owner' AND revoked_at IS NULL AND superseded_by IS NULL GROUP BY kind").all(botId) as Array<{ kind: string; n: number }>) {
    if (row.kind in counts) (counts as Record<string, number>)[row.kind] = Number(row.n);
  }
  counts.proposed = Number(db.prepare("SELECT COUNT(*) n FROM memory_outcomes WHERE bot_id=? AND confirmed_by IS NULL AND revoked_at IS NULL AND superseded_by IS NULL").get(botId)?.n ?? 0);
  return counts;
}

/** Retire proposals nobody answered, and weak signals nobody built on. */
export function expireOutcomes(db: DatabaseSync, now = Date.now()): void {
  db.prepare("UPDATE memory_outcomes SET revoked_at=?,reason='expired' WHERE confirmed_by IS NULL AND revoked_at IS NULL AND superseded_by IS NULL AND expires_at IS NOT NULL AND expires_at<=?").run(now, now);
  db.prepare(`UPDATE memory_feedback SET state='expired' WHERE state='detected' AND created_at<=? AND target_action IN (${WEAK_SIGNAL_ACTIONS.map(() => "?").join(",")})`)
    .run(now - WEAK_SIGNAL_TTL_MS, ...WEAK_SIGNAL_ACTIONS);
}

// ---------------------------------------------------------------- passive signals

export const WEAK_SIGNAL_ACTIONS = ["reask", "stop", "rewind"] as const;
export type WeakSignalAction = (typeof WEAK_SIGNAL_ACTIONS)[number];

/** How a stored signal may be used. A weak signal never forms a lesson alone;
 * an approval says what the owner permits and is a quality signal only when
 * the owner added a reason; an edit is the owner showing the right way. */
export function signalClass(row: { target_action: string | null; correction: string | null }): "weak" | "permission" | "quality" {
  const action = row.target_action ?? "";
  if ((WEAK_SIGNAL_ACTIONS as readonly string[]).includes(action)) return "weak";
  if (action.startsWith("approval:")) return row.correction ? "quality" : "permission";
  return "quality";
}

function passiveAllowed(db: DatabaseSync, bot: LearningBotLike | null | undefined, threadId: string): boolean {
  if (!bot || !readBotLearning(bot).enabled) return false;
  if (db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode === "off") return false;
  return !db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=? LIMIT 1").get(threadId);
}
function insertFeedback(db: DatabaseSync, row: { turnId?: string | null; id: string; botId: string; threadId: string; targetMessageId?: string | null; action: string; polarity: "+" | "-"; strength: 1 | 2 | 3; correction?: string | null; confidence: number; messageId?: string | null; now: number }): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'detected','chat',?)`).run(row.id, row.botId, row.threadId, row.messageId ?? null, row.targetMessageId ?? null, row.turnId ?? null, row.action, row.polarity, row.strength, row.correction ?? null, row.confidence, row.now);
  return Number(result.changes) > 0;
}

/** The owner approved or refused something. Called from the decision log for
 * the owner's own answer only (source "user"); a rule, a grant or Auto never
 * lands here. Returns false when nothing new was kept. */
export function captureApprovalDecision(db: DatabaseSync, input: { botId: string; threadId: string; requestId: string; tool?: string; approved: boolean; reason?: string; now?: number }, bot: LearningBotLike | null | undefined): boolean {
  if (!input.requestId || !passiveAllowed(db, bot, input.threadId)) return false;
  const reason = cleanText(input.reason, REASON_MAX, "reason");
  const tool = redactSecretsInText(String(input.tool ?? "action")).replace(/[^\w .:-]/g, "").slice(0, 60) || "action";
  return insertFeedback(db, { id: `approval:${input.requestId}`, botId: input.botId, threadId: input.threadId, action: `approval:${tool}`,
    polarity: input.approved ? "+" : "-", strength: reason ? 2 : 1, correction: reason, confidence: reason ? 0.8 : 1, now: input.now ?? Date.now() });
}

/** Re-ask, stop pressed or rewind: a weak negative, kept once per target. */
export function recordWeakSignal(db: DatabaseSync, input: { botId: string; threadId: string; action: WeakSignalAction; targetMessageId?: string | null; now?: number }, bot: LearningBotLike | null | undefined): boolean {
  if (!(WEAK_SIGNAL_ACTIONS as readonly string[]).includes(input.action) || !passiveAllowed(db, bot, input.threadId)) return false;
  const now = input.now ?? Date.now();
  return insertFeedback(db, { id: `weak:${input.action}:${input.threadId}:${input.targetMessageId ?? Math.floor(now / 60_000)}`, botId: input.botId, threadId: input.threadId,
    targetMessageId: input.targetMessageId, action: input.action, polarity: "-", strength: 1, confidence: 0.3, now });
}

/** The owner pressed Stop on a turn: a weak negative aimed at the bot's latest reply in that conversation. */
export function recordStopForThread(db: DatabaseSync, bot: LearningBotLike | null | undefined, threadId: string, now = Date.now()): boolean {
  if (!bot) return false;
  const last = db.prepare("SELECT id FROM messages WHERE thread_id=? AND role='user' AND kind='text' ORDER BY at DESC,rowid DESC LIMIT 1").get(threadId) as { id: string } | undefined;
  // Aimed at what the owner last asked: the turn that was stopped answers it.
  return recordWeakSignal(db, { botId: bot.id, threadId, action: "stop", targetMessageId: last?.id ?? null, now }, bot);
}

// ---------------------------------------------------------------- re-ask and owner edits

const tokens = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const STOP = new Set(["the", "a", "an", "to", "of", "and", "is", "it", "you", "can", "please", "i", "me", "my", "for", "on", "in", "that", "this", "do", "we"]);
const meaningful = (text: string) => new Set(tokens(text).filter(word => !STOP.has(word)));

/** The index of the earlier message (most recent first) the new one repeats, or -1. */
export function detectReask(text: string, priorUserTexts: string[]): number {
  const now = meaningful(text);
  if (now.size < 3) return -1;
  for (let index = 0; index < Math.min(priorUserTexts.length, 3); index += 1) {
    const before = meaningful(priorUserTexts[index]!);
    if (before.size < 3) continue;
    let shared = 0;
    for (const word of now) if (before.has(word)) shared += 1;
    if (shared / (now.size + before.size - shared) >= 0.6) return index;
  }
  return -1;
}

export interface OwnerEditDiff { similarity: number; added: string[]; removed: string[]; summary: string }
const WORD_CAP = 600;
/** A word diff of what the owner changed. Similarity is 1 for no change. */
export function diffOwnerEdit(original: string, edited: string): OwnerEditDiff {
  const a = original.split(/\s+/).filter(Boolean).slice(0, WORD_CAP), b = edited.split(/\s+/).filter(Boolean).slice(0, WORD_CAP);
  if (!a.length && !b.length) return { similarity: 1, added: [], removed: [], summary: "No change" };
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1)
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i += 1; j += 1; }
    else if (j < b.length && (i === a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { added.push(b[j]!); j += 1; }
    else { removed.push(a[i]!); i += 1; }
  }
  const similarity = (2 * table[0]![0]!) / (a.length + b.length);
  const plural = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;
  return { similarity, added, removed, summary: `Removed ${plural(removed.length)}, added ${plural(added.length)}` };
}

const EDIT_MIN_SIMILARITY = 0.5, EDIT_MAX_SIMILARITY = 0.98, EDIT_MIN_WORDS = 12;
/** The recent bot reply this owner message looks like an edited copy of. */
export function detectOwnerEditedDraft(text: string, recentBotReplies: Array<{ id: string; text: string }>): { id: string; text: string } | null {
  if (text.split(/\s+/).filter(Boolean).length < EDIT_MIN_WORDS) return null;
  let best: { reply: { id: string; text: string }; similarity: number } | null = null;
  for (const reply of recentBotReplies) {
    if (reply.text.split(/\s+/).filter(Boolean).length < EDIT_MIN_WORDS) continue;
    const { similarity } = diffOwnerEdit(reply.text, text);
    if (similarity >= EDIT_MIN_SIMILARITY && similarity < EDIT_MAX_SIMILARITY && (!best || similarity > best.similarity)) best = { reply, similarity };
  }
  return best?.reply ?? null;
}

/** Where an owner can change a bot's draft before it goes out, as inventoried
 * for B1 (lanes/bot-evolution design section 6). Only the one that exists is wired. */
export const OWNER_EDIT_SURFACES: ReadonlyArray<{ id: string; wired: boolean; why: string }> = Object.freeze([
  { id: "pasted-draft", wired: true, why: "The owner copies a bot reply into the composer, edits it and sends it. Detected from the sent message against the bot's recent replies (observeOwnerMessage)." },
  { id: "message-fork", wired: false, why: "Editing a message forks the thread at the owner's OWN message (store.ts parentId); it edits the owner's words, not a bot draft. It already counts as a rewind (weak) signal." },
  { id: "approval-card", wired: false, why: "Approval cards offer fixed options only (ApprovalCard.tsx); there is no field to edit what the bot proposed. Wire here if one is added." },
  { id: "connected-app-draft", wired: false, why: "Drafts for connected apps are created and sent through the app's own tools; Murage has no edit step in between. Wire here when it gains one." },
]);

/** An owner edit of a bot draft, kept as a clear signal when the words really
 * changed (not a copy, not a different text). */
export function captureOwnerEdit(db: DatabaseSync, input: { botId: string; threadId: string; surface: string; originalMessageId: string; editedMessageId: string; original: string; edited: string; now?: number }, bot: LearningBotLike | null | undefined): boolean {
  if (!passiveAllowed(db, bot, input.threadId)) return false;
  const diff = diffOwnerEdit(input.original, input.edited);
  if (diff.similarity < EDIT_MIN_SIMILARITY || diff.similarity >= EDIT_MAX_SIMILARITY) return false;
  const edited = redactSecretsInText(input.edited).slice(0, EDIT_TEXT_MAX);
  const kinds = classifyEdit(input.original, input.edited);
  const id = `edit:${input.editedMessageId}`, now = input.now ?? Date.now();
  const stored = insertFeedback(db, { id, botId: input.botId, threadId: input.threadId, messageId: input.editedMessageId, targetMessageId: input.originalMessageId, turnId: editKindsTag(kinds),
    action: `edit:${input.surface.replace(/[^\w-]/g, "").slice(0, 40)}`, polarity: "-", strength: diff.similarity < 0.8 ? 3 : 2, correction: edited, confidence: 0.7, now });
  // The same kind of edit twice becomes a lesson (design 7); the first one is only recent feedback.
  if (stored && kinds.length && editLessonSink) {
    try {
      const prior: Partial<Record<EditKind, number>> = {};
      for (const kind of kinds) prior[kind] = Number(db.prepare("SELECT COUNT(*) c FROM memory_feedback WHERE bot_id=? AND target_action LIKE 'edit:%' AND id<>? AND state<>'ignored' AND target_turn_id LIKE ?").get(input.botId, id, `%|${kind}|%`)?.c ?? 0);
      for (const plan of planEditLesson(input.botId, kinds, prior, { askFirst: false }, db, now)) editLessonSink(plan, { botId: input.botId, threadId: input.threadId, replyMessageId: input.originalMessageId, sourceMessageId: input.editedMessageId });
    } catch { /* a lesson is optional; the edit is already kept */ }
  }
  return stored;
}
/** Which kinds of change an edit made, kept beside the row so the repeat rule can count them without the draft text. */
export const editKindsTag = (kinds: readonly EditKind[]) => (kinds.length ? `|${kinds.join("|")}|` : null);
export const editKindsOf = (tag: unknown): EditKind[] => (typeof tag === "string" ? tag.split("|").filter(Boolean) as EditKind[] : []);
type EditLessonSink = (plan: LessonPlan, ctx: { botId: string; threadId: string; replyMessageId?: string; sourceMessageId?: string }) => string | null;
let editLessonSink: EditLessonSink | null = null;
/** wireBotLearning plugs the lesson sink in; null removes it. */
export function setEditLessonSink(next: EditLessonSink | null): void { editLessonSink = next; }

type HistoryMessage = { id: string; role?: string; kind?: string; text?: string; queued?: boolean; turnTerminal?: boolean; automation?: unknown };
/** Beside the capture of an owner's new message: a re-ask, or an edited copy
 * of the bot's draft. The owner only (not a routine, a webhook or a customer). */
export function observeOwnerMessage(db: DatabaseSync, bot: LearningBotLike | null | undefined, threadId: string, message: HistoryMessage & { at?: number }, history: HistoryMessage[], now = message.at ?? Date.now()): void {
  if (!bot || message.role !== "user" || message.kind !== "text" || message.queued || message.automation || !message.text) return;
  if (!passiveAllowed(db, bot, threadId)) return;
  const recent = history.slice(-40);
  const userTexts = recent.filter(item => item.role === "user" && item.kind === "text" && !item.queued && !item.automation && item.text).map(item => item.text!).reverse();
  const replies = recent.filter(item => item.role === "bot" && item.kind === "text" && item.text && (item.turnTerminal || item.turnTerminal === undefined)).map(item => ({ id: item.id, text: item.text! })).reverse();
  const reasked = detectReask(message.text, userTexts);
  if (reasked >= 0) {
    // Three turns back at most: the bot reply that sat between the two asks.
    recordWeakSignal(db, { botId: bot.id, threadId, action: "reask", targetMessageId: replies[0]?.id ?? null, now }, bot);
  }
  const draft = detectOwnerEditedDraft(message.text, replies.slice(0, 2));
  if (draft) captureOwnerEdit(db, { botId: bot.id, threadId, surface: "pasted-draft", originalMessageId: draft.id, editedMessageId: message.id, original: draft.text, edited: message.text, now }, bot);
}
