// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-thread storage sequence (ROOM-ORDER-DESIGN r6 Q1, r7 R1-R3, r8 R8): `messages.seq`, 1..n per thread, allocated
// in the row's own write transaction once the thread is numbered, and given to the rows written before it by the bounded
// walk (transcript-backfill.ts numberSeqChunk). This module owns the column's index, the readiness probe, the one decoder
// of a stored row (rowToMessage) and the walk's listeners and figures. It imports nothing that opens the database.
import type { DatabaseSync } from "node:sqlite";

import { registerOptionalIndex } from "./memory/optional-index.ts";
import type { Message } from "./store.ts";

/** The index both probes and every numbered page read go through. */
export const SEQ_INDEX = "messages_thread_seq";
export const SEQ_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${SEQ_INDEX} ON messages(thread_id, seq)`;
/** On a file that already holds messages the index is an optional index (memory/optional-index.ts): built in an idle window, off the
 * serving thread, under the writer hold. Until it exists nothing is numbered and every thread is served legacy. */
export const SEQ_OPTIONAL_INDEX = registerOptionalIndex({ name: SEQ_INDEX, table: "messages", minSchemaVersion: 0, sql: SEQ_INDEX_SQL, logTag: "transcript-seq" });
/** The walk's row in transcript_index_state. */
export const SEQ_STATE = "seq";

/** The one decoder of a stored row: the JSON, with `seq` from the column (never from the JSON, which never holds it). */
export function rowToMessage(row: { seq?: number | bigint | null; json: string }): Message {
  const message = JSON.parse(row.json) as Message;
  if (row.seq === null || row.seq === undefined) delete message.seq;
  else message.seq = Number(row.seq);
  return message;
}

/** The JSON a row stores: the message without its `seq` (the column holds it). */
export function storedJson(message: Message): string {
  if (message.seq === undefined) return JSON.stringify(message);
  const { seq: _seq, ...rest } = message;
  return JSON.stringify(rest);
}

const indexSeen = new WeakMap<DatabaseSync, true>();
const walkDone = new WeakMap<DatabaseSync, true>();

/** The index exists (an index that exists is complete). Remembered once seen: nothing in a running process drops it. */
export function seqIndexReady(db: DatabaseSync): boolean {
  if (indexSeen.has(db)) return true;
  let ready = false;
  try { ready = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'index' AND name = ?").get(SEQ_INDEX) !== undefined; } catch { ready = false; }
  if (ready) indexSeen.set(db, true);
  return ready;
}

/** The walk has numbered every row (and so every later write allocates). Remembered once seen. */
export function seqWalkDone(db: DatabaseSync): boolean {
  if (walkDone.has(db)) return true;
  let done = false;
  try { done = Number((db.prepare("SELECT done FROM transcript_index_state WHERE name = ?").get(SEQ_STATE) as { done: number } | undefined)?.done ?? 0) === 1; } catch { done = false; }
  if (done) walkDone.set(db, true);
  return done;
}
export function noteSeqWalkDone(db: DatabaseSync): void { walkDone.set(db, true); }

/** `numbered(thread)`: no row of the thread has `seq IS NULL` (a thread with no rows is numbered). One probe on the index, where
 * NULL sorts first. Derived, never stored: it flips exactly when the chunk that numbers the thread's last NULL row commits. */
export function threadNumbered(db: DatabaseSync, threadId: string): boolean {
  if (!seqIndexReady(db)) return false;
  // always the probe, even once the walk is done: a row some other writer stored without a number (a tool, an older build on the same
  // file) keeps its thread legacy instead of being paged by a number it does not have
  return db.prepare(`SELECT 1 AS present FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? AND seq IS NULL LIMIT 1`).get(threadId) === undefined;
}

/** The number the next row of a numbered thread takes: one probe on the index. */
export function nextSeq(db: DatabaseSync, threadId: string): number {
  return Number((db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ?`).get(threadId) as { n: number }).n);
}

/** The thread's highest number (0 for an empty thread); undefined while the thread is not numbered. */
export function newestSeqOf(db: DatabaseSync, threadId: string): number | undefined {
  if (!threadNumbered(db, threadId)) return undefined;
  return Number((db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ?`).get(threadId) as { n: number }).n);
}

/** One row's number, or null (no such row, or not numbered yet). */
export function seqOfRow(db: DatabaseSync, threadId: string, messageId: string): number | null {
  const row = db.prepare("SELECT seq FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as { seq: number | null } | undefined;
  return row?.seq === null || row?.seq === undefined ? null : Number(row.seq);
}

// ---- the walk's listeners and figures ------------------------------------------------------------------------------

/** Told after each committed chunk, per thread the chunk numbered rows of: the (id, seq) pairs, and `flipped()`, whether the thread is now
 * numbered. `flipped` is one index probe, run only when a listener asks (the store asks for the threads it holds in memory), at most once
 * per thread per chunk: a chunk over an interleaved history touches hundreds of threads, and a probe for each held the slice past its bound. */
export type SeqNumberedListener = (threadId: string, stamps: ReadonlyArray<readonly [string, number]>, flipped: () => boolean) => void;
const numberedListeners = new Set<SeqNumberedListener>();
export function onSeqNumbered(listener: SeqNumberedListener): () => void { numberedListeners.add(listener); return () => { numberedListeners.delete(listener); }; }
export function notifySeqNumbered(threadId: string, stamps: ReadonlyArray<readonly [string, number]>, flipped: () => boolean): void {
  if (!numberedListeners.size) return;
  let known: boolean | undefined;
  const once = () => (known ??= flipped());
  for (const listener of [...numberedListeners]) { try { listener(threadId, stamps, once); } catch { /* a listener never stops the walk */ } }
}

/** `threadNumbered` for many threads of one chunk: the probe prepared once. Only for a handle whose index exists. */
export function threadNumberedProbe(db: DatabaseSync): (threadId: string) => boolean {
  const probe = db.prepare(`SELECT 1 AS present FROM messages INDEXED BY ${SEQ_INDEX} WHERE thread_id = ? AND seq IS NULL LIMIT 1`);
  return (threadId) => probe.get(threadId) === undefined;
}

/** One chunk's figures: `ms` is the chunk's wall time from its first read to its commit (the slice the event loop was held). */
export interface SeqChunkFigures {
  ms: number; scanned: number; numbered: number; cursor: number; newest: number; done: boolean; cut: boolean;
  /** The parts of `ms`: the row loop (reads, updates, the cursor), the COMMIT, and what follows it (loaded-thread stamps, flip checks). */
  loopMs?: number; commitMs?: number; checksMs?: number;
  /** Threads the chunk numbered a row of. */
  threads?: number;
}
type SeqChunkListener = (figures: SeqChunkFigures) => void;
const chunkListeners = new Set<SeqChunkListener>();
/** A rig's hook on every chunk (the slice p50/p99): cheap when nobody listens. */
export function onSeqChunk(listener: SeqChunkListener): () => void { chunkListeners.add(listener); return () => { chunkListeners.delete(listener); }; }
/** `MURAGE_SEQ_TRACE=1` logs every chunk as `[transcript-seq] chunk ms=… scanned=… numbered=… cursor=… newest=…`. */
const TRACE = process.env.MURAGE_SEQ_TRACE === "1";
export function noteSeqChunk(figures: SeqChunkFigures): void {
  if (TRACE) console.log(`[transcript-seq] chunk ms=${figures.ms.toFixed(2)} scanned=${figures.scanned} numbered=${figures.numbered} cursor=${figures.cursor} newest=${figures.newest}${figures.cut ? " cut=1" : ""}`);
  if (figures.done) console.log(`[transcript-seq] walk done cursor=${figures.cursor}`);
  for (const listener of [...chunkListeners]) { try { listener(figures); } catch { /* a listener never stops the walk */ } }
}

/** The walk's progress for /api/health (beside memoryIntegrity), in the upgrade phase shape. `done/total` are storage positions
 * (the cursor and the newest rowid): never a COUNT(*) over messages. */
export function seqProgress(db: DatabaseSync): { phaseId: "transcript-seq"; labelKey: string; done: number; total: number; stillWorking: boolean; indexReady: boolean } {
  const indexReady = seqIndexReady(db);
  if (seqWalkDone(db)) return { phaseId: "transcript-seq", labelKey: "health.transcriptSeq", done: 1, total: 1, stillWorking: false, indexReady };
  let cursor = 0, newest = 0;
  try {
    cursor = Number((db.prepare("SELECT cursor FROM transcript_index_state WHERE name = ?").get(SEQ_STATE) as { cursor: number } | undefined)?.cursor ?? 0);
    newest = Number((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM messages").get() as { n: number }).n);
  } catch { /* unknown: reported as not started */ }
  return { phaseId: "transcript-seq", labelKey: "health.transcriptSeq", done: Math.min(cursor, newest), total: newest, stillWorking: true, indexReady };
}

// ---- the step back to 1.0.2 -------------------------------------------------------------------------------------------

/** "Prepare to reinstall" steps a 1.0.3 file back to 1.0.2's shape (installation-memory-downgrade.ts). 1.0.2's backup inspector refuses a
 * column or an index it does not know (DATABASE_SCHEMA_UNSUPPORTED), so the sequence leaves: its index, then the column (SQLite rewrites the
 * table without it; every row and its JSON are kept, the JSON never held `seq`), then the walk's place, in one BEGIN IMMEDIATE. Idempotent:
 * a file without them is left untouched. A later upgrade adds the column again (NULL), finds no index and walks from the start. */
/** The objects downgradeTranscriptSeqTo102 removes (the column goes with them): not 1.0.2 objects, so not in APP_SCHEMA_102_ADDITIONS. */
export const SEQ_103_OBJECTS: readonly string[] = Object.freeze([SEQ_INDEX]);
export function downgradeTranscriptSeqTo102(db: DatabaseSync): { dropped: boolean } {
  const has = (type: string, name: string) => db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) !== undefined;
  if (!has("table", "messages")) return { dropped: false };
  const column = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).some((c) => c.name === "seq");
  const index = has("index", SEQ_INDEX);
  const state = has("table", "transcript_index_state") && db.prepare("SELECT 1 AS present FROM transcript_index_state WHERE name = ?").get(SEQ_STATE) !== undefined;
  if (!column && !index && !state) return { dropped: false };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (index) db.exec(`DROP INDEX ${SEQ_INDEX}`);
    if (column) db.exec("ALTER TABLE messages DROP COLUMN seq");
    if (state) db.prepare("DELETE FROM transcript_index_state WHERE name = ?").run(SEQ_STATE);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  indexSeen.delete(db); walkDone.delete(db);
  return { dropped: true };
}
