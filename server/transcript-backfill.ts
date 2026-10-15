// Bounded, resumable upkeep of the derived transcript tables (message-tables.ts):
// open_card and keyed_card (global passes, complete before first read), and the
// per-thread tables (branch index, line index, turn_first, message_image), which
// are filled thread by thread in slices (branch-fill.ts): a thread is read only
// once its own fill has reached its last row, and the pass here just prepares
// every thread in the background. Each chunk is its own transaction that records
// where it got to, so a failure or a restart carries on from the last chunk
// instead of starting over or being mistaken for done. Nothing here walks a whole
// thread in one go; the event loop is free between chunks.
import { scopedTx } from "./tx-scope.ts";
import type { DatabaseSync } from "node:sqlite";
import { ioBudget } from "./io-budget.ts";
import { ownerFirst, type Admission } from "./owner-first.ts";
import { dequeueFrontFill, fillOneSlice, nextQueuedFill, nextUnpreparedThread, noteSlice, recentUnpreparedThreads } from "./branch-fill.ts";

/** An open request card: an unanswered, undismissed options row that carries a
 * request id (Store.isOpenRequestCard), and not one the start already retired (`orphaned`: an approval left by an earlier run, which no longer counts
 * as waiting). Retired cards stay in their conversations but not in this list, so the list, and everything that reads it before the server
 * listens, follows the cards that are really open and not the approvals of the past. */
export function isOpenCardJson(message: { kind?: unknown; card?: { requestId?: unknown; answered?: unknown; dismissed?: unknown; orphaned?: unknown } | null }): boolean {
  const card = message.card;
  return message.kind === "options" && typeof card?.requestId === "string" && card.requestId !== "" && !card.answered && !card.dismissed && !card.orphaned;
}

export { keyedCardsOf, mayBeKeyed, type KeyedFamily } from "./keyed-cards.ts";
import { keyedCardsOf } from "./keyed-cards.ts";

/** How many rows one backfill chunk reads. */
export const BACKFILL_CHUNK_ROWS = 1_000;

interface StateRow { done: number; cursor: number; skipped: number }

export function readIndexState(db: DatabaseSync, name: string): StateRow {
  return (db.prepare("SELECT done, cursor, skipped FROM transcript_index_state WHERE name = ?").get(name) as StateRow | undefined) ?? { done: 0, cursor: 0, skipped: 0 };
}
export function writeIndexState(db: DatabaseSync, name: string, state: StateRow): void {
  db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, ?, ?, ?)").run(name, state.done, state.cursor, state.skipped);
}

/** Run one unit of work in a transaction; a throw rolls it back and propagates. */
function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  return scopedTx(() => {
    db.exec("BEGIN IMMEDIATE");
    try { const out = run(); db.exec("COMMIT"); return out; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  });
}

/** One chunk of the open-card index: the next stretch of `rows` storage positions.
 * The stretch is bounded by the rows it SCANS (a rowid range), never by how many
 * options rows it finds: `messages` has no index on `kind`, so a limit on matches
 * would let a history with few cards read the whole table in one statement.
 * Returns whether more remain. Malformed JSON rows are skipped and counted in
 * `skipped`; any database write failure throws with the chunk rolled back. */
export function indexOpenCardsChunk(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): boolean {
  const state = readIndexState(db, "open_card");
  if (state.done) return false;
  const newest = newestRowid(db);
  const upper = Math.min(newest, state.cursor + rows);
  const batch = db.prepare("SELECT rowid AS position, thread_id, id, json FROM messages WHERE rowid > ? AND rowid <= ? AND kind = 'options' ORDER BY rowid").all(state.cursor, upper) as Array<{ position: number; thread_id: string; id: string; json: string }>;
  const add = db.prepare("INSERT OR IGNORE INTO open_card(thread_id, id) VALUES (?, ?)");
  return inTransaction(db, () => {
    let skipped = state.skipped;
    for (const row of batch) {
      let open = false;
      try { open = isOpenCardJson(JSON.parse(row.json)); } catch { skipped++; continue; }
      if (open) add.run(row.thread_id, row.id);
    }
    const done = upper >= newest;
    writeIndexState(db, "open_card", { done: done ? 1 : 0, cursor: Math.max(state.cursor, upper), skipped });
    return !done;
  });
}
export function newestRowid(db: DatabaseSync): number {
  return Number((db.prepare("SELECT max(rowid) AS n FROM messages").get() as { n: number | null } | undefined)?.n ?? 0);
}

// ---- per-thread readiness of the open-card index ---------------------------------------------------------------------
// While the background walker has not finished the whole history, a reader asking for one thread's open cards must not scan that thread's history on
// every request. It gets a bounded look at the thread's newest rows (flagged incomplete when the thread is longer), and the thread is put at the front
// of the walker's queue (`prioritizeThread`); the walker reads that thread's rows in chunks (`stepPriorityThreads`) and marks the thread ready, after
// which the index answers for it exactly, whatever the rest of the history is still waiting for.
const priorityThreads = new WeakMap<object, Map<string, number>>();
const readyThreads = new WeakMap<object, Set<string>>();
/** True when the open-card index answers exactly for this thread: the whole history is indexed, or this thread has been prepared. */
export function threadCardsReady(db: DatabaseSync, threadId: string): boolean {
  return readIndexState(db, "open_card").done === 1 || readyThreads.get(db)?.has(threadId) === true;
}
/** Told when a thread's open cards become exact (one prepared thread, or `null` when the whole history is indexed): a reader that was answered
 * "pending" asks again. A listener never stops the walker. */
type CardsReadyListener = (threadId: string | null) => void;
const cardsReadyListeners = new Set<CardsReadyListener>();
export function onThreadCardsReady(listener: CardsReadyListener): () => void { cardsReadyListeners.add(listener); return () => { cardsReadyListeners.delete(listener); }; }
export function notifyThreadCardsReady(threadId: string | null): void {
  for (const listener of [...cardsReadyListeners]) { try { listener(threadId); } catch { /* a listener never stops the walker */ } }
}
/** Asks the walker to prepare this thread's open cards before anything else. */
export function prioritizeThread(db: DatabaseSync, threadId: string): void {
  if (threadCardsReady(db, threadId)) return;
  let queue = priorityThreads.get(db);
  if (!queue) priorityThreads.set(db, queue = new Map());
  if (!queue.has(threadId)) queue.set(threadId, 0);
}
/** True while a prioritised thread waits for the walker. */
export function priorityThreadsPending(db: DatabaseSync): boolean { return (priorityThreads.get(db)?.size ?? 0) > 0; }
/** One chunk of the first prioritised thread: `rows` of its own rows from where the last chunk ended, open cards into the index, and no row begun once
 * `deadline` (on `now`'s clock) has passed (looked at after every row, so a chunk overruns by one row at most). Returns whether any thread still waits. */
export function stepPriorityThreads(db: DatabaseSync, bounds: number | { rows?: number; deadline?: number; now?: () => number } = BACKFILL_CHUNK_ROWS): boolean {
  const { rows = BACKFILL_CHUNK_ROWS, deadline = Infinity, now = () => performance.now() } = typeof bounds === "number" ? { rows: bounds } : bounds;
  const queue = priorityThreads.get(db);
  const thread = queue?.keys().next().value;
  if (!queue || thread === undefined) return false;
  if (readIndexState(db, "open_card").done === 1) { queue.clear(); return false; }
  const from = queue.get(thread) ?? 0;
  const chunk = db.prepare("SELECT rowid AS position, id, CASE WHEN kind = 'options' THEN json END AS json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?");
  const add = db.prepare("INSERT OR IGNORE INTO open_card(thread_id, id) VALUES (?, ?)");
  let read = 0, last = from, cut = false;
  inTransaction(db, () => {
    for (const row of chunk.iterate(thread, from, rows) as Iterable<{ position: number; id: string; json: string | null }>) {
      read++; last = row.position;
      if (row.json !== null) {
        let open = false;
        try { open = isOpenCardJson(JSON.parse(row.json)); } catch { open = false; }
        if (open) add.run(thread, row.id);
      }
      if (read < rows && now() >= deadline) { cut = true; break; }
    }
  });
  if (!cut && read < rows) {
    queue.delete(thread);
    let ready = readyThreads.get(db);
    if (!ready) readyThreads.set(db, ready = new Set());
    ready.add(thread);
    notifyThreadCardsReady(thread);
  } else queue.set(thread, last);
  return queue.size > 0;
}

/** Where a long start-up scan has got to, for the start-up note. */
export interface IndexProgress { done: number; total: number }
export interface EnsureIndexHooks {
  /** Called once, before the first chunk, only when there is history left to index. */
  onStart?: (progress: IndexProgress) => void;
  /** Called after each committed chunk (the caller decides how often to publish it). */
  onChunk?: (progress: IndexProgress) => void;
  /** Leave the index to the background job (upgrade-background.ts): on a history with messages it is neither read nor waited for here. */
  defer?: boolean;
}
/** True while the open-card index still has history to read (a fresh or empty file has none). */
export function openCardIndexPending(db: DatabaseSync): boolean {
  if (readIndexState(db, "open_card").done) return false;
  return db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() !== undefined;
}

/** The open-card index is complete before the first read of it (it is small,
 * and a card missing from it would hide an approval). Chunks are committed with
 * their cursor, so an interrupted pass resumes; `hooks` let the start-up note
 * be published BEFORE the first chunk and refreshed after each one, so a long
 * scan on a large history is reported work, not silence. */
export function ensureOpenCardIndex(db: DatabaseSync, hooks: EnsureIndexHooks = {}): void {
  if ((hooks.onStart || hooks.onChunk) && openCardIndexPending(db)) {
    const total = newestRowid(db);
    try { hooks.onStart?.({ done: readIndexState(db, "open_card").cursor, total }); } catch { /* a status write never stops the index */ }
    while (indexOpenCardsChunk(db)) {
      try { hooks.onChunk?.({ done: readIndexState(db, "open_card").cursor, total }); } catch { /* as above */ }
    }
    return;
  }
  while (indexOpenCardsChunk(db)) { /* chunk by chunk, each committed */ }
}

/** One chunk of the keyed-card index: the next stretch of `rows` storage
 * positions, bounded by the rows it scans like indexOpenCardsChunk. Only
 * options rows are read: every family that is filled from history (setup,
 * intake, browser, skill, publish) is one. Rows written since the table exists are
 * indexed by their writer. Returns whether more remain. */
export function indexKeyedCardsChunk(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): boolean {
  const state = readIndexState(db, "keyed_card");
  if (state.done) return false;
  const newest = newestRowid(db);
  const upper = Math.min(newest, state.cursor + rows);
  const batch = db.prepare("SELECT thread_id, id, json FROM messages WHERE rowid > ? AND rowid <= ? AND kind = 'options' ORDER BY rowid").all(state.cursor, upper) as Array<{ thread_id: string; id: string; json: string }>;
  const add = db.prepare("INSERT OR IGNORE INTO keyed_card(thread_id, family, key, id) VALUES (?, ?, ?, ?)");
  return inTransaction(db, () => {
    let skipped = state.skipped;
    for (const row of batch) {
      let keys: ReturnType<typeof keyedCardsOf>;
      try { keys = keyedCardsOf(JSON.parse(row.json)); } catch { skipped++; continue; }
      for (const { family, key } of keys) add.run(row.thread_id, family, key, row.id);
    }
    const done = upper >= newest;
    writeIndexState(db, "keyed_card", { done: done ? 1 : 0, cursor: Math.max(state.cursor, upper), skipped });
    return !done;
  });
}

/** The keyed-card index is complete before the first read of it, like the
 * open-card index (a card missing from it would hide a setup step or a
 * browser offer): chunk by chunk, each committed with its cursor, so an
 * interrupted pass resumes. */
export function ensureKeyedCardIndex(db: DatabaseSync, hooks: EnsureIndexHooks = {}): void {
  const pending = !readIndexState(db, "keyed_card").done && db.prepare("SELECT 1 AS present FROM messages LIMIT 1").get() !== undefined;
  if (pending && (hooks.onStart || hooks.onChunk)) {
    const total = newestRowid(db);
    try { hooks.onStart?.({ done: readIndexState(db, "keyed_card").cursor, total }); } catch { /* a status write never stops the index */ }
    while (indexKeyedCardsChunk(db)) {
      try { hooks.onChunk?.({ done: readIndexState(db, "keyed_card").cursor, total }); } catch { /* as above */ }
    }
    return;
  }
  while (indexKeyedCardsChunk(db)) { /* chunk by chunk, each committed */ }
}

/** Every stored-attachment file name (uuid.ext, lowercase) a message's JSON mentions: the definition conversation deletion asks by. */
export const ATTACHMENT_NAME_IN_JSON = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}/gi;
export function attachmentNamesIn(json: string): string[] {
  return [...new Set([...json.matchAll(ATTACHMENT_NAME_IN_JSON)].map((m) => m[0].toLowerCase()))];
}

/** One chunk of the attachment-name index (which rows name which stored attachment file): the next stretch of `rows` storage
 * positions, bounded by the rows it scans. Rows written since the table exists are indexed by their writers. Conversation
 * deletion trusts the index only once this pass is done, and keeps a file it cannot yet vouch for. Returns whether more remain. */
export function indexAttachmentNamesChunk(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): boolean {
  const state = readIndexState(db, "attachment_name");
  if (state.done) return false;
  const newest = newestRowid(db);
  const upper = Math.min(newest, state.cursor + rows);
  const batch = db.prepare("SELECT thread_id, id, json FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid").all(state.cursor, upper) as Array<{ thread_id: string; id: string; json: string }>;
  const add = db.prepare("INSERT OR IGNORE INTO attachment_name(name, thread_id, id) VALUES (?, ?, ?)");
  return inTransaction(db, () => {
    for (const row of batch) for (const name of attachmentNamesIn(row.json)) add.run(name, row.thread_id, row.id);
    const done = upper >= newest;
    writeIndexState(db, "attachment_name", { done: done ? 1 : 0, cursor: Math.max(state.cursor, upper), skipped: state.skipped });
    return !done;
  });
}

/** A turn's first row as kept (turn_first: written with each row and filled with the thread, so for a prepared thread it
 * is exact), or null when the turn wrote nothing. */
export function turnFirstRowid(db: DatabaseSync, threadId: string, turnId: string): number | null {
  const kept = db.prepare("SELECT first_rowid AS first FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId) as { first: number } | undefined;
  return kept ? kept.first : null;
}

// ---- the branch walk -------------------------------------------------------

/** Parent reads made by branch walks (the numbers the scale tests assert on). */
export const walkStats = { parentReads: 0 };

export interface Step { position: number; json: string; parent: string | null; requestId: boolean }

/** One step up a branch: the row's storage position and parent id. A row saved
 * before branching existed (no parentId key) is chained to the row stored
 * before it, as Store.loadedMessages reads it. */
export function stepUpRow(db: DatabaseSync, threadId: string, id: string): { position: number; json: string; message: Record<string, unknown>; parent: string | null } | null {
  walkStats.parentReads++;
  const row = db.prepare("SELECT rowid AS position, json FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { position: number; json: string } | undefined;
  if (!row) return null;
  const message = JSON.parse(row.json) as Record<string, unknown>;
  if (message.parentId === undefined) {
    walkStats.parentReads++;
    const before = db.prepare("SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1").get(threadId, row.position) as { id: string } | undefined;
    message.parentId = before?.id ?? null;
  }
  return { position: row.position, json: row.json, message, parent: (message.parentId as string | null | undefined) ?? null };
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const defaultSleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** The source name the I/O budget sees this work under. */
export const BACKFILL_SOURCE = "transcript-backfill";
/** How long background work waits for a lock; past it the chunk is retried later (the memory worker's figure). */
export const BACKFILL_BUSY_MS = 50;

function isBusy(error: unknown): boolean {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true; // SQLITE_BUSY and its extended codes
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
}

/** Run one chunk as background work: attributed to the backfill in the I/O
 * budget and waiting only BACKFILL_BUSY_MS for a lock, so it never holds the
 * thread for the owner's full wait. A lock past that throws and is retried. */
function asBackground<T>(db: DatabaseSync, run: () => T): T {
  let prior: number | null = null;
  try { prior = Number((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout); db.exec(`PRAGMA busy_timeout=${BACKFILL_BUSY_MS}`); } catch { prior = null; }
  try { return ioBudget.withSource(BACKFILL_SOURCE, run); }
  finally { if (prior !== null) { try { db.exec(`PRAGMA busy_timeout=${prior}`); } catch { /* handle closed */ } } }
}

export interface BackfillTuning {
  sleep?: (ms: number) => Promise<void>;
  /** First retry wait after a lock (doubles to retryMaxMs). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** The owner-first gate this work asks before each chunk. Defaults to the process-wide gate
   * (off under vitest unless a test passes one, like the loop itself). */
  gate?: { admit(kind: string): Admission } | null;
  /** Resolves when this work may write (default: the hold the server set, holdTranscriptBackfillUntil). */
  ready?: Promise<void> | null;
}
/** What the server holds the backfill's writes behind: the listen tick writes nothing until the first health answer (STALLS-FINAL-DESIGN 3.4;
 * rc13 real-data run: `[startup] writes before first health=57`, all of them attachment-name slices of this backfill). Set in the listen tick
 * (index.ts, startupWritesReady); no hold is set anywhere else (a test, a tool that opens the file), so nothing else waits. */
let startHold: Promise<void> | null = null;
export function holdTranscriptBackfillUntil(ready: Promise<void> | null): void { startHold = ready; }
/** The kind this work asks the owner-first gate under. */
export const BACKFILL_OWNER_FIRST_KIND = "transcript-backfill";

/** Run every pending backfill to the end, one bounded chunk at a time. Each
 * chunk is at most ~1,000 reads and the event loop is free after EVERY chunk,
 * the last of a thread included. A lock or other failure waits (doubling, and
 * never inside the I/O budget's deferral window) and carries on from the
 * progress already saved; the loop itself is what retries, so no open is
 * needed to restart it. `stillOpen` ends it if the handle was closed. */
export async function runTranscriptBackfill(db: DatabaseSync, stillOpen: () => boolean = () => true, tuning: BackfillTuning = {}): Promise<void> {
  const sleep = tuning.sleep ?? defaultSleep;
  const base = tuning.retryBaseMs ?? 250;
  const cap = tuning.retryMaxMs ?? 30_000;
  const failures = { prepare: 0 };
  // wait out the I/O budget's deferral window completely: sleep in steps of at
  // most `cap` but look again after each, and run nothing until it has ended
  // and let the owner's own work go first (owner-first.ts): while a turn runs, the owner types or the
  // computer is overloaded, wait; the gate admits it anyway after its own bound, so it never starves
  const gate = tuning.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : tuning.gate;
  const pause = async () => {
    // read at every chunk, so a hold set after the loop began still holds the next chunk
    const hold = tuning.ready === undefined ? startHold : tuning.ready;
    if (hold) await hold;
    while (gate && stillOpen()) {
      const admission = gate.admit(BACKFILL_OWNER_FIRST_KIND);
      if (admission.admitted) break;
      await sleep(Math.min(admission.retryInMs, cap));
    }
    for (let deferred = ioBudget.deferredForMs(BACKFILL_SOURCE); deferred > 0 && stillOpen(); deferred = ioBudget.deferredForMs(BACKFILL_SOURCE)) {
      await sleep(Math.min(deferred, cap));
    }
  };
  /** One slice of the thread a request asked for (the front of the fill), when one waits; whoever was answered "pending" is told when it is ready. */
  const serviceFront = async (): Promise<boolean> => {
    if (!stillOpen()) return false;
    const queued = asBackground(db, () => nextQueuedFill(db));
    if (queued === undefined) return false;
    await pause();
    const done = asBackground(db, () => { const began = performance.now(); const finished = inTransaction(db, () => fillOneSlice(db, queued).done); noteSlice(performance.now() - began); return finished; });
    failures.prepare = 0;
    if (done && dequeueFrontFill(db, queued)) notifyThreadCardsReady(queued);
    await yieldLoop();
    return true;
  };
  while (stillOpen()) {
    try {
      // the attachment-name index first: a chunk at a time, committed with its cursor
      for (;;) {
        if (!stillOpen()) return;
        await serviceFront();
        await pause();
        const more = asBackground(db, () => indexAttachmentNamesChunk(db));
        failures.prepare = 0;
        await yieldLoop();
        if (!more) break;
      }
      notifyAttachmentIndexComplete();
      // every thread, one at a time, in slices: a thread the owner opens first is prepared ahead of this pass by its own turn
      do {
        wake = false;
        while (await serviceFront()) { /* the threads a request is waiting on, first */ }
        // the conversations with the newest messages first: they are the ones about to be used
        for (const threadId of asBackground(db, () => recentUnpreparedThreads(db))) {
          for (;;) {
            if (!stillOpen()) return;
            if (await serviceFront()) continue;
            await pause();
            const done = asBackground(db, () => { const began = performance.now(); const finished = inTransaction(db, () => fillOneSlice(db, threadId).done); noteSlice(performance.now() - began); return finished; });
            failures.prepare = 0;
            await yieldLoop();
            if (done) break;
          }
        }
        let after = "";
        for (;;) {
          if (!stillOpen()) return;
          const threadId = asBackground(db, () => nextUnpreparedThread(db, after));
          if (threadId === null) break;
          for (;;) {
            if (!stillOpen()) return;
            if (await serviceFront()) continue;
            await pause();
            const done = asBackground(db, () => { const began = performance.now(); const finished = inTransaction(db, () => fillOneSlice(db, threadId).done); noteSlice(performance.now() - began); return finished; });
            failures.prepare = 0;
            await yieldLoop();
            if (done) break;
          }
          after = threadId;
        }
      } while (wake && stillOpen());
      return;
    } catch (error) {
      if (!stillOpen()) return;
      const count = ++failures.prepare;
      if (count === 1 || count % 10 === 0) console.warn(`[transcript] backfill: ${isBusy(error) ? "database busy" : error instanceof Error ? error.message : String(error)}; retrying from saved progress`);
      await sleep(Math.min(isBusy(error) ? cap : cap * 10, base * 2 ** Math.min(count - 1, 16)));
    }
  }
}

/** Called when a pass finds the attachment-name index complete (the deletion of a conversation that had to keep a file waits on it). */
const attachmentIndexListeners = new Set<() => void>();
export function onAttachmentIndexComplete(listener: () => void): () => void {
  attachmentIndexListeners.add(listener);
  return () => { attachmentIndexListeners.delete(listener); };
}
export function notifyAttachmentIndexComplete(): void {
  for (const listener of attachmentIndexListeners) { try { listener(); } catch (error) { console.warn(`[transcript] attachment index listener: ${error instanceof Error ? error.message : String(error)}`); } }
}

/** The one background pass of the process, and whether it has been asked to look again. */
let running: { db: DatabaseSync; done: Promise<void> } | null = null;
let wake = false;
/** Whether the backfill loop of this process is running (it ends once every index and thread is prepared). Idle memory work yields to it. */
export function transcriptBackfillRunning(): boolean { return running !== null; }

/** Start (or nudge) the background backfill. One loop per process; it retries
 * itself with backoff, so a lock or a failed chunk never waits for the next open. */
export function startTranscriptBackfill(db: DatabaseSync, stillOpen: () => boolean): void {
  if (process.env.VITEST && !process.env.MURAGE_TEST_BACKFILL) return;
  wake = true;
  if (running && running.db === db) return;
  const done = (async () => { await yieldLoop(); await runTranscriptBackfill(db, stillOpen); })()
    .catch((error) => { if (stillOpen()) console.warn(`[transcript] backfill: ${error instanceof Error ? error.message : String(error)}`); })
    .finally(() => { if (running?.done === done) running = null; });
  running = { db, done };
}
