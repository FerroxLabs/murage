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

/** The verdict for every line of one page of one thread, by message id, for this reader. Every message id of the page has an entry. */
export function denyLookup(db: DatabaseSync, page: LinePage, reader: LineageReader): Map<string, LineageVerdict> {
  try { return lookupPage(db, page.threadId, page.lines, reader, false); }
  catch { return new Map(page.lines.map(line => [line.messageId, checking("lookup-error")])); }
}

/** `infer`: the authors are not known to the caller (refs): a stored owner line (role user, no generated lineage row) is judged as one. */
function lookupPage(db: DatabaseSync, threadId: string, lines: readonly PageLine[], reader: LineageReader, infer: boolean): Map<string, LineageVerdict> {
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
      stored.set(String(row.id), { role: String(row.role), flagged: flag !== null && flag !== undefined && flag !== 0 && flag !== "false" });
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
    if (row.flagged || callerFlag.get(id)) { out.set(id, withheld("own-flag")); continue; }
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
  const since = pendingSince(db, threadId, content);
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
  const mark = audience && withRows.some(id => lineage.get(id)!.memLsn !== null) ? watermark(db) : null;
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
      else if (since !== null && since <= lin.lsn) verdict = worstVerdict(verdict, checking("pending"));
    }
    out.set(id, verdict);
  }
  return out;
}

// ---- memory objects ----

/** created_lsn, when S3 adds it to a memory table (the pending-scope gate compares it with since_lsn); absent = unknown = "checking". */
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
  /** Versioned record refs read in one statement (row, its deny_memory mark, its tombstone), by memoryRefKey; null = no such version. */
  records: Map<string, Row | null> }
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

function memoryVerdict(db: DatabaseSync, ref: MemoryRef, memo: MemoryMemo): LineageVerdict {
  const version = ref.version ?? 0;
  const batched = ref.kind === "record" && version ? memo.records.get(memoryRefKey(ref)) : undefined;
  if (batched !== undefined) {
    if (batched === null) return withheld("tombstone");
    if (Number(batched.marked)) return withheld("deny-memory");
    if (Number(batched.tomb)) return withheld("tombstone");
    return memoryScopeVerdict(db, String(batched.scope_id), num(batched.created_lsn), memo);
  }
  const marked = version
    ? one(db, `SELECT 1 AS x FROM memory_deny_memory WHERE kind=? AND id=? AND version IN (0,?) AND ${NOT_AUDIENCE_ONLY} LIMIT 1`, ref.kind, ref.id, version)
    : one(db, `SELECT 1 AS x FROM memory_deny_memory WHERE kind=? AND id=? AND ${NOT_AUDIENCE_ONLY} LIMIT 1`, ref.kind, ref.id);
  if (marked) return withheld("deny-memory");
  let scopeId: string | null = ref.scopeId ?? null, created: number | null = null;
  if (ref.kind === "record") {
    const cols = `scope_id${hasCreatedLsn(db, "memory_records") ? ",created_lsn" : ""}`;
    const row = version ? one(db, `SELECT ${cols} FROM memory_records WHERE id=? AND version=?`, ref.id, version) : one(db, `SELECT ${cols} FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1`, ref.id);
    if (!row) return withheld("tombstone");
    scopeId = String(row.scope_id); created = num(row.created_lsn);
    const tomb = version
      ? one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1", ref.id, version)
      : one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? LIMIT 1", ref.id);
    if (tomb) return withheld("tombstone");
  } else if (ref.kind === "source") {
    const cols = `s.scope_id,s.state,s.kind,s.content_hash,${DENIED_SOURCE("s")} AS denied${hasCreatedLsn(db, "memory_sources") ? ",s.created_lsn" : ""}`;
    const row = one(db, `SELECT ${cols} FROM memory_sources s WHERE s.id=?`, ref.id);
    if (!row) return withheld("tombstone");
    scopeId = String(row.scope_id); created = num(row.created_lsn);
    if (row.state === "deleted") return withheld("tombstone");
    if (Number(row.denied)) return withheld("scope-deny");
    // revbound r3 A6: an import admitted while its hash tombstone was still on the way is refused once the tombstone is there (one seek on
    // the tombstones' unique index, then the scope's forgotten import hashes)
    if (row.kind === "legacy-import" && one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=? LIMIT 1", scopeId, String(row.content_hash))) return withheld("tombstone");
    const tomb = version
      ? one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1", ref.id, version)
      : one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1", ref.id);
    if (tomb) return withheld("tombstone");
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
    created = num(row.created_lsn);
  }
  return memoryScopeVerdict(db, scopeId, created, memo);
}
/** The scope's deny row, then the pending window (created lsn unknown = checking). */
function memoryScopeVerdict(db: DatabaseSync, scopeId: string | null, created: number | null, memo: MemoryMemo): LineageVerdict {
  if (scopeId !== null && scopeDenied(db, scopeId, memo)) return withheld("scope-deny");
  const since = memoryPendingSince(db, scopeId, memo);
  if (since !== null && (created === null || since <= created)) return checking("pending");
  return SHOWN;
}
/** Reads every versioned record ref in one statement: a primary-key seek, one deny_memory seek and one tombstone seek per ref. */
function batchRecords(db: DatabaseSync, refs: readonly MemoryRef[], memo: MemoryMemo): void {
  const wanted = [...new Map(refs.filter(ref => ref.kind === "record" && ref.version).map(ref => [memoryRefKey(ref), ref])).values()];
  for (let at = 0; at < wanted.length; at += BATCH) {
    const slice = wanted.slice(at, at + BATCH);
    for (const ref of slice) memo.records.set(memoryRefKey(ref), null);
    const rows = all(db, `SELECT r.id,r.version,r.scope_id${hasCreatedLsn(db, "memory_records") ? ",r.created_lsn" : ""},
        EXISTS (SELECT 1 FROM memory_deny_memory dm WHERE dm.kind='record' AND dm.id=r.id AND dm.version IN (0,r.version) AND dm.${NOT_AUDIENCE_ONLY}) AS marked,
        EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version)) AS tomb
      FROM json_each(?) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')`, JSON.stringify(slice.map(ref => [ref.id, ref.version])));
    for (const row of rows) memo.records.set(memoryRefKey({ kind: "record", id: String(row.id), version: Number(row.version) }), row);
  }
}

/** The verdict for memory objects (records, sources, lessons, claims), keyed by memoryRefKey. */
export function memoryLookup(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader): Map<string, LineageVerdict> {
  void reader; // a memory object's own facts and marks are the same for every reader; scope access is the caller's assertMemoryAccess
  const out = new Map<string, LineageVerdict>();
  const memo: MemoryMemo = { scopes: new Map(), denied: new Map(), records: new Map() };
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

/** The verdict for a retained session (deny_session, rs-forgotten, memorySessionRevoked, pending). Not shown = the session resets. */
export function sessionLookup(db: DatabaseSync, session: SessionKey, reader: LineageReader): LineageVerdict {
  void reader;
  try {
    const { threadId, driverInstance, nativeSession } = session;
    if (threadDenied(db, threadId)) return withheld("thread-deny");
    if (one(db, "SELECT 1 AS x FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1", threadId, driverInstance, nativeSession)) return withheld("deny-session");
    // memory-revocation.ts FORGOTTEN_SESSION_SET: a forget ended a source of this thread while the session was retained
    // (a file whose root sets were handed back has no such table: deny_session holds what a forget marked since the backfill)
    if (sessionRootSet(db, session) === "rs-forgotten") return withheld("session-forgotten");
    // memorySessionRevoked, in O(1): revisions and epochs only grow, so the session's oldest receipt is stale exactly when any is; a revoked
    // receipt among the newest few is read directly, an older one has its deny_session mark or its thread's pending row
    const meta = one(db, "SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1");
    const oldest = one(db, "SELECT policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid LIMIT 1", threadId, driverInstance, nativeSession);
    if (oldest && (!meta || oldest.policy_revision !== meta.policy_revision || oldest.deletion_epoch !== meta.deletion_epoch)) return withheld("watermark");
    if (all(db, "SELECT state FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT ?", threadId, driverInstance, nativeSession, SESSION_RECEIPT_PEEK)
      .some(row => row.state === "revoked")) return withheld("deny-session");
    const row = one(db, "SELECT last_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?", threadId, driverInstance, nativeSession);
    if (!row) return checking("no-lineage");
    if (!threadReady(db, threadId)) return checking("thread-not-ready");
    const since = pendingSince(db, threadId, false); // a session resets on any revoke it rests on, audience-only ones included (the RC reset it on a revoked receipt)
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
    const memory: MemoryRef[] = [];
    for (const ref of refs) {
      if (ref.kind === "line") { const list = lines.get(ref.threadId) ?? []; list.push(ref.messageId); lines.set(ref.threadId, list); }
      else if (ref.kind === "memory") memory.push(ref.ref);
      else if (ref.kind === "prefix") {
        worst = worstVerdict(worst, prefixVerdict(db, ref.threadId, ref.headLsn, reader.audience === null));
        if (ref.shown?.length) { const set = shownLines.get(ref.threadId) ?? new Set<string>(); for (const id of ref.shown) set.add(id); shownLines.set(ref.threadId, set); }
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
      for (const verdict of lookupPage(db, threadId, [...ids].map(messageId => ({ messageId, author: "generated" as const })), { audience: null }, true).values()) worst = worstVerdict(worst, verdict);
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
  if (built.denyGeneration >= 0 && built.denyGeneration === now) return fenceUnchanged(db, built);
  return refsLookup(db, built.parts.flatMap(part => part.lineageOf), reader);
}
/** The send fence when deny_generation has not moved since the prompt was built. The generation moves at a revoke's commit and at its last
 * mark, not at each mark between: a memory object a running walk denied (a card, a note, a lesson the prompt names) is withheld at once, so
 * its refs are asked again here (seeks per ref). Only a denial refuses: a ref reading "checking" was known to be under a window when the
 * prompt was built, and that window is what the build already withheld around (Astra audit P1 4). */
export function fenceUnchanged(db: DatabaseSync, built: BuiltPrompt): LineageVerdict {
  const memory = built.parts.flatMap(part => part.lineageOf.flatMap(ref => ref.kind === "memory" ? [ref.ref] : []));
  if (!memory.length) return SHOWN;
  for (const verdict of memoryLookup(db, memory, { audience: null }).values()) if (verdict.state === "withheld") return verdict;
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
