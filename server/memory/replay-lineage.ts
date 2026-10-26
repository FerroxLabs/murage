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
import { memoryGate } from "./memory-gate.ts";
import { setMemoryCheckingSource } from "./integrity-flags.ts";
import { authorityParts } from "./authority-epoch.ts";
import { statementReusePassId, withStatementReuse, writeStamp } from "../io-budget.ts";
import { supersededThreadCheckpoint, threadCheckpointId } from "./checkpoints.ts";
import { ancestryThreadRepaired } from "./schema.ts";
import { allowanceHooks, LineageAllowance, ROWS_PER_NODE, TURN_LINEAGE_NODES, setTurnLineageNodesForTest } from "./lineage-allowance.ts";
import { forgetRootSetHandles, handleFor, handleKeys, layeredOf, LayeredRoots, storeLayered, type Handle, type HandleCache, type ReadMeter, type RootView } from "./root-set-handles.ts";
import { heldStep } from "../observe.ts";
import { copyFieldsChanged } from "../message-copy-fields.ts";
import { DENIED_RECORD_SCOPE, DENIED_SOURCE } from "./deny.ts";
import { denyLookup, lineageLive, memoryLookup } from "./deny-read.ts";
import { chainJudge } from "../bot-read.ts";
import type { Message } from "../store.ts";
import { readTimeRetired, withoutDroppedTableTriggers } from "./read-time-retired.ts";
import { FOOTPRINT_STAR, memoryRefKey } from "./lineage-types.ts";
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
  // every version of the record: a tombstone names the record, not always a version
  dep("q", id);
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
/** Budgets that ran out so far, anywhere (a verdict reached while this moved is not kept: it may have been cut short). */
let limitHits = 0;

/** What ONE piece of work may spend on lineage work in all (1.0.2 lineage-cold; lineage-allowance.ts). Every judge a turn starts (the replay
 * check, the recall checks, the continuation check, and the judges those start for the replies they cite) draws on the turn's one
 * LineageAllowance, passed to it as a REQUIRED parameter, so the work of a turn follows the allowance, never the length of the history
 * behind it. A check that runs past it withholds what it could not prove: a reply with no kept verdict is not shown, recall drops the hit,
 * a retained session is reset (reason `lineage-warming`). What the check proved before it ran out stays kept, and the warmer
 * (lineage-warm.ts) finishes the rest while the app is idle, so the next turn finds it done. */
export { LineageAllowance, ROWS_PER_NODE, TURN_LINEAGE_NODES, setTurnLineageNodesForTest };
/** Moves whenever lineage progress is made that a later call can build on (a verdict kept, a page of a root-set chain read and held): the
 * warmer asks whether a slice that ran out still moved things on. */
let progressTick = 0;
export function lineageProgress(): number { return progressTick; }
allowanceHooks.progress = () => { progressTick++; };
allowanceHooks.exhausted = thread => { noteLineageWanted(thread); limitHits++; unfinished++; };
allowanceHooks.wanted = thread => { noteLineageWanted(thread); };
/** Whether an error is the allowance (or a check's budget) running out. */
export const isLineageLimit = (error: unknown): boolean => error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT";
/** Threads where a turn's allowance ran out: the warmer (lineage-warm.ts) takes them next. */
const wantedThreads = new Set<string>();
function noteLineageWanted(thread: string): void { if (!warming && wantedThreads.size < 4096) wantedThreads.add(thread); }
/** Set while the warmer itself judges: its own allowance running out is not a turn that needs warming. */
let warming = false;
/** The threads waiting for the warmer since the last call. */
/** Whether a turn has asked for warming since the warmer last looked (nothing is taken). */
export function lineageWantedPending(): boolean { return wantedThreads.size > 0; }
export function takeLineageWanted(): string[] { const found = [...wantedThreads]; wantedThreads.clear(); return found; }
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

/** A copy's original is not there to be copied from, judged by the reader door's chain judge (bot-read.ts chainJudge, LINEAGE-DESIGN-S6 rules 9
 * and 16): gone (its conversation was deleted), unreadable, classified, not a bot or owner row, its own chain failing, or reading withheld under
 * the lineage verdicts. A copy never outlives the original it was made from, whatever memory is doing. While no line lineage is written on
 * this file the verdicts read nothing, and the owner's note stays this reader's own read-time judge (rule 29). */
export function copyOriginUnavailable(threadId: string, messageId: string): boolean {
  dirtyMessage(threadId, messageId);
  const db = database();
  const probe = { id: COPY_ORIGIN_PROBE, role: "user", kind: "text", at: 0, copyOf: { threadId, messageIds: [messageId] } } as Message;
  const chain = chainJudge(db, threadId, null);
  // a chain that fails only on unknowns (a source still checking) is a check that could not finish, not a mark: counted so the copy reads
  // checking (replayExclusionsWith, REPLY-WITHHELD-CONTRACT R1)
  if (!chain(probe)) { if (chain.checking()) unfinished++; return true; }
  if (lineageLive(db)) return false;
  const row = stmt(db, "SELECT json_extract(json,'$.withheldFromBots') AS withheld FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (!row) return true;
  // "checking" is never a stored verdict: an original left flagged so on disk is read as no note and judged by the chain above (contract R2)
  return row.withheld !== null && row.withheld !== undefined && row.withheld !== 0 && row.withheld !== "false" && row.withheld !== "checking";
}

/** The owner forgot the message itself (its captured source is deleted or tombstoned). */
/** messageSourceForgotten for many lines of one thread at once: ONE statement per 500 lines (the conversation's deny row, deleted
 * or denied sources, source tombstones), so a turn pays a statement per batch, not two per line. */
export function forgottenMessageSources(threadId: string, messageIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!messageIds.length) return out;
  const db = database(), prefix = `message:${threadId}:`;
  for (const id of messageIds) dep("s", `${prefix}${id}`);
  for (let at = 0; at < messageIds.length; at += 500) {
    const ids = JSON.stringify(messageIds.slice(at, at + 500).map(id => `${prefix}${id}`));
    for (const row of stmt(db, `SELECT value AS id FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?2)
      UNION SELECT s.id FROM memory_sources s WHERE s.id IN (SELECT value FROM json_each(?1)) AND (s.state='deleted' OR ${DENIED_SOURCE("s")})
      UNION SELECT target_id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?1))`).all(ids, threadId)) out.add(String(row.id).slice(prefix.length));
  }
  return out;
}
export function messageSourceForgotten(threadId: string, messageId: string): boolean {
  const db = database(), sourceId = `message:${threadId}:${messageId}`;
  dep("s", sourceId);
  // deleted, or in a deleted conversation or bot (deny.ts) before the job marks it; a deleted conversation's uncaptured lines too
  const source = stmt(db, `SELECT (SELECT s.state FROM memory_sources s WHERE s.id=?1) AS state,
    EXISTS(SELECT 1 FROM memory_sources s WHERE s.id=?1 AND ${DENIED_SOURCE("s")}) OR EXISTS(SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?2) AS denied`).get(sourceId, threadId);
  return source?.state === "deleted" || Boolean(source?.denied) || Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1").get(sourceId));
}

/** The forgotten message lines of a thread, with when each was written and forgotten (positionalWithheld). One range seek on the
 * tombstones' unique index over the thread's message source ids, at most 256 (past that: "many"), then a primary-key read of each
 * line; kept per thread until a forget moves the epoch or a tombstone is written. */
const threadForgetsCache = new Map<string, { key: string; pass?: unknown; writes?: unknown; db?: object; forgets: Array<{ at: number; forgetAt: number; id: string }> | "many" }>();
function threadForgets(db: DatabaseLike, threadId: string): Array<{ at: number; forgetAt: number; id: string }> | "many" {
  // inside one synchronous pass with no write since, the list has not moved (the same reuse rule as lineageStamp)
  const pass = statementReusePassId(), writes = writeStamp(db as never);
  const kept = threadForgetsCache.get(threadId);
  if (kept && pass && writes !== undefined && kept.pass === pass && kept.writes === writes && kept.db === db) return kept.forgets;
  const stamp = stmt(db, "SELECT (SELECT deletion_epoch FROM memory_meta WHERE id=1) AS e,(SELECT max(rowid) FROM memory_tombstones) AS t").get();
  const key = `${stamp?.e}:${stamp?.t}`;
  if (kept && kept.key === key) { Object.assign(kept, { pass, writes, db }); return kept.forgets; }
  const prefix = `message:${threadId}:`;
  // what the owner forgot (a line, or a memory resting on it), not a deleted bot's or conversation's bookkeeping
  const rows = stmt(db, "SELECT target_id,min(created_at) AS f FROM memory_tombstones WHERE target_type='source' AND target_id>=? AND target_id<? AND reason IN ('owner-forget','forgotten-supporting-source') GROUP BY target_id LIMIT 257").all(prefix, `message:${threadId};`);
  let forgets: Array<{ at: number; forgetAt: number; id: string }> | "many" = [];
  if (rows.length > 256) forgets = "many";
  else for (const row of rows) {
    const id = String(row.target_id).slice(prefix.length);
    const line = stmt(db, "SELECT at FROM messages WHERE thread_id=? AND id=?").get(threadId, id);
    if (line) forgets.push({ at: Number(line.at), forgetAt: Number(row.f), id });
  }
  if (threadForgetsCache.size >= 256) threadForgetsCache.delete(threadForgetsCache.keys().next().value!);
  threadForgetsCache.set(threadId, { key, pass, writes, db, forgets });
  return forgets;
}
/** Generated lines of a thread written after a line the owner forgot, by a turn that began before that forget: the reply may
 * repeat the forgotten words with no receipt to say so (capture only, paused, off; or quoted from the transcript in any mode), so
 * it is withheld in every mode (1.0.2 revoke-bounded r3). A turn begins at its first row's parent (or the line's own parent):
 * a forget made while the turn ran still covers its reply. Owner and person lines are never withheld this way. Past 256 forgotten
 * lines in one thread every generated line counts (fail closed). Bounded: the cached forget list plus a few primary-key reads per
 * line, nothing when the thread has no forgotten line. */
export function positionalWithheld(threadId: string, messageIds: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const db = database();
  const forgets = threadForgets(db, threadId);
  if (forgets !== "many" && !forgets.length) return out;
  const line = stmt(db, "SELECT at,role,json_extract(json,'$.turnId') AS turn,json_extract(json,'$.parentId') AS parent FROM messages WHERE thread_id=? AND id=?");
  const atOf = (id: unknown) => typeof id === "string" ? stmt(db, "SELECT at FROM messages WHERE thread_id=? AND id=?").get(threadId, id)?.at : undefined;
  for (const id of messageIds) {
    const row = line.get(threadId, id);
    if (!row || row.role === "user") continue;
    if (forgets === "many") { out.add(id); continue; }
    const at = Number(row.at);
    let start: number | undefined;
    for (const forget of forgets) {
      if (forget.id === id || !(forget.at < at)) continue;
      if (at < forget.forgetAt) { out.add(id); break; }
      if (start === undefined) {
        // the turn's first row (turn_first), else this line: its parent was there when the turn was put together
        const first = typeof row.turn === "string" ? stmt(db, "SELECT json_extract(m.json,'$.parentId') AS parent FROM turn_first f JOIN messages m ON m.rowid=f.first_rowid WHERE f.thread_id=? AND f.turn_id=?").get(threadId, row.turn) : undefined;
        const parentAt = atOf(first ? first.parent : row.parent);
        start = parentAt === undefined || parentAt === null ? at : Number(parentAt);
      }
      if (start < forget.forgetAt) { out.add(id); break; }
    }
  }
  return out;
}

/** A budget ran out (a check's own, or the turn's allowance). Unwinding for that reason taints nothing: whatever was kept before is a
 * complete proof, and whatever was being worked out is not kept (the exception passes through it), so a check that ran out leaves its
 * finished parts for the next one (1.0.2 lineage-cold; any other failure still taints the check, as before). */
const ranOut = (error: unknown): boolean => (error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT") || error instanceof LineageControl;
/** Verdicts reached without knowing what they rested on (a memo entry made outside any verdict's scope, or one cut short). */
let untracked = 0;
/** THE check-wide taint (1.0.2 r5). While a top-level check runs, `checkBase` is the `untracked` count it began with and `checkKept` every
 * verdict it kept (any judge, any reuse structure). The moment `untracked` moves, a memo hit lacked a recorded dependency set: nothing
 * further in that check is kept (`keepVerdict`), and what it already kept is discarded when it ends. No propagation through groupRests
 * or any other reuse: the blunt rule is what keeps warm replay from showing what an unbounded cold check would withhold. */
let checkBase: number | null = null;
let checkKept: string[] | null = null;
const checkTainted = (): boolean => checkBase !== null && untracked !== checkBase;
function keepVerdict(key: string, entry: Verdict): boolean {
  if (checkTainted() || !remember(key, entry)) { noteUnkept(checkTainted() ? "tainted" : `refused ${key[0]}`); return false; }
  checkKept?.push(key);
  return true;
}
/** Verdicts reached and NOT kept (a cycle, an untracked memo hit, a basis too large, an open transaction): the warmer cannot warm what a
 * judgement of this kind reaches, so a slice that moved this has not finished its thread. */
let unkept = 0;
const unkeptWhy: string[] = [];
const noteUnkept = (why: string): void => { unkept++; if (unkeptWhy.length < 64) unkeptWhy.push(why); };
export function lineageUnkept(): number { return unkept; }
/** The first few reasons a verdict was reached and not kept (for tests and the turn trace). */
export function lineageUnkeptReasons(): readonly string[] { return unkeptWhy; }
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
    catch (error) { collected = outer; if (outer && mine) { for (const d of mine) outer.add(d); if (!ranOut(error)) untracked++; } throw error; }
    collected = outer;
    this.entries.set(key, { value, deps: mine, upTo: mine ? mine.size : 0 });
    if (mine && outer) for (const d of mine) outer.add(d);
    return value;
  }
}

/** The content half of a receipt check: every record and source the receipt
 * cites still exists at the version disclosed, and nothing of it was
 * forgotten. No reader access and no global counter is consulted. */
export function contentRevoked(allowance: LineageAllowance, row: Disclosure, threadId: string, memo?: JudgeMemo<boolean>): boolean {
  try {
    const db = database();
    // A session's receipts cite the same records and sources again and again: one check judges each once. A lookup that is not already
    // in the memo is paid for BEFORE it is made (1.0.2 lineage-cold): a receipt that cites thousands of sources cannot read them all
    // for free, it stops with the limit error when the allowance cannot cover the next one.
    const once = (key: string, judge: () => boolean): boolean => {
      const paid = (): boolean => { allowance.spendNodes(threadId, 1); return judge(); };
      return memo ? memo.run(key, paid) : paid();
    };
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) {
      const bad = once(`r\u0000${record.id}\u0000${record.version}`, () => {
        // (a deleted bot's scope refuses its records from the deletion's commit: deny.ts)
        const current = stmt(db, `SELECT r.state,r.kind,r.scope_id,${DENIED_RECORD_SCOPE("r")} AS denied FROM memory_records r WHERE r.id=? AND r.version=?`).get(record.id,record.version);
        recordDep(record.id, record.version, current, threadId);
        if (!current || (current.state!=="active" && !supersededThreadCheckpoint(record.id,record.version,{threadId}))) return true;
        if (current.denied) return true;
        return Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(record.id,record.version));
      });
      if (bad) return true;
    }
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      dep("s", source.id);
      const bad = once(`s\u0000${source.id}\u0000${source.revision}`, () => {
        const current = stmt(db, `SELECT s.state,s.revision,${DENIED_SOURCE("s")} AS denied FROM memory_sources s WHERE s.id=?`).get(source.id);
        return !current || current.state!=="active" || current.revision!==source.revision || Boolean(current.denied) || Boolean(stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision));
      });
      if (bad) return true;
    }
    return false;
  } catch (error) {
    // the allowance running out is not a finding about the receipt: it passes up, so the check withholds as unproven
    if (isLineageLimit(error)) throw error;
    return true;
  }
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
interface ReceiptGroup {
  row: Disclosure; bundles: BundleList;
  /** How many receipts at the front of `bundles` were judged sound (the group's verdict kept under `judgedKey`): while that kept verdict
   * stands, a check judges only the receipts after them, so the work of a check follows the receipts added, not the group's length. */
  judgedUpTo?: number; judgedKey?: string;
}
/** The receipt ids of one group: an append-only list of chunks (1.0.2 lineage-cold). A receipt added to a long group is one more id in a
 * new chunk; the ids already there are neither copied nor serialised again. Each chunk keeps where it starts, so a read from a position
 * (a check going on from `judgedUpTo`) finds its chunk by a binary search and never walks the chunks before it: the work of advancing
 * follows the receipts added, not the number of appends the group has had. */
export class BundleList implements Iterable<string> {
  private readonly chunks: string[][] = [];
  /** Where each chunk starts in the list (ascending, one per chunk). */
  private readonly starts: number[] = [];
  length = 0;
  constructor(ids: string[] = []) { if (ids.length) { this.chunks.push(ids); this.starts.push(0); this.length = ids.length; } }
  get first(): string { return this.chunks[0]?.[0] ?? ""; }
  /** Adds ids at the end, as a chunk of their own. */
  append(ids: BundleList | readonly string[]): number {
    let added = 0;
    for (const chunk of ids instanceof BundleList ? ids.chunks : [ids as readonly string[]]) {
      if (!chunk.length) continue;
      this.starts.push(this.length + added); this.chunks.push(chunk.slice()); added += chunk.length;
    }
    this.length += added;
    return added;
  }
  *[Symbol.iterator](): Iterator<string> { for (const chunk of this.chunks) for (const id of chunk) yield id; }
  /** The chunk that holds position `at` (the last chunk starting at or before it). */
  private chunkAt(at: number): number {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid]! <= at) lo = mid; else hi = mid - 1; }
    return lo;
  }
  /** The ids from position `from` on: the chunks before the one holding `from` are not visited. */
  *tail(from: number): Iterable<string> {
    if (from >= this.length) return;
    for (let index = from <= 0 ? 0 : this.chunkAt(from); index < this.chunks.length; index++) {
      chunkVisits++;
      const chunk = this.chunks[index]!;
      for (let at = Math.max(0, from - this.starts[index]!); at < chunk.length; at++) yield chunk[at]!;
    }
  }
  some(test: (id: string) => unknown, from = 0): boolean { for (const id of this.tail(from)) if (test(id)) return true; return false; }
  filter(test: (id: string) => unknown, from = 0): string[] { const found: string[] = []; for (const id of this.tail(from)) if (test(id)) found.push(id); return found; }
  toArray(): string[] { return [...this]; }
}
/** Chunks of receipt groups visited by reads from a position (tests pin a check of an unchanged long group at a constant number). */
let chunkVisits = 0;
export function replayChunkVisits(): number { return chunkVisits; }
export function resetReplayChunkVisits(): void { chunkVisits = 0; }
/** Receipt ids copied into a kept group when a receipt is added to it (tests pin this at one per added receipt). */
let groupIdsCopied = 0;
export function replayGroupIdsCopied(): number { return groupIdsCopied; }
export function resetReplayGroupIdsCopied(): void { groupIdsCopied = 0; }
const GROUP_COLUMNS = `thread_id,state,policy_revision,deletion_epoch,
  CASE WHEN length(record_versions)<=262144 THEN record_versions END AS record_versions,
  CASE WHEN length(source_versions)<=262144 THEN source_versions END AS source_versions,
  json_group_array(bundle_id) AS bundles, max(rowid) AS latest`;
const GROUP_BY = "GROUP BY thread_id,state,policy_revision,deletion_epoch,record_versions,source_versions ORDER BY latest DESC";

/** The listing of a warm turn, in one statement over one materialised set of the receipts that list the lines: the native sessions they
 * belong to (their newest receipt each: the 's' rows) and the receipts that belong to no session, grouped (the 'g' rows). A receipt of a
 * session is judged with the session's proof of its receipts up to the newest one listing the lines (provePrefix), which covers it, so it
 * is not read again here: a reply every receipt of a long session lists costs its listers once, not once per group. Binds: thread,
 * message ids (JSON), thread, limit. */
export const LISTING_SQL = `WITH direct(b) AS MATERIALIZED (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))),
      sess AS (SELECT l.driver_instance AS d, l.native_session AS ns, max(l.rowid) AS c FROM direct JOIN memory_disclosures l ON l.bundle_id=direct.b WHERE l.native_session IS NOT NULL GROUP BY 1,2),
      grp AS (SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND native_session IS NULL AND bundle_id IN (SELECT b FROM direct) ${GROUP_BY} LIMIT ?)
      SELECT 's' AS k, d, ns, c, NULL AS thread_id, NULL AS state, NULL AS policy_revision, NULL AS deletion_epoch, NULL AS record_versions, NULL AS source_versions, NULL AS bundles, NULL AS latest FROM sess
      UNION ALL SELECT 'g', NULL, NULL, NULL, thread_id, state, policy_revision, deletion_epoch, record_versions, source_versions, bundles, latest FROM grp
      ORDER BY k DESC, latest DESC`;

/** Receipts read per page when a session's receipts are proven in turn (provePrefix). */
const PREFIX_PAGE = 512;
/** One check's judge: verdicts per receipt, per group, per cited list, per
 * record and per proven reply last for this check only. */
function lineageJudge(allowance: LineageAllowance, threadId: string, audience: ReplayAudience | null, invalidBundles?: Set<string>) {
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
  /** Receipts already counted against REPLAY_RECEIPT_BUDGET: each distinct receipt once, however many times a walk that did not finish comes back to it. */
  const countedReceipts = new Set<string>();
  const ownsCheck = checkBase === null;
  if (ownsCheck) { checkBase = untracked; checkKept = []; }
  /** Set once a budget of THIS judge ran out: nothing further is kept by it. What it kept before is complete and stays (1.0.2 lineage-cold):
   * a verdict is kept only when the work that reached it finished cleanly (no check cut short, no cycle, nothing untracked), which is
   * exactly what an unbounded cold check computes for that key, so keeping it can never show what that check withholds. Discarding it made
   * a check that ran out start from nothing again on every turn (the first prime turn on the scale rig never finished). */
  let exhausted = false;
  // (a check cut short is an unfinished one: a verdict whose work spans it is not kept, wherever the cut was swallowed)
  const limit = (): Error => { exhausted = true; limitHits++; unfinished++; return new Error("MEMORY_REPLAY_LIMIT"); };
  /** The allowance's shared lineage budget, drawn on by every judge the work starts, nested ones included. */
  const spend = (count: number): void => {
    try { allowance.spendNodes(threadId, count); }
    catch (error) { exhausted = true; throw error; }
  };
  /** Work that spends on the allowance itself (the content rule): a limit it meets ends this judge's keeping, as a charge of the judge's own would. */
  const guarded = <T>(work: () => T): T => {
    try { return work(); }
    catch (error) { if (isLineageLimit(error)) exhausted = true; throw error; }
  };
  const keep = (key: string, entry: Verdict): boolean => !exhausted && keepVerdict(key, entry);
  const settle = (): void => {
    if (!ownsCheck) return;
    // the check that owns the taint settles everything kept anywhere in it
    if (checkTainted() && checkKept?.length) forgetKept(checkKept);
    checkBase = null; checkKept = null;
  };
  const charge = (count=1) => { nodes+=count; rowsRead+=count; spend(count); if(nodes>(nodeBudgetOverride ?? REPLAY_NODE_BUDGET)) throw limit(); };
  const READ_FREE_ROWS = 64;
  /** Index rows read, paid for ROWS_PER_NODE to a node (a share of a node each, never free: a history-sized read is paid for by its rows). */
  let readDebt = 0;
  const chargeRead = (rows: number): void => {
    rowsRead += rows;
    // the first rows of a read ride on the node the step that made it is charged (a probe of a few receipts is part of judging them)
    if (rows <= READ_FREE_ROWS) return;
    readDebt += rows - READ_FREE_ROWS;
    const cost = Math.floor(readDebt / ROWS_PER_NODE);
    if (!cost) return;
    readDebt -= cost * ROWS_PER_NODE;
    nodes += cost; spend(cost);
    if (nodes > (nodeBudgetOverride ?? REPLAY_NODE_BUDGET)) throw limit();
  };
  const within = <T>(key: string, work: () => T): T => {
    if (visiting.has(key)) { cycleThrown++; throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE"); }
    visiting.add(key);
    try { return work(); } finally { visiting.delete(key); }
  };
  /** What this turn may still spend (Infinity outside a turn). */
  const roomLeft = (): number => allowance.room();
  /** The allowance cannot cover this: stop now rather than start work that would run past it. */
  const refuse = (): never => { allowance.refuse(threadId); throw limit(); };
  /** Refuses a read of the size `count` reports (counted in rows, no further than the room left can pay for) when the turn cannot afford it.
   * With no room left nothing is read at all. */
  const needRoom = (count: (rows: number) => number): void => { if (!roomFits(count)) refuse(); };
  /** Whether a read of the size `count` reports (in rows, counted no further than the room left can pay for: ROWS_PER_NODE to a node) fits the
   * room. No side effect. (What the rows are judged as, receipt groups, is paid for when they are read: toGroups.) */
  const roomFits = (count: (rows: number) => number): boolean => {
    const room = roomLeft();
    if (room === Infinity) return true;
    const rows = room * ROWS_PER_NODE;
    return room > 0 && count(rows + 1) <= rows;
  };
  /** The key a group's kept verdict is filed under (see groupBad). */
  const groupKeyOf = (row: Disclosure): string => `g${SEP}${JSON.stringify([threadId, String(row.thread_id), row.record_versions, row.source_versions])}`;
  /** Charges the groups a check has to judge: a group whose verdict is already kept costs a lookup (a small share of a node), not a judgement. */
  const groupsCost = (groups: readonly ReceiptGroup[]): number => {
    const kept = audience === null ? verdictCache() : undefined;
    if (!kept) return groups.length;
    let owed = 0;
    for (const group of groups) if (!kept.has(groupKeyOf(group.row))) owed++;
    return owed + Math.ceil((groups.length - owed) / 32);
  };
  const chargeGroups = (groups: readonly ReceiptGroup[]): void => { charge(groupsCost(groups)); };
  /** `quiet`: a read the caller can do without (it falls back to another way of reading): when the turn cannot pay for it, it stops BEFORE
   * paying anything and without telling the turn it ran out, so the caller goes on with the room it has. */
  const toGroups = (rows: Disclosure[], quiet = false): ReceiptGroup[] => {
    let receipts = 0;
    const groups = rows.map(row => { const bundles = new BundleList(JSON.parse(String(row.bundles)) as string[]); receipts += bundles.length; return { row, bundles }; });
    if (quiet) {
      const room = roomLeft();
      const readNodes = receipts > READ_FREE_ROWS ? Math.floor((readDebt + receipts - READ_FREE_ROWS) / ROWS_PER_NODE) : 0;
      if (room !== Infinity && groupsCost(groups) + readNodes > room) throw limit();
    }
    // every group read is charged (the ones already judged and kept for little), and a listing past the receipt budget fails
    chargeGroups(groups);
    chargeRead(receipts);
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
  const listingFull = (thread: string, messageIds: readonly string[]): ReceiptGroup[] => {
    // a turn does not start a listing its allowance cannot cover (the receipts that list the lines are at least as many as the lines' pairs)
    needRoom(room => Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)) LIMIT ?)").get(thread, JSON.stringify(messageIds), room)?.n ?? 0));
    // The listing below expands each native session the direct receipts belong to into every receipt of it up to the newest that lists
    // the lines (1.0.2 lineage-cold r3: that expansion read 60,000 receipts of a session while one node had been paid). The receipts it
    // would read are counted first, session by session, no further than the room left can pay for, and a listing the room cannot cover
    // is refused BEFORE it is made.
    const sessions = stmt(db, `SELECT l.driver_instance AS d, l.native_session AS ns, max(l.rowid) AS c FROM memory_disclosures l
      WHERE l.bundle_id IN (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))) AND l.native_session IS NOT NULL GROUP BY 1,2`).all(thread, JSON.stringify(messageIds));
    if (sessions.length) needRoom(limit => {
      let total = 0;
      const count = stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid<=? LIMIT ?)");
      for (const session of sessions) {
        total += Number(count.get(thread, session.d, session.ns, session.c, limit - total)?.n ?? 0);
        if (total >= limit) break;
      }
      return total;
    });
    return toGroups(stmt(db, `WITH direct(b) AS MATERIALIZED (SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))),
      sessions(d,ns,c) AS (SELECT l.driver_instance, l.native_session, max(l.rowid) FROM direct JOIN memory_disclosures l ON l.bundle_id=direct.b WHERE l.native_session IS NOT NULL GROUP BY 1,2)
      SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND bundle_id IN (SELECT b FROM direct
        UNION SELECT s.bundle_id FROM sessions JOIN memory_disclosures s ON s.thread_id=? AND s.driver_instance=sessions.d AND s.native_session=sessions.ns AND s.rowid<=sessions.c)
      ${GROUP_BY} LIMIT ?`).all(thread, JSON.stringify(messageIds), thread, thread, REPLAY_RECEIPT_BUDGET+1));
  };
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
  const provePrefix = (cache: Map<string, Verdict>, thread: string, d: string, ns: string, c: number, depth = 0): string | null => {
    const sessionKey = JSON.stringify([thread, d, ns]);
    let held = sessionSound.get(sessionKey);
    if (held && !cache.has(held.key)) { sessionSound.delete(sessionKey); held = undefined; }
    if (held && held.upTo >= c) return `v${SEP}${held.key}`;
    const lo = held?.upTo ?? 0;
    const sessionDep = `a${SEP}${thread}${SEP}${d}${SEP}${ns}`;
    /** The groups of one stretch of receipts all hold on content, and what each rests on joins `consulted`. */
    const groupsSound = (groups: ReceiptGroup[], consulted: Set<string>): boolean => {
      for (const group of groups) {
        // judged at the depth of the check that asked: a session's receipts each cite the reply before, and judging them all at depth 0 left nothing to
        // bound the recursion down a conversation (it overflowed the stack at about 250 replies, and every reply of the window was withheld)
        if (groupBad(group, depth)) return false;
        const first = group.bundles.first, rests = groupRests.get(first);
        if (typeof rests === "string") consulted.add(rests);
        // not kept because the transaction is still open, but reached cleanly: what it consulted is what it rests on
        else if (rests && keepRefused() && groupClean.has(first)) for (const x of rests) consulted.add(x);
        else return false;
      }
      return true;
    };
    // A proof that cannot be kept (the capture transaction is still open) serves this call only: the session is read from where the last
    // proof ended, in one read the turn must be able to pay for.
    if (keepRefused()) {
      const consulted = new Set<string>([sessionDep]);
      if (held) consulted.add(`v${SEP}${held.key}`);
      needRoom(rows => Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? AND rowid<=? LIMIT ?)").get(thread, d, ns, lo, c, rows)?.n ?? 0));
      let sound = true;
      try {
        const fresh = toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? AND rowid<=?
          ${GROUP_BY} LIMIT ?`).all(thread, d, ns, lo, c, REPLAY_RECEIPT_BUDGET+1));
        sound = groupsSound(fresh, consulted);
      } catch (error) {
        if (ranOut(error)) throw error;
        sound = false;
      }
      if (!sound || consulted.size > 4000) return null;
      for (const x of consulted) collected?.add(x);
      return "";
    }
    // Otherwise the session is proven a page of receipts at a time, each page's proof kept on top of the last (sessionSound names the
    // newest). A turn, or a warming slice, that runs out of its allowance stops with the pages it finished kept: the next call goes on
    // from there, so a session of any length is proven in as many calls as its receipts need, never in none because it does not fit one.
    let upTo = lo, previous: string | null = held?.key ?? null;
    for (;;) {
      needRoom(() => 0);
      const room = roomLeft();
      const pageRows = Math.max(1, Math.min(PREFIX_PAGE, room === Infinity ? PREFIX_PAGE : room * ROWS_PER_NODE));
      const edge = stmt(db, "SELECT rowid AS r FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(thread, d, ns, upTo, c, pageRows);
      if (!edge.length) break;
      const high = Number(edge[edge.length - 1]!.r);
      const consulted = new Set<string>([sessionDep]);
      if (previous) consulted.add(`v${SEP}${previous}`);
      let sound = true;
      try {
        const fresh = toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? AND rowid<=?
          ${GROUP_BY} LIMIT ?`).all(thread, d, ns, upTo, high, REPLAY_RECEIPT_BUDGET+1));
        sound = groupsSound(fresh, consulted);
      } catch (error) {
        if (ranOut(error)) throw error;
        sound = false;
      }
      if (!sound || consulted.size > 4000) return null;
      const key = `a${SEP}${JSON.stringify([thread, d, ns, high])}`;
      if (!keep(key, { withheld: false, unproven: false, deps: consulted })) return null;
      if (sessionSound.size > 4096) sessionSound.clear();
      sessionSound.set(sessionKey, { upTo: high, key });
      previous = key; upTo = high;
      if (high >= c) break;
    }
    return previous && upTo >= c ? `v${SEP}${previous}` : null;
  };
  const listing = (thread: string, messageIds: readonly string[], depth = 0): ReceiptGroup[] => {
    const cache = audience === null ? verdictCache() : undefined;
    if (!cache) return fallback(thread, messageIds);
    const ids = JSON.stringify(messageIds);
    const read = stmt(db, LISTING_SQL).all(thread, ids, thread, REPLAY_RECEIPT_BUDGET+1);
    const reached = read.filter(row => row.k === "s");
    if (!reached.length) return fallback(thread, messageIds);
    const covers: string[] = [];
    for (const row of reached) {
      const cover = provePrefix(cache, thread, String(row.d), String(row.ns), Number(row.c), depth);
      if (cover === null) return fallback(thread, messageIds);
      if (cover) covers.push(cover);
    }
    for (const cover of covers) collected?.add(cover);
    return toGroups(read.filter(row => row.k === "g").map(({ k: _k, d: _d, ns: _ns, c: _c, ...group }) => group));
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
  const threadGroups = (thread: string, quiet = false): ReceiptGroup[] => {
    let groups = threadGroupCache.get(thread);
    if (!groups) {
      // On content, a thread's groups are kept across checks (a turn writes a receipt or two: only those are read again)
      const reusable = audience === null && verdictCache() !== undefined && !keepRefused();
      if (reusable) needRoom(() => 0);
      const known = reusable ? currentThreadGroups(db, thread) : undefined;
      if (known) {
        if (quiet && groupsCost(known) > roomLeft()) throw limit();
        chargeGroups(known);
        rowsRead += known.reduce((total, group) => total + group.bundles.length, 0);
        groups = known;
      } else {
        const count = (rows: number) => Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, rows)?.n ?? 0);
        if (quiet) { if (!roomFits(count)) throw limit(); } else needRoom(count);
        groups = toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? ${GROUP_BY} LIMIT ?`).all(thread, REPLAY_RECEIPT_BUDGET+1), quiet);
        if (reusable) rememberThreadGroups(db, thread, groups);
      }
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
  const producers = (thread: string, messageIds: readonly string[], depth = 0): {groups: ReceiptGroup[]; exact: boolean} => {
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
    // counted once per thread per check (Astra r4 #7), and once per turn however many checks the turn starts: the figure only picks
    // between two ways of reading, and the count reads (and pays for) up to THREAD_RECEIPT_LIMIT index rows
    let receipts = receiptCounts.get(thread);
    if (receipts === undefined) {
      receipts = allowance.counts?.get(thread);
      if (receipts === undefined) {
        // (a probe of at most THREAD_RECEIPT_LIMIT+1 index rows, whatever the thread holds: not paid for by the row, only refused when no room is left)
        needRoom(() => 0);
        receipts = Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, THREAD_RECEIPT_LIMIT+1)?.n ?? 0);
        rowsRead += receipts;
        (allowance.counts ??= new Map()).set(thread, receipts);
      }
      receiptCounts.set(thread, receipts);
    }
    // A thread of more receipts than the receipt limit counts its pairs no
    // further than that limit either: counting to PAIR_LIMIT charged 20,000
    // rows for a count that only decides between two reads, on every check of
    // every long thread. Past the cap the thread's groups are judged; only if
    // that read runs out of budget are the pairs counted to PAIR_LIMIT and
    // listed, as before.
    const pairCap = receipts <= THREAD_RECEIPT_LIMIT ? Math.min(PAIR_LIMIT, receipts) : THREAD_RECEIPT_LIMIT;
    needRoom(() => 0);
    const pairs = Number(stmt(db, pairSql).get(thread, JSON.stringify(messageIds), pairCap+1)?.n ?? 0);
    chargeRead(pairs);
    charge();
    if (pairs <= pairCap) { needRoom(() => pairs); return { groups: listing(thread, messageIds, depth), exact: true }; }
    if (receipts <= THREAD_RECEIPT_LIMIT) return { groups: threadGroups(thread), exact: false };
    // Too many receipts to read whole (found on an earlier call): list.
    if (!threadTooLong.has(thread)) {
      // A thread the turn cannot afford to read whole is listed, without trying (a refused read is not a check that ran out)
      if (!roomFits(rows => Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, rows)?.n ?? 0))) threadTooLong.add(thread);
      else {
        const spent = nodes, wasExhausted = exhausted, wasUnfinished = unfinished, wasHits = limitHits, wasHit = allowance.hit;
        try { return { groups: threadGroups(thread, true), exact: false }; }
        catch (error) {
          if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT")) throw error;
          // a turn whose allowance ran out lists nothing further
          if (allowance.spentOut()) throw error;
          // the failed read's charge is given back, so listing is possible: a read that did not fit is not a check that ran out
          nodes = spent; exhausted = wasExhausted; unfinished = wasUnfinished; limitHits = wasHits; allowance.hit = wasHit; threadTooLong.add(thread);
        }
      }
    }
    needRoom(() => 0);
    const all = Number(stmt(db, pairSql).get(thread, JSON.stringify(messageIds), PAIR_LIMIT+1)?.n ?? 0);
    chargeRead(all);
    if (all <= PAIR_LIMIT) { needRoom(() => all); return { groups: listing(thread, messageIds, depth), exact: true }; }
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
    const { groups, exact } = producers(thread, messageIds, depth);
    for (const group of groups) {
      if (exact) { if (alsoBad?.(group) || groupBad(group, depth)) return true; continue; }
      // Judging the whole thread meets groups that list none of these
      // messages, among them the one being judged right now: their lineage
      // may lead back to it. Such a group's verdict does not matter here.
      let bad: boolean;
      try { bad = Boolean(alsoBad?.(group)) || groupBad(group, depth); }
      catch (error) {
        if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LINEAGE_CYCLE")) throw error;
        if (listingAny(thread, group.bundles.toArray(), messageIds).length) throw error;
        continue;
      }
      if (bad && listingAny(thread, group.bundles.toArray(), messageIds).length) return true;
    }
    return false;
  };
  /** Every receipt of one native session, grouped. */
  const session = (driverInstance: string, nativeSession: string): ReceiptGroup[] => {
    needRoom(room => Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT ?)").get(threadId, driverInstance, nativeSession, room)?.n ?? 0));
    return toGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?
      ${GROUP_BY} LIMIT ?`).all(threadId, driverInstance, nativeSession, REPLAY_RECEIPT_BUDGET+1));
  };
  /** The reader's own receipt, under its audience (or on content alone). Its
   * row-level fields were checked by the caller, so the verdict rests on what
   * it cites. */
  const ownBad = (row: Disclosure, cited: string): boolean => {
    return ownVerdicts.run(cited, () => {
      if (!audience) return guarded(() => contentRevoked(allowance, row, threadId, contentMemo));
      // the reader's answer rests on what the content check consults too: noted so a kept set verdict is dropped by the same keys
      if (collected) guarded(() => contentRevoked(allowance, row, threadId, contentMemo));
      return audience.revoked(row);
    });
  };
  const groupBad = (group: ReceiptGroup, depth = 0): boolean => {
    // Receipts at the front of a kept group that were judged sound stay sound while the kept verdict stands (the group's verdict rests on
    // what it cites, never on which receipts it holds): only the receipts added since are looked at again (the first stays, for its basis).
    let from = 0;
    if (group.judgedUpTo && group.judgedKey !== undefined && audience === null) {
      const held = verdictCache()?.get(group.judgedKey);
      if (held && !held.withheld && group.judgedKey === groupKeyOf(group.row)) from = Math.min(group.judgedUpTo, group.bundles.length);
    }
    const first = group.bundles.first;
    const unknown = group.bundles.filter(id => !verdicts.has(id), from);
    if (from > 0 && !verdicts.has(first)) unknown.unshift(first);
    if (!unknown.length) {
      if (collected) {
        const rests = groupRests.get(first);
        if (typeof rests === "string") collected.add(rests); else if (rests) for (const d of rests) collected.add(d);
        // a verdict with no recorded basis cannot be carried into another proof: that proof is not kept (1.0.2 r2 P1)
        else untracked++;
      }
      return group.bundles.some(id => verdicts.get(id), from);
    }
    if (depth > 64) throw limit();
    for (const id of unknown) if (!countedReceipts.has(id)) { countedReceipts.add(id); receiptCount++; }
    if (receiptCount > REPLAY_RECEIPT_BUDGET) throw limit();
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
    const key = cache ? groupKeyOf(row) : "";
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
      else { if (!clean && unfinished === unfinishedBefore) noteUnkept(`group ${consulted.size > 4000 ? "basis" : cycles !== cyclesBefore || cycleThrown !== thrownBefore ? "cycle" : "untracked"}`); rests = consulted; }
      if (clean) for (const id of unknown) groupClean.add(id);
      if (outer) { if (typeof rests === "string") outer.add(rests); else for (const d of rests) outer.add(d); }
    } else {
      // Not kept here (a reader's check, or a transaction still open): the verdict is still reached ONCE per check and read again
      // by whatever else lists these receipts, so what it consulted is recorded, and every reader of it rests on the same
      // things (1.0.2 r2 P1: a second root set sharing the receipt lost its dependency on what the receipt cites).
      const outer = collected, consulted = new Set<string>();
      collected = consulted;
      try { bad = judge(); }
      catch (error) { collected = outer; if (outer) { for (const d of consulted) outer.add(d); if (!ranOut(error)) untracked++; } throw error; }
      collected = outer;
      rests = consulted;
      if (outer) for (const d of consulted) outer.add(d);
    }
    for (const id of unknown) { verdicts.set(id, bad as boolean); if (rests !== undefined) groupRests.set(id, rests); if (bad) invalidBundles?.add(id); }
    if (known && collected) collected.add(rests as string);
    if (cache && !bad && typeof rests === "string") { group.judgedUpTo = group.bundles.length; group.judgedKey = key; }
    return (bad as boolean) || group.bundles.some(id => verdicts.get(id), from);
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
        for (const edge of edges) { dep("r", String(edge.parent_id), String(edge.parent_version)); dep("r", String(edge.child_id), String(edge.child_version)); dep("q", String(edge.parent_id)); dep("q", String(edge.child_id)); }
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
          // deep in a chain the replies not judged yet are judged in one batch (one check, one shared allowance), not one by one
          charge(unjudged.length);
          const judged = capturedMessageVerdicts(allowance, thread, unjudged);
          for (const message of unjudged) if (settle(message, judged.get(message)!)) return true;
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
  // the deny seek once per thread for this judge (one synchronous pass), not once per batch of roots
  const threadDeny = new Map<string, boolean>();
  const badRoots = (thread: string, messages: readonly string[], depth: number): string[] => {
    const pending = [...new Set(messages)].filter(message => !rootVerdicts.has(rootKey(thread, message)) && !soundReplies.has(rootKey(thread, message)));
    if (pending.length) {
      const ids = JSON.stringify(pending.map(message => `message:${thread}:${message}`));
      for (const message of pending) dep("s", `message:${thread}:${message}`);
      rowsRead += pending.length;
      const forgotten = new Set([
        ...stmt(db, `SELECT s.id FROM memory_sources s WHERE s.id IN (SELECT value FROM json_each(?)) AND (s.state='deleted' OR ${DENIED_SOURCE("s")})`).all(ids).map(row => String(row.id)),
        ...stmt(db, "SELECT target_id AS id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?))").all(ids).map(row => String(row.id)),
      ]);
      // a deleted conversation's lines, and a line written after one the owner forgot (1.0.2 revoke-bounded r3)
      let deniedThread = threadDeny.get(thread);
      if (deniedThread === undefined) { deniedThread = Boolean(stmt(db, "SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(thread)); threadDeny.set(thread, deniedThread); }
      const positional = deniedThread ? new Set<string>() : positionalWithheld(thread, pending);
      const rest: string[] = [];
      for (const message of pending) {
        if (deniedThread || positional.has(message) || forgotten.has(`message:${thread}:${message}`)) rootVerdicts.set(rootKey(thread, message), true); else rest.push(message);
      }
      if (rest.length) {
        const { groups, exact } = producers(thread, rest, depth);
        const bad: string[] = [];
        for (const group of groups) {
          let verdict: boolean;
          try { verdict = groupBad(group, depth+1); }
          catch (error) {
            // judging the whole thread meets groups listing none of these (anyProducerBad)
            if (exact || !(error instanceof Error && error.message === "MEMORY_REPLAY_LINEAGE_CYCLE")) throw error;
            if (listingAny(thread, group.bundles.toArray(), rest).length) throw error;
            continue;
          }
          if (verdict) for (const id of group.bundles) bad.push(id);
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
        // in a time-boxed background slice a set more than one chunk large that is not proven whole gets a proof of its own before anything of it is
        // read (building its handle reads its rows)
        if (sliceDeadline !== Infinity && sizes.get(id)! > soundChunk() && !kept.has(readerKey ? `R${SEP}${readerKey}${SEP}${id}` : `R${SEP}${id}`) && !kept.has(wholeProofKey(id, readerKey))) {
          deferSet(id, true);
          setVerdicts.set(id, true); out.add(id);
          continue;
        }
        const handle = storedHandle(cache, id, sizes.get(id)!, allowance.meter(threadId));
        const bad = !handle || replaySetBad(kept, handle, depth);
        setVerdicts.set(id, bad);
        if (bad) out.add(id);
      }
      return out;
    }
    // No kept verdicts to lean on (a reader with no cache key, or a transaction that moved the epoch): each set is judged along its chain
    // with a verdict map of this call alone, the chain read page by page from the allowance (1.0.2 lineage-cold: the whole-forest read this
    // used to make was paid for by nothing and followed the length of the history). What a set rests on is judged once per call, in the
    // same chunks as the kept path, and nothing here is kept beyond the call.
    const scratchKept = new Map<string, Verdict>();
    const cache = handles();
    for (const id of live) {
      const handle = storedHandle(cache, id, sizes.get(id)!, allowance.meter(threadId));
      const bad = !handle || replaySetBad(scratchKept, handle, depth, (key, entry) => { scratchKept.set(key, entry); return true; });
      setVerdicts.set(id, bad);
      if (bad) out.add(id);
    }
    return out;
  };
  /** Whether any root of a stored set is bad on content (audience null), the answer kept per set and resting on its parent's
   * answer and on what its additions consulted: the same rules as capturedMessageVerdicts, one entry per chunk of additions. */
  /** Whether any of `keys` (members of a stored set, `thread\u0000message`) is bad, judged as replaySetBad judges one chunk: what a memo hides (replies
   * proven sound, roots and sets judged) is judged afresh, so `consulted` receives everything the answer rests on. */
  const chunkBad = (keys: readonly string[], depth: number, consulted: Set<string>): boolean => {
    const byThread = new Map<string, string[]>();
    for (const key of keys) {
      const cut = key.indexOf("\u0000"), thread = key.slice(0, cut);
      let list = byThread.get(thread);
      if (!list) byThread.set(thread, list = []);
      list.push(key.slice(cut + 1));
    }
    const outer = collected;
    const [sound0, root0, set0] = [soundReplies, rootVerdicts, setVerdicts];
    soundReplies = new JudgeMemo<boolean>(); rootVerdicts = new JudgeMemo<boolean>(); setVerdicts = new JudgeMemo<boolean>();
    collected = consulted;
    try { for (const [thread, messages] of byThread) if (badRoots(thread, messages, depth).length) return true; return false; }
    finally { collected = outer; soundReplies = sound0; rootVerdicts = root0; setVerdicts = set0; }
  };
  /** A set this check does not walk: its proof is asked of the recovery scheduler (for this reader, or on content), and the answer here is "not proven"
   * (bad, unfinished); the verdict being worked out rests on the proof's completion. `boxed`: deferred only for a background slice's time box. */
  const deferSet = (id: string, boxed: boolean): true => {
    const asked = requestProof(id, readerKey && audience ? { key: readerKey, thread: threadId, audience } : null);
    deferredLarge++; unfinished++;
    if (boxed) boxDeferred++;
    collected?.add(awaitedKey(asked));
    return true;
  };
  const replaySetBad = (kept: Map<string, Verdict>, handle: Handle, depth: number, keepEntry: (key: string, entry: Verdict) => boolean = keep): boolean => {
    const keyOf = (node: Handle) => readerKey ? `R${SEP}${readerKey}${SEP}${node.id}` : `R${SEP}${node.id}`;
    // a set the scheduler proved (whole, for content or for this reader) counts as one judged here
    const provenAs = (node: Handle): string | null => kept.has(keyOf(node)) ? keyOf(node) : kept.has(wholeProofKey(node.id, readerKey)) ? wholeProofKey(node.id, readerKey) : null;
    const top = provenAs(handle);
    if (top) { collected?.add(`v${SEP}${top}`); return false; }
    const run: Handle[] = [];
    let at: Handle | null = handle, below: string | null = null;
    while (at) { below = provenAs(at); if (below) break; run.push(at); at = at.parent; }
    // A large set whose additions beyond the nearest proven set are more than a turn judges is never walked here (the rule handleSound applies to a
    // retained session): its proof is built by the recovery scheduler, and until then a reply resting on it is withheld, not proven. So a replay after
    // a "checking" reset leaves that reply out and the replacement session does not carry the unproven set into the next turn (r8 Astra #1).
    // Inside a time-boxed background slice, any set whose unproven part is more than one chunk gets a proof of its own, in chunks, rather than a walk
    // that could outlast the slice (r8 Astra #3); what that deferral reaches is never kept for a turn to read (boxDeferred).
    const unprovenPart = handle.end - (at?.end ?? 0);
    const large = handle.end > LARGE_ROOT_SET && unprovenPart > TURN_JUDGE_MAX, boxed = !large && sliceDeadline !== Infinity && unprovenPart > soundChunk();
    if (large || boxed) return deferSet(handle.id, boxed);
    const outer = collected, rests = new Set<string>();
    let previous = below, pending: string[] = [], carried = new Set<string>(), lost = false;
    if (previous) rests.add(`v${SEP}${previous}`);
    const done = (bad: boolean): boolean => { if (outer) for (const d of rests) outer.add(d); return bad; };
    let rowsOf = new Set<string>();
    for (let index = run.length - 1; index >= 0; index--) {
      const node = run[index]!;
      // the rows of every set read here are part of what the entry rests on ("x": a change to them drops it)
      rowsOf.add(`x${SEP}${node.id}`);
      for (const key of handleKeys(node, node.parent?.end ?? 0)) { pending.push(key); memberWork++; }
      if (pending.length < soundChunk() && index > 0) continue;
      // a background proof slice hands back between chunks once it has used its time (each kept chunk is progress the next slice starts from)
      yieldIfLate();
      const consulted = new Set<string>(), cyclesBefore = cycles, thrownBefore = cycleThrown, unfinishedBefore = unfinished, untrackedBefore = untracked;
      let bad = false;
      try { bad = chunkBad(pending, depth, consulted); }
      catch (error) { for (const d of consulted) rests.add(d); throw error; }
      pending = [];
      if (bad) { for (const d of consulted) rests.add(d); return done(true); }
      // What this entry rests on includes everything the proof below it rested on. A proof kept is named ("v"); one that was not kept
      // (no room, a walk that did not finish cleanly) is carried here by what it consulted; one that was kept and has since gone (room
      // made for another entry) cannot be carried, so nothing above it is kept either (the entry would lose its ancestors' keys).
      if (previous) { if (kept.has(previous)) consulted.add(`v${SEP}${previous}`); else lost = true; }
      for (const d of carried) consulted.add(d);
      for (const d of rowsOf) consulted.add(d);
      rowsOf = new Set();
      const clean = !lost && consulted.size <= 4000 && cycles === cyclesBefore && cycleThrown === thrownBefore && unfinished === unfinishedBefore && untracked === untrackedBefore;
      if (clean && keepEntry(keyOf(node), { withheld: false, unproven: false, deps: consulted })) {
        if (readerKey) audienceHolds.get(readerKey)?.keys.add(keyOf(node));
        previous = keyOf(node); carried = new Set();
        rests.clear(); rests.add(`v${SEP}${previous}`);
        sliceProgressed = true;
      } else {
        if (!clean && unfinished === unfinishedBefore) noteUnkept("set");
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
    // the set's rows are what the verdict read: a change to them reaches it ("x"), nothing else does
    if (id) dep("x", id);
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
      if(copyOriginUnavailable(copy.threadId,original))return true;
      if(messageSourceForgotten(copy.threadId,original))return true;
      if(anyProducerBad(copy.threadId,[original],depth+1,asReader&&audience?group=>(audience.copyOriginRevoked??audience.revoked)(group.row):undefined))return true;
      if(rootsBad(copy.threadId,original,depth+1))return true;
      const further=messageCopy(copy.threadId,original);
      if(further&&originBad(further,hops+1,depth,asReader))return true;
    }
    return false;
  };
  return { settle, verdicts, producers, listingAny, session, sessionProven, groupBad, originBad, rootsBad, badSets, chunkBad };
}

/** The ids among `messages` a reader may no longer be shown. `audience` null:
 * content checks only (a room's owner-audience turn, recall). failClosed: a
 * message whose check runs past its budget is withheld instead of throwing.
 *
 * Only the receipts that list one of `messages` as an output are read (the
 * output index), however many receipts the thread holds, grouped by what a
 * verdict rests on; each distinct cited list, record and reply is judged
 * once per call (0.1.61.1 memreplay). */
/** `checking`: filled with the excluded ids that were left out only because the allowance (or a check's budget) ran out, not because
 * anything they used was withdrawn or forgotten: what the owner is told is that earlier context is still being checked. */
export interface ReplayOptions { invalidBundles?: Set<string>; failClosed?: boolean; checking?: Set<string> }
function replayExclusionsWork(allowance: LineageAllowance, threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: ReplayOptions = {}): Set<string> {
  // one synchronous pass: the stamp and the dirty list are not asked for again by each of the check's thousands of verdicts (see verdictCache)
  return heldStep("memory.replay-exclusions", () => withStatementReuse(() => {
    const retired = readTimeRetired(database());
    const excluded = retired ? retiredExclusions(threadId, messages, audience, options) : replayExclusionsUnheld(allowance, threadId, messages, audience, options);
    // What the owner forgot is not replayed whoever wrote it (owner lines too), nor a later reply that may repeat it (1.0.2
    // revoke-bounded r3). Bounded reads outside the kept verdicts (the stricter reader layer the write-time slices replace).
    for (const id of forgottenMessageSources(threadId, messages.filter(message => !excluded.has(message.id)).map(message => message.id))) { excluded.add(id); options.checking?.delete(id); }
    // (retired: the positional rule is deny_range, written at the forget's commit)
    if (!retired) for (const id of positionalWithheld(threadId, messages.filter(message => !excluded.has(message.id)).map(message => message.id))) excluded.add(id);
    return excluded;
  }));
}
/** The generated lines of `messages` the write-time lookup (deny-read.ts) does not show a content reader, a line that reads "checking" also
 * added to `checking`. One page lookup: a fixed number of seeks per page, whatever the history. */
function writetimeContentWithheld(db: DatabaseLike, threadId: string, messages: readonly ReplayMessage[], checking?: Set<string>): Set<string> {
  const out = new Set<string>();
  // (the copy-origin probe is not a stored line: only the original it points at is judged, below)
  messages = messages.filter(message => message.id !== COPY_ORIGIN_PROBE);
  if (!messages.length) return out;
  const verdicts = denyLookup(db, { threadId, lines: messages.map(message => ({ messageId: message.id, author: message.role === "user" ? "owner" as const : "generated" as const })) }, { audience: null });
  for (const message of messages) {
    const verdict = verdicts.get(message.id);
    if (verdict?.state === "shown") continue;
    out.add(message.id);
    if (!verdict || verdict.state === "checking") checking?.add(message.id);
  }
  return out;
}
/** replayExclusions once the read-time judge is retired (S6): no receipt group, root set or kept verdict is read. The integrity gate still
 * holds every reply; a content reader (audience null) is answered by the write-time lookup, copies included (a copy is withheld with its
 * original); an audience reader is answered by the caller's own write-time layer (disclosures.ts writetimeReplayWithheld, which knows the
 * reader's scopes). */
function retiredExclusions(threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: ReplayOptions): Set<string> {
  if (!messages.length) return new Set();
  const db = database();
  const generated = messages.filter(message => message.role !== "user");
  if (generated.length && integrityUntrusted(db)) return new Set(generated.map(message => message.id));
  if (audience !== null) return new Set();
  const excluded = writetimeContentWithheld(db, threadId, messages, options.checking);
  // a copy is withheld with its original (its own line carries the original too; this covers a copy not yet written, the egress probe)
  for (const message of messages) {
    if (!message.copyOf || excluded.has(message.id)) continue;
    const origin = message.copyOf;
    const roles = new Map(stmt(db, "SELECT id,role FROM messages WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))").all(origin.threadId, JSON.stringify(origin.messageIds)).map(row => [String(row.id), String(row.role)]));
    const verdicts = denyLookup(db, { threadId: origin.threadId, lines: origin.messageIds.map(id => ({ messageId: id, author: roles.get(id) === "user" ? "owner" as const : "generated" as const })) }, { audience: null });
    let bad = origin.messageIds.length > COPY_ORIGINS;
    for (const id of origin.messageIds) { const verdict = verdicts.get(id); if (!verdict || verdict.state !== "shown") { bad = true; if (!verdict || verdict.state === "checking") options.checking?.add(message.id); } }
    if (bad) excluded.add(message.id);
  }
  return excluded;
}
function replayExclusionsUnheld(allowance: LineageAllowance, threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: ReplayOptions = {}): Set<string> {
  if (!messages.length) return new Set();
  const judge = lineageJudge(allowance, threadId, audience, options.invalidBundles);
  try { return replayExclusionsWith(judge, threadId, messages, audience, options); }
  finally { judge.settle(); }
}
function replayExclusionsWith(judge: ReturnType<typeof lineageJudge>, threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: ReplayOptions): Set<string> {
  // No cap on how many lines are asked about: a line no receipt lists costs
  // one index probe. The 0.1.61 cap (10,000 lines) failed every turn of a
  // conversation a routine keeps posting into (0.1.61.1 memreplay).
  if (!messages.length) return new Set();
  const { failClosed = false } = options;
  const excluded = new Set<string>();
  const checking = options.checking ?? new Set<string>();
  // The owner's or a person's own words are never linked to a receipt.
  const generated = [...new Set(messages.filter(message=>message.role!=="user").map(message=>message.id))];
  // Until the integrity pass has passed (or after it held), the output index and the receipts are not proven: nothing is read from them, and every
  // reply is withheld for every thread. This is checked before, and independently of, the producer lookup below, which would read an empty index as "no receipts".
  if (generated.length && integrityUntrusted(database())) return new Set(generated);
  if (generated.length) {
    /** Receipts found bad, or not judged before the budget ran out. */
    const unsettled: string[] = [];
    /** Receipts not judged before the allowance ran out: not bad, only unproven for now. */
    const cut: string[] = [];
    let groups: ReceiptGroup[] = [], exact = true;
    // A group of the whole thread (past PAIR_LIMIT) counts only for the lines
    // it lists: the mapping below reads that from the index.
    try { ({ groups, exact } = judge.producers(threadId, generated)); }
    catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for(const id of generated){excluded.add(id); if(isLineageLimit(error))checking.add(id);} }
    for (let index = 0; index < groups.length; index++) {
      try { if (judge.groupBad(groups[index])) for (const id of groups[index].bundles) unsettled.push(id); }
      catch (outcome) {
        let error = outcome;
        if(error instanceof LineageControl)throw error;
        // On content, cited replies are judged by their own verdicts: judged as a whole thread, a group listing none of
        // these lines may lead back to one of them (its verdict is being worked out right now), and then its verdict
        // does not matter here (anyProducerBad, same rule). The probe that tells is a read like any other and can run out of its
        // budget: then the group is not shown to be unrelated, and the lines are withheld (1.0.2 lineage-cold: it used to escape
        // failClosed from here).
        if(audience===null&&!exact&&error instanceof Error&&error.message==="MEMORY_REPLAY_LINEAGE_CYCLE"){
          try { if(!judge.listingAny(threadId,groups[index].bundles.toArray(),generated).length)continue; }
          catch (probe) { if(!failClosed||probe instanceof LineageControl)throw probe; error = probe; }
        }
        if(!failClosed)throw error;
        noteWithheldOnError(error);
        // Past the budget: what is not proven sound is not shown.
        const into = isLineageLimit(error) ? cut : unsettled;
        for (const group of groups.slice(index)) for (const id of group.bundles) if (judge.verdicts.get(id) !== false) into.push(id);
        break;
      }
    }
    if (unsettled.length || cut.length) {
      const pending = generated.filter(id => !excluded.has(id));
      // every receipt of a thread judged as a whole is bad: any line a receipt lists is withheld
      const wholeThread = !cut.length && !exact && unsettled.length === groups.reduce((total, group) => total + group.bundles.length, 0);
      if (unsettled.length) {
        try { for (const id of judge.listingAny(threadId, unsettled, pending, false, wholeThread)) excluded.add(id); }
        catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for (const id of pending) { excluded.add(id); if (isLineageLimit(error)) checking.add(id); } }
      }
      // lines only the unjudged receipts list are left out for now (a line a bad receipt lists was settled above, and stays withdrawn)
      const unjudged = pending.filter(id => !excluded.has(id));
      if (cut.length && unjudged.length) {
        try { for (const id of judge.listingAny(threadId, cut, unjudged, false, false)) { excluded.add(id); checking.add(id); } }
        catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for (const id of unjudged) { excluded.add(id); checking.add(id); } }
      }
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
    } catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); for (const id of rooted) if (messageMadeWithMemory(threadId, id)) { excluded.add(id); if (isLineageLimit(error)) checking.add(id); } }
  }
  // A copy is withheld with its original.
  for(const message of messages){
    if(!message.copyOf||excluded.has(message.id))continue;
    // a copy whose originals are bad only because a check could not finish (a set whose proof is still being built: deferSet) is an unknown,
    // not a mark (REPLY-WITHHELD-CONTRACT R1): the walk stops at its first bad answer, so a check left unfinished during it is what made it bad.
    // A cycle met on the way stays withheld (R1, S26)
    const before = unfinished, cyclesBefore = cycles, thrownBefore = cycleThrown;
    try { if(judge.originBad(message.copyOf,1,0,true)){ excluded.add(message.id); if (unfinished !== before && cycles === cyclesBefore && cycleThrown === thrownBefore) checking.add(message.id); } }
    catch (error) { if(!failClosed||error instanceof LineageControl)throw error; noteWithheldOnError(error); excluded.add(message.id); if (isLineageLimit(error)) checking.add(message.id); }
  }
  // a line withdrawn by anything that was proven stays withdrawn: only a line left out for lack of room alone is `checking`
  return excluded;
}

/** A resumed native session rests on everything it was ever shown: true
 * when any receipt of the session no longer holds, lineage included, or
 * when the check cannot finish (review M1: the replay window no longer
 * reaches an old session's receipts, so the continuation check must). The
 * bad receipts are added to `invalidBundles`. */
function sessionLineageBadWork(allowance: LineageAllowance, threadId: string, driverInstance: string, nativeSession: string, audience: ReplayAudience | null, invalidBundles?: Set<string>): boolean {
  // retired (S6): a session is judged by sessionLookup (deny_session, its pending window, its receipts), asked by dispatch.ts and disclosures.ts
  if (readTimeRetired(database())) return false;
  let judge: ReturnType<typeof lineageJudge> | undefined;
  try {
    judge = lineageJudge(allowance, threadId, audience, invalidBundles);
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
 * verdict drops every verdict resting on it, transitively. A verdict evicted for room keeps its place in this graph (only its
 * answer goes), so a change it rested on still reaches what rests on it: eviction never cuts a kept proof loose and never
 * takes a proof with it. */
const dependents = new Map<string,Set<string>>();
/** Verdicts kept at most; past it the oldest eighth goes (what rests on it stays, still reached through the graph), never the
 * whole cache. A session's root set alone reaches tens of thousands of messages (ROOT_SET_CEILING). */
const VERDICT_LIMIT = 65536;
let verdictLimit = VERDICT_LIMIT;
/** Tests lower the capacity to reach eviction; null is the real one. */
export function setVerdictLimitForTest(limit: number | null): void { verdictLimit = limit ?? VERDICT_LIMIT; }
/** Drops every kept verdict and root-set handle, so the next check is a fresh one (tests: the cold side of warm-versus-cold). */
export function forgetKeptLineageForTest(): void { forgetVerdicts(); proving.clear(); }
/** Kept verdicts, for tests. */
export function keptVerdictCount(): number { return verdicts.size; }
/** Keeps a verdict, or refuses to: one that rests on another kept verdict ("v") is kept only while that verdict is still
 * there once room has been made, since a verdict dropped for room takes its dependents with it only if they are already
 * registered. Refused, the verdict serves the call that reached it, and so does whatever rests on it (the caller lists what it
 * consulted instead of its key). Returns whether it was kept. */
function remember(key: string, entry: Verdict): boolean {
  if (keepRefused()) return false;
  if (verdicts.size >= verdictLimit && !verdicts.has(key)) {
    // The oldest eighth goes, never a proof of a large set (S, Q): a cold turn of a long conversation keeps about one verdict per root, and evicting the
    // proof the scheduler is building would start it again from nothing on every turn (r8 Fable #2). Only a cache that holds nothing else gives a proof up.
    const oldest: string[] = [], proofs: string[] = [];
    for (const kept of verdicts.keys()) {
      if (isProofKey(kept)) { if (proofs.length < verdictLimit / 8) proofs.push(kept); continue; }
      oldest.push(kept); if (oldest.length >= verdictLimit / 8) break;
    }
    for (const kept of oldest.length ? oldest : proofs) verdicts.delete(kept);
  }
  // dependency lists of verdicts long gone are cleared only when their key moves: bound them, keeping every edge a kept verdict still needs (so the
  // proofs survive), and only past that start over
  if (dependents.size > verdictLimit * 8) {
    collectDependents();
    if (dependents.size > verdictLimit * 8) {
      // what is kept needs more edges than the bound: the older half of what is not a proof goes and the edges are collected again; only when the
      // proofs alone need more does everything go
      let left = Math.floor(verdicts.size / 2);
      for (const kept of [...verdicts.keys()]) { if (left <= 0) break; if (!isProofKey(kept)) { verdicts.delete(kept); left--; } }
      collectDependents();
      if (dependents.size > verdictLimit * 8) forgetVerdicts();
    }
  }
  for (const d of entry.deps) if (d.startsWith(`v${SEP}`) && !verdicts.has(d.slice(2))) return false;
  // a key kept again moves to the newest end, so what is in use is the last to go for room
  verdicts.delete(key);
  verdicts.set(key, entry);
  progressTick++;
  for (const d of entry.deps) { let held = dependents.get(d); if (!held) dependents.set(d, held = new Set()); held.add(key); }
  return true;
}
/** Drops the dependency edges no kept verdict needs any more: an edge to a verdict still kept, or to one evicted that a kept verdict rests on (through
 * "v" edges, transitively), stays; the rest go. One pass over the edges, run only when the graph has outgrown its bound. */
function collectDependents(): void {
  const restsOn = new Map<string, string[]>();
  for (const [d, held] of dependents) {
    if (!d.startsWith(`v${SEP}`)) continue;
    const below = d.slice(2);
    for (const key of held) { let list = restsOn.get(key); if (!list) restsOn.set(key, list = []); list.push(below); }
  }
  const needed = new Set<string>(verdicts.keys()), queue = [...needed];
  while (queue.length) for (const below of restsOn.get(queue.pop()!) ?? []) if (!needed.has(below)) { needed.add(below); queue.push(below); }
  for (const [d, held] of dependents) {
    for (const key of held) if (!needed.has(key)) held.delete(key);
    if (!held.size) dependents.delete(d);
  }
}
/** A proof of a large set, whole (S) or in progress (Q), for content or for one reader. */
const isProofKey = (key: string): boolean => key.startsWith(`S${SEP}`) || key.startsWith(`Q${SEP}`);
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
  verdicts.clear(); dependents.clear(); sessionSound.clear(); audienceHolds.clear(); threadGroupStore.clear();
  if (withHandles) { forgetRootSetHandles(sharedHandles); handleStamp = ""; }
}
function dropDependents(keys: Iterable<string>): void {
  const queue = [...keys];
  while (queue.length) {
    const d = queue.pop()!, held = dependents.get(d);
    if (!held) continue;
    dependents.delete(d);
    // an evicted verdict passes the change on as a kept one does (its edges outlive its answer)
    for (const key of held) { verdicts.delete(key); queue.push(`v${SEP}${key}`); }
  }
}
/** Every receipt group of a thread, kept across checks for the content reader (threadGroups): the read is one statement over all
 * the thread's receipts (350 ms at 16k), and a turn adds a receipt or two. Valid while the thread's receipts are the ones it was read
 * from: nothing newer in the table, or only receipts added since (read and merged: a bounded look at the table's newest rows, never at the
 * thread's own history). A change to a receipt's cited lists, its place in a session or its id, a removal or another connection's commit
 * drops it (`d` dirty keys, forgetVerdicts). `top` is the table's newest rowid when the groups were last known to be current. */
const threadGroupStore = new Map<string, { count: number; top: number; groups: ReceiptGroup[]; at: Map<string, number> }>();
const THREAD_GROUP_STORE_MAX = 64;
/** The most receipts written to the table since a kept read that are looked at to bring it up to date: more, and it is read afresh. */
const THREAD_GROUP_MERGE_MAX = 256;
function parseGroups(rows: Disclosure[]): ReceiptGroup[] { return rows.map(row => ({ row, bundles: new BundleList(JSON.parse(String(row.bundles)) as string[]) })); }
const groupShape = (row: Disclosure): string => JSON.stringify([row.thread_id, row.state, row.policy_revision, row.deletion_epoch, row.record_versions, row.source_versions]);
function currentThreadGroups(db: DatabaseLike, thread: string): ReceiptGroup[] | undefined {
  const held = threadGroupStore.get(thread);
  if (!held) return undefined;
  try {
    const top = Number(stmt(db, "SELECT max(rowid) AS top FROM memory_disclosures").get()?.top ?? 0);
    if (top === held.top) return held.groups;
    if (top > held.top) {
      const recent = Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE rowid>? LIMIT ?)").get(held.top, THREAD_GROUP_MERGE_MAX + 1)?.n ?? 0);
      if (recent <= THREAD_GROUP_MERGE_MAX) {
        // NOT INDEXED: the rowid range is the cheap way to the newest rows (the thread index is ordered by session first)
        const fresh = parseGroups(stmt(db, `SELECT ${GROUP_COLUMNS} FROM memory_disclosures NOT INDEXED WHERE thread_id=? AND rowid>? ${GROUP_BY} LIMIT ?`).all(thread, held.top, THREAD_GROUP_MERGE_MAX + 1));
        // brought up to date in place: a receipt added to a group of any length is appended to it, and nothing already there is copied or serialised
        const merged = held.groups, at = held.at;
        let added = 0;
        for (const group of fresh) {
          added += group.bundles.length;
          const index = at.get(groupShape(group.row));
          if (index === undefined) { at.set(groupShape(group.row), merged.length); merged.push(group); continue; }
          const into = merged[index]!;
          groupIdsCopied += into.bundles.append(group.bundles);
          into.row.latest = Math.max(Number(into.row.latest), Number(group.row.latest));
        }
        held.count += added; held.top = top;
        return merged;
      }
    }
  } catch { /* read afresh */ }
  threadGroupStore.delete(thread);
  return undefined;
}
function rememberThreadGroups(db: DatabaseLike, thread: string, groups: ReceiptGroup[]): void {
  try {
    let receipts = 0;
    for (const group of groups) receipts += group.bundles.length;
    // only a read that covered every receipt of the thread is kept (the count reads no further than the rows just read)
    const held = Number(stmt(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, receipts + 1)?.n ?? -1);
    if (receipts !== held) return;
    if (threadGroupStore.size >= THREAD_GROUP_STORE_MAX) threadGroupStore.delete(threadGroupStore.keys().next().value!);
    const top = Number(stmt(db, "SELECT max(rowid) AS top FROM memory_disclosures").get()?.top ?? 0);
    threadGroupStore.set(thread, { count: receipts, top, groups, at: new Map(groups.map((group, index) => [groupShape(group.row), index])) });
  } catch { /* not kept */ }
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
const TOMBSTONE_NOTE = (row: "NEW" | "OLD") => `INSERT INTO lineage_dirty SELECT (CASE ${row}.target_type WHEN 'source' THEN 's' ELSE 'q' END)||char(31)||${row}.target_id;
 UPDATE lineage_epoch SET n=n+1 WHERE ${row}.target_type NOT IN ('source','record')`;
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
-- A tombstone reaches exactly the verdicts that read its target (1.0.2 lineage-cold r3: it used to flush the whole cache, and every turn after
-- an unrelated forget judged the whole history again): a source's "s" key, a record's "q" key (every version). An import tombstone, which no
-- verdict reads by key, still moves the counter.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_i AFTER INSERT ON main.memory_tombstones
 BEGIN ${TOMBSTONE_NOTE("NEW")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_u AFTER UPDATE ON main.memory_tombstones
 BEGIN ${TOMBSTONE_NOTE("OLD")}; ${TOMBSTONE_NOTE("NEW")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_tombstones_d AFTER DELETE ON main.memory_tombstones
 BEGIN ${TOMBSTONE_NOTE("OLD")}; END;
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
-- A stored set's rows changing (compaction, collection of sets nothing points at) reaches only the verdicts that read that set ("x" key:
-- every kept set verdict and every reply verdict that read a set holds it), never the whole cache (1.0.2 lineage-cold r3: compaction's deletes
-- flushed every verdict on the rig). The stored handles go with the structure counter, as before.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_sets_d AFTER DELETE ON main.memory_root_set_members BEGIN ${NOTE("'x'||char(31)||OLD.set_id")}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_set_rows_d AFTER DELETE ON main.memory_root_sets BEGIN ${NOTE("'x'||char(31)||OLD.set_id")}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_set_rows_u AFTER UPDATE ON main.memory_root_sets BEGIN ${NOTE("'x'||char(31)||OLD.set_id")}; ${NOTE("'x'||char(31)||NEW.set_id")}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_parents_d AFTER DELETE ON main.memory_root_set_parents BEGIN ${NOTE("'x'||char(31)||OLD.set_id")}; ${STRUCT}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_parents_u AFTER UPDATE ON main.memory_root_set_parents BEGIN ${NOTE("'x'||char(31)||OLD.set_id")}; ${NOTE("'x'||char(31)||NEW.set_id")}; ${STRUCT}; END;
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
-- the kept receipt groups of a thread (threadGroupStore): a receipt of it whose cited lists, thread or id changed, or one removed
CREATE TEMP TRIGGER IF NOT EXISTS lineage_receipts_g AFTER UPDATE ON main.memory_disclosures
 WHEN OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.thread_id IS NOT NEW.thread_id OR OLD.bundle_id IS NOT NEW.bundle_id
 BEGIN ${NOTE("'d'||char(31)||OLD.thread_id")}; ${NOTE("'d'||char(31)||NEW.thread_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_receipts_gd AFTER DELETE ON main.memory_disclosures BEGIN ${NOTE("'d'||char(31)||OLD.thread_id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_u AFTER UPDATE ON main.messages WHEN ${copyFieldsChanged("OLD.json", "NEW.json")}
 BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_d AFTER DELETE ON main.messages BEGIN ${BUMP}; END;
-- INSERT OR REPLACE (writeMessage) deletes and re-inserts without firing the UPDATE or DELETE triggers (recursive triggers are off): the
-- replaced row is looked at before it goes, the same condition as lineage_messages_u.
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_r BEFORE INSERT ON main.messages
 WHEN EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND ${copyFieldsChanged("o.json", "NEW.json")})
 BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.id")}; END;
`;
const epochReady = new WeakMap<object, boolean>();
function installEpoch(db: ReturnType<typeof database>): boolean {
  let ready = epochReady.get(db);
  if (ready === undefined) {
    try { db.exec(withoutDroppedTableTriggers(db, EPOCH_SCHEMA)); ready = true; }
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
    // a receipt of this thread was changed or removed: the kept groups of the thread are read afresh
    if (key.startsWith(`d${SEP}`)) { threadGroupStore.delete(key.slice(2)); continue; }
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
export function integrityUntrusted(db: DatabaseSync): boolean { return memoryGate(db, "replay") !== "ok"; }
export function ancestryWithheld(db: DatabaseSync, thread: string): boolean {
  // Until the integrity pass has proven the output index and the references (or after it found a source row that is not valid), no thread's replies are trusted.
  // This is decided first and without a look at the derived output index: an index that has not been proven can be empty for a thread whose receipts exist.
  if (integrityUntrusted(db)) return true;
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
/** Commits by another connection (1.0.2 lineage-cold r3). This connection's triggers do not see them, so a commit nothing accounted for moves
 * the generation, which drops the cache as before (fail closed). A commit made through foreignLineageWrite is accounted for: the writing
 * connection carries the same triggers, and the keys they noted are applied here, so only the verdicts that read what it changed go. */
const foreignSeen = new WeakMap<object, { version: number; generation: number }>();
function foreignGeneration(db: ReturnType<typeof database>, read?: unknown): number {
  // the caller's own statement usually read data_version already (one statement per stamp, as before)
  const version = Number(read ?? stmt(db, "SELECT data_version AS v FROM pragma_data_version").get()?.v ?? 0);
  const seen = foreignSeen.get(db);
  if (!seen) { foreignSeen.set(db, { version, generation: 0 }); return 0; }
  if (version !== seen.version) { seen.version = version; seen.generation++; }
  return seen.generation;
}
/** Runs `work`, which writes and commits through another connection of this process (a maintenance worker's own handle), so that its commit
 * reaches the kept verdicts by key, as one of this connection's own writes would. `writer` gets the lineage triggers; what they noted (and a
 * move of its counters) is applied to this connection's dirty list after `work`. A commit by any other connection, or one made while this
 * connection is inside a transaction, still drops the whole cache. */
export function foreignLineageWrite<T>(writer: DatabaseSync, work: () => T): T {
  const db = database();
  if (writer === db || db.isTransaction || !installEpoch(db) || !installEpoch(writer)) return work();
  const counters = () => stmt(writer, "SELECT (SELECT n FROM temp.lineage_epoch) AS epoch, (SELECT n FROM temp.lineage_structure) AS structure").get();
  writer.exec("DELETE FROM temp.lineage_dirty");
  const before = counters(), generation = foreignGeneration(db);
  const value = work();
  if (writer.isTransaction) return value;
  const after = counters();
  const keys = stmt(writer, "SELECT DISTINCT k FROM temp.lineage_dirty").all();
  writer.exec("DELETE FROM temp.lineage_dirty");
  // (unqualified: the temp table is found first, as in the trigger bodies)
  const insert = stmt(db, "INSERT INTO lineage_dirty VALUES(?)");
  for (const row of keys) insert.run(String(row.k));
  if (Number(after?.epoch) !== Number(before?.epoch)) db.exec(BUMP);
  if (Number(after?.structure) !== Number(before?.structure)) db.exec(STRUCT);
  // the commit just made is accounted for: unless another one came in between (the generation moved), this connection's view of it is absorbed
  const seen = foreignSeen.get(db);
  if (seen && seen.generation === generation) seen.version = Number(stmt(db, "SELECT data_version AS v FROM pragma_data_version").get()?.v ?? seen.version);
  return value;
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
    value = `e${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row?.epoch}:${foreignGeneration(db, row?.version)}`;
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
  if (verdictDb !== db) { verdictDb = db; forgetVerdicts(); chains.clear(); verdictStamp = ""; proving.clear(); }
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
  return `h${connectionId(db)}.${row?.structure}:${foreignGeneration(db, row?.version)}`;
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
  if (!row || `e${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row.epoch}:${foreignGeneration(db, row.version)}` !== verdictStamp) return undefined;
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
export function capturedMessageWithheld(allowance: LineageAllowance, threadId: string, messageId: string): boolean {
  return (!readTimeRetired(database()) && positionalWithheld(threadId, [messageId]).has(messageId)) || capturedMessageVerdicts(allowance, threadId, [messageId]).get(messageId)!.withheld;
}
/** The same answer with why: `unproven` when it is withheld only because the check could not finish (shown as "still being checked",
 * never as deleted or changed). */
export function capturedMessageVerdict(allowance: LineageAllowance, threadId: string, messageId: string): { withheld: boolean; unproven: boolean } {
  // a line written after one the owner forgot, by a turn begun before that forget (1.0.2 revoke-bounded r3): withheld, proven
  if (!readTimeRetired(database()) && positionalWithheld(threadId, [messageId]).has(messageId)) return { withheld: true, unproven: false };
  const verdict = capturedMessageVerdicts(allowance, threadId, [messageId]).get(messageId)!;
  return { withheld: verdict.withheld, unproven: verdict.withheld && verdict.unproven };
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
function capturedMessageVerdictsWork(allowance: LineageAllowance, threadId: string, messageIds: readonly string[]): Map<string, Verdict> {
  // retired (S6): the write-time lookup answers, for a content reader; "checking" is withheld and unproven (shown as "still being checked")
  if (readTimeRetired(database())) {
    const shown = writetimeContentWithheld(database(), threadId, messageIds.map(id => ({ id, role: "bot" })));
    const checking = new Set<string>();
    if (shown.size) for (const [id, verdict] of denyLookup(database(), { threadId, lines: [...shown].map(messageId => ({ messageId, author: "generated" as const })) }, { audience: null })) if (verdict.state === "checking") checking.add(id);
    return new Map(messageIds.map(id => [id, { withheld: shown.has(id), unproven: checking.has(id), deps: new Set<string>() }]));
  }
  if (nesting > 0) return judgeCapturedMessages(allowance, threadId, messageIds);
  const own = scratch === null;
  if (own) scratch = new Map();
  try {
    const work: Array<[string, readonly string[]]> = [[threadId, messageIds]];
    for (;;) {
      const [thread, messages] = work[work.length - 1]!;
      try {
        const verdicts = judgeCapturedMessages(allowance, thread, messages);
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
/** A background proof slice used its time (advanceRootSetProofs): the judgement unwinds to the slice, which resumes from what was kept. */
class LineageYield extends LineageControl { constructor() { super("MEMORY_LINEAGE_YIELD"); } }
let nesting = 0, cycles = 0, batches = 0, scratch: Map<string, Verdict> | null = null;
/** The verdicts being worked out right now, by the batch judging them: met again alone, the lineage is a cycle. */
const judging = new Map<string, { batch: number; size: number }>();
function judgeCapturedMessages(allowance: LineageAllowance, threadId: string, messageIds: readonly string[]): Map<string, Verdict> {
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
  // A turn whose allowance is spent walks no further: a reply with no kept verdict is unproven, which is withheld and never shown, and the
  // warmer takes its thread (a verdict is not made up here, and nothing of the history is read for it).
  if (allowance.spentOut()) {
    allowance.refuse(threadId);
    noteWithheldOnError(new Error("MEMORY_LINEAGE_WARMING"));
    for (const messageId of pending) out.set(messageId, { withheld: true, unproven: true, deps: new Set<string>() });
    return out;
  }
  // judged in chunks: what a chunk consulted is each of its verdicts' dependencies, so a chunk stays small enough to keep
  if (pending.length > JUDGE_CHUNK) {
    for (let at = 0; at < pending.length; at += JUDGE_CHUNK) for (const [id, verdict] of judgeCapturedMessages(allowance, threadId, pending.slice(at, at + JUDGE_CHUNK))) out.set(id, verdict);
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
  yieldIfLate();
  cacheMisses += pending.length;
  let excluded = new Set<string>(), failed = false, split = false;
  const outer = collected, cyclesBefore = cycles, unfinishedBefore = unfinished, limitsBefore = limitHits, boxedBefore = boxDeferred, batch = ++batches;
  collected = new Set<string>();
  const consulted = collected;
  nesting++; for (const key of keys) judging.set(key, { batch, size: keys.length });
  try {
    excluded = replayExclusions(allowance, threadId, pending.map(messageId => { dirtyMessage(threadId, messageId); const copy = messageCopy(threadId, messageId); return { id: messageId, ...(copy ? { copyOf: copy } : {}) }; }), null, { failClosed: true });
  } catch (error) {
    if (error instanceof LineageSplit && error.batch === batch) split = true;
    else if (error instanceof LineageControl) throw error;
    else { noteWithheldOnError(error); excluded = new Set(pending); failed = true; }
  }
  finally { collected = outer; nesting--; for (const key of keys) judging.delete(key); }
  if (split) {
    for (const messageId of pending) out.set(messageId, judgeCapturedMessages(allowance, threadId, [messageId]).get(messageId)!);
    return out;
  }
  const unproven = failed || unfinished !== unfinishedBefore;
  // A verdict that a cycle made withhold something depends on where the walk began: it serves this call only, never the
  // shared cache. (A cycle through a group that lists none of the lines judged is passed over, and changes nothing.)
  // (a budget that ran out inside may have cut a verdict short: none of this batch's is kept; the sub-proofs it finished are)
  // nor one a background slice deferred for its time box alone: a turn would have judged that set itself
  const kept = cache !== undefined && consulted.size <= 4000 && cycles === cyclesBefore && limitHits === limitsBefore && boxDeferred === boxedBefore;
  pending.forEach((messageId, index) => {
    const withheld = excluded.has(messageId), entry: Verdict = { withheld, unproven: withheld && unproven, deps: consulted };
    // (a check that ran out of room is not an unkeepable one: the warmer gives it more room, or goes on from what it kept)
    if (!kept && limitHits === limitsBefore && boxDeferred === boxedBefore) noteUnkept(`reply ${cache === undefined ? "no cache" : consulted.size > 4000 ? `basis ${consulted.size}` : "cycle"}`);
    const stored = kept && keepVerdict(keys[index]!, entry);
    scratch?.set(keys[index]!, entry);
    if (outer) { if (stored) outer.add(`v${SEP}${keys[index]}`); else for (const d of consulted) outer.add(d); }
    out.set(messageId, entry);
  });
  sliceProgressed = true;
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
function derivationAncestryCurrentWork(allowance: LineageAllowance, db: DatabaseLike, id: string, version: number, selfSupersedes?: unknown, historical = false): boolean {
  // paid for before it is read (1.0.2 lineage-cold r3): a first page of DERIVATION_PAGE edges (most records have none or a few), and the
  // rest of the bounded walk only when the first page was full; each edge reads its parent and child rows too
  const walk = (limit: number) => stmt(db, `WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
      SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
      UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
      JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
      LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
      WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT ?)
    SELECT e.parent_id,e.parent_version,e.child_id,p.state,c.supersedes_id,c.assertion,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=e.parent_id AND (t.revision IS NULL OR t.revision=e.parent_version)) AS tombstoned,
      (${DENIED_RECORD_SCOPE("p")} OR EXISTS(SELECT 1 FROM memory_evidence pe JOIN memory_sources ps ON ps.id=pe.source_id WHERE pe.record_id=e.parent_id AND pe.record_version=e.parent_version
        AND (ps.state='deleted' OR EXISTS(SELECT 1 FROM memory_tombstones pt WHERE pt.target_type='source' AND pt.target_id=ps.id AND (pt.revision IS NULL OR pt.revision=pe.source_revision)) OR ${DENIED_SOURCE("ps")}))) AS forgotten
    FROM edges e LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
    LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(id,version,limit);
  // a walk the allowance cannot cover is not made: the record does not stand for now (checks it cannot finish withhold it); a walk made
  // pays for the edges it read
  const read = (limit: number): ReturnType<typeof walk> | null => {
    try { allowance.reserveRows("", limit * DERIVATION_EDGE_ROWS); } catch (error) { if (isLineageLimit(error)) return null; throw error; }
    const found = walk(limit);
    allowance.spendRows("", Math.max(1, found.length) * DERIVATION_EDGE_ROWS);
    return found;
  };
  let edges = read(DERIVATION_PAGE + 1);
  if (edges && edges.length > DERIVATION_PAGE) edges = read(257);
  if (!edges) return false;
  if (!edges.length) return true;
  if (edges.length > 256) return false;
  const replacing = new Set(edges.map(edge => String(edge.supersedes_id ?? "")));
  if (typeof selfSupersedes === "string" && selfSupersedes) replacing.add(selfSupersedes);
  for (const edge of edges) {
    // the first edge of an owner correction is history (see the walk above)
    if (edge.assertion === "owner-statement" && edge.supersedes_id === edge.parent_id) continue;
    // a parent forgotten by what it rests on (a forgotten or deleted source, a deleted conversation or bot) takes its copies with it
    // from the forget's commit, before the job marks the parent deleted (1.0.2 revoke-bounded r3)
    if (edge.tombstoned || edge.forgotten) return false;
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

/** Edges of a derivation walk read on its first page, and the rows each edge reads (the edge, its parent, its child, a tombstone). */
const DERIVATION_PAGE = 4, DERIVATION_EDGE_ROWS = 4;
/** A captured source that carries a generated message withheld on content
 * (what its reply used was forgotten, deleted, changed or archived). The
 * owner's and a person's own words are never withheld this way. */
export function capturedSourceWithheld(allowance: LineageAllowance, source: {thread_id?: unknown; message_id?: unknown; speaker?: unknown}): boolean {
  if (typeof source.thread_id !== "string" || typeof source.message_id !== "string" || !generatedSpeaker(source.speaker)) return false;
  return capturedMessageWithheld(allowance, source.thread_id, source.message_id);
}

/** A record whose evidence includes a withheld generated message: recall,
 * memory search and the thread checkpoint leave it out, so a withheld reply
 * does not come back as a remembered line. `alsoWithheld` adds a reader's
 * own transcript rule (a room turn that is not the owner's). */
function recordRestsOnWithheldMessageWork(allowance: LineageAllowance, recordId: string, version: number, alsoWithheld?: (threadId: string, messageId: string, allowance: LineageAllowance) => boolean): boolean {
  // The record and every record it was derived from (an approved projection
  // carries no evidence of its own): a line resting on a withheld reply
  // anywhere up that chain rests on it.
  // An owner's correction (a new version in the owner's own words that
  // supersedes the old one) does not carry the old words: that history edge
  // is not a dependency (0.1.61 third fix round, Astra P1 #3).
  const db = database();
  // retired (S6): the record's own write-time mark first (the marker walks evidence and derivations from a denied line); a record it does not
  // show is withheld whatever its chain holds. The chain walk below then still answers a reader's own transcript rule (`alsoWithheld`).
  if (readTimeRetired(db) && memoryLookup(db, [{ kind: "record", id: recordId, version }], { audience: null }).get(memoryRefKey({ kind: "record", id: recordId, version }))?.state !== "shown") return true;
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
    // paid for before each read (1.0.2 lineage-cold r3): the chain is at most 66 records, its evidence at most 257 rows, a first page of 17
    // and the rest only when the first was full
    // a read the allowance cannot cover is not made: the record counts as resting on a withheld reply for now; a read made pays for its rows
    const reserve = (count: number): boolean => { try { allowance.reserveRows("", count); return true; } catch (error) { if (isLineageLimit(error)) return false; throw error; } };
    if (!reserve(66 * 2)) return true;
    const length = Number(stmt(db, `${chain} SELECT count(*) AS n FROM chain`).get(recordId, version)?.n ?? 0);
    allowance.spendRows("", Math.max(1, length) * 2);
    if (length > 64) rows = "long";
    else {
      const read = (limit: number) => stmt(db, `${chain} SELECT DISTINCT s.thread_id,s.message_id,s.speaker FROM chain c JOIN memory_evidence e ON e.record_id=c.id AND e.record_version=c.version
        JOIN memory_sources s ON s.id=e.source_id WHERE s.thread_id IS NOT NULL AND s.message_id IS NOT NULL LIMIT ?`).all(recordId, version, limit);
      if (!reserve(257 * 2)) return true;
      const found = read(257);
      allowance.spendRows("", Math.max(1, found.length) * 2);
      rows = found.length > 256 ? "many" : found.map(row => ({ thread: String(row.thread_id), message: String(row.message_id), generated: generatedSpeaker(row.speaker) }));
    }
    if (stamp !== undefined && lineageStamp() === stamp) chains.set(chainKey, rows);
  }
  if (rows === "long" || rows === "many") return true;
  return rows.some(row => row.generated && (capturedMessageWithheld(allowance, row.thread, row.message) || Boolean(alsoWithheld?.(row.thread, row.message, allowance))));
}

/** A reply made under a memory receipt, built on one (its output roots),
 * or a copy of one: what a reader whose words were not proven may not be quoted. */
export function messageMadeWithMemory(threadId: string, messageId: string): boolean;
/** SL-E r3 E3b (lanes/release104/designs/SL-E.md section 10, W1-W8): the same question for a proven person reader whose scopes are `scopeIds`
 * (S(P)): "withheld" when the line rests on memory the person may not read, "checking" when whose memory it rests on cannot be proven, "shown"
 * when it rests on none or only on the person's own. Only the result gate passes `scopeIds`, and only from a person proof. */
export function messageMadeWithMemory(threadId: string, messageId: string, scopeIds: readonly string[]): "shown" | "withheld" | "checking";
export function messageMadeWithMemory(threadId: string, messageId: string, scopeIds?: readonly string[]): boolean | "shown" | "withheld" | "checking" {
  if (scopeIds !== undefined) return personMemoryVerdict(threadId, messageId, scopeIds);
  const db = database();
  if (ancestryWithheld(db, threadId) || Boolean(messageCopy(threadId, messageId)) || Boolean(stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId))) return true;
  // retired (S6): the line's own lineage row says it (a receipt or memory in its ancestry); a generated line with no row is unknown, so made with memory
  if (readTimeRetired(db)) {
    const row = stmt(db, "SELECT l.mem_lsn AS mem,l.footprint AS foot FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?").get(threadId, messageId);
    return !row || row.mem !== null || row.foot !== null;
  }
  return Boolean(stmt(db, "SELECT 1 FROM memory_output_roots WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId));
}
function personMemoryVerdict(threadId: string, messageId: string, scopeIds: readonly string[]): "shown" | "withheld" | "checking" {
  try {
    const db = database();
    // W1 partition ancestry, W2 a copy (its originals are on the walk): withheld, as today
    if (ancestryWithheld(db, threadId) || Boolean(messageCopy(threadId, messageId))) return "withheld";
    // W3 the read-time judge still decides on this file (lineage not live): today's blind rule
    if (!readTimeRetired(db)) return "withheld";
    const row = stmt(db, "SELECT l.lsn AS lsn,l.mem_lsn AS mem,l.footprint AS foot,l.thread_no AS no FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?").get(threadId, messageId);
    // W4 no lineage row: unknown
    if (!row) return "checking";
    if (row.mem === null && row.foot === null) {
      // W5 an output record whose lineage says nothing: unknown whose memory; no output record: not made with memory
      const output = Boolean(stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId))
        || Boolean(stmt(db, "SELECT 1 FROM memory_receipt_lines WHERE thread_no=? AND first_lsn<=? LIMIT 1").get(Number(row.no), Number(row.lsn)));
      return output ? "checking" : "shown";
    }
    // W6 (r3.2 R2) a footprint too wide to name: unknown. mem_lsn set with no footprint is a receipt that disclosed no scope (both writers
    // store an empty fold as NULL; every unknown is FOOTPRINT_STAR or no row): not made with memory at this reader. A stale receipt is
    // withheld by the watermark at the write-time lookup (W9), which judges mem_lsn.
    if (row.foot === null) return "shown";
    if (Number(row.foot) === FOOTPRINT_STAR) return "checking";
    // W8 every scope of the footprint must be the person's own
    const members = stmt(db, "SELECT scope_id FROM memory_scope_sets WHERE set_id=? LIMIT 33").all(Number(row.foot)).map(member => String(member.scope_id));
    if (!members.length || members.length > 32) return "checking";
    const own = new Set(scopeIds);
    return members.every(scope => own.has(scope)) ? "shown" : "withheld";
  } catch { return "checking"; }
}
/** Whether the thread holds a reply that rests on memory by its lineage row (room-transcript.ts: a thread with none is read as it is). */
export function threadHoldsMemoryLines(threadId: string): boolean {
  const db = database();
  if (!readTimeRetired(db)) return Boolean(stmt(db, "SELECT 1 FROM memory_output_roots WHERE thread_id=? LIMIT 1").get(threadId));
  return Boolean(stmt(db, "SELECT 1 FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.turn_lsn IS NOT NULL AND (l.mem_lsn IS NOT NULL OR l.footprint IS NOT NULL) LIMIT 1").get(threadId));
}

/** A set of output roots: keys `thread\u0000message`; `over` when it passed
 * the ceiling (or a context could not be proven). `roots` is a stored set plus
 * what is added to it (root-set-handles.ts), so a long session's set is never
 * copied: its cost follows what a turn adds. */
export interface OutputRoots {
  roots: RootView; over: boolean;
  /** The session's set was forgotten (memory-revocation.ts): withheld, whatever the set holds. */
  forgotten?: boolean;
  /** With `over`: the set could not be read within the turn's allowance (not past the ceiling): withheld for now, and the warmer reads it. */
  unproven?: boolean;
}
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
function addSetMembers(into: OutputRoots & { roots: LayeredRoots }, setId: string, allowance: LineageAllowance, thread: string): void {
  const db = database();
  if (!setId) { into.over = true; return; }
  const size = stmt(db, "SELECT size FROM memory_root_sets WHERE set_id=?").get(setId);
  if (!size || Number(size.size) > rootCeiling()) { into.over = true; return; }
  const handle = storedHandle(handles(), setId, Number(size.size), allowance.meter(thread));
  if (!handle) { into.over = true; return; }
  into.roots.absorb(handle);
}
/** The handle of a stored set of the size its row says; a kept one of another size is not trusted and is read again. */
function storedHandle(cache: HandleCache, setId: string, size: number, meter?: ReadMeter): Handle | null {
  const db = database();
  let handle = handleFor(db, cache, setId, meter);
  if (handle && handle.end !== size) { cache.delete(setId); handle = handleFor(db, cache, setId, meter); }
  return handle && handle.end === size ? handle : null;
}
const layeredOutput = (): OutputRoots & { roots: LayeredRoots } => ({ roots: new LayeredRoots(), over: false });
/** The flat root set of what a turn's context carries (memory schema v6):
 * each carried reply made under a receipt is a root itself, and a reply that
 * has roots hands over its set (the union, never a link: depth stays 1). A
 * copy carries its originals'. Owner and person lines are never roots. */
function outputRootsForWork(allowance: LineageAllowance, lines: ReadonlyArray<{ threadId: string; id: string; role?: string; copyOf?: MessageCopy }>, home?: string): OutputRoots {
  const found = layeredOutput();
  const db = database();
  // retired (S6): a turn's parents are carries (lineage-write.ts), not root sets
  if (readTimeRetired(db)) return found;
  const listed = stmt(db, "SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1");
  const rooted = stmt(db, "SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?");
  const seenSets = new Set<string>(), seenLines = new Set<string>();
  const visit = (thread: string, message: string, copy: MessageCopy | undefined, hops: number) => {
    if (found.over || seenLines.has(rootKey(thread, message))) return;
    seenLines.add(rootKey(thread, message));
    if (listed.get(thread, message)) found.roots.add(rootKey(thread, message));
    const row = rooted.get(thread, message);
    if (row) { const id = String(row.set_id ?? ""); if (!seenSets.has(id)) { seenSets.add(id); addSetMembers(found, id, allowance, thread); } }
    const origin = copy ?? messageCopy(thread, message);
    if (origin) {
      if (hops >= COPY_HOPS || origin.messageIds.length > COPY_ORIGINS) { found.over = true; return; }
      for (const original of origin.messageIds) visit(origin.threadId, original, undefined, hops + 1);
    }
    if (found.roots.size > rootCeiling()) found.over = true;
  };
  // A line carried from another thread (working context) is a root itself, whoever wrote it and with or without a receipt: the
  // reply may repeat it, so forgetting it withholds the reply (1.0.2 r3). The turn's own thread needs none: positionalWithheld.
  try {
    for (const line of lines) {
      if (home !== undefined && line.threadId !== home) { found.roots.add(rootKey(line.threadId, line.id)); if (found.roots.size > rootCeiling()) found.over = true; }
      if (line.role !== "user") visit(line.threadId, line.id, line.copyOf, 0);
    }
  } catch (error) {
    // the allowance could not pay for a set's chain: what the turn was shown is unproven for now, not past the ceiling
    if (!isLineageLimit(error)) throw error;
    found.over = true; found.unproven = true;
  }
  return found;
}
/** The shown lines themselves as the roots of what a turn was shown, used when their stored sets could not be read within the
 * allowance. A line's verdict (capturedMessageVerdicts) already rests on everything the line rests on (its receipts, its own
 * output roots, the original of a copy), so a reply whose roots are these lines is withheld exactly when one of them is: the
 * same answer the flattened set gives, reached a level deeper. Nothing of the history is read here, and nothing is dropped. */
export function outputRootsShallow(lines: ReadonlyArray<{ threadId: string; id: string; role?: string }>, home?: string): OutputRoots {
  const found = layeredOutput();
  // (a line carried from another thread counts whoever wrote it: outputRootsFor)
  for (const line of lines) if (line.role !== "user" || (home !== undefined && line.threadId !== home)) found.roots.add(rootKey(line.threadId, line.id));
  if (found.roots.size > rootCeiling()) found.over = true;
  return found;
}
/** The union of two root sets (unproven when either is: withheld for now, never written as the permanent marker). */
export function mergeOutputRoots(a: OutputRoots, b: OutputRoots): OutputRoots {
  const roots = layeredOf(a.roots).union(layeredOf(b.roots));
  const unproven = Boolean(a.unproven || b.unproven);
  return { roots, over: a.over || b.over || roots.size > rootCeiling(), ...(unproven ? { unproven } : {}) };
}
/** The allowance of a writer that reads ONE stored root set whole (the set a row already points at, or a retained session's): a
 * stored set is never past the root ceiling, and reading it costs at most a member row and a link row per root, so this bounds the
 * read by the ceiling, never by the history. */
export function writerAllowance(reason: string): LineageAllowance {
  return LineageAllowance.writer(reason, Math.ceil((2 * rootCeiling()) / ROWS_PER_NODE) + 64);
}
/** The set a write stores: what the caller carries, with any set the row already points at. An incoming set already past the
 * ceiling (or unproven) is written as the marker without reading what the row holds. */
function unionWith(set: OutputRoots, held: unknown, writer: string): (OutputRoots & { roots: LayeredRoots }) | "" {
  if (set.over || set.roots.size > rootCeiling()) return "";
  const union: OutputRoots & { roots: LayeredRoots } = { roots: layeredOf(set.roots).clone(), over: set.over };
  if (held) {
    if (!String((held as { set_id?: unknown }).set_id ?? "")) return "";
    try { addSetMembers(union, String((held as { set_id?: unknown }).set_id), writerAllowance(writer), ""); }
    catch (error) { if (!isLineageLimit(error)) throw error; return ""; }
  }
  if (union.over || union.roots.size > rootCeiling()) return "";
  return union;
}
/** Points a reply at the root set of what it rests on (every mode, v6): the
 * union with any set it already has, stored once and reused when the same
 * union exists. Past the ceiling the unprovable marker is written instead,
 * which withholds the reply. */
export function recordOutputRoots(threadId: string, messageId: string, set: OutputRoots): void {
  // Write-time privacy (Murage 1.0.2, DESIGN-WRITETIME 1 and STORAGE-AUDIT 2): root sets are never written again. A reply's ancestry is its
  // memory_line_lineage row and its turn's carries (lineage-write.ts); this judge reads a reply with no row as resting on nothing it holds,
  // and the write-time lookup beside it (deny-read.ts) decides. S6 deletes this function.
  if (ROOT_SETS_FROZEN) return;
  if (!set.over && !set.roots.size) return;
  const db = database();
  const upsert = stmt(db, "INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?) ON CONFLICT(thread_id,message_id) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = stmt(db, "SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(threadId, messageId);
  const union = unionWith(set, held, "writer: recordOutputRoots");
  if (union === "") { if (held && !String(held.set_id ?? "")) return; upsert.run(threadId, messageId, ""); return; }
  atomically(db, () => upsert.run(threadId, messageId, storeLayered(db, handles(), union.roots)));
}
/** The roots a retained engine session was shown (v6). A session marked over,
 * or whose set is within the headroom of the ceiling, comes back `over`: it
 * resets before its next turn instead of withholding that turn's replies. */
/** memory-revocation.ts FORGOTTEN_SESSION_SET (kept as a literal: that module imports this one's dependents). */
const FORGOTTEN_SESSION_SET = "rs-forgotten";
function sessionOutputRootsWork(allowance: LineageAllowance, threadId: string, driverInstance: string, nativeSession: string): OutputRoots {
  const found = layeredOutput();
  if (readTimeRetired(database())) return found; // retired (S6): sessionLookup
  const row = stmt(database(), "SELECT s.set_id,r.size FROM memory_session_roots s LEFT JOIN memory_root_sets r ON r.set_id=s.set_id WHERE s.thread_id=? AND s.driver_instance=? AND s.native_session=?").get(threadId, driverInstance, nativeSession);
  if (!row) return found;
  // a forget ended a source of this thread while the session was retained (memory-revocation.ts endSourceWork): its roots are bad
  if (row.set_id === FORGOTTEN_SESSION_SET) { found.forgotten = true; return found; }
  if (row.size === null || row.size === undefined || Number(row.size) > sessionCeiling()) { found.over = true; return found; }
  // A CHECK of the session reads a cold chain within the allowance, page by page, and what it cannot read is unproven, not past the
  // ceiling: the session resets until the warmer has read the chain. A writer of the session's roots passes writerAllowance and reads it whole.
  try { addSetMembers(found, String(row.set_id), allowance, threadId); }
  catch (error) {
    if (!isLineageLimit(error)) throw error;
    found.over = true; found.unproven = true;
  }
  return found;
}
/** Whether a session has a v6 lineage row (every session v6 starts or resumes has one). */
export function sessionLineageKnown(threadId: string, driverInstance: string, nativeSession: string): boolean {
  const db = database();
  try { if (stmt(db, "SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession)) return true; }
  catch { /* the root sets were handed back */ }
  // a session 1.0.2 started or resumed has its write-time row (lineage-write.ts writeSessionLineage) instead of a root-set row
  try { return Boolean(stmt(db, "SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession)); }
  catch { return false; }
}
/** Root sets are frozen from v10 on: nothing writes memory_root_sets, _members, _parents, memory_output_roots or memory_session_roots rows
 * (STORAGE-AUDIT 2). Tests of the retired read-time machinery may thaw them on their own file. */
let ROOT_SETS_FROZEN = true;
export function thawRootSetWritesForTest(thawed: boolean): void { ROOT_SETS_FROZEN = !thawed; }
/** Adds what a turn's context carried to its engine session's set (v6). The
 * row is written even for an empty set: it marks the session as one v6 saw. */
export function recordSessionRoots(threadId: string, driverInstance: string, nativeSession: string, set: OutputRoots): void {
  // never written again (see recordOutputRoots): a session's lineage is memory_session_lineage (lineage-write.ts writeSessionLineage)
  if (ROOT_SETS_FROZEN) return;
  const db = database();
  const upsert = stmt(db, "INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = stmt(db, "SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession);
  const union = unionWith(set, held, "writer: recordSessionRoots");
  if (union === "") { if (held && !String(held.set_id ?? "")) return; upsert.run(threadId, driverInstance, nativeSession, ""); return; }
  atomically(db, () => upsert.run(threadId, driverInstance, nativeSession, storeLayered(db, handles(), union.roots)));
}
/** Whether any of these roots (`thread\u0000message` keys) is forgotten, deleted, withheld on content, or could not be
 * judged. Every key judged is a dependency of `collected`, when a caller collects. */
function flatRootsBad(allowance: LineageAllowance, keys: Iterable<string>): boolean {
  const byThread = new Map<string, string[]>();
  for (const key of keys) {
    memberWork++;
    const at = key.indexOf("\u0000"), thread = key.slice(0, at);
    let list = byThread.get(thread);
    if (!list) byThread.set(thread, list = []);
    list.push(key.slice(at + 1));
  }
  const db = database();
  for (const [thread, messages] of byThread) {
    // a deleted conversation, or a root written after a line the owner forgot (positionalWithheld)
    if (stmt(db, "SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(thread) || positionalWithheld(thread, messages).size) return true;
    // forgotten roots, read in batches rather than one query per root
    for (let at = 0; at < messages.length; at += ROOT_BATCH) {
      const batch = messages.slice(at, at + ROOT_BATCH);
      // the rows of the two lookups below are paid for from the turn before they are read
      allowance.spendRows(thread, batch.length * 2);
      if (collected) for (const message of batch) collected.add(`s${SEP}message:${thread}:${message}`);
      const ids = JSON.stringify(batch.map(message => `message:${thread}:${message}`));
      if (stmt(db, `SELECT 1 FROM memory_sources s WHERE s.id IN (SELECT value FROM json_each(?)) AND (s.state='deleted' OR ${DENIED_SOURCE("s")}) LIMIT 1`).get(ids)
        || stmt(db, "SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(ids)) return true;
    }
    // Each root's verdict is the one the replay keeps (judged in batches, kept across turns), so a session of
    // tens of thousands of roots judges only the roots not judged yet or touched since, not all of them every turn.
    for (const verdict of capturedMessageVerdicts(allowance, thread, messages).values()) if (verdict.withheld) return true;
  }
  return false;
}
/** The most dependencies one kept soundness proof may rest on. An ordinary proof rests on a few thousand; the proof of an ADMITTED full set (one the replay
 * accepts, so at most ROOT_SET_CEILING roots) may rest on a few per root, which is bounded by the ceiling and not by the history. */
const SOUND_DEPS_LIGHT = 4000;
const soundDepsMax = () => Math.max(SOUND_DEPS_LIGHT, rootCeiling() * 3);
/** Keeps a soundness proof. The proof of a set is keyed by the set's id (a stored set is immutable under its id) and held in this process only, under the
 * lineage stamp of the verdict cache: any change to a set row, a root or anything a root's receipt cites (a revised or retired source, a message source
 * among them) drops it, with everything resting on it. Nothing of it is kept in the file, so nothing proven before a restart is trusted after it. */
function keepSound(key: string, deps: Set<string>): boolean {
  return keepVerdict(key, { withheld: false, unproven: false, deps });
}
/** A set with more members than this is never walked by a turn. Its proof is built by the recovery scheduler, in slices of at most the scheduler's
 * budget (advanceRootSetProofs), and until it is complete in this process a retained session resting on the set counts as unproven: it resets and
 * replays what is allowed now ("checking"), and the replay withholds a reply resting on it (replaySetBad). A turn of a large set judges only what the
 * set added to the nearest proven set below it, at most TURN_JUDGE_MAX members; more than that and it does not walk. So what a turn pays for a set is
 * flat, whatever the set's size or the history's. */
export const LARGE_ROOT_SET = 20_000;
export const TURN_JUDGE_MAX = 4_000;
/** Roots one node of an allowance pays to judge cold, at the least (measured at 0.2 to 0.25 nodes a root). */
const COLD_ROOTS_PER_NODE = 4;
/** Who a proof is for: content (no reader), or one reader of one replay thread with the audience it is judged with (its kept verdicts are that
 * reader's, dropped with the reader's authority like every other verdict it keeps: audienceCache). */
interface ProofReader { key: string; thread: string; audience: ReplayAudience }
/** A large set waiting for its proof: how far the proof has got (`cursor` members, the last of them `after`, so the read resumes by key) and the kept
 * entry that says the members before the cursor are sound (`partial`). Each chunk's entry rests on what the chunk consulted and on the entry before it,
 * so a change to anything an earlier chunk consulted drops that chunk and every later one, and the proof starts again. `waits` counts the slices that
 * met another large set not proven yet (a member's own set): the proof waits for that one instead of calling its own set bad. */
interface Proving { id: string; reader: ProofReader | null; cursor: number; after: string | undefined; partial: string | null; waits: number }
const proving = new Map<string, Proving>();
/** The most sets waiting at once; past it the oldest request goes (a turn that needs it asks again). */
const PROVING_MAX = 64;
/** The most slices a proof waits on other proofs before it gives up (its set then counts as unproven, and a later turn asks again). */
const PROOF_WAITS_MAX = 64;
const provingKey = (id: string, reader: string) => reader ? `${reader}${SEP}${id}` : id;
const partialKey = (id: string, at: number, reader = "") => reader ? `Q${SEP}${reader}${SEP}${id}${SEP}${at}` : `Q${SEP}${id}${SEP}${at}`;
/** The kept proof of a whole set: the content proof (soundKey), or one reader's. */
const wholeProofKey = (id: string, reader = "") => reader ? `S${SEP}${reader}${SEP}${id}` : `S${SEP}${id}`;
/** The key a verdict collected while a set was unproven rests on: it goes when the set's proof completes, so that verdict is judged again. */
const awaitedKey = (key: string) => `q${SEP}${key}`;
function requestProof(id: string, reader: ProofReader | null = null): string {
  const key = provingKey(id, reader?.key ?? "");
  if (proving.has(key)) return key;
  if (proving.size >= PROVING_MAX) proving.delete(proving.keys().next().value!);
  proving.set(key, { id, reader, cursor: 0, after: undefined, partial: null, waits: 0 });
  return key;
}
/** Large sets waiting for their proof in this process, for tests and the scheduler's report. */
export function rootSetProofsPending(): number { return proving.size; }
// the owner is told while these wait or run ("Checking earlier memory"): the status reading asks the leaf for this count
setMemoryCheckingSource(() => proving.size);
/** Large sets a check met unproven and did not walk; of them, the ones deferred only because a background slice is time-boxed. */
let deferredLarge = 0, boxDeferred = 0;
/** Members walked by every judgement of a set, nested ones included (a member's own set): what a proof slice is charged, not just its own members. */
let memberWork = 0;
/** When a background proof slice must hand back (performance.now()), Infinity outside one; and whether the slice has already finished a unit of work
 * (a chunk kept, a batch of verdicts judged). A slice hands back only between units and only after one, so every slice makes progress. */
let sliceDeadline = Infinity, sliceProgressed = false, sliceWorkEnd = Infinity;
function yieldIfLate(): void { if (sliceProgressed && (memberWork > sliceWorkEnd || sliceDeadline !== Infinity && performance.now() > sliceDeadline)) throw new LineageYield(); }
/** Members judged as one kept entry: smaller inside a time-boxed slice, so the slice hands back close to its time. */
const soundChunk = () => sliceDeadline === Infinity ? SOUND_CHUNK : TIMED_CHUNK;
const TIMED_CHUNK = 32;
/** Builds the proofs of the large sets checks have asked for, oldest request first: at most `budget` members walked in one call, the members of sets
 * nested under the ones judged included, and no longer than `sliceMs` (handing back between chunks). The recovery scheduler's slice. A chunk is judged
 * exactly as a check judges members (the same verdicts), and is kept only while nothing it consulted has changed. */
export function advanceRootSetProofs(budget: number, sliceMs = Infinity): { members: number; pending: number } {
  if (readTimeRetired(database())) return { members: 0, pending: 0 }; // retired (S6): no set is read, none is proven
  const db = database();
  if (db.isTransaction || !proving.size) return { members: 0, pending: proving.size };
  if (verdictCache() === undefined) return { members: 0, pending: proving.size };
  let left = Math.max(0, budget), done = 0;
  // the slice stops starting new units at three quarters of its time, so the unit in hand (TIMED_CHUNK members) ends within it
  sliceDeadline = sliceMs === Infinity ? Infinity : performance.now() + sliceMs * 0.75; sliceProgressed = false; sliceWorkEnd = memberWork + Math.max(0, budget);
  try {
    for (const [key, state] of [...proving]) {
      if (left <= 0 || (sliceProgressed && performance.now() > sliceDeadline)) break;
      if (proving.get(key) !== state) continue;
      let step: { members: number; finished: boolean; waiting?: boolean };
      try { step = proveSlice(db, state, left); }
      catch (error) { noteWithheldOnError(error); step = { members: 0, finished: true }; }
      left -= step.members; done += step.members;
      if (step.finished) proving.delete(key);
      // waiting on a member's own set: that proof (asked for just now) goes first
      else if (step.waiting) { proving.delete(key); proving.set(key, state); }
    }
  } finally { sliceDeadline = Infinity; sliceProgressed = false; sliceWorkEnd = Infinity; }
  return { members: done, pending: proving.size };
}
function proveSlice(db: ReturnType<typeof database>, state: Proving, budget: number): { members: number; finished: boolean; waiting?: boolean } {
  const { id, reader } = state, readerKey = reader?.key ?? "";
  const kept = reader ? audienceCache(reader.key) : verdictCache();
  if (kept === undefined) return { members: 0, finished: false };
  const row = stmt(db, "SELECT size FROM memory_root_sets WHERE set_id=?").get(id);
  // a set that is gone, or past the ceiling, is never admitted: there is nothing to prove (the turn's own check says so)
  if (!row || Number(row.size) > rootCeiling()) return { members: 0, finished: true };
  const handle = storedHandle(handles(), id, Number(row.size));
  if (!handle) return { members: 0, finished: true };
  const whole = wholeProofKey(id, readerKey), awaited = awaitedKey(provingKey(id, readerKey));
  if (kept.has(whole)) { dropDependents([awaited]); return { members: 0, finished: true }; }
  const restart = () => { state.cursor = 0; state.after = undefined; state.partial = null; };
  // a chunk kept before and dropped since (something it consulted changed, or the whole cache went): the proof starts again
  if (state.partial !== null && !kept.has(state.partial)) restart();
  if (state.partial === null) {
    // the nearest set below this one that is already proven is where the proof begins (a turn's own additions were judged by the turn)
    for (let at = handle.parent; at; at = at.parent) {
      const proven = [wholeProofKey(at.id, readerKey), readerKey ? `R${SEP}${readerKey}${SEP}${at.id}` : `R${SEP}${at.id}`].find(key => kept.has(key));
      if (proven) { state.cursor = at.end; state.partial = proven; break; }
    }
  }
  const keys = handleKeys(handle, state.cursor, state.after);
  const work0 = memberWork, outer = collected;
  const worked = () => Math.max(memberWork - work0, 0);
  try {
    for (;;) {
      if (worked() >= budget) return { members: worked(), finished: false };
      if (sliceProgressed && performance.now() > sliceDeadline) return { members: worked(), finished: false };
      const chunk: string[] = [];
      const want = Math.max(1, Math.min(soundChunk(), budget - worked()));
      for (let next = keys.next(); !next.done; next = keys.next()) { chunk.push(next.value); if (chunk.length >= want) break; }
      // fewer members than the set row declares: unprovable (the turn's own check refuses it)
      if (!chunk.length) return { members: worked(), finished: true };
      const deps = new Set<string>();
      const before = { cycles, cycleThrown, unfinished, untracked, deferredLarge };
      let bad: boolean;
      collected = deps;
      // background slice of the recovery scheduler: paid from its own allowance (a few nodes per member), never a turn's
      const allowance = LineageAllowance.warm(chunk.length * 4 + 256);
      try {
        if (reader) {
          memberWork += chunk.length;
          const judge = lineageJudge(allowance, reader.thread, reader.audience);
          try { bad = judge.chunkBad(chunk, 0, deps); } finally { judge.settle(); }
        } else bad = flatRootsBad(allowance, chunk);
      } catch (error) {
        // the slice's time ran out inside the chunk: what was finished in it is kept by the checks that finished it; this chunk is judged again next time
        if (error instanceof LineageYield) return { members: worked(), finished: false };
        throw error;
      } finally { collected = outer; allowance.close(); }
      sliceProgressed = true;
      if (bad) {
        // a member resting on another large set not proven yet: wait for that proof (asked for by the check) rather than call this set bad
        if (deferredLarge !== before.deferredLarge && ++state.waits <= PROOF_WAITS_MAX) return { members: worked(), finished: false, waiting: true };
        // a set with a root that does not hold is not proven; a session resting on it resets on its next turn
        return { members: worked(), finished: true };
      }
      const end = state.cursor + chunk.length;
      if (state.partial !== null) deps.add(`v${SEP}${state.partial}`);
      const clean = cycles === before.cycles && cycleThrown === before.cycleThrown && unfinished === before.unfinished && untracked === before.untracked && deps.size <= soundDepsMax();
      const key = end >= handle.end ? whole : partialKey(id, end, readerKey);
      if (!clean || !keepSound(key, deps)) { restart(); return { members: worked(), finished: false }; }
      if (reader) audienceHolds.get(reader.key)?.keys.add(key);
      // the step before is now carried by this one (its edges stay in the graph, so a change below still reaches this entry): its answer can go
      if (state.partial?.startsWith(`Q${SEP}`)) verdicts.delete(state.partial);
      state.cursor = end; state.after = chunk[chunk.length - 1]; state.partial = key;
      if (end >= handle.end) { dropDependents([awaited]); return { members: worked(), finished: true }; }
    }
  } finally { keys.return(undefined); }
}
/** Roots judged and recorded as one kept entry (see handleSound). */
const SOUND_CHUNK = 512;
const soundKey = (handle: Handle) => wholeProofKey(handle.id);
/** A large set no turn may walk yet: its proof is asked of the recovery scheduler, and the caller is told the set is unproven. */
function notProvenYet(handle: Handle, why?: { reason?: string }): false {
  const asked = requestProof(handle.id);
  deferredLarge++;
  // a verdict being worked out that rests on this answer is judged again once the proof is complete
  collected?.add(awaitedKey(asked));
  if (why) why.reason = "checking";
  return false;
}
/** Whether every member of a stored set is sound. The answer for a set is kept, resting on the answer for its parent and
 * on the verdicts and sources of the members it adds, so a turn judges only what its set added to the one it began with:
 * a set whose parent is already known to hold costs its own additions. An entry is dropped, with everything resting on
 * it, exactly when a root it covers changes (the same dirty keys as the verdicts). A large set (LARGE_ROOT_SET) with more than
 * TURN_JUDGE_MAX members not yet proven in this process is not walked here at all (notProvenYet). */
function handleSound(allowance: LineageAllowance, handle: Handle, why?: { reason?: string }): boolean {
  const kept = verdictCache();
  const large = handle.end > LARGE_ROOT_SET;
  if (kept === undefined || collected !== null) {
    // nowhere to keep what is judged (inside a transaction that wrote), or a check that collects what it consulted: a large set is judged only from a
    // proof already kept, never walked
    if (large) {
      if (!kept?.has(soundKey(handle))) return notProvenYet(handle, why);
      collected?.add(`v${SEP}${soundKey(handle)}`);
      return true;
    }
    return !flatRootsBad(allowance, handleKeys(handle));
  }
  if (kept.has(soundKey(handle))) return true;
  const run: Handle[] = [];
  let at: Handle | null = handle;
  while (at && !kept.has(soundKey(at))) {
    run.push(at); at = at.parent;
    // A cold judge costs about a quarter node a root (measured: 20k roots ran a 3,000-node turn allowance out): a set the allowance cannot pay for is asked of the
    // recovery scheduler like a large one, and answers "checking", instead of spending the allowance and failing as an unexplained limit.
    const unproven = handle.end - (at?.end ?? 0);
    if (unproven > TURN_JUDGE_MAX && (large || unproven / COLD_ROOTS_PER_NODE > allowance.remaining)) return notProvenYet(handle, why);
  }
  let previous = at ? soundKey(at) : null, pending: string[] = [], carried = new Set<string>(), lost = false, rowsOf: string[] = [];
  for (let index = run.length - 1; index >= 0; index--) {
    const node = run[index]!;
    rowsOf.push(`x${SEP}${node.id}`);
    for (const key of handleKeys(node, node.parent?.end ?? 0)) pending.push(key);
    if (pending.length < SOUND_CHUNK && index > 0) continue;
    const deps = new Set<string>(rowsOf);
    rowsOf = [];
    collected = deps;
    let bad: boolean;
    try { bad = flatRootsBad(allowance, pending); } finally { collected = null; }
    if (bad) return false;
    pending = [];
    // see replaySetBad: a proof below that was not kept is carried by what it consulted; one kept and since gone ends the keeping
    if (previous) { if (kept.has(previous)) deps.add(`v${SEP}${previous}`); else lost = true; }
    for (const d of carried) deps.add(d);
    if (!lost && deps.size <= soundDepsMax() && keepSound(soundKey(node), deps)) { previous = soundKey(node); carried = new Set(); }
    else { if (lost || deps.size > soundDepsMax()) noteUnkept("sound"); previous = null; carried = deps; }
  }
  return true;
}
/** Whether a root set no longer holds: past the ceiling, or any root
 * forgotten or withheld by its receipts (content only: no reader access
 * needed, so it runs with memory off). Checks it cannot finish count as bad.
 * `why.reason` is "checking" when the answer is only that a large set is not proven yet in this process (handleSound). */
function outputRootsBadWork(allowance: LineageAllowance, set: OutputRoots, why?: { reason?: string }): boolean {
  if (readTimeRetired(database())) return false; // retired (S6): refsLookup / sessionLookup decide, on what the turn carried
  if (set.forgotten || set.over || set.roots.size > rootCeiling()) return true;
  if (!set.roots.size) return false;
  try {
    const view = layeredOf(set.roots);
    if (view.extra.size && flatRootsBad(allowance, view.extra)) return true;
    return Boolean(view.handle) && !handleSound(allowance, view.handle!, why);
  } catch (error) { noteWithheldOnError(error); return true; }
}

/** A copy link whose original is withheld, on content (a delegation result
 * read back later). Checks it cannot finish withhold it. */
export const COPY_ORIGIN_PROBE = "copy-origin-probe";
export function copyOriginWithheld(allowance: LineageAllowance, copy: MessageCopy): boolean {
  try { return replayExclusions(allowance, copy.threadId, [{ id: COPY_ORIGIN_PROBE, role: "user", copyOf: copy }], null, { failClosed: true }).size > 0; }
  catch { return true; }
}
/** The same answer with why (REPLY-WITHHELD-CONTRACT R1): `unproven` when the copy's originals are withheld only because a check could not
 * finish (a budget, a pending set, an error), so the result gate reads them as checking rather than deleted or changed. */
export function copyOriginVerdict(allowance: LineageAllowance, copy: MessageCopy): { withheld: boolean; unproven: boolean } {
  const checking = new Set<string>();
  try {
    const withheld = replayExclusions(allowance, copy.threadId, [{ id: COPY_ORIGIN_PROBE, role: "user", copyOf: copy }], null, { failClosed: true, checking }).size > 0;
    return { withheld, unproven: withheld && checking.has(COPY_ORIGIN_PROBE) };
  } catch { return { withheld: true, unproven: true }; }
}

/** Whether a captured reply is withheld only because a check could not finish yet (a large set it rests on is still being proven, or a check that
 * failed): what waits on it asks again later instead of giving up on it. */
export function sourceAwaitsProof(allowance: LineageAllowance, source: Record<string, unknown>): boolean {
  if (!source.thread_id || !source.message_id || !generatedSpeaker(source.speaker)) return false;
  return capturedMessageVerdict(allowance, String(source.thread_id), String(source.message_id)).unproven;
}
/** The same rule for one captured source (checkpoint maintenance). */
export function sourceIsWithheldMessage(allowance: LineageAllowance, source: Record<string, unknown>): boolean {
  return Boolean(source.thread_id && source.message_id && generatedSpeaker(source.speaker) && capturedMessageWithheld(allowance, String(source.thread_id), String(source.message_id)));
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

// ---- the warmer's entry points (lineage-warm.ts) -----------------------------------------------------------------------------------------------
// A cold start keeps no verdict, and a turn may spend only its allowance, so the first turns of a long thread would be
// unproven. While the app is idle the warmer judges the thread bottom-up in slices, each under an allowance of its own; what a slice
// finishes is kept (like any verdict, dropped by the same dirty keys), and one that runs out keeps its finished parts and is taken up again.
/** `moved`: the slice kept something a later slice builds on (a verdict, a page of a chain), whether or not it finished. */
interface WarmSlice { done: boolean; spent: number; moved: boolean; unkept: boolean }
function warmSlice(nodes: number, work: (allowance: LineageAllowance) => boolean): WarmSlice {
  const budget = LineageAllowance.warm(nodes), was = warming, before = progressTick, unkeptBefore = unkept;
  warming = true;
  try {
    const finished = work(budget);
    // done: it finished within its allowance and every verdict it reached is kept (or was already)
    return { done: finished && !budget.hit && unkept === unkeptBefore, spent: budget.spent, moved: progressTick !== before, unkept: unkept !== unkeptBefore };
  } catch (error) {
    if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT")) throw error;
    return { done: false, spent: budget.spent, moved: progressTick !== before, unkept: unkept !== unkeptBefore };
  } finally { warming = was; budget.close(); }
}
/** Judges captured replies of a thread (the verdicts recall, the replay check and the continuation check ask for), oldest first. */
export function warmReplies(threadId: string, messageIds: readonly string[], nodes: number): WarmSlice {
  return warmSlice(nodes, allowance => {
    let proven = true;
    for (const verdict of capturedMessageVerdicts(allowance, threadId, messageIds).values()) if (verdict.unproven) proven = false;
    return proven;
  });
}
/** Judges stored root sets (the roots of replies), so the replay check finds their chains proven. */
export function warmRootSets(threadId: string, setIds: readonly string[], nodes: number): WarmSlice {
  return warmSlice(nodes, allowance => {
    const judge = lineageJudge(allowance, threadId, null);
    try { judge.badSets(setIds, 0); return true; } finally { judge.settle(); }
  });
}
/** Judges a retained session's receipts and roots: the proof of its receipts so far, and its set of roots. */
export function warmSession(threadId: string, driverInstance: string, nativeSession: string, nodes: number): WarmSlice {
  return warmSlice(nodes, allowance => {
    sessionLineageBad(allowance, threadId, driverInstance, nativeSession, null);
    outputRootsBad(allowance, sessionOutputRoots(allowance, threadId, driverInstance, nativeSession));
    return true;
  });
}

// ---- the entry points of the lineage reads, each timed (see LineageAllowance.timed) ----
/** replayExclusions, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function replayExclusions(...args: Parameters<typeof replayExclusionsWork>): ReturnType<typeof replayExclusionsWork> { return args[0].timed(() => replayExclusionsWork(...args)); }
/** capturedMessageVerdicts, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
function capturedMessageVerdicts(...args: Parameters<typeof capturedMessageVerdictsWork>): ReturnType<typeof capturedMessageVerdictsWork> { return args[0].timed(() => capturedMessageVerdictsWork(...args)); }
/** outputRootsFor, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function outputRootsFor(...args: Parameters<typeof outputRootsForWork>): ReturnType<typeof outputRootsForWork> { return args[0].timed(() => outputRootsForWork(...args)); }
/** sessionOutputRoots, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function sessionOutputRoots(...args: Parameters<typeof sessionOutputRootsWork>): ReturnType<typeof sessionOutputRootsWork> { return args[0].timed(() => sessionOutputRootsWork(...args)); }
/** outputRootsBad, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function outputRootsBad(...args: Parameters<typeof outputRootsBadWork>): ReturnType<typeof outputRootsBadWork> { return args[0].timed(() => outputRootsBadWork(...args)); }
/** recordRestsOnWithheldMessage, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function recordRestsOnWithheldMessage(...args: Parameters<typeof recordRestsOnWithheldMessageWork>): ReturnType<typeof recordRestsOnWithheldMessageWork> { return args[0].timed(() => recordRestsOnWithheldMessageWork(...args)); }
/** derivationAncestryCurrent, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function derivationAncestryCurrent(...args: Parameters<typeof derivationAncestryCurrentWork>): ReturnType<typeof derivationAncestryCurrentWork> { return args[0].timed(() => derivationAncestryCurrentWork(...args)); }
/** sessionLineageBad, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function sessionLineageBad(...args: Parameters<typeof sessionLineageBadWork>): ReturnType<typeof sessionLineageBadWork> { return args[0].timed(() => sessionLineageBadWork(...args)); }
