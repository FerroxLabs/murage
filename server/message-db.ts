// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { stampEmailDerived } from "./email/external-marks.ts";
import { noteThreadChanged, threadActivitySeq, threadsChangedSince } from "./thread-activity.ts";
import { bumpForMessage, bumpMessagesVersion } from "./inbox-version.ts";
import { initializeOwnerSends } from "./send-store.ts";
import { noteHandoffEvidence } from "./handoff-evidence.ts";
import type { ProviderReply } from "./provider-reply.ts";
import { scrubOwnerSendsOfThread } from "./room-requests.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { chmodSync, readFileSync, renameSync } from "node:fs";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

import { isOpenCardJson } from "./message-tables.ts";
import { prioritizeThread, threadCardsReady, readIndexState, writeIndexState, attachmentNamesIn, keyedCardsOf, mayBeKeyed, startTranscriptBackfill, stepUpRow, type KeyedFamily } from "./transcript-backfill.ts";

import { SEQ_INDEX, newestSeqOf, nextSeq, rowToMessage, seqOfRow, storedJson, threadNumbered } from "./transcript-seq.ts";
import { database as db, databaseGeneration, closeDatabase, transaction, withBusyBudget, BACKGROUND_BUSY_MS, isDatabaseBusy } from "./database.ts";
import { browserCheckIndexExists, isPendingBrowserCheck } from "./message-tables.ts";
import type { Message } from "./store.ts";
// runtime use only (inside searchDoor): bot-read.ts imports this module, so nothing of it is read while the modules load
import { rowsShown, type Viewer } from "./bot-read.ts";
import { attachmentReferencesIn, messageJsonReferences } from "./attachment-access.ts";
import { imagePathsOf, tagImagePaths } from "./message-image-paths.ts";
import {
  MIN_INDEXED_QUERY_CODEPOINTS,
  dropThreadSearchRows,
  mergeMessageSearchIndex,
  disableMessageSearchIndex,
  messageSearchIndexReady,
  searchableText,
  trigramQuery,
  syncMessageSearchRow,
} from "./message-search-index.ts";
import { captureMessage, captureBranchChange, captureThreadDeletion, exportPasteNoted } from "./memory/capture.ts";
import { noteFluxCaptureHold } from "./flux-capture-hold.ts";
import { threadKey as keyOfThread, LINE_TEXT } from "./branch-index.ts";
import { lineClassesOf } from "./line-classes.ts";
import { boundedBranchWalk, isPrepared as isThreadPrepared, branchRows, branchTester, childRowids, requirePrepared, afterInsert, afterSpliceAfter, afterSpliceBefore, afterUpdate, forgetThread } from "./branch-store.ts";
import { closeThreadTurns, currentTurnLineage, extendLineage, markThreadNotReady, noLineageToken, openTurnsBegan, openTurnsParents, readyImportedThread, runningTurnFor, turnOfProvider, turnsOfProviderAnywhere, writeLineage, writerTurnFor } from "./memory/lineage-write.ts";
import { isMurageLine } from "./murage-line.ts";
import { isMurageVoice, murageVoiceSql } from "./murage-voice.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { lineOf } from "./memory/revoke-marker.ts";
import { COPY_ORIGINS, type LineAuthor, type LineageParents, type LineageRef, type LineageToken, type TurnLineage } from "./memory/lineage-types.ts";
import { SetupThreadFactsCache } from "./setup-thread-facts.ts";
import type { SetupThreadFacts } from "./setup.ts";

/** The setup checklist's per-conversation facts, kept per database handle
 *  until the conversation is written (every writer below touches it). */
const setupFacts = new WeakMap<DatabaseSync, SetupThreadFactsCache>();
function setupFactsCache(database: DatabaseSync): SetupThreadFactsCache {
  let cache = setupFacts.get(database);
  if (!cache) { cache = new SetupThreadFactsCache(database); setupFacts.set(database, cache); }
  return cache;
}
/** Whether an engine answered in a conversation, and any newer provider refusal: a few indexed rows, never the transcript. */
export function setupFactsFor(threadId: string): SetupThreadFacts {
  return setupFactsCache(db()).facts(threadId);
}


export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  // a numbered thread in its number order, a legacy one in storage order (ROOM-ORDER-DESIGN r7 R2): one probe picks the statement
  const rows = (threadNumbered(db(), threadId)
    ? db().prepare(`SELECT seq, json FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? ORDER BY seq`)
    : db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? ORDER BY rowid")
  ).all(threadId) as Array<{ seq: number | null; json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

/** A bounded, chronological slice of one thread's rows, untransformed.
 * `previous` is the row immediately before the first returned row (when the
 * slice is non-empty and one exists), so a reader can chain legacy rows that
 * carry no parentId exactly as a full load would. */
export interface ThreadSlice {
  messages: Message[];
  previous: Message | null;
  /** Rows exist before the first returned row. */
  hasMore: boolean;
}

// A page's order key: `seq` for a numbered thread (served by messages_thread_seq), the rowid for a legacy one (served by the
// messages_thread index, whose entries are in rowid order within a thread). Both are the order readThread() returns, and a page
// is wholly one or the other: the probe is made once per read (ROOM-ORDER-DESIGN r7 R2).
type PageKey = "seq" | "rowid";
const pageKey = (threadId: string): PageKey => (threadNumbered(db(), threadId) ? "seq" : "rowid");
const PAGE_SQL = {
  seq: {
    newest: `SELECT seq, json FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
    before: `SELECT seq, json FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
    from: `SELECT seq, json FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
  },
  rowid: {
    newest: "SELECT seq, json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?",
    before: "SELECT seq, json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
    from: "SELECT seq, json FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?",
  },
} as const;
const rowsDescending = (threadId: string, limit: number, key: PageKey, before?: number) =>
  (before === undefined
    ? db().prepare(PAGE_SQL[key].newest).all(threadId, limit)
    : db().prepare(PAGE_SQL[key].before).all(threadId, before, limit)
  ) as Array<{ seq: number | null; json: string }>;
/** The anchor row's place under `key`: its number or its rowid. */
const anchorOf = (threadId: string, messageId: string, key: PageKey): number | null =>
  key === "seq" ? messageSeq(threadId, messageId) : messageRowid(threadId, messageId);

/** Whether the thread's rows are all numbered (transcript-seq.ts threadNumbered): its pages are numbered deliveries. */
export function threadIsNumbered(threadId: string): boolean { return threadNumbered(db(), threadId); }
/** The thread's MAX(seq) (0 when empty), or undefined while it is not numbered: one probe on the index. */
export function newestSeq(threadId: string): number | undefined { return newestSeqOf(db(), threadId); }

/** A row's number in its thread (messages.seq), or null: no such row, or its thread is not numbered yet. Transcript paging only;
 * the branch and splice indexes keep messageRowid. */
export function messageSeq(threadId: string, messageId: string): number | null {
  return seqOfRow(db(), threadId, messageId);
}

function messageRowid(threadId: string, messageId: string): number | null {
  const row = db().prepare("SELECT rowid AS position FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as
    | { position: number }
    | undefined;
  return row ? row.position : null;
}

/** The first row (storage order) written at or after `at`, else the newest
 * row; null for a thread with no rows. Two indexed reads, never the thread. */
export function firstMessageSince(threadId: string, at: number): Message | null {
  const row = (db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? AND at >= ? ORDER BY rowid LIMIT 1").get(threadId, at)
    ?? db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId)) as { json: string } | undefined;
  return row ? rowToMessage(row) : null;
}

/** One row of a thread by id, through the (thread, id) key. Null when this
 * thread has no such message. */
export function readMessage(threadId: string, messageId: string): Message | null {
  const row = db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as { json: string } | undefined;
  return row ? rowToMessage(row) : null;
}

/** `limit` rows ending just before `rowid` (or at the newest row). */
function sliceEndingBefore(threadId: string, limit: number, key: PageKey, before?: number): ThreadSlice & { empty: boolean } {
  const rows = rowsDescending(threadId, limit + 1, key, before);
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit).reverse().map(rowToMessage);
  return { messages: kept, previous: hasMore && kept.length ? rowToMessage(rows[limit]) : null, hasMore, empty: rows.length === 0 };
}

/** How many rows a thread holds, read through the thread index. */
export function threadRowCount(threadId: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** One page of a thread's row count, keyed by rowid through the thread index: how many of its rows come after `afterRowid` (at most
 * `limit`) and the last of them, so a caller that needs the count of a thread of any size takes it in bounded pieces. */
export function threadRowCountPage(threadId: string, afterRowid: number, limit: number): { n: number; last: number } {
  const row = db().prepare(
    "SELECT COUNT(*) AS n, COALESCE(MAX(r), ?) AS last FROM (SELECT rowid AS r FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?)",
  ).get(afterRowid, threadId, afterRowid, limit) as { n: number; last: number } | undefined;
  return { n: Number(row?.n ?? 0), last: Number(row?.last ?? afterRowid) };
}

export function threadHasRows(threadId: string): boolean {
  return db().prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId) !== undefined;
}

/** The newest row's time per thread, kept for the life of one database connection. Every message write and thread delete is noted in
 * thread-activity.ts, so a lookup first drops the entries of threads that changed since the last one (the cost of the changes, never of
 * the thread count), then answers from memory. An idle roster broadcast therefore reads the database for no thread it has seen.
 * The cache is capped (NEWEST_AT_CAP, least recently used out first) so a long run over many threads cannot grow it without bound;
 * the cap sits well above any roster, so the steady state still answers from memory. */
export const NEWEST_AT_CAP = 4096;
let newestAtCache: { generation: number; seq: number; at: Map<string, number | null> } | null = null;

/** When the newest row was written, or null for a thread with no rows. The first lookup of a thread reads one row through the thread
 * index by rowid, never the transcript; later lookups answer from memory until the thread changes. A lookup that hits touches neither
 * the filesystem nor the database: the connection is only asked for when the answer is not held. */
export function newestMessageAt(threadId: string): number | null {
  let cache = newestAtCache;
  if (cache && cache.generation !== databaseGeneration()) cache = newestAtCache = null; // another connection: nothing held applies
  if (cache && cache.seq !== threadActivitySeq()) {
    const changed = threadsChangedSince(cache.seq);
    if (changed === null) cache.at.clear(); else for (const id of changed) cache.at.delete(id);
    cache.seq = threadActivitySeq();
  }
  const known = cache?.at.get(threadId);
  if (known !== undefined && cache) {
    cache.at.delete(threadId); cache.at.set(threadId, known); // most recently used last
    return known;
  }
  const handle = db();
  if (!cache || cache.generation !== databaseGeneration()) cache = newestAtCache = { generation: databaseGeneration(), seq: threadActivitySeq(), at: new Map() };
  const newest = handle.prepare("SELECT at FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId) as
    | { at: number }
    | undefined;
  const at = typeof newest?.at === "number" ? newest.at : null;
  // a read inside a transaction may see rows that roll back: answer, keep nothing
  if (handle.isTransaction) return at;
  cache.at.set(threadId, at);
  if (cache.at.size > NEWEST_AT_CAP) cache.at.delete(cache.at.keys().next().value as string);
  return at;
}

/** The stored branch head, or the newest row's id when none is stored —
 * the same default Store applies after a full load. */
export function readActiveLeafOrNewest(threadId: string): string | null {
  const state = db().prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId) as
    | { active_leaf_id: string | null }
    | undefined;
  if (state?.active_leaf_id) return state.active_leaf_id;
  const newest = db().prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId) as
    | { id: string }
    | undefined;
  return newest?.id ?? null;
}

/** Newest `limit` rows. Null when the thread has no rows, so the caller can
 * take the full path (which performs any one-time legacy import). */
export function readThreadNewest(threadId: string, limit: number): ThreadSlice | null {
  const { empty, ...slice } = sliceEndingBefore(threadId, limit, pageKey(threadId));
  return empty ? null : slice;
}

/** `limit` rows before `messageId` in this thread. Null when that id is not a
 * row of this thread (including a thread with no rows). */
export function readThreadBefore(threadId: string, messageId: string, limit: number): ThreadSlice | null {
  const key = pageKey(threadId);
  const anchor = anchorOf(threadId, messageId, key);
  if (anchor === null) return null;
  const { empty: _empty, ...slice } = sliceEndingBefore(threadId, limit, key, anchor);
  return slice;
}

/** Up to `limit` rows stored after `messageId`, oldest first: what was written
 * since that row, read through the thread index. Null when that id is not a
 * row of this thread. */
export function readThreadAfter(threadId: string, messageId: string, limit: number): Message[] | null {
  const anchor = messageRowid(threadId, messageId);
  if (anchor === null) return null;
  const rows = db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?").all(threadId, anchor, limit) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** The rows of one turn, oldest first, every one: from the turn's first row (turn_first, kept by the writer and filled
 * with the thread) onward, so the work is the rows written since the turn began and no cap cuts a long turn short.
 * Empty when the turn wrote nothing. The thread is prepared first. */
export function turnRows(threadId: string, turnId: string): Message[] {
  requirePrepared(threadId, "turnRows");
  const kept = db().prepare("SELECT first_rowid AS first FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId) as { first: number } | undefined;
  if (!kept) return [];
  const out: Message[] = [];
  for (const row of db().prepare("SELECT seq, json FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid").iterate(threadId, kept.first) as Iterable<{ json: string }>) {
    const message = rowToMessage(row);
    if (message.turnId === turnId) out.push(message);
  }
  return out;
}

/** The text lines of one turn, oldest first, through the line index: the activity rows a long turn writes between its
 * replies are never read. */
export function turnTextRows(threadId: string, turnId: string, classes: readonly number[] = [LINE_TEXT]): Message[] {
  requirePrepared(threadId, "turnTextRows");
  const kept = db().prepare("SELECT first_rowid AS first FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId) as { first: number } | undefined;
  const tk = keyOfThread(db(), threadId);
  if (!kept || !tk) return [];
  const read = db().prepare("SELECT l.mrow AS mrow, m.seq AS seq, m.json AS json FROM line l JOIN messages m ON m.rowid = l.mrow WHERE l.key = ? AND l.cls = ? AND l.mrow >= ? ORDER BY l.mrow");
  const rows = classes.flatMap((cls) => read.all(tk.key, cls, kept.first) as Array<{ mrow: number; json: string }>).sort((a, b) => a.mrow - b.mrow);
  return rows.map(rowToMessage).filter((message) => message.turnId === turnId);
}

/** Visit text lines newest first, a page at a time, until `visit` returns true; returns whether it did. */
export function scanTextLinesNewest(threadId: string, visit: (message: Message) => boolean, classes: readonly number[] = [LINE_TEXT]): boolean {
  let before: number | undefined;
  for (;;) {
    const page = newestLinesOf(threadId, classes, 64, before);
    if (!page.length) return false;
    for (const row of page) if (visit(row.message)) return true;
    before = page[page.length - 1]!.mrow;
  }
}

/** The bot text rows of a thread that carry saved files (artifactIds), read
 * through the partial index messages_inbox_text_artifact (inbox.ts): the work
 * is the thread's file rows, never its chat. */
export function artifactRows(threadId: string): Message[] {
  const rows = db().prepare("SELECT seq, json FROM messages INDEXED BY messages_inbox_text_artifact WHERE thread_id = ? AND role = 'bot' AND kind = 'text' AND json_extract(json, '$.artifactIds[0]') IS NOT NULL ORDER BY at").all(threadId) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** ROUTINE-DELIVER-1010: the saved-file rows a routine run wrote in its own conversation between `from` and `to`, oldest first, at most
 * `limit`, read through the same partial index as artifactRows: the work is that window's file rows, never the conversation. */
export function artifactRowsBetween(threadId: string, from: number, to: number, limit: number): Message[] {
  const rows = db().prepare("SELECT seq, json FROM messages INDEXED BY messages_inbox_text_artifact WHERE thread_id = ? AND at >= ? AND at <= ? AND role = 'bot' AND kind = 'text' AND json_extract(json, '$.artifactIds[0]') IS NOT NULL ORDER BY at LIMIT ?").all(threadId, from, to, limit) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** The newest `limit` rows of a class in the line index (text lines: kind "text" with words), newest first with their
 * places in storage. The thread is prepared first (a turn awaits that; here it is counted as a defect when it is not
 * done): the answer is the thread's lines exactly, and the work is `limit`, never the thread. */
export function newestLines(threadId: string, cls: number, limit: number, beforeMrow?: number): Array<{ mrow: number; message: Message }> {
  if (limit <= 0) return [];
  requirePrepared(threadId, "newestLines");
  const tk = keyOfThread(db(), threadId);
  if (!tk) return [];
  const rows = db().prepare(
    "SELECT l.mrow AS mrow, m.seq AS seq, m.json AS json FROM line l JOIN messages m ON m.rowid = l.mrow WHERE l.key = ? AND l.cls = ? AND l.mrow < ? ORDER BY l.mrow DESC LIMIT ?",
  ).all(tk.key, cls, beforeMrow ?? Number.MAX_SAFE_INTEGER, limit) as Array<{ mrow: number; json: string }>;
  return rows.map((row) => ({ mrow: Number(row.mrow), message: rowToMessage(row) }));
}

/** The rows of a class that are on the branch ending at `leafId`, newest first (by storage), each with its place in storage
 * and a way to ask whether it is after another row of the branch. Lazy: the caller reads only as far as it needs. */
export function* branchLinesNewest(threadId: string, leafId: string | null, cls: number): Generator<{ mrow: number; message: Message; after: (other: number) => boolean }> {
  if (leafId !== null && !isThreadPrepared(threadId)) {
    // not prepared: the lines found on the bounded walk up from the leaf, never a fill (the thread is queued for the background pass)
    const walk = boundedBranchWalk(threadId, leafId).rows;
    for (let i = 0; i < walk.length; i++) {
      const message = rowToMessage(walk[i]!);
      if (!lineClassesOf(message).includes(cls)) continue;
      yield { mrow: walk[i]!.mrow, message, after: (other) => { const j = walk.findIndex((row) => row.mrow === other); return j > i; } };
    }
    return;
  }
  const branch = branchRows(threadId, leafId);
  let before: number | undefined;
  for (;;) {
    const page = newestLines(threadId, cls, 64, before);
    if (!page.length) return;
    for (const row of page) {
      before = row.mrow;
      if (branch.contains(row.mrow)) yield { mrow: row.mrow, message: row.message, after: (other) => branch.after(row.mrow, other) };
    }
  }
}

/** The newest `n` rows of a class on the branch ending at `leafId` that `accept` takes, in their order along the branch (oldest
 * first), and whether the branch has older ones. Lines are read newest first by storage; a row keeps the key its rowid gives
 * unless a splice put it elsewhere, so the plain rows are already in branch order and a spliced row sits just before a
 * recent row: reading until `n` plain rows are in hand finds every row that can be among the newest, and the rows read are put
 * in branch order before the newest `n` are kept. */
export function topRowsOnBranch(threadId: string, leafId: string | null, cls: number, n: number, accept: (message: Message) => boolean = () => true): { rows: Array<{ mrow: number; message: Message }>; hasMore: boolean } {
  if (!leafId || n <= 0) return { rows: [], hasMore: false };
  if (!isThreadPrepared(threadId)) {
    // not prepared: the newest rows of the bounded walk up from the leaf (BOUNDED_WALK_ROWS at most), never a fill. A branch longer than
    // the walk may hold older rows than it saw: the thread is queued for the background pass and the next ask reads the index.
    const walk = boundedBranchWalk(threadId, leafId);
    const found: Array<{ mrow: number; message: Message }> = [];
    let more = false;
    for (const row of walk.rows) {
      const message = rowToMessage(row);
      if (!lineClassesOf(message).includes(cls) || !accept(message)) continue;
      if (found.length >= n) { more = true; break; }
      found.push({ mrow: row.mrow, message });
    }
    return { rows: found.reverse(), hasMore: more || !walk.complete };
  }
  const branch = branchRows(threadId, leafId);
  const collected: Array<{ mrow: number; message: Message }> = [];
  let plain = 0, more = false, before: number | undefined;
  scan: for (;;) {
    const page = newestLines(threadId, cls, 64, before);
    if (!page.length) break;
    for (const row of page) {
      before = row.mrow;
      if (!branch.contains(row.mrow) || !accept(row.message)) continue;
      if (plain >= n) { more = true; break scan; } // an older one exists beyond the n plain rows in hand
      collected.push(row);
      if (branch.plain(row.mrow)) plain++;
    }
  }
  collected.sort((a, b) => branch.compare(a.mrow, b.mrow));
  return { rows: collected.slice(-n), hasMore: more || collected.length > n };
}

/** A row's place on the branch ending at `leafId`, for ordering it against another row of the branch (by the rowid it was found at). */
export function rowPlace(threadId: string, leafId: string | null, mrow: number, message: Message): { message: Message; position: number; after: (other: number) => boolean } {
  const branch = branchRows(threadId, leafId);
  return { message, position: mrow, after: (other) => branch.after(mrow, other) };
}

/** The newest `limit` text lines of the branch ending at `leafId`, oldest first, and whether the branch has older ones. */
export function activeTextLines(threadId: string, leafId: string | null, limit: number): { messages: Message[]; hasMore: boolean } {
  const top = topRowsOnBranch(threadId, leafId, LINE_TEXT, limit);
  return { messages: top.rows.map((row) => row.message), hasMore: top.hasMore };
}

/** Rows of any of several classes, newest first by storage: each class is paged and the pages merged. */
export function newestLinesOf(threadId: string, classes: readonly number[], limit: number, beforeMrow?: number): Array<{ mrow: number; message: Message }> {
  if (classes.length === 1) return newestLines(threadId, classes[0]!, limit, beforeMrow);
  return classes.flatMap((cls) => newestLines(threadId, cls, limit, beforeMrow)).sort((a, b) => b.mrow - a.mrow).slice(0, limit);
}

/** The newest `limit` text lines, oldest first. */
export function newestTextLines(threadId: string, limit: number): Message[] {
  return newestLines(threadId, LINE_TEXT, limit).reverse().map((row) => row.message);
}

/** A row's place in storage order: the key a branch walk compares against. */
export function messagePosition(threadId: string, messageId: string): number | null {
  return messageRowid(threadId, messageId);
}

/** One step up a branch from `id`: its storage position and its parent's id
 * (a legacy row with no parent link is the child of the row stored before it,
 * as a load reads it). Null when `id` is not a row of the thread. */
export function branchStepAt(threadId: string, id: string): { position: number; parent: string | null } | null {
  const step = stepUp(threadId, id);
  return step ? { position: step.position, parent: step.parent } : null;
}

/** One step up the branch from `id` (its row, and its parent as a loaded
 * thread reads it), or null when `id` is not a row of this thread. */
export function branchStep(threadId: string, id: string): { message: Message; parent: string | null } | null {
  const step = stepUp(threadId, id);
  return step ? { message: step.message, parent: step.parent } : null;
}

/** The thread's onboarding suggestion cards nobody has typed past yet, oldest
 * first: options rows with a card that is not a request, an intake or a
 * first-run card, and is not dismissed. Read through the (kind, thread) index,
 * so the work is the thread's option cards, never its other rows. The caller
 * still checks each row (Store isOnboardingSuggestion). */
export function openOnboardingCards(threadId: string): Message[] {
  const rows = db().prepare(
    "SELECT seq, json FROM messages INDEXED BY messages_inbox_kind_thread_at WHERE kind = 'options' AND thread_id = ? AND json_extract(json, '$.card') IS NOT NULL" +
    " AND COALESCE(json_extract(json, '$.card.requestId'), '') = '' AND COALESCE(json_extract(json, '$.card.intake'), 0) = 0" +
    " AND COALESCE(json_extract(json, '$.card.setup'), 0) = 0 AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 ORDER BY rowid",
  ).all(threadId) as Array<{ json: string }>;
  const cards: Message[] = [];
  for (const row of rows) { try { cards.push(rowToMessage(row)); } catch { /* a damaged row is no card */ } }
  return cards;
}

/** The newest `limit` screen frames of a thread, newest first, through the
 * (kind, thread) index. Frame pruning keeps pixels on the newest few only, so
 * those are the only ones that can still carry them. */
export function newestScreenFrames(threadId: string, limit: number): Message[] {
  const rows = db().prepare("SELECT seq, json FROM messages INDEXED BY messages_inbox_kind_thread_at WHERE kind = 'screen' AND thread_id = ? ORDER BY at DESC LIMIT ?").all(threadId, limit) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** The newest screen frame that still carries pixels, through the (kind, thread) index: frames are read
 * newest first until one has them (the newest few do, pruning clears the rest), however many have none. */
export function newestScreenWithPixels(threadId: string): Message | null {
  for (const row of db().prepare("SELECT seq, json FROM messages INDEXED BY messages_inbox_kind_thread_at WHERE kind = 'screen' AND thread_id = ? ORDER BY at DESC").iterate(threadId) as Iterable<{ json: string }>) {
    const message = rowToMessage(row);
    if (message.png) return message;
  }
  return null;
}

/** The rows of this thread that name `path` as an image, by the message_image index: an attachment, or the
 * `<attached-image>` tag an older row carries in its text. Each row is read by its key and must still name the path
 * (the index is only a pointer, never trusted alone). The thread is prepared first, so the answer is every row of the
 * thread, however far back. */
export function rowsNamingImage(threadId: string, path: string): Message[] {
  requirePrepared(threadId, "rowsNamingImage");
  const ids = db().prepare("SELECT id FROM message_image WHERE thread_id = ? AND path = ?").all(threadId, path) as Array<{ id: string }>;
  const rows: Message[] = [];
  for (const { id } of ids) {
    const row = readMessage(threadId, id);
    if (row && imagePathsOf(row).includes(path)) rows.push(row);
  }
  return rows;
}

/** The image paths named by the thread's newest rows that name any (an attachment of kind image, or an `<attached-image>` tag),
 * newest first, at most `limit`: the conversation's own pictures a request is checked against for a duplicate. The work is the
 * thread's rows that name an image, never its other rows. */
export function recentImagePaths(threadId: string, limit: number): string[] {
  requirePrepared(threadId, "recentImagePaths");
  const rows = db().prepare("SELECT m.seq AS seq, m.json AS json FROM (SELECT DISTINCT id FROM message_image WHERE thread_id = ?) i JOIN messages m ON m.thread_id = ? AND m.id = i.id ORDER BY m.rowid DESC LIMIT ?").all(threadId, threadId, limit) as Array<{ json: string }>;
  const out: string[] = [];
  for (const row of rows) {
    const message = rowToMessage(row);
    for (const item of message.attachments ?? []) if (item.kind === "image" && !out.includes(item.path)) out.push(item.path);
    for (const path of tagImagePaths(message)) if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** Keep attachment_name in step with a written row: every stored attachment file name its JSON mentions (conversation deletion's
 * "is this file used elsewhere" is a keyed read of it). A name a later write drops stays as a pointer; readers re-check the row. */
function trackAttachmentNames(database: DatabaseSync, threadId: string, message: Message): void {
  const names = attachmentNamesIn(JSON.stringify(message));
  if (!names.length) return;
  const put = database.prepare("INSERT OR IGNORE INTO attachment_name(name, thread_id, id) VALUES (?, ?, ?)");
  for (const name of names) put.run(name, threadId, message.id);
}

/** Keep message_image in step with a written row: every image path it names, by attachment or by tag. A path a later
 * write drops stays as a pointer; readers re-check the row. */
function trackImages(database: DatabaseSync, threadId: string, message: Message): void {
  const paths = imagePathsOf(message);
  if (!paths.length) return;
  const put = database.prepare("INSERT OR IGNORE INTO message_image(thread_id, path, id) VALUES (?, ?, ?)");
  for (const path of paths) put.run(threadId, path, message.id);
}

/** How many of the newest rows a newest-page must span to include every open
 * request card and the stored branch head (`leafId`), or 0 when neither is
 * older than the newest row. An open card is one the person still has to
 * answer (OPEN_CARD_TEST, `Store.isOpenRequestCard` spelled in SQL). This is
 * the page shape of a client that cannot take cards beside its page
 * (older renderers, the phone); the oldest card comes from the card index, the
 * head from the key, and only the rows they span are counted. */
export function newestPageSpan(threadId: string, leafId: string | null): number {
  const card = !openCardIndexUsable(threadId) ? { position: openCardsLongWay(threadId, 1, "ASC").cards[0]?.rowid ?? null } : db().prepare("SELECT MIN(position) AS position FROM (SELECT m.rowid AS position FROM open_card c CROSS JOIN messages m ON m.thread_id = c.thread_id AND m.id = c.id WHERE c.thread_id = ?)").get(threadId) as { position: number | null } | undefined;
  const leaf = leafId ? messageRowid(threadId, leafId) : null;
  const floor = Math.min(card?.position ?? Infinity, leaf ?? Infinity);
  if (!Number.isFinite(floor)) return 0;
  const row = db().prepare("SELECT COUNT(*) AS span FROM messages WHERE thread_id = ? AND rowid >= ?").get(threadId, floor) as { span: number } | undefined;
  return row?.span ?? 0;
}

/** How many of the newest rows reach back to the stored branch head (0 when
 * the head is the newest row or unknown). Open request cards are NOT part of
 * this: they travel beside the page (openRequestCards). */
export function branchHeadSpan(threadId: string, leafId: string | null): number {
  if (!leafId) return 0;
  const row = db()
    .prepare("SELECT COUNT(*) AS span FROM messages WHERE thread_id = ? AND rowid >= (SELECT rowid FROM messages WHERE thread_id = ? AND id = ?)")
    .get(threadId, threadId, leafId) as { span: number } | undefined;
  return row?.span ?? 0;
}

/** The card index is filled in the background after an upgrade from a build that did not keep it. Until it is complete (or the thread has been prepared:
 * transcript-backfill.ts prioritizeThread) a card may be missing from it, and a missing card would hide an approval, so the readers below look at the
 * thread's newest rows themselves, a bounded number of them, and say when that was not the whole thread. */
function openCardIndexUsable(threadId: string): boolean {
  return threadCardsReady(db(), threadId);
}
/** Rows of one thread a reader looks at while the index cannot answer for it. */
export const OPEN_CARD_SLICE_ROWS = 500;
/** Rows left for long-way card reads while a many-thread request runs (see withLongWayBudget); null outside one. */
let longWayBudget: { rows: number } | null = null;
/** Run a synchronous read that touches many threads (the roster at first screen) with at most `rows` rows parsed by long-way card reads in all,
 * however many threads are still waiting on the card index. Threads past the budget are queued for the walker and reported incomplete. */
export function withLongWayBudget<T>(rows: number, read: () => T): T {
  const outer = longWayBudget;
  longWayBudget = { rows };
  try { return read(); } finally { longWayBudget = outer; }
}
/** Rows one many-thread request may parse for long-way card reads: eight full slices, not one per thread. */
export const LONG_WAY_REQUEST_ROWS = OPEN_CARD_SLICE_ROWS * 8;
/** The thread's open request cards found in its newest OPEN_CARD_SLICE_ROWS rows, in the order asked, at most `limit`. `incomplete` is true when the thread
 * has older rows that were not looked at; the thread is queued at the front of the walker, which prepares it so the next answer is exact. Never a scan of the thread's history. */
function openCardsLongWay(threadId: string, limit: number, order: "ASC" | "DESC"): { cards: Array<{ message: Message; rowid: number }>; incomplete: boolean } {
  // Inside withLongWayBudget (a request that reads many threads at once) the rows looked at are shared out of one budget; a thread that finds it spent is
  // not looked at now: it is queued for the walker and says incomplete, and its cards come when it is opened (a request of its own, with a full slice).
  const budget = longWayBudget;
  const take = budget ? Math.min(OPEN_CARD_SLICE_ROWS, budget.rows) : OPEN_CARD_SLICE_ROWS;
  if (take <= 0) { prioritizeThread(db(), threadId); return { cards: [], incomplete: true }; }
  const rows = db().prepare("SELECT seq, json, rowid AS position FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?").all(threadId, take) as Array<{ json: string; position: number }>;
  if (budget) budget.rows -= rows.length;
  const incomplete = rows.length >= take;
  if (incomplete) prioritizeThread(db(), threadId);
  const found: Array<{ message: Message; rowid: number }> = [];
  for (const row of order === "DESC" ? rows : [...rows].reverse()) {
    let message: Message;
    try { message = rowToMessage(row); } catch { continue; }
    if (!isOpenCardJson(message)) continue;
    found.push({ message, rowid: row.position });
    if (found.length >= limit) break;
  }
  return { cards: found, incomplete };
}

/** The thread's open request cards, newest first, at most `limit`, with whether the answer is known to be complete: through the card index when it can
 * answer for the thread (never the thread's rows), else from a bounded look at its newest rows. */
export function openRequestCardsStatus(threadId: string, limit: number): { cards: Array<{ message: Message; rowid: number }>; incomplete: boolean } {
  if (limit <= 0) return { cards: [], incomplete: false };
  if (!openCardIndexUsable(threadId)) return openCardsLongWay(threadId, limit, "DESC");
  const rows = db()
    .prepare("SELECT seq, json, position FROM (SELECT m.seq AS seq, m.json AS json, m.rowid AS position FROM open_card c CROSS JOIN messages m ON m.thread_id = c.thread_id AND m.id = c.id WHERE c.thread_id = ?) ORDER BY position DESC LIMIT ?")
    .all(threadId, limit) as Array<{ json: string; position: number }>;
  return { cards: rows.map((row) => ({ message: rowToMessage(row), rowid: row.position })), incomplete: false };
}
export function openRequestCards(threadId: string, limit: number): Array<{ message: Message; rowid: number }> {
  return openRequestCardsStatus(threadId, limit).cards;
}

/** One step up a branch (transcript-backfill.stepUpRow) as a Message. */
function stepUp(threadId: string, id: string): { position: number; message: Message; parent: string | null } | null {
  const step = stepUpRow(db(), threadId, id);
  return step ? { position: step.position, message: step.message as unknown as Message, parent: step.parent } : null;
}

/** Text lines of the branch ending at `leafId`, outward from `anchorId` in the branch's own order (what is older than the anchor for
 * "before", newer for "after"; nearest first), and whether the branch goes on past `need` of them. Order is the branch's, never storage
 * rowid, so a spliced row sits where the branch puts it. `anchorOnBranch` is false when the anchor is not on that branch at all. At most
 * `steps` rows of any kind are looked at; a stretch left unread says `more`. */
export function textLinesAlongBranch(threadId: string, leafId: string | null, anchorId: string, direction: "before" | "after", need: number, steps = 480): { anchorOnBranch: boolean; rows: Message[]; more: boolean } {
  const gone = { anchorOnBranch: false, rows: [] as Message[], more: false };
  if (leafId === null) return gone;
  const anchor = messageRowid(threadId, anchorId);
  if (anchor === null) return gone;
  const rows: Message[] = [];
  const takes = (message: Message): boolean => message.kind === "text" && typeof message.text === "string" && message.text.length > 0;
  /** Adds a row; true when the walk must stop because `need` rows are in hand and one more exists. */
  const add = (message: Message): boolean => { if (!takes(message)) return false; if (rows.length >= need) return true; rows.push(message); return false; };
  if (!isThreadPrepared(threadId)) {
    // not prepared: the bounded walk up from the leaf, never a fill (the thread is queued for the background pass)
    const walk = boundedBranchWalk(threadId, leafId);
    const at = walk.rows.findIndex((row) => row.mrow === anchor);
    if (at < 0) return gone;
    const order = direction === "before" ? walk.rows.slice(at + 1) : walk.rows.slice(0, at).reverse();
    for (const row of order) if (add(rowToMessage(row))) return { anchorOnBranch: true, rows, more: true };
    return { anchorOnBranch: true, rows, more: direction === "before" && !walk.complete };
  }
  const branch = branchRows(threadId, leafId);
  if (!branch.contains(anchor)) return gone;
  if (direction === "before") {
    let cursor: string | null = stepUp(threadId, anchorId)?.parent ?? null, looked = 0;
    while (cursor !== null) {
      if (looked++ >= steps) return { anchorOnBranch: true, rows, more: true };
      const step = stepUp(threadId, cursor);
      if (!step) break;
      if (add(step.message)) return { anchorOnBranch: true, rows, more: true };
      cursor = step.parent;
    }
    return { anchorOnBranch: true, rows, more: false };
  }
  let mrow = anchor;
  for (let looked = 0; ; looked++) {
    const next = childRowids(threadId, mrow).find((child) => branch.contains(child));
    if (next === undefined) return { anchorOnBranch: true, rows, more: false };
    if (looked >= steps) return { anchorOnBranch: true, rows, more: true };
    const stored = db().prepare("SELECT json FROM messages WHERE rowid = ? AND thread_id = ?").get(next, threadId) as { json: string } | undefined;
    if (!stored) return { anchorOnBranch: true, rows, more: false };
    if (add(rowToMessage(stored))) return { anchorOnBranch: true, rows, more: true };
    mrow = next;
  }
}

/** Which of `cards` the branch that ends at `leafId` passes through: each asked of the branch index, a few keyed reads
 * however far back the card is, exact (an approval on an abandoned branch is not on this one). */
export function cardsOnBranch(threadId: string, leafId: string | null, cards: Array<{ id: string; rowid: number }>): Set<string> {
  return cardsOnBranchStatus(threadId, leafId, cards).on;
}
/** cardsOnBranch, with whether some card could not be placed yet: the thread is not prepared, its fill is queued, and the bounded walk
 * from the leaf neither found the card nor reached the thread's first row. Such a card is in neither answer. */
export function cardsOnBranchStatus(threadId: string, leafId: string | null, cards: Array<{ id: string; rowid: number }>): { on: Set<string>; unknown: boolean } {
  if (!leafId || !cards.length) return { on: new Set(), unknown: false };
  const test = branchTester(threadId, leafId);
  const on = new Set<string>();
  let unknown = false;
  for (const card of cards) { const known = test(card.id); if (known === undefined) unknown = true; else if (known) on.add(card.id); }
  return { on, unknown };
}

/** Start the background fill of the derived transcript tables (once per open handle). */
export function startBackfill(): void {
  const handle = db();
  startTranscriptBackfill(handle, () => { try { return db() === handle; } catch { return false; } });
}

/** Up to `limit` rows of the branch that ends at `fromId`, oldest stored
 * first, found by walking real parent links (never storage order, which says
 * nothing about ancestry once a thread has forked or had a row spliced in).
 * `olderFrom` is the id of the next ancestor when the branch goes further
 * back: the cursor the next page starts from. Null when `fromId` is not a row
 * of the thread. */
export function branchChain(threadId: string, fromId: string, limit: number): { messages: Message[]; hasMore: boolean; olderFrom: string | null } | null {
  const rows: Array<{ position: number; message: Message }> = [];
  const seen = new Set<string>();
  let next: string | null = fromId;
  while (next && rows.length < limit && !seen.has(next)) {
    seen.add(next);
    const step = stepUp(threadId, next);
    if (!step) { if (!rows.length) return null; next = null; break; }
    rows.push({ position: step.position, message: step.message });
    next = step.parent;
  }
  const olderFrom = next && !seen.has(next) && stepUp(threadId, next) ? next : null;
  rows.sort((x, y) => x.position - y.position);
  return { messages: rows.map((row) => row.message), hasMore: olderFrom !== null, olderFrom };
}

/** A `limit`-row window containing `messageId`, positioned exactly as the
 * whole-array formula (anchor slightly after centre, clamped to either end).
 * Reads at most limit+1 older and limit newer rows. Null for a foreign or
 * unknown id. */
export function readThreadAround(threadId: string, messageId: string, limit: number): ThreadSlice | null {
  const key = pageKey(threadId);
  const anchor = anchorOf(threadId, messageId, key);
  if (anchor === null) return null;
  // The whole-array start is index+1 for a zero limit: never the first row.
  if (limit === 0) return { messages: [], previous: null, hasMore: true };
  const older = rowsDescending(threadId, limit + 1, key, anchor);
  const newer = db().prepare(PAGE_SQL[key].from).all(threadId, anchor, limit) as Array<{ seq: number | null; json: string }>;
  const leading = Math.floor((limit - 1) / 2);
  // start = max(0, min(index - leading, length - limit)); expressed relative
  // to the anchor, `newer.length` (capped at limit) is sufficient.
  const included = Math.min(older.length, Math.max(0, -Math.min(-leading, newer.length - limit)));
  const messages = [...older.slice(0, included).reverse(), ...newer.slice(0, limit - included)].map(rowToMessage);
  return {
    messages,
    previous: older.length > included && messages.length ? rowToMessage(older[included]) : null,
    hasMore: older.length > included,
  };
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  // Re-sequenced: a legacy file is appended to in the order things happened, but a hand-edited or merged one may not be. Every imported line
  // takes its lsn (and its rowid) in time order, so a positional range written later (a forget of an early line) reads the thread as it was.
  // A stable sort: lines with the same time, or none, keep their place in the file.
  messages = messages.map((message, place) => ({ message, place })).sort((a, b) => (Number.isFinite(a.message.at) && Number.isFinite(b.message.at) ? a.message.at - b.message.at : 0) || a.place - b.place).map(item => item.message);
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // IMMEDIATE: the allocation in replaceRow reads MAX(seq) and writes the next number in one write transaction (r7 R1)
  db().exec("BEGIN IMMEDIATE");
  try {
    for (const message of messages) {
      replaceRow(insert, threadId, message);
      // every imported line gets its lineage row, in file order (DESIGN-WRITETIME 2.9); the thread reads "checking" until the backfill passes it
      recordLineage(threadId, message, undefined, false);
    }
    // not ready until the thread's rows are known to be in time order and the upgrade has passed it (lineage-write.ts readyImportedThread)
    if (messages.length) { markThreadNotReady(db(), threadId); readyImportedThread(db(), threadId); }
    writeActiveLeaf(threadId, activeLeafId);
    setupFactsCache(db()).touch(threadId);
    db().exec("COMMIT");
    bumpMessagesVersion();
    noteThreadChanged(threadId);
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // Imported rows reach the store without insertMessage: they adopt pictures too.
  for (const message of messages) observeAdoption(message);
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

/** INSERT OR REPLACE one row and keep its search-index entry in step: a
 * replace deletes the old row (new rowid), so the old rowid's entry goes too.
 * The row's number (r7 R1): a REPLACE keeps the held key's number (bound explicitly); else a numbered thread (one with no rows
 * included) takes MAX(seq)+1 in this same write transaction; else NULL, and the walk numbers it at its rowid. `message.seq` is
 * set to what was stored (removed for NULL): every delivery path hands this same object on. The JSON never holds it. */
function replaceRow(insert: StatementSync, threadId: string, message: Message, structure: "append" | "none" = "append"): void {
  const prior = db().prepare("SELECT rowid AS position, seq FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id) as
    | { position: number; seq: number | null }
    | undefined;
  const seq = prior && prior.seq !== null ? Number(prior.seq) : threadNumbered(db(), threadId) ? nextSeq(db(), threadId) : null;
  const result = insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, storedJson(message), seq);
  if (seq === null) delete message.seq; else message.seq = seq;
  if (prior) syncMessageSearchRow(db(), prior.position, null);
  trackOpenCard(db(), threadId, message);
  trackBrowserCheck(db(), threadId, message);
  trackKeyedCards(db(), threadId, message, Boolean(prior));
  afterInsert(db(), threadId, message, Number(result.lastInsertRowid), prior?.position, structure);
  trackImages(db(), threadId, message);
  trackAttachmentNames(db(), threadId, message);
  if (message.turnId) trackTurnFirst(threadId, message, Number(result.lastInsertRowid));
  const text = searchableText(message);
  if (text !== null) syncMessageSearchRow(db(), Number(result.lastInsertRowid), text);
}

/** Record a turn's first row as it is written: the lowest position any row of the turn has had. The fill of a thread
 * (branch-index.ts) takes the same minimum over the rows stored before, so the two never disagree. */
function trackTurnFirst(threadId: string, message: Message, position: number): void {
  db().prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES (?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)").run(threadId, message.turnId!, position);
}

/** Keep keyed_card in step with a written row: the (family, key) pairs the row
 * belongs under as of now. A row that cannot be keyed costs no statement, unless
 * it replaced or patched one that was (`replaced`), which is then dropped. */
function trackKeyedCards(database: DatabaseSync, threadId: string, message: Message, replaced: boolean): void {
  const keys = mayBeKeyed(message) ? keyedCardsOf(message) : [];
  if (!keys.length && !replaced) return;
  database.prepare("DELETE FROM keyed_card WHERE thread_id = ? AND id = ?").run(threadId, message.id);
  if (!keys.length) return;
  const add = database.prepare("INSERT OR IGNORE INTO keyed_card(thread_id, family, key, id) VALUES (?, ?, ?, ?)");
  for (const { family, key } of keys) add.run(threadId, family, key, message.id);
}

const TEXT_ROW_FAMILIES = new Set<KeyedFamily>(["steer", "echo", "routineRun", "digest"]);

/** The families of cards the global index holds (the others are filed by the thread's fill). Until the background walk has filled that index (an
 * upgrade from a file that did not keep it: message-walker.ts), a reader looks at the thread's newest OPEN_CARD_SLICE_ROWS rows itself. */
function keyedLongWay(threadId: string, family: KeyedFamily, key?: string): Message[] | null {
  if (TEXT_ROW_FAMILIES.has(family) || readIndexState(db(), "keyed_card").done === 1) return null;
  const rows = db().prepare("SELECT seq, json, rowid AS position FROM messages WHERE thread_id = ? AND kind = 'options' ORDER BY rowid DESC LIMIT ?").all(threadId, OPEN_CARD_SLICE_ROWS) as Array<{ json: string; position: number }>;
  const found: Message[] = [];
  for (const row of rows) {
    let message: Message;
    try { message = rowToMessage(row); } catch { continue; }
    if (keyedCardsOf(message).some((entry) => entry.family === family && (key === undefined || entry.key === key))) found.push(message);
  }
  return found.reverse();
}

/** Whether any row of the thread is filed under `family` (and `key` when given): one keyed read. */
export function threadHasKeyed(threadId: string, family: KeyedFamily, key?: string): boolean {
  if (TEXT_ROW_FAMILIES.has(family)) requirePrepared(threadId, "threadHasKeyed");
  const longWay = keyedLongWay(threadId, family, key);
  if (longWay) return longWay.length > 0;
  const row = key === undefined
    ? db().prepare("SELECT 1 AS present FROM keyed_card WHERE thread_id = ? AND family = ? LIMIT 1").get(threadId, family)
    : db().prepare("SELECT 1 AS present FROM keyed_card WHERE thread_id = ? AND family = ? AND key = ? LIMIT 1").get(threadId, family, key);
  return row !== undefined;
}

/** The rows of a thread filed under `family` (and `key` when given), oldest
 * first, through keyed_card: the work is those cards, never the thread. */
export function keyedCardRows(threadId: string, family: KeyedFamily, key?: string): Message[] {
  // the families that live on text rows are filed by the thread's fill (branch-fill.ts): read only once it is complete
  if (TEXT_ROW_FAMILIES.has(family)) requirePrepared(threadId, "keyedCardRows");
  const longWay = keyedLongWay(threadId, family, key);
  if (longWay) return longWay;
  const rows = (key === undefined
    ? db().prepare("SELECT DISTINCT m.seq AS seq, m.json AS json, m.rowid AS position FROM keyed_card k JOIN messages m ON m.thread_id = k.thread_id AND m.id = k.id WHERE k.thread_id = ? AND k.family = ? ORDER BY position").all(threadId, family)
    : db().prepare("SELECT DISTINCT m.seq AS seq, m.json AS json, m.rowid AS position FROM keyed_card k JOIN messages m ON m.thread_id = k.thread_id AND m.id = k.id WHERE k.thread_id = ? AND k.family = ? AND k.key = ? ORDER BY position").all(threadId, family, key)) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** The rows of one kind in a thread, oldest first, through the (kind, thread,
 * at) index the inbox keeps (inbox.ts): for a kind that is rare by nature (a
 * credential request, a connect-app card), so the work is those rows. */
export function rowsOfKind(threadId: string, kind: string): Message[] {
  const rows = db().prepare("SELECT seq, json FROM messages INDEXED BY messages_inbox_kind_thread_at WHERE kind = ? AND thread_id = ? ORDER BY rowid").all(kind, threadId) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** Every thread's rows filed under `family`, by thread then position: for a
 * family that is small by nature (open browser-setup offers). */
export function keyedCardRowsAll(family: KeyedFamily): Array<{ threadId: string; message: Message }> {
  const rows = db().prepare("SELECT DISTINCT k.thread_id AS thread_id, m.seq AS seq, m.json AS json, m.rowid AS position FROM keyed_card k JOIN messages m ON m.thread_id = k.thread_id AND m.id = k.id WHERE k.family = ? ORDER BY k.thread_id, position").all(family) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}

/** Every thread holding an open request card or an answerable card of a run that died (keyed family "orphaned"): the threads
 * openRequestCardRows can answer for with a card. Read from the open-card list and the card index, which every card write keeps
 * (trackOpenCard, trackKeyedCards) and the history walk fills after an upgrade, so the work follows the open cards, never the
 * history. Null while either list is not complete: the caller then asks thread by thread. */
export function threadsWithOpenCards(): string[] | null {
  const database = db();
  if (readIndexState(database, "open_card").done !== 1 || readIndexState(database, "keyed_card").done !== 1) return null;
  const rows = database.prepare("SELECT thread_id FROM open_card UNION SELECT thread_id FROM keyed_card WHERE family = 'orphaned'").all() as Array<{ thread_id: string }>;
  return rows.map((row) => row.thread_id);
}

/** Keep the open-card list in step with a written row. */
function trackOpenCard(database: DatabaseSync, threadId: string, message: Message): void {
  if (isOpenCardJson(message)) {
    database.prepare("INSERT OR IGNORE INTO open_card(thread_id, id) VALUES (?, ?)").run(threadId, message.id);
  } else database.prepare("DELETE FROM open_card WHERE thread_id = ? AND id = ?").run(threadId, message.id);
}

/** Keep the table of pending "Checking the browser" notes in step with a written row (a note leaves it when it is rewritten to its settled wording). */
function trackBrowserCheck(database: DatabaseSync, threadId: string, message: Message): void {
  if (isPendingBrowserCheck(message)) database.prepare("INSERT OR IGNORE INTO browser_check_pending(thread_id, id) VALUES (?, ?)").run(threadId, message.id);
  else database.prepare("DELETE FROM browser_check_pending WHERE thread_id = ? AND id = ?").run(threadId, message.id);
}

/** Who wrote a stored line, for its lineage row (DESIGN-WRITETIME 2). A bot row, Murage's own lines, a copy, a hand-off prompt and an
 * engine-written user row (a delegation, ask, card or unattended message) are generated: they rest on what produced them. A line from a
 * channel or webhook person is a person line; the owner's own words (a routine's prompt included) are owner lines. */
export function lineAuthor(message: Message): LineAuthor {
  if (message.role === "bot" || message.copyOf || message.handoffFrom || message.handoffOf) return "generated";
  if (message.actorKind === "person") return "person";
  if (message.actorKind === "owner" || message.actorKind === "routine") return "owner";
  if (message.actorKind === "bot" || message.actorKind === "murage") return "generated";
  const kind = message.automation?.kind;
  if (kind === "delegation" || kind === "ask" || kind === "card" || kind === "message") return "generated";
  if (kind === "webhook" || kind === "channel" || message.automation?.channel) return "person";
  return "owner";
}


/** Whether a row may be the engine output of the turn running in its thread (DESIGN-WRITETIME 2.3): a bot row a bot speaks (its reply, a
 * tool chip, a card its tool call raised). Not engine output: anything Murage writes in its own voice (a routine.run or goal.run card, a
 * status, failure, queue or progress line: actorKind "murage", a `murage` offer or the murageLine marker (murage-line.ts: an error, retry,
 * stop or notice line the turn's event fold or a dispatch writes in the bot's colours), a "Removed a line" note), a copy, a hand-off prompt and
 * every user row (another bot's delegation or ask, a card answer). Such a row gets line-only lineage: the refs of what it quotes (lineRefs),
 * never a running turn. One rule for every writer (appendMessage, insertMessage, updateMessage); which turn an engine row belongs to is
 * lineTurnOf's, and lineage-write.ts lineageRow attaches a turn only to a line written inside it. */
export function isEngineOutput(message: Message): boolean {
  if (message.role !== "bot" || message.copyOf || message.handoffFrom || message.handoffOf) return false;
  return !isMurageVoice(message);
}

/** The running turn a line written now is the engine output of, or undefined (not engine output, or no one turn is named for it): the
 * turn its provider turn (the row's turnId) was bound to, by id (lineage-write.ts writerTurnFor), never a merge of the bot's open turns.
 * A write by a routine, Murage or another bot never attaches to, and so never makes an inherit child of, an open turn that did not produce it. */
export function lineTurnOf(threadId: string, message: Message): TurnLineage | undefined {
  return isEngineOutput(message) ? writerTurnFor(threadId, message.from?.botId, message.turnId) : undefined;
}

/** What a row that is attached to no turn rests on of the turns open for it, as the line's own refs (it is withheld when they are, and no
 * turn is made its child, so no prompt already built is held): an engine row no one turn is named for (several open turns of its member,
 * or of a thread whose row names no member) rests on all of their parents; a line Murage wrote into a turn's stream (murage-line.ts: an
 * error, retry or stop line quoting what the engine said) on the parents of the turn its turnId names. Empty otherwise. */
function unattributedRefs(threadId: string, message: Message): LineageRef[] {
  if (isMurageLine(message)) {
    if (message.role !== "bot") return [];
    // the turn that wrote the words, in this conversation or (a room copy of a bot's message) in the sender's
    const own = turnOfProvider(threadId, message.turnId);
    return (own ? [own] : turnsOfProviderAnywhere(message.turnId)).flatMap(turn => turn.parents);
  }
  if (!isEngineOutput(message) || writerTurnFor(threadId, message.from?.botId, message.turnId)) return [];
  return openTurnsParents(threadId, message.from?.botId);
}

/** When the row unattributedRefs rests on open turns, the lowest turn lsn of those turns (LineageParents.began): its turn began no later
 * than the earliest of them. Undefined otherwise. */
function unattributedBegan(threadId: string, message: Message): number | undefined {
  if (isMurageLine(message)) {
    if (message.role !== "bot") return undefined;
    const own = turnOfProvider(threadId, message.turnId);
    const turns = own ? [own] : turnsOfProviderAnywhere(message.turnId);
    return turns.length ? Math.min(...turns.map(turn => turn.turnLsn)) : undefined;
  }
  if (!isEngineOutput(message) || writerTurnFor(threadId, message.from?.botId, message.turnId)) return undefined;
  return openTurnsBegan(threadId, message.from?.botId);
}

/** What a generated line rests on besides positional context: the originals it copies (point carries), for a hand-off prompt the row that
 * handed it over (`handoffOf`, one line) or, for a prompt written before that row was kept, the asking
 * conversation read up to now plus the asking turn's parents, and for a routine's card that reports its run the run's conversation (the
 * summary or error it quotes). Null when the line must not get a row at all (a copy of more than COPY_ORIGINS lines: past the bound it is
 * withheld, by having no row). */
function lineRefs(message: Message, extra: readonly LineageRef[] | undefined): LineageRef[] | null {
  const refs: LineageRef[] = [...(extra ?? [])];
  const run = message.kind === "routine.run" ? message.routineRun : undefined;
  if (run?.executionThreadId && (run.summary || run.error)) refs.push({ kind: "prefix", threadId: run.executionThreadId });
  if (message.copyOf) {
    if (message.copyOf.messageIds.length > COPY_ORIGINS) return null;
    for (const id of message.copyOf.messageIds) refs.push({ kind: "line", threadId: message.copyOf.threadId, messageId: id });
  }
  if (message.handoffOf) {
    // the hand-off is the one row that handed it over (rule 7): that row's lineage, never the asking conversation as it reads at drain
    refs.push({ kind: "line", threadId: message.handoffOf.threadId, messageId: message.handoffOf.messageId });
  } else if (message.handoffFrom) {
    refs.push({ kind: "prefix", threadId: message.handoffFrom });
    refs.push(...(runningTurnFor(message.handoffFrom)?.parents ?? []));
  }
  return refs;
}

/** The lineage row of a line written now (writeLineage), with the running turn it is the engine output of (lineTurnOf): a reply, a member's
 * room reply (that member's turn). A row Murage, a routine or another bot wrote gets only the refs of what it quotes. `fresh` = false for an
 * import: no running turn applies. Inside the caller's transaction. */
function recordLineage(threadId: string, message: Message, extra: readonly LineageRef[] | undefined, fresh = true): LineageToken {
  const author = lineAuthor(message);
  const refs = author === "generated" ? lineRefs(message, [...(extra ?? []), ...(fresh ? unattributedRefs(threadId, message) : [])]) : [];
  const line = { threadId, messageId: message.id, author };
  if (refs === null) return noLineageToken(threadId, message.id); // over the copy bound: no row, so withheld
  const turn = author === "generated" && fresh ? lineTurnOf(threadId, message) : undefined;
  const began = author === "generated" && fresh && !turn ? unattributedBegan(threadId, message) : undefined;
  const parents: LineageParents = { ...(turn ? { turn } : {}), ...(refs.length ? { refs } : {}), ...(began !== undefined ? { began } : {}) };
  return writeLineage(db(), line, parents);
}

/** Every message write goes through here with its lineage token (writeLineage, same transaction): a message cannot be stored without
 * it. A token with lsn 0 means no row was written, and the line reads "checking" (withheld) until one is. */
function writeMessage(threadId: string, message: Message, lineage: LineageToken, reply?: ProviderReply, structure: "append" | "none" = "append"): void {
  if (lineage.threadId !== threadId || lineage.messageId !== message.id) throw new Error("LINEAGE_TOKEN_MISMATCH: the lineage token names another line");
  setupFactsCache(db()).touch(threadId);
  // the chat's "left out of memory" line under an export paste: the server's mark, written with the row (capture.ts exportPasteNoted).
  // The caller's object carries it, so the message the store sends out has it too; a mark that came in with the row is never kept.
  if (message.role === "user" && structure === "append") {
    if (exportPasteNoted(db(), threadId, message)) message.memoryNote = "export-paste";
    else delete message.memoryNote;
  }
  replaceRow(
    db().prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    threadId,
    message,
    structure,
  );
  // the Flux Memory number hold, before capture and whatever the memory mode (flux-capture-hold.ts)
  noteFluxCaptureHold(db(), threadId, message);
  captureMessage(db(), threadId, message);
  // the engine's reply to a hand-off's prompt is the evidence that the hand-off ran, recorded in this same transaction (server/handoff-evidence.ts)
  noteHandoffEvidence(db(), threadId, message, reply);
  bumpForMessage(message);
  noteThreadChanged(threadId);
}

/** The post-commit watch on owner messages (memory/feedback.ts, installed by
 * index.ts). It runs AFTER the message transaction commits, because detection is
 * async and may call the learning connection. It never throws into the write path. */
let feedbackObserver: ((threadId: string, message: Message) => void) | null = null;
export function setFeedbackObserver(observer: ((threadId: string, message: Message) => void) | null): void { feedbackObserver = observer; }
/** A bot reply was stored or grew: lets a "Remembered" chip that was waiting for it attach. Must be cheap; it runs for streamed updates. */
let botReplyObserver: ((threadId: string, message: Message) => void) | null = null;
export function setBotReplyObserver(observer: ((threadId: string, message: Message) => void) | null): void { botReplyObserver = observer; }
/** A committed message names stored attachments: lets an unsent remote upload's grant be consumed at adoption. */
let attachmentAdoptionObserver: ((paths: string[]) => void) | null = null;
export function setAttachmentAdoptionObserver(observer: ((paths: string[]) => void) | null): void { attachmentAdoptionObserver = observer; }
/** Tell the adoption observer which stored pictures a committed message names, by the one
 * reference definition visibility uses (attachment-access.ts attachmentReferencesIn). */
function observeAdoption(message: Message): void {
  if (!attachmentAdoptionObserver) return;
  try {
    const names = attachmentReferencesIn(JSON.stringify(message));
    if (names.length) attachmentAdoptionObserver(names);
  } catch { /* optional signal */ }
}
function observeCommitted(threadId: string, message: Message): void {
  observeAdoption(message);
  if (botReplyObserver && message.role === "bot" && message.kind === "text" && message.text?.trim()) { try { botReplyObserver(threadId, message); } catch { /* optional signal */ } }
  if (!feedbackObserver || message.role !== "user" || message.kind !== "text") return;
  try { feedbackObserver(threadId, message); } catch { /* optional signal */ }
}

/** Classification is sticky by verdict (LINEAGE-DESIGN-S6 rule 2): a write that would turn a stored Murage-voice row into an unclassified one
 * throws before any SQL. Only the classifying fields are read (no parse of the whole row). */
export class ClassificationViolation extends Error {}
function assertStillClassified(database: DatabaseSync, threadId: string, message: Message): void {
  if (isMurageVoice(message)) return;
  const prior = database.prepare("SELECT kind, json_type(json,'$.murageLine') AS ml, json_extract(json,'$.actorKind') AS ak, json_type(json,'$.murage') AS mt FROM messages WHERE thread_id=? AND id=? AND json_valid(json)")
    .get(threadId, message.id) as { kind: string; ml: string | null; ak: unknown; mt: string | null } | undefined;
  if (!prior) return;
  const before = { kind: prior.kind, murageLine: prior.ml === "true" ? true : undefined, actorKind: prior.ak, murage: prior.mt && prior.mt !== "null" && prior.mt !== "false" ? {} : undefined };
  if (isMurageVoice(before)) throw new ClassificationViolation(`A Murage-voice row stays classified: ${message.id}`);
}

/** `lineage`: what the line rests on besides its thread and running turn (a copy's or hand-off result's originals, an event replay's
 * lines, a room card's result), DESIGN-WRITETIME 2.4. */
export function insertMessage(threadId: string, message: Message, reply?: ProviderReply, lineage?: readonly LineageRef[]): void {
  stampEmailDerived(threadId, message);
  assertStillClassified(db(), threadId, message);
  transaction(() => writeMessage(threadId, message, recordLineage(threadId, message, lineage), reply));
  observeCommitted(threadId, message);
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message, within?: () => void, reply?: ProviderReply, lineage?: readonly LineageRef[]): void {
  stampEmailDerived(threadId, message);
  assertStillClassified(db(), threadId, message);
  transaction(() => {
    const previous = db().prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(threadId)?.active_leaf_id;
    writeMessage(threadId, message, recordLineage(threadId, message, lineage), reply);
    writeActiveLeaf(threadId, message.id);
    if ((message.parentId ?? null) !== (previous ?? null)) {
      captureBranchChange(db(), threadId, message.id, (previous as string | null | undefined) ?? null);
      // leaving a branch (regenerate, edit and resend) revokes its head: what the abandoned branch led to elsewhere is withheld (2.8). The
      // range stops at the new branch's own turn: the line just written (an edited question, whose rerun opens its turn on it) or the turn
      // that wrote it (a regenerated reply) is the new branch, and the lines after it in that turn are not the abandoned branch's.
      if (typeof previous === "string" && previous) {
        const written = lineOf(db(), threadId, message.id);
        // an edit's rerun is admitted (its turn opened) before the fork appends the edited line: its replies start at that turn
        const forking = message.role === "bot" ? undefined : currentTurnLineage(threadId);
        const until = written ? Math.min(written.turn_lsn ?? written.lsn, forking ? forking.turnLsn : Number.MAX_SAFE_INTEGER) : undefined;
        commitRevoke(db(), { kind: "line", threadId, messageIds: [previous], cause: message.role === "bot" ? "regenerate" : "branch-switch" },
          until === undefined ? {} : { until });
      }
    }
    within?.();
  });
  observeCommitted(threadId, message);
}

/** True while a splice rewrites the parent of the rows it moves: that rewrite is part of the splice, not a change the branch index must refill for. */
let splicing = false;

/** `within` runs in the same transaction as the update (a change to another row that must commit or roll back with this message); if it throws, nothing is written. */
export function updateMessage(threadId: string, message: Message, within?: () => void): void {
  stampEmailDerived(threadId, message);
  assertStillClassified(db(), threadId, message);
  transaction(database => {
    const prior = database.prepare(
      "SELECT rowid AS position, seq, kind, text, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') END AS tool_name, CASE WHEN json_valid(json) THEN json_type(json, '$.parentId') END AS parent_type, CASE WHEN json_valid(json) THEN json_extract(json, '$.parentId') END AS parent FROM messages WHERE thread_id=? AND id=?",
    ).get(threadId, message.id) as { position: number; seq: number | null; kind: string; text: string | null; tool_name: string | null; parent_type: string | null; parent: string | null } | undefined;
    // the patched object carries the row's number from this read (r7 R3), never one copied from elsewhere; the JSON never holds it
    if (prior) { if (prior.seq === null) delete message.seq; else message.seq = Number(prior.seq); }
    database.prepare("UPDATE messages SET at=?, role=?, kind=?, text=?, json=? WHERE thread_id=? AND id=?")
      .run(message.at,message.role,message.kind,message.text??null,storedJson(message),threadId,message.id);
    // A generated line patched inside its turn (a streamed reply growing) also rests on what its turn was shown since it was first written:
    // only the refs it does not carry yet are added. A row that is not that turn's engine output (a routine card turned Completed) adds only
    // the refs of what it now quotes. A line with no lineage row keeps none (it reads "checking" until the backfill).
    if (prior && lineAuthor(message) === "generated") {
      const refs = lineRefs(message, unattributedRefs(threadId, message));
      const turn = lineTurnOf(threadId, message);
      if (refs && (refs.length || turn?.parents.length)) extendLineage(database, { threadId, messageId: message.id, author: "generated" }, { ...(turn ? { turn } : {}), refs, ...(isEngineOutput(message) ? {} : { quotedNow: true }) });
    }
    // The owner changing the words of a line already written is a revoke of that line (2.8): what was built on the old words is withheld.
    if (prior && prior.kind === "text" && message.kind === "text" && lineAuthor(message) !== "generated" && (prior.text ?? "") !== (message.text ?? ""))
      commitRevoke(database, { kind: "line", threadId, messageIds: [message.id], cause: "edit" });
    // Streaming patches rewrite a message many times with the same text: only
    // re-index when what the index holds for this row would change.
    if (prior) {
      const before = searchableText({ kind: prior.kind, text: prior.text, tool: { name: prior.tool_name } });
      const after = searchableText(message);
      if (before !== after) syncMessageSearchRow(database, prior.position, after);
    }
    // An answered or dismissed card is no longer open, or sought on any branch.
    trackOpenCard(database, threadId, message);
    trackBrowserCheck(database, threadId, message);
    trackKeyedCards(database, threadId, message, prior?.kind === "options" || mayBeKeyed(message));
    if (prior) afterUpdate(database, threadId, message, prior.position, (prior.parent_type === null ? undefined : prior.parent) !== message.parentId, splicing);
    trackImages(database, threadId, message);
    trackAttachmentNames(database, threadId, message);
    noteFluxCaptureHold(database,threadId,message);
    captureMessage(database,threadId,message);
    setupFactsCache(database).touch(threadId);
    bumpForMessage(message);
    within?.();
  });
  // a patched message (new words, withheld from bots, a copy) is a change to its thread (thread-activity.ts)
  noteThreadChanged(threadId);
  observeCommitted(threadId, message);
}

/** Store `fresh` directly before `target` (which the caller rewrote to `moved`, parent now `fresh`): one transaction for the row, the rewrite and the index. */
export function insertMessageBefore(threadId: string, fresh: Message, moved: Message, reply?: ProviderReply): void {
  transaction((database) => {
    const target = messageRowid(threadId, moved.id);
    writeMessage(threadId, fresh, recordLineage(threadId, fresh, undefined), reply, "none");
    splicing = true;
    try { updateMessage(threadId, moved); } finally { splicing = false; }
    const row = messageRowid(threadId, fresh.id);
    if (target !== null && row !== null) afterSpliceBefore(database, threadId, row, target, fresh.parentId ? messageRowid(threadId, fresh.parentId) : null);
  });
  observeCommitted(threadId, fresh);
}

/** The rows whose parent is `anchorId`, in storage order: the anchor's continuation and the heads of the forks hung from it. */
export function childrenOfRow(threadId: string, anchorId: string): Message[] {
  const anchor = messageRowid(threadId, anchorId);
  if (anchor === null) return [];
  const rows: Message[] = [];
  for (const mrow of childRowids(threadId, anchor)) {
    const row = db().prepare("SELECT seq, json FROM messages WHERE rowid = ? AND thread_id = ?").get(mrow, threadId) as { json: string } | undefined;
    if (row) rows.push(rowToMessage(row));
  }
  return rows;
}

/** Store `fresh` directly after `anchorId`: it takes `children` (rewritten by the caller to `reparented`) as its own, after `others` were patched. */
export function insertMessageAfter(threadId: string, fresh: Message, anchorId: string, patched: Message[], reparented: Message[]): void {
  transaction((database) => {
    writeMessage(threadId, fresh, recordLineage(threadId, fresh, undefined), undefined, "none");
    for (const next of patched) updateMessage(threadId, next);
    splicing = true;
    try { for (const next of reparented) updateMessage(threadId, next); } finally { splicing = false; }
    const row = messageRowid(threadId, fresh.id), anchor = messageRowid(threadId, anchorId);
    if (row !== null && anchor !== null) afterSpliceAfter(database, threadId, row, anchor);
  });
  observeCommitted(threadId, fresh);
}

/** Goal cards are new SQLite-backed messages, so crash recovery can locate
 * the tiny set of unfinished receipts without eagerly loading every room
 * transcript into memory at startup. */
export function workingGoalRunMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, seq, json FROM messages " +
      "WHERE kind = 'goal.run' AND json_extract(json, '$.goalRun.status') = 'working'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}

/** Threads holding an allowed "Local computer approval" card: evidence that
 * the owner already let a bot act on this computer (grandfathering for the
 * one-time Auto confirmation, server/host-computer-consent.ts). */
export function threadsWithAllowedHostActions(): Set<string> {
  const rows = db()
    .prepare(
      "SELECT DISTINCT thread_id FROM messages " +
      "WHERE kind = 'options' AND json_extract(json, '$.card.approvalScope') = 'local-computer' " +
      "AND json_extract(json, '$.card.answered') = 'allow'",
    )
    .all() as Array<{ thread_id: string }>;
  return new Set(rows.map((row) => row.thread_id));
}

/** Threads whose visible conversation ends on a user message. After a restart
 * these are the 1:1 turns that were running when the process died: the person
 * asked, and nothing ever answered. Routines, memory turns and room goals all
 * get a restart marker; a direct turn had none, so the transcript simply
 * showed two user messages in a row (F7). Keyed off the branch head, so the
 * boot sweep costs one row per thread instead of a transcript load. */
export function threadsEndingOnUserMessage(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT s.thread_id AS thread_id, m.seq AS seq, m.json AS json FROM thread_state s " +
        "JOIN messages m ON m.thread_id = s.thread_id AND m.id = s.active_leaf_id " +
        "WHERE m.role = 'user' AND m.kind = 'text'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}

/** threadsEndingOnUserMessage for the threads whose thread_state rowid lies in (after, upTo], so a heavy history is read in bounded slices. */
export function threadsEndingOnUserMessageSlice(after: number, upTo: number): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT s.thread_id AS thread_id, m.seq AS seq, m.json AS json FROM thread_state s " +
        "JOIN messages m ON m.thread_id = s.thread_id AND m.id = s.active_leaf_id " +
        "WHERE s.rowid > ? AND s.rowid <= ? AND m.role = 'user' AND m.kind = 'text'",
    )
    .all(after, upTo) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}
/** The threads in flight (see writeActiveLeaf) whose branch head is still the person's own message, one row each; a row that no longer holds is dropped. */
export function inflightDirectTurns(): Array<{ threadId: string; message: Message }> {
  const out: Array<{ threadId: string; message: Message }> = [];
  for (const row of db().prepare("SELECT thread_id FROM direct_turn_inflight").all() as Array<{ thread_id: string }>) {
    const leaf = db().prepare("SELECT m.seq AS seq, m.json AS json FROM thread_state s JOIN messages m ON m.thread_id = s.thread_id AND m.id = s.active_leaf_id WHERE s.thread_id = ? AND m.role = 'user' AND m.kind = 'text'").get(row.thread_id) as { json: string } | undefined;
    if (!leaf) { db().prepare("DELETE FROM direct_turn_inflight WHERE thread_id = ?").run(row.thread_id); continue; }
    out.push({ threadId: row.thread_id, message: rowToMessage(leaf) });
  }
  return out;
}
/** Whether the one-time walk over thread_state (for a file that predates the in-flight table) has finished. */
export function directTurnsWalked(): boolean { return readIndexState(db(), "direct_turns_walk").done === 1; }
export function markDirectTurnsWalked(): void { backgroundMark("direct-turns-mark", d => writeIndexState(d, "direct_turns_walk", { done: 1, cursor: 0, skipped: 0 })); }
/** A mark the boot recoveries write after listen (an autocommit statement): within the background budget. A held lock leaves the mark where it
 * was (the walks are resumable from the saved place, so the next slice or the next start writes it again); it is never a failure. */
function backgroundMark(op: string, write: (database: DatabaseSync) => void): void {
  try { withBusyBudget(BACKGROUND_BUSY_MS, op, write); }
  catch (error) { if (!isDatabaseBusy(error)) throw error; }
}
/** The highest rowid of messages (a seek). */
export function messagesHighWater(): number { return Number((db().prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM messages").get() as { n: number }).n); }
const CARD_SWEEP_MARK = "card_sweep_through";
/** The sweep marks below say "every row numbered above me was written after the sweep reached me". SQLite numbers a new row one past the newest, so a
 * delete that removes the newest rows frees their numbers for the next writes: in the same transaction as such a delete, a mark above the newest row
 * left comes down to it (a seek and at most two point writes). The marks are then durable insertion cursors: a card written later, whatever number it
 * gets, is above the mark and is swept. */
function lowerSweepMarks(database: DatabaseSync): void {
  const high = Number((database.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM messages").get() as { n: number }).n);
  const through = readIndexState(database, CARD_SWEEP_MARK);
  if (through.done === 1 && through.cursor > high) writeIndexState(database, CARD_SWEEP_MARK, { done: 1, cursor: high, skipped: 0 });
  const range = readIndexState(database, TOOL_CARD_SWEEP_MARK);
  if (range.done === 1 && (range.cursor > high || range.skipped > high)) writeIndexState(database, TOOL_CARD_SWEEP_MARK, { done: 1, cursor: Math.min(range.cursor, high), skipped: Math.min(range.skipped, high) });
}
/** The rowid the previous starts' sweep of cards left open by a dead run reached (0: none yet). A mark above the newest row is cut to it (deleting the newest conversation does not send the next start back over the whole history). */
export function cardSweepThrough(high: number): number {
  const state = readIndexState(db(), CARD_SWEEP_MARK);
  return state.done === 1 ? Math.min(state.cursor, high) : 0;
}
export function keepCardSweepThrough(rowid: number): void { backgroundMark("card-sweep-mark", d => writeIndexState(d, CARD_SWEEP_MARK, { done: 1, cursor: rowid, skipped: 0 })); }
/** The highest rowid of thread_state (a seek). */
export function threadStateHighWater(): number {
  return Number((db().prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM thread_state").get() as { n: number }).n);
}

/** The "Checking the browser" notes still pending (null while the table is not complete), with whether each is its
 * thread's branch head. Reads browser_check_pending (server/message-tables.ts), which the writers keep: cost follows the pending notes, not the history. */
export function pendingBrowserCheckRows(): Array<{ threadId: string; message: Message; isLeaf: boolean }> | null {
  // The table is not yet complete (its background fill has not finished): null, never a scan of the history on the request path.
  if (!browserCheckIndexExists(db())) return null;
  const rows = db()
    .prepare(
      "SELECT m.thread_id AS thread_id, m.seq AS seq, m.json AS json, (s.active_leaf_id = m.id) AS is_leaf FROM browser_check_pending p " +
        "CROSS JOIN messages m ON m.thread_id = p.thread_id AND m.id = p.id " +
        "LEFT JOIN thread_state s ON s.thread_id = m.thread_id",
    )
    .all() as Array<{ thread_id: string; json: string; is_leaf: number | null }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row), isLeaf: row.is_leaf === 1 }));
}

/** The query plan of pendingBrowserCheckRows, for the test that proves it never scans history. */
export function pendingBrowserCheckPlan(): string[] {
  return (db().prepare(
    "EXPLAIN QUERY PLAN SELECT m.thread_id, m.json FROM browser_check_pending p CROSS JOIN messages m ON m.thread_id = p.thread_id AND m.id = p.id",
  ).all() as Array<{ detail: string }>).map((row) => row.detail);
}

/** Provider question cards still waiting on an answer (0.1.52 ASK2). An
 * engine's wait lives only in memory, so after a restart every one of these
 * is unanswerable where it stands; the boot sweep marks them Expired so a
 * late answer can still go out as a message. A question card is a request
 * card without a permission tool and without a harness-owned proposal. */
export function openQuestionCardMessages(after = 0, upTo = Number.MAX_SAFE_INTEGER): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, seq, json FROM messages WHERE rowid > ? AND rowid <= ? AND kind = 'options' " +
        "AND json_type(json, '$.card.requestId') = 'text' " +
        "AND json_type(json, '$.card.tool') IS NULL " +
        "AND json_type(json, '$.card.answered') IS NULL " +
        "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 " +
        "AND json_type(json, '$.card.routineRequest') IS NULL " +
        "AND json_type(json, '$.card.skillRequest') IS NULL " +
        "AND json_type(json, '$.card.intake') IS NULL",
    )
    .all(after, upTo) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}

/** Permission cards (a card carrying a tool) still waiting on an answer. The
 * request behind every one lives only in memory (the engine's ask, the image
 * or computer-consent broker), so after a restart none of them can be
 * answered where it stands, and each would sit in the Inbox under "Waiting 1
 * hour" with Allow once and Deny that can do nothing (D7). Harness-owned
 * proposals are durable and are left alone. */
export function openApprovalCardMessages(after = 0, upTo = Number.MAX_SAFE_INTEGER): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, seq, json FROM messages WHERE rowid > ? AND rowid <= ? AND kind = 'options' " +
        "AND json_type(json, '$.card.requestId') = 'text' " +
        "AND json_type(json, '$.card.tool') = 'text' " +
        "AND json_type(json, '$.card.answered') IS NULL " +
        "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 " +
        "AND COALESCE(json_extract(json, '$.card.orphaned'), 0) = 0 " +
        "AND json_type(json, '$.card.routineRequest') IS NULL " +
        "AND json_type(json, '$.card.skillRequest') IS NULL " +
        "AND json_type(json, '$.card.intake') IS NULL",
    )
    .all(after, upTo) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}

const OPEN_TOOL_CARD_FILTER = "m.kind = 'options' AND json_type(m.json, '$.card.requestId') = 'text' AND json_type(m.json, '$.card.answered') IS NULL AND COALESCE(json_extract(m.json, '$.card.dismissed'), 0) = 0";
/** Open request cards carrying one of `tools`, read through the open-card list (cost follows the open cards, never the history). Null while that list is
 * not complete: the caller then walks rowid ranges after the server listens instead of looking at transcripts. */
export function openToolCardRowsIndexed(tools: readonly string[]): Array<{ threadId: string; message: Message }> | null {
  if (readIndexState(db(), "open_card").done !== 1) return null;
  if (tools.length === 0) return [];
  const marks = tools.map(() => "?").join(", ");
  const rows = db()
    .prepare(`SELECT m.thread_id AS thread_id, m.seq AS seq, m.json AS json FROM open_card c CROSS JOIN messages m ON m.thread_id = c.thread_id AND m.id = c.id WHERE ${OPEN_TOOL_CARD_FILTER} AND json_extract(m.json, '$.card.tool') IN (${marks})`)
    .all(...tools) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}
/** A key of the open-card list (thread, card id): pages of it resume after one. */
export type OpenCardKey = readonly [string, string];
/** Rows of the open-card list one page reads (each one a primary-key seek of its message), counted for tests that pin the work down. */
let openCardRowsRead = 0;
export function openCardPageRowsRead(): number { return openCardRowsRead; }
/** One page of the open-card list in key order after `after` (at most `limit` list rows, whatever card they hold), with the open request cards among
 * them that carry one of `tools` and were written at or below `upTo` (the start's high-water mark: no card of this run). `next` is where the following
 * page starts, null when the list is done. A start reads one page before it listens and the rest after, so what it does before listen is the same with
 * 20,000 open cards as with 200,000. Null while the list is not complete. */
export function openToolCardPage(tools: readonly string[], after: OpenCardKey | null, limit: number, upTo: number): { rows: Array<{ threadId: string; message: Message }>; next: OpenCardKey | null } | null {
  if (readIndexState(db(), "open_card").done !== 1) return null;
  const keys = (after
    ? db().prepare("SELECT thread_id, id FROM open_card WHERE (thread_id, id) > (?, ?) ORDER BY thread_id, id LIMIT ?").all(after[0], after[1], limit)
    : db().prepare("SELECT thread_id, id FROM open_card ORDER BY thread_id, id LIMIT ?").all(limit)) as Array<{ thread_id: string; id: string }>;
  openCardRowsRead += keys.length;
  const wanted = new Set(tools), rows: Array<{ threadId: string; message: Message }> = [];
  const read = db().prepare("SELECT rowid AS position, seq, json FROM messages WHERE thread_id = ? AND id = ?");
  for (const key of keys) {
    const row = read.get(key.thread_id, key.id) as { position: number; json: string } | undefined;
    if (!row || row.position > upTo) continue;
    let message: Message;
    try { message = rowToMessage(row); } catch { continue; }
    const card = message.card;
    if (message.kind !== "options" || typeof card?.requestId !== "string" || card.answered || card.dismissed || typeof card.tool !== "string" || !wanted.has(card.tool)) continue;
    rows.push({ threadId: key.thread_id, message });
  }
  const last = keys[keys.length - 1];
  return { rows, next: keys.length === limit && last ? [last.thread_id, last.id] : null };
}
/** Open request cards carrying one of `tools` among the rows with a storage position in (after, upTo]: a bounded range, for a slice of a sweep. */
export function openToolCardRowsInRange(tools: readonly string[], after: number, upTo: number): Array<{ threadId: string; message: Message }> {
  if (tools.length === 0) return [];
  const marks = tools.map(() => "?").join(", ");
  const rows = db()
    .prepare(`SELECT m.thread_id AS thread_id, m.seq AS seq, m.json AS json FROM messages m WHERE m.rowid > ? AND m.rowid <= ? AND ${OPEN_TOOL_CARD_FILTER} AND json_extract(m.json, '$.card.tool') IN (${marks})`)
    .all(after, upTo, ...tools) as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: rowToMessage(row) }));
}
/** The query plans of the two readers above, for the test that proves neither reads a transcript. */
export function openToolCardPlans(): { indexed: string[]; range: string[] } {
  const plan = (sql: string, ...args: Array<string | number>) => (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail);
  return {
    indexed: plan(`SELECT m.thread_id, m.json FROM open_card c CROSS JOIN messages m ON m.thread_id = c.thread_id AND m.id = c.id WHERE json_extract(m.json, '$.card.tool') IN (?)`, "x"),
    range: plan(`SELECT m.thread_id, m.json FROM messages m WHERE m.rowid > ? AND m.rowid <= ? AND json_extract(m.json, '$.card.tool') IN (?)`, 0, 1, "x"),
  };
}
const TOOL_CARD_SWEEP_MARK = "stale_tool_card_sweep_range";
/** Whether the open-card list is complete (then the list alone answers for every open card, and no history sweep is needed). */
export function openCardIndexDone(): boolean { return readIndexState(db(), "open_card").done === 1; }
/** The rows with a storage position in (floor, top] have been swept for peer and consent cards left by a dead run. A range above the newest row is cut
 * to it; the marks are kept (rows are not renumbered by anything but an empty table). */
export function toolCardSweepRange(high: number): { floor: number; top: number } {
  const state = readIndexState(db(), TOOL_CARD_SWEEP_MARK);
  if (state.done !== 1) return { floor: high, top: high };
  return { floor: Math.min(state.cursor, high), top: Math.min(state.skipped, high) };
}
export function keepToolCardSweepRange(floor: number, top: number): void { backgroundMark("card-sweep-mark", d => writeIndexState(d, TOOL_CARD_SWEEP_MARK, { done: 1, cursor: floor, skipped: top })); }

function writeActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
  // A direct turn is in flight while the visible end of its thread is the person's own message (written when the turn is admitted, removed when anything
  // answers it): the boot sweep for interrupted turns reads this table alone.
  db().prepare("DELETE FROM direct_turn_inflight WHERE thread_id = ?").run(threadId);
  if (leafId) {
    const leaf = db().prepare("SELECT at FROM messages WHERE thread_id = ? AND id = ? AND role = 'user' AND kind = 'text'").get(threadId, leafId) as { at: number } | undefined;
    if (leaf) db().prepare("INSERT OR REPLACE INTO direct_turn_inflight(thread_id, turn_id, started_at) VALUES (?, ?, ?)").run(threadId, leafId, Number(leaf.at));
  }
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  transaction(database => {
    const previous = (database.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(threadId) as { active_leaf_id: string | null } | undefined)?.active_leaf_id ?? null;
    writeActiveLeaf(threadId,leafId); captureBranchChange(database,threadId,leafId,previous);
    // a branch switch revokes the head it leaves (2.8)
    if (typeof previous === "string" && previous && previous !== leafId) commitRevoke(database, { kind: "line", threadId, messageIds: [previous], cause: "branch-switch" });
  });
}

export function deleteThread(threadId: string): void {
  transaction(database => {
    // deleting the conversation is one revoke of the whole thread (its lineage rows stay: the marker walks out of them). The capture
    // commits it (capture.ts captureThreadDeletion), whatever memory captured; a second commit here doubled every deletion's mark walk.
    captureThreadDeletion(database,threadId);
    // the durable proof that the OWNER deleted this conversation, committed with its rows (owner-deletions.ts)
    recordOwnerDeletion(database, threadId);
    const indexed = dropThreadSearchRows(database, threadId); // before the rows it is keyed by go
    database.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
    lowerSweepMarks(database);
    setupFactsCache(database).forget(threadId);
    database.prepare("DELETE FROM thread_state WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM open_card WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM browser_check_pending WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM keyed_card WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM turn_first WHERE thread_id=?").run(threadId);
    forgetThread(database, threadId);
    database.prepare("DELETE FROM message_image WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM attachment_name WHERE thread_id=?").run(threadId);
    // the owner's sends for this conversation go with it (the words of a waiting or unconfirmed one live there)
    initializeOwnerSends(database);
    database.prepare("DELETE FROM owner_sends WHERE thread_id=?").run(threadId);
    // ...and so do the words of its room requests (a request closed later must not make a chip for a conversation that is gone)
    scrubOwnerSendsOfThread(database, threadId);
    if (indexed) mergeMessageSearchIndex(database);
    bumpMessagesVersion();
    noteThreadChanged(threadId);
  });
  closeThreadTurns(threadId);
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * Queries of three or more characters ask the trigram index
 * (message-search-index.ts) for candidate rows, then check each with the same
 * LIKE the search has always used, so the index can narrow a search but never
 * add a hit. Shorter queries (1-2 characters, which includes most CJK words),
 * and any handle whose index is not known complete, scan with LIKE. Either
 * way the result is the rows the scan would return.
 *
 * LIKE is ASCII-case-insensitive on both sides, so the old `lower(text)` is
 * redundant (it was ASCII-only too) and is gone. Only the final page of rows
 * is read through json_extract.
 *
 * @param threads the only threads that may be searched — one id, or a set.
 *   Absent means no restriction. An **empty array means nothing is visible
 *   and returns no rows**, never "no restriction": that is the direction
 *   this argument would otherwise fail in, and it is the direction that
 *   leaks.
 *
 *   The set is bound as a single JSON parameter and unpacked by `json_each`
 *   rather than expanded into `IN (?, ?, …)`. A workspace can hold 100 bots
 *   (`MAX_WORKSPACE_BOTS`) each with any number of task threads, so the
 *   placeholder count is unbounded and would eventually meet SQLite's
 *   variable ceiling — as a runtime throw, on a big workspace, in the one
 *   path whose job is to not leak. One parameter has no ceiling to meet.
 *
 *   Scoping happens **inside** the SQL so `LIMIT` counts rows the caller can
 *   actually see. A post-filter applied to the rows this returns would cut a
 *   full page down to a short one, and can return zero while matches exist. */
/** The bounded newest window a short or pre-index query is answered from. Never a full-table LIKE on the loop. */
export const SHORT_QUERY_WINDOW = 4000;
/** The most trigram index matches one search examines, in scope or not. A common word matches thousands of rows; the newest-inserted of them
 * answer the search and the result is marked partial when more existed, so the cost no longer grows with how often the word was said, nor with
 * how many matches sit outside the scope. A scope of a few threads whose matches lie past the cap is answered by walking those threads instead. */
export const TRIGRAM_CANDIDATE_CAP = 2000;
/** Candidates verified per statement. */
export const SEARCH_CHUNK = 200;
export const WINDOW_CHUNK = 500;
/** A thread scope of at most this many threads is walked thread by thread through the (kind, thread_id, at) index, so the window counts
 * in-scope rows only and one chunk reads at most WINDOW_CHUNK index entries per thread and kind. A wider scope (a companion that can see most of
 * the workspace) walks the newest rows of the whole table through the at index and applies the scope in the verify: one chunk is then
 * WINDOW_CHUNK index entries whatever the scope, and the window counts rows looked at, in scope or not (the answer says partial when rows are left). */
export const SCOPED_WINDOW_THREADS = 8;
/** The most at-index entries an unscoped trigram search walks to put its candidates in time order (about 80 covering-index pages); the
 * candidates not reached by then are read by rowid instead. */
export const CANDIDATE_WALK_ROWS = 20_000;

/** The reader a non-owner search answers: no bot of the roster (so no partition of one), read through the door as a bot reads, under no
 * turn audience (content checks only). */
const SEARCH_READER: Viewer = Object.freeze({ kind: "bot", botId: "\u0000search" });

/** The door's verdict on one chunk of matching rows for a non-owner search: only the rows it shows as stored. Fail closed: a row whose JSON
 * does not parse, or a chunk the door throws on, gives no hit. */
function searchDoor(handle: DatabaseSync, rows: ReadonlyArray<SearchRow & { json?: string }>): SearchRow[] {
  const held: Array<{ threadId: string; row: Message }> = [];
  const kept: SearchRow[] = [];
  for (const { json, ...row } of rows) {
    let stored: unknown;
    try { stored = rowToMessage({ json: String(json) }); } catch { continue; }       // the one decoder of a stored row (transcript-seq.ts)
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
    held.push({ threadId: row.thread_id, row: { ...(stored as Message), id: row.id, role: row.role as Message["role"], kind: row.kind as Message["kind"], text: row.text ?? undefined } });
    kept.push(row);
  }
  if (!held.length) return [];
  let shown: boolean[];
  try { shown = rowsShown(handle, SEARCH_READER, held); } catch { return []; }
  return kept.filter((_, index) => shown[index] === true);
}

interface SearchRow {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  from_name: string | null;
  rid?: number;
}

/** Who reads the answer. The owner is shown every row of their own transcripts, the ones withheld from bots included (Message.withheldFromBots:
 * the owner still sees those). Every other reader (a script or agent through the local MCP server, a door that did not prove the owner) is never
 * shown a row the owner withheld from bots, and that is the default. */
export interface SearchAudience {
  owner?: boolean;
  /** "door": the caller applies the reader door's own verdict to every row, so the withheld-from-bots clause is dropped here and only text rows are
   * candidates. */
  judge?: "door";
  /** All chats and the bot chat pop-up (CHATS-FINDABILITY-DESIGN 3.5): a line the owner forgot is never a hit there, the owner included. A
   * forgotten line is one stamped `withheldFromBots: "forgotten"`, or one whose message source the owner forgot (an owner-forget or
   * forgotten-supporting-source tombstone) or whose source is deleted. Checked inside the verify, so LIMIT counts rows this view may show.
   * Every other caller leaves it unset and is answered as before. */
  excludeForgotten?: boolean;
}

export function searchMessages(
  query: string,
  limit = 40,
  threads?: string | readonly string[],
  audience: SearchAudience = {},
): SearchHit[] {
  return searchMessagesWithMeta(query, limit, threads, audience).hits;
}

/** As searchMessages, plus whether the answer is partial. `partial` is true exactly when the search knows of matches beyond the page it returns,
 * or stopped before it had examined every candidate in scope (a window or a cap was reached with rows left over). It is false only when every
 * candidate in scope was examined and every match is in the page. */
export function searchMessagesWithMeta(
  query: string,
  limit = 40,
  threads?: string | readonly string[],
  audience: SearchAudience = {},
  before?: number,
): { hits: SearchHit[]; partial: boolean } {
  let partial = false;
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], partial };
  const threadIds = typeof threads === "string" ? [threads] : threads;
  if (threadIds && threadIds.length === 0) return { hits: [], partial };
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadIds ? "m.thread_id IN (SELECT value FROM json_each(?)) AND " : "";
  // Not the owner: a row withheld from bots (true or "forgotten") is not a hit. Checked inside the verify so LIMIT counts rows this reader
  // may get, and after the LIKE so only a matching row's JSON is read. A "checking" left on disk is no note (never a stored verdict).
  // Not the owner: a Murage-voice row is never a hit either (the reader door, bot-read.ts: a bot never reads Murage's own words).
  const withheld = audience.owner || audience.judge === "door" ? "" : ` AND COALESCE(NULLIF(json_extract(m.json, '$.withheldFromBots'), 'checking'), 0) = 0 AND NOT ${murageVoiceSql("m")}`;
  // The forgotten-line exclusion (SearchAudience.excludeForgotten): after the LIKE, so only a matching row's JSON and its source are probed
  // (one primary-key probe of memory_sources, one range seek of memory_tombstones' target index per verified row).
  const forgotten = audience.excludeForgotten
    ? " AND COALESCE(json_extract(m.json, '$.withheldFromBots'), '') IS NOT 'forgotten'" +
      " AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type = 'source' AND t.target_id = 'message:' || m.thread_id || ':' || m.id" +
      " AND t.reason IN ('owner-forget', 'forgotten-supporting-source'))" +
      " AND NOT EXISTS (SELECT 1 FROM memory_sources s WHERE s.id = 'message:' || m.thread_id || ':' || m.id AND s.state = 'deleted')"
    : "";
  const doorOnly = audience.judge === "door";
  const verify = doorOnly
    ? "(m.kind = 'text' AND m.text IS NOT NULL AND m.text LIKE ? ESCAPE '\\')"
    : "((m.kind = 'text' AND m.text IS NOT NULL AND m.text LIKE ? ESCAPE '\\') " +
      "OR (m.kind = 'activity' AND json_extract(m.json, '$.tool.name') LIKE ? ESCAPE '\\'))";
  const verifyParams = (): string[] => (doorOnly ? [pattern] : [pattern, pattern]);
  // `before` is a walk start and a final filter, never text in a walk's predicate: a row at exactly `before` is on no path.
  const beforeSql = before === undefined ? "" : " AND m.at < ?";
  const beforeParams: number[] = before === undefined ? [] : [before];
  const handle = db();
  const scopeParams = threadIds ? [JSON.stringify([...threadIds])] : [];
  // Each chunk of candidate rowids is its own statement: the loop is held for at most one chunk, and the search stops as soon as it holds one
  // verified hit more than the page (so it knows whether more exist), so its cost follows limit / hit-rate, never the size of the history.
  //
  // CROSS JOIN pins the join order: the chunk's rowids first, one primary-key probe each. Written as `m.rowid IN (json_each)` the planner chose
  // the kind index instead and walked EVERY text and activity row of the table for every chunk (103,000 rows per chunk on the owner's data:
  // a 2-character query took 1.4 s and held the loop; rc9 data test). The page is sorted once by page(), so no ORDER BY here.
  //
  // Not the owner: every matching row then passes the reader door (bot-read.ts, the same judgment a bot's transcript gets: lineage denials,
  // copy and hand-off ancestry, the row check) before any snippet is cut from it, one door operation per chunk. A row the door does not show
  // as stored is not a hit, and a chunk the door cannot judge yields none (fail closed).
  const verifyChunk = (ids: number[]): SearchRow[] => {
    if (ids.length === 0) return [];
    const rows = handle.prepare(
      "SELECT m.thread_id, m.id, m.at, m.role, m.kind, m.text, json_extract(m.json, '$.tool.name') AS tool_name, json_extract(m.json, '$.from.name') AS from_name, m.rowid AS rid" +
      `${audience.owner ? "" : ", m.json AS json"} FROM json_each(?) c CROSS JOIN messages m ON m.rowid = c.value WHERE ${scope}${verify}${withheld}${forgotten}${beforeSql}`,
    ).all(JSON.stringify(ids), ...scopeParams, ...verifyParams(), ...beforeParams) as unknown as Array<SearchRow & { json?: string }>;
    // a `judge: "door"` caller (thread recall) runs the same door over every hit itself, so it can count what it holds back (checking,
    // could not be judged, partial); judged here too, those rows would vanish uncounted
    if (audience.owner || doorOnly) return rows;
    return searchDoor(handle, rows);
  };
  const verified: SearchRow[] = [];
  /** One more than the page: holding it proves matches exist beyond what is returned. */
  const enough = () => verified.length > limit;
  /** Newest hits first, one page. Chunks arrive newest-first, so a later chunk only fills the page when earlier ones could not. */
  const page = (): SearchRow[] => verified.sort((x, y) => y.at - x.at || (y.rid ?? 0) - (x.rid ?? 0)).slice(0, limit);
  const perThread = threadIds && threadIds.length <= SCOPED_WINDOW_THREADS ? [...threadIds] : null;
  if ([...needle].length >= MIN_INDEXED_QUERY_CODEPOINTS && messageSearchIndexReady(handle)) {
    // The trigram index names the candidates (code points, not UTF-16 units); they are verified in RESULT order, (at DESC, rowid DESC), because rowid is
    // insertion order and an import gives old messages new rowids.
    try {
      const match = trigramQuery(needle);
      if (!threadIds) {
        // No scope (the owner's desktop): the candidates are read from the index alone (rowids, no row touched) and put in time order by the
        // at index, never by reading each candidate's row for its timestamp. That read was one random table page per candidate, 2,001 for a
        // common word: 1,888 page misses and 1.4 s on a cold cache on the owner's copy, and 53 to 249 ms a search in the rc13 data run while
        // the memory upgrade's commits kept dropping the page cache (/api/search?q=email p95 129 ms, 176 ms after the upgrade).
        const candidates = (handle.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ?")
          .all(match, TRIGRAM_CANDIDATE_CAP + 1) as Array<{ rowid: number }>).map((row) => Number(row.rowid));
        if (candidates.length > TRIGRAM_CANDIDATE_CAP) { candidates.length = TRIGRAM_CANDIDATE_CAP; partial = true; }
        verifyNewestCandidates(candidates);
      } else {
        // At most CAP+1 index matches are EXAMINED, the highest rowids first, whatever the scope: the scope is checked on those rows (one primary-key
        // probe each), never by reading on through the index until enough in-scope rows turn up (thread A's one match behind 100,000 newer
        // matches in thread B was 100,000 probes). LEFT JOIN keeps the index row's place in the count when its message is gone.
        const inScope = "s.thread_id IN (SELECT value FROM json_each(?))";
        const examined = handle.prepare(
          `SELECT f.rowid AS rowid, s.at AS at, ${inScope} AS ok FROM (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ?) f ` +
          "LEFT JOIN messages s ON s.rowid = f.rowid",
        ).all(...scopeParams, match, TRIGRAM_CANDIDATE_CAP + 1) as Array<{ rowid: number; at: number | null; ok: number | null }>;
        const capped = examined.length > TRIGRAM_CANDIDATE_CAP;
        if (capped && perThread) {
          // A few threads, and the index holds more matches than one read may examine: walk those threads' own rows newest first (the kind index)
          // and check each chunk with the LIKE, as a short query does. The window bounds the walk; running out of the scope first is a complete
          // answer. (Asking the trigram index about each walked row by rowid was measured on the owner's copy: 134 ms of CPU per 500 rows, against
          // under 1 ms for the LIKE on the same rows.)
          walkWindow(perThread);
        } else {
          if (capped) { examined.length = TRIGRAM_CANDIDATE_CAP; partial = true; }
          const all = examined.filter((row): row is { rowid: number; at: number; ok: number } => row.at !== null && Boolean(row.ok) && (before === undefined || row.at < before));
          all.sort((x, y) => y.at - x.at || y.rowid - x.rowid);
          for (let i = 0; i < all.length && !enough(); i += SEARCH_CHUNK) verified.push(...verifyChunk(all.slice(i, i + SEARCH_CHUNK).map((row) => row.rowid)));
        }
      }
    } catch (error) { disableMessageSearchIndex(handle, error); verified.length = 0; partial = false; walkWindow(perThread); }
  } else walkWindow(perThread);
  if (enough()) partial = true;

  /** The candidates (index matches, newest-inserted first) verified in result order, (at DESC, rowid DESC), until one hit more than the page.
   * A handful is verified directly: the verify reads those rows anyway and the page is sorted afterwards. More than a verify chunk are put in
   * order by walking the at index newest first (a covering index, about 250 entries a page) and picking the candidates out as they pass, so a
   * common word costs the index pages down to its newest page of hits plus the rows verified, never a row read per candidate. The walk is
   * bounded (CANDIDATE_WALK_ROWS); candidates it has not reached by then are read for their timestamps as before (at most the cap), and they
   * all sort after everything the walk handed out, so the order is exact either way. */
  function verifyNewestCandidates(candidates: number[]): void {
    if (candidates.length <= SEARCH_CHUNK) { verified.push(...verifyChunk(candidates)); return; }
    const unseen = new Set(candidates);
    const walk = mergeNewestFirst([newestFirst(handle, "messages m INDEXED BY messages_at", "", [], WINDOW_CHUNK, before)]);
    const pending: number[] = [];
    // verify what the walk has picked out once it can fill the rest of the page, a chunk at a time
    const flush = (all: boolean) => {
      while (pending.length > 0 && !enough() && (all || pending.length >= Math.min(SEARCH_CHUNK, limit + 1 - verified.length))) {
        verified.push(...verifyChunk(pending.splice(0, SEARCH_CHUNK)));
      }
    };
    let walked = 0;
    while (unseen.size > 0 && !enough() && walked < CANDIDATE_WALK_ROWS) {
      const got = walk.take(WINDOW_CHUNK);
      walked += got.length;
      for (const row of got) if (unseen.delete(row.rowid)) pending.push(row.rowid);
      flush(false);
      // the index ran out: a candidate it never named has no message left (its row is gone), so nothing is left to read
      if (got.length < WINDOW_CHUNK) unseen.clear();
    }
    flush(true);
    if (enough() || unseen.size === 0) return;
    const rest = handle.prepare("SELECT c.value AS rowid, m.at AS at FROM json_each(?) c CROSS JOIN messages m ON m.rowid = c.value")
      .all(JSON.stringify([...unseen])) as Array<{ rowid: number; at: number }>;
    rest.sort((x, y) => y.at - x.at || y.rowid - x.rowid);
    for (let i = 0; i < rest.length && !enough(); i += SEARCH_CHUNK) verified.push(...verifyChunk(rest.slice(i, i + SEARCH_CHUNK).map((row) => row.rowid)));
  }

  /** Short queries, no usable index, or a few threads whose matches lie past the trigram cap: newest-first chunks
   * from a bounded window, never a scan of the whole table on the event loop. Stopping with one hit over the page is exact (the order is total).
   * Running out of rows first is a complete answer; reaching the window with rows left over is partial. A scope of a few threads walks each
   * thread's text and activity rows through the (kind, thread_id, at) index; any other search walks the whole table's newest rows through the at
   * index and the verify's probes check the scope (the window then counts rows looked at, in scope or not). */
  function walkWindow(threadsToWalk: string[] | null): void {
    const next = threadsToWalk
      ? mergeNewestFirst(threadsToWalk.flatMap((threadId) => (doorOnly ? ["text"] : ["text", "activity"]).map((kind) =>
          newestFirst(handle, "messages m", "m.kind = ? AND m.thread_id = ? AND ", [kind, threadId], WINDOW_CHUNK, before))))
      : mergeNewestFirst([newestFirst(handle, "messages m INDEXED BY messages_at", "", [], WINDOW_CHUNK, before)]);
    let looked = 0;
    for (;;) {
      const got = next.take(WINDOW_CHUNK);
      verified.push(...verifyChunk(got.map((row) => row.rowid)));
      looked += got.length;
      if (enough()) return;
      // A short chunk means every row the walk could reach has been looked at: the answer is complete, however small (a new install).
      if (got.length < WINDOW_CHUNK) return;
      if (looked >= SHORT_QUERY_WINDOW) { partial = next.more(); return; }
    }
  }
  const rows = page();
  const hits = rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
  return { hits, partial };
}

interface RowPosition { rowid: number; at: number }
const newerFirst = (x: RowPosition, y: RowPosition) => y.at - x.at || y.rowid - x.rowid;

/** One stream of message rows newest first, (at DESC, rowid DESC), read through an index in the index's own order, so no statement sorts.
 *
 * An index on `at` (or on `kind, thread_id, at`) holds equal timestamps in rowid order, ascending. `ORDER BY at DESC, rowid DESC` therefore made
 * SQLite sort each run of equal timestamps it met (USE TEMP B-TREE FOR LAST TERM OF ORDER BY): 100,000 rows with one timestamp were read and
 * sorted for a window of 500. Here every statement has one order key the index gives:
 *  - `at < ? ORDER BY at DESC LIMIT n` reads the next n rows of the index. Rows of the last timestamp in a full chunk may be cut off, so they are
 *    set aside; the earlier timestamps are whole and are sorted (at most n rows) in memory;
 *  - `at = ? AND rowid < ? ORDER BY rowid DESC LIMIT n` then walks that one timestamp's rows, n at a time, backwards through the same index.
 * Each statement reads at most n index entries, so a walk's cost follows the rows it hands out, whatever the timestamps. `from` names the table
 * (and any INDEXED BY); `prefix` is the equality prefix of the index ("m.kind = ? AND m.thread_id = ? AND ", or ""). */
function newestFirst(handle: DatabaseSync, from: string, prefix: string, prefixParams: readonly SQLInputValue[], size = WINDOW_CHUNK, below?: number): () => RowPosition[] {
  const older = handle.prepare(`SELECT m.rowid AS rowid, m.at AS at FROM ${from} WHERE ${prefix}m.at < ? ORDER BY m.at DESC LIMIT ?`);
  const tied = handle.prepare(`SELECT m.rowid AS rowid, m.at AS at FROM ${from} WHERE ${prefix}m.at = ? AND m.rowid < ? ORDER BY m.rowid DESC LIMIT ?`);
  let at = below ?? Number.MAX_SAFE_INTEGER, tieBelow: number | null = null, done = false;
  return () => {
    while (!done) {
      if (tieBelow !== null) {
        const got = tied.all(...prefixParams, at, tieBelow, size) as unknown as RowPosition[];
        // a short read ends this timestamp; the next statement reads below it
        tieBelow = got.length < size ? null : got[got.length - 1]!.rowid;
        if (got.length > 0) return got;
        continue;
      }
      const got = older.all(...prefixParams, at, size) as unknown as RowPosition[];
      if (got.length < size) { done = true; return got.sort(newerFirst); }
      const last = got[got.length - 1]!.at;
      const whole = got.filter((row) => row.at > last);
      at = last; tieBelow = Number.MAX_SAFE_INTEGER;
      if (whole.length > 0) return whole.sort(newerFirst);
    }
    return [];
  };
}

/** Several newest-first streams merged into one, read lazily: `take(n)` hands out the next n rows overall (fewer only when every stream has run
 * out), and `more()` says whether any row is left. */
function mergeNewestFirst(streams: Array<() => RowPosition[]>): { take: (n: number) => RowPosition[]; more: () => boolean } {
  const held: RowPosition[][] = streams.map(() => []);
  const at: number[] = streams.map(() => 0);
  const over: boolean[] = streams.map(() => false);
  const head = (i: number): RowPosition | undefined => {
    if (at[i]! >= held[i]!.length && !over[i]) {
      held[i] = streams[i]!(); at[i] = 0;
      if (held[i]!.length === 0) over[i] = true;
    }
    return held[i]![at[i]!];
  };
  return {
    take(n) {
      const out: RowPosition[] = [];
      while (out.length < n) {
        let best = -1;
        for (let i = 0; i < streams.length; i++) {
          const row = head(i);
          if (row && (best < 0 || newerFirst(row, held[best]![at[best]!]!) < 0)) best = i;
        }
        if (best < 0) break;
        out.push(held[best]![at[best]!]!);
        at[best]!++;
      }
      return out;
    },
    more: () => streams.some((_, i) => head(i) !== undefined),
  };
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  closeDatabase();
}

/** Every thread whose messages mention this stored attachment name (a bare
 * generated filename such as `<uuid>.png`). A bare name carries no LIKE
 * wildcards, and anything else matches nothing. Used to decide whether a
 * paired phone may be shown an image (attachment-access.ts). */
export function threadsReferencingAttachment(name: string): string[] {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) return [];
  // LIKE narrows the rows; the shared reference definition decides (a name that only
  // appears inside a longer filename-shaped token is not a reference, for adoption or here).
  const rows = db().prepare("SELECT thread_id, seq, json FROM messages WHERE json LIKE ?").iterate(`%${name}%`) as Iterable<{ thread_id: string; json: string }>;
  const threads = new Set<string>();
  for (const row of rows) if (!threads.has(row.thread_id) && messageJsonReferences(row.json, name)) threads.add(row.thread_id);
  return [...threads];
}

/** The stored message with this id, if one exists (a redelivered provider event finds the copy it already wrote). */
export function storedMessage(threadId: string, id: string): Message | null {
  const row = db().prepare("SELECT seq, json FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { seq: number | null; json?: string } | undefined;
  if (!row?.json) return null;
  try { return rowToMessage({ seq: row.seq, json: row.json }); } catch { return null; }
}
