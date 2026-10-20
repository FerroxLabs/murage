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
// nothing (idempotent). A row the gate reads as checking is left as it is: nothing is held for a delegation (NOHOLD-DELEGATION.md), so no
// words are written and no receipt is made; a later start judges it again. A held `dres-` row an earlier 1.0.3 build left with a copy link and
// no receipt (S24) is retired: rewritten as the no-answer row, its request completed or its asker woken once (ports.retire).
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
import type { RetiredHold } from "./held-replies.ts";
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
  /** An earlier build's held row with no receipt: rewritten as the no-answer row and its request completed or its asker woken once
   * (index.ts: held-replies.ts retireHeldRow, then the retirement's complete port). */
  retire: (hold: RetiredHold, messageId: string) => void;
  /** C5, "the receipt follows": a restored reply's receipt, when it still exists, gets the words and the copy link back (index.ts: settleHeldReceipt). */
  restored: (handoffId: string, patch: { result: ReleasedText; copyOf: EgressOrigin }) => void;
}

export interface FrozenRepliesSlice {
  more: boolean; scanned: number; restored: number; retired: number; left: number;
  /** A frozen row whose check has not finished: the slice stopped before it (the cursor stays there) and the caller runs the recovery again once
   * the revocation runner is idle, so the row is restored (or stays the withheld line) then. */
  waiting?: boolean;
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

type Outcome = "restored" | "retired" | "left" | "skip" | "checking" | { prepare: string };

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

/** S24: an earlier build's held row (the words flagged "checking") that no receipt names is retired fail-closed, whoever's conversation it is in. */
function retire(ports: FrozenReplyPorts, threadId: string, message: Message, handoffId: string): Outcome {
  ports.retire({ id: handoffId, sourceThreadId: threadId, toBotId: message.from!.botId, toBotName: message.from!.name, ...(message.requestId ? { requestId: message.requestId } : {}) }, message.id);
  return "retired";
}

function recoverRow(ports: FrozenReplyPorts, threadId: string, id: string): Outcome {
  const { store } = ports;
  const handoffId = id.slice(HANDOFF_REPLY_PREFIX.length);
  if (!handoffId || id.endsWith(RESTORED_SUFFIX)) return "skip";
  const message = store.messageById(threadId, id);
  if (!message) return "skip";
  if (isUnregisteredHeld(message, handoffId)) return retire(ports, threadId, message, handoffId);
  if (!isFrozen(message)) return "skip";
  const restoredId = restoredReplyId(handoffId);
  const restored = store.messageById(threadId, restoredId);
  if (restored) {
    // done by an earlier run; a restored row an earlier build still held with its receipt lost is retired, as an S24 held `dres-` row is
    if (!isUnregisteredHeld(restored, handoffId)) return "skip";
    return retire(ports, threadId, restored, handoffId);
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
  // still being checked: nothing is held and nothing written; the slice stops before this row so it is judged again once the check finishes
  // (index.ts runs the recovery again when the revocation runner goes idle), never left as the frozen line
  if (gate.kind === "checking") return "checking";
  return "left"; // withheld (the frozen row is that line), gone or refused
}

/** One bounded slice of the recovery. Call again while `more`; `prepare` names a thread to prepare first. */
export function recoverFrozenRepliesSlice(ports: FrozenReplyPorts, options: { rowsPerSlice?: number; cursorFile?: string } = {}): FrozenRepliesSlice {
  const rowsPerSlice = Math.max(1, Math.floor(options.rowsPerSlice ?? DEFAULT_ROWS_PER_SLICE));
  const cursorFile = options.cursorFile ?? join(DATA_DIR, FROZEN_REPLIES_CURSOR);
  const cursor = readCursor(cursorFile);
  const windowRows = rowsPerSlice * WINDOW_PER_JUDGED_ROW;
  const rows = ports.db().prepare("SELECT rowid AS r, thread_id AS t, id FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .all(cursor.rowid, windowRows) as Array<{ r: number | bigint; t: string; id: string }>;
  const out: FrozenRepliesSlice = { more: false, scanned: 0, restored: 0, retired: 0, left: 0 };
  let reached = cursor.rowid;
  let stopped = false;
  for (const row of rows) {
    const rowid = Number(row.r);
    if (typeof row.id === "string" && row.id.startsWith(HANDOFF_REPLY_PREFIX) && !row.id.endsWith(RESTORED_SUFFIX)) {
      if (out.scanned >= rowsPerSlice) { stopped = true; break; }
      const outcome = recoverRow(ports, row.t, row.id);
      if (typeof outcome === "object") { out.prepare = outcome.prepare; stopped = true; break; }
      if (outcome === "checking") { out.waiting = true; break; }
      out.scanned++;
      if (outcome === "restored") out.restored++;
      else if (outcome === "retired") out.retired++;
      else if (outcome === "left") out.left++;
    }
    reached = rowid;
  }
  out.more = !out.waiting && (stopped || rows.length === windowRows);
  writeCursor(cursorFile, { rowid: reached, done: !out.more && !out.waiting });
  return out;
}
