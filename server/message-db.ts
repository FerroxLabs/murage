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
import { chmodSync, readFileSync, renameSync } from "node:fs";

import { database as db, closeDatabase, transaction } from "./database.ts";
import type { Message } from "./store.ts";
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
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    writeActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
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

function writeMessage(threadId: string, message: Message): void {
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  captureMessage(db(), threadId, message);
}

export function insertMessage(threadId: string, message: Message): void {
  transaction(() => writeMessage(threadId, message));
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  transaction(() => {
    const previous = db().prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(threadId)?.active_leaf_id;
    writeMessage(threadId, message);
    writeActiveLeaf(threadId, message.id);
    if ((message.parentId ?? null) !== (previous ?? null)) captureBranchChange(db(), threadId, message.id);
  });
}

export function updateMessage(threadId: string, message: Message): void {
  transaction(database => {
    database.prepare("UPDATE messages SET at=?, role=?, kind=?, text=?, json=? WHERE thread_id=? AND id=?")
      .run(message.at,message.role,message.kind,message.text??null,JSON.stringify(message),threadId,message.id);
    captureMessage(database,threadId,message);
  });
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
    database.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
    database.prepare("DELETE FROM thread_state WHERE thread_id=?").run(threadId);
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
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist.
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
  const scope = threadIds ? "thread_id IN (SELECT value FROM json_each(?)) AND " : "";
  const statement = db().prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = (threadIds
    ? statement.all(JSON.stringify([...threadIds]), pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
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
