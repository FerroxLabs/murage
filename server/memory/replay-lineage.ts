// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which generated messages a memory receipt still vouches for (0.1.61).
//
// A bot reply made with recalled memory is linked to the receipt of that
// recall (memory_disclosures.output_message_ids). When what the receipt used
// is forgotten, deleted or changed, the reply is withheld from the
// transcript bots read (disclosures.ts). The same reply lives on in other
// places, and each of them has to follow it:
// - its captured source, and every record built on it (recall, the thread
//   checkpoint, memory search): recordRestsOnWithheldMessage;
// - a copy of it posted somewhere else (a delegation or ask reply mirrored
//   into the pair room or the room that asked): Message.copyOf, followed by
//   replayExclusions.
//
// Work is bounded by what is asked about, not by the thread: only the
// receipts that list one of the given messages are read (the output index),
// and each distinct record, source and cited list is judged once per check
// (0.1.61.1 memreplay: a long direct chat failed every turn once its output
// lists outgrew a whole-thread budget). Past the node and receipt budgets a
// caller that asks for failClosed gets the message withheld instead of an
// error, so a turn never fails and never shows what it could not check.
import type { DatabaseSync } from "node:sqlite";
import { ancestryUnrepaired, connectionId, database } from "../database.ts";
import { authorityParts } from "./authority-epoch.ts";
import { statementReusePassId, writeStamp } from "../io-budget.ts";
import { supersededThreadCheckpoint, threadCheckpointId } from "./checkpoints.ts";
import { ancestryThreadRepaired, loadRootSetForest, provenRootSets } from "./schema.ts";
import { forgetRootSetHandles, handleFor, handleKeys, layeredOf, LayeredRoots, storeLayered, type Handle, type HandleCache, type RootView } from "./root-set-handles.ts";
import { heldStep } from "../observe.ts";
type DatabaseLike = ReturnType<typeof database>;

// One prepared statement per SQL text, kept for the life of the connection. The checks here run
// the same few dozen statements thousands of times a turn, and preparing them again each time cost
// 4-6 s of server CPU over 40 turns (perf102). Only get/all/run are used on them, each of which runs
// to completion synchronously, so a statement is never held by two callers at once. A closed
// connection takes its statements with it (WeakMap).
type Statement = ReturnType<DatabaseLike["prepare"]>;
const statements = new WeakMap<object, Map<string, Statement>>();
function stmt(db: DatabaseLike, sql: string): Statement {
  let known = statements.get(db);
  if (!known) statements.set(db, known = new Map());
  let statement = known.get(sql);
  if (!statement) {
    if (known.size >= 256) known.clear();
    statement = db.prepare(sql);
    known.set(sql, statement);
  }
  return statement;
}
/** Test hook: how many statements the cache holds for the shared connection. */
export function lineageStatementCount(): number { return statements.get(database())?.size ?? 0; }

/** The dependency a verdict takes on one cited record version. A thread's own checkpoint rolls on
 * every captured message: the version a receipt cites is archived, and it stays valid there
 * (checkpoints.ts supersededThreadCheckpoint) while a newer version is active. Such a version is
 * filed under "t" with its id's "c" key, so the roll itself (trigger key "k") leaves the verdict
 * alone, while losing every active version ("c") or any other change to the version ("r") still
 * drops it. Every other record is filed under "r". */
function recordDep(id: string, version: number, row: Record<string, unknown> | undefined, own: string): void {
  if (row && row.kind === "checkpoint" && id === threadCheckpointId(String(row.scope_id), own)) { dep("t", id, String(version)); dep("c", id); return; }
  dep("r", id, String(version));
  if (row && row.state !== "active") dep("c", id);
}

export type Disclosure = Record<string,string|number|bigint|Uint8Array|null>;

// A check that cannot finish withholds the line; say so once per reason, so
// a real fault does not pass as quiet withholding.
const warned = new Set<string>();
/** Checks that could not finish so far (each withheld what it could not prove): a verdict reached past one is unproven. */
let unfinished = 0;
/** Cycles met while walking a lineage, caught or not (a verdict reached past one is not kept). */
let cycleThrown = 0;
function noteWithheldOnError(error: unknown) {
  unfinished++;
  const reason = error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "unknown";
  // a cycle that withheld something: what was judged around it depends on where the walk began (judgeCapturedMessages)
  if (reason === "MEMORY_REPLAY_LINEAGE_CYCLE") cycles++;
  if (reason === "MEMORY_REPLAY_LIMIT") limitWithheld++;
  if (warned.has(reason) || warned.size > 32) return;
  warned.add(reason);
  console.warn(`[memory] a replay check could not finish (${reason}); the line is withheld from bots`);
}
/** Where a message was copied from: the original thread and its message ids. */
export interface MessageCopy { threadId: string; messageIds: string[] }
/** role "user": the owner's or a person's own words. Only bot output is ever
 * linked to a receipt (dispatch.ts), so those are never looked up. */
export interface ReplayMessage { id: string; role?: string; copyOf?: MessageCopy }
/** The reader's side of a replay check. Null means content checks only. */
export interface ReplayAudience {
  policyRevision: number; deletionEpoch: number; revoked(row: Disclosure): boolean;
  /** How a copy's original receipt is judged for this reader (default: `revoked`).
   * The owner's own conversation judges it on content: the owner may read what
   * any of their bots was told, so a delegation result built on the helper's
   * private checkpoint is still the owner's to see. */
  copyOriginRevoked?(row: Disclosure): boolean;
  /** Names the reader (who they are, what they may read, the policy revision and deletion epoch they read under). Two audiences with the
   * same key judge every receipt the same way while the authority stamp holds, so their set verdicts are kept and shared; an audience
   * with no key is judged afresh every time. */
  cacheKey?: string;
}

/** A room past this many receipts checks only the lines a member prompt can
 * show (room-transcript.ts). */
export const THREAD_RECEIPT_LIMIT = 2048;
/** Distinct receipts one check may judge, across every thread its lineage
 * reaches. A resumed session links each reply to every receipt before it,
 * so the newest reply of a long session is vouched for by all of them. */
export const REPLAY_RECEIPT_BUDGET = 65536;
/** Lineage work one check may do (cited lists, records, derivation and
 * evidence rows, sources), each distinct one counted once. */
const REPLAY_NODE_BUDGET = 50000;
/** Tests lower the node budget to reach the budget-exhausted path; null is the real one. */
let nodeBudgetOverride: number | null = null;
export function setReplayNodeBudgetForTest(budget: number | null): void { nodeBudgetOverride = budget; }
/** Replay checks withheld because a budget ran out (MEMORY_REPLAY_LIMIT), for tests. */
let limitWithheld = 0;
export function replayLimitWithheld(): number { return limitWithheld; }
/** (receipt, message) pairs read one by one before a check judges the
 * thread's receipt groups instead. */
const PAIR_LIMIT = 20000;
const COPY_HOPS = 4, COPY_ORIGINS = 64;
/** The one hard ceiling on a root set (memory schema v6), against
 * pathological growth only: a set is never truncated. A retained session
 * whose set comes within ROOT_SET_HEADROOM of it resets before its next turn
 * (its replies are not withheld); only a reply whose own context alone passes
 * the ceiling is marked unprovable (an empty set id) and withheld. */
export const ROOT_SET_CEILING = 50000;
let ceilingOverride: number | null = null;
/** Tests lower the ceiling to reach the reset path; null is the real one. */
export function setRootSetCeilingForTest(ceiling: number | null): void { ceilingOverride = ceiling; }
const rootCeiling = () => ceilingOverride ?? ROOT_SET_CEILING;
/** A session set past this resets: room for one more turn's roots. */
const sessionCeiling = () => rootCeiling() - Math.floor(rootCeiling() / 10);
// Output lists are not read: the output index answers which receipts list a
// message, and a resumed session's lists grow with every reply.

export function largeReceiptThread(threadId: string): boolean {
  const row = stmt(database(), "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(threadId, THREAD_RECEIPT_LIMIT+1);
  return Number(row?.n ?? 0) > THREAD_RECEIPT_LIMIT;
}

/** The copy link a stored message carries, if any. */
export function messageCopy(threadId: string, messageId: string): MessageCopy | undefined {
  dirtyMessage(threadId, messageId);
  const row = stmt(database(), "SELECT json_extract(json,'$.copyOf') AS copy FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (typeof row?.copy !== "string") return undefined;
  try {
    const copy = JSON.parse(row.copy) as MessageCopy;
    return typeof copy?.threadId === "string" && Array.isArray(copy.messageIds) ? { threadId: copy.threadId, messageIds: copy.messageIds.filter(id => typeof id === "string") } : undefined;
  } catch { return undefined; }
}

/** The owner forgot the message itself (its captured source is deleted or tombstoned). */
export function messageSourceForgotten(threadId: string, messageId: string): boolean {
  const db = database(), sourceId = `message:${threadId}:${messageId}`;
  dep("s", sourceId);
  const source = stmt(db, "SELECT state FROM memory_sources WHERE id=?").get(sourceId);
  return source?.state === "deleted" || Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1").get(sourceId));
}

/** Verdicts reached without knowing what they rested on (a memo entry made outside any verdict's scope, or one cut short). */
let untracked = 0;
/** THE check-wide taint (1.0.2 r5). While a top-level check runs, `checkBase` is the `untracked` count it began with and `checkKept` every
 * verdict it kept (any judge, any reuse structure). The moment `untracked` moves, a memo hit lacked a recorded dependency set: nothing
 * further in that check is kept (`keepVerdict`), and what it already kept is discarded when it ends. No propagation through groupRests
 * or any other reuse: the blunt rule is what keeps warm replay from showing what an unbounded cold check would withhold. */
let checkBase: number | null = null;
let checkKept: string[] | null = null, checkExhausted = false;
const checkTainted = (): boolean => checkBase !== null && untracked !== checkBase;
function keepVerdict(key: string, entry: Verdict): boolean {
  if (checkTainted() || checkExhausted || !remember(key, entry)) return false;
  checkKept?.push(key);
  return true;
}
/** THE within-check memo (1.0.2 r4: every per-check memo of the judge goes through it, none is a bare Map or Set). An entry keeps the
 * dependencies that were collected when it was made: the exact set the judgement consulted for `run`, the scope's set up to its size
 * at that moment for `set`. A hit merges them into the scope that is collecting now, so reading an entry rests on exactly what making
 * it did, whichever scope made it and whichever reads it. An entry made where nothing was collected cannot say what it rests on: a
 * hit of it inside a scope marks that scope's proof as not kept. */
export class JudgeMemo<T> {
  private readonly entries = new Map<string, { value: T; deps: Set<string> | null; upTo: number }>();
  private absorb(entry: { deps: Set<string> | null; upTo: number }): void {
    if (!collected) return;
    if (!entry.deps) { untracked++; return; }
    if (entry.deps === collected) return;
    let seen = 0;
    for (const d of entry.deps) { if (seen++ >= entry.upTo) break; collected.add(d); }
  }
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.absorb(entry);
    return true;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.absorb(entry);
    return entry.value;
  }
  /** Records a value reached in the current scope. */
  set(key: string, value: T): void { this.entries.set(key, { value, deps: collected, upTo: collected ? collected.size : 0 }); }
  /** `judge` run once per `key`; a later reader rests on the same things. */
  run(key: string, judge: () => T): T {
    const known = this.entries.get(key);
    if (known) { this.absorb(known); return known.value; }
    const outer = collected, mine = outer ? new Set<string>() : null;
    collected = mine;
    let value: T;
    try { value = judge(); }
    catch (error) { collected = outer; if (outer && mine) { for (const d of mine) outer.add(d); untracked++; } throw error; }
    collected = outer;
    this.entries.set(key, { value, deps: mine, upTo: mine ? mine.size : 0 });
    if (mine && outer) for (const d of mine) outer.add(d);
    return value;
  }
}

/** The content half of a receipt check: every record and source the receipt
 * cites still exists at the version disclosed, and nothing of it was
 * forgotten. No reader access and no global counter is consulted. */
export function contentRevoked(row: Disclosure, threadId: string, memo?: JudgeMemo<boolean>): boolean {
  try {
    const db = database();
    // A session's receipts cite the same records and sources again and again: one check judges each once.
    const once = (key: string, judge: () => boolean): boolean => memo ? memo.run(key, judge) : judge();
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) {
      const bad = once(`r\u0000${record.id}\u0000${record.version}`, () => {
        const current = stmt(db, "SELECT state,kind,scope_id FROM memory_records WHERE id=? AND version=?").get(record.id,record.version);
        recordDep(record.id, record.version, current, threadId);
        if (!current || (current.state!=="active" && !supersededThreadCheckpoint(record.id,record.version,{threadId}))) return true;
        return Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(record.id,record.version));
      });
      if (bad) return true;
    }
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      dep("s", source.id);
      const bad = once(`s\u0000${source.id}\u0000${source.revision}`, () => {
        const current = stmt(db, "SELECT state,revision FROM memory_sources WHERE id=?").get(source.id);
        return !current || current.state!=="active" || current.revision!==source.revision || Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision));
      });
      if (bad) return true;
    }
    return false;
  } catch { return true; }
}

/** Index entries and rows the replay checks have read, for tests that pin
 * the work down rather than the time (machines differ). */
let rowsRead = 0;
export function replayRowsRead(): number { return rowsRead; }
export function resetReplayRowsRead(): void { rowsRead = 0; }

/** Receipts that share everything a verdict rests on (thread, state, policy
 * revision, deletion epoch, what they cite): one is judged for all of them.
 * The receipts of one resumed session cite the same frame, so a session of
 * any length is one group per distinct frame (0.1.61.1 memreplay, review M2). */
interface ReceiptGroup { row: Disclosure; bundles: string[] }
const GROUP_COLUMNS = `thread_id,state,policy_revision,deletion_epoch,
  CASE WHEN length(record_versions)<=262144 THEN record_versions END AS record_versions,
  CASE WHEN length(source_versions)<=262144 THEN source_versions END AS source_versions,
  json_group_array(bundle_id) AS bundles, max(rowid) AS latest`;
const GROUP_BY = "GROUP BY thread_id,state,policy_revision,deletion_epoch,record_versions,source_versions ORDER BY latest DESC";

/** One check's judge: verdicts per receipt, per group, per cited list, per
 * record and per proven reply last for this check only. */
function lineageJudge(threadId: string, audience: ReplayAudience | null, invalidBundles?: Set<string>) {
  const db = database();
  const readerKey = audience?.cacheKey ? JSON.stringify([threadId, audience.cacheKey]) : "";
  /** Per receipt, per cited content of the reader's own receipts, per cited
   * content in its thread, per record in a thread: true = bad. */
  const verdicts = new Map<string,boolean>();
  const ownVerdicts = new JudgeMemo<boolean>(), citedVerdicts = new JudgeMemo<boolean>();
  const refVerdicts = new JudgeMemo<{bad:boolean;sources:string[]}>();
  /** Per cited record and source, for the content rule: judged once per check. */
  const contentMemo = new JudgeMemo<boolean>();
  /** Captured replies proven still vouched for, by thread and message. */
  let soundReplies = new JudgeMemo<boolean>();
  /** What a group's verdict, once reached in this check, rests on: the kept verdict that holds it (its key) or, where
   * none could be kept, what it consulted. A verdict read again from `verdicts` consults the same things. */
  const groupRests = new Map<string,string|Set<string>>();
  /** Bundles whose verdict was reached cleanly (no cycle, nothing unfinished) even where it was not kept: what it consulted is its whole basis. */
  const groupClean = new Set<string>();
  /** What is being judged right now: met again, the lineage is a cycle. */
  const visiting = new Set<string>();
  let receiptCount = 0, nodes = 0;
  const ownsCheck = checkBase === null;
  if (ownsCheck) { checkBase = untracked; checkKept = []; }
  /** Set once any budget of this check ran out. A check that ran out proves nothing it could not finish, so none of what it kept
   * is left kept (`settle`, run when the check ends): the next check would be charged nothing for the parts that were finished, get
   * further than this one and show what it withheld, where a check from nothing withholds it (1.0.2 r4 P2). */
  let exhausted = false;
  const kept: string[] = [];
  const limit = (): Error => { exhausted = true; if (checkBase !== null) checkExhausted = true; return new Error("MEMORY_REPLAY_LIMIT"); };
  const keep = (key: string, entry: Verdict): boolean => { if (exhausted || !keepVerdict(key, entry)) return false; kept.push(key); return true; };
  const settle = (): void => {
    if (exhausted && kept.length) forgetKept(kept.splice(0));
    if (!ownsCheck) return;
    // the check that owns the taint settles everything kept anywhere in it
    if ((checkTainted() || checkExhausted) && checkKept?.length) forgetKept(checkKept);
    checkBase = null; checkKept = null; checkExhausted = false;
  };
  const charge = (count=1) => { nodes+=count; rowsRead+=count; if(nodes>(nodeBudgetOverride ?? REPLAY_NODE_BUDGET)) throw limit(); };
  const within = <T>(key: string, work: () => T): T => {
    if (visiting.has(key)) { cycleThrown++; throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE"); }
    visiting.add(key);
    try { return work(); } finally { visiting.delete(key); }
  };
  const toGroups = (rows: Disclosure[]): ReceiptGroup[] => {
    // every row read is charged, and a listing past the receipt budget fails
    charge(rows.length);
    let receipts = 0;
    const groups = rows.map(row => { const bundles = JSON.parse(String(row.bundles)) as string[]; receipts += bundles.length; return { row, bundles }; });
    rowsRead += receipts;
    if (receipts > REPLAY_RECEIPT_BUDGET) throw limit();
    return groups;
  };
  /** The receipts of `thread` that list any of `messageIds` as an output,
   * through the output index (memory schema v3), grouped, newest first. A
   * reply rests on every receipt of its session made no later than the
   * newest receipt listing it: linkMemoryDisclosureOutput lists it on its own
   * receipt and the session's newest only, where it used to write it into
   * every receipt of the session (a reply written that way is listed by all
   * of them already, and the same rule finds the same receipts). */
  const listingFull = (thread: string, messageIds: readonly string[]): ReceiptGroup[] =>
    toGroups(stmt(db, `WITH direct(b) AS MATERIALIZED (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))),
      sessions(d,ns,c) AS (SELECT l.driver_instance, l.native_session, max(l.rowid) FROM direct JOIN memory_disclosures l ON l.bundle_id=direct.b WHERE l.native_session IS NOT NULL GROUP BY 1,2)
      SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND bundle_id IN (SELECT b FROM direct
        UNION SELECT s.bundle_id FROM sessions JOIN memory_disclosures s ON s.thread_id=? AND s.driver_instance=sessions.d AND s.native_session=sessions.ns AND s.rowid<=sessions.c)
      ${GROUP_BY} LIMIT ?`).all(thread, JSON.stringify(messageIds), thread, thread, REPLAY_RECEIPT_BUDGET+1));
  /** The same listing, where a session's earlier receipts are not read again while they are proven sound. On content, the
   * receipts of a session up to a receipt are judged once and kept as one verdict (kept like any other, dropped by what the
   * receipts rest on and by a change to any receipt of the session); the next turn judges only the receipts written since,
   * so the work per turn follows the new receipts, not the length of the session. Anything that is not plainly sound
   * (a bad or unfinished receipt, a cycle, no cache) is listed in full, as before. */
  const fallback = (thread: string, messageIds: readonly string[]): ReceiptGroup[] => { listingFallbacks.all++; if (database().isTransaction) listingFallbacks.inTransaction++; return listingFull(thread, messageIds); };
  /** The receipts of one native session up to `c` proven sound on content, judging only those written since the last proof (a kept
   * verdict, dropped by what the receipts rest on and by a change to any receipt of the session). Returns the kept verdict to rest
   * on (`v` key), "" where the proof serves this call only (the capture transaction is still open: it rests on what it consulted,
   * added to the check being worked out), or null when it is not plainly sound (a bad or unfinished receipt, a cycle, no room). */
  const provePrefix = (cache: Map<string, Verdict>, thread: string, d: string, ns: string, c: number): string | null => {
    const sessionKey = JSON.stringify([thread, d, ns]);
    let held = sessionSound.get(sessionKey);
    if (held && !cache.has(held.key)) { sessionSound.delete(sessionKey); held = undefined; }
    if (held && held.upTo >= c) return `v${SEP}${held.key}`;
    const lo = held?.upTo ?? 0;
    const consulted = new Set<string>([`a${SEP}${thread}${SEP}${d}${SEP}${ns}`]);
    if (held) consulted.add(`v${SEP}${held.key}`);
    let sound = true;
    try {
      const fresh = toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? AND rowid<=?
        ${GROUP_BY} LIMIT ?`).all(thread, d, ns, lo, c, REPLAY_RECEIPT_BUDGET+1));
      for (const group of fresh) {
        if (groupBad(group)) { sound = false; break; }
        const first = group.bundles[0] ?? "", rests = groupRests.get(first);
        if (typeof rests === "string") consulted.add(rests);
        // not kept because the transaction is still open, but reached cleanly: what it consulted is what it rests on
        else if (rests && keepRefused() && groupClean.has(first)) for (const x of rests) consulted.add(x);
        else { sound = false; break; }
      }
    } catch (error) {
      if (error instanceof LineageControl) throw error;
      sound = false;
    }
    if (!sound || consulted.size > 4000) return null;
    if (keepRefused()) { for (const x of consulted) collected?.add(x); return ""; }
    const key = `a${SEP}${JSON.stringify([thread, d, ns, c])}`;
    if (!keep(key, { withheld: false, unproven: false, deps: consulted })) return null;
    if (sessionSound.size > 4096) sessionSound.clear();
    sessionSound.set(sessionKey, { upTo: c, key });
    return `v${SEP}${key}`;
  };
  const listing = (thread: string, messageIds: readonly string[]): ReceiptGroup[] => {
    const cache = audience === null ? verdictCache() : undefined;
    if (!cache) return fallback(thread, messageIds);
    const ids = JSON.stringify(messageIds);
    const reached = stmt(db, `WITH direct(b) AS MATERIALIZED (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)))
      SELECT l.driver_instance AS d, l.native_session AS ns, max(l.rowid) AS c FROM direct JOIN memory_disclosures l ON l.bundle_id=direct.b WHERE l.native_session IS NOT NULL GROUP BY 1,2`).all(thread, ids);
    if (!reached.length) return fallback(thread, messageIds);
    const covers: string[] = [];
    for (const row of reached) {
      const cover = provePrefix(cache, thread, String(row.d), String(row.ns), Number(row.c));
      if (cover === null) return fallback(thread, messageIds);
      if (cover) covers.push(cover);
    }
    for (const cover of covers) collected?.add(cover);
    return toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND bundle_id IN (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)))
      ${GROUP_BY} LIMIT ?`).all(thread, thread, ids, REPLAY_RECEIPT_BUDGET+1));
  };
  /** Whether every receipt of one native session is proven sound on content (nothing to judge again but the receipts written since).
   * False means "not proven", and the caller judges every receipt as before. */
  const sessionProven = (driverInstance: string, nativeSession: string): boolean => {
    const cache = audience === null ? verdictCache() : undefined;
    if (!cache) return false;
    const c = Number(stmt(db, "SELECT max(rowid) AS c FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession)?.c ?? 0);
    if (!c) return false;
    return provePrefix(cache, threadId, driverInstance, nativeSession, c) !== null;
  };
  /** Every receipt of a thread, grouped, read once per check. */
  const threadGroupCache = new Map<string,ReceiptGroup[]>();
  /** Receipts per thread (counted no further than the limit), once per check. */
  const receiptCounts = new Map<string,number>();
  /** Threads whose whole read ran out of budget, so later calls list at once. */
  const threadTooLong = new Set<string>();
  const threadGroups = (thread: string): ReceiptGroup[] => {
    let groups = threadGroupCache.get(thread);
    if (!groups) {
      groups = toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? ${GROUP_BY} LIMIT ?`).all(thread, REPLAY_RECEIPT_BUDGET+1));
      threadGroupCache.set(thread, groups);
    }
    return groups;
  };
  /** The groups to judge for `messageIds` of `thread`, and whether they are
   * exactly the receipts that list them. Reading every (receipt, message)
   * pair costs a row lookup each, and a long resumed session lists each
   * reply on every receipt before it, so past PAIR_LIMIT pairs (counted from
   * the index alone) the thread's groups are judged instead, and a bad group
   * then counts only for the messages it actually lists (review M2). */
  const producers = (thread: string, messageIds: readonly string[]): {groups: ReceiptGroup[]; exact: boolean} => {
    for (const id of messageIds) dirtyMessage(thread, id);
    // Counted no further than the limit: the count itself is index work. A
    // thread of few receipts is judged as a whole (one grouped read of them)
    // when listing the pairs would cost more rows than the receipts there are:
    // a resumed session lists every reply on every receipt before it, so the
    // pairs grow as turns squared while the receipts grow as turns.
    const pairSql = `SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=?
      AND message_id IN (SELECT value FROM json_each(?)) LIMIT ?)`;
    // nothing lists these messages: one index probe, no receipts read
    if (!Number(stmt(db, pairSql).get(thread, JSON.stringify(messageIds), 1)?.n ?? 0)) { charge(); return { groups: [], exact: true }; }
    // counted once per thread per check (Astra r4 #7)
    let receipts = receiptCounts.get(thread);
    if (receipts === undefined) {
      receipts = Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, THREAD_RECEIPT_LIMIT+1)?.n ?? 0);
      rowsRead += receipts;
      receiptCounts.set(thread, receipts);
    }
    // A thread of more receipts than the receipt limit counts its pairs no
    // further than that limit either: counting to PAIR_LIMIT charged 20,000
    // rows for a count that only decides between two reads, on every check of
    // every long thread. Past the cap the thread's groups are judged; only if
    // that read runs out of budget are the pairs counted to PAIR_LIMIT and
    // listed, as before.
    const pairCap = receipts <= THREAD_RECEIPT_LIMIT ? Math.min(PAIR_LIMIT, receipts) : THREAD_RECEIPT_LIMIT;
    const pairs = Number(stmt(db, pairSql).get(thread, JSON.stringify(messageIds), pairCap+1)?.n ?? 0);
    rowsRead += pairs;
    charge();
    if (pairs <= pairCap) return { groups: listing(thread, messageIds), exact: true };
    if (receipts <= THREAD_RECEIPT_LIMIT) return { groups: threadGroups(thread), exact: false };
    // Too many receipts to read whole (found on an earlier call): list.
    if (!threadTooLong.has(thread)) {
      const spent = nodes, wasExhausted = exhausted, wasCheckExhausted = checkExhausted;
      try { return { groups: threadGroups(thread), exact: false }; }
      catch (error) {
        if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT")) throw error;
        // the failed read's charge is given back, so listing is possible
        nodes = spent; exhausted = wasExhausted; checkExhausted = wasCheckExhausted; threadTooLong.add(thread);
      }
    }
    const all = Number(stmt(db, pairSql).get(thread, JSON.stringify(messageIds), PAIR_LIMIT+1)?.n ?? 0);
    rowsRead += all;
    if (all <= PAIR_LIMIT) return { groups: listing(thread, messageIds), exact: true };
    throw limit();
  };
  /** Of `messageIds`, the ones one of `bundles` lists (`first`: stop at
   * one). Per message, from the cheaper side: its own receipts, or a probe of
   * each bundle, so a message costs at most the smaller of the two; its
   * receipts are counted no further than that. */
  const listingAny = (thread: string, bundles: readonly string[], messageIds: readonly string[], first = true, wholeThread = false): string[] => {
    const set = new Set(bundles), bundleJson = JSON.stringify(bundles), hits: string[] = [];
    // `bundles` is every receipt of the thread: a message is listed by one of
    // them exactly when anything lists it, one index probe per message instead
    // of its receipts (all of them, for a reply of a long resumed session).
    if (wholeThread) {
      const any = stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1");
      for (const message of messageIds) {
        dirtyMessage(thread, message);
        charge();
        if (any.get(thread, message)) { hits.push(message); if (first) break; }
      }
      return hits;
    }
    // A message is listed by a bundle that lists it (first: from the cheaper side, its own receipts or a probe of
    // each bundle), or else by a receipt of the same session made no later than one that lists it
    // (linkMemoryDisclosureOutput): per session among `bundles`, the earliest receipt decides.
    const count = stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT ?)");
    const own = stmt(db, "SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=?");
    const probe = stmt(db, "SELECT 1 FROM json_each(?) b CROSS JOIN memory_disclosure_outputs o ON o.bundle_id=b.value AND o.message_id=? WHERE o.thread_id=? LIMIT 1");
    // a receipt of the session, made no earlier than the given time, that lists the message: the session's receipts in
    // turn, each one primary-key probe, stopping at the first
    const laterLister = stmt(db, `SELECT 1 FROM memory_disclosures s JOIN memory_disclosure_outputs o ON o.bundle_id=s.bundle_id AND o.message_id=?
      WHERE s.thread_id=? AND s.driver_instance=? AND s.native_session=? AND s.rowid>=? LIMIT 1`);
    let earliest: Map<string, {driver: string; session: string; at: number}> | undefined;
    const sessionsOfBundles = () => {
      if (earliest) return earliest;
      earliest = new Map();
      for (const row of stmt(db, "SELECT driver_instance,native_session,rowid AS seq FROM memory_disclosures WHERE bundle_id IN (SELECT value FROM json_each(?)) AND native_session IS NOT NULL").all(bundleJson)) {
        const key = `${String(row.driver_instance)}${SEP}${String(row.native_session)}`, at = Number(row.seq);
        if ((earliest.get(key)?.at ?? Infinity) > at) earliest.set(key, { driver: String(row.driver_instance), session: String(row.native_session), at });
      }
      rowsRead += set.size;
      return earliest;
    };
    for (const message of messageIds) {
      dirtyMessage(thread, message);
      charge();
      // a few bundles: probe them, no count needed
      const listers = set.size <= 64 ? Infinity : Number(count.get(thread, message, set.size+1)?.n ?? 0);
      if (listers !== Infinity) rowsRead += listers;
      if (!listers) continue;
      let listed: boolean;
      if (listers <= set.size) { listed = own.all(thread, message).some(row => set.has(String(row.bundle_id))); rowsRead += listers; }
      else { listed = Boolean(probe.get(bundleJson, message, thread)); rowsRead += set.size; }
      if (!listed && sessionsOfBundles().size) {
        for (const { driver, session, at } of earliest!.values()) { rowsRead++; if (laterLister.get(message, thread, driver, session, at)) { listed = true; break; } }
      }
      if (listed) { hits.push(message); if (first) break; }
    }
    return hits;
  };
  /** Whether a receipt that lists one of `messageIds` no longer holds. */
  const anyProducerBad = (thread: string, messageIds: readonly string[], depth: number, alsoBad?: (group: ReceiptGroup) => boolean): boolean => {
    const { groups, exact } = producers(thread, messageIds);
    for (const group of groups) {
      if (exact) { if (alsoBad?.(group) || groupBad(group, depth)) return true; continue; }
      // Judging the whole thread meets groups that list none of these
      // messages, among them the one being judged right now: their lineage
      // may lead back to it. Such a group's verdict does not matter here.
      let bad: boolean;
      try { bad = Boolean(alsoBad?.(group)) || groupBad(group, depth); }
      catch (error) {
        if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LINEAGE_CYCLE")) throw error;
        if (listingAny(thread, group.bundles, messageIds).length) throw error;
        continue;
      }
      if (bad && listingAny(thread, group.bundles, messageIds).length) return true;
    }
    return false;
  };
  /** Every receipt of one native session, grouped. */
  const session = (driverInstance: string, nativeSession: string): ReceiptGroup[] =>
    toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?
      ${GROUP_BY} LIMIT ?`).all(threadId, driverInstance, nativeSession, REPLAY_RECEIPT_BUDGET+1));
  /** The reader's own receipt, under its audience (or on content alone). Its
   * row-level fields were checked by the caller, so the verdict rests on what
   * it cites. */
  const ownBad = (row: Disclosure, cited: string): boolean => {
    return ownVerdicts.run(cited, () => {
      if (!audience) return contentRevoked(row, threadId, contentMemo);
      // the reader's answer rests on what the content check consults too: noted so a kept set verdict is dropped by the same keys
      if (collected) contentRevoked(row, threadId, contentMemo);
      return audience.revoked(row);
    });
  };
  const groupBad = (group: ReceiptGroup, depth = 0): boolean => {
    const unknown = group.bundles.filter(id => !verdicts.has(id));
    if (!unknown.length) {
      if (collected) {
        const rests = groupRests.get(group.bundles[0] ?? "");
        if (typeof rests === "string") collected.add(rests); else if (rests) for (const d of rests) collected.add(d);
        // a verdict with no recorded basis cannot be carried into another proof: that proof is not kept (1.0.2 r2 P1)
        else untracked++;
      }
      return group.bundles.some(id => verdicts.get(id));
    }
    if (depth > 64 || (receiptCount += unknown.length) > REPLAY_RECEIPT_BUDGET) throw limit();
    const row = group.row;
    if (row.record_versions === null || row.source_versions === null) throw limit();
    const own = String(row.thread_id);
    const judge = () => within(`group\u0000${JSON.stringify([own,row.state,row.policy_revision,row.deletion_epoch,row.record_versions,row.source_versions])}`, () => {
      if (audience !== null && (row.state === "revoked" || row.policy_revision !== audience.policyRevision || row.deletion_epoch !== audience.deletionEpoch)) return true;
      // Only this replay's receipts are hydrated under its audience. An explicitly
      // approved shared projection does not require access to a private ancestor.
      if (own === threadId && ownBad(row, `${row.record_versions}\u0000${row.source_versions}`)) return true;
      return citedBad(own, String(row.record_versions), String(row.source_versions), depth);
    });
    // On content (no reader) a group's verdict rests only on what its receipt cites, so it is kept across checks, dropped by
    // exactly what it consulted (the keys a message verdict is dropped by). A session's receipts each cite their own
    // checkpoint version, so a session of n turns is n groups, and judging them all again on every turn grew with the session
    // (perf102 long500). The group is judged with memos of its own so that what it consulted is all in its own list.
    const cache = audience === null ? verdictCache() : undefined;
    let bad: boolean | undefined, rests: string | Set<string> | undefined;
    const key = cache ? `g${SEP}${JSON.stringify([threadId,own,row.record_versions,row.source_versions])}` : "";
    const known = cache?.get(key);
    if (known) { bad = known.withheld; rests = `v${SEP}${key}`; cacheHits++; }
    else if (cache) {
      const outer = collected, cyclesBefore = cycles, thrownBefore = cycleThrown, unfinishedBefore = unfinished;
      const consulted = new Set<string>();
      const untrackedBefore = untracked;
      // what a memo hides (the replies already proven sound, the roots and root sets already judged) is judged afresh in here
      const [sound0, root0, set0] = [soundReplies, rootVerdicts, setVerdicts];
      soundReplies = new JudgeMemo<boolean>(); rootVerdicts = new JudgeMemo<boolean>(); setVerdicts = new JudgeMemo<boolean>();
      collected = consulted;
      try { bad = judge(); }
      finally { collected = outer; soundReplies = sound0; rootVerdicts = root0; setVerdicts = set0; }
      cacheMisses++;
      // A walk that met a cycle, or a check that could not finish, depends on where it began: it serves this call only.
      const clean = consulted.size <= 4000 && cycles === cyclesBefore && cycleThrown === thrownBefore && unfinished === unfinishedBefore && untracked === untrackedBefore;
      if (clean && keep(key, { withheld: bad, unproven: false, deps: consulted })) rests = `v${SEP}${key}`;
      else rests = consulted;
      if (clean) for (const id of unknown) groupClean.add(id);
      if (outer) { if (typeof rests === "string") outer.add(rests); else for (const d of rests) outer.add(d); }
    } else {
      // Not kept here (a reader's check, or a transaction still open): the verdict is still reached ONCE per check and read again
      // by whatever else lists these receipts, so what it consulted is recorded, and every reader of it rests on the same
      // things (1.0.2 r2 P1: a second root set sharing the receipt lost its dependency on what the receipt cites).
      const outer = collected, consulted = new Set<string>();
      collected = consulted;
      try { bad = judge(); }
      catch (error) { collected = outer; if (outer) { for (const d of consulted) outer.add(d); untracked++; } throw error; }
      collected = outer;
      rests = consulted;
      if (outer) for (const d of consulted) outer.add(d);
    }
    for (const id of unknown) { verdicts.set(id, bad as boolean); if (rests !== undefined) groupRests.set(id, rests); if (bad) invalidBundles?.add(id); }
    if (known && collected) collected.add(rests as string);
    return (bad as boolean) || group.bundles.some(id => verdicts.get(id));
  };
  /** What a receipt of thread `own` cites: every record and source still
   * current, and every reply any of it came from still vouched for. */
  const citedBad = (own: string, recordVersions: string, sourceVersions: string, depth: number): boolean => {
    const key = `${own}\u0000${recordVersions}\u0000${sourceVersions}`;
    return citedVerdicts.run(key, () => within(`cited\u0000${key}`, () => {
      const refs: Array<{id:string;version:number}> = JSON.parse(recordVersions);
      const direct: Array<{id:string;revision:number}> = JSON.parse(sourceVersions);
      charge(1+refs.length+direct.length);
      const sourceIds = new Set(direct.map(source=>source.id));
      for (const source of direct) {
        const current = sourceRow(source.id);
        if (!current || current.state!=="active" || current.revision!==source.revision) return true;
      }
      for (const ref of refs) {
        const verdict = refBad(ref, own);
        if (verdict.bad) return true;
        for (const sourceId of verdict.sources) sourceIds.add(sourceId);
      }
      return sourcesBad(sourceIds, depth);
    }));
  };
  /** One cited record (read from thread `own`): current, not forgotten, and
   * every record it was derived from still holds; with the sources its
   * evidence rests on, for the lineage check. */
  const refBad = (ref: {id:string;version:number}, own: string): {bad:boolean;sources:string[]} => {
    const key = `${own}\u0000${ref.id}\u0000${ref.version}`;
    return refVerdicts.run(key, (): {bad:boolean;sources:string[]} => {
      const sources: string[] = [];
      const current = stmt(db, "SELECT state,kind,scope_id FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
      recordDep(ref.id, ref.version, current, own);
      // A receipt's own thread checkpoint, superseded since, is stale there, not
      // revoked (checkpoints.ts), wherever the receipt is read from.
      if (!current || (current.state!=="active" && !supersededThreadCheckpoint(ref.id,ref.version,{threadId:own})) || stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(ref.id,ref.version)) return {bad:true,sources};
      // An owner's correction does not carry the old words, so the version
      // it replaced is history, not evidence (recordRestsOnWithheldMessage).
      const parents = stmt(db, `WITH RECURSIVE parents(id,version) AS (
        SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d
        JOIN parents p ON d.child_id=p.id AND d.child_version=p.version
        LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
        WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 1025)
        SELECT id,version FROM parents`).all(ref.id,ref.version);
      if (parents.length > 1024) throw limit();
      charge(parents.length);
      // Content checks cannot lean on the global policy revision a correction
      // moves, so every record the ref was derived from must still be current:
      // a projection whose original the owner corrected carries the old words.
      // A correction's own history edge (the child supersedes that parent) is
      // not a dependency.
      if (!audience) {
        const edges = stmt(db, `WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
          SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
          UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
          JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
          -- not past an owner's correction: the version it replaced is history (Astra r3 #2)
          LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
          WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT 1025)
          SELECT e.parent_id,e.parent_version,e.child_id,e.child_version,p.state,c.supersedes_id FROM edges e
          LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
          LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(ref.id,ref.version);
        if (edges.length > 1024) throw limit();
        charge(edges.length);
        for (const edge of edges) { dep("r", String(edge.parent_id), String(edge.parent_version)); dep("r", String(edge.child_id), String(edge.child_version)); }
        // A parent replaced by a record in this same chain is history, not a
        // dependency, however many corrections and projections lie between.
        const replacing = new Set(edges.map(edge=>String(edge.supersedes_id??"")));
        const self = stmt(db, "SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
        if (self?.supersedes_id) replacing.add(String(self.supersedes_id));
        for (const edge of edges) {
          const history = replacing.has(String(edge.parent_id)) && (edge.state==="superseded" || edge.state==="archived");
          if (!edge.state || (edge.state!=="active" && !history) || stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(edge.parent_id,edge.parent_version)) return {bad:true,sources};
        }
      }
      for (const parent of parents) {
        const evidence = stmt(db, "SELECT e.source_id,e.source_revision,s.revision,s.state FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? LIMIT 1025").all(parent.id,parent.version);
        if (evidence.length > 1024) throw limit();
        charge(evidence.length);
        for (const source of evidence) {
          dep("s", String(source.source_id));
          if (source.state!=="active" || source.revision!==source.source_revision) return {bad:true,sources};
          sources.push(String(source.source_id));
        }
      }
      return {bad:false,sources};
    });
  };
  /** One source row per check: a session's receipts cite the same sources again and again, and the row cannot change while the check runs. */
  const sourceRows = new Map<string, Record<string, unknown> | undefined>();
  const sourceRow = (id: string) => {
    dep("s", id);
    if (!sourceRows.has(id)) sourceRows.set(id, stmt(db, "SELECT state,revision,thread_id,message_id FROM memory_sources WHERE id=?").get(id));
    return sourceRows.get(id);
  };
  /** Cited sources: still there, and the captured replies among them still
   * vouched for by every receipt that produced them (read in one grouped
   * listing per thread), and by their originals if they are copies. */
  const sourcesBad = (sourceIds: ReadonlySet<string>, depth: number): boolean => {
    const replies = new Map<string,string[]>();
    for (const sourceId of sourceIds) {
      charge();
      const source = sourceRow(sourceId);
      if (!source || source.state!=="active") return true;
      if (!source.thread_id || !source.message_id) continue;
      const thread = String(source.thread_id), message = String(source.message_id);
      if (soundReplies.has(`${thread}\u0000${message}`)) continue;
      let list = replies.get(thread);
      if (!list) replies.set(thread, list = []);
      list.push(message);
    }
    for (const [thread, cited] of replies) {
      let messages = cited;
      if (audience === null) {
        // On content (no reader), a cited reply already judged is not walked again: its verdict is the one the replay
        // keeps for it (capturedMessageWithheld), kept across turns and dropped by exactly what it rests on. Each frame
        // of a conversation cites the replies before it, so walking them on every check went one reply further down
        // that chain each turn, past the depth bound after about 64 turns; that check could not finish, and the owner's
        // direct chat reset its engine session on every turn from then on with nothing changed (perf102 F2). Deep in
        // a chain, a reply not judged yet is judged on its own and kept, so no walk goes deeper than HANDOFF_DEPTH.
        const settle = (message: string, verdict: Verdict): boolean => {
          // withheld because its own check could not finish: not proven bad, so neither can this check finish
          if (verdict.unproven) throw limit();
          if (!verdict.withheld) soundReplies.set(`${thread}\u0000${message}`, true);
          return verdict.withheld;
        };
        const unjudged: string[] = [];
        for (const message of messages) {
          const known = keptVerdict(thread, message);
          if (known === undefined) unjudged.push(message);
          else if (settle(message, known)) return true;
        }
        if (!unjudged.length) continue;
        if (depth >= HANDOFF_DEPTH) {
          for (const message of unjudged) { charge(); if (settle(message, capturedMessageVerdicts(thread, [message]).get(message)!)) return true; }
          continue;
        }
        messages = unjudged;
      }
      if (anyProducerBad(thread, messages, depth+1)) return true;
      for (const message of messages) {
        // a reply made without a receipt rests on the replies its context carried
        if (rootsBad(thread, message, depth+1)) return true;
        // a copy used as evidence carries its original's lineage
        // (the reader's own check too: a harness copy is not an approved projection)
        const copy = messageCopy(thread, message);
        if (copy && originBad(copy, 1, depth+1, true)) return true;
        soundReplies.set(`${thread}\u0000${message}`, true);
      }
    }
    return false;
  };
  /** Root verdicts (true = bad: forgotten, or withheld by its receipts) and
   * set verdicts, for this check only. */
  let rootVerdicts = new JudgeMemo<boolean>(), setVerdicts = new JudgeMemo<boolean>();
  /** Of `messages` (roots in `thread`), the bad ones: forgotten sources read
   * in one batch, producers judged in one batch for the thread (Astra r4 #7). */
  const badRoots = (thread: string, messages: readonly string[], depth: number): string[] => {
    const pending = [...new Set(messages)].filter(message => !rootVerdicts.has(rootKey(thread, message)) && !soundReplies.has(rootKey(thread, message)));
    if (pending.length) {
      const ids = JSON.stringify(pending.map(message => `message:${thread}:${message}`));
      for (const message of pending) dep("s", `message:${thread}:${message}`);
      rowsRead += pending.length;
      const forgotten = new Set([
        ...stmt(db, "SELECT id FROM memory_sources WHERE state='deleted' AND id IN (SELECT value FROM json_each(?))").all(ids).map(row => String(row.id)),
        ...stmt(db, "SELECT target_id AS id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?))").all(ids).map(row => String(row.id)),
      ]);
      const rest: string[] = [];
      for (const message of pending) {
        if (forgotten.has(`message:${thread}:${message}`)) rootVerdicts.set(rootKey(thread, message), true); else rest.push(message);
      }
      if (rest.length) {
        const { groups, exact } = producers(thread, rest);
        const bad: string[] = [];
        for (const group of groups) {
          let verdict: boolean;
          try { verdict = groupBad(group, depth+1); }
          catch (error) {
            // judging the whole thread meets groups listing none of these (anyProducerBad)
            if (exact || !(error instanceof Error && error.message === "MEMORY_REPLAY_LINEAGE_CYCLE")) throw error;
            if (listingAny(thread, group.bundles, rest).length) throw error;
            continue;
          }
          if (verdict) bad.push(...group.bundles);
        }
        const hit = new Set(bad.length ? listingAny(thread, bad, rest, false) : []);
        for (const message of rest) {
          rootVerdicts.set(rootKey(thread, message), hit.has(message));
          if (!hit.has(message)) soundReplies.set(rootKey(thread, message), true);
        }
      }
    }
    return messages.filter(message => rootVerdicts.get(rootKey(thread, message)) === true);
  };
  /** Of root sets `setIds`, the bad ones: a set missing, past the ceiling, or
   * holding a bad root. Every distinct root of all of them is judged once
   * (grouped by thread), then each set is judged once along its chain of
   * parents (v7), linear in the rows the sets hold. */
  const badSets = (setIds: readonly string[], depth: number): Set<string> => {
    const out = new Set<string>();
    const pending = [...new Set(setIds)].filter(id => { const known = setVerdicts.get(id); if (known) out.add(id); return known === undefined; });
    if (!pending.length) return out;
    const json = JSON.stringify(pending);
    const sizes = new Map(stmt(db, "SELECT set_id,size FROM memory_root_sets WHERE set_id IN (SELECT value FROM json_each(?))").all(json).map(row => [String(row.set_id), Number(row.size)]));
    const live: string[] = [];
    for (const id of pending) {
      const size = sizes.get(id);
      if (size === undefined || size > rootCeiling()) { setVerdicts.set(id, true); out.add(id); } else live.push(id);
    }
    if (!live.length) return out;
    // On content (no reader), a set is judged along its chain once and the answer kept (replaySetBad): a turn's check of a
    // long session's replies judges what each set added to the one before it, not every root of the ancestry again.
    const kept = audience === null ? verdictCache() : readerKey ? audienceCache(readerKey) : undefined;
    if (kept) {
      const cache = handles();
      for (const id of live) {
        const handle = storedHandle(cache, id, sizes.get(id)!);
        const bad = !handle || replaySetBad(kept, handle, depth);
        setVerdicts.set(id, bad);
        if (bad) out.add(id);
      }
      return out;
    }
    // Every set the live ones rest on (v7: a set may be its parent plus
    // what it adds), read in one go; each distinct root judged once; a set
    // is bad when its chain is unprovable or any set along it holds a bad root.
    const forest = loadRootSetForest(db, live);
    const proven = provenRootSets(forest, live);
    let rowCount = 0;
    const byThread = new Map<string,Set<string>>();
    for (const rows of forest.own.values()) for (const [thread, message] of rows) {
      rowCount++;
      let messages = byThread.get(thread);
      if (!messages) byThread.set(thread, messages = new Set());
      messages.add(message);
    }
    rowsRead += rowCount;
    const badKeys = new Set<string>();
    for (const [thread, messages] of byThread) {
      for (const message of badRoots(thread, [...messages], depth)) { charge(); badKeys.add(rootKey(thread, message)); }
    }
    const ownBad = (id: string) => (forest.own.get(id) ?? []).some(([thread, message]) => badKeys.has(rootKey(thread, message)));
    const chainBad = new Map<string, boolean>();
    const badLive = new Set<string>();
    for (const start of live) {
      if (!proven.get(start)) { badLive.add(start); continue; }
      const path: string[] = [];
      let at: string | null = start, below = false;
      while (at !== null) {
        const known = chainBad.get(at);
        if (known !== undefined) { below = known; break; }
        path.push(at);
        at = forest.nodes.get(at)!.parent;
      }
      for (let index = path.length - 1; index >= 0; index--) { below = below || ownBad(path[index]!); chainBad.set(path[index]!, below); }
      if (below) badLive.add(start);
    }
    for (const id of live) { setVerdicts.set(id, badLive.has(id)); if (badLive.has(id)) out.add(id); }
    return out;
  };
  /** Whether any root of a stored set is bad on content (audience null), the answer kept per set and resting on its parent's
   * answer and on what its additions consulted: the same rules as capturedMessageVerdicts, one entry per chunk of additions. */
  const replaySetBad = (kept: Map<string, Verdict>, handle: Handle, depth: number): boolean => {
    const keyOf = (node: Handle) => readerKey ? `R${SEP}${readerKey}${SEP}${node.id}` : `R${SEP}${node.id}`;
    if (kept.has(keyOf(handle))) { collected?.add(`v${SEP}${keyOf(handle)}`); return false; }
    const run: Handle[] = [];
    let at: Handle | null = handle;
    while (at && !kept.has(keyOf(at))) { run.push(at); at = at.parent; }
    const outer = collected, rests = new Set<string>();
    let previous = at ? keyOf(at) : null, pending: string[] = [], carried = new Set<string>(), lost = false;
    if (previous) rests.add(`v${SEP}${previous}`);
    const done = (bad: boolean): boolean => { if (outer) for (const d of rests) outer.add(d); return bad; };
    for (let index = run.length - 1; index >= 0; index--) {
      const node = run[index]!;
      for (const key of handleKeys(node, node.parent?.end ?? 0)) pending.push(key);
      if (pending.length < SOUND_CHUNK && index > 0) continue;
      const byThread = new Map<string, string[]>();
      for (const key of pending) {
        const cut = key.indexOf("\u0000"), thread = key.slice(0, cut);
        let list = byThread.get(thread);
        if (!list) byThread.set(thread, list = []);
        list.push(key.slice(cut + 1));
      }
      pending = [];
      const consulted = new Set<string>(), cyclesBefore = cycles, thrownBefore = cycleThrown, unfinishedBefore = unfinished, untrackedBefore = untracked;
      // what a memo hides (replies proven sound, roots and sets judged) is judged afresh in here, so the entry's dependencies are all of it
      const [sound0, root0, set0] = [soundReplies, rootVerdicts, setVerdicts];
      soundReplies = new JudgeMemo<boolean>(); rootVerdicts = new JudgeMemo<boolean>(); setVerdicts = new JudgeMemo<boolean>();
      collected = consulted;
      let bad = false;
      try { for (const [thread, messages] of byThread) if (badRoots(thread, messages, depth).length) { bad = true; break; } }
      catch (error) { for (const d of consulted) rests.add(d); throw error; }
      finally { collected = outer; soundReplies = sound0; rootVerdicts = root0; setVerdicts = set0; }
      if (bad) { for (const d of consulted) rests.add(d); return done(true); }
      // What this entry rests on includes everything the proof below it rested on. A proof kept is named ("v"); one that was not kept
      // (no room, a walk that did not finish cleanly) is carried here by what it consulted; one that was kept and has since gone (room
      // made for another entry) cannot be carried, so nothing above it is kept either (the entry would lose its ancestors' keys).
      if (previous) { if (kept.has(previous)) consulted.add(`v${SEP}${previous}`); else lost = true; }
      for (const d of carried) consulted.add(d);
      const clean = !lost && consulted.size <= 4000 && cycles === cyclesBefore && cycleThrown === thrownBefore && unfinished === unfinishedBefore && untracked === untrackedBefore;
      if (clean && keep(keyOf(node), { withheld: false, unproven: false, deps: consulted })) {
        if (readerKey) audienceHolds.get(readerKey)?.keys.add(keyOf(node));
        previous = keyOf(node); carried = new Set();
        rests.clear(); rests.add(`v${SEP}${previous}`);
      } else {
        previous = null; carried = consulted;
        for (const d of consulted) rests.add(d);
      }
    }
    return done(false);
  };
  /** A reply's output roots (memory schema v6): the one root set it points
   * at. Bad when the marker (an empty set id) is there or the set is bad. */
  const rootsBad = (thread: string, message: string, depth: number): boolean => {
    dirtyMessage(thread, message);
    charge();
    if (ancestryWithheld(db, thread)) return true;
    const row = stmt(db, "SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(thread, message);
    if (!row) return false;
    const id = String(row.set_id ?? "");
    return !id || badSets([id], depth).size > 0;
  };
  /** A copy's originals: forgotten, or made under a receipt that no longer
   * holds, and for the reader's own copies also one the reader may not see
   * (a harness copy is not an owner-approved projection). A lineage longer
   * or wider than the budget is not established, so it counts as bad. */
  const originBad = (copy:MessageCopy, hops:number, depth:number, asReader:boolean):boolean => {
    if(hops>COPY_HOPS||copy.messageIds.length>COPY_ORIGINS||depth>64)return true;
    for(const original of copy.messageIds){
      charge();
      if(messageSourceForgotten(copy.threadId,original))return true;
      if(anyProducerBad(copy.threadId,[original],depth+1,asReader&&audience?group=>(audience.copyOriginRevoked??audience.revoked)(group.row):undefined))return true;
      if(rootsBad(copy.threadId,original,depth+1))return true;
      const further=messageCopy(copy.threadId,original);
      if(further&&originBad(further,hops+1,depth,asReader))return true;
    }
    return false;
  };
  return { settle, verdicts, producers, listingAny, session, sessionProven, groupBad, originBad, rootsBad, badSets };
}

/** The ids among `messages` a reader may no longer be shown. `audience` null:
 * content checks only (a room's owner-audience turn, recall). failClosed: a
 * message whose check runs past its budget is withheld instead of throwing.
 *
 * Only the receipts that list one of `messages` as an output are read (the
 * output index), however many receipts the thread holds, grouped by what a
 * verdict rests on; each distinct cited list, record and reply is judged
 * once per call (0.1.61.1 memreplay). */
export function replayExclusions(threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: {invalidBundles?: Set<string>; failClosed?: boolean} = {}): Set<string> { return heldStep("memory.replay-exclusions", () => replayExclusionsUnheld(threadId, messages, audience, options)); }
function replayExclusionsUnheld(threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: {invalidBundles?: Set<string>; failClosed?: boolean} = {}): Set<string> {
  if (!messages.length) return new Set();
  const judge = lineageJudge(threadId, audience, options.invalidBundles);
  try { return replayExclusionsWith(judge, threadId, messages, audience, options); }
  finally { judge.settle(); }
}
function replayExclusionsWith(judge: ReturnType<typeof lineageJudge>, threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: {invalidBundles?: Set<string>; failClosed?: boolean}): Set<string> {
  // No cap on how many lines are asked about: a line no receipt lists costs
  // one index probe. The 0.1.61 cap (10,000 lines) failed every turn of a
  // conversation a routine keeps posting into (0.1.61.1 memreplay).
  if (!messages.length) return new Set();
  const { failClosed = false } = options;
  const excluded = new Set<string>();
  // The owner's or a person's own words are never linked to a receipt.
  const generated = [...new Set(messages.filter(message=>message.role!=="user").map(message=>message.id))];
  if (generated.length) {
    /** Receipts found bad, or not judged before the budget ran out. */
    const unsettled: string[] = [];
    let groups: ReceiptGroup[] = [], exact = true;
    // A group of the whole thread (past PAIR_LIMIT) counts only for the lines
    // it lists: the mapping below reads that from the index.
    try { ({ groups, exact } = judge.producers(threadId, generated)); }
    catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for(const id of generated)excluded.add(id); }
    for (let index = 0; index < groups.length; index++) {
      try { if (judge.groupBad(groups[index])) unsettled.push(...groups[index].bundles); }
      catch (error) {
        if(error instanceof LineageControl)throw error;
        // On content, cited replies are judged by their own verdicts: judged as a whole thread, a group listing none of
        // these lines may lead back to one of them (its verdict is being worked out right now), and then its verdict
        // does not matter here (anyProducerBad, same rule).
        if(audience===null&&!exact&&error instanceof Error&&error.message==="MEMORY_REPLAY_LINEAGE_CYCLE"&&!judge.listingAny(threadId,groups[index].bundles,generated).length)continue;
        if(!failClosed)throw error;
        noteWithheldOnError(error);
        // Past the budget: what is not proven sound is not shown.
        for (const group of groups.slice(index)) for (const id of group.bundles) if (judge.verdicts.get(id) !== false) unsettled.push(id);
        break;
      }
    }
    if (unsettled.length) {
      const pending = generated.filter(id => !excluded.has(id));
      // every receipt of a thread judged as a whole is bad: any line a receipt lists is withheld
      const wholeThread = !exact && unsettled.length === groups.reduce((total, group) => total + group.bundles.length, 0);
      try { for (const id of judge.listingAny(threadId, unsettled, pending, false, wholeThread)) excluded.add(id); }
      catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for (const id of pending) excluded.add(id); }
    }
  }
  // A reply rests on its output roots, in every memory mode (v6): the lines'
  // root sets are read in one indexed lookup, each distinct set and root is
  // judged once, and a line whose set no longer holds is withheld.
  const rooted = generated.filter(id => !excluded.has(id));
  if (rooted.length && ancestryWithheld(database(), threadId)) for (const id of rooted) excluded.add(id);
  else if (rooted.length) {
    try {
      const rows = stmt(database(), "SELECT message_id,set_id FROM memory_output_roots WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))").all(threadId, JSON.stringify(rooted));
      for (const id of rooted) dirtyMessage(threadId, id);
      rowsRead += rows.length;
      const bad = judge.badSets(rows.map(row => String(row.set_id ?? "")).filter(Boolean), 0);
      for (const row of rows) { const id = String(row.set_id ?? ""); if (!id || bad.has(id)) excluded.add(String(row.message_id)); }
    } catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for (const id of rooted) if (messageMadeWithMemory(threadId, id)) excluded.add(id); }
  }
  // A copy is withheld with its original.
  for(const message of messages){
    if(!message.copyOf||excluded.has(message.id))continue;
    try { if(judge.originBad(message.copyOf,1,0,true))excluded.add(message.id); }
    catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); excluded.add(message.id); }
  }
  return excluded;
}

/** A resumed native session rests on everything it was ever shown: true
 * when any receipt of the session no longer holds, lineage included, or
 * when the check cannot finish (review M1: the replay window no longer
 * reaches an old session's receipts, so the continuation check must). The
 * bad receipts are added to `invalidBundles`. */
export function sessionLineageBad(threadId: string, driverInstance: string, nativeSession: string, audience: ReplayAudience | null, invalidBundles?: Set<string>): boolean {
  let judge: ReturnType<typeof lineageJudge> | undefined;
  try {
    judge = lineageJudge(threadId, audience, invalidBundles);
    // a session whose receipts were proven sound is not judged again receipt by receipt: only the ones written since
    if (judge.sessionProven(driverInstance, nativeSession)) return false;
    let bad = false;
    for (const group of judge.session(driverInstance, nativeSession)) if (judge.groupBad(group)) bad = true;
    return bad;
  } catch (error) { noteWithheldOnError(error); return true; }
  finally { judge?.settle(); }
}

/** Generated speakers: a bot, the engine, a tool. Never the owner's or a
 * person's own words, which are never withheld for what a bot recalled. */
function generatedSpeaker(speaker: unknown): boolean {
  return typeof speaker === "string" && speaker !== "owner" && !speaker.startsWith("person:");
}

// One verdict per message, kept while nothing that a verdict can rest on changed.
// It used to be flushed by ANY write on this connection (total_changes), and every
// turn writes (a receipt, a message, a checkpoint roll, a notebook poll), so it never
// survived to be used. What a content verdict rests on, and what now flushes it:
// - the receipts that list a message as an output, and the copy link a message carries:
//   a dirty key per (thread, message), written by triggers on the output index and on a
//   receipt's cited lists, and by the message trigger below; an entry flushes only when
//   one of the keys it consulted is dirty;
// - the records a lineage cites (state, pin, assertion, supersession): a dirty key per
//   (record, version); a checkpoint's own supersession tolerance also reads "is any version
//   of it still active", a dirty key per id that counts only when none is left;
// - a source's state, revision or content (a turn settling, a message captured again, a forget):
//   a dirty key per source, read by every check that looks at the source (perf102: two turn
//   settlements a turn flushed the whole cache, so every check walked a conversation's whole
//   lineage again, and past 64 replies it could not finish);
// - another verdict: a dirty key per (thread, message) verdict ("v"), dropped with it;
// - everything else (a source's speaker or place, tombstones, derivations, evidence, policy
//   revision, deletion epoch, mode, a message deleted): a counter that flushes the whole cache;
// - commits by another connection (data_version), as before.
// A write that touches none of these (a new message, a new receipt with no outputs, a
// checkpoint version added, a notebook poll, a data_revision bump) flushes nothing.
const SEP = "\u001f";
/** A cached verdict: withheld or not, whether it was reached past a check that could not finish, and what it rests on. */
interface Verdict { withheld: boolean; unproven: boolean; deps: Set<string> }
const verdicts = new Map<string,Verdict>();
/** Per dependency key, the cached verdicts that consulted it. A verdict that rests on another reply's verdict holds that
 * reply's key ("v"), not a copy of everything that verdict consulted, so a long chain of replies stays small; dropping a
 * verdict drops every verdict resting on it, transitively. */
const dependents = new Map<string,Set<string>>();
/** Verdicts kept at most; past it the oldest eighth goes (with what rests on it), never the whole cache. A session's
 * root set alone reaches tens of thousands of messages (ROOT_SET_CEILING). */
const VERDICT_LIMIT = 65536;
let verdictLimit = VERDICT_LIMIT;
/** Tests lower the capacity to reach eviction; null is the real one. */
export function setVerdictLimitForTest(limit: number | null): void { verdictLimit = limit ?? VERDICT_LIMIT; }
/** Drops every kept verdict and root-set handle, so the next check is a fresh one (tests: the cold side of warm-versus-cold). */
export function forgetKeptLineageForTest(): void { forgetVerdicts(); }
/** Kept verdicts, for tests. */
export function keptVerdictCount(): number { return verdicts.size; }
/** Keeps a verdict, or refuses to: one that rests on another kept verdict ("v") is kept only while that verdict is still
 * there once room has been made, since a verdict dropped for room takes its dependents with it only if they are already
 * registered. Refused, the verdict serves the call that reached it, and so does whatever rests on it (the caller lists what it
 * consulted instead of its key). Returns whether it was kept. */
function remember(key: string, entry: Verdict): boolean {
  if (keepRefused()) return false;
  if (verdicts.size >= verdictLimit) {
    const oldest: string[] = [];
    for (const kept of verdicts.keys()) { oldest.push(kept); if (oldest.length >= verdictLimit / 8) break; }
    for (const kept of oldest) verdicts.delete(kept);
    dropDependents(oldest.map(kept => `v${SEP}${kept}`));
  }
  // dependency lists of verdicts long gone are cleared only when their key moves: bound them
  if (dependents.size > verdictLimit * 8) forgetVerdicts();
  for (const d of entry.deps) if (d.startsWith(`v${SEP}`) && !verdicts.has(d.slice(2))) return false;
  verdicts.set(key, entry);
  for (const d of entry.deps) { let held = dependents.get(d); if (!held) dependents.set(d, held = new Set()); held.add(key); }
  return true;
}
/** Drops kept verdicts, and what rests on them. */
function forgetKept(keys: readonly string[]): void {
  for (const key of keys) verdicts.delete(key);
  dropDependents(keys.map(key => `v${SEP}${key}`));
}
/** Per reader (audience key and replay thread): the authority stamp its kept verdicts were judged under, and their keys. A reader's verdicts rest
 * on what the content checks consulted (the dirty keys drop them) and on what the reader may read (roster, scope bindings, grants, policy),
 * which has no key of its own: they hold only while no revocation-relevant write happened (authority-epoch.ts), and go together when one did. */
const audienceHolds = new Map<string, { hard: string; keys: Set<string> }>();
const AUDIENCE_HOLDS_MAX = 256;
function audienceCache(readerKey: string): Map<string, Verdict> | undefined {
  const kept = verdictCache();
  if (!kept) return undefined;
  const parts = authorityParts();
  if (!parts) return undefined;
  const held = audienceHolds.get(readerKey);
  if (held && held.hard === parts.hard) return kept;
  if (held) { for (const k of held.keys) kept.delete(k); dropDependents([...held.keys].map(k => `v${SEP}${k}`)); }
  if (audienceHolds.size >= AUDIENCE_HOLDS_MAX) {
    for (const other of audienceHolds.values()) { for (const k of other.keys) kept.delete(k); dropDependents([...other.keys].map(k => `v${SEP}${k}`)); }
    audienceHolds.clear();
  }
  audienceHolds.set(readerKey, { hard: parts.hard, keys: new Set() });
  return kept;
}
/** Per session, the newest receipt up to which its receipts are proven sound, and the kept verdict that says so. */
const sessionSound = new Map<string, { upTo: number; key: string }>();
/** Drops every kept verdict. The stored root-set handles are structure, not verdicts, and survive unless asked (see structureStamp). */
function forgetVerdicts(withHandles = true): void {
  verdicts.clear(); dependents.clear(); sessionSound.clear(); audienceHolds.clear();
  if (withHandles) { forgetRootSetHandles(sharedHandles); handleStamp = ""; }
}
function dropDependents(keys: Iterable<string>): void {
  const queue = [...keys];
  while (queue.length) {
    const d = queue.pop()!, held = dependents.get(d);
    if (!held) continue;
    dependents.delete(d);
    for (const key of held) if (verdicts.delete(key)) queue.push(`v${SEP}${key}`);
  }
}
const chains = new Map<string,Array<{thread:string;message:string;generated:boolean}> | "long" | "many">();
let cacheHits = 0, cacheMisses = 0;
/** How often the session listing fell back to every receipt of the session (and how often inside a transaction), for tests. */
const listingFallbacks = { all: 0, inTransaction: 0 };
export function lineageListingFallbacks(): { all: number; inTransaction: number } { return { ...listingFallbacks }; }
/** Verdict cache hits and misses so far, for the turn trace. */
export function lineageCacheCounts(): { hits: number; misses: number } { return { hits: cacheHits, misses: cacheMisses }; }
/** What the verdict being computed has consulted. */
let collected: Set<string> | null = null;
const dep = (...parts: string[]) => { collected?.add(parts.join(SEP)); };
const dirtyMessage = (thread: string, message: string) => dep("m", thread, message);

// Trigger bodies name their write target unqualified: SQLite forbids a
// qualified one there, and an unqualified name resolves to the temp table.
const NOTE = (key: string) => `INSERT INTO lineage_dirty VALUES(${key})`;
const BUMP = "UPDATE lineage_epoch SET n=n+1";
/** The root-set handles (root-set-handles.ts) are immutable data of immutable set rows: only a change to those rows can make one stale. */
const STRUCT = "UPDATE lineage_structure SET n=n+1";
const RECORD_CHANGED = "OLD.state IS NOT NEW.state OR OLD.owner_pinned IS NOT NEW.owner_pinned OR OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind";
// A checkpoint version archived by its roll, nothing else about it changed (authority-epoch.ts treats the same transition).
const CHECKPOINT_ROLL = "OLD.kind='checkpoint' AND NEW.kind='checkpoint' AND OLD.state='active' AND NEW.state='archived' AND OLD.owner_pinned=0 AND NEW.owner_pinned=0 AND OLD.assertion IS NEW.assertion AND OLD.supersedes_id IS NEW.supersedes_id";
const EPOCH_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS lineage_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.lineage_epoch VALUES(1,0);
CREATE TEMP TABLE IF NOT EXISTS lineage_structure(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.lineage_structure VALUES(1,0);
CREATE TEMP TABLE IF NOT EXISTS lineage_dirty(k TEXT NOT NULL);
CREATE TEMP TRIGGER IF NOT EXISTS lineage_sources_u AFTER UPDATE ON main.memory_sources
 WHEN OLD.speaker IS NOT NEW.speaker OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id
 BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_sources_s AFTER UPDATE ON main.memory_sources
 WHEN (OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash) AND NOT (OLD.speaker IS NOT NEW.speaker OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id)
 BEGIN ${NOTE("'s'||char(31)||OLD.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_sources_d AFTER DELETE ON main.memory_sources BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_u AFTER UPDATE ON main.memory_records WHEN (${RECORD_CHANGED}) AND NOT (${CHECKPOINT_ROLL})
 BEGIN ${NOTE("'r'||char(31)||OLD.id||char(31)||OLD.version")}; ${NOTE("'c'||char(31)||OLD.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_roll AFTER UPDATE ON main.memory_records WHEN ${CHECKPOINT_ROLL}
 BEGIN ${NOTE("'k'||char(31)||OLD.id||char(31)||OLD.version")}; ${NOTE("'c'||char(31)||OLD.id")}; END;
-- A chain's meaning moves with a record's supersedes link, with its assertion where it supersedes, and with a checkpoint's kind. A candidate that
-- becomes an ordinary active record (automatic learning, no supersedes link, no checkpoint) changes none of that: the keys noted above ("r", "c")
-- reach every verdict that read the record, so the whole cache is not dropped for it.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_chain AFTER UPDATE ON main.memory_records WHEN (OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind)
  AND NOT (OLD.state='candidate' AND NEW.state='active' AND OLD.supersedes_id IS NULL AND NEW.supersedes_id IS NULL AND OLD.kind IS NOT 'checkpoint' AND NEW.kind IS NOT 'checkpoint')
 BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_d AFTER DELETE ON main.memory_records BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_i AFTER INSERT ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_u AFTER UPDATE ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_d AFTER DELETE ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_derivations_u AFTER UPDATE ON main.memory_derivations BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_derivations_d AFTER DELETE ON main.memory_derivations BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_evidence_u AFTER UPDATE ON main.memory_evidence BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_evidence_d AFTER DELETE ON main.memory_evidence BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_meta_u AFTER UPDATE ON main.memory_meta
 WHEN OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch OR OLD.mode IS NOT NEW.mode BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_outputs_i AFTER INSERT ON main.memory_disclosure_outputs BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.message_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_outputs_d AFTER DELETE ON main.memory_disclosure_outputs BEGIN ${NOTE("'m'||char(31)||OLD.thread_id||char(31)||OLD.message_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_roots_i AFTER INSERT ON main.memory_output_roots BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.message_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_roots_d AFTER DELETE ON main.memory_output_roots BEGIN ${NOTE("'m'||char(31)||OLD.thread_id||char(31)||OLD.message_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_roots_u AFTER UPDATE ON main.memory_output_roots BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.message_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_sets_d AFTER DELETE ON main.memory_root_set_members BEGIN ${BUMP}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_set_rows_d AFTER DELETE ON main.memory_root_sets BEGIN ${BUMP}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_set_rows_u AFTER UPDATE ON main.memory_root_sets BEGIN ${BUMP}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_parents_d AFTER DELETE ON main.memory_root_set_parents BEGIN ${BUMP}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_parents_u AFTER UPDATE ON main.memory_root_set_parents BEGIN ${BUMP}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_receipts_u AFTER UPDATE ON main.memory_disclosures WHEN OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.native_session IS NOT NEW.native_session
 BEGIN INSERT INTO lineage_dirty SELECT 'm'||char(31)||thread_id||char(31)||message_id FROM main.memory_disclosure_outputs WHERE bundle_id=NEW.bundle_id;
 INSERT INTO lineage_dirty SELECT 'm'||char(31)||o.thread_id||char(31)||o.message_id FROM main.memory_disclosures l JOIN main.memory_disclosure_outputs o ON o.bundle_id=l.bundle_id
  WHERE NEW.native_session IS NOT NULL AND l.thread_id=NEW.thread_id AND l.driver_instance=NEW.driver_instance AND l.native_session=NEW.native_session AND l.rowid>=NEW.rowid; END;
-- a session's kept "receipts so far are sound" verdict ("a") is dropped by a change to a receipt already in it. A receipt joining the
-- session as its newest (a turn's frame or companion bound to its session) is not in it yet; fewer receipts only weaken what it rests on.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_receipts_a AFTER UPDATE ON main.memory_disclosures
 WHEN (OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.native_session IS NOT NEW.native_session OR OLD.driver_instance IS NOT NEW.driver_instance OR OLD.thread_id IS NOT NEW.thread_id)
  AND NOT (OLD.native_session IS NULL AND OLD.record_versions IS NEW.record_versions AND OLD.source_versions IS NEW.source_versions AND NOT EXISTS (SELECT 1 FROM main.memory_disclosures x WHERE x.thread_id=NEW.thread_id AND x.driver_instance=NEW.driver_instance AND x.native_session=NEW.native_session AND x.rowid>NEW.rowid))
 BEGIN INSERT INTO lineage_dirty VALUES('a'||char(31)||OLD.thread_id||char(31)||OLD.driver_instance||char(31)||COALESCE(OLD.native_session,'')); INSERT INTO lineage_dirty VALUES('a'||char(31)||NEW.thread_id||char(31)||NEW.driver_instance||char(31)||COALESCE(NEW.native_session,'')); END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_u AFTER UPDATE ON main.messages WHEN OLD.json IS NOT NEW.json AND (instr(OLD.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)
 BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_d AFTER DELETE ON main.messages BEGIN ${BUMP}; END;
-- INSERT OR REPLACE (writeMessage) deletes and re-inserts without firing the UPDATE or DELETE triggers (recursive triggers are off): the
-- replaced row is looked at before it goes, the same condition as lineage_messages_u.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_r BEFORE INSERT ON main.messages
 WHEN EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND o.json IS NOT NEW.json AND (instr(o.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0))
 BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.id")}; END;
`;
const epochReady = new WeakMap<object, boolean>();
function installEpoch(db: ReturnType<typeof database>): boolean {
  let ready = epochReady.get(db);
  if (ready === undefined) {
    try { db.exec(EPOCH_SCHEMA); ready = true; }
    catch (error) {
      ready = false;
      if (!epochWarned) { epochWarned = true; console.warn(`[memory] lineage cache triggers could not be installed; every write drops the verdict cache (${error instanceof Error ? error.message : String(error)})`); }
    }
    epochReady.set(db, ready);
  }
  return ready;
}
let epochWarned = false;
/** Whether the lineage cache triggers are installed on the shared connection (installs them if not tried yet). */
export function lineageTriggersInstalled(): boolean { return installEpoch(database()); }
let verdictStamp = "", verdictDb: object | null = null;
/** Keys changed since the last look, applied: entries that consulted one are dropped. */
function drainDirty(db: ReturnType<typeof database>): void {
  const rows = stmt(db, "SELECT DISTINCT k FROM temp.lineage_dirty").all();
  if (!rows.length) return;
  const keys = new Set<string>();
  for (const row of rows) {
    const key = String(row.k);
    // a checkpoint that was rolled still has an active newer version: nothing about its tolerance changed
    if (key.startsWith(`c${SEP}`) && stmt(db, "SELECT 1 FROM memory_records WHERE id=? AND state='active' LIMIT 1").get(key.slice(2))) continue;
    // a version rolled: only verdicts that read it as an ordinary record ("r") move; one read as its thread's own checkpoint ("t") holds
    if (key.startsWith(`k${SEP}`)) { keys.add(`r${key.slice(1)}`); continue; }
    // any other change to a version moves both
    if (key.startsWith(`r${SEP}`)) keys.add(`t${key.slice(1)}`);
    keys.add(key);
  }
  db.exec("DELETE FROM temp.lineage_dirty");
  if (!keys.size) return;
  dropDependents(keys);
}
/** The lineage repair of this file did not finish and this thread, which holds receipt outputs, has not been repaired yet: whatever a
 * reply there rests on is not proven, so replay of its replies is withheld (fail closed) until a later repair succeeds. */
export function ancestryWithheld(db: DatabaseSync, thread: string): boolean {
  if (!ancestryUnrepaired(db) || ancestryThreadRepaired(db, thread)) return false;
  try { return Boolean(stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? LIMIT 1").get(thread)); } catch { return true; }
}
/** Moves on every write through this connection and every commit by another
 * one; undefined inside a transaction, where a verdict may rest on writes
 * that roll back. A cached verdict holds only while it is unchanged. */
export function databaseStamp(): string | undefined {
  if (database().isTransaction) return undefined;
  const row = stmt(database(), "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `${connectionId(database())}.${row?.changes}:${row?.version}`;
}
/** The stamp the verdict cache is held under: the counter of changes a verdict cannot be
 * tracked through, and other connections' commits. Falls back to every change if the
 * triggers could not be installed. */
let passStamp: { pass: number; db: object; writes: number; value: string | undefined } | null = null;
function lineageStamp(): string | undefined {
  const db = database();
  if (db.isTransaction) return undefined;
  // Inside a synchronous pass with no write since it was last read, the stamp has not moved (see verdictCache).
  const pass = statementReusePassId(), writes = writeStamp(db);
  if (pass && writes !== undefined && passStamp && passStamp.pass === pass && passStamp.db === db && passStamp.writes === writes) return passStamp.value;
  let value: string | undefined;
  if (!installEpoch(db)) value = databaseStamp();
  else {
    const row = stmt(db, "SELECT (SELECT n FROM temp.lineage_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version").get();
    value = `e${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row?.epoch}:${row?.version}`;
  }
  passStamp = pass && writes !== undefined ? { pass, db, writes, value } : null;
  return value;
}
// Inside one synchronous pass (the check of a resumed session's receipts) that has written nothing since the cache was last made
// current, it is still current: the stamp and the dirty list are not asked for again by each of the check's thousands of verdicts.
// (A commit by another connection inside that one pass is seen by the next pass, which is how it already was for the check as a whole.)
let passCache: { pass: number; db: object; writes: number; value: typeof verdicts } | null = null;
function verdictCache(): typeof verdicts | undefined {
  const db = database(), pass = statementReusePassId(), writes = writeStamp(db);
  if (pass && writes !== undefined && passCache && passCache.pass === pass && passCache.db === db && passCache.writes === writes) return passCache.value;
  const value = currentVerdictCache();
  passCache = pass && writes !== undefined && value ? { pass, db, writes, value } : null;
  return value;
}
function currentVerdictCache(): typeof verdicts | undefined {
  if (database().isTransaction) return transactionVerdictCache();
  txnTainted = false;
  const stamp = lineageStamp();
  if (stamp === undefined) return undefined;
  const db = database();
  // a different connection (a restore, a data-dir switch) shares nothing with the last
  if (verdictDb !== db) { verdictDb = db; forgetVerdicts(); chains.clear(); verdictStamp = ""; }
  if (stamp !== verdictStamp) { forgetVerdicts(false); chains.clear(); verdictStamp = stamp; if (stamp.startsWith("e")) db.exec("DELETE FROM temp.lineage_dirty"); }
  else if (stamp.startsWith("e")) drainDirty(db);
  keepHandlesCurrent(db);
  if (chains.size > 4096) chains.clear();
  return verdicts;
}

/** What the stored root-set handles rest on: the set rows (a change to them moves the structure counter) and other connections' commits.
 * A write that moves the verdict epoch (a forgotten source, a tombstone, a policy change) leaves them alone: a set is its rows, and
 * whether a root of it is still sound is a verdict, judged against the kept verdicts. Undefined without the triggers: always dropped. */
let handleStamp = "";
function structureStamp(db: ReturnType<typeof database>): string | undefined {
  // the counter tables are made outside a transaction (a rollback would take them): inside one, only if they are already there
  if (db.isTransaction && epochReady.get(db) !== true) return undefined;
  if (!installEpoch(db)) return undefined;
  const row = stmt(db, "SELECT (SELECT n FROM temp.lineage_structure) AS structure, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `h${connectionId(db)}.${row?.structure}:${row?.version}`;
}
function keepHandlesCurrent(db: ReturnType<typeof database>): void {
  const now = structureStamp(db);
  if (now === undefined || now !== handleStamp) { forgetRootSetHandles(sharedHandles); handleStamp = now ?? ""; }
}
/** Brings the verdict cache up to date before a transaction that judges messages (the checkpoint refresh): inside one,
 * the cache serves only while nothing is waiting to be applied, so what committed since the last look is applied now. */
export function prepareLineageCache(): void { if (!database().isTransaction) verdictCache(); }
/** Inside a transaction (the checkpoint refresh after every captured message judges its evidence in one) the cache
 * serves only while the transaction has written nothing a verdict rests on: no dirty key and the counter unmoved since
 * the cache was made current. What it holds is then the committed state, and so is anything judged meanwhile; a write
 * later in the transaction leaves a dirty key that is drained after it commits (or rolls back with it). */
function transactionVerdictCache(): typeof verdicts | undefined {
  const db = database();
  if (verdictDb !== db || !verdictStamp.startsWith("e") || !installEpoch(db)) return undefined;
  const row = stmt(db, "SELECT (SELECT n FROM temp.lineage_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version, EXISTS(SELECT 1 FROM temp.lineage_dirty) AS dirty").get();
  if (!row || `e${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row.epoch}:${row.version}` !== verdictStamp) return undefined;
  if (Number(row.dirty)) {
    // The transaction has written something a kept verdict may rest on (the capture of a reply writes its own outputs and sources).
    // The verdicts that consulted a written key are dropped, exactly as after the commit (dropping is never wrong, and a rollback
    // only makes it needless); what is left is the committed state and is read. Nothing judged from here until the transaction ends
    // is kept (remember refuses): it rests on writes that may roll back. A move of the epoch counter (a removal, a tombstone,
    // a speaker change) still leaves no cache at all, as before.
    drainDirty(db);
    txnTainted = true;
  }
  return verdicts;
}
/** Set once a transaction has read the cache after writing keys it rests on; cleared at the next look outside a transaction. */
let txnTainted = false;
/** Whether what is judged now rests on writes of a transaction that is still open: it serves the call and is never kept. */
const keepRefused = (): boolean => txnTainted && database().isTransaction;

/** A captured generated message is withheld on content: what its receipt
 * used was forgotten, deleted or changed, or it is a copy of a message that
 * is. Checks it cannot finish withhold it. */
export function capturedMessageWithheld(threadId: string, messageId: string): boolean {
  return capturedMessageVerdicts(threadId, [messageId]).get(messageId)!.withheld;
}
/** The verdicts of captured messages of one thread. The ones not kept yet are judged together, in one check, as the
 * replay judges its lines (the same producers, roots and copy checks, read once for all of them).
 *
 * A reply's verdict rests on the verdicts of the replies its receipts cite, and those on theirs (each frame of a
 * conversation cites the replies before it), so judging one with nothing kept would go as deep as the conversation is
 * long. Past NEST_LIMIT verdicts down, the deepest are judged first, on their own, and the chain is taken up again from
 * there: never deeper than the limit, each verdict judged once. Every verdict an outermost call works out is kept for
 * that call (`scratch`), so it is reused even where the shared cache cannot hold it (inside a transaction): nothing
 * writes while it runs. */
function capturedMessageVerdicts(threadId: string, messageIds: readonly string[]): Map<string, Verdict> {
  if (nesting > 0) return judgeCapturedMessages(threadId, messageIds);
  const own = scratch === null;
  if (own) scratch = new Map();
  try {
    const work: Array<[string, readonly string[]]> = [[threadId, messageIds]];
    for (;;) {
      const [thread, messages] = work[work.length - 1]!;
      try {
        const verdicts = judgeCapturedMessages(thread, messages);
        work.pop();
        if (!work.length) return verdicts;
      } catch (error) {
        if (!(error instanceof LineageDeferred)) throw error;
        // a chain past the budget is not established: withheld, unproven
        if (work.length >= DEFERRED_LIMIT) {
          noteWithheldOnError(new Error("MEMORY_REPLAY_LIMIT"));
          return new Map(messageIds.map(id => [id, { withheld: true, unproven: true, deps: new Set<string>() }]));
        }
        work.push([error.threadId, error.messageIds]);
      }
    }
  } finally { if (own) scratch = null; }
}
/** How many replies down one check walks before it hands a reply not judged yet to its own kept verdict. */
const HANDOFF_DEPTH = 16;
/** The verdict already kept for a captured message, if any (nothing is judged); one read from the shared cache becomes a
 * dependency of the verdict being worked out. */
function keptVerdict(threadId: string, messageId: string): Verdict | undefined {
  const cache = verdictCache(), key = JSON.stringify([threadId, messageId]);
  const cached = cache?.get(key), known = cached ?? scratch?.get(key);
  if (known !== undefined && collected) { if (cached) collected.add(`v${SEP}${key}`); else for (const d of known.deps) collected.add(d); }
  return known;
}
/** Messages judged in one check by capturedMessageVerdicts, and roots read in one query by outputRootsBad. */
const JUDGE_CHUNK = 64, ROOT_BATCH = 500;
/** How many verdicts deep one judgement may go before the deepest are judged on their own first. */
const NEST_LIMIT = 8;
/** How many judgements may wait on each other in one outermost call: a chain longer than this is not established. */
const DEFERRED_LIMIT = 4096;
/** Unwinds verdicts being worked out; never a verdict itself, so no check catches it as one. */
class LineageControl extends Error {}
/** Too deep: these are judged on their own first (capturedMessageVerdicts). */
class LineageDeferred extends LineageControl {
  readonly threadId: string; readonly messageIds: readonly string[];
  constructor(threadId: string, messageIds: readonly string[]) { super("MEMORY_LINEAGE_DEFERRED"); this.threadId = threadId; this.messageIds = messageIds; }
}
/** A message judged in a batch was asked about again from inside that batch's own check (a reply and the one it cites,
 * judged together): not a cycle, but the batch is judged one message at a time instead. */
class LineageSplit extends LineageControl {
  readonly batch: number;
  constructor(batch: number) { super("MEMORY_LINEAGE_SPLIT"); this.batch = batch; }
}
let nesting = 0, cycles = 0, batches = 0, scratch: Map<string, Verdict> | null = null;
/** The verdicts being worked out right now, by the batch judging them: met again alone, the lineage is a cycle. */
const judging = new Map<string, { batch: number; size: number }>();
function judgeCapturedMessages(threadId: string, messageIds: readonly string[]): Map<string, Verdict> {
  const cache = verdictCache(), out = new Map<string, Verdict>(), pending: string[] = [];
  for (const messageId of new Set(messageIds)) {
    const key = JSON.stringify([threadId, messageId]);
    const cached = cache?.get(key), known = cached ?? scratch?.get(key);
    if (known === undefined) { pending.push(messageId); continue; }
    cacheHits++;
    if (collected) { if (cached) collected.add(`v${SEP}${key}`); else for (const d of known.deps) collected.add(d); }
    out.set(messageId, known);
  }
  if (!pending.length) return out;
  // judged in chunks: what a chunk consulted is each of its verdicts' dependencies, so a chunk stays small enough to keep
  if (pending.length > JUDGE_CHUNK) {
    for (let at = 0; at < pending.length; at += JUDGE_CHUNK) for (const [id, verdict] of judgeCapturedMessages(threadId, pending.slice(at, at + JUDGE_CHUNK))) out.set(id, verdict);
    return out;
  }
  const keys = pending.map(messageId => JSON.stringify([threadId, messageId]));
  for (const key of keys) {
    const owner = judging.get(key);
    if (!owner) continue;
    if (owner.size > 1) throw new LineageSplit(owner.batch);
    throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE");
  }
  if (nesting >= NEST_LIMIT) throw new LineageDeferred(threadId, pending);
  cacheMisses += pending.length;
  let excluded = new Set<string>(), failed = false, split = false;
  const outer = collected, cyclesBefore = cycles, unfinishedBefore = unfinished, batch = ++batches;
  collected = new Set<string>();
  const consulted = collected;
  nesting++; for (const key of keys) judging.set(key, { batch, size: keys.length });
  try {
    excluded = replayExclusions(threadId, pending.map(messageId => { dirtyMessage(threadId, messageId); const copy = messageCopy(threadId, messageId); return { id: messageId, ...(copy ? { copyOf: copy } : {}) }; }), null, { failClosed: true });
  } catch (error) {
    if (error instanceof LineageSplit && error.batch === batch) split = true;
    else if (error instanceof LineageControl) throw error;
    else { noteWithheldOnError(error); excluded = new Set(pending); failed = true; }
  }
  finally { collected = outer; nesting--; for (const key of keys) judging.delete(key); }
  if (split) {
    for (const messageId of pending) out.set(messageId, judgeCapturedMessages(threadId, [messageId]).get(messageId)!);
    return out;
  }
  const unproven = failed || unfinished !== unfinishedBefore;
  // A verdict that a cycle made withhold something depends on where the walk began: it serves this call only, never the
  // shared cache. (A cycle through a group that lists none of the lines judged is passed over, and changes nothing.)
  const kept = cache !== undefined && consulted.size <= 4000 && cycles === cyclesBefore;
  pending.forEach((messageId, index) => {
    const withheld = excluded.has(messageId), entry: Verdict = { withheld, unproven: withheld && unproven, deps: consulted };
    const stored = kept && keepVerdict(keys[index]!, entry);
    scratch?.set(keys[index]!, entry);
    if (outer) { if (stored) outer.add(`v${SEP}${keys[index]}`); else for (const d of consulted) outer.add(d); }
    out.set(messageId, entry);
  });
  return out;
}

/** A derived record (a reveal resting on a canon version, an approved
 * projection, a consolidation) carries its parents' words, so every record it
 * was derived from must still stand: one superseded by something outside this
 * chain, archived, deleted, missing or tombstoned takes the derived record
 * with it. A candidate parent withdrew nothing and does not.
 * History is not a dependency: an owner correction's edge to the version it
 * replaced is not followed, and a parent replaced by a record of this same
 * chain may be superseded or archived (the receipt check above, same rule). A chain
 * too long to judge does not stand. */
export function derivationAncestryCurrent(db: DatabaseLike, id: string, version: number, selfSupersedes?: unknown, historical = false): boolean {
  const edges = stmt(db, `WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
      SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
      UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
      JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
      LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
      WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT 257)
    SELECT e.parent_id,e.parent_version,e.child_id,p.state,c.supersedes_id,c.assertion,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=e.parent_id AND (t.revision IS NULL OR t.revision=e.parent_version)) AS tombstoned
    FROM edges e LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
    LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(id,version);
  if (!edges.length) return true;
  if (edges.length > 256) return false;
  const replacing = new Set(edges.map(edge => String(edge.supersedes_id ?? "")));
  if (typeof selfSupersedes === "string" && selfSupersedes) replacing.add(selfSupersedes);
  for (const edge of edges) {
    // the first edge of an owner correction is history (see the walk above)
    if (edge.assertion === "owner-statement" && edge.supersedes_id === edge.parent_id) continue;
    if (edge.tombstoned) return false;
    // History (readable.ts historical mode) keeps ancestors that were archived or replaced since; a forgotten,
    // deleted or missing ancestor withdraws its copies there too (msearch review round 2).
    if (historical) { if (!["active", "candidate", "archived", "superseded"].includes(String(edge.state))) return false; continue; }
    // a record's own earlier version is history too: its words were replaced
    const history = (replacing.has(String(edge.parent_id)) || edge.parent_id === edge.child_id) && (edge.state === "superseded" || edge.state === "archived");
    // an unapproved parent withdrew nothing (an approved copy rests on it)
    if (edge.state !== "active" && edge.state !== "candidate" && !history) return false;
  }
  return true;
}

/** A captured source that carries a generated message withheld on content
 * (what its reply used was forgotten, deleted, changed or archived). The
 * owner's and a person's own words are never withheld this way. */
export function capturedSourceWithheld(source: {thread_id?: unknown; message_id?: unknown; speaker?: unknown}): boolean {
  if (typeof source.thread_id !== "string" || typeof source.message_id !== "string" || !generatedSpeaker(source.speaker)) return false;
  return capturedMessageWithheld(source.thread_id, source.message_id);
}

/** A record whose evidence includes a withheld generated message: recall,
 * memory search and the thread checkpoint leave it out, so a withheld reply
 * does not come back as a remembered line. `alsoWithheld` adds a reader's
 * own transcript rule (a room turn that is not the owner's). */
export function recordRestsOnWithheldMessage(recordId: string, version: number, alsoWithheld?: (threadId: string, messageId: string) => boolean): boolean {
  // The record and every record it was derived from (an approved projection
  // carries no evidence of its own): a line resting on a withheld reply
  // anywhere up that chain rests on it.
  // An owner's correction (a new version in the owner's own words that
  // supersedes the old one) does not carry the old words: that history edge
  // is not a dependency (0.1.61 third fix round, Astra P1 #3).
  const db = database();
  verdictCache();  // brings the chain cache up to date with the stamp
  const stamp = verdictStamp, chainKey = `${recordId}${SEP}${version}`;
  let rows = chains.get(chainKey);
  if (rows === undefined) {
    const chain = `WITH RECURSIVE chain(id,version) AS (
      SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d JOIN chain c ON d.child_id=c.id AND d.child_version=c.version
      LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
      WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 66)`;
    // A chain longer than the budget is not established: it counts as resting
    // on a withheld reply, whether or not its first records carry evidence.
    if (Number(stmt(db, `${chain} SELECT count(*) AS n FROM chain`).get(recordId, version)?.n ?? 0) > 64) rows = "long";
    else {
      const found = stmt(db, `${chain} SELECT DISTINCT s.thread_id,s.message_id,s.speaker FROM chain c JOIN memory_evidence e ON e.record_id=c.id AND e.record_version=c.version
        JOIN memory_sources s ON s.id=e.source_id WHERE s.thread_id IS NOT NULL AND s.message_id IS NOT NULL LIMIT 257`).all(recordId, version);
      rows = found.length > 256 ? "many" : found.map(row => ({ thread: String(row.thread_id), message: String(row.message_id), generated: generatedSpeaker(row.speaker) }));
    }
    if (stamp !== undefined && lineageStamp() === stamp) chains.set(chainKey, rows);
  }
  if (rows === "long" || rows === "many") return true;
  return rows.some(row => row.generated && (capturedMessageWithheld(row.thread, row.message) || Boolean(alsoWithheld?.(row.thread, row.message))));
}

/** A reply made under a memory receipt, built on one (its output roots),
 * or a copy of one: what a reader whose words were not proven may not be quoted. */
export function messageMadeWithMemory(threadId: string, messageId: string): boolean {
  return ancestryWithheld(database(), threadId) || Boolean(messageCopy(threadId, messageId)) || Boolean(stmt(database(), "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId))
    || Boolean(stmt(database(), "SELECT 1 FROM memory_output_roots WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId));
}

/** A set of output roots: keys `thread\u0000message`; `over` when it passed
 * the ceiling (or a context could not be proven). `roots` is a stored set plus
 * what is added to it (root-set-handles.ts), so a long session's set is never
 * copied: its cost follows what a turn adds. */
export interface OutputRoots { roots: RootView; over: boolean }
const rootKey = (thread: string, message: string) => `${thread}\u0000${message}`;
/** One commit for a set and the row that points at it. */
function atomically(db: ReturnType<typeof database>, work: () => void): void {
  db.exec("SAVEPOINT memory_root_pointer");
  try { work(); db.exec("RELEASE memory_root_pointer"); }
  catch (error) { db.exec("ROLLBACK TO memory_root_pointer; RELEASE memory_root_pointer"); throw error; }
}
/** The stored sets read so far, kept while the lineage cache is (a set is immutable under its id; every removal or change
 * of a set row moves the lineage epoch, which drops them with the verdicts). Where no cache can be kept (inside a
 * transaction that moved the epoch) the sets are read afresh for that one call. */
const sharedHandles: HandleCache = new Map();
const handles = (): HandleCache => {
  if (verdictCache() !== undefined) return sharedHandles;
  // inside a transaction that moved the epoch the verdicts are not served, but the handles are, while no set row moved
  const db = database(), now = structureStamp(db);
  return now !== undefined && now === handleStamp ? sharedHandles : new Map();
};
/** The members of one stored root set, into `into`; an unknown or empty id,
 * or a chain that cannot be proven, is unprovable. */
function addSetMembers(into: OutputRoots & { roots: LayeredRoots }, setId: string): void {
  const db = database();
  if (!setId) { into.over = true; return; }
  const size = stmt(db, "SELECT size FROM memory_root_sets WHERE set_id=?").get(setId);
  if (!size || Number(size.size) > rootCeiling()) { into.over = true; return; }
  const handle = storedHandle(handles(), setId, Number(size.size));
  if (!handle) { into.over = true; return; }
  into.roots.absorb(handle);
}
/** The handle of a stored set of the size its row says; a kept one of another size is not trusted and is read again. */
function storedHandle(cache: HandleCache, setId: string, size: number): Handle | null {
  const db = database();
  let handle = handleFor(db, cache, setId);
  if (handle && handle.end !== size) { cache.delete(setId); handle = handleFor(db, cache, setId); }
  return handle && handle.end === size ? handle : null;
}
const layeredOutput = (): OutputRoots & { roots: LayeredRoots } => ({ roots: new LayeredRoots(), over: false });
/** The flat root set of what a turn's context carries (memory schema v6):
 * each carried reply made under a receipt is a root itself, and a reply that
 * has roots hands over its set (the union, never a link: depth stays 1). A
 * copy carries its originals'. Owner and person lines are never roots. */
export function outputRootsFor(lines: ReadonlyArray<{ threadId: string; id: string; role?: string; copyOf?: MessageCopy }>): OutputRoots {
  const found = layeredOutput();
  const db = database();
  const listed = stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1");
  const rooted = stmt(db, "SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?");
  const seenSets = new Set<string>(), seenLines = new Set<string>();
  const visit = (thread: string, message: string, copy: MessageCopy | undefined, hops: number) => {
    if (found.over || seenLines.has(rootKey(thread, message))) return;
    seenLines.add(rootKey(thread, message));
    if (listed.get(thread, message)) found.roots.add(rootKey(thread, message));
    const row = rooted.get(thread, message);
    if (row) { const id = String(row.set_id ?? ""); if (!seenSets.has(id)) { seenSets.add(id); addSetMembers(found, id); } }
    const origin = copy ?? messageCopy(thread, message);
    if (origin) {
      if (hops >= COPY_HOPS || origin.messageIds.length > COPY_ORIGINS) { found.over = true; return; }
      for (const original of origin.messageIds) visit(origin.threadId, original, undefined, hops + 1);
    }
    if (found.roots.size > rootCeiling()) found.over = true;
  };
  for (const line of lines) if (line.role !== "user") visit(line.threadId, line.id, line.copyOf, 0);
  return found;
}
/** The union of two root sets. */
export function mergeOutputRoots(a: OutputRoots, b: OutputRoots): OutputRoots {
  const roots = layeredOf(a.roots).union(layeredOf(b.roots));
  return { roots, over: a.over || b.over || roots.size > rootCeiling() };
}
/** The set a write stores: what the caller carries, with any set the row already points at. */
function unionWith(set: OutputRoots, held: unknown): (OutputRoots & { roots: LayeredRoots }) | "" {
  const union: OutputRoots & { roots: LayeredRoots } = { roots: layeredOf(set.roots).clone(), over: set.over };
  if (held) { if (!String((held as { set_id?: unknown }).set_id ?? "")) return ""; addSetMembers(union, String((held as { set_id?: unknown }).set_id)); }
  if (union.over || union.roots.size > rootCeiling()) return "";
  return union;
}
/** Points a reply at the root set of what it rests on (every mode, v6): the
 * union with any set it already has, stored once and reused when the same
 * union exists. Past the ceiling the unprovable marker is written instead,
 * which withholds the reply. */
export function recordOutputRoots(threadId: string, messageId: string, set: OutputRoots): void {
  if (!set.over && !set.roots.size) return;
  const db = database();
  const upsert = stmt(db, "INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?) ON CONFLICT(thread_id,message_id) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = stmt(db, "SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(threadId, messageId);
  const union = unionWith(set, held);
  if (union === "") { if (held && !String(held.set_id ?? "")) return; upsert.run(threadId, messageId, ""); return; }
  atomically(db, () => upsert.run(threadId, messageId, storeLayered(db, handles(), union.roots)));
}
/** The roots a retained engine session was shown (v6). A session marked over,
 * or whose set is within the headroom of the ceiling, comes back `over`: it
 * resets before its next turn instead of withholding that turn's replies. */
export function sessionOutputRoots(threadId: string, driverInstance: string, nativeSession: string): OutputRoots {
  const found = layeredOutput();
  const row = stmt(database(), "SELECT s.set_id,r.size FROM memory_session_roots s LEFT JOIN memory_root_sets r ON r.set_id=s.set_id WHERE s.thread_id=? AND s.driver_instance=? AND s.native_session=?").get(threadId, driverInstance, nativeSession);
  if (!row) return found;
  if (row.size === null || row.size === undefined || Number(row.size) > sessionCeiling()) { found.over = true; return found; }
  addSetMembers(found, String(row.set_id));
  return found;
}
/** Whether a session has a v6 lineage row (every session v6 starts or resumes has one). */
export function sessionLineageKnown(threadId: string, driverInstance: string, nativeSession: string): boolean {
  return Boolean(stmt(database(), "SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession));
}
/** Adds what a turn's context carried to its engine session's set (v6). The
 * row is written even for an empty set: it marks the session as one v6 saw. */
export function recordSessionRoots(threadId: string, driverInstance: string, nativeSession: string, set: OutputRoots): void {
  const db = database();
  const upsert = stmt(db, "INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = stmt(db, "SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession);
  const union = unionWith(set, held);
  if (union === "") { if (held && !String(held.set_id ?? "")) return; upsert.run(threadId, driverInstance, nativeSession, ""); return; }
  atomically(db, () => upsert.run(threadId, driverInstance, nativeSession, storeLayered(db, handles(), union.roots)));
}
/** Whether any of these roots (`thread\u0000message` keys) is forgotten, deleted, withheld on content, or could not be
 * judged. Every key judged is a dependency of `collected`, when a caller collects. */
function flatRootsBad(keys: Iterable<string>): boolean {
  const byThread = new Map<string, string[]>();
  for (const key of keys) {
    const at = key.indexOf("\u0000"), thread = key.slice(0, at);
    let list = byThread.get(thread);
    if (!list) byThread.set(thread, list = []);
    list.push(key.slice(at + 1));
  }
  const db = database();
  for (const [thread, messages] of byThread) {
    // forgotten roots, read in batches rather than one query per root
    for (let at = 0; at < messages.length; at += ROOT_BATCH) {
      const batch = messages.slice(at, at + ROOT_BATCH);
      if (collected) for (const message of batch) collected.add(`s${SEP}message:${thread}:${message}`);
      const ids = JSON.stringify(batch.map(message => `message:${thread}:${message}`));
      if (stmt(db, "SELECT 1 FROM memory_sources WHERE state='deleted' AND id IN (SELECT value FROM json_each(?)) LIMIT 1").get(ids)
        || stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(ids)) return true;
    }
    // Each root's verdict is the one the replay keeps (judged in batches, kept across turns), so a session of
    // tens of thousands of roots judges only the roots not judged yet or touched since, not all of them every turn.
    for (const verdict of capturedMessageVerdicts(thread, messages).values()) if (verdict.withheld) return true;
  }
  return false;
}
/** Roots judged and recorded as one kept entry (see handleSound). */
const SOUND_CHUNK = 512;
const soundKey = (handle: Handle) => `S${SEP}${handle.id}`;
/** Whether every member of a stored set is sound. The answer for a set is kept, resting on the answer for its parent and
 * on the verdicts and sources of the members it adds, so a turn judges only what its set added to the one it began with:
 * a set whose parent is already known to hold costs its own additions. An entry is dropped, with everything resting on
 * it, exactly when a root it covers changes (the same dirty keys as the verdicts). */
function handleSound(handle: Handle): boolean {
  const kept = verdictCache();
  if (kept === undefined || collected !== null) return !flatRootsBad(handleKeys(handle));
  if (kept.has(soundKey(handle))) return true;
  const run: Handle[] = [];
  let at: Handle | null = handle;
  while (at && !kept.has(soundKey(at))) { run.push(at); at = at.parent; }
  let previous = at ? soundKey(at) : null, pending: string[] = [], carried = new Set<string>(), lost = false;
  for (let index = run.length - 1; index >= 0; index--) {
    const node = run[index]!;
    for (const key of handleKeys(node, node.parent?.end ?? 0)) pending.push(key);
    if (pending.length < SOUND_CHUNK && index > 0) continue;
    const deps = new Set<string>();
    collected = deps;
    let bad: boolean;
    try { bad = flatRootsBad(pending); } finally { collected = null; }
    if (bad) return false;
    pending = [];
    // see replaySetBad: a proof below that was not kept is carried by what it consulted; one kept and since gone ends the keeping
    if (previous) { if (kept.has(previous)) deps.add(`v${SEP}${previous}`); else lost = true; }
    for (const d of carried) deps.add(d);
    if (!lost && deps.size <= 4000 && keepVerdict(soundKey(node), { withheld: false, unproven: false, deps })) { previous = soundKey(node); carried = new Set(); }
    else { previous = null; carried = deps; }
  }
  return true;
}
/** Whether a root set no longer holds: past the ceiling, or any root
 * forgotten or withheld by its receipts (content only: no reader access
 * needed, so it runs with memory off). Checks it cannot finish count as bad. */
export function outputRootsBad(set: OutputRoots): boolean {
  if (set.over || set.roots.size > rootCeiling()) return true;
  if (!set.roots.size) return false;
  try {
    const view = layeredOf(set.roots);
    if (view.extra.size && flatRootsBad(view.extra)) return true;
    return Boolean(view.handle) && !handleSound(view.handle!);
  } catch (error) { noteWithheldOnError(error); return true; }
}

/** A copy link whose original is withheld, on content (a delegation result
 * read back later). Checks it cannot finish withhold it. */
export function copyOriginWithheld(copy: MessageCopy): boolean {
  try { return replayExclusions(copy.threadId, [{ id: "copy-origin-probe", role: "user", copyOf: copy }], null, { failClosed: true }).size > 0; }
  catch { return true; }
}

/** The same rule for one captured source (checkpoint maintenance). */
export function sourceIsWithheldMessage(source: Record<string, unknown>): boolean {
  return Boolean(source.thread_id && source.message_id && generatedSpeaker(source.speaker) && capturedMessageWithheld(String(source.thread_id), String(source.message_id)));
}

/** A session that was shown memory before output lineage began (memory
 * schema v6) may have taken in replies whose lineage was never recorded. It
 * is unproven while it holds receipts and has no v6
 * session row (decided by the row alone, never by comparing times), and it resets before its first v6 continuation, whatever the
 * counters say. The session v6 then starts gets its row (recordSessionRoots on
 * session.started), so it is not reset again (Astra r4 #5). */
export function preLineageSessionRevoked(rows:ReadonlyArray<Record<string,unknown>>,threadId:string,driverInstance:string,nativeSession:string):boolean {
  if(!rows.length||sessionLineageKnown(threadId,driverInstance,nativeSession))return false;
  // structural, never by clock: every session v6 starts or resumes has a lineage row, so receipts with no row are a legacy session
  return true;
}
