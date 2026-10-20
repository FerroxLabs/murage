// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// REPLY-WITHHELD-CONTRACT C5, R3, R6, R7, R8 (lanes/release103/REPLY-WITHHELD-CONTRACT.md): the boot recovery of delegated replies that 1.0.2 and
// earlier 1.0.3 builds froze as "Reply withheld: it used something you deleted or changed" while the gate was only checking.
//
// A frozen row is matched by its shape (R6): a `dres-<id>` bot text row with no copy link whose words are the delegated-reply wrapper ending in
// the fixed withheld line (1.0.2), or whose kept status is `replied_to_task` with the fixed line as its reply (1.0.3). Its worker's words are
// found only through proven provenance (R7): the worker is the row's `from.botId`, the hand-off's prompt row `dlg-<id>` is stored in one of
// that bot's conversations, the first bot text row after it carries a turn id, and the originals are that turn's own replies. They are judged
// again through the gate for the owner's audience, and only into the owner's own conversation.
//
// The frozen row is never edited (R8): the worker's row is appended beside it under `dres-<id>-restored`, so a second run finds it and does
// nothing (idempotent). A row the gate reads as checking is registered as held (ports.hold) BEFORE it is written (R3: the receipt first, then
// the row), flagged "checking", so no bot reads its words until the hold settle clears it. A held `dres-` row with a copy link and no receipt
// (the receipts file write was lost, S24) is registered again.
//
// The scan is bounded: each slice reads at most a window of rows by rowid and judges at most `rowsPerSlice` `dres-` rows, and the cursor file
// keeps the last rowid reached, so a restart resumes where it stopped and a finished file scans only rows written since.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { RowSink, writeBotRow } from "./bot-egress.ts";
import { isPrepared } from "./branch-store.ts";
import { DATA_DIR } from "./config.ts";
import { findDelegationReceipt } from "./delegations.ts";
import { HANDOFF_REPLY_PREFIX, handoffReplyId } from "./handoff-reply.ts";
import { readThreadAfter } from "./message-db.ts";
import { botName, status } from "./murage-status.ts";
import { delegationTurnKey } from "./pending-delegations-schema.ts";
import { WorkerText, type EgressOrigin, type ReleasedText } from "./released-text.ts";
import type { ReleasedResult } from "./result-egress.ts";
import { ROOM_REPLY_WITHHELD } from "./room-context.ts";
import type { Message, Store } from "./store.ts";

export interface FrozenReplyPorts {
  store: Store; db: () => DatabaseSync; rows: RowSink;
  /** index.ts: isWorkspaceOwner(threadHumanPrincipal(threadId)) */
  ownerThread: (threadId: string) => boolean;
  /** The gate at the turn's originals, for the request the frozen row answered (when it carries one) and with the turn's words assembled as the finalizer
   * recorded them (`text`), so a turn of several replies is restored whole. */
  release: (origin: EgressOrigin, worker: string, sourceThreadId: string, fromBotId: string, requestId: string | undefined, text: WorkerText | undefined) => ReleasedResult;
  /** index.ts: recordDelegationReceipt with the held mark; `text` is the words the receipt keeps (C3), absent when only the row is known (S24). Returns
   * whether the receipt reached disk: when it did not, the recovery stops before this row and the next start judges it again (R3). */
  hold: (input: { handoffId: string; sourceThreadId: string; messageId: string; toBotId: string; toBotName: string; copyOf: EgressOrigin; text?: ReleasedText; requestId?: string }) => boolean;
  /** C5, "the receipt follows": a restored reply's receipt, when it still exists, gets the words and the copy link back (index.ts: settleHeldReceipt). */
  restored: (handoffId: string, patch: { result: ReleasedText; copyOf: EgressOrigin }) => void;
}

export interface FrozenRepliesSlice {
  more: boolean; scanned: number; restored: number; held: number; left: number;
  /** A hold's receipt could not be written: the slice stopped before that row (the cursor stays there) and the caller stops the recovery; the next
   * start carries on from the cursor. */
  halted?: boolean;
  /** A worker conversation whose line index is not filled yet: the slice stopped before the row that needs it (the cursor stays there), and
   * the caller prepares the thread (store.prepareThread, off the serving path) before the next slice. Additive to the frozen interface. */
  prepare?: string;
}

const RESTORED_SUFFIX = "-restored";
export function restoredReplyId(handoffId: string): string { return `${handoffReplyId(handoffId)}${RESTORED_SUFFIX}`; }

export const FROZEN_REPLIES_CURSOR = "frozen-replies-recovery.json";
const DEFAULT_ROWS_PER_SLICE = 200;
/** Rows read by rowid per slice, whatever they are: bounds a slice on a file with few `dres-` rows. */
const WINDOW_PER_JUDGED_ROW = 20;
/** Rows read after a hand-off's prompt to find the turn's first reply. */
const PROMPT_LOOKAHEAD = 200;

const FROZEN_LINE = `[${ROOM_REPLY_WITHHELD}]`;
const WRAPPER = / replied to the delegated task:\n\n/;

interface Cursor { rowid: number; done: boolean }
function readCursor(file: string): Cursor {
  try {
    if (!existsSync(file)) return { rowid: 0, done: false };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Cursor>;
    const rowid = typeof parsed.rowid === "number" && Number.isInteger(parsed.rowid) && parsed.rowid >= 0 ? parsed.rowid : 0;
    return { rowid, done: parsed.done === true };
  } catch { return { rowid: 0, done: false }; }
}
function writeCursor(file: string, cursor: Cursor): void { writeFileAtomic(file, JSON.stringify(cursor)); }

/** R6: the frozen shapes. A 1.0.2 plain row (the wrapper ending in the fixed line) or a 1.0.3 row whose kept status is replied_to_task with
 * the fixed line as its reply. Never a row with a copy link (that one carries its originals and is the gate's to judge). */
function isFrozen(message: Message): boolean {
  if (message.role !== "bot" || message.kind !== "text" || message.copyOf || !message.from?.botId) return false;
  const text = message.text ?? "";
  if (text.startsWith("@") && WRAPPER.test(text) && text.trimEnd().endsWith(FROZEN_LINE)) return true;
  const kept = message.murage?.status as { key?: string; data?: Record<string, unknown> } | undefined;
  return kept?.key === "replied_to_task" && kept.data?.reply === FROZEN_LINE;
}

/** S24: a held row (owner audience, flagged checking, with its copy link) that no receipt names. */
function isUnregisteredHeld(message: Message, handoffId: string): boolean {
  return message.role === "bot" && message.withheldFromBots === "checking" && Boolean(message.copyOf?.messageIds.length) && Boolean(message.from?.botId)
    && findDelegationReceipt(handoffId) === null;
}

type Outcome = "restored" | "held" | "left" | "skip" | "halt" | { prepare: string };

function markUnread(store: Store, threadId: string): void {
  const bot = store.botByThread(threadId);
  if (bot) { store.patchTask(bot.id, threadId, { unread: true }); return; }
  const group = store.groupByThread(threadId);
  if (group) store.patchGroup(group.id, { unread: true });
}

/** R7: the worker's prompt row and the turn's own replies, or null when any link of the chain is missing or ambiguous. */
function provenOriginals(store: Store, workerId: string, handoffId: string, sourceThreadId: string): { origin: EgressOrigin; words: WorkerText } | { prepare: string } | null {
  const worker = store.bot(workerId);
  if (!worker) return null;
  const promptId = delegationTurnKey(handoffId);
  for (const task of worker.tasks ?? [{ threadId: worker.threadId }]) {
    const prompt = store.messageById(task.threadId, promptId);
    if (!prompt) continue;
    if (prompt.role !== "user" || (prompt.handoffFrom !== undefined && prompt.handoffFrom !== sourceThreadId)) return null;
    const after = readThreadAfter(task.threadId, promptId, PROMPT_LOOKAHEAD) ?? [];
    let first: Message | undefined;
    for (const row of after) {
      if (row.role === "user") break; // the next owner row (or the next prompt): the turn is over
      if (row.role === "bot" && row.kind === "text" && !row.copyOf) { first = row; break; }
    }
    if (!first?.turnId) return null;
    if (!isPrepared(task.threadId)) return { prepare: task.threadId };
    const ids = store.turnReplyOriginals(task.threadId, first.turnId);
    if (!ids.length) return null;
    // the turn's words as the finalizer recorded them: every reply of the turn, in order (the gate reads one row's text otherwise)
    const words = ids.map(id => store.messageById(task.threadId, id)?.text ?? "").filter(Boolean).join("\n\n");
    return { origin: { threadId: task.threadId, messageIds: ids }, words: new WorkerText(words) };
  }
  return null;
}

function recoverRow(ports: FrozenReplyPorts, threadId: string, id: string): Outcome {
  const { store } = ports;
  const handoffId = id.slice(HANDOFF_REPLY_PREFIX.length);
  if (!handoffId || id.endsWith(RESTORED_SUFFIX)) return "skip";
  const message = store.messageById(threadId, id);
  if (!message) return "skip";
  if (isUnregisteredHeld(message, handoffId)) {
    if (!ports.ownerThread(threadId)) return "left";
    return ports.hold({ handoffId, sourceThreadId: threadId, messageId: message.id, toBotId: message.from!.botId, toBotName: message.from!.name, copyOf: message.copyOf!,
      ...(message.requestId ? { requestId: message.requestId } : {}) }) ? "held" : "halt";
  }
  if (!isFrozen(message)) return "skip";
  const restoredId = restoredReplyId(handoffId);
  const restored = store.messageById(threadId, restoredId);
  if (restored) {
    // done by an earlier run; a restored row still held whose receipt was lost is registered again, as S24 registers a held `dres-` row
    if (!isUnregisteredHeld(restored, handoffId)) return "skip";
    if (!ports.ownerThread(threadId)) return "left";
    return ports.hold({ handoffId, sourceThreadId: threadId, messageId: restored.id, toBotId: restored.from!.botId, toBotName: restored.from!.name, copyOf: restored.copyOf!,
      ...(restored.requestId ? { requestId: restored.requestId } : {}) }) ? "held" : "halt";
  }
  if (findDelegationReceipt(handoffId)?.notOwnerAudience === true || !ports.ownerThread(threadId)) return "left";
  const workerId = message.from!.botId;
  const proven = provenOriginals(store, workerId, handoffId, threadId);
  if (!proven) return "left";
  if ("prepare" in proven) return proven;
  const worker = store.bot(workerId)!;
  const gate = ports.release(proven.origin, workerId, threadId, store.botByThread(threadId)?.id ?? "", message.requestId, proven.words);
  const from = { botId: worker.id, name: worker.name, color: worker.color };
  if (gate.kind === "text") {
    // the receipt follows (C5), first: check/wait_delegation on this hand-off reads the words again, not the frozen line; a process that dies
    // before the row is written finds no restored row next time and judges the frozen row again (the receipt repair repeats, the same words)
    ports.restored(handoffId, { result: gate.text, copyOf: gate.copyOf ?? proven.origin });
    writeBotRow(ports.rows, threadId, { inboundKind: "action", from }, status("replied_to_task", { name: botName(worker), reply: gate.text }), undefined, restoredId);
    markUnread(store, threadId);
    return "restored";
  }
  if (gate.kind === "checking" && gate.held) {
    // R3: the receipt reaches disk first, then the row; a crash in between leaves a receipt naming no row, which the hold settle drops, and
    // the cursor (saved after the slice) brings this frozen row back on the next start.
    const registered = ports.hold({ handoffId, sourceThreadId: threadId, messageId: restoredId, toBotId: worker.id, toBotName: worker.name, copyOf: gate.held.copyOf, text: gate.held.text,
      ...(message.requestId ? { requestId: message.requestId } : {}) });
    if (!registered) return "halt";
    writeBotRow(ports.rows, threadId, { inboundKind: "action", from, withheldFromBots: "checking" }, status("replied_to_task", { name: botName(worker), reply: gate.held.text }), undefined, restoredId);
    markUnread(store, threadId);
    return "held";
  }
  return "left"; // withheld, gone, refused, or checking with nothing the owner may hold
}

/** One bounded slice of the recovery. Call again while `more`; `prepare` names a thread to prepare first. */
export function recoverFrozenRepliesSlice(ports: FrozenReplyPorts, options: { rowsPerSlice?: number; cursorFile?: string } = {}): FrozenRepliesSlice {
  const rowsPerSlice = Math.max(1, Math.floor(options.rowsPerSlice ?? DEFAULT_ROWS_PER_SLICE));
  const cursorFile = options.cursorFile ?? join(DATA_DIR, FROZEN_REPLIES_CURSOR);
  const cursor = readCursor(cursorFile);
  const windowRows = rowsPerSlice * WINDOW_PER_JUDGED_ROW;
  const rows = ports.db().prepare("SELECT rowid AS r, thread_id AS t, id FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .all(cursor.rowid, windowRows) as Array<{ r: number | bigint; t: string; id: string }>;
  const out: FrozenRepliesSlice = { more: false, scanned: 0, restored: 0, held: 0, left: 0 };
  let reached = cursor.rowid;
  let stopped = false;
  for (const row of rows) {
    const rowid = Number(row.r);
    if (typeof row.id === "string" && row.id.startsWith(HANDOFF_REPLY_PREFIX) && !row.id.endsWith(RESTORED_SUFFIX)) {
      if (out.scanned >= rowsPerSlice) { stopped = true; break; }
      const outcome = recoverRow(ports, row.t, row.id);
      if (typeof outcome === "object") { out.prepare = outcome.prepare; stopped = true; break; }
      if (outcome === "halt") { out.halted = true; stopped = true; break; }
      out.scanned++;
      if (outcome === "restored") out.restored++;
      else if (outcome === "held") out.held++;
      else if (outcome === "left") out.left++;
    }
    reached = rowid;
  }
  out.more = stopped || rows.length === windowRows;
  writeCursor(cursorFile, { rowid: reached, done: !out.more });
  return out;
}
