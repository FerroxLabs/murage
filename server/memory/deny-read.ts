// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: the one read predicate (DESIGN-WRITETIME 1, "The one read predicate"; S4 owns every body here).
//
// A bot turn asks the deny tables about the lines, memory objects, sessions and refs it would show. Each answer is a fixed number of
// primary-key or index seeks per page, per distinct thread, per memory ref and per distinct footprint, whatever the history size (the
// marker, memory-revocation.ts, has already walked the ancestry and written the marks). Two rules are reader-relative and are not marks:
// the watermark (a line whose oldest receipt predates the last policy or deletion-epoch bump is withheld from an audience reader, the same
// answer as replay-lineage.ts:865) and the footprint (the scopes a line's memory ancestry read from must all be the reader's; an owner
// audience skips it, as copyOriginRevoked does).
//
// Every unknown is "checking" (withheld): no lineage row, a thread not ready, a pending revoke covering the line, a `*` footprint for a
// non-owner, a footprint set that cannot be read, and any error in the lookup. There is no path where an unknown shows a line. Owner and
// person lines are judged only by their own flag, their source's tombstone and the thread deny: they never wait.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DENIED_SOURCE } from "./deny.ts";
import { threadNo } from "./thread-no.ts";
import { murageAnchor } from "../murage-anchor.ts";
import { FOOTPRINT_STAR, memoryRefKey, PENDING_ALL_SCOPES, PENDING_ALL_THREADS, worstVerdict, type BuiltPrompt, type CheckingReason, type DenyReason, type LineageReader, type LineageRef,
  type LinePage, type LineageVerdict, type MemoryRef, type PageLine, type SessionKey } from "./lineage-types.ts";
import { AUDIENCE_COALESCED } from "./lineage-types.ts";

const SHOWN: LineageVerdict = Object.freeze({ state: "shown" });
const withheld = (reason: DenyReason): LineageVerdict => ({ state: "withheld", reason });
const checking = (reason: CheckingReason): LineageVerdict => ({ state: "checking", reason });
/** deny_range rows read per thread: the marker coalesces a thread's ranges at DENY_RANGE_COALESCE (64); past this many every generated
 * line after the first range is withheld (fail closed, never a longer read). */
const RANGE_READ_LIMIT = 256;
/** Records citing one source read by the in-flight supporting-source check (revbound r3 A2); past this the source reads "checking". */
const SUPPORT_FAN_IN = 64;
/** Retained-session receipts read for a revoked state (newest first); older ones are covered by deny_session and the pending window. */
const SESSION_RECEIPT_PEEK = 64;
/** Line ids per batched statement. */
const BATCH = 500;
/** How many records a derivation walk reads (rule 23) before it gives up: past it the record reads "checking", never shown. */
const DERIVATION_WALK = 256;
/** How many cited objects of one receipt the anchor check reads (rule 23); past it the receipt reads "checking". */
const RECEIPT_ANCHORS = 2048;
/** How many rows (parents and cited anchors) one step of the rule 23 walk reads for one record; past it the record reads "checking". */
const RECORD_ANCHORS = 2048;

// ---- statements and the meter the flatness tests read ----

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const meter = { statements: 0, rows: 0, sql: new Set<string>() };
/** Statements run and rows returned by this module since the last reset, and every statement text it ran (the flatness tests compare these
 * at small and huge history and check each text's query plan). */
export function denyReadMeter(): { statements: number; rows: number; sql: readonly string[] } { return { statements: meter.statements, rows: meter.rows, sql: [...meter.sql] }; }
export function resetDenyReadMeter(): void { meter.statements = 0; meter.rows = 0; meter.sql.clear(); }
function prepared(db: DatabaseSync, sql: string): StatementSync {
  let byText = statementCache.get(db);
  if (!byText) { byText = new Map(); statementCache.set(db, byText); }
  let statement = byText.get(sql);
  if (!statement) { statement = db.prepare(sql); byText.set(sql, statement); }
  meter.statements++; meter.sql.add(sql);
  return statement;
}
type Row = Record<string, unknown>;
function one(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row | undefined {
  const row = prepared(db, sql).get(...args) as Row | undefined;
  if (row) meter.rows++;
  return row;
}
function all(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] {
  const rows = prepared(db, sql).all(...args) as Row[];
  meter.rows += rows.length;
  return rows;
}
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

// ---- shared facts (each a seek or two) ----

function threadDenied(db: DatabaseSync, threadId: string): boolean {
  return Boolean(one(db, "SELECT 1 AS x FROM memory_deny WHERE kind='thread' AND id=?", threadId));
}
/** Marks and pending rows of an audience-only revoke (a receipt whose state turned 'revoked': lineage-types.ts RevokeRoot) bind audience
 * readers only: the content judge (the owner's direct chat and rooms, reader.audience null) and memory recall skip them, as the RC did
 * (replay-lineage.ts: `audience !== null && row.state === "revoked"`). One primary-key seek per mark row. */
const NOT_AUDIENCE_ONLY = "revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience)";
/** A memory mark under the coalesced audience row (AUDIENCE_COALESCED) is audience-only too: a late edge's child under it is marked with
 * that id at its write (revoke-commit.ts inheritMarks). */
const NOT_AUDIENCE_MEMORY = `${NOT_AUDIENCE_ONLY} AND revoke_id<>${AUDIENCE_COALESCED}`;
/** The lowest since_lsn of any pending revoke covering this thread (its own rows and the `*` rows), or null. Two seeks on the primary key.
 * A content reader skips audience-only revokes, and receipt flips not yet committed (those are audience-only too). */
function pendingSince(db: DatabaseSync, threadId: string, content: boolean): number | null {
  const skip = content ? ` AND ${NOT_AUDIENCE_ONLY}` : "";
  const own = num(one(db, `SELECT since_lsn FROM memory_deny_pending WHERE thread_id=?${skip} ORDER BY since_lsn LIMIT 1`, threadId)?.since_lsn);
  const every = num(one(db, `SELECT since_lsn FROM memory_deny_pending WHERE thread_id=?${skip} ORDER BY since_lsn LIMIT 1`, PENDING_ALL_THREADS)?.since_lsn);
  // a receipt some path turned 'revoked' and the marker has not committed yet (receipt-outputs.ts): its lines from its first output on
  const no = content ? null : threadNo(db, threadId);
  const flipped = no === null ? null : num(one(db, "SELECT first_lsn FROM memory_receipt_flips WHERE thread_no=? ORDER BY first_lsn LIMIT 1", no)?.first_lsn);
  return [own, every, flipped].reduce<number | null>((low, value) => value === null ? low : low === null ? value : Math.min(low, value), null);
}
/** One pending window over a thread's generated lines: a line at or after `since` whose turn began before `cap` reads "checking". */
interface PendingWindow { since: number; cap: number }
/** Most pending rows read for one thread (its own and the `*` rows); past it every line from the lowest since is held, whatever its turn. */
const PENDING_READ_LIMIT = 256;
/** The pending windows over a thread's generated lines (lookupPage): its own rows and the `*` rows, each capped at its revoke's commit
 * (memory_revoke_jobs.started_lsn), the cap the marker's ranges and session stage use (revoke-marker.ts: a turn begun after the owner's
 * action is a new turn). A prompt built after the commit has a head (turn_lsn) at or above the cap and was fenced against the revoke
 * (send-fence.ts); a line of such a turn that rests on what the revoke reaches gets its own hold at write (revoke-commit.ts inheritMarks).
 * No cap (fail closed): a bulk still seeding, a row with no job, a hold written after the commit (since past the cap: an inherit hold for a
 * derived post-commit line), a receipt flip not committed yet, and more rows than PENDING_READ_LIMIT. */
function pendingWindows(db: DatabaseSync, threadId: string, content: boolean): PendingWindow[] {
  const skip = content ? ` AND p.${NOT_AUDIENCE_ONLY}` : "";
  const rows = all(db, `SELECT p.since_lsn AS s,j.started_lsn AS c,j.state AS st FROM memory_deny_pending p LEFT JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id WHERE p.thread_id IN (?,?)${skip} ORDER BY p.since_lsn LIMIT ?`, threadId, PENDING_ALL_THREADS, PENDING_READ_LIMIT + 1);
  const windows: PendingWindow[] = rows.length > PENDING_READ_LIMIT ? [{ since: Number(rows[0]!.s), cap: Infinity }] : rows.map(row => {
    const since = Number(row.s), cap = num(row.c);
    return { since, cap: cap === null || row.st === "seeding" || since > cap ? Infinity : cap };
  });
  const no = content ? null : threadNo(db, threadId);
  const flipped = no === null ? null : num(one(db, "SELECT first_lsn FROM memory_receipt_flips WHERE thread_no=? ORDER BY first_lsn LIMIT 1", no)?.first_lsn);
  if (flipped !== null) windows.push({ since: flipped, cap: Infinity });
  return windows;
}
/** A generated line is in a pending window: at or after its since, of a turn begun before its cap (a line with no turn lsn counts from 0). */
function inPendingWindow(windows: readonly PendingWindow[], line: LineageRow): boolean {
  const turnLsn = line.turnLsn ?? 0;
  return windows.some(window => window.since <= line.lsn && turnLsn < window.cap);
}
/** A thread is ready (its lineage is complete) only when the upgrade certificate is ready AND the thread has no ready row of 0 (an import,
 * a restore or a merge marks one: lineage-write.ts markThreadNotReady). A ready row of 1 never makes a thread ready sooner: U1 and U2 are
 * whole-file passes, so the certificate is the only proof (lineage-backfill.ts, S5). Two seeks on primary keys. */
export function lineageThreadReady(db: DatabaseSync, threadId: string): boolean {
  if (Number(one(db, "SELECT ready FROM memory_lineage_cert WHERE id=1")?.ready ?? 0) !== 1) return false;
  const row = one(db, "SELECT ready FROM memory_lineage_thread_ready WHERE thread_id=?", threadId);
  return !row || Number(row.ready) === 1;
}
const threadReady = lineageThreadReady;
/** max(policy_bump_lsn, epoch_bump_lsn): a generated line whose oldest receipt is older than this is stale for an audience reader. */
function watermark(db: DatabaseSync): number {
  const row = one(db, "SELECT max(value) AS w FROM memory_lineage_lsn_meta WHERE key IN ('policy_bump_lsn','epoch_bump_lsn')");
  const value = num(row?.w);
  if (value === null) throw new Error("INVALID_MEMORY_LINEAGE_META");
  return value;
}

/** Interned scope sets never change once written (memory_scope_set_keys holds their hash): their members are kept per database. */
const footprintSets = new WeakMap<DatabaseSync, Map<number, ReadonlySet<string> | null>>();
function footprintMembers(db: DatabaseSync, setId: number): ReadonlySet<string> | null {
  let sets = footprintSets.get(db);
  if (!sets) { sets = new Map(); footprintSets.set(db, sets); }
  if (sets.has(setId)) return sets.get(setId)!;
  const rows = all(db, "SELECT scope_id FROM memory_scope_sets WHERE set_id=? LIMIT 33", setId);
  // a set that has no rows, or more than the cap (never written so), is unknown: the caller reads it as "checking"
  const members = rows.length && rows.length <= 32 ? new Set(rows.map(row => String(row.scope_id))) : null;
  if (sets.size >= 4096) sets.delete(sets.keys().next().value!);
  if (members) sets.set(setId, members);
  return members;
}
/** The footprint rule for one line, memoised per call by set id. */
function footprintVerdict(db: DatabaseSync, footprint: number | null, reader: LineageReader, memo: Map<number, LineageVerdict>): LineageVerdict {
  const audience = reader.audience;
  if (!audience || audience.owner || footprint === null) return SHOWN;
  if (footprint === FOOTPRINT_STAR) return checking("footprint-wide");
  const kept = memo.get(footprint);
  if (kept) return kept;
  const members = footprintMembers(db, footprint);
  const scopes = new Set(audience.scopeIds);
  const verdict = !members ? checking("lookup-error") : [...members].every(scope => scopes.has(scope)) ? SHOWN : withheld("footprint");
  memo.set(footprint, verdict);
  return verdict;
}

// ---- lines ----

interface StoredLine { role: string; flagged: boolean }
interface LineageRow { lsn: number; generated: boolean; turnLsn: number | null; memLsn: number | null; footprint: number | null }

/** The verdict for every line of one page of one thread, by message id, for this reader. Every message id of the page has an entry.
 * `ownerOwnChat` exempts only an explicit owner audience from the policy/epoch watermark for result delivery. All marks still apply. */
export function denyLookup(db: DatabaseSync, page: LinePage, reader: LineageReader, options: { ownerOwnChat?: boolean } = {}): Map<string, LineageVerdict> {
  try { return lookupPage(db, page.threadId, page.lines, reader, false, options.ownerOwnChat === true && reader.audience?.owner === true); }
  catch { return new Map(page.lines.map(line => [line.messageId, checking("lookup-error")])); }
}

/** `infer`: the authors are not known to the caller (refs): a stored owner line (role user, no generated lineage row) is judged as one. */
function lookupPage(db: DatabaseSync, threadId: string, lines: readonly PageLine[], reader: LineageReader, infer: boolean, skipPolicyWatermark = false): Map<string, LineageVerdict> {
  const out = new Map<string, LineageVerdict>();
  if (!lines.length) return out;
  const ids = [...new Set(lines.map(line => line.messageId))];
  if (threadDenied(db, threadId)) { for (const id of ids) out.set(id, withheld("thread-deny")); return out; }
  // the stored row: its role and its own flag (the caller's flag counts too); a line that is not stored is gone
  const stored = new Map<string, StoredLine>();
  const forgotten = new Set<string>();
  const lineage = new Map<string, LineageRow>();
  const prefix = `message:${threadId}:`;
  const no = threadNo(db, threadId);
  for (let at = 0; at < ids.length; at += BATCH) {
    const slice = ids.slice(at, at + BATCH), json = JSON.stringify(slice), sourceIds = JSON.stringify(slice.map(id => `${prefix}${id}`));
    for (const row of all(db, "SELECT id,role,json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))", threadId, json)) {
      const flag = row.w;
      // "checking" is never a stored verdict: a row left flagged "checking" on disk (1.0.2, an earlier 1.0.3 process) is read as no note and
      // judged live on its marks and windows below (REPLY-WITHHELD-CONTRACT R2). It once read itself back as "checking" for good (rehearsal 4).
      stored.set(String(row.id), { role: String(row.role), flagged: flag === "checking" ? false : flag !== null && flag !== undefined && flag !== 0 && flag !== "false" });
    }
    // the owner forgot the line (its captured source is deleted, denied or tombstoned at any revision)
    for (const row of all(db, `SELECT s.id FROM memory_sources s WHERE s.id IN (SELECT value FROM json_each(?)) AND (s.state='deleted' OR ${DENIED_SOURCE("s")})`, sourceIds)) forgotten.add(String(row.id).slice(prefix.length));
    for (const row of all(db, "SELECT DISTINCT target_id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?))", sourceIds)) forgotten.add(String(row.target_id).slice(prefix.length));
    // (a generated line is one with a turn_lsn: owner and person lines have none)
    if (no !== null) for (const row of all(db, "SELECT message_id,lsn,turn_lsn,mem_lsn,footprint FROM memory_line_lineage WHERE thread_no=? AND message_id IN (SELECT value FROM json_each(?))", no, json))
      lineage.set(String(row.message_id), { lsn: Number(row.lsn), generated: row.turn_lsn !== null && row.turn_lsn !== undefined, turnLsn: num(row.turn_lsn), memLsn: num(row.mem_lsn), footprint: num(row.footprint) });
  }
  const callerFlag = new Map<string, boolean>();
  const callerAuthor = new Map<string, PageLine["author"]>();
  for (const line of lines) {
    if (line.withheldFromBots) callerFlag.set(line.messageId, true);
    // the strictest author any entry gives: generated over person over owner
    if (callerAuthor.get(line.messageId) !== "generated") callerAuthor.set(line.messageId, line.author === "generated" ? "generated" : callerAuthor.get(line.messageId) ?? line.author);
  }
  const generatedIds: string[] = [];
  for (const id of ids) {
    const row = stored.get(id), lin = lineage.get(id);
    if (!row) { out.set(id, withheld("tombstone")); continue; }            // gone: its conversation or the line was deleted
    if (reader.ownFlag !== false && (row.flagged || callerFlag.get(id))) { out.set(id, withheld("own-flag")); continue; }
    if (forgotten.has(id)) { out.set(id, withheld("tombstone")); continue; }
    // owner and person lines: only the direct facts above. A line is judged as generated when anything says so (fail closed).
    const human = row.role === "user" && !lin?.generated && (infer || callerAuthor.get(id) !== "generated");
    if (human) { out.set(id, SHOWN); continue; }
    generatedIds.push(id);
  }
  if (!generatedIds.length) return out;
  // generated lines: lineage row, ready thread, marks, the pending window, then the reader's watermark and footprint
  const ready = threadReady(db, threadId);
  const content = reader.audience === null;
  const windows = pendingWindows(db, threadId, content);
  const withRows = generatedIds.filter(id => lineage.has(id));
  const denied = new Set<number>();
  let ranges: Array<{ from: number; until: number }> = [], overRanges = false;
  if (withRows.length) {
    const lsns = withRows.map(id => lineage.get(id)!.lsn);
    for (let at = 0; at < lsns.length; at += BATCH)
      for (const row of all(db, `SELECT DISTINCT lsn FROM memory_deny_line WHERE thread_id=? AND lsn IN (SELECT value FROM json_each(?))${content ? ` AND ${NOT_AUDIENCE_ONLY}` : ""}`, threadId, JSON.stringify(lsns.slice(at, at + BATCH)))) denied.add(Number(row.lsn));
    const top = Math.max(...lsns);
    const rows = all(db, `SELECT from_lsn,until_turn_lsn FROM memory_deny_range WHERE thread_id=? AND from_lsn<?${content ? ` AND revoke_id<>${AUDIENCE_COALESCED} AND ${NOT_AUDIENCE_ONLY}` : ""} ORDER BY from_lsn LIMIT ?`, threadId, top, RANGE_READ_LIMIT + 1);
    overRanges = rows.length > RANGE_READ_LIMIT;
    ranges = rows.map(row => ({ from: Number(row.from_lsn), until: Number(row.until_turn_lsn) }));
  }
  const audience = reader.audience;
  // Owner result delivery may ignore policy/epoch age, but remains an audience reader for every revocation and pending mark.
  const mark = audience && !skipPolicyWatermark && withRows.some(id => lineage.get(id)!.memLsn !== null) ? watermark(db) : null;
  const footprints = new Map<number, LineageVerdict>();
  for (const id of generatedIds) {
    const lin = lineage.get(id);
    if (!lin) { out.set(id, checking("no-lineage")); continue; }
    let verdict: LineageVerdict = SHOWN;
    if (denied.has(lin.lsn)) verdict = withheld("deny-line");
    else {
      // a generated line in T is denied when from_lsn < L.lsn AND L.turn_lsn < until_turn_lsn; a line with no turn lsn counts from 0
      const turnLsn = lin.turnLsn ?? 0;
      if (overRanges ? ranges[0]!.from < lin.lsn : ranges.some(range => range.from < lin.lsn && turnLsn < range.until)) verdict = withheld("deny-range");
    }
    if (verdict.state === "shown" && mark !== null && lin.memLsn !== null && lin.memLsn < mark) verdict = withheld("watermark");
    if (verdict.state === "shown") verdict = footprintVerdict(db, lin.footprint, reader, footprints);
    if (verdict.state !== "withheld") {
      if (!ready) verdict = worstVerdict(verdict, checking("thread-not-ready"));
      else if (inPendingWindow(windows, lin)) verdict = worstVerdict(verdict, checking("pending"));
    }
    out.set(id, verdict);
  }
  return out;
}

// ---- memory objects ----

/** created_lsn, when a memory table carries it as a column (lessons: none yet; the pending-scope gate compares it with since_lsn); absent =
 * unknown = "checking". Records and sources are stamped in tables of their own (recordCreated, sourceCreated). */
const createdColumn = new WeakMap<DatabaseSync, Map<string, boolean>>();
function hasCreatedLsn(db: DatabaseSync, table: string): boolean {
  let tables = createdColumn.get(db);
  if (!tables) { tables = new Map(); createdColumn.set(db, tables); }
  let has = tables.get(table);
  if (has === undefined) {
    has = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(column => column.name === "created_lsn");
    tables.set(table, has);
  }
  return has;
}
/** Whether a revoke is in flight: any pending row, or revbound's revocation job waiting (memory-revocation.ts binds its system subject). */
function revokeInFlight(db: DatabaseSync, memo: { inFlight?: boolean }): boolean {
  if (memo.inFlight !== undefined) return memo.inFlight;
  return memo.inFlight = Boolean(one(db, "SELECT 1 AS x FROM memory_deny_pending LIMIT 1")) || Boolean(one(db, "SELECT 1 AS x FROM memory_deny_pending_scope LIMIT 1"))
    || Boolean(one(db, "SELECT 1 AS x FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation' LIMIT 1"));
}
interface MemoryMemo { inFlight?: boolean; every?: number | null; anyScope?: boolean; scopes: Map<string, number | null>; denied: Map<string, boolean>;
  /** lineage_upgrade_lsn, read once per lookup (recordUnstampedBound); null = no key. */
  upgradeLsn?: number | null;
  /** Versioned record refs read in one statement (row, its deny_memory mark, its tombstone), by memoryRefKey; null = no such version. */
  records: Map<string, Row | null>;
  /** Rule 23 verdicts of records already walked in this lookup, by `id\0version`; null = no Murage anchor. */
  anchored: Map<string, LineageVerdict | null> }
function scopeDenied(db: DatabaseSync, scopeId: string, memo: MemoryMemo): boolean {
  let denied = memo.denied.get(scopeId);
  if (denied === undefined) { denied = Boolean(one(db, "SELECT 1 AS x FROM memory_deny WHERE kind='scope' AND id=?", scopeId)); memo.denied.set(scopeId, denied); }
  return denied;
}
/** The lowest since_lsn of a pending revoke covering a memory object of this scope (the scope's rows and the `*` window), or null. When the
 * scope is unknown, any pending scope row counts. */
function memoryPendingSince(db: DatabaseSync, scopeId: string | null, memo: MemoryMemo): number | null {
  // the window of a revoke whose flow is not proven narrower: memory_deny_pending('*') and memory_deny_pending_scope('*') (all scopes)
  if (memo.every === undefined) {
    const threads = num(one(db, `SELECT since_lsn FROM memory_deny_pending WHERE thread_id=? AND ${NOT_AUDIENCE_ONLY} ORDER BY since_lsn LIMIT 1`, PENDING_ALL_THREADS)?.since_lsn);
    const scopes = num(one(db, `SELECT since_lsn FROM memory_deny_pending_scope WHERE scope_id=? AND ${NOT_AUDIENCE_ONLY} ORDER BY since_lsn LIMIT 1`, PENDING_ALL_SCOPES)?.since_lsn);
    memo.every = threads === null ? scopes : scopes === null ? threads : Math.min(threads, scopes);
  }
  let scoped: number | null;
  if (scopeId === null) {
    // an object with no scope (a Murage object: a note, a card, a summary, a skill, a file; or a ref whose scope is not known) is reached
    // through carries from threads and scopes alike: while ANY revoke is pending it reads "checking" (fail closed, never a guess)
    if (memo.anyScope === undefined) memo.anyScope = Boolean(one(db, `SELECT 1 AS x FROM memory_deny_pending_scope WHERE ${NOT_AUDIENCE_ONLY} LIMIT 1`)) || Boolean(one(db, `SELECT 1 AS x FROM memory_deny_pending WHERE ${NOT_AUDIENCE_ONLY} LIMIT 1`));
    scoped = memo.anyScope ? 0 : null;
  } else if (memo.scopes.has(scopeId)) scoped = memo.scopes.get(scopeId)!;
  else { scoped = num(one(db, `SELECT since_lsn FROM memory_deny_pending_scope WHERE scope_id=? AND ${NOT_AUDIENCE_ONLY} ORDER BY since_lsn LIMIT 1`, scopeId)?.since_lsn); memo.scopes.set(scopeId, scoped); }
  return scoped === null ? memo.every : memo.every === null ? scoped : Math.min(scoped, memo.every);
}

// ---- created lsn of a record or source version (1.0.7 memory-recall-hydration D1, D2) ----
//
// DESIGN-WRITETIME 1: an object is held "checking" by a pending window only when since <= its created lsn. The created lsn is the stamp of
// THE VERSION READ (an unversioned ref reads its latest version's), from memory_record_lsn (v10 S3) and memory_source_lsn (v13). A version
// with no stamp row predates its table, and its created lsn is at most a known bound, used in its place (a bound never shows an object a
// window could have tainted: since <= bound holds for every since <= the true created lsn). No bound known: null, "checking". Each read is
// one primary-key seek, made only when a pending window covers the object's scope.

/** A record version with no memory_record_lsn row was made before v10: its created lsn is at most lineage_upgrade_lsn (the first lsn 1.0.2
 * wrote). Read once per lookup; no key: null (unknown, "checking"). */
function recordUnstampedBound(db: DatabaseSync, memo: MemoryMemo): number | null {
  if (memo.upgradeLsn === undefined) memo.upgradeLsn = num(one(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='lineage_upgrade_lsn'")?.value);
  return memo.upgradeLsn;
}
/** The created lsn of record version (id, version): its stamp, or the pre-v10 bound. */
function recordCreated(db: DatabaseSync, id: string, version: number, memo: MemoryMemo): number | null {
  const stamp = one(db, "SELECT created_lsn AS c FROM memory_record_lsn WHERE id=? AND version=?", id, version);
  return stamp ? num(stamp.c) : recordUnstampedBound(db, memo);
}
/** The first source stamp per database handle, kept while the schema is unchanged (PRAGMA schema_version: a downgrade and re-upgrade on one
 * handle starts the table empty again, and the old floor would then be too low a bound). */
const sourceFloors = new WeakMap<DatabaseSync, { cookie: number; floor: number }>();
/** v13: every source version inserted since the migration is stamped (memory_source_lsn_insert), so one without a row predates the first
 * stamp: its created lsn is at most min(created_lsn), or, with no stamp yet, the lsn counter now. The first non-null minimum can only stay
 * or rise as stamps are added, so it is kept per handle; with no stamp yet it is read per lookup. */
function sourceUnstampedBound(db: DatabaseSync): number | null {
  const cookie = Number(one(db, "PRAGMA schema_version")?.schema_version);
  const known = sourceFloors.get(db);
  if (known && known.cookie === cookie) return known.floor;
  const floor = num(one(db, "SELECT min(created_lsn) AS m FROM memory_source_lsn")?.m);
  if (floor !== null) { sourceFloors.set(db, { cookie, floor }); return floor; }
  return num(one(db, "SELECT next FROM memory_lsn WHERE id=1")?.next);
}
/** The created lsn of source revision `version` (0: its latest revision): its stamp, or the pre-v13 bound. */
function sourceCreated(db: DatabaseSync, id: string, version: number): number | null {
  const stamp = version
    ? one(db, "SELECT created_lsn AS c FROM memory_source_lsn WHERE source_id=? AND revision=?", id, version)
    : one(db, "SELECT l.created_lsn AS c FROM memory_source_versions v LEFT JOIN memory_source_lsn l ON l.source_id=v.source_id AND l.revision=v.revision WHERE v.source_id=? ORDER BY v.revision DESC LIMIT 1", id);
  return stamp && stamp.c !== null && stamp.c !== undefined ? num(stamp.c) : sourceUnstampedBound(db);
}

function memoryVerdict(db: DatabaseSync, ref: MemoryRef, memo: MemoryMemo): LineageVerdict {
  const version = ref.version ?? 0;
  const batched = ref.kind === "record" && version ? memo.records.get(memoryRefKey(ref)) : undefined;
  if (batched !== undefined) {
    if (batched === null) return withheld("tombstone");
    if (Number(batched.marked)) return withheld("deny-memory");
    if (Number(batched.tomb)) return withheld("tombstone");
    const anchored = recordAnchorVerdict(db, ref.id, version, memo);
    if (anchored) return anchored;
    return memoryScopeVerdict(db, String(batched.scope_id), () => Number(batched.stamped) ? num(batched.stamp) : recordUnstampedBound(db, memo), memo);
  }
  const marked = version
    ? one(db, `SELECT 1 AS x FROM memory_deny_memory WHERE kind=? AND id=? AND version IN (0,?) AND ${NOT_AUDIENCE_MEMORY} LIMIT 1`, ref.kind, ref.id, version)
    : one(db, `SELECT 1 AS x FROM memory_deny_memory WHERE kind=? AND id=? AND ${NOT_AUDIENCE_MEMORY} LIMIT 1`, ref.kind, ref.id);
  if (marked) return withheld("deny-memory");
  let scopeId: string | null = ref.scopeId ?? null, created: () => number | null = () => null;
  if (ref.kind === "record") {
    const row = version ? one(db, "SELECT version,scope_id FROM memory_records WHERE id=? AND version=?", ref.id, version) : one(db, "SELECT version,scope_id FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1", ref.id);
    if (!row) return withheld("tombstone");
    // the version read: an unversioned ref is its latest version, and that version's stamp decides (never the earliest's)
    const read = Number(row.version);
    scopeId = String(row.scope_id); created = () => recordCreated(db, ref.id, read, memo);
    const tomb = version
      ? one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1", ref.id, version)
      : one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? LIMIT 1", ref.id);
    if (tomb) return withheld("tombstone");
    const anchored = recordAnchorVerdict(db, ref.id, Number(row.version), memo);
    if (anchored) return anchored;
  } else if (ref.kind === "source") {
    const row = one(db, `SELECT s.scope_id,s.state,s.kind,s.content_hash,s.thread_id,s.message_id,${DENIED_SOURCE("s")} AS denied FROM memory_sources s WHERE s.id=?`, ref.id);
    if (!row) return withheld("tombstone");
    scopeId = String(row.scope_id); created = () => sourceCreated(db, ref.id, version);
    if (row.state === "deleted") return withheld("tombstone");
    if (Number(row.denied)) return withheld("scope-deny");
    // revbound r3 A6: an import admitted while its hash tombstone was still on the way is refused once the tombstone is there (one seek on
    // the tombstones' unique index, then the scope's forgotten import hashes)
    if (row.kind === "legacy-import" && one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=? LIMIT 1", scopeId, String(row.content_hash))) return withheld("tombstone");
    const tomb = version
      ? one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1", ref.id, version)
      : one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1", ref.id);
    if (tomb) return withheld("tombstone");
    // rule 24: a source anchored at a Murage-voice message (a legacy capture, rule 22) is withheld at every revision
    if (murageAnchor(db, row.thread_id as string | null, row.message_id as string | null)) return withheld("murage-anchor");
    // revbound r3 A2: while a revoke is in flight, a source supporting a record the owner forgot is forgotten with it (the forget tombstones
    // only the newest supporting sources in its commit). Bounded fan-in; past it the source reads "checking" until the job has marked it.
    if (revokeInFlight(db, memo)) {
      const citing = all(db, "SELECT record_id,record_version FROM memory_evidence_by_source WHERE source_id=? LIMIT ?", ref.id, SUPPORT_FAN_IN + 1);
      for (const cite of citing.slice(0, SUPPORT_FAN_IN)) {
        // only a forget takes the record's supporting sources with it (forget.ts, memory-revocation.ts 'forgotten-supporting-source'):
        // an archive, a correction or a derived mark does not
        if (one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?) AND reason='owner-forget' LIMIT 1", String(cite.record_id), Number(cite.record_version))) return withheld("tombstone");
      }
      if (citing.length > SUPPORT_FAN_IN) return checking("pending");
    }
  } else if (ref.kind === "lesson") {
    const cols = `id${hasCreatedLsn(db, "memory_lessons") ? ",created_lsn" : ""}`;
    const row = version ? one(db, `SELECT ${cols} FROM memory_lessons WHERE id=? AND version=?`, ref.id, version) : one(db, `SELECT ${cols} FROM memory_lessons WHERE id=? ORDER BY version DESC LIMIT 1`, ref.id);
    if (!row) return withheld("tombstone");
    const lesson = num(row.created_lsn);
    created = () => lesson;
  }
  return memoryScopeVerdict(db, scopeId, created, memo);
}
/** One step of the rule 23 walk, one statement per record: the records it was derived from (memory_derivations_child, columns a and b are
 * parent_id and parent_version), then the distinct anchors its evidence cites (columns a and b are thread_id and message_id; many
 * evidence spans on one message are one anchor), at most
 * RECORD_ANCHORS + 1 rows in all. Each distinct anchor is judged by murageAnchor, the one implementation the source path uses too. A source
 * with no message id names no anchor, as in murageAnchor. */
const ANCHOR_STEP = `SELECT 'parent' AS t, parent_id AS a, parent_version AS b FROM memory_derivations WHERE child_id=?1 AND child_version=?2
  UNION ALL SELECT DISTINCT 'anchor', s.thread_id, s.message_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id
    WHERE e.record_id=?1 AND e.record_version=?2 AND COALESCE(s.message_id,'') <> '' LIMIT ?3`;
/** The step on a file with no messages table (a bare memory database): no source can be anchored there. */
const PARENT_STEP = "SELECT 'parent' AS t, parent_id AS a, parent_version AS b FROM memory_derivations WHERE child_id=?1 AND child_version=?2";
const messagesTable = new WeakSet<DatabaseSync>();
function hasMessages(db: DatabaseSync): boolean {
  if (messagesTable.has(db)) return true;
  const has = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='messages'").get());
  if (has) messagesTable.add(db);
  return has;
}
/** Rule 23: a record is withheld when any source its evidence cites, or any record it was derived from (walked by child through
 * memory_derivations_child), is anchored (murageAnchor: a Murage-voice message, or an anchor that cannot be read). One statement per record
 * walked (ANCHOR_STEP) plus one primary-key seek per distinct anchor; a visited set ends cycles, and past DERIVATION_WALK records or
 * RECORD_ANCHORS rows in one step the answer is "checking". Nothing is written. */
function recordAnchorVerdict(db: DatabaseSync, id: string, version: number, memo: MemoryMemo): LineageVerdict | undefined {
  const start = `${id}\u0000${version}`;
  const known = memo.anchored.get(start);
  if (known !== undefined) return known ?? undefined;
  const visited = new Set<string>([start]);
  const queue: Array<[string, number]> = [[id, version]];
  let verdict: LineageVerdict | null = null;
  while (queue.length) {
    const [recordId, recordVersion] = queue.shift()!;
    const cached = memo.anchored.get(`${recordId}\u0000${recordVersion}`);
    if (cached) { verdict = cached; break; }
    if (cached === null) continue;                                        // walked clean before, in this lookup
    const messages = hasMessages(db);
    const step = messages ? all(db, ANCHOR_STEP, recordId, recordVersion, RECORD_ANCHORS + 1) : all(db, PARENT_STEP, recordId, recordVersion);
    if (step.length > RECORD_ANCHORS) { verdict = checking("pending"); break; }
    const anchors = new Map<string, [string | null, string]>();
    for (const row of step) if (row.t === "anchor") anchors.set(`${String(row.a)}\u0000${String(row.b)}`, [row.a as string | null, String(row.b)]);
    if ([...anchors.values()].some(([threadId, messageId]) => murageAnchor(db, threadId, messageId))) { verdict = withheld("murage-anchor"); break; }
    for (const parent of step) {
      if (parent.t !== "parent") continue;
      const key = `${String(parent.a)}\u0000${Number(parent.b)}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([String(parent.a), Number(parent.b)]);
    }
    if (visited.size > DERIVATION_WALK) { verdict = checking("pending"); break; }
  }
  memo.anchored.set(start, verdict);
  return verdict ?? undefined;
}
/** Rule 23 for a receipt line: the sources and records its disclosure cites (memory_disclosures.source_versions, record_versions). */
function receiptAnchorVerdict(db: DatabaseSync, bundleId: string): LineageVerdict | undefined {
  const row = one(db, "SELECT record_versions,source_versions FROM memory_disclosures WHERE bundle_id=?", bundleId);
  if (!row) return undefined;
  let records: unknown, sources: unknown;
  try { records = JSON.parse(String(row.record_versions)); sources = JSON.parse(String(row.source_versions)); } catch { return checking("lookup-error"); }
  if (!Array.isArray(records) || !Array.isArray(sources)) return checking("lookup-error");
  if (records.length + sources.length > RECEIPT_ANCHORS) return checking("pending");
  for (const source of sources) {
    const sourceId = (source as { id?: unknown } | null)?.id;
    if (typeof sourceId !== "string") return checking("lookup-error");
    const anchor = one(db, "SELECT thread_id,message_id FROM memory_sources WHERE id=?", sourceId);
    if (anchor && murageAnchor(db, anchor.thread_id as string | null, anchor.message_id as string | null)) return withheld("murage-anchor");
  }
  const memo: MemoryMemo = { scopes: new Map(), denied: new Map(), records: new Map(), anchored: new Map() };
  for (const record of records) {
    const recordId = (record as { id?: unknown } | null)?.id, recordVersion = (record as { version?: unknown } | null)?.version;
    if (typeof recordId !== "string" || typeof recordVersion !== "number") return checking("lookup-error");
    const verdict = recordAnchorVerdict(db, recordId, recordVersion, memo);
    if (verdict) return verdict;
  }
  return undefined;
}
/** The scope's deny row, then the pending window: "checking" when since <= the created lsn (unknown = checking). The created lsn is read
 * only when a window covers the scope. */
function memoryScopeVerdict(db: DatabaseSync, scopeId: string | null, createdLsn: () => number | null, memo: MemoryMemo): LineageVerdict {
  if (scopeId !== null && scopeDenied(db, scopeId, memo)) return withheld("scope-deny");
  const since = memoryPendingSince(db, scopeId, memo);
  if (since === null) return SHOWN;
  const created = createdLsn();
  if (created === null || since <= created) return checking("pending");
  return SHOWN;
}
/** Reads every versioned record ref in one statement: a primary-key seek, one deny_memory seek, one tombstone seek and one stamp seek
 * (memory_record_lsn, the version's created lsn) per ref. */
function batchRecords(db: DatabaseSync, refs: readonly MemoryRef[], memo: MemoryMemo): void {
  const wanted = [...new Map(refs.filter(ref => ref.kind === "record" && ref.version).map(ref => [memoryRefKey(ref), ref])).values()];
  for (let at = 0; at < wanted.length; at += BATCH) {
    const slice = wanted.slice(at, at + BATCH);
    for (const ref of slice) memo.records.set(memoryRefKey(ref), null);
    const rows = all(db, `SELECT r.id,r.version,r.scope_id,l.created_lsn AS stamp,l.id IS NOT NULL AS stamped,
        EXISTS (SELECT 1 FROM memory_deny_memory dm WHERE dm.kind='record' AND dm.id=r.id AND dm.version IN (0,r.version) AND dm.${NOT_AUDIENCE_ONLY} AND dm.revoke_id<>${AUDIENCE_COALESCED}) AS marked,
        EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version)) AS tomb
      FROM json_each(?) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
      LEFT JOIN memory_record_lsn l ON l.id=r.id AND l.version=r.version`, JSON.stringify(slice.map(ref => [ref.id, ref.version])));
    for (const row of rows) memo.records.set(memoryRefKey({ kind: "record", id: String(row.id), version: Number(row.version) }), row);
  }
}

/** The verdict for memory objects (records, sources, lessons, claims), keyed by memoryRefKey. */
export function memoryLookup(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader): Map<string, LineageVerdict> {
  void reader; // a memory object's own facts and marks are the same for every reader; scope access is the caller's assertMemoryAccess
  const out = new Map<string, LineageVerdict>();
  const memo: MemoryMemo = { scopes: new Map(), denied: new Map(), records: new Map(), anchored: new Map() };
  try { batchRecords(db, refs, memo); } catch { memo.records.clear(); } // each ref is then read on its own, and an error there is "checking"
  for (const ref of refs) {
    const key = memoryRefKey(ref);
    if (out.has(key)) continue;
    try { out.set(key, memoryVerdict(db, ref, memo)); }
    catch { out.set(key, checking("lookup-error")); }
  }
  return out;
}

// ---- sessions ----

/** The v6-v9 session root set id (memory-revocation.ts marks a forgotten one), or undefined when the session has none or the table was handed
 * back (root-set-reclaim.ts drops it once the backfill certified the file; a missing table is no finding). */
function sessionRootSet(db: DatabaseSync, session: SessionKey): string | undefined {
  try { const id = one(db, "SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?", session.threadId, session.driverInstance, session.nativeSession)?.set_id; return id === undefined || id === null ? undefined : String(id); }
  catch (error) { if (error instanceof Error && /no such table/.test(error.message)) { statementCache.get(db)?.clear(); return undefined; } throw error; }
}

/** S6 rules 27 and 29: a retained session is admitted only when its row carries a door epoch stamp at or above the file's reader_door_epoch.
 * No row, a NULL stamp (written by an older build, or by a resumed turn) or one below the key reads withheld("door-epoch"): the session
 * resets once, and the next start is fresh and stamped. Two primary-key seeks; runs before every lineageLive test, so a file with no line
 * rows still resets every retained session once. Nothing is written. */
export function doorEpochVerdict(db: DatabaseSync, session: SessionKey): LineageVerdict {
  try {
    const row = one(db, "SELECT door_epoch FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?", session.threadId, session.driverInstance, session.nativeSession);
    const epoch = one(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch'");
    if (!row || row.door_epoch === null || row.door_epoch === undefined || !epoch || Number(row.door_epoch) < Number(epoch.value)) return withheld("door-epoch");
    return SHOWN;
  } catch { return withheld("door-epoch"); }
}

/** The verdict for a retained session (deny_session, rs-forgotten, memorySessionRevoked, pending). Not shown = the session resets.
 * A content reader (audience null: the owner's own direct chat) judges the session by content, as its replay does (disclosures.ts
 * filterDirectReplay, 1.0.1.1): an audience-only revoke (a receipt flipped by a roster or settings change, memory_revoke_audience) changes
 * what other audiences may be shown, never what the owner's own chat holds, so its deny_session marks, its pending window and its receipt
 * flips do not reset the session, and the session's own receipts are judged on state, policy and epoch by the continuation check that runs
 * next (fullContinuationCheck). Counted here, one install-wide revoke reset the owner's session on every turn and every fresh session was
 * marked again (1.0.2 Keep all P0). An audience reader keeps every mark. */
export function sessionLookup(db: DatabaseSync, session: SessionKey, reader: LineageReader): LineageVerdict {
  const content = reader.audience === null;
  try {
    const { threadId, driverInstance, nativeSession } = session;
    if (threadDenied(db, threadId)) return withheld("thread-deny");
    if (one(db, `SELECT 1 AS x FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=?${content ? ` AND ${NOT_AUDIENCE_ONLY}` : ""} LIMIT 1`, threadId, driverInstance, nativeSession)) return withheld("deny-session");
    // memory-revocation.ts FORGOTTEN_SESSION_SET: a forget ended a source of this thread while the session was retained
    // (a file whose root sets were handed back has no such table: deny_session holds what a forget marked since the backfill)
    if (sessionRootSet(db, session) === "rs-forgotten") return withheld("session-forgotten");
    // memorySessionRevoked, in O(1): revisions and epochs only grow, so the session's oldest receipt is stale exactly when any is; a revoked
    // receipt among the newest few is read directly, an older one has its deny_session mark or its thread's pending row
    const meta = one(db, "SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1");
    const oldest = one(db, "SELECT policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid LIMIT 1", threadId, driverInstance, nativeSession);
    if (oldest && (!meta || oldest.policy_revision !== meta.policy_revision || oldest.deletion_epoch !== meta.deletion_epoch)) return withheld("watermark");
    if (!content && all(db, "SELECT state FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT ?", threadId, driverInstance, nativeSession, SESSION_RECEIPT_PEEK)
      .some(row => row.state === "revoked")) return withheld("deny-session");
    const row = one(db, "SELECT last_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?", threadId, driverInstance, nativeSession);
    if (!row) return checking("no-lineage");
    if (!threadReady(db, threadId)) return checking("thread-not-ready");
    // an audience reader's session resets on any revoke it rests on, audience-only ones included (the RC reset it on a revoked receipt)
    const since = pendingSince(db, threadId, content);
    if (since !== null && since <= Number(row.last_lsn)) return checking("pending");
    return SHOWN;
  } catch { return checking("lookup-error"); }
}

// ---- refs (steer quotes, tool texts, prompt parts) and the send fence ----

/** The strictest verdict over a list of refs (steer quotes, tool texts, prompt parts). An empty list or only `none` refs is shown. A prefix
 * ref (a thread read wholesale) is judged on the thread: deleted, not ready, or pending at or before its head. Its lines were each judged by
 * the reader that rendered them (denyLookup); marks inside the prefix are theirs, not the prefix's. */
export function refsLookup(db: DatabaseSync, refs: readonly LineageRef[], reader: LineageReader): LineageVerdict {
  let worst: LineageVerdict = SHOWN;
  try {
    const lines = new Map<string, string[]>();
    const shownLines = new Map<string, Set<string>>();
    // lines a non-owner audience reader's prefix showed: judged again by that same audience reader (watermark and audience-only marks included),
    // since they were rendered under it (1.0.4 audit 01-B2: a content recheck let a stale transcript through once the revoke's pending rows were tidied)
    const audienceShown = new Map<string, Set<string>>();
    const memory: MemoryRef[] = [];
    for (const ref of refs) {
      // a replayed line of the prompt's own thread is judged by content, as a prefix's shown lines are (below); every other line for the reader
      if (ref.kind === "line" && (ref.replay || ref.copyOfShown)) { const set = shownLines.get(ref.threadId) ?? new Set<string>(); set.add(ref.messageId); shownLines.set(ref.threadId, set); }
      else if (ref.kind === "line") { const list = lines.get(ref.threadId) ?? []; list.push(ref.messageId); lines.set(ref.threadId, list); }
      else if (ref.kind === "memory") memory.push(ref.ref);
      else if (ref.kind === "prefix") {
        worst = worstVerdict(worst, prefixVerdict(db, ref.threadId, ref.headLsn, reader.audience === null || ref.content === true));
        if (ref.shown?.length) {
          const target = reader.audience === null || ref.content === true ? shownLines : audienceShown;
          const set = target.get(ref.threadId) ?? new Set<string>(); for (const id of ref.shown) set.add(id); target.set(ref.threadId, set);
        }
      }
      else if (ref.kind === "receipt") worst = worstVerdict(worst, receiptVerdict(db, ref, reader));
      if (worst.state === "withheld") return worst;
    }
    for (const [threadId, ids] of lines) {
      for (const verdict of lookupPage(db, threadId, ids.map(messageId => ({ messageId, author: "generated" as const })), reader, true).values()) worst = worstVerdict(worst, verdict);
      if (worst.state === "withheld") return worst;
    }
    // the lines a prefix part showed: their marks, as of now. Judged as a content reader judged them when the prompt was built (the owner's
    // own chat reads content; the reader-relative rules, watermark and footprint, were applied then): a mark, a pending revoke, a flag, a
    // forgotten source or a deleted conversation.
    for (const [threadId, ids] of shownLines) {
      for (const verdict of lookupPage(db, threadId, [...ids].map(messageId => ({ messageId, author: "generated" as const })), contentReader(reader), true).values()) worst = worstVerdict(worst, verdict);
      if (worst.state === "withheld") return worst;
    }
    for (const [threadId, ids] of audienceShown) {
      for (const verdict of lookupPage(db, threadId, [...ids].map(messageId => ({ messageId, author: "generated" as const })), reader, true).values()) worst = worstVerdict(worst, verdict);
      if (worst.state === "withheld") return worst;
    }
    for (const verdict of memoryLookup(db, memory, reader).values()) worst = worstVerdict(worst, verdict);
    return worst;
  } catch { return worstVerdict(worst, checking("lookup-error")); }
}
function prefixVerdict(db: DatabaseSync, threadId: string, headLsn: number | undefined, content: boolean): LineageVerdict {
  if (threadDenied(db, threadId)) return withheld("thread-deny");
  if (!threadReady(db, threadId)) return checking("thread-not-ready");
  const since = pendingSince(db, threadId, content);
  if (since !== null && (headLsn === undefined || since <= headLsn)) return checking("pending");
  return SHOWN;
}
function receiptVerdict(db: DatabaseSync, ref: Extract<LineageRef, { kind: "receipt" }>, reader: LineageReader): LineageVerdict {
  const row = one(db, "SELECT d.state,d.policy_revision,d.deletion_epoch,m.policy_revision AS p,m.deletion_epoch AS e FROM memory_disclosures d, memory_meta m WHERE m.id=1 AND d.bundle_id=?", ref.bundleId);
  if (!row) return checking("lookup-error");
  if (row.state === "revoked") return withheld("deny-memory");
  const anchored = receiptAnchorVerdict(db, ref.bundleId);
  if (anchored) return anchored;
  const audience = reader.audience;
  if (audience) {
    if (row.policy_revision !== row.p || row.deletion_epoch !== row.e || ref.lsn < watermark(db)) return withheld("watermark");
    if (!audience.owner) {
      if (ref.scopeIds.length > 32) return checking("footprint-wide");
      const scopes = new Set(audience.scopeIds);
      if (!ref.scopeIds.every(scope => scopes.has(scope))) return withheld("footprint");
    }
  }
  return SHOWN;
}

/** The send fence (driver submission and steer): shown when deny_generation has not moved since the prompt was built, or when it moved
 * and every part still reads shown; otherwise the prompt is rebuilt (DESIGN-WRITETIME 3, "Prompt vs send race"). A prompt built with no
 * known generation (-1) is always re-checked; an unreadable generation is "checking". */
export function fenceVerdict(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader): LineageVerdict {
  // a part that names nothing (not even none(reason)) is unaccounted for: never written. A prompt resting only on none(reason) parts holds
  // nothing stored that a revoke could reach.
  if (built.parts.some(part => !part.lineageOf.length)) return checking("no-lineage");
  if (built.parts.every(part => part.lineageOf.every(ref => ref.kind === "none"))) return SHOWN;
  const now = denyGeneration(db);
  if (now < 0) return checking("lookup-error");
  if (generationUnchanged(db, built, now)) return fenceUnchanged(db, built, reader);
  return refsLookup(db, built.parts.flatMap(part => part.lineageOf), reader);
}
/** The content reader derived from another (LINEAGE-DESIGN-S6 15c): content checks only, carrying the judge (ownFlag) of the reader the
 * build used, never rebuilt. The only place deny-read.ts derives a reader. */
export function contentReader(reader: LineageReader): LineageReader {
  return { audience: null, ownFlag: reader.ownFlag !== false };
}
/** Nothing was revoked since the prompt was built: deny_generation is where it was, or every value it moved through was produced by the
 * building turn's own committed writes (its session row, its lines' carries: BuiltPrompt.ownGenerations). Those hold what the turn carried
 * from now on, above its prompt's head, so they never refuse the turn's own prompt (1.0.2 Keep all P0). Each own value is recorded exactly,
 * in the bump's transaction, so a rolled-back own bump leaves no record and the revoke that reuses its value is looked up (Astra 1.0.3). */
export function generationUnchanged(db: DatabaseSync, built: BuiltPrompt, now: number): boolean {
  if (built.denyGeneration < 0 || now < 0) return false;
  if (built.denyGeneration === now) return true;
  if (now < built.denyGeneration) return false;
  let own = 0;
  try { own = built.ownGenerations?.(db, built.denyGeneration, now) ?? 0; } catch { return false; }
  return own === now - built.denyGeneration;
}
/** The send fence when deny_generation has not moved since the prompt was built. The generation moves at a revoke's commit and at its last
 * mark, not at each mark between: a memory object a running walk denied (a card, a note, a lesson the prompt names) is withheld at once, so
 * its refs are asked again here (seeks per ref). Only a denial refuses: a ref reading "checking" was known to be under a window when the
 * prompt was built, and that window is what the build already withheld around (Astra audit P1 4). */
export function fenceUnchanged(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader): LineageVerdict {
  const memory = built.parts.flatMap(part => part.lineageOf.flatMap(ref => ref.kind === "memory" ? [ref.ref] : []));
  if (!memory.length) return SHOWN;
  for (const verdict of memoryLookup(db, memory, contentReader(reader)).values()) if (verdict.state === "withheld") return verdict;
  return SHOWN;
}

/** memory_lineage_lsn_meta.deny_generation (bumped by every revoke commit and every final marker slice). -1 when it cannot be read. */
export function denyGeneration(db: DatabaseSync): number {
  try { return Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()?.value ?? -1); }
  catch { return -1; }
}

/** Whether write-time lineage is being written on this file: a line row exists (an S1 writer or the backfill wrote one), so a generated
 * line with no row is a real unknown. Until then (no S1 writer yet, an upgraded file before its backfill reaches a line) the S4 readers keep
 * the read-time judge as the only line judge. An lsn alone proves nothing here: a policy or epoch bump, a receipt flip or a capture takes
 * one (the v10 triggers) with no line written. One seek. TRANSITIONAL: S6 deletes the read-time judge and this gate with it. */
export function lineageLive(db: DatabaseSync): boolean {
  try { return Boolean(db.prepare("SELECT 1 AS x FROM memory_line_lineage LIMIT 1").get()); }
  catch { return false; }
}
