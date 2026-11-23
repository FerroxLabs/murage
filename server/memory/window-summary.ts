// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory V2 lane C, V5 item 2 (MEMORY-V2-DESIGN 4.3): the strict summary of the pending windows on one key, for READERS only.
//
// "More than 256 rows: today the reader holds everything. V2 keeps that answer unless a summary exists for the key: one row in a TEMP
// table (count, lowest since, highest finite cap, count of uncapped rows) maintained row by row by TEMP triggers. [...] No reader ever
// runs an aggregate over the queue."
//
// What a reader gets from here is one primary-key seek on the TEMP table, or null ("hold everything", today's answer). null whenever the
// summary is not proven to cover every row of the key: no row yet, a build in progress, a job row deleted or its state or started_lsn
// changed since the build, a commit by another connection since the build began (its rows fired no trigger here), no TEMP objects on
// this handle. "Since the build" is judged at the seek itself: the seek statement reads data_version together with the row (as
// main.pragma_data_version, and refused while main holds a table or view of that name, which that name would read instead), so
// the version compared is never older than the pending rows this lookup read on that key (a version sampled earlier in the lookup, the
// memo's, is not proof: another connection can commit a hold after it). Each key proves itself; two keys of one lookup are read by
// separate statements, as the exact read's are. The first null queues a paged build as closing work (revoke-wake.ts raise/onWake): never on the reader's call.
//
// Why it is at least as strict as the exact rows (deny-read.ts pendingWindows). The one window it answers is [low, cap), or [low, no
// cap) when any row counted uncapped. Every row's own window lies inside it: low is at most the row's since (min over the build's pages
// and every later insert; a delete never raises it), cap is at least the row's cap (max, never lowered), and a row counts uncapped by
// the exact read's own rule at the time it is counted (CAPPED below). A row's cap can only change through its job row, and any DELETE
// of a job, any UPDATE of state, started_lsn or revoke_id, and an INSERT of a job that pending rows already name, drops every summary.
// The count is never under the true count (a delete during a build is not subtracted, an insert during a build may be counted twice).
// Audience-only rows are counted for every reader (the content reader's exact read skips them): stricter, never weaker.
// Everything is TEMP, so a ROLLBACK or ROLLBACK TO restores the summary with the rows it summarises, the build cursor included.
// No persisted object, no DELETE of a pending row, no job row written.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { memoDataVersion, onWake, raise } from "./revoke-wake.ts";

export type PendingTable = "memory_deny_pending" | "memory_deny_pending_scope";
const TABLES: ReadonlyArray<[PendingTable, string]> = [["memory_deny_pending", "thread_id"], ["memory_deny_pending_scope", "scope_id"]];
/** A summary exists only for a key past this many rows (deny-read.ts PENDING_READ_LIMIT); at or under it the exact read answers. */
export const SUMMARY_FLOOR = 256;
/** Rows one build page reads (one index range, one primary-key seek each). */
export const SUMMARY_PAGE = 128;
/** Keys queued for a build on one handle; past it a new key keeps today's answer. */
const QUEUE_CAP = 64;
/** A build that is restarted this often by job changes is dropped; the next overflow read queues it again. */
const RESTART_CAP = 4;
const TOPIC = "window-summary";

/** Test-only seams, the mutants of memv2-c-windows-1021.test.ts. Read when the TEMP objects are installed on a handle. Never set in product code. */
export const windowSummaryTestHooks = { seedingOnlyUncapped: false, deleteLowersBounds: false, noJobUpdateReset: false, trustMemoVersion: false, ignoreForeignCommit: false, unqualifiedDataVersion: false, ignoreMissingTriggers: false, ignoreMainShadow: false };
/** The started_lsn of the row's job when the row is CAPPED, by the exact read's rule (deny-read.ts pendingWindows:
 * `cap === null || row.st === "seeding" || since > cap ? Infinity : cap`), else no row: job missing, job seeding, or since past the cap. */
const capOf = (since: string, revoke: string): string =>
  `SELECT j.started_lsn FROM main.memory_revoke_jobs j WHERE j.revoke_id=${revoke} AND j.state IS NOT 'seeding'${windowSummaryTestHooks.seedingOnlyUncapped ? "" : ` AND ${since}<=j.started_lsn`}`;

interface Installed { seek: StatementSync; triggers: number; first: Record<PendingTable, StatementSync>; next: Record<PendingTable, StatementSync>; open: StatementSync; drop: StatementSync; page: StatementSync; dataVersion: StatementSync }
const installed = new WeakMap<DatabaseSync, Installed | "failed">();
interface Queued { table: PendingTable; key: string; restarts: number }
const queue = new Map<DatabaseSync, Map<string, Queued>>();
const stats = { seeks: 0, pages: 0, pageRows: 0, built: 0, queued: 0, installs: 0 };
/** Counters for the witnesses: `seeks` is the one TEMP seek an overflowing key costs a reader; pages run only from the wake. */
export function windowSummaryStats(): Readonly<typeof stats> { return { ...stats }; }
export function resetWindowSummaryStats(): void { for (const key of Object.keys(stats) as Array<keyof typeof stats>) stats[key] = 0; }

function install(db: DatabaseSync): Installed | "failed" | null {
  if ((db as { isTransaction?: boolean }).isTransaction !== false) return null; // TEMP DDL inside a transaction would vanish with its rollback
  try {
    if (Number((db.prepare("PRAGMA query_only").get() as { query_only?: unknown } | undefined)?.query_only ?? 1) !== 0) return "failed";
    const hooks = windowSummaryTestHooks;
    const sql: string[] = [`CREATE TEMP TABLE IF NOT EXISTS mem_c_window_summary(tbl INTEGER NOT NULL, key TEXT NOT NULL, state INTEGER NOT NULL, dv INTEGER NOT NULL,
      n INTEGER NOT NULL, low INTEGER NOT NULL, cap INTEGER NOT NULL, uncapped INTEGER NOT NULL, cs INTEGER, cr INTEGER, PRIMARY KEY(tbl,key)) WITHOUT ROWID;`];
    TABLES.forEach(([table, column], tbl) => {
      const cap = capOf("NEW.since_lsn", "NEW.revoke_id");
      sql.push(`CREATE TEMP TRIGGER mem_c_ws_${tbl}_i AFTER INSERT ON main.${table} BEGIN
          UPDATE mem_c_window_summary SET n=n+1, low=min(low,NEW.since_lsn), cap=max(cap,coalesce((${cap}),cap)), uncapped=uncapped+(NOT EXISTS(${cap}))
            WHERE tbl=${tbl} AND key=NEW.${column}; END;`);
      // a delete lowers the row count only (and only of a finished build): never the uncapped count, never either bound
      sql.push(`CREATE TEMP TRIGGER mem_c_ws_${tbl}_d AFTER DELETE ON main.${table} BEGIN
          UPDATE mem_c_window_summary SET n=n-1${hooks.deleteLowersBounds ? ", uncapped=max(uncapped-1,0), low=CASE WHEN low=OLD.since_lsn THEN low+1 ELSE low END" : ""}
            WHERE tbl=${tbl} AND key=OLD.${column} AND state=1;
          DELETE FROM mem_c_window_summary WHERE tbl=${tbl} AND key=OLD.${column} AND state=1 AND n<=${SUMMARY_FLOOR}; END;`);
      sql.push(`CREATE TEMP TRIGGER mem_c_ws_${tbl}_u AFTER UPDATE ON main.${table} BEGIN DELETE FROM mem_c_window_summary WHERE tbl=${tbl}; END;`);
    });
    sql.push(`CREATE TEMP TRIGGER mem_c_ws_job_d AFTER DELETE ON main.memory_revoke_jobs BEGIN DELETE FROM mem_c_window_summary; END;`);
    if (!hooks.noJobUpdateReset) sql.push(`CREATE TEMP TRIGGER mem_c_ws_job_u AFTER UPDATE OF state,started_lsn,revoke_id ON main.memory_revoke_jobs BEGIN DELETE FROM mem_c_window_summary; END;`);
    // a job row written over (INSERT OR REPLACE fires no delete trigger) or written after its pending rows: the rows' caps may have moved
    sql.push(`CREATE TEMP TRIGGER mem_c_ws_job_i AFTER INSERT ON main.memory_revoke_jobs
        WHEN EXISTS(SELECT 1 FROM main.memory_deny_pending WHERE revoke_id=NEW.revoke_id) OR EXISTS(SELECT 1 FROM main.memory_deny_pending_scope WHERE revoke_id=NEW.revoke_id)
        BEGIN DELETE FROM mem_c_window_summary; END;`);
    // DROP then CREATE (never IF NOT EXISTS): a trigger of the same name made by anyone else is replaced, so what is pinned below is ours.
    // The summaries are cleared too: one written while a trigger was missing may not count every row.
    const made = sql.slice(1).map(text => /^CREATE TEMP TRIGGER (\w+)/.exec(text)![1]!);
    db.exec([sql[0]!, "DELETE FROM temp.mem_c_window_summary;", ...made.map(name => `DROP TRIGGER IF EXISTS temp.${name};`), ...sql.slice(1)].join("\n"));
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const pinned = db.prepare(`SELECT name, sql FROM temp.sqlite_master WHERE type='trigger' AND name IN (${made.map(quote).join(",")})`).all() as Array<{ name: string; sql: string }>;
    if (pinned.length !== made.length) return "failed";
    const pageSql = (table: PendingTable, column: string, after: boolean): string =>
      `SELECT p.since_lsn AS s,p.revoke_id AS r,(${capOf("p.since_lsn", "p.revoke_id")}) AS c FROM main.${table} p
         WHERE p.${column}=?${after ? " AND (p.since_lsn,p.revoke_id)>(?,?)" : ""} ORDER BY p.since_lsn,p.revoke_id LIMIT ${SUMMARY_PAGE}`;
    const each = (after: boolean) => Object.fromEntries(TABLES.map(([table, column]) => [table, db.prepare(pageSql(table, column, after))])) as Record<PendingTable, StatementSync>;
    stats.installs++;
    return {
      // `now`: data_version as this statement sees it. Outside a transaction that is the committed state at the seek; inside one it is
      // the transaction's snapshot, the same one its pending-row reads came from. main.pragma_data_version: schema-qualified, so a TEMP
      // table or view named pragma_data_version cannot answer the build's version forever; `shadowed`: a table or view of that name in
      // main (which main.pragma_data_version would read instead), checked in the same statement. `armed`: how many of the triggers that
      // keep the row exact are still the ones installed (exact name and stored text); fewer, and this handle's own writes may be uncounted.
      seek: db.prepare(`SELECT state,dv,n,low,cap,uncapped,cs,cr,(SELECT data_version FROM ${hooks.unqualifiedDataVersion ? "" : "main."}pragma_data_version) AS now,
        EXISTS(SELECT 1 FROM main.sqlite_master WHERE type IN ('table','view') AND lower(name)='pragma_data_version') AS shadowed,
        (SELECT count(*) FROM temp.sqlite_master WHERE type='trigger' AND (name, sql) IN (VALUES ${pinned.map(t => `(${quote(t.name)},${quote(t.sql)})`).join(",")})) AS armed
        FROM temp.mem_c_window_summary WHERE tbl=? AND key=?`),
      triggers: pinned.length,
      first: each(false), next: each(true),
      open: db.prepare(`INSERT INTO temp.mem_c_window_summary(tbl,key,state,dv,n,low,cap,uncapped,cs,cr) VALUES(?,?,0,?,0,${Number.MAX_SAFE_INTEGER},-1,0,NULL,NULL)`),
      drop: db.prepare("DELETE FROM temp.mem_c_window_summary WHERE tbl=? AND key=?"),
      page: db.prepare("UPDATE temp.mem_c_window_summary SET n=n+?,low=min(low,?),cap=max(cap,?),uncapped=uncapped+?,cs=?,cr=?,state=? WHERE tbl=? AND key=? AND state=0"),
      dataVersion: db.prepare("PRAGMA data_version"),
    };
  } catch { return "failed"; }
}
function handle(db: DatabaseSync): Installed | null {
  let held = installed.get(db);
  if (held === undefined) { const made = install(db); if (made === null) return null; installed.set(db, held = made); }
  return held === "failed" ? null : held;
}
/** Install this handle's summary objects now, ahead of the "windows" memo version read (deny-read.ts windowsMemo). Their TEMP DDL moves
 * PRAGMA temp.schema_version, which is part of that version (revoke-wake.ts memoVersion): installed lazily at a key's first overflow, it
 * dropped the memo in the middle of a reader's lookup, so the first turn to meet a backlog past PENDING_READ_LIMIT re-read every key it
 * had already read (more statements with 1000 jobs than with 10). Once per handle; no statement after that; inside a transaction it
 * waits for the next call outside one, as summaryWindow does. A query_only handle installs nothing. */
export function prepareWindowSummary(db: DatabaseSync): void {
  try { handle(db); } catch { /* summaryWindow fails closed on its own */ }
}
const tblOf = (table: PendingTable): number => (table === "memory_deny_pending" ? 0 : 1);

/** The one window that covers every pending row of an overflowing key, or null: hold everything (today's answer), and a build is queued.
 * One primary-key seek on a TEMP table, which reads data_version in the same statement: a commit by another connection at any point
 * before the seek (before or after the caller's pending-row read) is a mismatch, and a mismatch is null. `cap` Infinity: at least one
 * row has no cap. Call only for a key the exact read found past SUMMARY_FLOOR rows, on a handle whose "windows" memo is installed. */
export function summaryWindow(db: DatabaseSync, table: PendingTable, key: string): { since: number; cap: number } | null {
  try {
    const held = handle(db), sampled = memoDataVersion("windows", db);
    if (!held || sampled === null) return null;
    stats.seeks++;
    const row = held.seek.get(tblOf(table), key) as Record<string, unknown> | undefined;
    // a trigger of the summary is gone or rewritten: no summary on this handle until it installs again (outside a transaction)
    if (row && Number(row.armed) !== held.triggers && !windowSummaryTestHooks.ignoreMissingTriggers) { installed.delete(db); return null; }
    // a table or view in main named pragma_data_version: `now` may be its constant, not the version. Hold everything.
    if (row && Number(row.shadowed) !== 0 && !windowSummaryTestHooks.ignoreMainShadow) return null;
    const now = windowSummaryTestHooks.trustMemoVersion ? sampled : typeof row?.now === "number" ? row.now : NaN;
    const unseen = !Number.isSafeInteger(now) || Number(row?.dv) !== now;   // another connection committed since the build, or unknown
    if (!row || Number(row.state) !== 1 || (unseen && !windowSummaryTestHooks.ignoreForeignCommit) || !(Number(row.n) > SUMMARY_FLOOR)) { enqueue(db, table, key); return null; }
    const since = Number(row.low), cap = Number(row.cap), uncapped = Number(row.uncapped);
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(cap) || !Number.isSafeInteger(uncapped)) return null;
    return { since, cap: uncapped > 0 || cap < 0 ? Infinity : cap };
  } catch { return null; }
}
function enqueue(db: DatabaseSync, table: PendingTable, key: string): void {
  let keys = queue.get(db);
  if (!keys) queue.set(db, keys = new Map());
  const id = `${tblOf(table)}\u0000${key}`;
  if (keys.has(id) || keys.size >= QUEUE_CAP) return;
  keys.set(id, { table, key, restarts: 0 });
  stats.queued++;
  raise(TOPIC);
}
/** One page of one queued build. Answers whether anything is still queued on this handle. */
function buildPage(db: DatabaseSync): boolean {
  const keys = queue.get(db);
  const entry = keys?.entries().next().value as [string, Queued] | undefined;
  if (!keys || !entry) { queue.delete(db); return false; }
  const [id, job] = entry;
  const done = (): boolean => { keys.delete(id); if (!keys.size) queue.delete(db); return keys.size > 0; };
  try {
    const held = handle(db);
    if (!held) return done();
    const tbl = tblOf(job.table);
    const dv = Number((held.dataVersion.get() as { data_version?: unknown } | undefined)?.data_version);
    let row = held.seek.get(tbl, job.key) as Record<string, unknown> | undefined;
    if (row && Number(row.dv) !== dv) { held.drop.run(tbl, job.key); row = undefined; }   // another connection committed: its rows fired no trigger here
    if (row && Number(row.state) === 1) return done();
    if (!row) {
      if (job.restarts++ >= RESTART_CAP) return done();
      held.open.run(tbl, job.key, dv);
      row = { cs: null, cr: null };
    }
    const rows = (row.cs === null || row.cs === undefined ? held.first[job.table].all(job.key) : held.next[job.table].all(job.key, Number(row.cs), Number(row.cr))) as Array<Record<string, unknown>>;
    stats.pages++; stats.pageRows += rows.length;
    let low = Number.MAX_SAFE_INTEGER, cap = -1, uncapped = 0;
    for (const each of rows) {
      low = Math.min(low, Number(each.s));
      if (each.c === null || each.c === undefined) uncapped++; else cap = Math.max(cap, Number(each.c));
    }
    const last = rows[rows.length - 1], finished = rows.length < SUMMARY_PAGE;
    held.page.run(rows.length, low, cap, uncapped, last ? Number(last.s) : row.cs === undefined ? null : (row.cs as number | null), last ? Number(last.r) : row.cr === undefined ? null : (row.cr as number | null), finished ? 1 : 0, tbl, job.key);
    if (finished) { stats.built++; return done(); }
    return true;
  } catch { return done(); }
}
onWake(TOPIC, () => {
  const db = queue.keys().next().value as DatabaseSync | undefined;
  if (!db) return;
  buildPage(db);
  if (queue.size) raise(TOPIC);
}, { priority: 2, name: "window-summary-build" });

/** Run every queued build of this handle now (tests, and a caller that already holds closing work's slice). Bounded by the queue. */
export function buildWindowSummariesNow(db: DatabaseSync, maxPages = 100_000): number {
  let pages = 0;
  while (pages < maxPages && queue.has(db)) { buildPage(db); pages++; }
  return pages;
}
