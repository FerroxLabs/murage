// Bounded, resumable upkeep of the derived transcript tables (message-tables.ts):
// open_card, turn_first, card_branch. All three are derived from `messages`;
// a database from before they existed is brought up to date here in chunks,
// each its own transaction that records where it got to, so a failure or a
// restart carries on from the last chunk instead of starting over or being
// mistaken for done. Nothing here walks a whole thread in one go: the open path
// takes a bounded number of steps and the rest runs in the background, yielding
// the event loop between chunks.
import { scopedTx } from "./tx-scope.ts";
import type { DatabaseSync } from "node:sqlite";
import { ioBudget } from "./io-budget.ts";
import { ownerFirst, type Admission } from "./owner-first.ts";

/** An open request card: an unanswered, undismissed options row that carries a
 * request id (Store.isOpenRequestCard), and not one the start already retired (`orphaned`: an approval left by an earlier run, which no longer counts
 * as waiting). Retired cards stay in their conversations but not in this list, so the list, and everything that reads it before the server
 * listens, follows the cards that are really open and not the approvals of the past. */
export function isOpenCardJson(message: { kind?: unknown; card?: { requestId?: unknown; answered?: unknown; dismissed?: unknown; orphaned?: unknown } | null }): boolean {
  const card = message.card;
  return message.kind === "options" && typeof card?.requestId === "string" && card.requestId !== "" && !card.answered && !card.dismissed && !card.orphaned;
}

/** How many rows one backfill chunk reads. */
export const BACKFILL_CHUNK_ROWS = 1_000;
/** Parent links the request path may follow for one open before it leaves the rest to the background. */
export const OPEN_PATH_WALK_STEPS = 256;
/** Parent links one background chunk follows. */
export const BACKGROUND_WALK_STEPS = 1_000;

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
      if (open && Number(add.run(row.thread_id, row.id).changes) > 0) invalidateCardWalk(db, row.thread_id, row.id);
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
/** One chunk of the first prioritised thread: `rows` of its own rows from where the last chunk ended, open cards into the index. Returns whether any thread still waits. */
export function stepPriorityThreads(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): boolean {
  const queue = priorityThreads.get(db);
  const thread = queue?.keys().next().value;
  if (!queue || thread === undefined) return false;
  if (readIndexState(db, "open_card").done === 1) { queue.clear(); return false; }
  const from = queue.get(thread) ?? 0;
  const batch = db.prepare("SELECT rowid AS position, id, CASE WHEN kind = 'options' THEN json END AS json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?").all(thread, from, rows) as Array<{ position: number; id: string; json: string | null }>;
  const add = db.prepare("INSERT OR IGNORE INTO open_card(thread_id, id) VALUES (?, ?)");
  inTransaction(db, () => {
    for (const row of batch) {
      if (row.json === null) continue;
      let open = false;
      try { open = isOpenCardJson(JSON.parse(row.json)); } catch { continue; }
      if (open && Number(add.run(thread, row.id).changes) > 0) invalidateCardWalk(db, thread, row.id);
    }
  });
  if (batch.length < rows) {
    queue.delete(thread);
    let ready = readyThreads.get(db);
    if (!ready) readyThreads.set(db, ready = new Set());
    ready.add(thread);
    notifyThreadCardsReady(thread);
  } else queue.set(thread, batch[batch.length - 1]!.position);
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

/** One chunk of the turn-first-row table: rows by storage position. */
export function indexTurnFirstChunk(db: DatabaseSync, rows = BACKFILL_CHUNK_ROWS): boolean {
  const state = readIndexState(db, "turn_first");
  if (state.done) return false;
  const batch = db.prepare("SELECT rowid AS position, thread_id, json FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?").all(state.cursor, rows) as Array<{ position: number; thread_id: string; json: string }>;
  const put = db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES (?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)");
  return inTransaction(db, () => {
    let skipped = state.skipped;
    for (const row of batch) {
      let turnId: unknown;
      try { turnId = (JSON.parse(row.json) as { turnId?: unknown }).turnId; } catch { skipped++; continue; }
      if (typeof turnId === "string" && turnId) put.run(row.thread_id, turnId, row.position);
    }
    const last = batch.length ? batch[batch.length - 1]!.position : state.cursor;
    const done = batch.length < rows;
    writeIndexState(db, "turn_first", { done: done ? 1 : 0, cursor: last, skipped });
    return !done;
  });
}

/** Most parent links one lookup of a turn's first row follows. */
export const TURN_LOOKUP_STEPS = 5_000;
/** Rows of other turns the lookup steps over inside one turn (a queued message
 * written between its rows) before it takes the turn to have begun. */
export const TURN_LOOKUP_GAP = 64;

/** A turn's first row: kept, else found by following the branch up from a row
 * of the turn (`fromId`), which costs the turn's length and never the thread's
 * history. A lookup cut short by the step cap or a damaged row is used for
 * this call but not kept, so the background fill (indexTurnFirstChunk) stays
 * the one writer of a figure that might be too late. */
export function turnFirstRowid(db: DatabaseSync, threadId: string, turnId: string, fromId?: string | null): number | null {
  const kept = db.prepare("SELECT first_rowid AS first FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId) as { first: number } | undefined;
  if (kept) return kept.first;
  if (!fromId) return null;
  let first: number | null = null;
  let at: string | null = fromId;
  let gap = 0;
  let steps = 0;
  let complete = false;
  while (true) {
    if (!at) { complete = true; break; }
    if (steps++ >= TURN_LOOKUP_STEPS) break;
    let step;
    try { step = stepUpRow(db, threadId, at); } catch (error) { if (error instanceof SyntaxError) break; throw error; }
    if (!step) { complete = first !== null || steps > 1; break; }
    if (step.message.turnId === turnId) { gap = 0; if (first === null || step.position < first) first = step.position; }
    else if (++gap > TURN_LOOKUP_GAP) { complete = true; break; }
    at = step.parent;
  }
  if (first !== null && complete) db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES (?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)").run(threadId, turnId, first);
  return first;
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

export interface WalkResult {
  /** The walk reached the root, a dead end, or proved the chain loops. */
  done: boolean;
  /** Wanted cards passed on the branch by THIS call (earlier calls' finds are
   * already stored per card in card_branch, so no list of them is carried). */
  found: Set<string>;
}

/** What a walk in progress keeps besides its cursor: constant size however far
 * the walk has gone. Stored in branch_walk.found as JSON. */
interface WalkState { power: number; lam: number; tortoise: string }

/** A card became open in `threadId` (new or reopened): the walk in progress may
 * have passed it already and the answer kept for it may be stale, so both are
 * dropped and the walk starts again. Every writer that makes a card open calls
 * this inside the transaction of the card write, so the walk can never resume
 * below a card it has not seen.
 *
 * One case keeps the walk: `parentId` is the very head the walk in progress
 * starts from (a card appended as the branch's next row, so it is a descendant
 * of the walk's start). The walk only ever goes up from that head, so it can
 * never have passed such a card, and the card is on the branch by the append
 * itself (trackCardBranch writes it). Ancestry decides this, never the storage
 * position. A busy thread, which gets a new card every few rows, therefore
 * finishes its walk once instead of starting it again for ever. */
export function invalidateCardWalk(db: DatabaseSync, threadId: string, cardId: string, parentId?: string | null): void {
  let extension = false;
  if (typeof parentId === "string" && parentId !== "" && parentId !== cardId) {
    const walk = db.prepare("SELECT leaf_id FROM branch_walk WHERE thread_id = ?").get(threadId) as { leaf_id: string } | undefined;
    extension = walk?.leaf_id === parentId;
  }
  if (!extension) db.prepare("DELETE FROM branch_walk WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM card_branch WHERE thread_id = ? AND card_id = ?").run(threadId, cardId);
}

/** Follow parent links up from `leafId` for at most `budget` reads, resuming
 * from the cursor saved for this (thread, leaf) and saving it again, so the
 * work is shared between opens and the background. Ancestry is the parent
 * links alone: storage order says nothing about it (an ancestor can be stored
 * after its child). A loop in the links is found by Brent's cycle detection,
 * whose whole state (power, steps since the last mark, the marked id) is kept
 * in the cursor, so no count of the thread's rows is ever taken. Callers run this and the writes of what it found in one
 * transaction so progress and results move together. */
export function advanceBranchWalk(db: DatabaseSync, threadId: string, leafId: string, want: ReadonlyMap<string, number>, budget: number): WalkResult {
  const saved = db.prepare("SELECT leaf_id, cursor_id, pos, found FROM branch_walk WHERE thread_id = ?").get(threadId) as { leaf_id: string; cursor_id: string | null; pos: number | null; found: string } | undefined;
  let at: string | null = leafId;
  let lastPos: number | null = null;
  let state: WalkState | null = null;
  if (saved && saved.leaf_id === leafId) {
    try {
      const parsed = JSON.parse(saved.found) as Partial<WalkState> | null;
      if (parsed && Number.isFinite(parsed.power) && Number.isFinite(parsed.lam) && typeof parsed.tortoise === "string") {
        state = parsed as WalkState; at = saved.cursor_id; lastPos = saved.pos;
      }
    } catch { /* an unreadable state is a walk that starts over */ }
  }
  if (!state) state = { power: 1, lam: 0, tortoise: leafId };
  const found = new Set<string>();
  const startReads = walkStats.parentReads;
  let done = false;
  while (true) {
    if (found.size >= want.size) { done = true; break; }
    if (!at) { done = true; break; }
    if (walkStats.parentReads - startReads >= budget) break;
    let step;
    try { step = stepUpRow(db, threadId, at); } catch (error) { if (error instanceof SyntaxError) step = null; else throw error; }
    if (!step) { done = true; break; }
    lastPos = step.position;
    if (want.has(at)) found.add(at);
    at = step.parent;
    if (at !== null) {
      // Brent: the marked id is renewed at every power of two; meeting it again is a loop
      state.lam++;
      if (at === state.tortoise) { done = true; break; }
      if (state.lam === state.power) { state.tortoise = at; state.power *= 2; state.lam = 0; }
    }
  }
  if (done) db.prepare("DELETE FROM branch_walk WHERE thread_id = ?").run(threadId);
  else db.prepare("INSERT OR REPLACE INTO branch_walk(thread_id, leaf_id, cursor_id, pos, found) VALUES (?, ?, ?, ?, ?)").run(threadId, leafId, at, lastPos, JSON.stringify(state));
  return { done, found };
}

export interface CardRef { id: string; rowid: number }

/** Which of `cards` the branch ending at `leafId` passes through: the answers
 * kept in card_branch, then at most `budget` parent reads for the rest, with
 * the progress and every card found written together. `pending` lists the
 * cards the walk has not settled yet; they are never written as an answer. */
export function resolveCardBranch(db: DatabaseSync, threadId: string, leafId: string, cards: CardRef[], budget: number, tx: <T>(run: () => T) => T = (run) => inTransaction(db, run)): { onBranch: Set<string>; pending: string[] } {
  const onBranch = new Set<string>();
  const read = db.prepare("SELECT leaf_id, on_branch FROM card_branch WHERE thread_id = ? AND card_id = ?");
  const unknown: CardRef[] = [];
  for (const card of cards) {
    const known = read.get(threadId, card.id) as { leaf_id: string; on_branch: number } | undefined;
    if (known && known.leaf_id === leafId) { if (known.on_branch) onBranch.add(card.id); }
    else unknown.push(card);
  }
  if (!unknown.length) return { onBranch, pending: [] };
  const write = db.prepare("INSERT OR REPLACE INTO card_branch (thread_id, card_id, leaf_id, on_branch) VALUES (?, ?, ?, ?)");
  const pending: string[] = [];
  tx(() => {
    const result = advanceBranchWalk(db, threadId, leafId, new Map(unknown.map((card) => [card.id, card.rowid])), budget);
    for (const card of unknown) {
      const yes = result.found.has(card.id);
      if (yes) { onBranch.add(card.id); write.run(threadId, card.id, leafId, 1); }
      else if (result.done) write.run(threadId, card.id, leafId, 0);
      else pending.push(card.id);
    }
  });
  return { onBranch, pending };
}

// ---- the background driver ---------------------------------------------------

let running: { db: DatabaseSync; done: Promise<void> } | null = null;
let wake = false;

/** The next thread after `after` that holds an open card, one keyed read. */
function nextThreadWithOpenCards(db: DatabaseSync, after: string): string | null {
  return (db.prepare("SELECT thread_id FROM open_card WHERE thread_id > ? ORDER BY thread_id LIMIT 1").get(after) as { thread_id: string } | undefined)?.thread_id ?? null;
}

/** The stored branch head, or the newest row when none is stored. */
export function activeLeafOf(db: DatabaseSync, threadId: string): string | null {
  const state = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId) as { active_leaf_id: string | null } | undefined;
  if (state?.active_leaf_id) return state.active_leaf_id;
  return (db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(threadId) as { id: string } | undefined)?.id ?? null;
}

/** One background walk chunk for a thread; true while it still has work. One
 * chunk is at most BACKGROUND_WALK_STEPS reads. */
export function walkThreadChunk(db: DatabaseSync, threadId: string): boolean {
  const leaf = activeLeafOf(db, threadId);
  if (!leaf) return false;
  const rows = db.prepare("SELECT c.id AS id, m.rowid AS rowid FROM open_card c JOIN messages m ON m.thread_id = c.thread_id AND m.id = c.id WHERE c.thread_id = ?").all(threadId) as unknown as CardRef[];
  if (!rows.length) return false;
  return resolveCardBranch(db, threadId, leaf, rows, BACKGROUND_WALK_STEPS).pending.length > 0;
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
  /** Fill the first-row-of-turn table here (default). The server leaves it to the fused walker over the messages (message-walker.ts), which fills it in the
   * same pass as the open-card index and the pending browser notes. */
  turnFirst?: boolean;
}
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
  const progress = { after: "" };
  // one failure count per phase, cleared only by progress in that phase: a
  // phase that is a no-op (turn indexing already done) must not hide a lock
  // that keeps failing the other one
  const failures = { turn: 0, walk: 0 };
  let phase: "turn" | "walk" = "turn";
  // wait out the I/O budget's deferral window completely: sleep in steps of at
  // most `cap` but look again after each, and run nothing until it has ended
  // and let the owner's own work go first (owner-first.ts): while a turn runs, the owner types or the
  // computer is overloaded, wait; the gate admits it anyway after its own bound, so it never starves
  const gate = tuning.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : tuning.gate;
  const pause = async () => {
    while (gate && stillOpen()) {
      const admission = gate.admit(BACKFILL_OWNER_FIRST_KIND);
      if (admission.admitted) break;
      await sleep(Math.min(admission.retryInMs, cap));
    }
    for (let deferred = ioBudget.deferredForMs(BACKFILL_SOURCE); deferred > 0 && stillOpen(); deferred = ioBudget.deferredForMs(BACKFILL_SOURCE)) {
      await sleep(Math.min(deferred, cap));
    }
  };
  while (stillOpen()) {
    try {
      while (stillOpen() && tuning.turnFirst !== false) {
        phase = "turn";
        await pause();
        const more = asBackground(db, () => indexTurnFirstChunk(db));
        failures.turn = 0;
        await yieldLoop();
        if (!more) break;
      }
      do {
        wake = false;
        while (stillOpen()) {
          phase = "walk";
          const threadId = asBackground(db, () => nextThreadWithOpenCards(db, progress.after));
          if (threadId === null) break;
          while (stillOpen()) {
            await pause();
            const more = asBackground(db, () => walkThreadChunk(db, threadId));
            failures.walk = 0;
            await yieldLoop();
            if (!more) break;
          }
          progress.after = threadId;
        }
        progress.after = "";
      } while (wake && stillOpen());
      return;
    } catch (error) {
      if (!stillOpen()) return;
      const count = ++failures[phase];
      if (count === 1 || count % 10 === 0) console.warn(`[transcript] backfill: ${isBusy(error) ? "database busy" : error instanceof Error ? error.message : String(error)}; retrying from saved progress`);
      await sleep(Math.min(isBusy(error) ? cap : cap * 10, base * 2 ** Math.min(count - 1, 16)));
    }
  }
}

/** Start (or nudge) the background backfill. One loop per process; it retries
 * itself with backoff, so a lock or a failed chunk never waits for the next open. */
export function startTranscriptBackfill(db: DatabaseSync, stillOpen: () => boolean): void {
  if (process.env.VITEST && !process.env.MURAGE_TEST_BACKFILL) return;
  wake = true;
  if (running && running.db === db) return;
  const done = (async () => { await yieldLoop(); await runTranscriptBackfill(db, stillOpen, { turnFirst: false }); })()
    .catch((error) => { if (stillOpen()) console.warn(`[transcript] backfill: ${error instanceof Error ? error.message : String(error)}`); })
    .finally(() => { if (running?.done === done) running = null; });
  running = { db, done };
}
