// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readIndexState, stepUpRow, writeIndexState } from "./transcript-backfill.ts";
import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";

export const THREAD_SUMMARY_SQL = `CREATE TABLE IF NOT EXISTS thread_summary(
  thread_id TEXT PRIMARY KEY, last_at INTEGER, last_role TEXT, last_from TEXT, snippet TEXT)`;
export const THREAD_SUMMARY_TABLE = "thread_summary";
export const CHATS_GEN_TABLE = "chats_gen";
export const CHATS_PREVIEW_TABLES = [THREAD_SUMMARY_TABLE, CHATS_GEN_TABLE] as const;
export const CHATS_PREVIEW_INDEXES: readonly string[] = [];
export interface ChatsGen { epoch: string; rev: number }
const CHATS_PREVIEW_SQL = `${THREAD_SUMMARY_SQL}; CREATE TABLE IF NOT EXISTS chats_gen(
  id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, rev INTEGER NOT NULL)`;
export function initializeChatsPreviewStorage(db: DatabaseSync): void { db.exec(CHATS_PREVIEW_SQL); }
let previewScope = 0;
/** The supplied handle owns every statement, including failure cleanup. */
export function withChatsPreviewTransaction<T>(db: DatabaseSync, operation: (db: DatabaseSync) => T): T {
  const nested = db.isTransaction;
  const scope = `chats_preview_${++previewScope}`;
  beginWrite(db, scope);
  const undo = (error: unknown): never => {
    try { undoWrite(db, scope); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Preview transaction and rollback failed", { cause: error }); }
    throw error;
  };
  let value: T;
  try {
    value = operation(db);
    if (value != null && typeof (value as { then?: unknown }).then === "function") throw new TypeError("Preview transactions must be synchronous");
  } catch (error) { undo(error); }
  try { endWrite(db, scope); }
  catch (error) {
    // endWrite owns top-level failure cleanup. Nested frames still belong to
    // this scope, so undo only the child and preserve the caller's transaction.
    if (nested) undo(error);
    throw error;
  }
  return value!;
}
export function readChatsGen(db: DatabaseSync): ChatsGen {
  const row = db.prepare("SELECT epoch,rev FROM chats_gen WHERE id=1").get();
  if (!row) throw new Error("Missing chat generation");
  return { epoch: String(row.epoch), rev: Number(row.rev) };
}
export function remintChatsGen(db: DatabaseSync): void {
  withChatsPreviewTransaction(db, handle => {
    initializeChatsPreviewStorage(handle);
    handle.prepare("INSERT OR IGNORE INTO chats_gen(id,epoch,rev) VALUES(1,'',0)").run();
    handle.prepare("UPDATE chats_gen SET epoch=?,rev=0 WHERE id=1").run(randomBytes(16).toString("hex"));
  });
  scheduleGenProbe(db);
}
export function bumpChatsGen(db: DatabaseSync): void {
  withChatsPreviewTransaction(db, handle => { handle.prepare("UPDATE chats_gen SET rev=rev+1 WHERE id=1").run(); });
  scheduleGenProbe(db);
}
export function downgradeChatsPreviewTables(db: DatabaseSync): void {
  withChatsPreviewTransaction(db, handle => {
    for (const name of CHATS_PREVIEW_TABLES) handle.exec(`DROP TABLE IF EXISTS ${name}`);
    if (handle.prepare("SELECT 1 FROM sqlite_schema WHERE name='transcript_index_state'").get())
      handle.prepare("DELETE FROM transcript_index_state WHERE name=?").run(FILL);
  });
}
interface Publisher {
  active: boolean;
  lastPublished: ChatsGen;
  probeImmediate: ReturnType<typeof setImmediate> | null;
  frameTimer: ReturnType<typeof setTimeout> | null;
  send: ((gen: ChatsGen) => void) | null;
}
const publishers = new WeakMap<DatabaseSync, Publisher>();
const sameGen = (a: ChatsGen, b: ChatsGen) => a.epoch === b.epoch && a.rev === b.rev;
export function registerChatsGenPublisher(db: DatabaseSync, send: (gen: ChatsGen) => void): () => void {
  if (publishers.has(db)) throw new Error("Chat generation publisher already registered");
  const state: Publisher = { active: true, lastPublished: readChatsGen(db), probeImmediate: null, frameTimer: null, send };
  publishers.set(db, state);
  return () => {
    if (!state.active) return;
    state.active = false;
    if (publishers.get(db) === state) publishers.delete(db);
    if (state.probeImmediate) clearImmediate(state.probeImmediate);
    if (state.frameTimer) clearTimeout(state.frameTimer);
    state.probeImmediate = null; state.frameTimer = null; state.send = null;
  };
}
function retryFrame(db: DatabaseSync, state: Publisher): void {
  if (!state.active || state.frameTimer) return;
  state.frameTimer = setTimeout(() => {
    state.frameTimer = null;
    if (!state.active) return;
    try {
      if (db.isTransaction) { scheduleGenProbe(db); return; }
      publishChatsGenImmediately(db, readChatsGen(db));
    } catch (error) { console.error("Chat generation publication failed", error); retryFrame(db, state); }
  }, 250);
}
export function scheduleGenProbe(db: DatabaseSync): void {
  const state = publishers.get(db);
  if (!state?.active || state.probeImmediate) return;
  state.probeImmediate = setImmediate(() => {
    state.probeImmediate = null;
    if (!state.active) return;
    try { publishChatsGenIfMoved(db); }
    catch (error) { console.error("Chat generation probe failed", error); retryFrame(db, state); }
  });
}
export function publishChatsGenIfMoved(db: DatabaseSync, now?: ChatsGen): void {
  const state = publishers.get(db);
  if (!state?.active) return;
  if (db.isTransaction) { scheduleGenProbe(db); return; }
  if (!sameGen(now ?? readChatsGen(db), state.lastPublished)) retryFrame(db, state);
}
/** Keepalive reads only while this exact serving handle still owns publication. */
export function publishChatsGenHeartbeat(db: DatabaseSync): void {
  const state = publishers.get(db);
  if (!state?.active) return;
  if (db.isTransaction) { scheduleGenProbe(db); return; }
  try { publishChatsGenImmediately(db, readChatsGen(db)); }
  catch (error) { console.error("Chat generation heartbeat failed", error); retryFrame(db, state); }
}
export function publishChatsGenImmediately(db: DatabaseSync, gen: ChatsGen): void {
  const state = publishers.get(db);
  if (!state?.active) return;
  if (db.isTransaction) { scheduleGenProbe(db); return; }
  if (sameGen(gen, state.lastPublished)) return;
  if (state.frameTimer) clearTimeout(state.frameTimer);
  state.frameTimer = null;
  try { state.send!(gen); state.lastPublished = gen; }
  catch (error) { console.error("Chat generation publication failed", error); retryFrame(db, state); }
}

const FILL = "thread_summary";
export const SUMMARY_WALK_ROWS = 50;
export interface ThreadSummary { last_at: number | null; last_role: string | null; last_from: string | null; snippet: string }

/** Called only inside the message/branch/forget transaction. Never reads more
 * than 50 ancestors, including cards and forgotten lines. No branch fill. */
export function syncThreadSummary(db: DatabaseSync, threadId: string): void {
  const state = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId);
  let id = (state?.active_leaf_id || db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId)?.id) as string | undefined;
  if (!id) { db.prepare("DELETE FROM thread_summary WHERE thread_id = ?").run(threadId); return; }
  const summary: ThreadSummary = { last_at: null, last_role: null, last_from: null, snippet: "" };
  const seen = new Set<string>();
  // Old standalone transcript files need no memory tables to build a summary.
  const memory = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_sources'").get() !== undefined;
  while (id && seen.size < SUMMARY_WALK_ROWS && !seen.has(id)) {
    seen.add(id);
    const step = stepUpRow(db, threadId, id);
    if (!step || "damaged" in step) break;
    const m = step.message;
    const source = `message:${threadId}:${id}`;
    // any source tombstone, whatever its reason, keeps the line out (at worst an older line is the preview)
    const forgotten = m.withheldFromBots === "forgotten" || (memory && Boolean(db.prepare(
      "SELECT 1 WHERE EXISTS (SELECT 1 FROM memory_sources WHERE id = ? AND state = 'deleted') OR EXISTS " +
      "(SELECT 1 FROM memory_tombstones WHERE target_type = 'source' AND target_id = ?)",
    ).get(source, source)));
    if (!forgotten && m.kind === "text" && typeof m.text === "string" && m.text.trim()) {
      summary.last_at = typeof m.at === "number" ? m.at : null;
      summary.last_role = typeof m.role === "string" ? m.role : null;
      const from = m.from as { name?: unknown } | undefined;
      summary.last_from = typeof from?.name === "string" ? from.name : null;
      summary.snippet = [...m.text.replace(/\s+/g, " ").trim()].slice(0, 160).join("");
      break;
    }
    id = step.parent ?? undefined;
  }
  db.prepare("INSERT INTO thread_summary(thread_id,last_at,last_role,last_from,snippet) VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET last_at=excluded.last_at,last_role=excluded.last_role,last_from=excluded.last_from,snippet=excluded.snippet")
    .run(threadId, summary.last_at, summary.last_role, summary.last_from, summary.snippet);
}

/** Owner-route only. One primary-key probe; no transcript reads. */
export function readThreadSummary(db: DatabaseSync, threadId: string): ThreadSummary | undefined {
  return db.prepare("SELECT last_at,last_role,last_from,snippet FROM thread_summary WHERE thread_id=?").get(threadId) as unknown as ThreadSummary | undefined;
}
export function threadSummaryPending(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE name='thread_summary'").get() !== undefined && readIndexState(db, FILL).done !== 1;
}

export function prepareThreadSummaryBackfill(db: DatabaseSync): void {
  withChatsPreviewTransaction(db, handle => {
    initializeChatsPreviewStorage(handle);
    if (!handle.prepare("SELECT 1 FROM chats_gen WHERE id=1").get()) remintChatsGen(handle);
  });
  if (!db.prepare("SELECT 1 FROM messages LIMIT 1").get()) writeIndexState(db, FILL, { done: 1, cursor: 0, skipped: 0 });
}

/** Saved rowid cursor, independent of live summary writes. Each step reads at
 * most `rows` messages and walks at most 50 ancestors per distinct thread.
 * The time bound is checked after every thread; caller yields between steps. */
export function stepThreadSummaryBackfill(db: DatabaseSync, rows = 100, now: () => number = () => performance.now()): { more: boolean; done: number; total: number } {
  const state = readIndexState(db, FILL);
  const total = Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM messages").get()!.n);
  if (state.done) return { more: false, done: state.cursor, total };
  const started = now();
  let cursor = state.cursor;
  const seen = new Set<string>();
  return withChatsPreviewTransaction(db, () => {
    const batch = db.prepare("SELECT rowid AS r,thread_id FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?").all(cursor, Math.max(1, Math.min(100, rows))) as Array<{ r: number; thread_id: string }>;
    for (const row of batch) {
      if (!seen.has(row.thread_id)) { syncThreadSummary(db, row.thread_id); seen.add(row.thread_id); }
      cursor = row.r;
      if (now() - started >= 20) break;
    }
    if (!batch.length) cursor = total;
    const more = cursor < total;
    writeIndexState(db, FILL, { done: more ? 0 : 1, cursor, skipped: 0 });
    return { more, done: cursor, total };
  });
}

/** Restore discards cached text before serving and resumes the ordinary fill. */
export function resetThreadSummaries(db: DatabaseSync): void {
  db.exec(THREAD_SUMMARY_SQL);
  db.exec("DELETE FROM thread_summary");
  // Archives predating the resumable indexes have no state table yet.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='transcript_index_state'").get())
    writeIndexState(db, FILL, { done: 0, cursor: 0, skipped: 0 });
}

/** Explicit repair, like rebuildMessageSearchIndex; normal startup is stepped. */
export function rebuildThreadSummaries(db: DatabaseSync): void {
  withChatsPreviewTransaction(db, () => {
    resetThreadSummaries(db);
    while (stepThreadSummaryBackfill(db).more) { /* offline repair */ }
    bumpChatsGen(db);
  });
}
