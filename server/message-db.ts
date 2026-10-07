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
import { bumpForMessage, bumpMessagesVersion } from "./inbox-version.ts";
import { chmodSync, readFileSync, renameSync } from "node:fs";
import type { StatementSync } from "node:sqlite";

import { database as db, closeDatabase, transaction } from "./database.ts";
import type { Message } from "./store.ts";
import { attachmentReferencesIn, messageJsonReferences } from "./attachment-access.ts";
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
import { captureMessage, captureBranchChange, captureThreadDeletion } from "./memory/capture.ts";

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
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

// Reads are served by the messages_thread index, whose entries are ordered by
// rowid within a thread: the same order readThread() returns. Only the rows
// named by LIMIT are materialized; no schema or index change is needed.
const rowsDescending = (threadId: string, limit: number, beforeRowid?: number) =>
  (beforeRowid === undefined
    ? db().prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?").all(threadId, limit)
    : db().prepare("SELECT json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(threadId, beforeRowid, limit)
  ) as Array<{ json: string }>;

function messageRowid(threadId: string, messageId: string): number | null {
  const row = db().prepare("SELECT rowid AS position FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as
    | { position: number }
    | undefined;
  return row ? row.position : null;
}

/** `limit` rows ending just before `rowid` (or at the newest row). */
function sliceEndingBefore(threadId: string, limit: number, beforeRowid?: number): ThreadSlice & { empty: boolean } {
  const rows = rowsDescending(threadId, limit + 1, beforeRowid);
  const hasMore = rows.length > limit;
  const kept = rows.slice(0, limit).reverse().map(rowToMessage);
  return { messages: kept, previous: hasMore && kept.length ? rowToMessage(rows[limit]) : null, hasMore, empty: rows.length === 0 };
}

/** How many rows a thread holds, read through the thread index. */
export function threadRowCount(threadId: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function threadHasRows(threadId: string): boolean {
  return db().prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId) !== undefined;
}

/** When the newest row was written, or null for a thread with no rows. Read
 * through the thread index by rowid, so it never scans the transcript. */
export function newestMessageAt(threadId: string): number | null {
  const newest = db().prepare("SELECT at FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId) as
    | { at: number }
    | undefined;
  return typeof newest?.at === "number" ? newest.at : null;
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
  const { empty, ...slice } = sliceEndingBefore(threadId, limit);
  return empty ? null : slice;
}

/** `limit` rows before `messageId` in this thread. Null when that id is not a
 * row of this thread (including a thread with no rows). */
export function readThreadBefore(threadId: string, messageId: string, limit: number): ThreadSlice | null {
  const anchor = messageRowid(threadId, messageId);
  if (anchor === null) return null;
  const { empty: _empty, ...slice } = sliceEndingBefore(threadId, limit, anchor);
  return slice;
}

/** How many of the newest rows a newest-page must span to include every open
 * request card and the stored branch head (`leafId`), or 0 when neither is
 * older than the newest row. An open card is one the person still has to
 * answer: `Store.isOpenRequestCard`, spelled in SQL, and answered is any
 * truthy value exactly as `!card.answered` reads it. Upstream #1527 pages the
 * desktop; a card older than the page would otherwise vanish from the
 * composer that takes it over. */
export function newestPageSpan(threadId: string, leafId: string | null): number {
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS span FROM messages WHERE thread_id = ? AND rowid >= (" +
        "SELECT MIN(rowid) FROM messages WHERE thread_id = ? AND (id = ? OR (kind = 'options' " +
        "AND json_type(json, '$.card.requestId') = 'text' AND json_extract(json, '$.card.requestId') <> '' " +
        "AND COALESCE(json_extract(json, '$.card.answered'), '') IN ('', 0) " +
        "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) IN ('', 0))))",
    )
    .get(threadId, threadId, leafId ?? "") as { span: number } | undefined;
  return row?.span ?? 0;
}

/** A `limit`-row window containing `messageId`, positioned exactly as the
 * whole-array formula (anchor slightly after centre, clamped to either end).
 * Reads at most limit+1 older and limit newer rows. Null for a foreign or
 * unknown id. */
export function readThreadAround(threadId: string, messageId: string, limit: number): ThreadSlice | null {
  const anchor = messageRowid(threadId, messageId);
  if (anchor === null) return null;
  // The whole-array start is index+1 for a zero limit: never the first row.
  if (limit === 0) return { messages: [], previous: null, hasMore: true };
  const older = rowsDescending(threadId, limit + 1, anchor);
  const newer = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?")
    .all(threadId, anchor, limit) as Array<{ json: string }>;
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
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      replaceRow(insert, threadId, message);
    }
    writeActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
    bumpMessagesVersion();
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
 * replace deletes the old row (new rowid), so the old rowid's entry goes too. */
function replaceRow(insert: StatementSync, threadId: string, message: Message): void {
  const prior = db().prepare("SELECT rowid AS position FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id) as
    | { position: number }
    | undefined;
  const result = insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  if (prior) syncMessageSearchRow(db(), prior.position, null);
  const text = searchableText(message);
  if (text !== null) syncMessageSearchRow(db(), Number(result.lastInsertRowid), text);
}

function writeMessage(threadId: string, message: Message): void {
  replaceRow(
    db().prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    threadId,
    message,
  );
  captureMessage(db(), threadId, message);
  bumpForMessage(message);
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

export function insertMessage(threadId: string, message: Message): void {
  transaction(() => writeMessage(threadId, message));
  observeCommitted(threadId, message);
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  transaction(() => {
    const previous = db().prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(threadId)?.active_leaf_id;
    writeMessage(threadId, message);
    writeActiveLeaf(threadId, message.id);
    if ((message.parentId ?? null) !== (previous ?? null)) captureBranchChange(db(), threadId, message.id);
  });
  observeCommitted(threadId, message);
}

export function updateMessage(threadId: string, message: Message): void {
  transaction(database => {
    const prior = database.prepare(
      "SELECT rowid AS position, kind, text, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') END AS tool_name FROM messages WHERE thread_id=? AND id=?",
    ).get(threadId, message.id) as { position: number; kind: string; text: string | null; tool_name: string | null } | undefined;
    database.prepare("UPDATE messages SET at=?, role=?, kind=?, text=?, json=? WHERE thread_id=? AND id=?")
      .run(message.at,message.role,message.kind,message.text??null,JSON.stringify(message),threadId,message.id);
    // Streaming patches rewrite a message many times with the same text: only
    // re-index when what the index holds for this row would change.
    if (prior) {
      const before = searchableText({ kind: prior.kind, text: prior.text, tool: { name: prior.tool_name } });
      const after = searchableText(message);
      if (before !== after) syncMessageSearchRow(database, prior.position, after);
    }
    captureMessage(database,threadId,message);
    bumpForMessage(message);
  });
  observeCommitted(threadId, message);
}

/** Goal cards are new SQLite-backed messages, so crash recovery can locate
 * the tiny set of unfinished receipts without eagerly loading every room
 * transcript into memory at startup. */
export function workingGoalRunMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      "WHERE kind = 'goal.run' AND json_extract(json, '$.goalRun.status') = 'working'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
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
      "SELECT s.thread_id AS thread_id, m.json AS json FROM thread_state s " +
        "JOIN messages m ON m.thread_id = s.thread_id AND m.id = s.active_leaf_id " +
        "WHERE m.role = 'user' AND m.kind = 'text'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

/** Provider question cards still waiting on an answer (0.1.52 ASK2). An
 * engine's wait lives only in memory, so after a restart every one of these
 * is unanswerable where it stands; the boot sweep marks them Expired so a
 * late answer can still go out as a message. A question card is a request
 * card without a permission tool and without a harness-owned proposal. */
export function openQuestionCardMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages WHERE kind = 'options' " +
        "AND json_type(json, '$.card.requestId') = 'text' " +
        "AND json_type(json, '$.card.tool') IS NULL " +
        "AND json_type(json, '$.card.answered') IS NULL " +
        "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 " +
        "AND json_type(json, '$.card.routineRequest') IS NULL " +
        "AND json_type(json, '$.card.skillRequest') IS NULL " +
        "AND json_type(json, '$.card.intake') IS NULL",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

/** Permission cards (a card carrying a tool) still waiting on an answer. The
 * request behind every one lives only in memory (the engine's ask, the image
 * or computer-consent broker), so after a restart none of them can be
 * answered where it stands, and each would sit in the Inbox under "Waiting 1
 * hour" with Allow once and Deny that can do nothing (D7). Harness-owned
 * proposals are durable and are left alone. */
export function openApprovalCardMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages WHERE kind = 'options' " +
        "AND json_type(json, '$.card.requestId') = 'text' " +
        "AND json_type(json, '$.card.tool') = 'text' " +
        "AND json_type(json, '$.card.answered') IS NULL " +
        "AND COALESCE(json_extract(json, '$.card.dismissed'), 0) = 0 " +
        "AND COALESCE(json_extract(json, '$.card.orphaned'), 0) = 0 " +
        "AND json_type(json, '$.card.routineRequest') IS NULL " +
        "AND json_type(json, '$.card.skillRequest') IS NULL " +
        "AND json_type(json, '$.card.intake') IS NULL",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

function writeActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  transaction(database => { writeActiveLeaf(threadId,leafId); captureBranchChange(database,threadId,leafId); });
}

export function deleteThread(threadId: string): void {
  transaction(database => {
    captureThreadDeletion(database,threadId);
    const indexed = dropThreadSearchRows(database, threadId); // before the rows it is keyed by go
    database.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM thread_state WHERE thread_id=?").run(threadId);
    if (indexed) mergeMessageSearchIndex(database);
    bumpMessagesVersion();
  });
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
/** Newest rows read first by searchMessages(), before any index. */
const RECENT_WINDOW = 400;

interface SearchRow {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  from_name: string | null;
}

export function searchMessages(
  query: string,
  limit = 40,
  threads?: string | readonly string[],
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const threadIds = typeof threads === "string" ? [threads] : threads;
  if (threadIds && threadIds.length === 0) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadIds ? "m.thread_id IN (SELECT value FROM json_each(?)) AND " : "";
  const verify =
    "((m.kind = 'text' AND m.text IS NOT NULL AND m.text LIKE ? ESCAPE '\\') " +
    "OR (m.kind = 'activity' AND json_extract(m.json, '$.tool.name') LIKE ? ESCAPE '\\'))";
  const handle = db();
  const scopeParams = threadIds ? [JSON.stringify([...threadIds])] : [];
  const detail =
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
    "WHERE rowid IN (%PAGE%) ORDER BY at DESC, rowid DESC";
  const fetch = (page: string, params: Array<string | number>) =>
    handle.prepare(detail.replace("%PAGE%", page)).all(...params) as unknown as SearchRow[];
  // CROSS JOIN pins the join order: candidates first, then one rowid probe each.
  // Left to itself the planner walks the kind index and reads every text row.
  const probe = "CROSS JOIN messages m ON m.rowid = c.rowid";
  const order = "ORDER BY m.at DESC, m.rowid DESC LIMIT ?";
  // 1. The newest rows first. When a common word fills a page from them, the
  //    page is the answer (the order is total, so nothing older can outrank
  //    it) and no index or scan is needed. messages_at serves the ordering.
  const recent = Math.max(RECENT_WINDOW, limit * 8);
  const window = fetch(
    `SELECT m.rowid FROM (SELECT m.rowid AS rowid FROM messages m ${scope ? "WHERE " + scope.slice(0, -5) : ""} ORDER BY m.at DESC, m.rowid DESC LIMIT ?) c ${probe} WHERE ${verify} ${order}`,
    [...scopeParams, recent, pattern, pattern, limit],
  );
  let rows: SearchRow[];
  if (window.length >= limit) rows = window;
  else if ([...needle].length >= MIN_INDEXED_QUERY_CODEPOINTS && messageSearchIndexReady(handle)) {
    // 2. Rare words: the trigram index names the candidates (code points, not UTF-16 units).
    try {
      rows = fetch(
        `SELECT m.rowid FROM (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) c ${probe} WHERE ${scope}${verify} ${order}`,
        [trigramQuery(needle), ...scopeParams, pattern, pattern, limit],
      );
    } catch (error) { disableMessageSearchIndex(handle, error); rows = scanAll(); }
  } else rows = scanAll();
  function scanAll(): SearchRow[] {
    // 3. Short queries, or no usable index: the scan this search always had.
    return fetch(`SELECT m.rowid FROM messages m WHERE ${scope}${verify} ${order}`, [...scopeParams, pattern, pattern, limit]);
  }
  return rows.map((row) => {
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
  const rows = db().prepare("SELECT thread_id, json FROM messages WHERE json LIKE ?").iterate(`%${name}%`) as Iterable<{ thread_id: string; json: string }>;
  const threads = new Set<string>();
  for (const row of rows) if (!threads.has(row.thread_id) && messageJsonReferences(row.json, name)) threads.add(row.thread_id);
  return [...threads];
}
