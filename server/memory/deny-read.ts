import { anchorRevokesSql, evidenceRevokesSql, recordImpliedSql, sourceImpliedSql } from "./deny-rule.ts";
import { assertRecallView, recallViewHasScope } from './recall-view.ts';
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
import { livePassLookup } from "./eligibility-pass.ts";
import { DENIED_SOURCE } from "./deny.ts";
import { threadNo } from "./thread-no.ts";
import { murageAnchor, murageAnchorOf } from "../murage-anchor.ts";
import { FOOTPRINT_STAR, memoryRefKey, PENDING_ALL_SCOPES, PENDING_ALL_THREADS, worstVerdict, type BuiltPrompt, type CheckingReason, type DenyReason, type LineageReader, type LineageRef,
  type LinePage, type LineageVerdict, type MemoryRef, type PageLine, type SessionKey } from "./lineage-types.ts";
import { AUDIENCE_COALESCED, readsSettledView } from "./lineage-types.ts";
import { normalizeRetainedRefs, prefixLineJudge } from "./retained-refs.ts";
import { accountedPrepare, chargeReleaseWork } from "./release-budget.ts";
import { createHash } from "node:crypto";
import { memoVersion } from "./revoke-wake.ts";
import { prepareWindowSummary, summaryWindow, type PendingTable } from "./window-summary.ts";

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
  if (!statement) { statement = accountedPrepare(db, sql); byText.set(sql, statement); }
  meter.statements++; meter.sql.add(sql);
  return statement;
}
type Row = Record<string, unknown>;
function one(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row | undefined {
  const row = prepared(db, sql).get(...args) as Row | undefined;
  if (row) { meter.rows++; }
  return row;
}
function all(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] {
  const rows = prepared(db, sql).all(...args) as Row[];
  meter.rows += rows.length;
  return rows;
}
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function rawMarks(db: DatabaseSync, sql: string, args: Array<string | number>, content: boolean, skipCoalesced = false): Row[] {
  const rows = all(db, `${sql} LIMIT ?`, ...args, RANGE_READ_LIMIT + 1);
  if (rows.length > RANGE_READ_LIMIT) throw new Error("MEMORY_MARK_READ_LIMIT");
  return content ? rows.filter(row => (!skipCoalesced || Number(row.revoke_id) !== AUDIENCE_COALESCED) && !audienceOnly(db, row.revoke_id)) : rows;
}
/** The deny rule's rows for one object (deny-rule.ts: anchorRevokesSql, evidenceRevokesSql) for a content reader: 1 = one of them is a
 * content mark, -1 = more rows than one read takes and none of those read is one (unknown), 0 = none. Metered as every read here. */
function ruleMarks(db: DatabaseSync, sql: string, args: Array<string | number>): 1 | 0 | -1 {
  const rows = all(db, sql, ...args);
  if (rows.some(row => Number(row.revoke_id) !== AUDIENCE_COALESCED && !audienceOnly(db, row.revoke_id))) return 1;
  return rows.length > RANGE_READ_LIMIT ? -1 : 0;
}

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
/** The lowest since_lsn of any pending revoke covering this thread (its own rows and the `*` rows), or null. Two seeks on the primary key.
 * A content reader skips audience-only revokes, and receipt flips not yet committed (those are audience-only too). */
/** Read raw indexed candidates before audience filtering. Overflow stays held;
 * a LIMIT after the audience predicate could examine the entire backlog. */
function rawPending(db: DatabaseSync, table: PendingTable, key: string | null): Row[] {
  const column = table === "memory_deny_pending" ? "thread_id" : "scope_id";
  return all(db, `WITH raw AS MATERIALIZED (SELECT since_lsn,revoke_id FROM ${table}${key === null ? "" : ` WHERE ${column}=?`} LIMIT ?) SELECT raw.*,j.started_lsn AS c,j.state AS st,EXISTS(SELECT 1 FROM memory_revoke_audience a WHERE a.revoke_id=raw.revoke_id) AS audience_only FROM raw LEFT JOIN memory_revoke_jobs j ON j.revoke_id=raw.revoke_id`, ...(key === null ? [] : [key]), PENDING_READ_LIMIT + 1);
}
function audienceOnly(db: DatabaseSync, revoke: unknown): boolean {
  return Boolean(one(db, "SELECT 1 AS x FROM memory_revoke_audience WHERE revoke_id=?", Number(revoke)));
}
/** One pending window over a thread's generated lines: a line at or after `since` whose turn began before `cap` reads "checking". */
interface PendingWindow { since: number; cap: number }
/** Most pending rows read for one key (a thread's own rows, the `*` rows, a scope's); past it the key's summary answers, or everything is held. */
const PENDING_READ_LIMIT = 256;
/** "Hold everything": every line from lsn 0, whatever its turn. Today's answer past PENDING_READ_LIMIT rows, and the fallback of every unknown. */
const HOLD_EVERYTHING: readonly PendingWindow[] = Object.freeze([Object.freeze({ since: 0, cap: Infinity })]);
/** No window: what a reader of the last settled view (the owner's own turn) is given in place of the pending rows. */
const NO_WINDOWS: readonly PendingWindow[] = Object.freeze([]);

// ---- Memory V2 V5 (MEMORY-V2-DESIGN 4.3): the window reads, memoised; a strict summary past 256 rows ----
// "(1) At most 256 rows on a key: today's exact read and today's per-row rules, memoised per (key, reader kind) under windowsVersion.
//  (2) More than 256 rows: today the reader holds everything. V2 keeps that answer unless a summary exists for the key. [...] No reader
//  ever runs an aggregate over the queue."
// The memo lives per handle and is dropped whenever memoVersion("windows") moves: any write to the pending tables, the flips, the jobs
// or the audience table on this connection, undone or not, and any commit by another connection (memo rules 3.4; revoke-wake.ts).
// Where there is no version (a read-only handle, no TEMP triggers) the version is new on every call and the exact read runs as before.
// The mem-f3 SQL aggregate over up to 4,096 rows (pendingAggregate) is gone from every reader path (AO-H5).
interface WindowsMemo { version: number; raw: Map<string, Row[]>; windows: Map<string, readonly PendingWindow[]>; flips: Map<number, number | null> }
const windowsMemos = new WeakMap<DatabaseSync, WindowsMemo>();
const WINDOWS_MEMO_KEYS = 4096;
function windowsMemo(db: DatabaseSync): WindowsMemo {
  // the summary's TEMP objects before the version read: installed later (at a key's first overflow) they would move the version mid-lookup
  prepareWindowSummary(db);
  const version = memoVersion("windows", db);
  let memo = windowsMemos.get(db);
  if (!memo) { memo = { version, raw: new Map(), windows: new Map(), flips: new Map() }; windowsMemos.set(db, memo); }
  else if (memo.version !== version || memo.raw.size > WINDOWS_MEMO_KEYS || memo.flips.size > WINDOWS_MEMO_KEYS) { memo.version = version; memo.raw.clear(); memo.windows.clear(); memo.flips.clear(); }
  return memo;
}
/** The exact read of one key (rawPending), once per version. */
function pendingRows(db: DatabaseSync, memo: WindowsMemo, table: PendingTable, key: string | null): Row[] {
  const id = `${table === "memory_deny_pending" ? "t" : "s"}${key === null ? "*" : `=${key}`}`;
  let rows = memo.raw.get(id);
  if (!rows) { rows = rawPending(db, table, key); memo.raw.set(id, rows); }
  return rows;
}
/** The windows of one key for one reader kind. At most PENDING_READ_LIMIT rows: one per row this reader counts, capped by the exact
 * rule. Past it: the key's summary window (window-summary.ts: one TEMP seek, never under the rows) or, with none, everything held.
 * The whole-table read (null key) past the limit is "some row is pending": the global count is over 256, so it holds. */
function keyWindows(db: DatabaseSync, memo: WindowsMemo, table: PendingTable, key: string | null, content: boolean): readonly PendingWindow[] {
  const rows = pendingRows(db, memo, table, key);
  if (rows.length > PENDING_READ_LIMIT) {
    // not memoised: a finished build changes the summary without a write to any watched table
    const summary = key === null ? null : summaryWindow(db, table, key);
    return summary ? [summary] : HOLD_EVERYTHING;
  }
  const id = `${content ? "c" : "a"}${table === "memory_deny_pending" ? "t" : "s"}${key === null ? "*" : `=${key}`}`;
  let windows = memo.windows.get(id);
  if (!windows) {
    const made: PendingWindow[] = [];
    for (const row of rows) {
      if (content && Number(row.audience_only)) continue;
      const since = Number(row.since_lsn), cap = num(row.c);
      made.push({ since, cap: cap === null || row.st === "seeding" || since > cap ? Infinity : cap });
    }
    memo.windows.set(id, windows = made);
  }
  return windows;
}
/** The lowest since of the pending rows on one key (null: none this reader counts); past PENDING_READ_LIMIT rows, the summary's, or 0. */
function pendingLowOf(db: DatabaseSync, table: PendingTable, key: string | null, content: boolean, memo: WindowsMemo = windowsMemo(db)): number | null {
  let low: number | null = null;
  for (const window of keyWindows(db, memo, table, key, content)) low = low === null ? window.since : Math.min(low, window.since);
  return low;
}
/** The first queued receipt flip of a thread (audience readers only), once per version. */
function flippedSince(db: DatabaseSync, memo: WindowsMemo, threadId: string, content: boolean): number | null {
  const no = content ? null : threadNo(db, threadId);
  if (no === null) return null;
  let flipped = memo.flips.get(no);
  if (flipped === undefined) { flipped = num(one(db, "SELECT first_lsn FROM memory_receipt_flips WHERE thread_no=? ORDER BY first_lsn LIMIT 1", no)?.first_lsn); memo.flips.set(no, flipped); }
  return flipped;
}
function pendingSince(db: DatabaseSync, threadId: string, content: boolean): number | null {
  const memo = windowsMemo(db);
  const own = pendingLowOf(db, "memory_deny_pending", threadId, content, memo);
  const every = pendingLowOf(db, "memory_deny_pending", PENDING_ALL_THREADS, content, memo);
  const flipped = flippedSince(db, memo, threadId, content);
  return [own, every, flipped].reduce<number | null>((low, value) => value === null ? low : low === null ? value : Math.min(low, value), null);
}
/** The pending windows over a thread's generated lines (lookupPage): its own rows and the `*` rows, each capped at its revoke's commit
 * (memory_revoke_jobs.started_lsn), the cap the marker's ranges and session stage use (revoke-marker.ts: a turn begun after the owner's
 * action is a new turn). A prompt built after the commit has a head (turn_lsn) at or above the cap and was fenced against the revoke
 * (send-fence.ts); a line of such a turn that rests on what the revoke reaches gets its own hold at write (revoke-commit.ts inheritMarks).
 * No cap (fail closed): a bulk still seeding, a row with no job, a hold written after the commit (since past the cap: an inherit hold for a
 * derived post-commit line), a receipt flip not committed yet, and more rows than PENDING_READ_LIMIT with no summary (keyWindows). */
function pendingWindows(db: DatabaseSync, threadId: string, content: boolean): PendingWindow[] {
  const memo = windowsMemo(db);
  const windows: PendingWindow[] = [];
  for (const key of new Set([threadId, PENDING_ALL_THREADS])) windows.push(...keyWindows(db, memo, "memory_deny_pending", key, content));
  const flipped = flippedSince(db, memo, threadId, content);
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
  const verdict = !members ? checking("lookup-error") : [...members].every(scope => lineageAudienceHasScope(db,audience,scope)) ? SHOWN : withheld("footprint");
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
    chargeReleaseWork();
      const flag = row.w;
      // "checking" is never a stored verdict: a row left flagged "checking" on disk (1.0.2, an earlier 1.0.3 process) is read as no note and
      // judged live on its marks and windows below (REPLY-WITHHELD-CONTRACT R2). It once read itself back as "checking" for good (rehearsal 4).
      stored.set(String(row.id), { role: String(row.role), flagged: flag === "checking" ? false : flag !== null && flag !== undefined && flag !== 0 && flag !== "false" });
    }
    // the owner forgot the line (its captured source is deleted, denied or tombstoned at any revision)
    for (const row of all(db, `SELECT s.id FROM memory_sources s WHERE s.id IN (SELECT value FROM json_each(?)) AND (s.state='deleted' OR ${DENIED_SOURCE("s")})`, sourceIds)) forgotten.add(String(row.id).slice(prefix.length));
    for (const row of all(db, "SELECT DISTINCT target_id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?))", sourceIds)) forgotten.add(String(row.target_id).slice(prefix.length));
    // (a generated line is one with a turn_lsn: owner and person lines have none)
    // The primary key starts with thread_no too, but would scan that thread's
    // entire lineage for each page. Require the (thread_no,message_id) seeks.
    if (no !== null) for (const row of all(db, "SELECT message_id,lsn,turn_lsn,mem_lsn,footprint FROM memory_line_lineage INDEXED BY memory_line_lineage_msg WHERE thread_no=? AND message_id IN (SELECT value FROM json_each(?))", no, json))
      lineage.set(String(row.message_id), { lsn: Number(row.lsn), generated: row.turn_lsn !== null && row.turn_lsn !== undefined, turnLsn: num(row.turn_lsn), memLsn: num(row.mem_lsn), footprint: num(row.footprint) });
  }
  const callerFlag = new Map<string, boolean>();
  const callerAuthor = new Map<string, PageLine["author"]>();
  for (const line of lines) {
    chargeReleaseWork();
    if (line.withheldFromBots) callerFlag.set(line.messageId, true);
    // the strictest author any entry gives: generated over person over owner
    if (callerAuthor.get(line.messageId) !== "generated") callerAuthor.set(line.messageId, line.author === "generated" ? "generated" : callerAuthor.get(line.messageId) ?? line.author);
  }
  const generatedIds: string[] = [];
  for (const id of ids) {
    chargeReleaseWork();
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
  // the owner's own turn reads the last settled view: marks only, no window of a walk still in flight (lineage-types.ts LineageReader.settled)
  const windows = readsSettledView(reader) ? NO_WINDOWS : pendingWindows(db, threadId, content);
  const withRows = generatedIds.filter(id => lineage.has(id));
  const denied = new Set<number>();
  let ranges: Array<{ from: number; until: number }> = [], overRanges = false;
  let unknownRangesFrom: number | null = null;
  if (withRows.length) {
    const lsns = withRows.map(id => lineage.get(id)!.lsn);
    for (let at = 0; at < lsns.length; at += BATCH)
      for (const row of rawMarks(db, "SELECT lsn,revoke_id FROM memory_deny_point WHERE thread_id=? AND lsn IN (SELECT value FROM json_each(?))", [threadId, JSON.stringify(lsns.slice(at, at + BATCH))], content)) denied.add(Number(row.lsn));
    const top = Math.max(...lsns);
    const raw = all(db, "SELECT from_lsn,until_turn_lsn,revoke_id FROM memory_deny_range WHERE thread_id=? AND from_lsn<? ORDER BY from_lsn LIMIT ?", threadId, top, RANGE_READ_LIMIT + 1);
    const rows = content ? raw.filter(row => Number(row.revoke_id) !== AUDIENCE_COALESCED && !audienceOnly(db, row.revoke_id)) : raw;
    if (raw.length > RANGE_READ_LIMIT && rows.length <= RANGE_READ_LIMIT) unknownRangesFrom = Number(raw[0]!.from_lsn);
    overRanges = rows.length > RANGE_READ_LIMIT;
    ranges = rows.map(row => ({ from: Number(row.from_lsn), until: Number(row.until_turn_lsn) }));
  }
  const audience = reader.audience;
  // Owner result delivery may ignore policy/epoch age, but remains an audience reader for every revocation and pending mark.
  const mark = audience && !skipPolicyWatermark && withRows.some(id => lineage.get(id)!.memLsn !== null) ? watermark(db) : null;
  const footprints = new Map<number, LineageVerdict>();
  for (const id of generatedIds) {
    chargeReleaseWork();
    const lin = lineage.get(id);
    if (!lin) { out.set(id, checking("no-lineage")); continue; }
    let verdict: LineageVerdict = SHOWN;
    if (denied.has(lin.lsn)) verdict = withheld("deny-line");
    else {
      // a generated line in T is denied when from_lsn < L.lsn AND L.turn_lsn < until_turn_lsn; a line with no turn lsn counts from 0
      const turnLsn = lin.turnLsn ?? 0;
      if (overRanges ? ranges[0]!.from < lin.lsn : ranges.some(range => range.from < lin.lsn && turnLsn < range.until)) verdict = withheld("deny-range");
    }
    if (verdict.state === "shown" && unknownRangesFrom !== null && unknownRangesFrom < lin.lsn) verdict = checking("lookup-error");
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
    has = (accountedPrepare(db, `PRAGMA table_info(${table})`).all() as Row[]).some(column => column.name === "created_lsn");
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
  /** Versioned source refs read in one statement (batchSources), by memoryRefKey: the row has the source's own columns (id null = no such
   *  source), its deny_memory mark, its tombstone at the revision, its stamp and its anchor message. Absent = read on its own. */
  sources: Map<string, Row>;
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
    const threads = pendingLowOf(db, "memory_deny_pending", PENDING_ALL_THREADS, true);
    const scopes = pendingLowOf(db, "memory_deny_pending_scope", PENDING_ALL_SCOPES, true);
    memo.every = threads === null ? scopes : scopes === null ? threads : Math.min(threads, scopes);
  }
  let scoped: number | null;
  if (scopeId === null) {
    // an object with no scope (a Murage object: a note, a card, a summary, a skill, a file; or a ref whose scope is not known) is reached
    // through carries from threads and scopes alike: while ANY revoke is pending it reads "checking" (fail closed, never a guess)
    if (memo.anyScope === undefined) memo.anyScope = pendingLowOf(db, "memory_deny_pending_scope", null, true) !== null || pendingLowOf(db, "memory_deny_pending", null, true) !== null;
    scoped = memo.anyScope ? 0 : null;
  } else if (memo.scopes.has(scopeId)) scoped = memo.scopes.get(scopeId)!;
  else { scoped = pendingLowOf(db, "memory_deny_pending_scope", scopeId, true); memo.scopes.set(scopeId, scoped); }
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
 * or rise as stamps are added, so it is kept per handle; with no stamp yet it is read per lookup. The minimum is one seek on the stamps'
 * created_lsn index (schema.ts SOURCE_LSN_FLOOR_INDEX, made before listen), not a pass over every stamp. */
export const SOURCE_FLOOR_SQL = "SELECT min(created_lsn) AS m FROM memory_source_lsn";
/** Exported for the floor's plan and work tests (source-lsn-floor-index.test.ts). */
export function sourceUnstampedBound(db: DatabaseSync): number | null {
  const cookie = Number(one(db, "PRAGMA schema_version")?.schema_version);
  const known = sourceFloors.get(db);
  if (known && known.cookie === cookie) return known.floor;
  const floor = num(one(db, SOURCE_FLOOR_SQL)?.m);
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

function memoryVerdict(db: DatabaseSync, ref: MemoryRef, memo: MemoryMemo, preparedWindow = false): LineageVerdict {
  const version = ref.version ?? 0;
  const batched = ref.kind === "record" && version ? memo.records.get(memoryRefKey(ref)) : undefined;
  if (batched !== undefined) {
    if (batched === null) return withheld("tombstone");
    // 1.0.23 deny rule (deny-rule.ts): no explicit row, but an evidence source of this version is withheld (its own row, or its anchor line)
    if (Number(batched.marked) === 1 || Number(batched.implied) === 1) return withheld("deny-memory");
    if (Number(batched.marked) === -1 || Number(batched.implied) === -1) return checking("lookup-error");
    if (Number(batched.tomb)) return withheld("tombstone");
    const anchored = recordAnchorVerdict(db, ref.id, version, memo);
    if (anchored) return anchored;
    return memoryScopeVerdict(db, String(batched.scope_id), () => Number(batched.stamped) ? num(batched.stamp) : recordUnstampedBound(db, memo), memo, preparedWindow);
  }
  // a versioned source read by batchSources: the same facts as the seeks below, decided by the same steps
  const fact = ref.kind === "source" && version ? memo.sources.get(memoryRefKey(ref)) : undefined;
  if (fact && Number(fact.marked) === -1 && Number(fact.implied) !== 1) return checking("lookup-error");
  const marked = fact ? Number(fact.marked) : version
    ? rawMarks(db, "SELECT revoke_id FROM memory_deny_object WHERE kind=? AND id=? AND version IN (0,?)", [ref.kind, ref.id, version], true, true).length
    : rawMarks(db, "SELECT revoke_id FROM memory_deny_object WHERE kind=? AND id=?", [ref.kind, ref.id], true, true).length;
  if (marked) return withheld("deny-memory");
  // 1.0.23 deny rule (deny-rule.ts): a source through its anchor line, a record through an evidence source; the content class, as above
  const implied = fact ? Number(fact.implied) : ref.kind === "source" ? ruleMarks(db, anchorRevokesSql("?1"), [ref.id])
    : ref.kind === "record" ? (version ? ruleMarks(db, evidenceRevokesSql("?1", "?2"), [ref.id, version]) : ruleMarks(db, evidenceRevokesSql("?1", null), [ref.id])) : 0;
  if (implied === 1) return withheld("deny-memory");
  if (implied === -1) return checking("lookup-error");
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
    const row = fact ? (fact.id === null || fact.id === undefined ? undefined : fact)
      : one(db, `SELECT s.scope_id,s.state,s.kind,s.content_hash,s.thread_id,s.message_id,${DENIED_SOURCE("s")} AS denied FROM memory_sources s WHERE s.id=?`, ref.id);
    if (!row) return withheld("tombstone");
    scopeId = String(row.scope_id);
    created = fact ? () => (fact.stamp !== null && fact.stamp !== undefined ? num(fact.stamp) : sourceUnstampedBound(db)) : () => sourceCreated(db, ref.id, version);
    if (row.state === "deleted") return withheld("tombstone");
    if (Number(row.denied)) return withheld("scope-deny");
    // revbound r3 A6: an import admitted while its hash tombstone was still on the way is refused once the tombstone is there (one seek on
    // the tombstones' unique index, then the scope's forgotten import hashes)
    if (row.kind === "legacy-import" && one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=? LIMIT 1", scopeId, String(row.content_hash))) return withheld("tombstone");
    const tomb = fact ? Number(fact.tomb) : version
      ? one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1", ref.id, version)
      : one(db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1", ref.id);
    if (tomb) return withheld("tombstone");
    // rule 24: a source anchored at a Murage-voice message (a legacy capture, rule 22) is withheld at every revision
    const anchoredAt = fact
      ? murageAnchorOf(db, row.thread_id as string | null, row.message_id as string | null, () => (Number(fact.anchor_found) ? { json: fact.anchor_json } : undefined))
      : murageAnchor(db, row.thread_id as string | null, row.message_id as string | null);
    if (anchoredAt) return withheld("murage-anchor");
    // revbound r3 A2: while a revoke is in flight, a source supporting a record the owner forgot is forgotten with it (the forget tombstones
    // only the newest supporting sources in its commit). Bounded fan-in; past it the source reads "checking" until the job has marked it.
    if (revokeInFlight(db, memo)) {
      const citing = all(db, "SELECT record_id,record_version FROM memory_evidence_by_source WHERE source_id=? LIMIT ?", ref.id, SUPPORT_FAN_IN + 1);
      for (const cite of citing.slice(0, SUPPORT_FAN_IN)) {
    chargeReleaseWork();
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
  return memoryScopeVerdict(db, scopeId, created, memo, preparedWindow);
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
  const has = Boolean(accountedPrepare(db, "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='messages'").get());
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
    chargeReleaseWork();
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
    chargeReleaseWork();
    const sourceId = (source as { id?: unknown } | null)?.id;
    if (typeof sourceId !== "string") return checking("lookup-error");
    const anchor = one(db, "SELECT thread_id,message_id FROM memory_sources WHERE id=?", sourceId);
    if (anchor && murageAnchor(db, anchor.thread_id as string | null, anchor.message_id as string | null)) return withheld("murage-anchor");
  }
  const memo: MemoryMemo = { scopes: new Map(), denied: new Map(), records: new Map(), sources: new Map(), anchored: new Map() };
  for (const record of records) {
    chargeReleaseWork();
    const recordId = (record as { id?: unknown } | null)?.id, recordVersion = (record as { version?: unknown } | null)?.version;
    if (typeof recordId !== "string" || typeof recordVersion !== "number") return checking("lookup-error");
    const verdict = recordAnchorVerdict(db, recordId, recordVersion, memo);
    if (verdict) return verdict;
  }
  return undefined;
}
/** The scope's deny row, then the pending window: "checking" when since <= the created lsn (unknown = checking). The created lsn is read
 * only when a window covers the scope. */
function memoryScopeVerdict(db: DatabaseSync, scopeId: string | null, createdLsn: () => number | null, memo: MemoryMemo, preparedWindow = false): LineageVerdict {
  if (scopeId !== null && scopeDenied(db, scopeId, memo)) return withheld("scope-deny");
  if (preparedWindow) return SHOWN;
  const since = memoryPendingSince(db, scopeId, memo);
  if (since === null) return SHOWN;
  const created = createdLsn();
  if (created === null || since <= created) return checking("pending");
  return SHOWN;
}
/** Reads every versioned record ref in one statement: a primary-key seek, one deny_memory seek, one tombstone seek and one stamp seek
 * (memory_record_lsn, the version's created lsn) per ref. */
function batchRecords(db: DatabaseSync, refs: readonly MemoryRef[], memo: MemoryMemo): void {
  const wanted = [...new Map(refs.filter(ref => ref.kind === "record" && ref.version && !memo.records.has(memoryRefKey(ref))).map(ref => [memoryRefKey(ref), ref])).values()];
  for (let at = 0; at < wanted.length; at += BATCH) {
    const slice = wanted.slice(at, at + BATCH);
    for (const ref of slice) memo.records.set(memoryRefKey(ref), null);
    const rows = all(db, `SELECT r.id,r.version,r.scope_id,l.created_lsn AS stamp,l.id IS NOT NULL AS stamped,
        (WITH candidates AS MATERIALIZED (SELECT revoke_id FROM memory_deny_object WHERE kind='record' AND id=r.id AND version IN (0,r.version) LIMIT 257) SELECT CASE WHEN count(*)>256 THEN -1 ELSE coalesce(max(${NOT_AUDIENCE_ONLY} AND revoke_id<>${AUDIENCE_COALESCED}),0) END FROM candidates) AS marked,
        ${recordImpliedSql("r.id", "r.version", true)} AS implied,
        EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version)) AS tomb
      FROM json_each(?) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
      LEFT JOIN memory_record_lsn l ON l.id=r.id AND l.version=r.version`, JSON.stringify(slice.map(ref => [ref.id, ref.version])));
    for (const row of rows) memo.records.set(memoryRefKey({ kind: "record", id: String(row.id), version: Number(row.version) }), row);
  }
}

/** Every versioned source ref in one statement per BATCH (1.0.18 PIP-PERF: the learning send gate re-checks each held source of a window,
 * up to WINDOW_MAX_SOURCES, inside its write lock, and one seek per fact per source held the loop about 7 ms at 208 sources). Per ref, the
 * seeks memoryVerdict would make: the source row with its denied place (DENIED_SOURCE), the deny_memory mark at (0, revision), the
 * tombstone at the revision, the revision's stamp (memory_source_lsn) and the anchor message (messages, by primary key). A LEFT JOIN from
 * the refs, so a missing source still reads its mark first (id null). The forgotten-import check (legacy-import only) and the in-flight
 * check stay their own seeks. The work follows the refs, never the history. */
const SOURCE_BATCH = `SELECT j.key AS i, s.id,s.scope_id,s.state,s.kind,s.content_hash,s.thread_id,s.message_id,
    CASE WHEN s.id IS NULL THEN 0 ELSE ${DENIED_SOURCE("s")} END AS denied,
    (WITH candidates AS MATERIALIZED (SELECT revoke_id FROM memory_deny_object WHERE kind='source' AND id=json_extract(j.value,'$[0]') AND version IN (0,json_extract(j.value,'$[1]')) LIMIT 257) SELECT CASE WHEN count(*)>256 THEN -1 ELSE coalesce(max(${NOT_AUDIENCE_ONLY} AND revoke_id<>${AUDIENCE_COALESCED}),0) END FROM candidates) AS marked,
    ${sourceImpliedSql("json_extract(j.value,'$[0]')", true)} AS implied,
    EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=json_extract(j.value,'$[0]') AND (t.revision IS NULL OR t.revision=json_extract(j.value,'$[1]'))) AS tomb,
    l.created_lsn AS stamp, m.id IS NOT NULL AS anchor_found, m.json AS anchor_json
  FROM json_each(?) j LEFT JOIN memory_sources s ON s.id=json_extract(j.value,'$[0]')
  LEFT JOIN memory_source_lsn l ON l.source_id=s.id AND l.revision=json_extract(j.value,'$[1]')
  LEFT JOIN messages m ON m.thread_id=s.thread_id AND m.id=s.message_id`;
function batchSources(db: DatabaseSync, refs: readonly MemoryRef[], memo: MemoryMemo): void {
  const wanted = [...new Map(refs.filter(ref => ref.kind === "source" && ref.version && !memo.sources.has(memoryRefKey(ref))).map(ref => [memoryRefKey(ref), ref])).values()];
  for (let at = 0; at < wanted.length; at += BATCH) {
    const slice = wanted.slice(at, at + BATCH);
    const rows = all(db, SOURCE_BATCH, JSON.stringify(slice.map(ref => [ref.id, ref.version])));
    for (const row of rows) { const ref = slice[Number(row.i)]; if (ref) memo.sources.set(memoryRefKey(ref), row); }
  }
}

/** The verdict for memory objects (records, sources, lessons, claims), keyed by memoryRefKey. */
export function memoryLookup(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader): Map<string, LineageVerdict> {
  return memoryLookupWithWindow(db, refs, reader);
}
/** The reference path: every source ref read on its own, which batchSources must answer the same as (deny-read-source-batch.test.ts).
 *  It shares no state with memoryLookup, so nothing a caller of it does can leave the product reading one source at a time. */
export function memoryLookupEachSource(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader): Map<string, LineageVerdict> {
  return lookupMemory(db, refs, reader, false);
}
function memoryLookupWithWindow(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader, preparedKeys?: ReadonlySet<string>): Map<string, LineageVerdict> {
  return lookupMemory(db, refs, reader, true, preparedKeys);
}
function lookupMemory(db: DatabaseSync, refs: readonly MemoryRef[], reader: LineageReader, batched: boolean, preparedKeys?: ReadonlySet<string>): Map<string, LineageVerdict> {
  // a memory object's own facts and marks are the same for every reader; scope access is the caller's assertMemoryAccess. Only the pending
  // scope window differs: it is no verdict for the owner's own turn (LineageReader.settled), exactly as for a prepared key.
  const settled = readsSettledView(reader);
  const out = new Map<string, LineageVerdict>();
  const fresh = (): MemoryMemo => ({ scopes: new Map(), denied: new Map(), records: new Map(), sources: new Map(), anchored: new Map() });
  const memo = batched ? livePassLookup(db, lookupMemory, fresh) : fresh();
  try { batchRecords(db, refs, memo); } catch { memo.records.clear(); } // each ref is then read on its own, and an error there is "checking"
  if (batched) { try { batchSources(db, refs, memo); } catch { memo.sources.clear(); } } // likewise (a file with no messages table)
  for (const ref of refs) {
    chargeReleaseWork();
    const key = memoryRefKey(ref);
    if (out.has(key)) continue;
    try { out.set(key, memoryVerdict(db, ref, memo, settled || preparedKeys?.has(key) === true)); }
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

/** Whether a span of a thread that an engine session holds (begun at `first`, run to `last`) rests on a revoked line, read from the durable
 * range rows alone: the write-time rule's own statement (lineage-write.ts sessionMarks, which marks a session row at its write) and the
 * walk's session stage (revoke-marker.ts): from_lsn <= last AND until_turn_lsn > first, never a row of a revoke being or already undone.
 * A revoke's commit writes these rows in its own transaction (revoke-commit.ts: a line, a bot, a forgotten source's capture line, the
 * capture lines of a forgotten record's supporting sources), so the answer does not wait for any walk. More rows than one read takes
 * throws (rawMarks): the caller reads that as "checking", never as shown. */
function heldSpanRevoked(db: DatabaseSync, threadId: string, first: number, last: number, content: boolean): boolean {
  return rawMarks(db, "SELECT d.revoke_id FROM memory_deny_range d WHERE d.thread_id=? AND d.from_lsn<=? AND d.until_turn_lsn>? AND NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=d.revoke_id AND j.state IN ('undoing','undone'))", [threadId, last, first], content, true).length > 0;
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
    if (rawMarks(db, "SELECT revoke_id FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=?", [threadId, driverInstance, nativeSession], content).length) return withheld("deny-session");
    // memory-revocation.ts FORGOTTEN_SESSION_SET: a forget ended a source of this thread while the session was retained
    // (a file whose root sets were handed back has no such table: deny_session holds what a forget marked since the backfill)
    if (sessionRootSet(db, session) === "rs-forgotten") return withheld("session-forgotten");
    // memorySessionRevoked, in O(1): revisions and epochs only grow, so the session's oldest receipt is stale exactly when any is; a revoked
    // receipt among the newest few is read directly, an older one has its deny_session mark or its thread's pending row
    // A known revoked audience receipt is the specific denial even when the
    // same policy withdrawal also advanced its watermark. Keep the bounded
    // receipt peek and the content reader's existing watermark check.
    if (!content && all(db, "SELECT state FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT ?", threadId, driverInstance, nativeSession, SESSION_RECEIPT_PEEK)
      .some(row => row.state === "revoked")) return withheld("deny-session");
    const meta = one(db, "SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1");
    const oldest = one(db, "SELECT policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid LIMIT 1", threadId, driverInstance, nativeSession);
    if (oldest && (!meta || oldest.policy_revision !== meta.policy_revision || oldest.deletion_epoch !== meta.deletion_epoch)) return withheld("watermark");
    const row = one(db, "SELECT first_lsn,last_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?", threadId, driverInstance, nativeSession);
    if (!row) return checking("no-lineage");
    if (!threadReady(db, threadId)) return checking("thread-not-ready");
    // an audience reader's session resets on any revoke it rests on, audience-only ones included (the RC reset it on a revoked receipt)
    // A session built after a revoke's commit was fenced against it. Old global
    // windows cannot reset that fresh session; inherited post-commit holds, unknown
    // jobs and seeding windows keep their uncapped fail-closed behavior.
    const first = num(row.first_lsn), last = Number(row.last_lsn);
    if (first === null || !Number.isFinite(first) || !Number.isFinite(last)) return checking("no-lineage");
    if (readsSettledView(reader)) {
      // The owner's own turn (LineageReader.settled): no window. What a walk's session stage would mark is read from the durable range row
      // the revoke's COMMIT wrote in its own transaction (revoke-commit.ts writeRange), by the stage's own test (revoke-marker.ts: a session
      // begun before the range's cap that ran to or past its line held it): first_lsn < until AND last_lsn >= from. So a revoke of a line
      // this session held resets it at once, walk finished or not. More rows than one read takes is an error: "checking", never shown.
      if (heldSpanRevoked(db, threadId, first, last, content)) return withheld("deny-session");
      return SHOWN;
    }
    if (pendingWindows(db, threadId, content).some(window => window.since <= last && first < window.cap)) return checking("pending");
    return SHOWN;
  } catch { return checking("lookup-error"); }
}

// ---- refs (steer quotes, tool texts, prompt parts) and the send fence ----

/** The strictest verdict over a list of refs (steer quotes, tool texts, prompt parts). An empty list or only `none` refs is shown. A prefix
 * ref checks deleted/readiness facts and its unlisted retained span (held); a fresh fully listed prefix has none.
 * Listed lines are re-judged by the reader that rendered them, including each pending window's turn cap. Legacy prefixes keep the wholesale rule. */
export function refsLookup(db: DatabaseSync, refs: readonly LineageRef[], reader: LineageReader, _retained = false,
  prepared?: import("./lineage-types.ts").PreparedWindow): LineageVerdict {
  let worst: LineageVerdict = SHOWN;
  try {
    const lines = new Map<string, string[]>();
    const shownLines = new Map<string, Set<string>>();
    // lines a non-owner audience reader's prefix showed: judged again by that same audience reader (watermark and audience-only marks included),
    // since they were rendered under it (1.0.4 audit 01-B2: a content recheck let a stale transcript through once the revoke's pending rows were tidied)
    const audienceShown = new Map<string, Set<string>>();
    const memory: MemoryRef[] = [];
    for (const ref of normalizeRetainedRefs(refs, chargeReleaseWork)) {
      chargeReleaseWork();
      // a replayed line of the prompt's own thread tagged `judge: "content"` (an owner audience) is judged by content, as a prefix's shown lines
      // are (below); every other line, an untagged replay included, for the reader
      if (ref.kind === "line" && (ref.judge === "content" || ref.copyOfShown || reader.audience === null)) { const set = shownLines.get(ref.threadId) ?? new Set<string>(); set.add(ref.messageId); shownLines.set(ref.threadId, set); }
      else if (ref.kind === "line") { const list = lines.get(ref.threadId) ?? []; list.push(ref.messageId); lines.set(ref.threadId, list); }
      else if (ref.kind === "memory") memory.push(ref.ref);
      else if (ref.kind === "prefix") {
        worst = worstVerdict(worst, prefixVerdict(db, ref, reader.audience === null || ref.content === true, readsSettledView(reader)));
        if (ref.shown?.length) {
          for (const id of ref.shown) {
    chargeReleaseWork();
            const target = reader.audience === null || prefixLineJudge(ref, id) === "content" ? shownLines : audienceShown;
            const set = target.get(ref.threadId) ?? new Set<string>(); set.add(id); target.set(ref.threadId, set);
          }
        }
      }
      else if (ref.kind === "receipt") worst = worstVerdict(worst, receiptVerdict(db, ref, reader));
      if (worst.state === "withheld") return worst;
    }
    for (const [threadId, ids] of lines) {
    chargeReleaseWork();
      for (const verdict of lookupPage(db, threadId, ids.map(messageId => ({ messageId, author: "generated" as const })), reader, true).values()) worst = worstVerdict(worst, verdict);
      if (worst.state === "withheld") return worst;
    }
    // the lines a prefix part showed: their marks, as of now. Judged as a content reader judged them when the prompt was built (the owner's
    // own chat reads content; the reader-relative rules, watermark and footprint, were applied then): a mark, a pending revoke, a flag, a
    // forgotten source or a deleted conversation.
    for (const [threadId, ids] of shownLines) {
    chargeReleaseWork();
      for (const verdict of lookupPage(db, threadId, [...ids].map(messageId => ({ messageId, author: "generated" as const })), contentReader(reader), true).values()) {
    chargeReleaseWork();
        worst = worstVerdict(worst, verdict);
      }
      if (worst.state === "withheld") return worst;
    }
    for (const [threadId, ids] of audienceShown) {
    chargeReleaseWork();
      for (const verdict of lookupPage(db, threadId, [...ids].map(messageId => ({ messageId, author: "generated" as const })), reader, true).values()) worst = worstVerdict(worst, verdict);
      if (worst.state === "withheld") return worst;
    }
    // The bounded identity read runs whatever the prepared identity was: a backlog past its bound must not make the check cheaper.
    const preparedKeys = prepared?.reader === reader && prepared.generation === denyGeneration(db)
      && prepared.identity === preparedWindowIdentity(db) && prepared.identity !== null ? prepared.memoryKeys : undefined;
    // The exception is only inside the scope-window check. Anchor traversal,
    // supporting-source uncertainty and all content denials still refuse.
    for (const verdict of memoryLookupWithWindow(db, memory, reader, preparedKeys).values()) worst = worstVerdict(worst, verdict);
    return worst;
  } catch { return worstVerdict(worst, checking("lookup-error")); }
}

/** Exact pending rows, not merely deny_generation: marking may change a
 * window without moving that counter. Never scan beyond a fixed bound.
 * Every column is aliased: a compound SELECT's ORDER BY only matches result
 * column names, and an unaliased p.revoke_id threw on every prepare. */
export function preparedWindowIdentity(db: DatabaseSync): string | null {
  const rows = all(db, `SELECT 't' AS k,p.thread_id AS id,p.since_lsn AS since_lsn,p.revoke_id AS revoke_id,j.started_lsn AS started_lsn,j.state AS state,
      EXISTS(SELECT 1 FROM memory_revoke_audience a WHERE a.revoke_id=p.revoke_id) AS audience
    FROM memory_deny_pending p LEFT JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id
    UNION ALL SELECT 's' AS k,p.scope_id AS id,p.since_lsn AS since_lsn,p.revoke_id AS revoke_id,j.started_lsn AS started_lsn,j.state AS state,
      EXISTS(SELECT 1 FROM memory_revoke_audience a WHERE a.revoke_id=p.revoke_id) AS audience
    FROM memory_deny_pending_scope p LEFT JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id
    ORDER BY k,id,since_lsn,revoke_id LIMIT 513`);
  // Above the bound there is no identity to compare, and so no prepared exception: every ref is then judged strictly (a pending window
  // refuses it). Throwing here refused every send in every chat once more than 512 pending rows piled up anywhere in the file.
  if (rows.length > 512) return null;
  return JSON.stringify(rows);
}

export function prepareWindowMemory(db: DatabaseSync, refs: readonly LineageRef[], prepared: import("./lineage-types.ts").PreparedWindow): void {
  if (!prepared.open || prepared.generation !== denyGeneration(db) || prepared.identity !== preparedWindowIdentity(db) || prepared.identity === null) return;
  for (const ref of refs) {
    if (ref.kind !== "memory" || prepared.memoryKeys.size >= 512) continue;
    const value = ref.ref;
    // Missing/dynamic objects cannot acquire the prepared exception.
    const known = value.kind === "record" && value.version !== undefined
      ? one(db, "SELECT 1 FROM memory_records WHERE id=? AND version=? AND state='active'", value.id, value.version)
      : value.kind === "source" && value.version !== undefined
        ? one(db, "SELECT 1 FROM memory_sources WHERE id=? AND revision=? AND state='active'", value.id, value.version) : undefined;
    if (known) prepared.memoryKeys.add(memoryRefKey(value));
  }
}
function prefixVerdict(db: DatabaseSync, ref: Extract<LineageRef, { kind: "prefix" }>, content: boolean, settled = false): LineageVerdict {
  const { threadId } = ref;
  const bound = ref.held === undefined ? ref.headLsn : ref.held;
  if (threadDenied(db, threadId)) return withheld("thread-deny");
  if (!threadReady(db, threadId)) return checking("thread-not-ready");
  if (bound === null) return SHOWN;
  if (settled) {
    // The owner's own turn (LineageReader.settled): no window. The span the engine session already holds is judged as the session is
    // (sessionLookup): withheld when a committed range row says it held a revoked line. A prefix with no held span lists its lines, and
    // each is judged by lookupPage (point and range rows).
    if (ref.heldFrom !== undefined && bound !== undefined) {
      if (!Number.isSafeInteger(ref.heldFrom) || !Number.isSafeInteger(bound) || ref.heldFrom > bound) return checking("no-lineage");
      return heldSpanRevoked(db, threadId, ref.heldFrom, bound, content) ? withheld("deny-range") : SHOWN;
    }
    return SHOWN;
  }
  // A retained session's first prompt was fenced at its head. Apply the same
  // commit cap as sessionLookup; listed lines are still judged independently.
  // Without both bounds the legacy wholesale rule below remains fail closed.
  if (ref.heldFrom !== undefined && bound !== undefined) {
    if (!Number.isSafeInteger(ref.heldFrom) || !Number.isSafeInteger(bound) || ref.heldFrom > bound) return checking("no-lineage");
    return pendingWindows(db, threadId, content).some(window => window.since <= bound && ref.heldFrom! < window.cap) ? checking("pending") : SHOWN;
  }
  const since = pendingSince(db, threadId, content);
  if (since !== null && (bound === undefined || since <= bound)) return checking("pending");
  return SHOWN;
}
/** 1.0.21 cause1 (MAIN ruling (a)): a receipt row whose cited versions are not two arrays of well-formed entries ({id, version} records,
 * {id, revision} sources, each a safe integer >= 1). Validated before any verdict, so a corrupted receipt never reads as a proven refusal
 * (revoked, a missing record, a Murage anchor) that the owner keep rule may drop. A plain loop over already-parsed JSON: no lookups. */
function malformedReceiptRow(row: Record<string, unknown>): boolean {
  let records: unknown, sources: unknown;
  try { records = JSON.parse(String(row.record_versions)); sources = JSON.parse(String(row.source_versions)); } catch { return true; }
  if (!Array.isArray(records) || !Array.isArray(sources)) return true;
  const entry = (value: unknown, field: "version" | "revision"): boolean => {
    const item = value as Record<string, unknown> | null;
    return Boolean(item) && typeof item === "object" && typeof item!.id === "string" && Number.isSafeInteger(item![field]) && Number(item![field]) >= 1;
  };
  return !records.every(record => entry(record, "version")) || !sources.every(source => entry(source, "revision"));
}
/** The send fence's keep rule asks this before it drops a held receipt: true for a malformed receipt row (above) or one that cannot be read. */
export function receiptMalformed(db: DatabaseSync, bundleId: string): boolean {
  try {
    const row = one(db, "SELECT record_versions,source_versions FROM memory_disclosures WHERE bundle_id=?", bundleId);
    return !row || malformedReceiptRow(row);
  } catch { return true; }
}
function receiptVerdict(db: DatabaseSync, ref: Extract<LineageRef, { kind: "receipt" }>, reader: LineageReader): LineageVerdict {
  const row = one(db, "SELECT d.state,d.policy_revision,d.deletion_epoch,d.record_versions,d.source_versions,m.policy_revision AS p,m.deletion_epoch AS e FROM memory_disclosures d, memory_meta m WHERE m.id=1 AND d.bundle_id=?", ref.bundleId);
  if (!row) return checking("lookup-error");
  // validate first: a malformed receipt is unreadable whatever its state (revoked included) or any later reason would say
  if (malformedReceiptRow(row)) return checking("lookup-error");
  if (row.state === "revoked") return withheld("deny-memory");
  if (reader.audience === null) return contentReceiptVerdict(db, ref.bundleId, reader);
  const anchored = receiptAnchorVerdict(db, ref.bundleId);
  if (anchored) return anchored;
  const audience = reader.audience;
  if (audience) {
    if (row.policy_revision !== row.p || row.deletion_epoch !== row.e || ref.lsn < watermark(db)) return withheld("watermark");
    if (!audience.owner) {
      if (ref.scopeIds.length > 32) return checking("footprint-wide");
      if (!ref.scopeIds.every(scope => lineageAudienceHasScope(db,audience,scope))) return withheld("footprint");
    }
  }
  // an audience receipt keeps its content dependencies too (AUDIENCE r3.1 2.5(c)): a later-denied record, a deleted or revised source, a pending scope
  return contentReceiptVerdict(db, ref.bundleId, reader);
}

/** 1.0.20 ctxrev-h1: a cited notebook chunk (import evidence) that later re-imports superseded without changing anything it showed: every
 * later version of the id has its exact words, kind, scope, assertion and pin, rests only on the same notebook source (one handle per
 * version, at that version's revision), and the newest of them is the one active version. Returns that version, the revision its evidence
 * cites, and each (source, revision) the cited version rested on; undefined for anything else (changed or restored words, a shorter
 * notebook, a correction or derived record, a deleted or archived later version), which stays withheld. Bounded by the id's versions. */
function reimportedChunk(db: DatabaseSync, id: string, version: number): { version: number; revision: number; sources: Array<[string, number]> } | undefined {
  const cited = one(db, `SELECT o.kind,o.assertion,count(e.source_id) AS n,min(e.source_id) AS source_id,min(e.source_revision) AS revision FROM memory_records o
    LEFT JOIN memory_evidence e ON e.record_id=o.id AND e.record_version=o.version WHERE o.id=? AND o.version=? AND o.state='superseded' GROUP BY o.id,o.version`, id, version);
  if (!cited || cited.kind !== "evidence" || cited.assertion !== "unverified-import" || Number(cited.n) !== 1) return undefined;
  // one aggregate over the id's later versions (primary-key range), never a row per version back to the caller
  const later = one(db, `SELECT count(*) AS n, max(n.version) AS newest, min(n.version) AS first, max(CASE WHEN n.state='active' THEN n.version END) AS live,
      sum(n.state='superseded') AS superseded,
      sum(n.text IS o.text AND n.kind IS o.kind AND n.scope_id IS o.scope_id AND n.assertion IS o.assertion AND n.owner_pinned IS o.owner_pinned
        AND (SELECT count(*) FROM memory_evidence e WHERE e.record_id=n.id AND e.record_version=n.version)=1
        AND EXISTS (SELECT 1 FROM memory_evidence e WHERE e.record_id=n.id AND e.record_version=n.version AND e.source_id=?1
          AND (e.source_revision=n.version OR (n.state='active' AND e.source_revision>n.version)))) AS same,
      max(CASE WHEN n.state='active' THEN (SELECT max(e.source_revision) FROM memory_evidence e WHERE e.record_id=n.id AND e.record_version=n.version AND e.source_id=?1) END) AS rests
    FROM memory_records o JOIN memory_records n ON n.id=o.id AND n.version>o.version WHERE o.id=?2 AND o.version=?3`, String(cited.source_id), id, version);
  const count = Number(later?.n ?? 0);
  if (!later || !count || Number(later.same) !== count || Number(later.superseded) !== count - 1 || later.live === null || Number(later.live) !== Number(later.newest)) return undefined;
  // r3: contiguous versions only. A removal (a shorter notebook) writes no row at its revision, so versions 1 and 3 with the same words are
  // a removed chunk restored later, never this; and no forget of the notebook at the cited or any later revision (an in-between one
  // included, which neither endpoint's own lookup reads)
  if (Number(later.first) !== version + 1 || Number(later.newest) - version !== count) return undefined;
  if (one(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision>=?) LIMIT 1", String(cited.source_id), Number(cited.revision))) return undefined;
  // 1.0.21 combine (h1 x selfheal H2): nor a forgotten import's contents (forget.ts: an import tombstone by scope and content hash) at the
  // cited or any later notebook revision; the cleanup (memory-revocation.ts importWindowStep) may not have reached its copy yet
  if (one(db, `SELECT 1 FROM memory_tombstones t JOIN memory_source_versions v ON v.source_id=? AND v.revision>=? AND v.content_hash=t.content_hash
      WHERE t.target_type='import' AND t.target_id=(SELECT scope_id FROM memory_sources WHERE id=?) LIMIT 1`, String(cited.source_id), Number(cited.revision), String(cited.source_id))) return undefined;
  // 1.0.21 cause10: the newest version may itself have been kept by later chunk-diff imports (import.ts), its evidence moved on with the notebook
  const rests = Number(later.rests);
  if (!Number.isSafeInteger(rests) || rests < Number(later.newest)) return undefined;
  return { version: Number(later.newest), revision: rests, sources: [[String(cited.source_id), Number(cited.revision)]] };
}
/** 1.0.21 cause10 (chunk-diff import, import.ts): a cited notebook chunk a later re-import KEPT. Its record and version are the cited ones,
 * still active, with their words (a record version's text is never rewritten); only its one evidence handle moved to the notebook's newer
 * revision. Returns the notebook and the revision that handle cites now; undefined for anything else (not an import chunk of that
 * notebook, more or fewer handles, a handle that did not move, a forget of the whole notebook). import.ts writes a chunk version at the
 * notebook revision of that change, so the cited version rested on the notebook from revision `version` on: a receipt naming the notebook
 * anywhere from there to the handle's revision named it while this chunk read as now.
 * r2 (review High): a forget is judged from the revision the RECEIPT names, as reimportedChunk judges it, never from the revision the chunk
 * was first written at. `from` is therefore the first revision with no forget of the notebook, or of its contents, at it or after it: a
 * receipt naming an earlier revision is not carried (a forget lies between it and now), one naming `from` or later is. A forget of an
 * EARLIER revision's contents (the same words under another topic, forgotten before this turn was shown the notebook) no longer refuses
 * the turn at the next unrelated append. */
function keptChunk(db: DatabaseSync, id: string, version: number): { sourceId: string; from: number; revision: number } | undefined {
  const cited = one(db, `SELECT o.kind,o.assertion,count(e.source_id) AS n,min(e.source_id) AS source_id,min(e.source_revision) AS revision FROM memory_records o
    LEFT JOIN memory_evidence e ON e.record_id=o.id AND e.record_version=o.version WHERE o.id=? AND o.version=? AND o.state='active' GROUP BY o.id,o.version`, id, version);
  if (!cited || cited.kind !== "evidence" || cited.assertion !== "unverified-import" || Number(cited.n) !== 1) return undefined;
  const sourceId = String(cited.source_id), revision = Number(cited.revision);
  if (!id.startsWith(`${sourceId}:chunk:`) || !Number.isSafeInteger(revision) || revision <= version) return undefined;
  if (one(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision IS NULL LIMIT 1", sourceId)) return undefined;
  const forgotten = Number(one(db, "SELECT max(revision) AS r FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision>=?", sourceId, version)?.r ?? 0);
  const contents = Number(one(db, `SELECT max(v.revision) AS r FROM memory_tombstones t JOIN memory_source_versions v ON v.source_id=? AND v.revision>=? AND v.content_hash=t.content_hash
      WHERE t.target_type='import' AND t.target_id=(SELECT scope_id FROM memory_sources WHERE id=?)`, sourceId, version, sourceId)?.r ?? 0);
  const from = Math.max(version, forgotten + 1, contents + 1);
  if (!Number.isSafeInteger(from) || from > revision) return undefined;
  return { sourceId, from, revision };
}
/** 1.0.20 ctxrev-h1 r3: the one carry both receipt readers use (contentReceiptVerdict below, disclosures.ts revokedReason on every adapter
 * acceptance, the Flux/HTTP tool rounds included): each cited record version that is such a re-imported unchanged chunk -> its newest
 * version, and the notebook (source, revision) it rested on -> the revision that newest version cites. Nothing else is carried. */
export type ReimportCarry = { records: Map<string, number>; sources: Map<string, number>;
  /** cause10: per notebook, the cited revisions [from, to] its kept chunks carry to the revision their evidence cites now */
  kept: Map<string, Array<{ from: number; to: number; revision: number }>> };
/** The revision a receipt's cited (source, revision) is judged at when its chunks carried it; undefined: not carried. */
export function carriedRevision(carry: ReimportCarry, sourceId: string, revision: number): number | undefined {
  const moved = carry.sources.get(reimportCarryKey(sourceId, revision));
  if (moved !== undefined) return moved;
  return carry.kept.get(sourceId)?.find(range => range.from <= revision && revision <= range.to)?.revision;
}
export const reimportCarryKey = (id: string, version: number) => `${id}\u0000${version}`;
export function reimportCarry(db: DatabaseSync, records: ReadonlyArray<{ id: string; version: number }>): ReimportCarry {
  const carry: ReimportCarry = { records: new Map(), sources: new Map(), kept: new Map() };
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !Number.isSafeInteger(record.version) || record.version < 1) continue;
    const state = one(db, "SELECT state FROM memory_records WHERE id=? AND version=?", record.id, record.version)?.state;
    if (state === "active" && record.id.includes(":chunk:")) {
      const kept = keptChunk(db, record.id, record.version);
      if (kept) carry.kept.set(kept.sourceId, [...carry.kept.get(kept.sourceId) ?? [], { from: kept.from, to: kept.revision, revision: kept.revision }]);
      continue;
    }
    if (state !== "superseded") continue;
    const replacement = reimportedChunk(db, record.id, record.version);
    if (!replacement) continue;
    carry.records.set(reimportCarryKey(record.id, record.version), replacement.version);
    for (const [sourceId, revision] of replacement.sources) carry.sources.set(reimportCarryKey(sourceId, revision), replacement.revision);
  }
  return carry;
}
/** disclosures.ts revokedReason: a receipt that leans on the carry must also read shown by the content verdict here (cited and newest
 * versions, both notebook revisions, marks, anchors), so the HTTP acceptance never accepts what the retained fence withholds. */
export function reimportedReceiptVerdict(db: DatabaseSync, bundleId: string, reader: LineageReader): LineageVerdict {
  try { return contentReceiptVerdict(db, bundleId, reader); } catch { return checking("lookup-error"); }
}
/** Ordinary direct owners ignore audience flips, but never the receipt's content dependencies. */
function contentReceiptVerdict(db: DatabaseSync, bundleId: string, reader: LineageReader): LineageVerdict {
  const row = one(db, "SELECT thread_id,record_versions,source_versions FROM memory_disclosures WHERE bundle_id=?", bundleId);
  if (!row) return checking("lookup-error");
  let records: unknown, sources: unknown;
  try { records = JSON.parse(String(row.record_versions)); sources = JSON.parse(String(row.source_versions)); }
  catch { return checking("lookup-error"); }
  if (!Array.isArray(records) || !Array.isArray(sources)) return checking("lookup-error");
  // A bounded receipt walk that cannot fit remains pending, as the anchor
  // reader does; malformed receipt data is a separate lookup failure.
  if (records.length + sources.length > RECEIPT_ANCHORS) return checking("pending");
  // The Murage-voice floor applies at every cited revision. Resolve that
  // bounded anchor verdict before a stale revision can replace its reason.
  const anchored = receiptAnchorVerdict(db, bundleId);
  if (anchored) return anchored;
  const refs: MemoryRef[] = [];
  const lineCheckpoints = new Map<string, { record: { id: string; version: number }; leftOut: () => string[] }>();
  // a re-imported notebook's source revision the receipt's unchanged chunks were cited at -> the revision their replacements cite
  const carry = reimportCarry(db, records);
  for (const record of records) {
    chargeReleaseWork();
    if (!record || typeof record.id !== "string" || !Number.isSafeInteger(record.version) || record.version < 1) return checking("lookup-error");
    const current = one(db, "SELECT state,kind,scope_id,owner_pinned,assertion FROM memory_records WHERE id=? AND version=?", record.id, record.version);
    if (!current) return withheld("deny-memory");
    const checkpointId = `checkpoint:${createHash("sha256").update(JSON.stringify([String(current.scope_id), String(row.thread_id)])).digest("hex")}`;
    const superseded = current.kind === "checkpoint" && current.state === "archived" && current.owner_pinned !== 1 && record.id === checkpointId
      && Boolean(one(db, "SELECT 1 FROM memory_records WHERE id=? AND version>? AND state='active' ORDER BY version DESC LIMIT 1", record.id, record.version));
    // 1.0.20 ctxrev-h1: a tracked notebook's re-import supersedes every chunk, its words unchanged included (import.ts reclaim-n6 withdraws
    // only the changed ones). Such a chunk is judged as its replacement: the cited version and every later one must still read clean below.
    const newest = current.state === "superseded" ? carry.records.get(reimportCarryKey(record.id, record.version)) : undefined;
    const replacement = newest === undefined ? undefined : { version: newest };
    if (current.state !== "active" && !superseded && !replacement) return withheld("deny-memory");
    if (replacement) refs.push({ kind: "record", id: record.id, version: replacement.version, scopeId: String(current.scope_id) });
    if (one(db, "SELECT 1 FROM memory_deny WHERE kind='scope' AND id=?", String(current.scope_id))
      || one(db, `SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?${replacement ? " OR revision>?" : ""}) LIMIT 1`, record.id, record.version, ...replacement ? [record.version] : [])) return withheld("deny-memory");
    refs.push({ kind: "record", id: record.id, version: record.version, scopeId: String(current.scope_id) });
    // an active thread checkpoint: the lines this receipt did not show are the evidence sources it does not cite (bounded; more than the
    // receipt walk allows is not read and nothing is excused)
    if (current.kind === "checkpoint" && current.state === "active") lineCheckpoints.set(memoryRefKey({ kind: "record", id: record.id, version: record.version }), { record: { id: record.id, version: record.version }, leftOut: () => {
      const evidence = db.prepare("SELECT DISTINCT source_id FROM memory_evidence WHERE record_id=? AND record_version=? LIMIT ?").all(record.id, record.version, RECEIPT_ANCHORS + 1).map(row => String(row.source_id));
      if (evidence.length > RECEIPT_ANCHORS) return [];
      const cited = new Set((sources as Array<{ id?: unknown }>).map(source => String(source?.id)));
      return evidence.filter(id => !cited.has(id));
    } });
  }
  for (const source of sources) {
    chargeReleaseWork();
    if (!source || typeof source.id !== "string" || !Number.isSafeInteger(source.revision) || source.revision < 1) return checking("lookup-error");
    const current = one(db, `SELECT s.state,s.revision,s.thread_id,s.message_id,${DENIED_SOURCE("s")} AS denied FROM memory_sources s WHERE s.id=?`, source.id);
    // the notebook source of a re-imported unchanged chunk this receipt cites moved on with the chunk: judged at the revision the chunk's
    // replacement cites (a source cited on its own, or at a revision no unchanged chunk carries, still withholds)
    const moved = carriedRevision(carry, source.id, source.revision);
    if (!current || current.state !== "active" || (current.revision !== source.revision && current.revision !== moved) || current.denied
      || one(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=? OR revision=?) LIMIT 1", source.id, source.revision, Number(current.revision))) return withheld("deny-memory");
    // A receipt preserves the source anchor's content obligations even when
    // the stored speaker is human. Audience-only marks still do not deny content.
    if (current.thread_id !== null && current.message_id !== null && one(db,
      `SELECT 1 FROM memory_thread_no t JOIN memory_line_lineage l ON l.thread_no=t.no
       JOIN memory_deny_point d ON d.thread_id=t.thread_id AND d.lsn=l.lsn
       WHERE t.thread_id=? AND l.message_id=? AND ${NOT_AUDIENCE_ONLY} LIMIT 1`, String(current.thread_id), String(current.message_id))) return withheld("deny-line");
    refs.push({ kind: "source", id: source.id, version: source.revision });
    if (moved !== undefined && moved !== source.revision) refs.push({ kind: "source", id: source.id, version: moved });
  }
  let worst: LineageVerdict = SHOWN;
  for (const [key, verdict] of memoryLookup(db, refs, reader)) {
    // q1023-leftout (banner run 12d08fbe19 t2/t3): a thread checkpoint is disclosed by lines (1.0.23 fencebundle, readable.ts
    // checkpointLineRefusal): the bundle kept it with the hidden lines left out, and this receipt cites exactly the sources of the lines it
    // showed (each judged above and below on its own). The record's own deny-memory mark is then only the mark of the lines it did NOT
    // show, by the same rule the reader used; judged whole here, every such send was refused, rebuilt, refused again and sent from the
    // message alone. Any other verdict, any other record kind and a mark no left-out line explains refuse as before.
    const lines = lineCheckpoints.get(key);
    if (lines && verdict.state === "withheld" && verdict.reason === "deny-memory" && checkpointMarksExplained(db, lines.record, lines.leftOut())) continue;
    worst = worstVerdict(worst, verdict);
  }
  return worst;
}
/** The 1.0.23 fencebundle rule, one copy for the reader (readable.ts checkpointLineRefusal) and the send fence's receipt check
 * (contentReceiptVerdict): a thread checkpoint's own deny-memory mark is explained by the lines left out when the record is no derivation's
 * child and every revoke that marked the record also marked a left-out line's source (on schema 14 the record carries no mark of its own:
 * the rule reaches it through those lines). False with no line left out: the record then showed everything it rests on. */
export function checkpointMarksExplained(db: DatabaseSync, record: { id: string; version: number }, leftOutSourceIds: readonly string[]): boolean {
  if (!leftOutSourceIds.length || db.prepare("SELECT 1 FROM memory_derivations WHERE child_id=? AND child_version=? LIMIT 1").get(record.id, record.version)) return false;
  const ruled = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny_object'").get());
  const table = ruled ? "memory_deny_object" : "memory_deny_memory";
  const marks = db.prepare(`SELECT DISTINCT revoke_id FROM ${table} WHERE kind='record' AND id=? AND version IN (0,?)`).all(record.id, record.version);
  const explained = new Set(db.prepare(`SELECT DISTINCT revoke_id FROM ${table} WHERE kind='source' AND id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(leftOutSourceIds)).map(row => Number(row.revoke_id)));
  return (marks.length > 0 || ruled) && marks.every(mark => explained.has(Number(mark.revoke_id)));
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
  return { audience: null, ownFlag: reader.ownFlag !== false, ...(readsSettledView(reader) ? { settled: true as const } : {}) };
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
 * its refs are asked again here (seeks per ref). Pending windows already accounted for at build remain safe, but a failed/overflowing
 * permanent-mark lookup proves nothing, even with an unchanged generation. */
export function fenceUnchanged(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader): LineageVerdict {
  const memory = built.parts.flatMap(part => part.lineageOf.flatMap(ref => ref.kind === "memory" ? [ref.ref] : []));
  if (!memory.length) return SHOWN;
  for (const verdict of memoryLookup(db, memory, contentReader(reader)).values()) if (verdict.state === "withheld" || (verdict.state === "checking" && verdict.reason === "lookup-error")) return verdict;
  return SHOWN;
}

/** memory_lineage_lsn_meta.deny_generation (bumped by every revoke commit and every final marker slice). -1 when it cannot be read. */
export function denyGeneration(db: DatabaseSync): number {
  try { return Number(accountedPrepare(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()?.value ?? -1); }
  catch { return -1; }
}

/** Whether write-time lineage is being written on this file: a line row exists (an S1 writer or the backfill wrote one), so a generated
 * line with no row is a real unknown. Until then (no S1 writer yet, an upgraded file before its backfill reaches a line) the S4 readers keep
 * the read-time judge as the only line judge. An lsn alone proves nothing here: a policy or epoch bump, a receipt flip or a capture takes
 * one (the v10 triggers) with no line written. One seek. TRANSITIONAL: S6 deletes the read-time judge and this gate with it. */
export function lineageLive(db: DatabaseSync): boolean {
  try { return Boolean(accountedPrepare(db, "SELECT 1 AS x FROM memory_line_lineage LIMIT 1").get()); }
  catch { return false; }
}

// Direct settlement uses separate raw readers: the ordinary readers above keep their
// existing behavior. Limits apply before filtering, JSON parsing or deduplication.
export class SettleReadLimit extends Error {
  readonly why: "work" | "time" | "pending-rows" | "ids";
  constructor(why: "work" | "time" | "pending-rows" | "ids") { super(`SETTLE_READ_${why}`); this.why = why; }
}
export const SETTLE_CLASSIFY_MS = 25;
export class SettleReadBudget {
  remaining = 4096;
  private bytes = 1024 * 1024;
  private readonly started = performance.now();
  check(): void { if (performance.now() - this.started >= SETTLE_CLASSIFY_MS) throw new SettleReadLimit("time"); }
  charge(n = 1): void { this.check(); if (n > this.remaining) throw new SettleReadLimit("work"); this.remaining -= n; }
  one(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row | undefined {
    this.charge(); const row = one(db, sql, ...args); this.check(); return row;
  }
  /** SQL must end in LIMIT ? and have an indexed prefix, with no filtering or joins. Numeric projections only. */
  rows(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] {
    this.check(); const rows = all(db, sql, ...args, this.remaining + 1); this.charge(rows.length); return rows;
  }
  /** Point-read text only after its byte size has been admitted, before SQLite copies it into JS. */
  text(db: DatabaseSync, column: string, from: string, ...args: Array<string | number | null>): string | null {
    const size = this.one(db, `SELECT length(CAST(${column} AS BLOB)) AS bytes FROM ${from}`, ...args)?.bytes;
    if (size === null || size === undefined) return null;
    const n = Number(size);
    if (n > 65536 || n > this.bytes) throw new SettleReadLimit("work");
    this.bytes -= n;
    // Recheck in the copying statement as well: a different connection may have changed the value.
    const row = this.one(db, `SELECT CASE WHEN length(CAST(${column} AS BLOB))<=? THEN ${column} ELSE NULL END AS value FROM ${from}`, n, ...args);
    if (typeof row?.value !== "string") throw new SettleReadLimit("work");
    return row.value;
  }
}
export interface OwnPendingRow { threadId: string; since: number; revokeId: number; cap: number }
export function readOwnPending(db: DatabaseSync, threadId: string, work: SettleReadBudget): OwnPendingRow[] {
  work.check();
  const seek = (thread: string) => all(db, "SELECT since_lsn,revoke_id FROM memory_deny_pending WHERE thread_id=? ORDER BY since_lsn,revoke_id LIMIT 257", thread);
  const own = seek(threadId); work.check(); const wildcard = seek(PENDING_ALL_THREADS); work.check();
  if (own.length === 257 || wildcard.length === 257 || own.length + wildcard.length > 256) throw new SettleReadLimit("pending-rows");
  const out: OwnPendingRow[] = [];
  for (const [thread, rows] of [[threadId, own], [PENDING_ALL_THREADS, wildcard]] as const) for (const row of rows) {
    const revokeId = Number(row.revoke_id), since = Number(row.since_lsn);
    if (!Number.isSafeInteger(revokeId) || !Number.isSafeInteger(since)) throw new Error("SETTLE_PENDING_POSITION");
    if (work.one(db, "SELECT 1 FROM memory_revoke_audience WHERE revoke_id=?", revokeId)) continue;
    const job = work.one(db, "SELECT started_lsn,state='seeding' AS seeding FROM memory_revoke_jobs WHERE revoke_id=?", revokeId);
    const cap = num(job?.started_lsn);
    out.push({ threadId: thread, since, revokeId, cap: cap === null || job?.seeding || since > cap ? Infinity : cap });
  }
  return out;
}
function ownTombstones(db: DatabaseSync, id: string, work: SettleReadBudget): Row[] {
  return work.rows(db, "SELECT revision FROM memory_tombstones WHERE target_type='source' AND target_id=? ORDER BY revision LIMIT ?", id);
}
function ownSource(db: DatabaseSync, id: string, work: SettleReadBudget): { gone: boolean; brought: boolean; revision: number } | null {
  const row = work.one(db, "SELECT state='deleted' AS deleted,kind='bring-in' AS brought,revision FROM memory_sources WHERE id=?", id);
  if (!row) return null;
  const thread = work.text(db, "thread_id", "memory_sources WHERE id=?", id);
  const scope = work.text(db, "scope_id", "memory_sources WHERE id=?", id);
  const denied = (kind: string, key: string | null) => key !== null && !!work.one(db, "SELECT 1 FROM memory_deny WHERE kind=? AND id=?", kind, key);
  const gone = !!row.deleted || denied("thread", thread) || denied("scope", scope);
  return { gone, brought: !!row.brought, revision: Number(row.revision) };
}
function ownForgotten(db: DatabaseSync, id: string, work: SettleReadBudget): boolean {
  const tombs = ownTombstones(db, id, work);
  const source = ownSource(db, id, work);
  if (tombs.length || source?.gone) return true;
  if (!source) return false;
  // Branch-change pending applies only to the source, not to a bring-in origin.
  const thread = work.text(db, "thread_id", "memory_sources WHERE id=?", id);
  if (thread !== null && work.one(db, "SELECT 1 FROM branch_change WHERE thread_id=?", thread)) return true;
  if (!source.brought) return false;
  const payload = work.text(db, "payload", "memory_source_versions WHERE source_id=? AND revision=?", id, source.revision);
  if (payload === null) return false;
  const origins: unknown = JSON.parse(payload)?.broughtFrom?.sources;
  if (origins === undefined) return false;
  // json_each emits one missing-origin row for JSON null, but none for an absent path.
  if (origins === null) { work.charge(); return true; }
  // json_each also accepts objects; account for their raw values before walking them.
  const values: unknown[] = [];
  if (typeof origins === "object") {
    for (const key in origins) {
      if (!Object.hasOwn(origins, key)) continue;
      work.charge(); values.push((origins as Record<string, unknown>)[key]);
    }
  } else { work.charge(); values.push(origins); }
  for (const value of values) {
    work.check();
    const origin = value as { id?: unknown; revision?: unknown } | null;
    if (typeof origin?.id !== "string") throw new Error("SETTLE_ORIGIN_SHAPE");
    const from = ownSource(db, origin.id, work);
    if (!from || from.gone) return true;
    const tombstones = ownTombstones(db, origin.id, work);
    const revision = typeof origin.revision === "boolean" ? Number(origin.revision)
      : typeof origin.revision === "string" && /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\t\n\v\f\r ]*$/.test(origin.revision) ? Number(origin.revision) : origin.revision;
    if (tombstones.some(row => row.revision === null || row.revision === revision)) return true;
  }
  return false;
}
export interface OwnLineVerdicts {
  verdicts: Map<string, LineageVerdict>;
  lsns: Map<string, number>;
  prefix: LineageVerdict;
  pending: OwnPendingRow[];
}
/** Content-only equivalent of lookupPage(infer=true) plus the prefix verdict.
 * An incomplete raw read throws SettleReadLimit; it must never be interpreted as clearance. */
export function ownLineVerdicts(db: DatabaseSync, threadId: string, messageIds: readonly string[], reader: LineageReader,
  headLsn: number, work = new SettleReadBudget(), pending = readOwnPending(db, threadId, work)): OwnLineVerdicts {
  if (messageIds.length > 512) throw new SettleReadLimit("ids");
  if (reader.audience !== null) throw new Error("SETTLE_CONTENT_READER_REQUIRED");
  work.check();
  const verdicts = new Map<string, LineageVerdict>(), lsns = new Map<string, number>();
  const denied = !!work.one(db, "SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?", threadId);
  const certificate = work.one(db, "SELECT ready FROM memory_lineage_cert WHERE id=1");
  const readyRow = work.one(db, "SELECT ready FROM memory_lineage_thread_ready WHERE thread_id=?", threadId);
  const ready = Number(certificate?.ready ?? 0) === 1 && (!readyRow || Number(readyRow.ready) === 1);
  const prefix = denied ? withheld("thread-deny") : !ready ? checking("thread-not-ready") : pending.some(row => row.since <= headLsn) ? checking("pending") : SHOWN;
  const no = num(work.one(db, "SELECT no FROM memory_thread_no WHERE thread_id=?", threadId)?.no);
  const generated = new Map<string, LineageRow>();
  for (const id of new Set(messageIds)) {
    work.check();
    if (denied) { verdicts.set(id, withheld("thread-deny")); continue; }
    const row = work.one(db, "SELECT role='user' AS human FROM messages WHERE thread_id=? AND id=?", threadId, id);
    if (!row) { verdicts.set(id, withheld("tombstone")); continue; }
    const json = work.text(db, "json", "messages WHERE thread_id=? AND id=?", threadId, id);
    const flag: unknown = json === null ? null : JSON.parse(json)?.withheldFromBots;
    const flagged = flag !== "checking" && flag !== null && flag !== undefined && flag !== false && flag !== 0 && flag !== "false";
    if (reader.ownFlag !== false && flagged) { verdicts.set(id, withheld("own-flag")); continue; }
    if (ownForgotten(db, `message:${threadId}:${id}`, work)) { verdicts.set(id, withheld("tombstone")); continue; }
    const lin = no === null ? undefined : work.one(db, "SELECT lsn,turn_lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?", no, id);
    if (lin) {
      if (!Number.isSafeInteger(lin.lsn) || (lin.turn_lsn !== null && !Number.isSafeInteger(lin.turn_lsn))) throw new Error("SETTLE_LINE_POSITION");
      lsns.set(id, Number(lin.lsn));
    }
    if (row.human && (lin?.turn_lsn === null || lin?.turn_lsn === undefined)) { verdicts.set(id, SHOWN); continue; }
    if (!lin) { verdicts.set(id, checking("no-lineage")); continue; }
    generated.set(id, { lsn: Number(lin.lsn), turnLsn: num(lin.turn_lsn), generated: true, memLsn: null, footprint: null });
  }
  const content = (row: Row) => !work.one(db, "SELECT 1 FROM memory_revoke_audience WHERE revoke_id=?", Number(row.revoke_id));
  let ranges: Row[] = [];
  if (generated.size) {
    const top = Math.max(...[...generated.values()].map(lin => lin.lsn));
    // Read all raw rows before audience filtering, even if the legacy reader would collapse at 257 content ranges.
    ranges = work.rows(db, "SELECT from_lsn,until_turn_lsn,revoke_id FROM memory_deny_range WHERE thread_id=? AND from_lsn<? ORDER BY from_lsn,revoke_id LIMIT ?", threadId, top)
      .filter(row => Number(row.revoke_id) !== AUDIENCE_COALESCED && content(row));
  }
  for (const [id, lin] of generated) {
    const marks = work.rows(db, "SELECT revoke_id FROM memory_deny_point WHERE thread_id=? AND lsn=? ORDER BY revoke_id LIMIT ?", threadId, lin.lsn);
    let verdict = marks.some(content) ? withheld("deny-line") : SHOWN;
    if (verdict.state === "shown" && (ranges.length > RANGE_READ_LIMIT ? Number(ranges[0]!.from_lsn) < lin.lsn : ranges.some(row => Number(row.from_lsn) < lin.lsn && (lin.turnLsn ?? 0) < Number(row.until_turn_lsn)))) verdict = withheld("deny-range");
    if (verdict.state !== "withheld") {
      if (!ready) verdict = checking("thread-not-ready");
      else if (pending.some(row => row.since <= lin.lsn && (lin.turnLsn ?? 0) < row.cap)) verdict = checking("pending");
    }
    verdicts.set(id, verdict);
  }
  work.check();
  return { verdicts, lsns, prefix, pending };
}

/** A bounded footprint supplies the probes. The reader's complete membership is never copied. */
function lineageAudienceHasScope(db: DatabaseSync,audience: import('./lineage-types.ts').LineageAudience,scope: string): boolean {
  if(audience.scopeCeiling && !audience.scopeCeiling.includes(scope))return false;
  if(audience.view){assertRecallView(db,audience.view);return recallViewHasScope(db,audience.view,scope,audience.recallOnly!==true,audience.personOnly===true);}
  return audience.scopeIds.includes(scope);
}
