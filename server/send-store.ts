// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one durable record of every message an owner has sent to a bot or a room.
//
// Acceptance IS a row in the same SQLite file the transcript uses. The server
// answers a send only after that row has committed, so a message the person was
// told about can never be lost to a failed side file, an in-memory queue or a
// restart. A row carries:
//   - a UNIQUE sendId (the client's idempotency key): a repeat finds the row
//     and never becomes a second dispatch;
//   - a sequence number: per thread, rows are dispatched in that order, and a
//     message waits behind any earlier one that has not resolved;
//   - a durable "dispatched" marker, written BEFORE anything reaches the engine:
//     a crash after the marker and before the engine's answer leaves the row
//     "unconfirmed" and shown to the person, never silently sent again.
//
// Statuses
//   sending      accepted, the server is deciding whether to run, steer or queue it
//   queued       waiting for the bot or room to be free
//   dispatched   the marker is written; the engine submission is in flight
//   started      a turn began from it (the transcript holds the line)
//   delivered    folded into the running turn (a steer the engine accepted)
//   unconfirmed  the engine may or may not have the words; never re-sent
//   failed       refused before anything ran; the same sendId may be tried again
//   refused      accepted, then the bot or room could not start it. The words are kept and shown
//                (a chip with "Send again" and "Dismiss"), until the person does one of them
//   cancelled    the owner cancelled it while it waited; a retry stays cancelled
//
// STATE TABLE (the one place the rules live; every transition has a test in send-store.test.ts)
// The invariant: an accepted owner send's WORDS are kept (here, or in a committed transcript
// line) until EITHER a transcript line holding them is committed OR the owner dismisses it.
// No transition below may clear them earlier. A state that is not a transcript line is a chip
// (words + Send again / Dismiss) or the unconfirmed line.
//
//   from          to           who performs it                                 words live in after it
//   (none)        sending      accept(): HTTP send, bot path                   this row
//   (none)        queued       accept(status queued): room/bot queue           this row
//   (none)        refused      accept(status refused): a room-queue request    this row (chip)
//   (none)        cancelled    acceptTypedStop(): a typed stop (TYPED-STOP-107) none (born finished)
//                              the dispatcher could not start or closed
//   sending       dispatched   markDispatched(): before the engine is asked    this row
//   sending       queued       queue(): earlier send unresolved / bot busy     this row
//   sending       queued       recover(): startup, no marker was written       this row
//   queued        dispatched   markDispatchedMany(): the drain, before running this row
//   dispatched    started      settleWithLine(): line + state, one transaction the transcript line
//   dispatched    started      settle(): the line is found in the transcript   the transcript line
//   dispatched    delivered    settleWithLine(): engine steered it             the transcript line
//   dispatched    unconfirmed  settleWithLine(): engine may have it            transcript line + this row
//                                                                              (until the late answer or turn end)
//   dispatched    unconfirmed  settle(): the line could not be written         this row (recovery writes the line)
//   dispatched    refused      refuse(): the drain could not write the line /  this row (chip)
//                              the room could not start it
//   dispatched    refused      refuse(): the HTTP send ended in an error and   this row (chip); a retry of the
//                              no line holds the words (a bot that left, a     same send id replaces the chip,
//                              task that moved)                                a different one is its own chip
//   dispatched    failed       settle(failed, line): a transcript line holds   the transcript line
//                              the words (a failed row with no line is shown as a chip)
//   unconfirmed   refused      settle(refused): the engine refused late and    this row (chip)
//                              no line was ever written for the steer
//   (none)        refused      accept(status refused, queueId = the request's  this row (chip). Made by the
//                              id): an owner send the room closed (member or   closing transaction itself
//                              audience change, last member deleted, room       (CompletionHooks.ownerWords);
//                              gone, expiry, could not start, restart).         startup recovery makes any
//                              Not the owner's own cancel.                      that was missed
//   unconfirmed   queued       queue(): the engine proved it never took them   this row + the transcript line
//   started       queued       requeueStarted(): a drained start found its     this row + the transcript line
//                              thread taken and never ran; same seq
//   unconfirmed   delivered    settle(): the engine confirmed late             the transcript line
//   unconfirmed   failed       settle(failed, line): a later message passed it the transcript line
//   unconfirmed   (scrubbed)   scrub(): late answer over, line committed       the transcript line
//   queued        refused      refuse(): the bot/room could not start it, the  this row (chip)
//                              bot left, the drain could not append
//   queued/refused cancelled   cancel(): the OWNER cancels or dismisses        nowhere (the owner chose)
//   refused/failed (deleted)   retire()/accept(): only when the replacement    the replacement row
//                              attempt of the same sendId is accepted, or its
//                              transcript line is committed
//   started, delivered, cancelled, failed-with-line, scrubbed unconfirmed      pruneResolved(): after
//                              retention, in fixed-size batches                 the words are gone from the row
//
// Pruning is bounded: its batches read an index that holds only the prunable rows in age order
// (owner_sends_prunable), so one batch costs the batch, not the history.
//
// Pruning NEVER removes: sending, queued, dispatched, refused, an unconfirmed row that has not
// been scrubbed or is still in lateOpen (an ordering barrier), or a failed row that still holds
// words. It removes only terminal rows whose words are in a committed transcript line, or that
// the owner dismissed.
//
// The rule every transition obeys: a row never reaches a state that hides an
// accepted message unless the message's visible receipt (its transcript line) is
// committed in the SAME transaction, or the row's state is itself the receipt
// ("refused" shows as a chip). "started" and "delivered" therefore need the
// line's id, and the startup reconciliation (completeUnresolved) finishes any
// "dispatched" or "unconfirmed" row that has no line yet.

import { murageLine } from "./murage-line.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { afterCommit, txScopeBegin, txScopeEnd } from "./tx-scope.ts";
import { RESTORE_HOLDS_DDL } from "./restore-fence.ts";
import { groupDeletionKey, ownerDeletedThread, OWNER_DELETIONS_DDL } from "./owner-deletions.ts";
import { SEND_NOTICE_ENGLISH, sendNoticeActivityName, type SendNoticeCode } from "../shared/send-notice.ts";

export type SendStatus = "sending" | "queued" | "dispatched" | "started" | "delivered" | "unconfirmed" | "failed" | "refused" | "cancelled";
export type SendKind = "bot" | "group";

export type SendVia = "share" | "ask-intent";
export interface SendAttachment { kind: "image" | "file"; path: string; mime: string }

export interface SendRow {
  seq: number;
  kind: SendKind;
  ownerId: string;
  threadId: string;
  sendId: string | null;
  queueId: string;
  /** Hashed before it is stored: the row never holds the words twice. */
  fingerprint: string;
  text: string;
  /** What the engine is told when it runs (the text with its quoted reply), when that differs. */
  prompt: string | null;
  replyToId: string | null;
  origin: string | null;
  /** "typedStop": a bot row acceptTypedStop made (designs/TYPED-STOP-107.md); it reads as acknowledged, never as a dismissal. */
  mode: "chat" | "goal" | "typedStop" | null;
  responderId: string | null;
  /** A line already in the transcript that this row will run from (a steer the engine later refused). */
  existingMessageId: string | null;
  messageId: string | null;
  status: SendStatus;
  /** Why the row ended the way it did, as a code the language packs spell (shared/send-notice.ts). */
  notice: SendNoticeCode | null;
  dispatched: boolean;
  /** Neutralized by a restore: a chip that only the owner's explicit resend may run (never a same-id retry). */
  restoreHeld: boolean;
  /** The restore generation a held chip carries: its Send again presents this token, and only the newest restore's token runs it. */
  restoreGen: string | null;
  /** Waiting when the owner pressed Stop (markStopped): after a restart it is held, and only the owner's explicit Send again (resend) runs it. */
  stopped: boolean;
  /** The token the owner's Stop minted for this row. A held stopped chip carries it, and Send again presents it: a press made
   * (or an automatic retry replayed) before that Stop cannot know it, so it never runs the row. */
  stopGen: string | null;
  /** The Send again press that made this row (a fresh token per press). A replay of that same press never runs the row again. */
  actionId: string | null;
  /** A steer the engine took: the provider turn it went into (BOTADDED-DESIGN-V3 r6 §5). A line written later by recovery
   * carries it as `dispatchedIn`. Null for every other row. */
  turnId: string | null;
  /** A row born from a share or an ask-intent (third-party words): null on every owner row. */
  via: SendVia | null;
  /** Waiting words that never run as an owner turn by themselves; re-read at the drain, not only at admission. */
  queueOnly: boolean;
  /** The phone that made a via row. */
  viaDevice: string | null;
  /** Files a via row carries; null when none or when the stored column is malformed (such a row is refused at the drain, never run with a guess). */
  attachments: SendAttachment[] | null;
  /** True when the stored attachments column holds something that does not parse: the drain refuses such a row. */
  attachmentsMalformed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AcceptInput {
  kind: SendKind;
  ownerId: string;
  threadId: string;
  sendId?: string;
  fingerprint: string;
  text: string;
  replyToId?: string;
  origin?: string;
  prompt?: string;
  mode?: "chat" | "goal" | "typedStop";
  responderId?: string;
  /** Rooms with the in-memory fallback accept straight into the queue. */
  /** "cancelled": only acceptTypedStop (a row born finished: never dispatched, never run). */
  status?: "sending" | "queued" | "refused" | "cancelled";
  /** With status "refused": the notice the chip shows. */
  notice?: SendNoticeCode;
  /** A chip made from a waiting room request keeps that request's id, so it is the same item to every client. */
  queueId?: string;
  /** The owner pressed Send again on this id (the chip's explicit action). Without it a restore-held id stays held. */
  resend?: boolean;
  /** The restore generation the chip carried when the owner pressed Send again. A held send runs only when it is the current one. */
  restoreGen?: string;
  /** The stop token the chip carried when the owner pressed Send again. A stopped send runs only when it is the row's own (minted at its Stop). */
  stopGen?: string;
  /** A token minted fresh on each Send again press; an automatic retry replays the token of the press it repeats. */
  actionId?: string;
  /** This chip was made from work a restore expired (a room request): it is held like a neutralized send. */
  restoreHeld?: boolean;
  /** A share or ask-intent row. Needs `queueOnly` and origin "unproven" (a programming error otherwise); a replaced via row carries all of it forward. */
  via?: SendVia;
  queueOnly?: true;
  viaDevice?: string;
  attachments?: SendRow["attachments"];
  now?: number;
}

/** A refused chip was asked for a conversation that no longer exists. */
export class ThreadGoneError extends Error {
  constructor() { super("the conversation is gone"); this.name = "ThreadGoneError"; }
}

export type AcceptResult =
  | { kind: "new"; row: SendRow }
  | { kind: "existing"; row: SendRow }
  | { kind: "conflict"; row: SendRow };

/** The refusal a send gets when its row cannot be written: a code the client spells in its own language. */
export function sendNoticeError(code: SendNoticeCode, status: number): Error & { status: number; noticeCode: SendNoticeCode } {
  return Object.assign(new Error(SEND_NOTICE_ENGLISH[code]), { status, noticeCode: code });
}

/** The transcript line that tells the person what happened to a send. */
export function sendNoticeLine(code: SendNoticeCode): { role: "bot"; kind: "activity"; tool: { name: string; ok: false; notice: true }; murageLine: true } {
  return murageLine({ role: "bot", kind: "activity", tool: { name: sendNoticeActivityName(code), ok: false, notice: true } });
}

/** Terminal rows are kept this long (and at most this many), then dropped. */
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TERMINAL_RETENTION_ROWS = 5000;

/** Rows that may be dropped: finished ones whose words are in a committed transcript line (or the
 * owner dismissed them). An unconfirmed row with no line, or still holding words, is not finished;
 * a failed row that still holds its words is the only copy the server has. */
export const PRUNABLE = "(status IN ('started','delivered','cancelled') OR (status IN ('unconfirmed','failed') AND message_id IS NOT NULL)) AND text=''";
/** The pruning index covers exactly the rows PRUNABLE selects, ordered the way every batch reads
 * them, so a batch is a short walk of the index (O(batch)), never a scan and sort of the history.
 * The queries name it (INDEXED BY) so the planner can never fall back to scanning the history. */
const PRUNE_INDEX = `CREATE INDEX IF NOT EXISTS owner_sends_prunable ON owner_sends(updated_at, seq) WHERE ${PRUNABLE}`;
/** A failed row whose words no transcript line holds: the only copy of them, so it is shown as a chip like a refused one. */
const HIDDEN_FAILED = "(status='failed' AND message_id IS NULL AND text<>'')";
/** Pruning deletes this many rows per batch, then yields to the event loop. */
export const PRUNE_BATCH_ROWS = 200;

function fingerprintHash(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex");
}

const DDL = `CREATE TABLE IF NOT EXISTS owner_sends (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('bot','group')),
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  send_id TEXT,
  queue_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  text TEXT,
  prompt TEXT,
  reply_to_id TEXT,
  origin TEXT,
  mode TEXT,
  responder_id TEXT,
  existing_message_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notice TEXT,
  restore_held INTEGER NOT NULL DEFAULT 0,
  restore_gen TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  stop_gen TEXT,
  action_id TEXT,
  turn_id TEXT,
  via TEXT,
  queue_only INTEGER NOT NULL DEFAULT 0,
  via_device TEXT,
  attachments TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_sends_send ON owner_sends(thread_id, send_id);
CREATE INDEX IF NOT EXISTS owner_sends_open ON owner_sends(thread_id, status, seq);
CREATE INDEX IF NOT EXISTS owner_sends_status ON owner_sends(status, thread_id, seq);
CREATE INDEX IF NOT EXISTS owner_sends_age ON owner_sends(status, updated_at);`;

/**
 * A restored backup never runs what the owner had waiting when it was taken: that work may have
 * finished on the original installation since, and running it again could repeat its effects.
 * Every send that was still deciding or waiting becomes a "refused" chip: the words stay, and only
 * the owner's explicit "Send again" (or "Dismiss") acts on them. A waiting row with no words left
 * has nothing to offer and is closed. Returns how many rows were neutralized.
 */
export function neutralizeRestoredSends(db: DatabaseSync, restoreGeneration?: string): number {
  // Every restore starts a new generation, even one with no waiting send: a Send again pressed before it (and any
  // automatic retry of that press) carries the older token and can no longer run anything.
  const generation = issueRestoreGeneration(db, restoreGeneration);
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='owner_sends'").get()) return 0;
  addMissingColumns(db);
  mintMissingStopTokens(db);
  const now = Date.now();
  const kept = db.prepare("UPDATE owner_sends SET status='refused', dispatched=0, prompt=NULL, existing_message_id=NULL, notice='refused', restore_held=1, updated_at=? WHERE status IN ('sending','queued') AND COALESCE(text,'')<>''").run(now);
  // Every other row a retry can re-admit (a refusal, a failed send, a terminal room-request refusal) is held too: a
  // Send again or automatic retry persisted before the backup must not run after it; only a post-restore press does.
  db.prepare("UPDATE owner_sends SET restore_held=1 WHERE status IN ('failed','refused') AND restore_held=0").run();
  // chips an earlier restore held take the new token as well
  db.prepare("UPDATE owner_sends SET restore_gen=? WHERE restore_held=1").run(generation);
  const empty = db.prepare("UPDATE owner_sends SET status='cancelled', dispatched=0, prompt=NULL, updated_at=? WHERE status IN ('sending','queued')").run(now);
  return Number(kept.changes) + Number(empty.changes);
}

/** The restore generation: a random token, new for every restore, that the server stores and held chips carry. */
export const RESTORE_GENERATION_DDL = "CREATE TABLE IF NOT EXISTS send_restore_generation (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)";
export function issueRestoreGeneration(db: DatabaseSync, token: string = randomUUID()): string {
  db.exec(RESTORE_GENERATION_DDL);
  db.prepare("INSERT OR REPLACE INTO send_restore_generation (id, token) VALUES (1, ?)").run(token);
  return token;
}

/** The newest restore's token, or null when this installation was never restored. */
export function currentRestoreGeneration(db: DatabaseSync): string | null {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='send_restore_generation'").get()) return null;
  const row = db.prepare("SELECT token FROM send_restore_generation WHERE id=1").get() as { token: string } | undefined;
  return row?.token ?? null;
}

/** Whether a presented token is the current generation's (a Send again after a later restore carries a stale one). */
export function restoreGenerationCurrent(db: DatabaseSync, token: unknown): boolean {
  if (typeof token !== "string" || !token) return false;
  return currentRestoreGeneration(db) === token;
}

/** A table made by an earlier build lacks later columns. */
function addMissingColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "notice")) db.exec("ALTER TABLE owner_sends ADD COLUMN notice TEXT");
  if (!columns.some((column) => column.name === "restore_held")) db.exec("ALTER TABLE owner_sends ADD COLUMN restore_held INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "restore_gen")) db.exec("ALTER TABLE owner_sends ADD COLUMN restore_gen TEXT");
  if (!columns.some((column) => column.name === "stopped")) db.exec("ALTER TABLE owner_sends ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "stop_gen")) db.exec("ALTER TABLE owner_sends ADD COLUMN stop_gen TEXT");
  if (!columns.some((column) => column.name === "action_id")) db.exec("ALTER TABLE owner_sends ADD COLUMN action_id TEXT");
  // 1.0.1 never reads turn_id: owner_sends is a 1.0.2 table in the downgrade manifest (APP_SCHEMA_102_ADDITIONS), dropped whole on the way back.
  if (!columns.some((column) => column.name === "turn_id")) db.exec("ALTER TABLE owner_sends ADD COLUMN turn_id TEXT");
  // Same table, same downgrade: the 1.0.9 via columns go with it when owner_sends is dropped whole.
  if (!columns.some((column) => column.name === "via")) db.exec("ALTER TABLE owner_sends ADD COLUMN via TEXT");
  if (!columns.some((column) => column.name === "queue_only")) db.exec("ALTER TABLE owner_sends ADD COLUMN queue_only INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "via_device")) db.exec("ALTER TABLE owner_sends ADD COLUMN via_device TEXT");
  if (!columns.some((column) => column.name === "attachments")) db.exec("ALTER TABLE owner_sends ADD COLUMN attachments TEXT");
}

/**
 * A row stopped by an earlier build (1.0.1, or a dev build before the stop token existed) has no token. Without one its held chip could never be
 * pressed: every Send again would be refused. Each such row gets its own freshly minted token, so one fresh press runs it exactly once while an
 * automatic resend of an older press (no token, or a token from before) still runs nothing. Safe to run again: it touches only rows lacking a token.
 */
export function mintMissingStopTokens(db: DatabaseSync): void {
  const rows = db.prepare("SELECT seq FROM owner_sends WHERE stopped=1 AND (stop_gen IS NULL OR stop_gen='')").all() as Array<{ seq: number }>;
  if (rows.length === 0) return;
  const set = db.prepare("UPDATE owner_sends SET stop_gen=? WHERE seq=? AND (stop_gen IS NULL OR stop_gen='')");
  for (const row of rows) set.run(randomUUID(), row.seq);
}

/** The steered line recovery writes for a row whose line was never written: the words, marked not confirmed. A steer the engine
 * took keeps the turn it went into (`turn_id`, BOTADDED-DESIGN-V3 r6 §5), whatever stopped its line being written. */
export function recoveredSteerLine(row: SendRow, steerId: string) {
  return {
    role: "user" as const, kind: "text" as const, text: row.text,
    ...(row.replyToId ? { replyToId: row.replyToId } : {}),
    ...(row.sendId ? { sendId: row.sendId } : {}),
    queueId: row.queueId,
    // a phone's line keeps its standing: without `via` the owner could edit it into an owner turn
    ...(row.via ? { via: row.via } : {}),
    steered: true, steerUnconfirmed: true, steerId,
    ...(row.turnId ? { dispatchedIn: row.turnId } : {}),
  };
}

/** Created by the database initializer (and by a test's own handle); safe to run again. */
export function initializeOwnerSends(db: DatabaseSync): void {
  // A table made by an earlier build lacks the notice column; the indexes need the table first.
  const existing = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='owner_sends'").get();
  if (existing) {
    addMissingColumns(db);
  }
  db.exec(DDL);
  db.exec(PRUNE_INDEX);
  // the owner-deletion record and the restore generation live beside the sends they govern
  db.exec(OWNER_DELETIONS_DDL);
  db.exec(RESTORE_GENERATION_DDL);
  db.exec(RESTORE_HOLDS_DDL);
  mintMissingStopTokens(db);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const OPEN: ReadonlySet<SendStatus> = new Set<SendStatus>(["sending", "queued", "dispatched"]);

/** The stored attachments, or null when absent or malformed in any way. */
function parseAttachments(raw: unknown): SendAttachment[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const out: SendAttachment[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") return null;
      const { kind, path, mime } = item as Record<string, unknown>;
      if ((kind !== "image" && kind !== "file") || typeof path !== "string" || !path || typeof mime !== "string") return null;
      out.push({ kind, path, mime });
    }
    return out;
  } catch { return null; }
}

function toRow(r: Record<string, unknown>): SendRow {
  return {
    seq: Number(r.seq),
    kind: r.kind as SendKind,
    ownerId: String(r.owner_id),
    threadId: String(r.thread_id),
    sendId: (r.send_id as string | null) ?? null,
    queueId: String(r.queue_id),
    fingerprint: String(r.fingerprint),
    text: typeof r.text === "string" ? r.text : "",
    prompt: (r.prompt as string | null) ?? null,
    replyToId: (r.reply_to_id as string | null) ?? null,
    origin: (r.origin as string | null) ?? null,
    mode: (r.mode as "chat" | "goal" | "typedStop" | null) ?? null,
    responderId: (r.responder_id as string | null) ?? null,
    existingMessageId: (r.existing_message_id as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    status: r.status as SendStatus,
    notice: (r.notice as SendNoticeCode | null) ?? null,
    dispatched: Number(r.dispatched) === 1,
    restoreHeld: Number(r.restore_held) === 1,
    restoreGen: (r.restore_gen as string | null) ?? null,
    stopped: Number(r.stopped) === 1,
    stopGen: (r.stop_gen as string | null) ?? null,
    actionId: (r.action_id as string | null) ?? null,
    turnId: (r.turn_id as string | null) ?? null,
    via: r.via === "share" || r.via === "ask-intent" ? r.via : null,
    queueOnly: Number(r.queue_only) === 1,
    viaDevice: (r.via_device as string | null) ?? null,
    attachments: parseAttachments(r.attachments),
    attachmentsMalformed: typeof r.attachments === "string" && r.attachments !== "" && parseAttachments(r.attachments) === null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** What startup recovery needs from the transcript: read a thread's lines, append a receipt. */
export interface RecoveryIo {
  /** The transcript line this row already became (by its message id, send id or queue id), if any: a keyed read and a look at the rows written since the row was accepted, never the thread. */
  landed(row: SendRow): { id: string } | undefined;
  /** Write the steered line (id `lineId`) holding the row's words, then the notice line. */
  appendReceipt(row: SendRow, lineId: string): void;
}

export class SendStore {
  private getDb: () => DatabaseSync;
  private fallback: DatabaseSync | null = null;
  private ready = new WeakSet<DatabaseSync>();
  /** Unconfirmed steers whose real answer may still arrive in THIS run. They still hold back later sends. */
  private readonly lateOpen = new Set<number>();
  private observer: ((threadId: string) => void) | null = null;

  constructor(getDb?: () => DatabaseSync) {
    this.getDb = getDb ?? (() => (this.fallback ??= new DatabaseSync(":memory:")));
  }

  /** Point the store at the server's message database. */
  use(getDb: (() => DatabaseSync) | null): void {
    this.getDb = getDb ?? (() => (this.fallback ??= new DatabaseSync(":memory:")));
    this.lateOpen.clear();
  }

  /** Tests: a clean in-memory store. */
  reset(): void {
    this.fallback = null;
    this.getDb = () => (this.fallback ??= new DatabaseSync(":memory:"));
    this.lateOpen.clear();
    this.observer = null;
    this.gate = null;
  }

  setObserver(fn: ((threadId: string) => void) | null): void { this.observer = fn; }

  private gate: ((threadId: string, ownerId: string, kind: SendKind) => boolean) | null = null;
  /** Whether a conversation still exists. A refused chip (a recovery surface for words) is never made for one that does not. */
  setThreadGate(fn: ((threadId: string, ownerId: string, kind: SendKind) => boolean) | null): void { this.gate = fn; }

  /**
   * Startup: rows of a conversation the OWNER deleted (a recorded deletion, owner-deletions.ts) are removed,
   * whatever their state. A conversation that is merely missing from the registry is never inferred deleted:
   * its rows are kept. Returns the threads touched.
   */
  purgeOrphans(live: (threadId: string, ownerId: string, kind: SendKind) => boolean): string[] {
    const db = this.db();
    const rows = db.prepare("SELECT DISTINCT thread_id AS t, owner_id AS o, kind AS k FROM owner_sends").all() as Array<{ t: string; o: string; k: SendKind }>;
    const touched = new Set<string>();
    this.atomically((tx) => {
      for (const { t, o, k } of rows) {
        // The thread's own record, or (for a channel's threads) the channel's: a crash between the registry write and the
        // per-thread cleanup leaves only the channel's record.
        if (live(t, o, k) || !(ownerDeletedThread(tx, t) || (k === "group" && ownerDeletedThread(tx, groupDeletionKey(o))))) continue;
        tx.prepare("DELETE FROM owner_sends WHERE thread_id=? AND owner_id=? AND kind=?").run(t, o, k);
        touched.add(t);
      }
    });
    return [...touched];
  }

  /** Chip refreshes reach clients only once the enclosing transaction commits; a rollback publishes nothing. */
  private notify(threadId: string): void {
    afterCommit(() => {
      try { this.observer?.(threadId); } catch { /* a chip refresh never fails a send */ }
    });
  }

  /** The connection the store writes on: the phone receipts table shares it, so a receipt and its row commit together. */
  database(): DatabaseSync { return this.db(); }

  private db(): DatabaseSync {
    const db = this.getDb();
    if (!this.ready.has(db)) { initializeOwnerSends(db); this.ready.add(db); }
    return db;
  }

  private atomically<T>(work: (db: DatabaseSync) => T): T {
    const db = this.db();
    const point = `owner_sends_${randomUUID().replace(/-/g, "")}`;
    db.exec(`SAVEPOINT ${point}`);
    txScopeBegin();
    try {
      const out = work(db);
      db.exec(`RELEASE ${point}`);
      txScopeEnd(true);
      return out;
    } catch (error) {
      try { db.exec(`ROLLBACK TO ${point}; RELEASE ${point}`); } catch { /* the handle is already gone */ }
      txScopeEnd(false);
      throw error;
    }
  }

  private one(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): SendRow | undefined {
    const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
  }

  bySeq(seq: number): SendRow | undefined {
    return this.one(this.db(), "SELECT * FROM owner_sends WHERE seq=?", seq);
  }

  byQueueId(ownerId: string, queueId: string): SendRow | undefined {
    return this.one(this.db(), "SELECT * FROM owner_sends WHERE owner_id=? AND queue_id=?", ownerId, queueId);
  }

  bySendId(threadId: string, sendId: string): SendRow | undefined {
    return this.one(this.db(), "SELECT * FROM owner_sends WHERE thread_id=? AND send_id=?", threadId, sendId);
  }

  /** Whether a row was accepted for exactly this message (the stored fingerprint is a hash). */
  matches(row: SendRow, fingerprint: string): boolean {
    return row.fingerprint === fingerprintHash(fingerprint);
  }

  /** Everything the sendId ever came to, however it ended: the one durable answer to a retry. */
  outcome(threadId: string, sendId: string, kind?: SendKind, ownerId?: string): SendRow | undefined {
    const row = this.bySendId(threadId, sendId);
    if (!row) return undefined;
    if ((kind && row.kind !== kind) || (ownerId && row.ownerId !== ownerId)) return undefined;
    return row;
  }

  /** The person asked again after a refusal: retire the old failed or refused row so the new attempt stands alone. */
  retire(seq: number): void {
    const row = this.bySeq(seq);
    if (!row || (row.status !== "failed" && row.status !== "refused")) return;
    this.db().prepare("DELETE FROM owner_sends WHERE seq=?").run(seq);
    this.notify(row.threadId);
  }

  /** Several writes, one transaction. */
  within<T>(work: () => T): T { return this.atomically(() => work()); }

  /**
   * Acceptance: ONE transaction. Throws when the row cannot be written, and
   * then nothing may be submitted. A repeat of a sendId returns the row it
   * already has (a `failed` one is re-admitted as a fresh row at the end of
   * the line: the person asked again, deliberately).
   */
  accept(input: AcceptInput): AcceptResult {
    const now = input.now ?? Date.now();
    const fingerprint = fingerprintHash(input.fingerprint);
    let typedAt = now;
    if (input.via && (input.queueOnly !== true || input.origin !== "unproven")) throw new Error("a via send is queue-only and unproven");
    let via: SendVia | null = input.via ?? null;
    let queueOnly = input.queueOnly === true;
    let viaDevice: string | null = input.viaDevice ?? null;
    let attachments: SendRow["attachments"] = input.attachments ?? null;
    let origin: string | null = input.origin ?? null;
    const result = this.atomically((db): AcceptResult => {
      // The check and the insert share this transaction: no chip for a conversation that is gone.
      if (input.status === "refused" && this.gate && !this.gate(input.threadId, input.ownerId, input.kind)) throw new ThreadGoneError();
      if (input.sendId) {
        const prior = this.one(db, "SELECT * FROM owner_sends WHERE thread_id=? AND send_id=?", input.threadId, input.sendId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) return { kind: "conflict", row: prior };
          // A send held by a restore is run only by the owner's explicit Send again, never by an automatic retry of the same id.
          // ...and only with the token of the NEWEST restore: a press (or its retry) from before a later restore is stale.
          if (prior.restoreHeld && !(input.resend && prior.restoreGen !== null && input.restoreGen === prior.restoreGen && restoreGenerationCurrent(db, input.restoreGen))) return { kind: "existing", row: prior };
          if (prior.status !== "failed" && prior.status !== "refused") return { kind: "existing", row: prior };
          // A message the owner stopped is held the same way: an automatic retry of its id (a lost acknowledgement) gets the held row back and never runs it,
          // even a retry of an earlier Send again (it replays that press's resend and token). Only a Send again pressed AFTER the Stop runs it: it presents
          // the token the Stop minted, which no earlier press can carry. Dismiss drops it.
          if (!stoppedResendRuns(prior, input)) return { kind: "existing", row: prior };
          // A replay of the very press that made this row (its acknowledgement was lost) never runs it a second time.
          if (input.resend && input.actionId && prior.actionId === input.actionId) return { kind: "existing", row: prior };
          if (prior.via !== null) {
            // A via row keeps its standing and its files across the replacement, whatever the press says: third-party words never become an owner turn here.
            if (input.via && input.via !== prior.via) throw new Error("a resend cannot change a send's via");
            via = prior.via; queueOnly = true; viaDevice = prior.viaDevice; attachments = prior.attachments; origin = "unproven";
          }
          db.prepare("DELETE FROM owner_sends WHERE seq=?").run(prior.seq);
          // Send again on a chip: the message is still the one the owner typed, at the time they typed it
          typedAt = prior.createdAt;
        }
      }
      if (input.queueId) {
        const same = this.one(db, "SELECT * FROM owner_sends WHERE queue_id=?", input.queueId);
        if (same) return { kind: "existing", row: same };
      }
      const queueId = input.queueId ?? randomUUID();
      const heldGeneration = input.restoreHeld ? (currentRestoreGeneration(db) ?? issueRestoreGeneration(db)) : null;
      db.prepare(`INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, prompt, reply_to_id, origin, mode, responder_id, status, notice, dispatched, created_at, updated_at, restore_held, restore_gen, action_id, via, queue_only, via_device, attachments)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`).run(
        input.kind, input.ownerId, input.threadId, input.sendId ?? null, queueId, fingerprint, input.text, input.prompt ?? null,
        input.replyToId ?? null, origin, input.mode ?? null, input.responderId ?? null,
        input.status ?? "sending", input.status === "refused" ? (input.notice ?? "refused") : null, typedAt, now,
        input.restoreHeld ? 1 : 0, heldGeneration, input.resend && input.actionId ? input.actionId : null,
        via, queueOnly ? 1 : 0, viaDevice, attachments ? JSON.stringify(attachments) : null,
      );
      return { kind: "new", row: this.one(db, "SELECT * FROM owner_sends WHERE queue_id=?", queueId)! };
    });
    if (result.kind === "new") this.notify(input.threadId);
    return result;
  }

  /**
   * A typed stop (designs/TYPED-STOP-107.md): ONE transaction records the owner's "stop" already finished ("cancelled": no words kept,
   * never dispatched, never run, never resent, and not a message that passed to the engine) and marks the conversation's waiting messages
   * as a Stop does (markStopped). A crash leaves either nothing or both. A repeat of the send id gets its existing row back.
   */
  acceptTypedStop(input: Omit<AcceptInput, "status" | "text"> & { text: string }): AcceptResult {
    return this.atomically((): AcceptResult => {
      const accepted = this.accept({ ...input, text: "", status: "cancelled", mode: "typedStop" });
      if (accepted.kind === "new") this.markStopped(input.threadId);
      return accepted;
    });
  }

  private update(seq: number, set: string, args: Array<string | number | null>, threadId?: string): void {
    const db = this.db();
    const info = db.prepare(`UPDATE owner_sends SET ${set}, updated_at=? WHERE seq=?`).run(...args, Date.now(), seq);
    if (Number(info.changes) !== 1) throw new Error("send record is gone");
    const tid = threadId ?? this.bySeq(seq)?.threadId;
    if (tid) this.notify(tid);
  }

  /** The marker, written before anything reaches the engine. Throws if it cannot be made durable. */
  markDispatched(seq: number): void {
    this.update(seq, "status='dispatched', dispatched=1", []);
  }

  /** The marker for a whole leading run, in one transaction. */
  markDispatchedMany(seqs: number[]): void {
    if (!seqs.length) return;
    const threads = new Set<string>();
    this.atomically((db) => {
      for (const seq of seqs) {
        const info = db.prepare("UPDATE owner_sends SET status='dispatched', dispatched=1, updated_at=? WHERE seq=? AND status='queued'").run(Date.now(), seq);
        if (Number(info.changes) !== 1) throw new Error("send record is not waiting");
        const row = this.one(db, "SELECT * FROM owner_sends WHERE seq=?", seq);
        if (row) threads.add(row.threadId);
      }
    });
    for (const t of threads) this.notify(t);
  }

  /** Waiting for the bot or room. `existingMessageId` names a transcript line it runs from. */
  queue(seq: number, existingMessageId?: string, prompt?: string): void {
    this.update(seq, "status='queued', dispatched=0, existing_message_id=COALESCE(?, existing_message_id), prompt=COALESCE(?, prompt)", [existingMessageId ?? null, prompt ?? null]);
    this.lateOpen.delete(seq);
  }

  /** A drained row whose start never ran (the thread was taken): back to waiting in its own place (seq, via, device and origin
   * unchanged), running from the transcript line it already has, with its words kept for the chip until it starts again. Only a
   * "started" row moves; anything else throws and stays as it is. */
  requeueStarted(seq: number, messageId: string, text: string, prompt?: string): void {
    const info = this.db().prepare("UPDATE owner_sends SET status='queued', dispatched=0, existing_message_id=?, text=?, prompt=COALESCE(?, prompt), updated_at=? WHERE seq=? AND status='started'")
      .run(messageId, text, prompt ?? null, Date.now(), seq);
    if (Number(info.changes) !== 1) throw new Error("send record is not started");
    this.lateOpen.delete(seq);
    const row = this.bySeq(seq);
    if (row) this.notify(row.threadId);
  }

  /**
   * An outcome. "started" and "delivered" need the id of the transcript line
   * that is the person's receipt: without it the row would hide an accepted
   * message. The words are dropped once the transcript (or the owner's retry)
   * holds them; "refused" keeps them, because the row is the only place they
   * are still visible. A finished row also drops its prompt (quoted text).
   */
  settle(seq: number, status: "started" | "delivered" | "unconfirmed" | "failed" | "refused" | "cancelled", messageId?: string, notice?: SendNoticeCode): void {
    if ((status === "started" || status === "delivered") && !messageId) throw new Error(`a ${status} send needs its transcript line`);
    if (status === "refused" && !notice) throw new Error("a refused send needs its notice");
    // An unconfirmed steer may still be refused by the engine and put back in line, running from
    // its words and prompt: those stay until it is answered, the turn ends, or Murage restarts.
    // A failed send keeps its words unless a transcript line holds them (a late refusal passed by a
    // later message): without the line the row is the only copy the server has.
    const hold = status === "refused" || status === "unconfirmed" || (status === "failed" && !messageId);
    this.update(
      seq,
      `status=?, notice=COALESCE(?, notice), message_id=COALESCE(?, message_id)${status === "refused" ? ", dispatched=0, prompt=NULL" : ""}${hold ? "" : ", prompt=NULL, text=''"}`,
      [status, notice ?? null, messageId ?? null],
    );
    if (status !== "unconfirmed") this.lateOpen.delete(seq);
  }

  /**
   * An outcome together with the transcript line that makes it visible, ONE
   * transaction: either both are there or neither is. `append(lineId)` writes
   * the line with that id (and any notice line beside it). The row is updated
   * first, so a failing append rolls the update back before anything is shown.
   */
  settleWithLine<T>(seq: number, status: "started" | "delivered" | "unconfirmed", lineId: string, append: () => T, notice?: SendNoticeCode): T {
    const threadId = this.bySeq(seq)?.threadId;
    const out = this.atomically(() => {
      this.settle(seq, status, lineId, notice);
      const written = append();
      // A store that assigned its own id for the line: the row names the line that exists.
      const actual = (written as { id?: unknown } | null | undefined)?.id;
      if (typeof actual === "string" && actual !== lineId) this.db().prepare("UPDATE owner_sends SET message_id=? WHERE seq=?").run(actual, seq);
      return written;
    });
    if (threadId) this.notify(threadId);
    return out;
  }

  /** The provider turn a delivered steer went into, kept with the row so a line written after a failed append or a restart
   * still names it. */
  setTurnId(seq: number, turnId: string): void {
    this.db().prepare("UPDATE owner_sends SET turn_id=? WHERE seq=?").run(turnId, seq);
  }

  /** A waiting message the bot or room could not start: the words stay, as a chip the person can resend or dismiss. */
  refuse(seq: number, notice: SendNoticeCode = "refused"): void {
    this.settle(seq, "refused", undefined, notice);
  }

  /**
   * The owner pressed Stop on this conversation: the messages still waiting there (not yet passed to the engine) are marked. In this session nothing changes
   * (they run as a steer once the bot settles, as before); after a restart they are not run on their own but held for the owner (recover()). Returns how many.
   */
  markStopped(threadId: string): number {
    // Each Stop mints its own token: only a Send again pressed after it (on the held chip that carries it) can present it.
    return Number(this.db().prepare("UPDATE owner_sends SET stopped=1, stop_gen=? WHERE thread_id=? AND status IN ('sending','queued') AND dispatched=0 AND stopped=0").run(randomUUID(), threadId).changes);
  }

  /** An unconfirmed steer whose real answer can still arrive: later sends wait behind it. */
  holdForLateAnswer(seq: number): void { this.lateOpen.add(seq); }
  releaseLateAnswer(seq: number): void {
    this.lateOpen.delete(seq);
    this.scrub(seq);
    const row = this.bySeq(seq);
    if (row) this.notify(row.threadId);
  }

  /** An unconfirmed row that has its line and can no longer be put back in line holds no words of its own. */
  scrub(seq: number): void {
    this.db().prepare("UPDATE owner_sends SET text='', prompt=NULL WHERE seq=? AND status='unconfirmed' AND message_id IS NOT NULL").run(seq);
  }

  /**
   * A message waits behind ANY earlier unresolved message on its thread:
   * still deciding (sending), waiting (queued), in flight (dispatched), or an
   * unconfirmed steer that may yet be refused. There is no time limit.
   */
  blockedByEarlier(threadId: string, seq: number): boolean {
    const rows = this.db().prepare("SELECT seq, status FROM owner_sends WHERE thread_id=? AND seq<? AND status IN ('sending','queued','dispatched','unconfirmed')").all(threadId, seq) as Array<{ seq: number; status: string }>;
    return rows.some((r) => r.status !== "unconfirmed" || this.lateOpen.has(Number(r.seq)));
  }

  /** The turn is over: its unconfirmed steers can no longer be folded in, so they stop holding the line. */
  releaseThreadLate(threadId: string): void {
    for (const seq of [...this.lateOpen]) {
      if (this.bySeq(seq)?.threadId !== threadId) continue;
      this.lateOpen.delete(seq);
      this.scrub(seq);
    }
  }

  /** True while an unconfirmed steer on the thread may still be answered. */
  hasLateOpen(threadId: string): boolean {
    for (const seq of this.lateOpen) if (this.bySeq(seq)?.threadId === threadId) return true;
    return false;
  }

  /** Whether any row at all is waiting on the thread. */
  queuedCount(threadId: string, kind?: SendKind): number {
    const sql = `SELECT COUNT(*) AS n FROM owner_sends WHERE thread_id=? AND status='queued'${kind ? " AND kind=?" : ""}`;
    const row = (kind ? this.db().prepare(sql).get(threadId, kind) : this.db().prepare(sql).get(threadId)) as { n: number };
    return Number(row.n);
  }

  /** Rows of a thread that are waiting, in the order they were accepted. */
  queuedRows(threadId: string, kind?: SendKind): SendRow[] {
    const sql = `SELECT * FROM owner_sends WHERE thread_id=? AND status='queued'${kind ? " AND kind=?" : ""} ORDER BY seq`;
    const rows = (kind ? this.db().prepare(sql).all(threadId, kind) : this.db().prepare(sql).all(threadId)) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  queuedThreads(kind?: SendKind): string[] {
    const sql = `SELECT DISTINCT thread_id FROM owner_sends WHERE status='queued'${kind ? " AND kind=?" : ""} ORDER BY thread_id`;
    const rows = (kind ? this.db().prepare(sql).all(kind) : this.db().prepare(sql).all()) as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  /**
   * The leading run of waiting rows that may start now: stops at the first
   * earlier row that has not resolved, so nothing ever overtakes it.
   */
  drainable(threadId: string, kind: SendKind): SendRow[] {
    const rows = this.db().prepare("SELECT * FROM owner_sends WHERE thread_id=? AND kind=? AND status IN ('sending','queued','dispatched','unconfirmed') ORDER BY seq").all(threadId, kind) as Array<Record<string, unknown>>;
    const out: SendRow[] = [];
    for (const raw of rows) {
      const row = toRow(raw);
      if (row.status === "queued") { out.push(row); continue; }
      if (row.status === "unconfirmed" && !this.lateOpen.has(row.seq)) continue;
      break;
    }
    return out;
  }

  /** Rows the person should see: being sent, waiting, or refused and waiting for their decision. */
  pending(threadId: string): SendRow[] {
    const rows = this.db().prepare(`SELECT * FROM owner_sends WHERE thread_id=? AND (status IN ('sending','dispatched','queued','refused') OR ${HIDDEN_FAILED}) ORDER BY seq`).all(threadId) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  pendingThreads(): string[] {
    const rows = this.db().prepare(`SELECT DISTINCT thread_id FROM owner_sends WHERE status IN ('sending','dispatched','queued','refused') OR ${HIDDEN_FAILED}`).all() as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  /** Cancel a waiting row, or dismiss a refused one. False when it already moved on (or is not this owner's). */
  cancel(ownerId: string, queueId: string): SendRow | null {
    const row = this.byQueueId(ownerId, queueId);
    const chip = row?.status === "refused" || (row?.status === "failed" && !row.messageId && row.text !== "");
    if (!row || (row.status !== "queued" && !chip) || (row.status === "queued" && row.dispatched)) return null;
    this.settle(row.seq, "cancelled");
    return this.bySeq(row.seq) ?? row;
  }

  /** True when a row of this thread is later than `seq` and has already passed to the engine. */
  hasPassed(threadId: string, seq: number): boolean {
    const row = this.db().prepare("SELECT 1 AS x FROM owner_sends WHERE thread_id=? AND seq>? AND status IN ('dispatched','started','delivered') LIMIT 1").get(threadId, seq);
    return Boolean(row);
  }

  /**
   * Startup. Rows left "sending" never reached the engine (no marker): they
   * wait again, in their original order. Rows left "dispatched" may have
   * reached it, and "unconfirmed" rows may lack their visible receipt: both are
   * returned, untouched, for `completeUnresolved`, which gives each its line and
   * its state in one transaction. Nothing is sent again on the person's behalf.
   * Runs on EVERY start, so a crash at any point of an earlier run is finished.
   */
  recover(): { requeued: SendRow[]; unresolved: SendRow[] } {
    return this.atomically((db) => {
      const now = Date.now();
      mintMissingStopTokens(db);
      // Messages that were waiting when the owner pressed Stop never run on their own after a restart: each is held as a chip (Send again / Dismiss),
      // with the words and the time they were typed. Within the session they ran as a steer after the stop; only a restart holds them.
      db.prepare("UPDATE owner_sends SET status='refused', dispatched=0, prompt=NULL, existing_message_id=NULL, notice='notConfirmed', updated_at=? WHERE stopped=1 AND status IN ('sending','queued') AND dispatched=0 AND COALESCE(text,'')<>''").run(now);
      const sending = (db.prepare("SELECT * FROM owner_sends WHERE status='sending' AND dispatched=0 ORDER BY seq").all() as Array<Record<string, unknown>>).map(toRow);
      const unresolved = (db.prepare("SELECT * FROM owner_sends WHERE status IN ('dispatched','unconfirmed') ORDER BY seq").all() as Array<Record<string, unknown>>).map(toRow);
      db.prepare("UPDATE owner_sends SET status='queued', updated_at=? WHERE status='sending' AND dispatched=0").run(now);
      this.lateOpen.clear();
      return { requeued: sending, unresolved };
    });
  }

  /**
   * Finish every row `recover` returned. A row whose line is in the transcript
   * becomes "started" (it was dispatched) or stays as it is (unconfirmed, line
   * present). A row with no line gets it: the person's words as a steered line
   * plus the "may not have reached the bot" notice, committed together with the
   * row's "unconfirmed" state. A failure on one row leaves that row for the next
   * start and never stops the others.
   */
  completeUnresolved(rows: SendRow[], io: RecoveryIo): { started: number; recorded: number } {
    let started = 0;
    let recorded = 0;
    for (const row of rows) {
      try {
        const landed = io.landed(row);
        if (landed) {
          if (row.status === "dispatched") { this.settle(row.seq, "started", landed.id); started += 1; }
          else this.scrub(row.seq); // after a restart no late answer can arrive
          continue;
        }
        if (!row.text) continue; // the words are gone with their row; nothing to show
        const lineId = randomUUID();
        this.settleWithLine(row.seq, "unconfirmed", lineId, () => {
          io.appendReceipt(row, lineId);
          this.scrub(row.seq);
        }, "notConfirmed");
        recorded += 1;
      } catch { /* the thread went away, or the write failed: the row stays for the next start */ }
    }
    return { started, recorded };
  }

  /**
   * Finished rows older than the retention are dropped, and past the row cap the
   * oldest go too. Only rows whose words are in a committed transcript line (or that
   * the owner dismissed) are ever removed: waiting, refused, dispatched and
   * receipt-less rows, and any unconfirmed steer still in `lateOpen` (an ordering
   * barrier), are never pruned. Work is done in fixed-size batches that yield to the
   * event loop between them, so a large ledger never stalls a send or startup.
   * Run at start and on a timer.
   */
  async pruneResolved(olderThanMs: number = TERMINAL_RETENTION_MS, now: number = Date.now(), maxRows: number = TERMINAL_RETENTION_ROWS, batch: number = PRUNE_BATCH_ROWS): Promise<number> {
    let removed = 0;
    const run = (sql: string, ...args: number[]): number => {
      const barrier = [...this.lateOpen].filter((seq) => Number.isInteger(seq));
      const exclude = barrier.length ? ` AND seq NOT IN (${barrier.join(",")})` : "";
      return Number(this.db().prepare(sql.replace("{X}", exclude)).run(...args).changes);
    };
    const cutoff = now - olderThanMs;
    for (;;) {
      const n = run(`DELETE FROM owner_sends WHERE seq IN (SELECT seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} AND updated_at<?{X} ORDER BY updated_at, seq LIMIT ?)`, cutoff, batch);
      removed += n;
      if (n < batch) break;
      await yieldToEventLoop();
    }
    // The cap: find the row that is the maxRows-th newest (bounded by the cap), then delete older ones in batches.
    const pivot = this.db().prepare(`SELECT updated_at, seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} ORDER BY updated_at DESC, seq DESC LIMIT 1 OFFSET ?`).get(maxRows) as { updated_at: number; seq: number } | undefined;
    if (pivot) {
      for (;;) {
        const n = run(`DELETE FROM owner_sends WHERE seq IN (SELECT seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} AND (updated_at, seq)<=(?, ?){X} ORDER BY updated_at, seq LIMIT ?)`, Number(pivot.updated_at), Number(pivot.seq), batch);
        removed += n;
        if (n < batch) break;
        await yieldToEventLoop();
      }
    }
    return removed;
  }

  isOpen(status: SendStatus): boolean { return OPEN.has(status); }
}

export const sendStore = new SendStore();

/**
 * Whether a send attempt may run a row the owner stopped. A row that was not stopped is not this rule's business. A stopped one runs only on
 * the owner's Send again pressed after the Stop: that press presents the token the Stop minted (the held chip carries it). An automatic retry
 * replays the request it repeats, so a retry of an earlier Send again (resend:true, but a token from before the Stop, or none) is held.
 */
export function stoppedResendRuns(prior: Pick<SendRow, "stopped" | "stopGen">, input: { resend?: boolean; stopGen?: string }): boolean {
  if (!prior.stopped) return true;
  return input.resend === true && prior.stopGen !== null && typeof input.stopGen === "string" && input.stopGen === prior.stopGen;
}

/** The chip a client shows for a row that has not landed yet. A "refused" chip carries what
 * "Send again" must repeat exactly (the same send id, reply, mode and responder). */
export function pendingItem(row: SendRow): {
  queueId: string; sendId?: string; text: string; state: "sending" | "queued" | "refused";
  notice?: SendNoticeCode; replyToId?: string; mode?: "chat" | "goal"; responderId?: string; restoreGen?: string; stopGen?: string;
  /** When the owner typed it (kept through a hold and a Send again). */
  at: number;
} {
  if (row.status === "refused" || row.status === "failed") {
    return {
      queueId: row.queueId,
      ...(row.sendId ? { sendId: row.sendId } : {}),
      text: row.text,
      state: "refused",
      notice: row.notice ?? "refused",
      ...(row.replyToId ? { replyToId: row.replyToId } : {}),
      ...(row.mode === "chat" || row.mode === "goal" ? { mode: row.mode } : {}),
      ...(row.responderId ? { responderId: row.responderId } : {}),
      ...(row.restoreHeld && row.restoreGen ? { restoreGen: row.restoreGen } : {}),
      ...(row.stopped && row.stopGen ? { stopGen: row.stopGen } : {}),
      at: row.createdAt,
    };
  }
  const sending = row.status !== "queued";
  return {
    queueId: sending && row.sendId ? `sending:${row.sendId}` : row.queueId,
    ...(row.sendId ? { sendId: row.sendId } : {}),
    text: row.text,
    state: sending ? "sending" : "queued",
    at: row.createdAt,
  };
}

/** Per-thread admission order: the decision section of one send runs only after
 * every earlier send on the same thread has finished deciding, so a later send
 * can never overtake an earlier one that is still choosing to steer or queue.
 * What an unfinished earlier send leaves behind (an unconfirmed steer that may
 * still be refused) is not a timer here: it is a row, and `blockedByEarlier`
 * keeps every later send behind it until it resolves. */
export class ThreadAdmission {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(threadId) ?? Promise.resolve();
    const current = prior.then(work, work);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(threadId, tail);
    void tail.then(() => { if (this.tails.get(threadId) === tail) this.tails.delete(threadId); });
    return current;
  }
}
