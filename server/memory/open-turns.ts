// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The v9 open-turns table (memory_open_turns) after an upgrade, and the start-up reconcile of the turns a stopped process left working.
// The schema transaction creates the table and its triggers empty (schema.ts), so the triggers keep every turn that starts from then on.
// This finds the turns that were already working when the file was upgraded (a dead process's: nothing runs yet), in short slices of the
// turn sources, one transaction per slice, keyed by a persisted source-id cursor: a large file never holds one huge write, a stopped
// start carries on where it left off, and the work finishes under continuous use. It never waits for a quiet spell, and it never
// reads the sources a second time: a completed turn is passed over by the cursor, not looked up.
//
// Start-up itself does constant work before the server listens: `bumpOpenTurnsBoot` adds one to the start counter, nothing more. The turns a
// stopped process left working carry an earlier counter, so after listening `reconcileOpenTurns` pages exactly those (an index on the
// counter) and settles them as interrupted, however many turns the history holds.
//
// The slice driver is the revocation index's (revocation-index.ts): adaptive 8..512 rows per transaction, a few milliseconds each, the
// writer gate awaited before each slice, a longer pause while an owner turn is live, a held lock tried again later.
import type { DatabaseSync } from "node:sqlite";
import { TURN_SOURCE_HIGH, TURN_SOURCE_LOW } from "./schema.ts";

export type OpenTurnRow = { source_id: string; thread_id: string | null; turn_id: string | null };
/** Settles one working turn as interrupted. Called inside the slice's own transaction, so what it writes commits with the slice. */
export type InterruptOpenTurn = (db: DatabaseSync, row: { id: string; threadId: string; turnId: string }) => void;
export type OpenTurnsProgress = { ready: boolean; done: number; interrupted: number };

type BuildRow = { boot: number; ready: number; cursor: string | null; done: number };
function buildRow(db: DatabaseSync): BuildRow | null | undefined {
  // undefined: no such table (a file below v9); null: the table without its row
  try { return (db.prepare("SELECT boot,ready,cursor,done FROM memory_open_turns_build WHERE id=1").get() as BuildRow | undefined) ?? null; }
  catch { return undefined; }
}
const rollback = (db: DatabaseSync) => { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } };
/** A lock held by another connection or process: never a reason to end the work. */
const lockedError = (error: unknown): boolean => {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
};

/** Time budget of one background slice's transaction: the slice ends after the chunk that crosses it. */
export const OPEN_TURNS_SLICE_TARGET_MS = 5;
/** The background slice starts this small, grows only while it stays within the target, shrinks at once on an overrun, and never passes the cap. */
export const OPEN_TURNS_START_ROWS = 32;
export const OPEN_TURNS_MIN_ROWS = 8;
export const OPEN_TURNS_MAX_ROWS = 512;
/** Rows per chunk inside a time-budgeted slice: the budget is checked between chunks, so a slice is never longer than the budget plus one chunk. */
export const OPEN_TURNS_CHUNK = 8;
/** The pause the work leaves the event loop between slices (always a real timer, never an immediate). */
export const OPEN_TURNS_PAUSE_MS = 5;
/** The pause while an owner turn is live: the work slows, it never stops. */
export const OPEN_TURNS_BUSY_PAUSE_MS = 250;
/** A lock held by something else: the slice is tried again this much later. */
export const OPEN_TURNS_LOCKED_RETRY_MS = 1000;

/** The next slice size from the last one: grow gently while within the target, shrink in proportion (at least by half) the moment it overran. */
export function nextOpenTurnsSliceRows(size: number, ms: number, targetMs: number): number {
  const next = ms <= targetMs ? Math.ceil(size * 1.25) : Math.floor(size * Math.min(0.5, targetMs / Math.max(ms, 0.001)));
  return Math.max(OPEN_TURNS_MIN_ROWS, Math.min(OPEN_TURNS_MAX_ROWS, next));
}

/** Adds one to the start counter. Constant work, done before the server listens: every working turn written from now on carries the new
 * count, every one written before it an earlier count. Returns the new count (0 below v9). */
export function bumpOpenTurnsBoot(db: DatabaseSync): number {
  if (buildRow(db) === undefined) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!buildRow(db)) db.prepare("INSERT INTO memory_open_turns_build(id,boot,ready,cursor,done,started_at) VALUES(1,0,0,NULL,0,?)").run(Date.now());
    db.exec("UPDATE memory_open_turns_build SET boot=boot+1 WHERE id=1");
    const boot = Number(db.prepare("SELECT boot FROM memory_open_turns_build WHERE id=1").get()!.boot);
    db.exec("COMMIT");
    return boot;
  } catch (error) { rollback(db); throw error; }
}

export type OpenTurnsStepOptions = {
  /** Stop adding chunks to this transaction once this many ms have passed (checked between chunks). Unset: one pass over `slice` rows. */
  budgetMs?: number; chunk?: number;
  /** Test seam: called after every chunk (a slow-storage stand-in). */
  afterChunk?: () => void;
  /** A turn this process is running now: never settled here. */
  live?: (sourceId: string) => boolean;
};

/** One step of the work, in its own transaction: first the turns an earlier start left working (the rows whose counter is older than this
 * start's), then, until the table is ready, the next slice of the turn sources, settling every working one the table does not hold (it was
 * working before the upgrade, so its process is gone). The last slice sets the ready flag in the same transaction. Idempotent. With
 * `budgetMs` the transaction ends after the chunk that crosses the budget, so its length is bounded by the budget plus one chunk's work. */
export function openTurnsStep(db: DatabaseSync, interrupt: InterruptOpenTurn, slice = OPEN_TURNS_MAX_ROWS, options: OpenTurnsStepOptions = {}): OpenTurnsProgress {
  const row = buildRow(db);
  if (row === undefined) return { ready: false, done: 0, interrupted: 0 };
  const started = performance.now(), budget = options.budgetMs;
  const overBudget = () => budget !== undefined && performance.now() - started >= budget;
  const rows = Math.max(1, Math.trunc(slice));
  const chunk = budget === undefined && options.chunk === undefined ? rows : Math.max(1, Math.min(rows, Math.trunc(options.chunk ?? OPEN_TURNS_CHUNK)));
  const live = options.live ?? (() => false);
  // One source that cannot be settled (a malformed row, a failing settlement) is passed over, never the end of the run: its own writes are
  // rolled back to a savepoint and the step goes on, so the table still becomes ready and the turns after it are reached (1.0.2 lineage-cold
  // r3, Fable P3-5). The passed-over source stays `working`, which is never extracted (fail closed). A lock still ends the slice (retried).
  let skippedOnce = false;
  const settle = (turn: { id: string; threadId: string; turnId: string }): boolean => {
    db.exec("SAVEPOINT open_turn_settle");
    try { interrupt(db, turn); db.exec("RELEASE open_turn_settle"); return true; }
    catch (error) {
      db.exec("ROLLBACK TO open_turn_settle"); db.exec("RELEASE open_turn_settle");
      if (lockedError(error)) throw error;
      if (!skippedOnce) { skippedOnce = true; console.warn(`[memory] open turns: ${turn.id} could not be settled (${error instanceof Error ? error.message.slice(0, 120) : String(error)}); it stays open and the rest go on`); }
      return false;
    }
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    let interrupted = 0;
    const current = buildRow(db) ?? { boot: 0, ready: 0, cursor: null, done: 0 };
    if (buildRow(db) === null) db.prepare("INSERT INTO memory_open_turns_build(id,boot,ready,cursor,done,started_at) VALUES(1,0,0,NULL,0,?)").run(Date.now());
    // 1) the turns a stopped process left working (counter older than this start's): the index on the counter finds exactly them
    let budgetLeft = rows;
    const stale = db.prepare("SELECT source_id,thread_id,turn_id FROM memory_open_turns WHERE boot<? ORDER BY boot LIMIT ?");
    const stillOpen = db.prepare("SELECT 1 AS x FROM memory_open_turns WHERE source_id=?");
    const restamp = db.prepare("UPDATE memory_open_turns SET boot=? WHERE source_id=?");
    for (;;) {
      const want = Math.min(chunk, budgetLeft);
      if (want <= 0) break;
      const found = stale.all(current.boot, want) as OpenTurnRow[];
      let settled = 0;
      for (const turn of found) {
        if (live(turn.source_id)) continue;
        const ok = settle({ id: turn.source_id, threadId: String(turn.thread_id ?? ""), turnId: String(turn.turn_id ?? "") });
        // a source that could not be settled (deleted since, or failing) stays as it is: it is no longer this start's to reconcile
        if (stillOpen.get(turn.source_id)) restamp.run(current.boot, turn.source_id);
        settled++; if (ok) interrupted++;
      }
      // a live row is skipped, not settled: stop when a whole chunk was skipped, or the same rows would come back
      budgetLeft -= found.length;
      options.afterChunk?.();
      if (found.length < want || settled === 0 || overBudget()) break;
    }
    if (interrupted > 0 || Number(current.ready) === 1) {
      // the working turns of an earlier start were this step's work; the sources are not read again once the table is ready
      const more = Number(current.ready) === 1 ? Boolean(db.prepare("SELECT 1 AS x FROM memory_open_turns WHERE boot<? LIMIT 1").get(current.boot)) : true;
      db.exec("COMMIT");
      return { ready: Number(current.ready) === 1 && !more, done: Number(current.done), interrupted };
    }
    // 2) the next slice of the turn sources, from the persisted cursor
    let lo = current.cursor ?? TURN_SOURCE_LOW, done = Number(current.done), last = false, taken = 0;
    const scan = db.prepare("SELECT id,thread_id,turn_id,kind,outcome FROM memory_sources WHERE id>? AND id<? ORDER BY id LIMIT ?");
    const tracked = db.prepare("SELECT 1 AS x FROM memory_open_turns WHERE source_id=?");
    for (;;) {
      const want = Math.min(chunk, rows - taken);
      const page = scan.all(lo, TURN_SOURCE_HIGH, want) as Array<{ id: string; thread_id: string | null; turn_id: string | null; kind: string; outcome: string }>;
      for (const source of page) {
        lo = source.id; done++;
        // a working turn the table does not hold was written before the upgrade (every later one is in the table through the triggers)
        if (source.kind === "turn" && source.outcome === "working" && !tracked.get(source.id) && !live(source.id)) {
          if (settle({ id: source.id, threadId: String(source.thread_id ?? ""), turnId: String(source.turn_id ?? "") })) interrupted++;
        }
      }
      taken += page.length;
      options.afterChunk?.();
      if (page.length < want) { last = true; break; }
      if (taken >= rows || overBudget()) break;
    }
    db.prepare("UPDATE memory_open_turns_build SET cursor=?,done=?,finished_at=?,ready=? WHERE id=1").run(last ? null : lo, done, last ? Date.now() : null, last ? 1 : 0);
    db.exec("COMMIT");
    return { ready: last, done, interrupted };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export type OpenTurnsRun = {
  done: Promise<{ finished: boolean }>; stop(): void;
  stats: { slices: number; maxSliceMs: number; lockedRetries: number; maxSliceRows: number; interrupted: number };
};

/** The same work, run in the background after the server listens. Each slice is a short writer transaction whose length is bounded by TIME,
 * not only by rows: it works in chunks of a few rows and stops after the chunk that crosses the target, so even on slow storage a slice
 * blocks the loop for at most the target plus one chunk. The row count of a slice starts small, grows only while slices stay within the
 * target, shrinks at once on an overrun, and is capped. Between slices the loop is handed back for a real timer, and `admit` (the writer gate)
 * is awaited before each slice, so a writer hold is respected. While an owner turn is live (`busy`) the pause is longer, never infinite.
 * Turns written meanwhile are kept by the triggers; the persisted cursor covers the older ones, and a stopped process resumes from it.
 * A lock held by another connection delays the slice; any other failure stops the run quietly (the next start carries on). */
export function startOpenTurnsReconcile(db: DatabaseSync, interrupt: InterruptOpenTurn, options: { busy?: () => boolean; admit?: () => Promise<void>; live?: (sourceId: string) => boolean; targetMs?: number; pauseMs?: number; busyPauseMs?: number; slice?: number; afterChunk?: () => void; onError?: (error: unknown) => void } = {}): OpenTurnsRun {
  const target = options.targetMs ?? OPEN_TURNS_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? OPEN_TURNS_PAUSE_MS), busyPause = Math.max(1, options.busyPauseMs ?? OPEN_TURNS_BUSY_PAUSE_MS);
  const stats: OpenTurnsRun["stats"] = { slices: 0, maxSliceMs: 0, lockedRetries: 0, maxSliceRows: 0, interrupted: 0 };
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, resolve!: (value: { finished: boolean }) => void;
  const done = new Promise<{ finished: boolean }>(r => { resolve = r; });
  if (buildRow(db) === undefined) { resolve({ finished: false }); return { done, stop() {}, stats }; }
  let size = Math.max(1, Math.min(OPEN_TURNS_MAX_ROWS, Math.trunc(options.slice ?? OPEN_TURNS_START_ROWS))), reportedOnce = false;
  const finish = (finished: boolean) => { stopped = true; if (timer) clearTimeout(timer); resolve({ finished }); };
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let delay = pause;
    try {
      if (options.admit) await options.admit();
      if (stopped) return;
      const t0 = performance.now();
      const step = openTurnsStep(db, interrupt, size, { budgetMs: target, ...(options.afterChunk ? { afterChunk: options.afterChunk } : {}), ...(options.live ? { live: options.live } : {}) });
      const ms = performance.now() - t0;
      stats.slices++; stats.interrupted += step.interrupted;
      stats.maxSliceMs = Math.max(stats.maxSliceMs, ms);
      stats.maxSliceRows = Math.max(stats.maxSliceRows, size);
      if (step.ready) { finish(true); return; }
      size = nextOpenTurnsSliceRows(size, ms, target);
      if (options.busy?.()) delay = busyPause;
    } catch (error) {
      if (lockedError(error)) { stats.lockedRetries++; delay = OPEN_TURNS_LOCKED_RETRY_MS; }
      else {
        if (!reportedOnce) { reportedOnce = true; try { options.onError?.(error); } catch { /* reporting never throws into the loop */ } }
        finish(false); return;
      }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, delay);
  };
  timer = setTimeout(() => { void tick(); }, 0);
  return { done, stop() { finish(false); }, stats };
}
