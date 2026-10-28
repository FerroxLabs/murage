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
import { instrumentDatabase } from "../io-budget.ts";
import { walBytes, WAL_DRAIN_BYTES, type IndexHit } from "./index.ts";
import { logSwallowed } from "./worker-log.ts";
import { indexFilesRegular } from "./index-quarantine.ts";
import { POSTINGS_BELOW, wordTerms } from "./postings.ts";
import { before, pageByRank } from "./rank-ties.ts";
import { CURRENT_MEMORY, HISTORICAL_MEMORY, REACHABLE_RECORD } from "./eligibility.ts";

/** Most words of a query that take part in the MATCH. */
export const RECALL_TERM_LIMIT = 8;
/** First page of ranked hits, and the most one search reads in all. */
export const RECALL_FIRST_PAGE = 50;
export const RECALL_MAX_HITS = 200;
const BUSY_MS = 50;

/** `partial`: the scan reached its deadline (or was told to stop) before it had read every match, so the page is the best of what
 * was read and nothing is said about what lies past it.
 * `bounded`: the words were common enough that the scan read only the newest matches (a cap per query) and more matches remain
 * unread, so the page is the newest readable matches, not the whole answer, and coverage is not complete. */
export type LexicalPage = { hits: IndexHit[]; more: boolean; partial?: true; bounded?: true };
export type IndexReaderState = "ready" | "missing" | "unreadable" | "blocked";

interface Open { release?: () => void; path: string; ino: number; dev: number; authIno: number; eligible: boolean; db: DatabaseSync; statement: StatementSync }
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

/** Words that say nothing about which records matter. A query made only of them keeps its own words (see recallTerms). */
const STOPWORDS = new Set(("a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your").split(" "));
/** A word found in at least this many records the reader may read is common: it neither narrows a search nor is worth ranking. */
export const RECALL_COMMON_POSTINGS = 1000;
/** Most of the reader's scopes one recall reads. A reader with more is answered from these and the page says `bounded`. */
export const RECALL_SCOPE_LIMIT = 64;
/** Matches read in one step of a walk over common words (a batch is ordered newest first and judged from the top). */
export const RECALL_COMMON_WALK = RECALL_COMMON_POSTINGS * 4;
/** Most index matches ONE recall steps in all, however many batches it takes and however much history there is. When it is spent
 * with matches left, the page says so (`bounded`). */
export const RECALL_QUERY_ROWS = 120_000;
/** Distinct words of a query that are looked at when choosing the rarest. */
const RECALL_TOKEN_LOOK = 24;
/** Postings read per step of one (word, scope) list in a newest-first walk. */
const POSTING_PAGE = 256;
/** Rows the recall read has stepped since the last reset: (word, scope) counts asked (and the postings they counted), matches read,
 * records judged, recalls that ranked their matches, and statements run. Tests and measurements read it. */
export const recallWork = { probes: 0, probeRows: 0, matchRows: 0, judged: 0, rankedScans: 0, statements: 0 };

/** The words of a query that can narrow it: stopwords dropped (a query of nothing else keeps its words), looked at in order. */
export function recallTerms(query: string): string[] {
  const all = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const content = all.filter(word => !STOPWORDS.has(word.toLowerCase()));
  return (content.length ? content : all).slice(0, RECALL_TOKEN_LOOK);
}
/** recallTerms as the index spells them (postings.ts wordTerms: FTS5's own tokenizer), distinct, in query order. */
export function recallTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const word of recallTerms(query)) for (const token of wordTerms(word)) tokens.add(token);
  return [...tokens].slice(0, RECALL_TOKEN_LOOK);
}
/** The reader's scopes that hold any posting, as their keys in the postings, each with whether the backfill still owes it postings: a seek
 * into its own list of entries to write (posting_todo), never a step over another scope's. */
const SCOPE_KEYS_SQL = "SELECT n, EXISTS(SELECT 1 FROM posting_todo t WHERE t.scope = p.n) AS owed FROM posting_scopes p WHERE scope_id IN (SELECT value FROM json_each(?1)) ORDER BY n";
/** How many postings of one word one scope holds, up to ?3: a seek to (word, scope), never a step over another scope's postings. */
const PROBE_SQL = "SELECT count(*) AS n FROM (SELECT 1 FROM postings WHERE term=?1 AND scope=?2 LIMIT ?3)";
/** Every posting of a narrow word in one scope (fewer than RECALL_COMMON_POSTINGS). */
const POSTINGS_SQL = "SELECT seq FROM postings WHERE term=?1 AND scope=?2";
/** The next page of one (word, scope) list, newest first. */
const NEWEST_SQL = "SELECT seq FROM postings WHERE term=?1 AND scope=?2 AND seq<?3 ORDER BY seq DESC LIMIT ?4";
/** The record versions of these postings, by position. */
const RESOLVE_SQL = "SELECT j.key AS k,e.id AS id,e.version AS version FROM json_each(?1) j JOIN entries e ON e.rowid=j.value";
interface RecallPlan { ranked: boolean; terms: Array<{ term: string; mine: number }> }
/** Which words a recall searches for. Commonness is counted over the postings of the READER's scopes only, one (word, scope) seek at a
 * time, so what other scopes hold can neither change which words take part nor cost anything: a probe is at most
 * RECALL_COMMON_POSTINGS postings of the reader's own, and there are at most (words x scopes) probes.
 *  - words the reader holds nowhere are left out;
 *  - narrow words (fewer than RECALL_COMMON_POSTINGS readable postings) take part, the rarest first, and their postings are read whole
 *    and ranked;
 *  - when every word is common, the first few are used and the newest postings are read. */
async function planRecall(probe: StatementSync, tokens: readonly string[], keys: readonly number[], pause: () => Promise<void>): Promise<RecallPlan | null> {
  const narrow: Array<{ term: string; order: number; mine: number }> = [], common: Array<{ term: string; order: number; mine: number }> = [];
  for (const [order, term] of tokens.entries()) {
    let mine = 0;
    for (const key of keys) {
      if (mine >= RECALL_COMMON_POSTINGS) break;
      recallWork.probes++; recallWork.statements++;
      const n = Number(probe.get(term, key, RECALL_COMMON_POSTINGS - mine)?.n ?? 0);
      mine += n; recallWork.probeRows += n;
    }
    if (mine >= RECALL_COMMON_POSTINGS) common.push({ term, order, mine });
    else if (mine > 0) narrow.push({ term, order, mine });
    await pause();
  }
  if (narrow.length) {
    narrow.sort((a, b) => a.mine - b.mine || a.order - b.order);
    return { ranked: true, terms: narrow.slice(0, RECALL_TERM_LIMIT) };
  }
  if (common.length) return { ranked: false, terms: common.slice(0, RECALL_TERM_LIMIT) };
  return null;
}
/** The record versions of these postings, in the order given (a posting whose entry is gone in this snapshot is skipped). */
function resolvePostings(resolve: StatementSync, seqs: readonly number[], rank: (seq: number) => number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let at = 0; at < seqs.length; at += 2048) {
    const part = seqs.slice(at, at + 2048);
    recallWork.statements++;
    const rows = resolve.all(JSON.stringify(part)) as Array<Record<string, unknown>>;
    const byKey = new Map(rows.map(row => [Number(row.k), row]));
    part.forEach((seq, index) => { const row = byKey.get(index); if (row) out.push({ id: row.id, version: row.version, rank: rank(seq) }); });
  }
  return out;
}
/** Narrow words: every readable posting, scored by the words it holds, each weighted by how rare it is for this reader (counts of the
 * reader's own postings only), best first; equal scores by (id, version). */
function rankedPostings(list: StatementSync, resolve: StatementSync, plan: RecallPlan, keys: readonly number[]): Array<Record<string, unknown>> {
  const score = new Map<number, number>();
  for (const { term, mine } of plan.terms) {
    const weight = Math.log(1 + RECALL_COMMON_POSTINGS / mine);
    for (const key of keys) {
      recallWork.statements++;
      for (const row of list.all(term, key)) { const seq = Number(row.seq); score.set(seq, (score.get(seq) ?? 0) + weight); }
    }
  }
  return resolvePostings(resolve, [...score.keys()], seq => -score.get(seq)!).sort(before);
}
/** Common words: the postings of every (word, scope) list merged newest first, each record once, a page of lists at a time. */
function* newestPostings(page: StatementSync, resolve: StatementSync, plan: RecallPlan, keys: readonly number[]): Generator<Record<string, unknown>> {
  const lists = plan.terms.flatMap(({ term }) => keys.map(key => ({ term, key, rows: [] as number[], at: 0, below: Number.MAX_SAFE_INTEGER, end: false })));
  const head = (list: typeof lists[number]): number | null => {
    if (list.at >= list.rows.length && !list.end) {
      recallWork.statements++;
      list.rows = page.all(list.term, list.key, list.below, POSTING_PAGE).map(row => Number(row.seq));
      list.at = 0;
      if (list.rows.length < POSTING_PAGE) list.end = true;
      if (list.rows.length) list.below = list.rows.at(-1)!;
    }
    return list.at < list.rows.length ? list.rows[list.at]! : null;
  };
  let last = Number.POSITIVE_INFINITY;
  for (;;) {
    const seqs: number[] = [];
    while (seqs.length < POSTING_PAGE) {
      let best: typeof lists[number] | null = null, bestSeq = -1;
      for (const list of lists) { const seq = head(list); if (seq !== null && seq > bestSeq) { best = list; bestSeq = seq; } }
      if (!best) break;
      best.at++;
      if (bestSeq === last) continue;
      last = bestSeq; seqs.push(bestSeq);
    }
    if (!seqs.length) return;
    yield* resolvePostings(resolve, seqs, () => 0);
  }
}

/** While the helper is starting (it may rebuild or rename a damaged index) the main process holds no handle. */
export function blockMemoryIndexReader(): void { blocked = true; closeMemoryIndexReader(); }
export function unblockMemoryIndexReader(): void { blocked = false; }
export function closeMemoryIndexReader(): void {
  window_ = null; slicedWindow = null; epoch++;
  const current = open; open = null;
  try { current?.release?.(); } catch { /* idempotent */ }
  try { current?.db.close(); } catch { /* idempotent */ }
  for (const scan of scanPool.splice(0)) try { scan.db.close(); } catch { /* idempotent */ }
}
export function memoryIndexReaderState(): IndexReaderState { return lastState; }
/** Whether the index owes a deletion scrub (index.ts scrubDeleted), read when the controller starts so a helper drains that durable debt
 * even with no other memory work (MEMDEL-SIMPLIFY-109). False only when there is no index file (ENOENT/ENOTDIR), or the index was read
 * and holds no marker; null when it could not be read now (any other stat error, locked, being replaced): unknown is not clean, so the caller starts the helper, which reads the
 * marker itself and says (memdel r2 High #3). */
export function indexScrubOwed(): boolean | null {
  try { statSync(indexPath()); } catch (error) {
    // Only a missing file means no debt: any other stat error (permission, I/O) is unknown, and unknown is owed (memdel r3 High).
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : null;
  }
  try {
    const db = handle()?.db;
    if (!db) return null;
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta'").get()) return false;
    return Boolean(db.prepare("SELECT 1 FROM index_meta WHERE key='delete_scrub_owed'").get());
  } catch { return null; }
}
/** How many times this process opened the index (tests: owner search and recall reuse the one handle). */
let readerOpens = 0;
export function memoryIndexReaderOpens(): number { return readerOpens; }
/** The one read-only handle on the index, with the main database attached as `authority`, for owner search: null when the index
 * cannot be read or the main database is not attached (the caller then matches the records' text). Owner search takes it again for
 * every slice, so a handle closed or replaced between slices (the helper restarting) is never used. */
export function ownerIndexHandle(): DatabaseSync | null {
  const current = handle();
  return current && current.eligible ? current.db : null;
}

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
    // A link (or anything but a regular file) as the index or its log is never opened, not even read-only (MEMINDEX-BUSY-109).
    if (!indexFilesRegular(path)) throw new Error("UNSAFE_MEMORY_INDEX");
    db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA cache_size=-${READER_CACHE_KIB}`);
    // A file the helper has not finished creating has no word table yet.
    db.prepare("SELECT 1 FROM entries LIMIT 1").get();
    const authIno = authorityIno();
    const eligible = authIno >= 0 && attachAuthority(db);
    // Timed like every other connection (slow statements, the I/O budget), so its work is named instead of showing as an unnamed stall.
    // Its bytes are not read here: this handle never writes, and the index's log is the helper's writing, which the helper reports itself.
    const release = instrumentDatabase(db, undefined, { bytes: false });
    readerOpens++;
    open = { path, ino: stat.ino, dev: stat.dev, authIno, eligible, db, statement: db.prepare(RECALL_SEARCH_SQL), release };
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


/** (Since 1.0.2 a recall no longer steps every match: recallTerms and planRecall choose the rarest words, the matches of those are
 * the only ones read, and eligibility is judged for the best-ranked ones only. The account below is why a ranking is never asked
 * of FTS5 itself.) The word list of a search, read in index order a chunk of matches at a time, never as one ranking: FTS5 computes a score for every
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
const SLICED_WINDOW_MAX = 50_000;
let slicedWindow: { key: string; ino: number; version: string; at: number; rows: Array<Record<string, unknown>>; end: boolean; bounded: boolean } | null = null;

/** `rows` in `order`, sorted in runs of SORT_RUN and merged pairwise, `pause` offered every SORT_RUN rows, so no single step of a
 * long sort holds the loop. A short list is sorted at once. */
const SORT_RUN = 2048;
async function sortSliced<T>(rows: readonly T[], order: (a: T, b: T) => number, pause: () => Promise<void>): Promise<T[]> {
  if (rows.length <= SORT_RUN) return [...rows].sort(order);
  let runs: T[][] = [];
  for (let at = 0; at < rows.length; at += SORT_RUN) { runs.push(rows.slice(at, at + SORT_RUN).sort(order)); await pause(); }
  while (runs.length > 1) {
    const merged: T[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r]!, b = runs[r + 1];
      if (!b) { merged.push(a); continue; }
      const out: T[] = [];
      let x = 0, y = 0;
      while (x < a.length || y < b.length) {
        out.push(y >= b.length || (x < a.length && order(a[x]!, b[y]!) <= 0) ? a[x++]! : b[y++]!);
        if (out.length % SORT_RUN === 0) await pause();
      }
      merged.push(out);
    }
    runs = merged;
  }
  return runs[0]!;
}
/** Page cache of each read-only connection on the index, in KiB (negative cache_size = KiB). The SQLite default is 2 MiB, which a scan
 * over a 70 MB index outgrows within one search, so every miss became a pread (on macOS, a syscall and context switch each). Pages are
 * allocated only as they are read, so a small index costs no more than its own size. Open at once: the shared reader (1) plus the
 * scans, which are the idle pool (SCAN_POOL_MAX = 2) and any overlapping searches (one more each, closed when they finish). Three
 * resident in steady state, four while two searches overlap, so at most 4 x 16 MiB = 64 MiB, and 48 MiB at rest. */
const READER_CACHE_KIB = 16384;
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
    if (!indexFilesRegular(current.path)) throw new Error("UNSAFE_MEMORY_INDEX");
    db = new DatabaseSync(current.path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA cache_size=-${READER_CACHE_KIB}`);
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
// 1.0.2: lazy. index.ts -> relevance -> ... -> drivers/engine-input -> dispatch -> bundle -> search -> this file is an import cycle, so WAL_DRAIN_BYTES
// is not yet initialised when this module body runs in the memory worker (TDZ ReferenceError killed the worker, no job ever completed).
let walThreshold: number | undefined;
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
  try { large = walBytes(path) > (walThreshold ?? WAL_DRAIN_BYTES); } catch { /* no log to measure */ }
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
  const tokens = recallTokens(query);
  if (!tokens.length) return { hits: [], more: false };
  const current = handle();
  if (!current) return null;
  const eligible = options.eligible === true && current.eligible, historical = options.historical === true;
  const scopes = JSON.stringify(scopeIds);
  const form = eligible ? (historical ? "h" : "c") : "-", key = `${tokens.join("\u0001")}\u0000${scopes}\u0000${form}`, wanted = offset + limit + 1;
  let bounded = false;
  const toPage = (rows: Array<Record<string, unknown>>, cut = bounded): LexicalPage => ({
    hits: rows.slice(offset, offset + limit).map((row, index) => ({ id: String(row.id), version: Number(row.version), score: 1 / (60 + offset + index + 1), lexical: true as const })),
    more: rows.length > offset + limit,
    ...cut ? { bounded: true as const } : {},
  });
  // PRAGMA data_version is comparable only on the connection that asks: the persistent one asks, before the snapshot starts.
  const dataVersion = () => `${Number(current.db.prepare("PRAGMA data_version").get()?.data_version ?? -1)}:${eligible ? Number(current.db.prepare("PRAGMA authority.data_version").get()?.data_version ?? -1) : 0}`;
  let scan: Scan | null = null, healthy = false, inTransaction = false, admitted = false;
  let matches: Iterator<Record<string, unknown>> | null = null;
  try {
    const version = dataVersion();
    const w = slicedWindow;
    if (w && w.key === key && w.ino === current.ino && w.version === version && performance.now() - w.at < WINDOW_TTL_MS && (w.end || wanted <= w.rows.length)) return toPage(w.rows, w.bounded);
    if (!await admitScan(current.path, options.signal, options.deadlineAt)) return options.signal?.aborted ? null : { hits: [], more: false, partial: true };
    admitted = true;
    scan = borrowScan(current);
    if (!scan) return null;
    const prepared = (name: string, sql: string) => { const known = scan!.statements.get(name); if (known) return known; const made = scan!.db.prepare(sql); scan!.statements.set(name, made); return made; };
    const born = epoch;
    // One snapshot of the index and of the record tables for the whole scan (the choice of words included): both are read once here,
    // inside the transaction.
    scan.db.exec("BEGIN");
    inTransaction = true;
    scan.db.prepare("SELECT 1 FROM entries LIMIT 1").get();
    if (eligible) scan.db.prepare("SELECT 1 FROM authority.memory_records LIMIT 1").get();
    // An index file the helper has not opened with this build yet has no postings: the helper answers.
    recallWork.statements++;
    if (scan.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('postings','posting_todo')").all().length < 2) { healthy = true; return null; }
    // Entries an earlier build indexed whose postings are not filled yet (newest first): only the newest were read, and the page says so.
    recallWork.statements++;
    // While the entries are still being listed (postings_below), every reader's page says so alike; afterwards only the scopes it reads owe.
    const enumerating = prepared("filling", "SELECT 1 AS x FROM index_meta WHERE key=?1").get(POSTINGS_BELOW) !== undefined;
    recallWork.statements++;
    const scopeRows = prepared("scopes", SCOPE_KEYS_SQL).all(scopes);
    const capped = scopeRows.length > RECALL_SCOPE_LIMIT;
    if (capped) scopeRows.length = RECALL_SCOPE_LIMIT;
    const keys = scopeRows.map(row => Number(row.n));
    // Postings still owed to the scopes this recall reads (the kept ones): nothing another scope holds is part of the answer.
    const filling = enumerating || scopeRows.some(row => Number(row.owed) === 1);
    let probeClock = performance.now();
    const plan = await planRecall(prepared("probe", PROBE_SQL), tokens, keys, async () => { if (performance.now() - probeClock >= SLICE_BUDGET_MS) { await yieldTurn(); probeClock = performance.now(); } });
    if (options.signal?.aborted || epoch !== born) { healthy = epoch === born; return null; }
    if (!plan) { healthy = true; return { hits: [], more: false, ...filling || capped ? { bounded: true as const } : {} }; }
    const resolve = prepared("resolve", RESOLVE_SQL);
    const ranked = plan.ranked ? rankedPostings(prepared("postings", POSTINGS_SQL), resolve, plan, keys) : null;
    const planRows = ranked ? ranked.length : RECALL_QUERY_ROWS;
    // Enough eligible rows for this page and the next few: the walk stops there, so a recall judges a handful of records.
    const keep = Math.min(SLICED_WINDOW_MAX, wanted * 2 + 64);
    const judge = prepared(`judge${form}`, eligible ? scanEligibleSql(historical) : SCAN_SCOPE_SQL);
    // The matches come from the reader's own postings only. When the words are narrow the batch is every readable posting of them,
    // ordered by (rank, id, version); otherwise the (word, scope) lists are merged newest first and read in batches of RECALL_COMMON_WALK,
    // the newest eligible ones kept and listed by id. Only the top of a batch is judged for eligibility, a chunk at a time, until `keep`
    // of them stand: what is kept is exactly as strict as before (the same statement judges each chunk). The walk never steps past
    // RECALL_QUERY_ROWS readable postings in all, and says `bounded` when it stopped with more behind it.
    if (ranked) recallWork.rankedScans++;
    matches = ranked ? ranked[Symbol.iterator]() : newestPostings(prepared("newest", NEWEST_SQL), resolve, plan, keys);
    const best: Array<Record<string, unknown>> = [];
    const batchSize = ranked ? Math.max(1, planRows) : RECALL_COMMON_WALK;
    let size = CHUNK_MIN, since = performance.now(), partial = false, exhausted = false, batchLeft = false, stepped = 0, spent = false;
    const stopped = () => options.signal?.aborted || epoch !== born;
    const pastDeadline = () => options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
    while (!partial && !exhausted && !spent && best.length < keep) {
      const batch: Array<Record<string, unknown>> = [];
      while (batch.length < batchSize) {
        if (stopped()) { healthy = epoch === born; return null; }
        if (pastDeadline()) { partial = true; break; }
        while (batch.length < batchSize && performance.now() - since < SLICE_BUDGET_MS) {
          if (stepped >= planRows) { spent = true; break; }
          const next = matches.next();
          if (next.done) { exhausted = true; break; }
          batch.push(next.value); stepped++; recallWork.matchRows++;
        }
        if (exhausted || spent) break;
        if (performance.now() - since >= SLICE_BUDGET_MS) { await yieldTurn(); since = performance.now(); }
      }
      if (partial) break;
      let at = 0;
      size = CHUNK_MIN;
      while (at < batch.length && best.length < keep) {
        if (stopped()) { healthy = epoch === born; return null; }
        if (pastDeadline()) { partial = true; break; }
        if (performance.now() - since >= SLICE_BUDGET_MS) { await yieldTurn(); since = performance.now(); continue; }
        const started = performance.now();
        const chunk = batch.slice(at, at + size);
        at += chunk.length;
        recallWork.judged += chunk.length;
        const kept = judge.all(JSON.stringify(chunk.map(row => [row.id, Number(row.version)])), scopes) as Array<Record<string, unknown>>;
        for (const entry of kept.sort((a, b) => Number(a.k) - Number(b.k))) best.push(chunk[Number(entry.k)]!);
        const took = performance.now() - started;
        size = took < SLICE_BUDGET_MS / 3 ? Math.min(CHUNK_MAX, size * 2) : took > SLICE_BUDGET_MS ? Math.max(CHUNK_MIN, Math.floor(size / 2)) : size;
      }
      batchLeft = at < batch.length;
    }
    // Matches the walk did not read: a walk that stopped (enough found, or the per-query cap spent) with more behind it.
    if (!partial && !exhausted) exhausted = matches.next().done === true;
    bounded = (!partial && !exhausted) || filling || capped;
    // The first `keep` eligible matches in the order they were judged (rank order, or newest first) are what the page is made of: where a
    // chunk ended inside the run is an accident of chunk sizes, and the answer must not depend on it.
    const trimmed = best.length > keep;
    if (trimmed) best.length = keep;
    // Up to SLICED_WINDOW_MAX rows: one sort of 50,000 held the loop for ~40 ms, so a long list is sorted in runs and merged in slices.
    const sorted = await sortSliced(best, before, async () => { if (performance.now() - since >= SLICE_BUDGET_MS) { await yieldTurn(); since = performance.now(); } });
    if (stopped()) { healthy = epoch === born; return null; }
    for (let n = 0; n < sorted.length; n++) best[n] = sorted[n]!;
    const done = exhausted && !batchLeft && !trimmed;
    // A page that lies past what was read, with matches still unread, cannot be served: say so (bounded) rather than end the list as
    // if it had been read to its end.
    if (!done && !partial && best.length < wanted) bounded = true;
    healthy = true;
    if (partial) return { ...toPage(best, false), more: false, partial: true };
    slicedWindow = { key, ino: current.ino, version, at: performance.now(), rows: best, end: done, bounded };
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
