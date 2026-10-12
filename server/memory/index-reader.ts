// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall reads the word index straight from the main process (PROPOSAL-v2 10.2,
// AUDIT M7). Until now every search went through the helper's one queue, behind
// whatever capture or index batch it was running, and missed its 500 ms budget
// whenever a backlog was draining (5 of 8 searches in the evidence run).
//
// One persistent read-only handle to memory-index.db. MATCH first, ordered by rank
// and cut to a page, restricted to the caller's scopes through the entries table
// (a primary-key probe per ranked hit, so the cursor still stops at the limit). The
// caller then checks each hit against the authoritative tables: current state, access
// scope, identity, audience and withheld sources, exactly as before. The reader never
// writes, never holds a read transaction between calls (statements run to completion),
// and gives up after a short busy wait instead of holding the thread.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { walBytes, WAL_DRAIN_BYTES, type IndexHit } from "./index.ts";
import { logSwallowed } from "./worker-log.ts";
import { before, pageByRank } from "./rank-ties.ts";
import { CURRENT_MEMORY, HISTORICAL_MEMORY, REACHABLE_RECORD } from "./eligibility.ts";

/** Most words of a query that take part in the MATCH. */
export const RECALL_TERM_LIMIT = 8;
/** First page of ranked hits, and the most one search reads in all. */
export const RECALL_FIRST_PAGE = 50;
export const RECALL_MAX_HITS = 200;
const BUSY_MS = 50;

/** `partial`: the scan reached its deadline (or was told to stop) before it had read every match, so the page is the best of what
 * was read and nothing is said about what lies past it. */
export type LexicalPage = { hits: IndexHit[]; more: boolean; partial?: true };
export type IndexReaderState = "ready" | "missing" | "unreadable" | "blocked";

interface Open { path: string; ino: number; dev: number; authIno: number; eligible: boolean; db: DatabaseSync; statement: StatementSync }
let open: Open | null = null;
/** Moves on every close: a scan that started under an older epoch stops (its file may be gone or replaced). */
let epoch = 0;
let blocked = false;
let lastState: IndexReaderState = "missing";

export const RECALL_SEARCH_SQL = `SELECT l.id AS id,l.version AS version,l.rank AS rank FROM lexical l JOIN entries e ON e.id=l.id AND e.version=CAST(l.version AS INTEGER)
  WHERE l.lexical MATCH ?1 AND e.scope_id IN (SELECT value FROM json_each(?2)) ORDER BY l.rank LIMIT ?3 OFFSET ?4`;

function indexPath() { return join(DATA_DIR, "memory-index.db"); }
/** The authoritative record tables live in the main database. The reader attaches it read-only as `authority`, so the index query
 * can leave out, before ranking and before any limit, the records NO reader may read (not active, forgotten, resting on nothing,
 * evidence withdrawn) and the records outside the reader's scopes. Nothing is copied into the index, so there is no flag that can
 * go stale and nothing to backfill: the answer is the authoritative tables' own, as of the scan's snapshot. */
function authorityPath() { return join(DATA_DIR, "messages.db"); }
function authorityIno(): number { try { return statSync(authorityPath()).ino; } catch { return -1; } }
/** True when the main database is attached and holds the record tables. Anything else leaves the query on the scope filter alone
 * and the final authorization (search.ts) unchanged: fewer records are spared, none are added. */
function attachAuthority(db: DatabaseSync): boolean {
  try {
    db.prepare("ATTACH DATABASE ? AS authority").run(authorityPath());
    db.prepare("SELECT 1 FROM authority.memory_records LIMIT 1").get();
    return true;
  } catch { try { db.exec("DETACH DATABASE authority"); } catch { /* never attached */ } return false; }
}

export function memoryIndexTerms(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, RECALL_TERM_LIMIT);
}

/** While the helper is starting (it may rebuild or rename a damaged index) the main process holds no handle. */
export function blockMemoryIndexReader(): void { blocked = true; closeMemoryIndexReader(); }
export function unblockMemoryIndexReader(): void { blocked = false; }
export function closeMemoryIndexReader(): void {
  window_ = null; slicedWindow = null; epoch++;
  const current = open; open = null;
  try { current?.db.close(); } catch { /* idempotent */ }
  for (const scan of scanPool.splice(0)) try { scan.db.close(); } catch { /* idempotent */ }
}
export function memoryIndexReaderState(): IndexReaderState { return lastState; }

function handle(): Open | null {
  if (blocked) { lastState = "blocked"; return null; }
  const path = indexPath();
  let stat;
  try { stat = statSync(path); } catch { closeMemoryIndexReader(); lastState = "missing"; logSwallowed("recall", "MEMORY_INDEX_MISSING"); return null; }
  if (open && open.path === path && open.ino === stat.ino && open.dev === stat.dev) {
    // the main database may have been created (or replaced) since this handle opened: attach it again when it was not attached
    if (!open.eligible || open.authIno !== authorityIno()) {
      if (open.eligible) { try { open.db.exec("DETACH DATABASE authority"); } catch { /* already gone */ } open.eligible = false; }
      open.authIno = authorityIno();
      open.eligible = open.authIno >= 0 && attachAuthority(open.db);
    }
    return open;
  }
  closeMemoryIndexReader();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    // A file the helper has not finished creating has no word table yet.
    db.prepare("SELECT 1 FROM entries LIMIT 1").get();
    const authIno = authorityIno();
    open = { path, ino: stat.ino, dev: stat.dev, authIno, eligible: authIno >= 0 && attachAuthority(db), db, statement: db.prepare(RECALL_SEARCH_SQL) };
    lastState = "ready";
    return open;
  } catch (error) {
    // Opened but not usable: close it now, or the file stays locked (Windows cannot delete or replace it).
    try { db?.close(); } catch { /* already closed */ }
    lastState = existsSync(path) ? "unreadable" : "missing";
    logSwallowed("recall", error);
    return null;
  }
}

/** One read of the ranked rows is kept for the next page of the same search: paging re-ranks every match each time, and a run of
 * equal ranks is settled over a window of rows (rank-ties.ts), so a search that pages would otherwise pay for several rankings.
 * The window is valid only for the same query and scopes, the same file, an unchanged index (PRAGMA data_version moves when
 * the helper commits) and a short time. */
const WINDOW_ROWS = 512;
const WINDOW_TTL_MS = 2000;
let window_: { key: string; ino: number; version: number; at: number; start: number; rows: Array<Record<string, unknown>>; end: boolean } | null = null;
function rankedRows(current: Open, expression: string, scopes: string, start: number, count: number): Array<Record<string, unknown>> {
  const version = Number(current.db.prepare("PRAGMA data_version").get()?.data_version ?? -1), key = `${expression}\u0000${scopes}`, now = performance.now();
  const w = window_;
  if (w && w.key === key && w.ino === current.ino && w.version === version && now - w.at < WINDOW_TTL_MS && start >= w.start && (w.end || start + count <= w.start + w.rows.length)) {
    return w.rows.slice(start - w.start, start - w.start + count);
  }
  // A read wider than the window (a long run of equal ranks being completed) is kept with room to spare, so the pages that follow
  // inside the same run are served from it instead of ranking every match again.
  const wanted = count > WINDOW_ROWS ? count * 2 : WINDOW_ROWS;
  const rows = current.statement.all(expression, scopes, wanted, start);
  window_ = { key, ino: current.ino, version, at: now, start, rows, end: rows.length < wanted };
  return rows.slice(0, count);
}

/** Of these record versions, the ones with no vector under `model` in the index, or null when the index cannot be read. The
 * unscored records of a search are exactly these among the eligible ones (the helper's own definition: no vector row). */
export function vectorlessAmong(refs: ReadonlyArray<{ id: string; version: number }>, model: string): Array<{ id: string; version: number }> | null {
  if (!refs.length) return [];
  const current = handle();
  if (!current) return null;
  try {
    const rows = current.db.prepare(`SELECT json_extract(j.value,'$[0]') AS id,json_extract(j.value,'$[1]') AS version FROM json_each(?1) j
      WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.id=json_extract(j.value,'$[0]') AND v.version=json_extract(j.value,'$[1]') AND v.model=?2)`)
      .all(JSON.stringify(refs.map(ref => [ref.id, ref.version])), model);
    return rows.map(row => ({ id: String(row.id), version: Number(row.version) }));
  } catch (error) { logSwallowed("recall", error); return null; }
}

/** Ranked word hits for the scopes, or null when the index cannot be read (the caller falls back to the helper). */
export function lexicalPage(query: string, scopeIds: readonly string[], limit: number, offset = 0): LexicalPage | null {
  const terms = memoryIndexTerms(query);
  if (!terms.length) return { hits: [], more: false };
  const current = handle();
  if (!current) return null;
  const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  try {
    // Equal ranks are settled after the query (rank-ties.ts): the page is positions [offset, offset + limit) of the order
    // (rank, id, version), the same rows whichever way the index happened to hold equal ranks and however long a run is.
    const scopes = JSON.stringify(scopeIds);
    const { rows, more } = pageByRank((start, count) => rankedRows(current, expression, scopes, start, count), offset, limit);
    const hits = rows.map((row, index) => ({ id: String(row.id), version: Number(row.version), score: 1 / (60 + offset + index + 1), lexical: true as const }));
    return { hits, more };
  } catch (error) {
    // A damaged or half-built index: drop the handle so the next call reopens, and let the helper path answer.
    closeMemoryIndexReader();
    lastState = "unreadable";
    logSwallowed("recall", error);
    return null;
  }
}


/** The word list of a search, read in index order a chunk of matches at a time, never as one ranking: FTS5 computes a score for every
 * match before the first row of `ORDER BY rank` can be returned, and node:sqlite runs a statement to completion on the calling
 * thread, so a query with 100,000 matches held the event loop for hundreds of milliseconds (msearch review round 5). The matches
 * are stepped one by one (a step is about a microsecond), and the loop is released between chunks. (Slicing by rowid range read
 * the same matches in 11 s instead of 0.15 s: every range re-seeks the term lists.)
 *
 * Which of the matches count is decided one chunk at a time by ONE statement over that chunk. Two forms. The scope form keeps
 * the records of the reader's scopes. The eligible form (msearch review round 6) reads the authoritative record table and keeps
 * only the records a reader of these scopes can possibly read: the version is in the mode's state, nobody forgot it, it rests on
 * evidence or is an owner statement, its evidence is still current. A population the reader cannot read is therefore never
 * ranked, never counted against a limit and never decides coverage, however large it is. What depends on the reader itself
 * (ancestry, withheld lines, identity, human principals) is still decided by readableMemoryRecord afterwards, so the final
 * authorization is exactly as strict as it was. */
const SCAN_MATCHES_SQL = "SELECT l.rowid AS rowid,l.id AS id,l.version AS version,l.rank AS rank FROM lexical l WHERE l.lexical MATCH ?1";
const SCAN_SCOPE_SQL = `SELECT j.key AS k FROM json_each(?1) j JOIN entries e ON e.id=json_extract(j.value,'$[0]') AND e.version=json_extract(j.value,'$[1]')
  WHERE e.scope_id IN (SELECT value FROM json_each(?2))`;
/** The evidence a record rests on is still there: its source version exists, and no source or source version was forgotten (the
 * same cheap refusals as plausiblyReadable in readable.ts, which are the same for every reader). */
const evidenceStanding = (historical: boolean) => `NOT EXISTS (SELECT 1 FROM memory_evidence ex LEFT JOIN memory_sources sx ON sx.id=ex.source_id
  LEFT JOIN memory_source_versions vx ON vx.source_id=ex.source_id AND vx.revision=ex.source_revision
  WHERE ex.record_id=r.id AND ex.record_version=r.version AND (sx.id IS NULL OR vx.source_id IS NULL OR ${historical ? "sx.state='deleted'" : "(sx.state!='active' OR sx.revision!=ex.source_revision)"}
    OR EXISTS (SELECT 1 FROM memory_tombstones st WHERE st.target_type='source' AND st.target_id=sx.id AND (st.revision IS NULL OR st.revision=vx.revision))))`;
/** A record derived directly from a record that was forgotten, deleted or is gone is refused to every reader (derivationAncestryCurrent
 * in replay-lineage.ts: the same edge test, including the one exception, an owner's correction of the record it replaces). Deeper
 * ancestry needs the walk, and stays with the record-by-record read. */
const DIRECT_ANCESTRY = `NOT EXISTS (SELECT 1 FROM memory_derivations d LEFT JOIN memory_records pr ON pr.id=d.parent_id AND pr.version=d.parent_version
  WHERE d.child_id=r.id AND d.child_version=r.version AND NOT (r.assertion='owner-statement' AND COALESCE(r.supersedes_id,'')=d.parent_id)
    AND (pr.id IS NULL OR pr.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones pt WHERE pt.target_type='record' AND pt.target_id=d.parent_id AND (pt.revision IS NULL OR pt.revision=d.parent_version))))`;
const scanEligibleSql = (historical: boolean) => `SELECT j.key AS k FROM json_each(?1) j CROSS JOIN authority.memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
  WHERE r.scope_id IN (SELECT value FROM json_each(?2)) AND ${historical ? HISTORICAL_MEMORY : CURRENT_MEMORY} AND ${REACHABLE_RECORD} AND ${evidenceStanding(historical)} AND ${DIRECT_ANCESTRY}`;
/** Longest the loop is held for between two yields, and the chunk sizes the scan moves between to stay under it. */
const SLICE_BUDGET_MS = 6;
const CHUNK_MIN = 64;
const CHUNK_MAX = 8192;
const SLICED_WINDOW = 512;
const SLICED_WINDOW_MAX = 50_000;
let slicedWindow: { key: string; ino: number; version: string; at: number; rows: Array<Record<string, unknown>>; end: boolean } | null = null;

/** A scan reads on its own connection, so searches that overlap each hold their own snapshot. Idle ones wait here for the next. */
interface Scan { db: DatabaseSync; ino: number; dev: number; authIno: number; eligible: boolean; statements: Map<string, StatementSync>; epoch: number }
const scanPool: Scan[] = [];
const SCAN_POOL_MAX = 2;
function borrowScan(current: Open): Scan | null {
  const fits = (scan: Scan) => scan.ino === current.ino && scan.dev === current.dev && scan.authIno === current.authIno && scan.eligible === current.eligible && scan.epoch === epoch;
  for (const stale of scanPool.filter(scan => !fits(scan))) { scanPool.splice(scanPool.indexOf(stale), 1); try { stale.db.close(); } catch { /* idempotent */ } }
  const idle = scanPool.pop();
  if (idle) return idle;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(current.path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    return { db, ino: current.ino, dev: current.dev, authIno: current.authIno, eligible: current.eligible && attachAuthority(db), statements: new Map(), epoch };
  } catch (error) { try { db?.close(); } catch { /* already closed */ } logSwallowed("recall", error); return null; }
}
function returnScan(scan: Scan, healthy: boolean): void {
  if (healthy && scan.epoch === epoch && scanPool.length < SCAN_POOL_MAX) { scanPool.push(scan); return; }
  try { scan.db.close(); } catch { /* idempotent */ }
}

/** Admission of scan snapshots (msearch review rounds 7, 8 and 9). A scan holds a read snapshot of the index for as long as it
 * runs, and a checkpoint cannot truncate the write-ahead log past the oldest snapshot. Scans run concurrently as a rule (two
 * bots' searches never wait on each other). Only when the log is over the threshold is admission closed: new scans wait, the
 * scans already open drain (each ends by its own deadline, and no new one joins them, so the drain is bounded), and only then
 * does the reader send the single checkpoint request to the helper that owns the index writer (worker IPC). The
 * acknowledgement timeout starts when that request is sent, not before the drain. An acknowledgement, a timeout, or the
 * drain bound (DRAIN_MAX_MS) reopens admission; a miss is retried after CHECKPOINT_RETRY_MS and logged once. A closed-out scan
 * waits within its own remaining search budget and answers `partial` only when that budget is spent. */
export const SCAN_ADMIT_WAIT_MS = 500;
/** Longest the helper has to acknowledge a checkpoint request once it is sent. */
export const GATE_MAX_MS = 2000;
/** Longest admission stays closed while the already-open scans drain (they end by their own deadlines; this is the backstop). */
export const DRAIN_MAX_MS = 5000;
/** After an unacknowledged or blocked checkpoint, the next request waits this long. */
export const CHECKPOINT_RETRY_MS = 10_000;
let activeScans = 0;
let admissionClosed = false;
let gateTimer: ReturnType<typeof setTimeout> | null = null;
let checkpointing = false;
let retryAfter = 0;
let loggedGateTimeout = false;
let walThreshold = WAL_DRAIN_BYTES;
let requestCheckpoint: (() => boolean | Promise<boolean>) | null = null;
const admitQueue: Array<() => void> = [];
/** Asks the writer to truncate the log; resolves true when it did (the acknowledgement). In production this is a message to the
 * memory helper process (worker-controller.ts), which owns the index writer. */
export function setWalCheckpointRequester(fn: (() => boolean | Promise<boolean>) | null): void { requestCheckpoint = fn; }
/** Tests only. */
export function setWalDrainThreshold(bytes: number): void { walThreshold = bytes; }
/** Tests only: forget every gate and counter. */
export function resetScanAdmission(): void {
  activeScans = 0; admissionClosed = false; checkpointing = false; retryAfter = 0; loggedGateTimeout = false;
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = null;
  wakeAll();
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function wakeAll(): void { for (const wake of admitQueue.splice(0)) wake(); }
const gated = () => admissionClosed;
function liftGate(): void {
  admissionClosed = false;
  if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
  wakeAll();
}
/** A checkpoint that was not acknowledged in time, or a drain that did not finish: reopen admission and back off. */
function missedCheckpoint(): void {
  gateTimer = null;
  if (!loggedGateTimeout) { loggedGateTimeout = true; logSwallowed("recall", "MEMORY_INDEX_CHECKPOINT_UNACKNOWLEDGED"); }
  retryAfter = Date.now() + CHECKPOINT_RETRY_MS;
  liftGate();
}
/** Closes admission when the log is over the threshold and no request is pending or backing off. */
function gateIfWalLarge(path: string): void {
  if (gated() || checkpointing || !requestCheckpoint || Date.now() < retryAfter) return;
  let large = false;
  try { large = walBytes(path) > walThreshold; } catch { /* no log to measure */ }
  if (!large) return;
  admissionClosed = true;
  gateTimer = setTimeout(missedCheckpoint, DRAIN_MAX_MS);
  gateTimer.unref?.();
  sendCheckpointWhenIdle();
}
/** The request goes out once no scan snapshot is open (a request made earlier could not truncate past it); the
 * acknowledgement timeout starts here. */
function sendCheckpointWhenIdle(): void {
  if (!gated() || checkpointing || activeScans > 0 || !requestCheckpoint) return;
  checkpointing = true;
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = setTimeout(missedCheckpoint, GATE_MAX_MS);
  gateTimer.unref?.();
  void (async () => {
    let ok = false;
    try { ok = await requestCheckpoint!(); } catch (error) { logSwallowed("recall", error); }
    checkpointing = false;
    if (ok) { loggedGateTimeout = false; retryAfter = 0; } else retryAfter = Date.now() + CHECKPOINT_RETRY_MS;
    liftGate();
  })();
}
/** Admitted at once unless a checkpoint is pending. A gated scan waits for the gate within `deadlineAt` (its own search budget; a
 * fixed wait when it has none) and is turned away only when that is spent. */
async function admitScan(path: string, signal?: AbortSignal, deadlineAt?: number): Promise<boolean> {
  const until = deadlineAt ?? Date.now() + SCAN_ADMIT_WAIT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    gateIfWalLarge(path);
    if (!gated()) { activeScans++; return true; }
    const remaining = until - Date.now();
    if (remaining <= 0) return false;
    await Promise.race([new Promise<void>(resolve => admitQueue.push(resolve)), sleep(remaining)]);
  }
}
function releaseScan(path: string): void {
  activeScans = Math.max(0, activeScans - 1);
  gateIfWalLarge(path);
  if (activeScans === 0) sendCheckpointWhenIdle();
}

export interface ScanOptions {
  /** Read the mode's eligible records only (needs the main database; without it the scope form answers). */
  eligible?: boolean;
  /** Historical reads keep archived and superseded versions. */
  historical?: boolean;
  /** Date.now() time at which the scan stops and answers `partial`. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

/** lexicalPage with the exact same answer (positions [offset, offset + limit) of the order (rank, id, version)), read in short
 * chunks with `yieldTurn` between them, so no match count can hold the event loop. The whole scan reads ONE snapshot (a read
 * transaction on its own connection, held by the open statement and ended in `finally`): a write that lands while the loop is
 * released is invisible to it, so a writer that commits at every yield can neither restart nor starve the scan, and it has a
 * fixed end. It checks its deadline and signal before every chunk; at the deadline it answers what it read, flagged `partial`,
 * never as if it had finished. Records that changed since the snapshot are caught by the caller's own revalidation of what it
 * returns. */
export async function lexicalPageSliced(query: string, scopeIds: readonly string[], limit: number, offset = 0, yieldTurn: () => Promise<void> = () => new Promise<void>(resolve => setImmediate(resolve)), options: ScanOptions = {}): Promise<LexicalPage | null> {
  const terms = memoryIndexTerms(query);
  if (!terms.length) return { hits: [], more: false };
  const current = handle();
  if (!current) return null;
  const eligible = options.eligible === true && current.eligible, historical = options.historical === true;
  const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  const scopes = JSON.stringify(scopeIds), form = eligible ? (historical ? "h" : "c") : "-", key = `${expression}\u0000${scopes}\u0000${form}`, wanted = offset + limit + 1;
  const toPage = (rows: Array<Record<string, unknown>>): LexicalPage => ({
    hits: rows.slice(offset, offset + limit).map((row, index) => ({ id: String(row.id), version: Number(row.version), score: 1 / (60 + offset + index + 1), lexical: true as const })),
    more: rows.length > offset + limit,
  });
  // PRAGMA data_version is comparable only on the connection that asks: the persistent one asks, before the snapshot starts.
  const dataVersion = () => `${Number(current.db.prepare("PRAGMA data_version").get()?.data_version ?? -1)}:${eligible ? Number(current.db.prepare("PRAGMA authority.data_version").get()?.data_version ?? -1) : 0}`;
  let scan: Scan | null = null, healthy = false, inTransaction = false, admitted = false;
  let matches: Iterator<Record<string, unknown>> | null = null;
  try {
    const version = dataVersion();
    const w = slicedWindow;
    if (w && w.key === key && w.ino === current.ino && w.version === version && performance.now() - w.at < WINDOW_TTL_MS && (w.end || wanted <= w.rows.length)) return toPage(w.rows);
    if (!await admitScan(current.path, options.signal, options.deadlineAt)) return options.signal?.aborted ? null : { hits: [], more: false, partial: true };
    admitted = true;
    scan = borrowScan(current);
    if (!scan) return null;
    const keep = Math.min(SLICED_WINDOW_MAX, Math.max(wanted * 2 + SLICED_WINDOW, SLICED_WINDOW));
    const prepared = (name: string, sql: string) => { const known = scan!.statements.get(name); if (known) return known; const made = scan!.db.prepare(sql); scan!.statements.set(name, made); return made; };
    const stepper = prepared("matches", SCAN_MATCHES_SQL), judge = prepared(`judge${form}`, eligible ? scanEligibleSql(historical) : SCAN_SCOPE_SQL);
    const born = epoch;
    // One snapshot of the index and of the record tables for the whole scan: both are read once here, inside the transaction.
    scan.db.exec("BEGIN");
    inTransaction = true;
    scan.db.prepare("SELECT 1 FROM entries LIMIT 1").get();
    if (eligible) scan.db.prepare("SELECT 1 FROM authority.memory_records LIMIT 1").get();
    matches = stepper.iterate(expression) as Iterator<Record<string, unknown>>;
    let best: Array<Record<string, unknown>> = [], size = CHUNK_MIN, since = performance.now(), partial = false, done = false;
    while (!done) {
      if (options.signal?.aborted || epoch !== born) { healthy = epoch === born; return null; }
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) { partial = true; break; }
      const started = performance.now();
      const chunk: Array<Record<string, unknown>> = [];
      while (chunk.length < size) { const next = matches.next(); if (next.done) { done = true; break; } chunk.push(next.value); }
      if (chunk.length) {
        const kept = judge.all(JSON.stringify(chunk.map(row => [row.id, Number(row.version)])), scopes) as Array<Record<string, unknown>>;
        const rows = kept.map(entry => chunk[Number(entry.k)]);
        // only rows that can still be among the first `keep` need sorting
        const floor = best.length >= keep ? best[keep - 1] : null;
        const fresh = floor ? rows.filter(row => before(row, floor) < 0) : rows;
        if (fresh.length) best = best.concat(fresh).sort(before).slice(0, keep);
      }
      // grow while a chunk is cheap, shrink when it was not
      const took = performance.now() - started;
      size = took < SLICE_BUDGET_MS / 3 ? Math.min(CHUNK_MAX, size * 2) : took > SLICE_BUDGET_MS ? Math.max(CHUNK_MIN, Math.floor(size / 2)) : size;
      if (!done && performance.now() - since >= SLICE_BUDGET_MS) { await yieldTurn(); since = performance.now(); }
    }
    healthy = true;
    if (partial) return { ...toPage(best), more: false, partial: true };
    slicedWindow = { key, ino: current.ino, version, at: performance.now(), rows: best, end: best.length < keep };
    return toPage(best);
  } catch (error) {
    closeMemoryIndexReader();
    lastState = "unreadable";
    logSwallowed("recall", error);
    return null;
  } finally {
    try { matches?.return?.(); } catch { /* the statement is finished */ }
    if (scan) {
      if (inTransaction) try { scan.db.exec("ROLLBACK"); } catch { /* the connection is closed */ healthy = false; }
      returnScan(scan, healthy);
    }
    if (admitted) releaseScan(current.path);
  }
}
