// SPDX-License-Identifier: AGPL-3.0-or-later
// Projects the rows the Inbox fill's slice budget could not admit.
//
// SQLite reads a column whole, so a row of several MiB cannot be projected on
// the server's main thread without holding it for the time of the read. The
// fill (server/inbox.ts) therefore never touches such a row: it writes its
// rowid to inbox_fill_deferred and moves on. This file drains that table on
// its own connection (messages.db is WAL: its reads never block the writer).
//
// For each deferred row the projection is COMPUTED OUTSIDE ANY WRITE LOCK into
// two connection-private temp tables (a temp write takes no lock on messages.db;
// the 128 MiB read and every json_extract happen here). Only then is the writer
// lock taken, and inside it nothing is parsed: a guard of header-only checks
// (the deferred entry is still there, the row has the same identity and the same
// octet_length) and an insert of the one or two staged rows. Any write to the
// row since the staging deleted its deferred entry (the triggers), so a stale
// stage fails the guard and is dropped. A row that is gone just drops its entry.
// The lock is taken without waiting (busy_timeout 0): a busy writer makes the
// step throw, and the caller retries LATER with the staging kept, so the main
// thread never waits on this file and the work is never done twice.
//
// Only node built-ins are imported, so it runs as a worker entry (bundled on
// its own, scripts/bundle-server.mjs) and inline from inbox.ts alike.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

/** The statements built by inbox.ts from the projection's own SQL. */
export interface InboxDeferredSql {
  /** Creates the two temp staging tables (no lock on the database file). */
  setup: string;
  /** Empties the staging tables. */
  clear: string[];
  /** (rowid): project that row into the staging tables. Parses its json. Run outside the lock. */
  stageRaw: string; stageMarks: string;
  /** (): move the staged rows into the projection. No parsing. Run inside the lock. */
  applyRaw: string; applyMarks: string;
  /** (rowid, thread_id, id, octet_length): a row when the staging still describes the row. Header-only. */
  guard: string;
}

/** A row whose write transaction held the lock longer than this is reported (the parent logs `[inbox] fill slow-row`). */
export const INBOX_FILL_MAX_HOLD_MS = 100;
/** One report per this long at most (the others are counted into it). */
export const INBOX_SLOW_ROW_REPORT_MS = 10_000;
export interface InboxSlowRow { ms: number; size: number; more: number }

export interface InboxDeferredDrain {
  /** Projects the next deferred row into the staging tables, outside the lock. False when there is none. Idempotent while that row stays the next. */
  stage(): boolean;
  /** Stages when needed, then applies under the writer lock. False when the table is empty. Throws SQLITE_BUSY with the staging kept. */
  step(): boolean;
}

export function inboxDeferredDrain(db: DatabaseSync, sql: InboxDeferredSql, options: { priorityOnly?: boolean; maxHoldMs?: number; onSlowRow?: (row: InboxSlowRow) => void; now?: () => number } = {}): InboxDeferredDrain {
  const maxHold = options.maxHoldMs ?? INBOX_FILL_MAX_HOLD_MS, now = options.now ?? (() => performance.now());
  let lastReport = -Infinity, folded = 0, foldedMax: InboxSlowRow | null = null;
  // Each step is one deferred row's write (one or two staged rows applied under the lock): how long it held the lock is measured and a row
  // over maxHold is reported (rate limited), so a slow store shows its per-row hold on the log (STALLS-FINAL-DESIGN 3.2).
  const noteHold = (ms: number, size: number) => {
    if (ms <= maxHold || !options.onSlowRow) return;
    const at = now();
    if (at - lastReport < INBOX_SLOW_ROW_REPORT_MS) { folded++; if (!foldedMax || ms > foldedMax.ms) foldedMax = { ms, size, more: 0 }; return; }
    const worst = foldedMax && foldedMax.ms > ms ? foldedMax : { ms, size, more: 0 };
    lastReport = at;
    try { options.onSlowRow({ ms: Math.round(worst.ms), size: worst.size, more: folded }); } catch { /* a report never stops the drain */ }
    folded = 0; foldedMax = null;
  };
  db.exec(sql.setup);
  // Rows of a thread whose own completion is awaited ('t:<thread>' not done) come first.
  const priority = db.prepare("SELECT d.source_row FROM inbox_fill_deferred d WHERE EXISTS (SELECT 1 FROM inbox_projection_state s WHERE s.name='t:'||d.thread_id AND s.done=0) ORDER BY d.source_row LIMIT 1");
  const lowest = db.prepare("SELECT source_row FROM inbox_fill_deferred ORDER BY source_row LIMIT 1");
  const identity = db.prepare("SELECT thread_id, id, octet_length(json) AS n FROM messages WHERE rowid=?");
  const clear = sql.clear.map(text => db.prepare(text));
  const stageRaw = db.prepare(sql.stageRaw), stageMarks = db.prepare(sql.stageMarks);
  const applyRaw = db.prepare(sql.applyRaw), applyMarks = db.prepare(sql.applyMarks);
  const guard = db.prepare(sql.guard);
  const drop = db.prepare("DELETE FROM inbox_fill_deferred WHERE source_row=?");
  let staged: { row: number; thread: string; id: string; size: number } | { row: number; thread?: undefined } | null = null;
  const head = (): number | undefined => {
    const first = priority.get() as { source_row: number } | undefined;
    if (first) return first.source_row;
    if (options.priorityOnly) return undefined;
    return (lowest.get() as { source_row: number } | undefined)?.source_row;
  };
  const stage = (): number | undefined => {
    const row = head();
    if (row === undefined) return undefined;
    if (staged?.row === row) return row;
    for (const statement of clear) statement.run();
    const found = identity.get(row) as { thread_id: string; id: string; n: number } | undefined;
    if (found) { stageRaw.run(row); stageMarks.run(row); staged = { row, thread: found.thread_id, id: found.id, size: found.n }; }
    else staged = { row };
    return row;
  };
  return {
    stage() { return stage() !== undefined; },
    step() {
      const row = stage();
      if (row === undefined || !staged) return false;
      const mine = staged;
      db.exec("BEGIN IMMEDIATE");
      const held = performance.now();
      try {
        if (mine.thread !== undefined && guard.get(row, mine.thread, mine.id, mine.size) !== undefined) { applyRaw.run(); applyMarks.run(); }
        drop.run(row);
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
      noteHold(performance.now() - held, mine.thread !== undefined ? mine.size : 0);
      staged = null;
      return true;
    },
  };
}

const BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i;
const RETRY_MS = 250;

if (parentPort && (workerData as { kind?: string } | null)?.kind === "inbox-fill") {
  const port = parentPort;
  const { file, sql, priorityOnly, maxHoldMs } = workerData as { file: string; sql: InboxDeferredSql; priorityOnly?: boolean; maxHoldMs?: number };
  try {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=0; PRAGMA secure_delete=ON;");
    const drain = inboxDeferredDrain(db, sql, { priorityOnly, ...(maxHoldMs !== undefined ? { maxHoldMs } : {}), onSlowRow: row => port.postMessage({ type: "slow-row", ...row }) });
    for (;;) {
      try { if (!drain.step()) break; }
      catch (error) {
        if (!BUSY.test(error instanceof Error ? error.message : String(error))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS); // the writer is busy: try the same row again
      }
    }
    db.close();
    port.postMessage({ type: "drained" });
  } catch (error) {
    port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
