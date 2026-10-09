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
import { database } from "../database.ts";
import { statementReusePassId, writeStamp } from "../io-budget.ts";
import { supersededThreadCheckpoint } from "./checkpoints.ts";
import { storeRootSet } from "./schema.ts";
type DatabaseLike = ReturnType<typeof database>;

export type Disclosure = Record<string,string|number|bigint|Uint8Array|null>;

// A check that cannot finish withholds the line; say so once per reason, so
// a real fault does not pass as quiet withholding.
const warned = new Set<string>();
function noteWithheldOnError(error: unknown) {
  const reason = error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "unknown";
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
  const row = database().prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(threadId, THREAD_RECEIPT_LIMIT+1);
  return Number(row?.n ?? 0) > THREAD_RECEIPT_LIMIT;
}

/** The copy link a stored message carries, if any. */
export function messageCopy(threadId: string, messageId: string): MessageCopy | undefined {
  dirtyMessage(threadId, messageId);
  const row = database().prepare("SELECT json_extract(json,'$.copyOf') AS copy FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (typeof row?.copy !== "string") return undefined;
  try {
    const copy = JSON.parse(row.copy) as MessageCopy;
    return typeof copy?.threadId === "string" && Array.isArray(copy.messageIds) ? { threadId: copy.threadId, messageIds: copy.messageIds.filter(id => typeof id === "string") } : undefined;
  } catch { return undefined; }
}

/** The owner forgot the message itself (its captured source is deleted or tombstoned). */
export function messageSourceForgotten(threadId: string, messageId: string): boolean {
  const db = database(), sourceId = `message:${threadId}:${messageId}`;
  const source = db.prepare("SELECT state FROM memory_sources WHERE id=?").get(sourceId);
  return source?.state === "deleted" || Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1").get(sourceId));
}

/** The content half of a receipt check: every record and source the receipt
 * cites still exists at the version disclosed, and nothing of it was
 * forgotten. No reader access and no global counter is consulted. */
export function contentRevoked(row: Disclosure, threadId: string): boolean {
  try {
    const db = database();
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) {
      const current = db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(record.id,record.version);
      dep("r", record.id, String(record.version));
      if (current && current.state!=="active") dep("c", record.id);
      if (!current || (current.state!=="active" && !supersededThreadCheckpoint(record.id,record.version,{threadId}))) return true;
      if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(record.id,record.version)) return true;
    }
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      const current = db.prepare("SELECT state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current || current.state!=="active" || current.revision!==source.revision || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return true;
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
  json_group_array(bundle_id) AS bundles, max(created_at) AS latest`;
const GROUP_BY = "GROUP BY thread_id,state,policy_revision,deletion_epoch,record_versions,source_versions ORDER BY latest DESC";

/** One check's judge: verdicts per receipt, per group, per cited list, per
 * record and per proven reply last for this check only. */
function lineageJudge(threadId: string, audience: ReplayAudience | null, invalidBundles?: Set<string>) {
  const db = database();
  /** Per receipt, per cited content of the reader's own receipts, per cited
   * content in its thread, per record in a thread: true = bad. */
  const verdicts = new Map<string,boolean>(), ownVerdicts = new Map<string,boolean>(), citedVerdicts = new Map<string,boolean>();
  const refVerdicts = new Map<string,{bad:boolean;sources:string[]}>();
  /** Captured replies proven still vouched for, by thread and message. */
  const soundReplies = new Set<string>();
  /** What is being judged right now: met again, the lineage is a cycle. */
  const visiting = new Set<string>();
  let receiptCount = 0, nodes = 0;
  const charge = (count=1) => { nodes+=count; rowsRead+=count; if(nodes>(nodeBudgetOverride ?? REPLAY_NODE_BUDGET)) throw new Error("MEMORY_REPLAY_LIMIT"); };
  const within = <T>(key: string, work: () => T): T => {
    if (visiting.has(key)) throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE");
    visiting.add(key);
    try { return work(); } finally { visiting.delete(key); }
  };
  const toGroups = (rows: Disclosure[]): ReceiptGroup[] => {
    // every row read is charged, and a listing past the receipt budget fails
    charge(rows.length);
    let receipts = 0;
    const groups = rows.map(row => { const bundles = JSON.parse(String(row.bundles)) as string[]; receipts += bundles.length; return { row, bundles }; });
    rowsRead += receipts;
    if (receipts > REPLAY_RECEIPT_BUDGET) throw new Error("MEMORY_REPLAY_LIMIT");
    return groups;
  };
  /** The receipts of `thread` that list any of `messageIds` as an output,
   * through the output index (memory schema v3), grouped, newest first. */
  const listing = (thread: string, messageIds: readonly string[]): ReceiptGroup[] =>
    toGroups(db.prepare(`SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND bundle_id IN (
      SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)))
      ${GROUP_BY} LIMIT ?`).all(thread, thread, JSON.stringify(messageIds), REPLAY_RECEIPT_BUDGET+1));
  /** Every receipt of a thread, grouped, read once per check. */
  const threadGroupCache = new Map<string,ReceiptGroup[]>();
  /** Receipts per thread (counted no further than the limit), once per check. */
  const receiptCounts = new Map<string,number>();
  /** Threads whose whole read ran out of budget, so later calls list at once. */
  const threadTooLong = new Set<string>();
  const threadGroups = (thread: string): ReceiptGroup[] => {
    let groups = threadGroupCache.get(thread);
    if (!groups) {
      groups = toGroups(db.prepare(`SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? ${GROUP_BY} LIMIT ?`).all(thread, REPLAY_RECEIPT_BUDGET+1));
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
    if (!Number(db.prepare(pairSql).get(thread, JSON.stringify(messageIds), 1)?.n ?? 0)) { charge(); return { groups: [], exact: true }; }
    // counted once per thread per check (Astra r4 #7)
    let receipts = receiptCounts.get(thread);
    if (receipts === undefined) {
      receipts = Number(db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(thread, THREAD_RECEIPT_LIMIT+1)?.n ?? 0);
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
    const pairs = Number(db.prepare(pairSql).get(thread, JSON.stringify(messageIds), pairCap+1)?.n ?? 0);
    rowsRead += pairs;
    charge();
    if (pairs <= pairCap) return { groups: listing(thread, messageIds), exact: true };
    if (receipts <= THREAD_RECEIPT_LIMIT) return { groups: threadGroups(thread), exact: false };
    // Too many receipts to read whole (found on an earlier call): list.
    if (!threadTooLong.has(thread)) {
      const spent = nodes;
      try { return { groups: threadGroups(thread), exact: false }; }
      catch (error) {
        if (!(error instanceof Error && error.message === "MEMORY_REPLAY_LIMIT")) throw error;
        // the failed read's charge is given back, so listing is possible
        nodes = spent; threadTooLong.add(thread);
      }
    }
    const all = Number(db.prepare(pairSql).get(thread, JSON.stringify(messageIds), PAIR_LIMIT+1)?.n ?? 0);
    rowsRead += all;
    if (all <= PAIR_LIMIT) return { groups: listing(thread, messageIds), exact: true };
    throw new Error("MEMORY_REPLAY_LIMIT");
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
      const any = db.prepare("SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1");
      for (const message of messageIds) {
        dirtyMessage(thread, message);
        charge();
        if (any.get(thread, message)) { hits.push(message); if (first) break; }
      }
      return hits;
    }
    const count = db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT ?)");
    const own = db.prepare("SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=?");
    const probe = db.prepare("SELECT 1 FROM json_each(?) b CROSS JOIN memory_disclosure_outputs o ON o.bundle_id=b.value AND o.message_id=? WHERE o.thread_id=? LIMIT 1");
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
    toGroups(db.prepare(`SELECT ${GROUP_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?
      ${GROUP_BY} LIMIT ?`).all(threadId, driverInstance, nativeSession, REPLAY_RECEIPT_BUDGET+1));
  /** The reader's own receipt, under its audience (or on content alone). Its
   * row-level fields were checked by the caller, so the verdict rests on what
   * it cites. */
  const ownBad = (row: Disclosure, cited: string): boolean => {
    let bad = ownVerdicts.get(cited);
    if (bad === undefined) { bad = audience ? audience.revoked(row) : contentRevoked(row, threadId); ownVerdicts.set(cited, bad); }
    return bad;
  };
  const groupBad = (group: ReceiptGroup, depth = 0): boolean => {
    const unknown = group.bundles.filter(id => !verdicts.has(id));
    if (!unknown.length) return group.bundles.some(id => verdicts.get(id));
    if (depth > 64 || (receiptCount += unknown.length) > REPLAY_RECEIPT_BUDGET) throw new Error("MEMORY_REPLAY_LIMIT");
    const row = group.row;
    if (row.record_versions === null || row.source_versions === null) throw new Error("MEMORY_REPLAY_LIMIT");
    const own = String(row.thread_id);
    const bad = within(`group\u0000${JSON.stringify([own,row.state,row.policy_revision,row.deletion_epoch,row.record_versions,row.source_versions])}`, () => {
      if (audience !== null && (row.state === "revoked" || row.policy_revision !== audience.policyRevision || row.deletion_epoch !== audience.deletionEpoch)) return true;
      // Only this replay's receipts are hydrated under its audience. An explicitly
      // approved shared projection does not require access to a private ancestor.
      if (own === threadId && ownBad(row, `${row.record_versions}\u0000${row.source_versions}`)) return true;
      return citedBad(own, String(row.record_versions), String(row.source_versions), depth);
    });
    for (const id of unknown) { verdicts.set(id, bad); if (bad) invalidBundles?.add(id); }
    return bad || group.bundles.some(id => verdicts.get(id));
  };
  /** What a receipt of thread `own` cites: every record and source still
   * current, and every reply any of it came from still vouched for. */
  const citedBad = (own: string, recordVersions: string, sourceVersions: string, depth: number): boolean => {
    const key = `${own}\u0000${recordVersions}\u0000${sourceVersions}`, known = citedVerdicts.get(key);
    if (known !== undefined) return known;
    const bad = within(`cited\u0000${key}`, () => {
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
    });
    citedVerdicts.set(key, bad);
    return bad;
  };
  /** One cited record (read from thread `own`): current, not forgotten, and
   * every record it was derived from still holds; with the sources its
   * evidence rests on, for the lineage check. */
  const refBad = (ref: {id:string;version:number}, own: string): {bad:boolean;sources:string[]} => {
    const key = `${own}\u0000${ref.id}\u0000${ref.version}`, known = refVerdicts.get(key);
    if (known) return known;
    const verdict = ((): {bad:boolean;sources:string[]} => {
      const sources: string[] = [];
      const current = db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
      dep("r", ref.id, String(ref.version));
      if (current && current.state!=="active") dep("c", ref.id);
      // A receipt's own thread checkpoint, superseded since, is stale there, not
      // revoked (checkpoints.ts), wherever the receipt is read from.
      if (!current || (current.state!=="active" && !supersededThreadCheckpoint(ref.id,ref.version,{threadId:own})) || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(ref.id,ref.version)) return {bad:true,sources};
      // An owner's correction does not carry the old words, so the version
      // it replaced is history, not evidence (recordRestsOnWithheldMessage).
      const parents = db.prepare(`WITH RECURSIVE parents(id,version) AS (
        SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d
        JOIN parents p ON d.child_id=p.id AND d.child_version=p.version
        LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
        WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 1025)
        SELECT id,version FROM parents`).all(ref.id,ref.version);
      if (parents.length > 1024) throw new Error("MEMORY_REPLAY_LIMIT");
      charge(parents.length);
      // Content checks cannot lean on the global policy revision a correction
      // moves, so every record the ref was derived from must still be current:
      // a projection whose original the owner corrected carries the old words.
      // A correction's own history edge (the child supersedes that parent) is
      // not a dependency.
      if (!audience) {
        const edges = db.prepare(`WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
          SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
          UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
          JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
          -- not past an owner's correction: the version it replaced is history (Astra r3 #2)
          LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
          WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT 1025)
          SELECT e.parent_id,e.parent_version,e.child_id,e.child_version,p.state,c.supersedes_id FROM edges e
          LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
          LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(ref.id,ref.version);
        if (edges.length > 1024) throw new Error("MEMORY_REPLAY_LIMIT");
        charge(edges.length);
        for (const edge of edges) { dep("r", String(edge.parent_id), String(edge.parent_version)); dep("r", String(edge.child_id), String(edge.child_version)); }
        // A parent replaced by a record in this same chain is history, not a
        // dependency, however many corrections and projections lie between.
        const replacing = new Set(edges.map(edge=>String(edge.supersedes_id??"")));
        const self = db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
        if (self?.supersedes_id) replacing.add(String(self.supersedes_id));
        for (const edge of edges) {
          const history = replacing.has(String(edge.parent_id)) && (edge.state==="superseded" || edge.state==="archived");
          if (!edge.state || (edge.state!=="active" && !history) || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(edge.parent_id,edge.parent_version)) return {bad:true,sources};
        }
      }
      for (const parent of parents) {
        const evidence = db.prepare("SELECT e.source_id,e.source_revision,s.revision,s.state FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? LIMIT 1025").all(parent.id,parent.version);
        if (evidence.length > 1024) throw new Error("MEMORY_REPLAY_LIMIT");
        charge(evidence.length);
        for (const source of evidence) {
          if (source.state!=="active" || source.revision!==source.source_revision) return {bad:true,sources};
          sources.push(String(source.source_id));
        }
      }
      return {bad:false,sources};
    })();
    refVerdicts.set(key, verdict);
    return verdict;
  };
  /** One source row per check: a session's receipts cite the same sources again and again, and the row cannot change while the check runs. */
  const sourceRows = new Map<string, Record<string, unknown> | undefined>();
  const sourceRow = (id: string) => {
    if (!sourceRows.has(id)) sourceRows.set(id, db.prepare("SELECT state,revision,thread_id,message_id FROM memory_sources WHERE id=?").get(id));
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
      replies.set(thread, [...(replies.get(thread) ?? []), message]);
    }
    for (const [thread, messages] of replies) {
      if (anyProducerBad(thread, messages, depth+1)) return true;
      for (const message of messages) {
        // a reply made without a receipt rests on the replies its context carried
        if (rootsBad(thread, message, depth+1)) return true;
        // a copy used as evidence carries its original's lineage
        // (the reader's own check too: a harness copy is not an approved projection)
        const copy = messageCopy(thread, message);
        if (copy && originBad(copy, 1, depth+1, true)) return true;
        soundReplies.add(`${thread}\u0000${message}`);
      }
    }
    return false;
  };
  /** Root verdicts (true = bad: forgotten, or withheld by its receipts) and
   * set verdicts, for this check only. */
  const rootVerdicts = new Map<string,boolean>(), setVerdicts = new Map<string,boolean>();
  /** Of `messages` (roots in `thread`), the bad ones: forgotten sources read
   * in one batch, producers judged in one batch for the thread (Astra r4 #7). */
  const badRoots = (thread: string, messages: readonly string[], depth: number): string[] => {
    const pending = [...new Set(messages)].filter(message => !rootVerdicts.has(rootKey(thread, message)) && !soundReplies.has(rootKey(thread, message)));
    if (pending.length) {
      const ids = JSON.stringify(pending.map(message => `message:${thread}:${message}`));
      rowsRead += pending.length;
      const forgotten = new Set([
        ...db.prepare("SELECT id FROM memory_sources WHERE state='deleted' AND id IN (SELECT value FROM json_each(?))").all(ids).map(row => String(row.id)),
        ...db.prepare("SELECT target_id AS id FROM memory_tombstones WHERE target_type='source' AND target_id IN (SELECT value FROM json_each(?))").all(ids).map(row => String(row.id)),
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
          if (!hit.has(message)) soundReplies.add(rootKey(thread, message));
        }
      }
    }
    return messages.filter(message => rootVerdicts.get(rootKey(thread, message)) === true);
  };
  /** Of root sets `setIds`, the bad ones: a set missing, past the ceiling, or
   * holding a bad root. Every distinct root of all of them is judged once
   * (grouped by thread), then the bad roots find their sets through the
   * member index: indexed lookups, no recursive walk. */
  const badSets = (setIds: readonly string[], depth: number): Set<string> => {
    const out = new Set<string>();
    const pending = [...new Set(setIds)].filter(id => { const known = setVerdicts.get(id); if (known) out.add(id); return known === undefined; });
    if (!pending.length) return out;
    const json = JSON.stringify(pending);
    const sizes = new Map(db.prepare("SELECT set_id,size FROM memory_root_sets WHERE set_id IN (SELECT value FROM json_each(?))").all(json).map(row => [String(row.set_id), Number(row.size)]));
    const live: string[] = [];
    for (const id of pending) {
      const size = sizes.get(id);
      if (size === undefined || size > rootCeiling()) { setVerdicts.set(id, true); out.add(id); } else live.push(id);
    }
    if (!live.length) return out;
    const liveJson = JSON.stringify(live);
    const members = db.prepare("SELECT DISTINCT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id IN (SELECT value FROM json_each(?))").all(liveJson);
    rowsRead += members.length;
    const byThread = new Map<string,string[]>();
    for (const row of members) { const thread = String(row.root_thread_id); byThread.set(thread, [...(byThread.get(thread) ?? []), String(row.root_message_id)]); }
    const holding = db.prepare("SELECT DISTINCT set_id FROM memory_root_set_members WHERE root_thread_id=? AND root_message_id=? AND set_id IN (SELECT value FROM json_each(?))");
    const badLive = new Set<string>();
    for (const [thread, messages] of byThread) {
      for (const message of badRoots(thread, messages, depth)) {
        charge();
        for (const row of holding.all(thread, message, liveJson)) badLive.add(String(row.set_id));
      }
    }
    for (const id of live) { setVerdicts.set(id, badLive.has(id)); if (badLive.has(id)) out.add(id); }
    return out;
  };
  /** A reply's output roots (memory schema v6): the one root set it points
   * at. Bad when the marker (an empty set id) is there or the set is bad. */
  const rootsBad = (thread: string, message: string, depth: number): boolean => {
    dirtyMessage(thread, message);
    charge();
    const row = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(thread, message);
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
  return { verdicts, producers, listingAny, session, groupBad, originBad, rootsBad, badSets };
}

/** The ids among `messages` a reader may no longer be shown. `audience` null:
 * content checks only (a room's owner-audience turn, recall). failClosed: a
 * message whose check runs past its budget is withheld instead of throwing.
 *
 * Only the receipts that list one of `messages` as an output are read (the
 * output index), however many receipts the thread holds, grouped by what a
 * verdict rests on; each distinct cited list, record and reply is judged
 * once per call (0.1.61.1 memreplay). */
export function replayExclusions(threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: {invalidBundles?: Set<string>; failClosed?: boolean} = {}): Set<string> {
  // No cap on how many lines are asked about: a line no receipt lists costs
  // one index probe. The 0.1.61 cap (10,000 lines) failed every turn of a
  // conversation a routine keeps posting into (0.1.61.1 memreplay).
  if (!messages.length) return new Set();
  const { invalidBundles, failClosed = false } = options;
  const judge = lineageJudge(threadId, audience, invalidBundles);
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
    catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); for(const id of generated)excluded.add(id); }
    for (let index = 0; index < groups.length; index++) {
      try { if (judge.groupBad(groups[index])) unsettled.push(...groups[index].bundles); }
      catch (error) {
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
      catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); for (const id of pending) excluded.add(id); }
    }
  }
  // A reply rests on its output roots, in every memory mode (v6): the lines'
  // root sets are read in one indexed lookup, each distinct set and root is
  // judged once, and a line whose set no longer holds is withheld.
  const rooted = generated.filter(id => !excluded.has(id));
  if (rooted.length) {
    try {
      const rows = database().prepare("SELECT message_id,set_id FROM memory_output_roots WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))").all(threadId, JSON.stringify(rooted));
      for (const id of rooted) dirtyMessage(threadId, id);
      rowsRead += rows.length;
      const bad = judge.badSets(rows.map(row => String(row.set_id ?? "")).filter(Boolean), 0);
      for (const row of rows) { const id = String(row.set_id ?? ""); if (!id || bad.has(id)) excluded.add(String(row.message_id)); }
    } catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); for (const id of rooted) if (messageMadeWithMemory(threadId, id)) excluded.add(id); }
  }
  // A copy is withheld with its original.
  for(const message of messages){
    if(!message.copyOf||excluded.has(message.id))continue;
    try { if(judge.originBad(message.copyOf,1,0,true))excluded.add(message.id); }
    catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); excluded.add(message.id); }
  }
  return excluded;
}

/** A resumed native session rests on everything it was ever shown: true
 * when any receipt of the session no longer holds, lineage included, or
 * when the check cannot finish (review M1: the replay window no longer
 * reaches an old session's receipts, so the continuation check must). The
 * bad receipts are added to `invalidBundles`. */
export function sessionLineageBad(threadId: string, driverInstance: string, nativeSession: string, audience: ReplayAudience | null, invalidBundles?: Set<string>): boolean {
  try {
    const judge = lineageJudge(threadId, audience, invalidBundles);
    let bad = false;
    for (const group of judge.session(driverInstance, nativeSession)) if (judge.groupBad(group)) bad = true;
    return bad;
  } catch (error) { noteWithheldOnError(error); return true; }
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
// - everything else (sources, tombstones, derivations, evidence, policy revision, deletion
//   epoch, mode, a message deleted): a counter that flushes the whole cache;
// - commits by another connection (data_version), as before.
// A write that touches none of these (a new message, a new receipt with no outputs, a
// checkpoint version added, a notebook poll, a data_revision bump) flushes nothing.
const SEP = "\u001f";
const verdicts = new Map<string,{withheld:boolean;deps:Set<string>}>();
const chains = new Map<string,Array<{thread:string;message:string;generated:boolean}> | "long" | "many">();
let cacheHits = 0, cacheMisses = 0;
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
const RECORD_CHANGED = "OLD.state IS NOT NEW.state OR OLD.owner_pinned IS NOT NEW.owner_pinned OR OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind";
const EPOCH_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS lineage_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.lineage_epoch VALUES(1,0);
CREATE TEMP TABLE IF NOT EXISTS lineage_dirty(k TEXT NOT NULL);
CREATE TEMP TRIGGER IF NOT EXISTS lineage_sources_u AFTER UPDATE ON main.memory_sources
 WHEN OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash OR OLD.speaker IS NOT NEW.speaker OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id
 BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_sources_d AFTER DELETE ON main.memory_sources BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_u AFTER UPDATE ON main.memory_records WHEN ${RECORD_CHANGED}
 BEGIN ${NOTE("'r'||char(31)||OLD.id||char(31)||OLD.version")}; ${NOTE("'c'||char(31)||OLD.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_records_chain AFTER UPDATE ON main.memory_records WHEN OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind
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
CREATE TEMP TRIGGER IF NOT EXISTS lineage_root_sets_d AFTER DELETE ON main.memory_root_set_members BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_receipts_u AFTER UPDATE ON main.memory_disclosures WHEN OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions
 BEGIN INSERT INTO lineage_dirty SELECT 'm'||char(31)||thread_id||char(31)||message_id FROM main.memory_disclosure_outputs WHERE bundle_id=NEW.bundle_id; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_u AFTER UPDATE ON main.messages WHEN OLD.json IS NOT NEW.json AND (instr(OLD.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)
 BEGIN ${NOTE("'m'||char(31)||NEW.thread_id||char(31)||NEW.id")}; END;
CREATE TEMP TRIGGER IF NOT EXISTS lineage_messages_d AFTER DELETE ON main.messages BEGIN ${BUMP}; END;
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
  const rows = db.prepare("SELECT DISTINCT k FROM temp.lineage_dirty").all();
  if (!rows.length) return;
  const keys = new Set<string>();
  for (const row of rows) {
    const key = String(row.k);
    // a checkpoint that was rolled still has an active newer version: nothing about its tolerance changed
    if (key.startsWith(`c${SEP}`) && db.prepare("SELECT 1 FROM memory_records WHERE id=? AND state='active' LIMIT 1").get(key.slice(2))) continue;
    keys.add(key);
  }
  db.exec("DELETE FROM temp.lineage_dirty");
  if (!keys.size) return;
  for (const [key, entry] of verdicts) for (const d of entry.deps) if (keys.has(d)) { verdicts.delete(key); break; }
}
/** Moves on every write through this connection and every commit by another
 * one; undefined inside a transaction, where a verdict may rest on writes
 * that roll back. A cached verdict holds only while it is unchanged. */
export function databaseStamp(): string | undefined {
  if (database().isTransaction) return undefined;
  const row = database().prepare("SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `${row?.changes}:${row?.version}`;
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
    const row = db.prepare("SELECT (SELECT n FROM temp.lineage_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version").get();
    value = `e${row?.epoch}:${row?.version}`;
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
  const stamp = lineageStamp();
  if (stamp === undefined) return undefined;
  const db = database();
  // a different connection (a restore, a data-dir switch) shares nothing with the last
  if (verdictDb !== db) { verdictDb = db; verdicts.clear(); chains.clear(); verdictStamp = ""; }
  if (stamp !== verdictStamp || verdicts.size > 4096) { verdicts.clear(); chains.clear(); verdictStamp = stamp; if (stamp.startsWith("e")) db.exec("DELETE FROM temp.lineage_dirty"); }
  else if (stamp.startsWith("e")) drainDirty(db);
  if (chains.size > 4096) chains.clear();
  return verdicts;
}

/** A captured generated message is withheld on content: what its receipt
 * used was forgotten, deleted or changed, or it is a copy of a message that
 * is. Checks it cannot finish withhold it. */
export function capturedMessageWithheld(threadId: string, messageId: string): boolean {
  const cache = verdictCache(), key = JSON.stringify([threadId, messageId]);
  const known = cache?.get(key);
  if (known !== undefined) { cacheHits++; return known.withheld; }
  cacheMisses++;
  let withheld: boolean;
  const outer = collected;
  collected = new Set<string>();
  const consulted = collected;
  try {
    dirtyMessage(threadId, messageId);
    const copy = messageCopy(threadId, messageId);
    withheld = replayExclusions(threadId, [{ id: messageId, ...(copy ? { copyOf: copy } : {}) }], null, { failClosed: true }).size > 0;
  } catch (error) { noteWithheldOnError(error); withheld = true; }
  finally { collected = outer; }
  if (cache && consulted.size <= 4000) cache.set(key, { withheld, deps: consulted });
  if (outer) for (const d of consulted) outer.add(d);
  return withheld;
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
export function derivationAncestryCurrent(db: DatabaseLike, id: string, version: number, selfSupersedes?: unknown): boolean {
  const edges = db.prepare(`WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
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
    if (Number(db.prepare(`${chain} SELECT count(*) AS n FROM chain`).get(recordId, version)?.n ?? 0) > 64) rows = "long";
    else {
      const found = db.prepare(`${chain} SELECT DISTINCT s.thread_id,s.message_id,s.speaker FROM chain c JOIN memory_evidence e ON e.record_id=c.id AND e.record_version=c.version
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
  return Boolean(messageCopy(threadId, messageId)) || Boolean(database().prepare("SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId))
    || Boolean(database().prepare("SELECT 1 FROM memory_output_roots WHERE thread_id=? AND message_id=? LIMIT 1").get(threadId, messageId));
}

/** A set of output roots: keys `thread\u0000message`; `over` when it passed
 * the ceiling (or a context could not be proven). */
export interface OutputRoots { roots: Set<string>; over: boolean }
const rootKey = (thread: string, message: string) => `${thread}\u0000${message}`;
/** One commit for a set and the row that points at it. */
function atomically(db: ReturnType<typeof database>, work: () => void): void {
  db.exec("SAVEPOINT memory_root_pointer");
  try { work(); db.exec("RELEASE memory_root_pointer"); }
  catch (error) { db.exec("ROLLBACK TO memory_root_pointer; RELEASE memory_root_pointer"); throw error; }
}
/** The members of one stored root set, into `into`; an unknown or empty id is unprovable. */
function addSetMembers(into: OutputRoots, setId: string): void {
  const db = database();
  if (!setId) { into.over = true; return; }
  const size = db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?").get(setId);
  if (!size || Number(size.size) > rootCeiling()) { into.over = true; return; }
  for (const row of db.prepare("SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=?").all(setId)) into.roots.add(rootKey(String(row.root_thread_id), String(row.root_message_id)));
}
/** The flat root set of what a turn's context carries (memory schema v6):
 * each carried reply made under a receipt is a root itself, and a reply that
 * has roots hands over its set (the union, never a link: depth stays 1). A
 * copy carries its originals'. Owner and person lines are never roots. */
export function outputRootsFor(lines: ReadonlyArray<{ threadId: string; id: string; role?: string; copyOf?: MessageCopy }>): OutputRoots {
  const found: OutputRoots = { roots: new Set(), over: false };
  const db = database();
  const listed = db.prepare("SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=? LIMIT 1");
  const rooted = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?");
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
  const roots = new Set([...a.roots, ...b.roots]);
  return { roots, over: a.over || b.over || roots.size > rootCeiling() };
}
/** Points a reply at the root set of what it rests on (every mode, v6): the
 * union with any set it already has, stored once and reused when the same
 * union exists. Past the ceiling the unprovable marker is written instead,
 * which withholds the reply. */
export function recordOutputRoots(threadId: string, messageId: string, set: OutputRoots): void {
  if (!set.over && !set.roots.size) return;
  const db = database();
  const upsert = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?) ON CONFLICT(thread_id,message_id) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(threadId, messageId);
  const union: OutputRoots = { roots: new Set(set.roots), over: set.over };
  if (held) { if (!String(held.set_id ?? "")) return; addSetMembers(union, String(held.set_id)); }
  if (union.over || union.roots.size > rootCeiling()) { upsert.run(threadId, messageId, ""); return; }
  atomically(db, () => upsert.run(threadId, messageId, storeRootSet(db, union.roots)));
}
/** The roots a retained engine session was shown (v6). A session marked over,
 * or whose set is within the headroom of the ceiling, comes back `over`: it
 * resets before its next turn instead of withholding that turn's replies. */
export function sessionOutputRoots(threadId: string, driverInstance: string, nativeSession: string): OutputRoots {
  const found: OutputRoots = { roots: new Set(), over: false };
  const row = database().prepare("SELECT s.set_id,r.size FROM memory_session_roots s LEFT JOIN memory_root_sets r ON r.set_id=s.set_id WHERE s.thread_id=? AND s.driver_instance=? AND s.native_session=?").get(threadId, driverInstance, nativeSession);
  if (!row) return found;
  if (row.size === null || row.size === undefined || Number(row.size) > sessionCeiling()) { found.over = true; return found; }
  addSetMembers(found, String(row.set_id));
  return found;
}
/** Whether a session has a v6 lineage row (every session v6 starts or resumes has one). */
export function sessionLineageKnown(threadId: string, driverInstance: string, nativeSession: string): boolean {
  return Boolean(database().prepare("SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession));
}
/** Adds what a turn's context carried to its engine session's set (v6). The
 * row is written even for an empty set: it marks the session as one v6 saw. */
export function recordSessionRoots(threadId: string, driverInstance: string, nativeSession: string, set: OutputRoots): void {
  const db = database();
  const upsert = db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id=excluded.set_id WHERE set_id IS NOT excluded.set_id");
  const held = db.prepare("SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, driverInstance, nativeSession);
  const union: OutputRoots = { roots: new Set(set.roots), over: set.over };
  if (held) { if (!String(held.set_id ?? "")) return; addSetMembers(union, String(held.set_id)); }
  if (union.over || union.roots.size > rootCeiling()) { upsert.run(threadId, driverInstance, nativeSession, ""); return; }
  atomically(db, () => upsert.run(threadId, driverInstance, nativeSession, storeRootSet(db, union.roots)));
}
/** Whether a root set no longer holds: past the ceiling, or any root
 * forgotten or withheld by its receipts (content only: no reader access
 * needed, so it runs with memory off). Checks it cannot finish count as bad. */
export function outputRootsBad(set: OutputRoots): boolean {
  if (set.over || set.roots.size > rootCeiling()) return true;
  if (!set.roots.size) return false;
  try {
    const byThread = new Map<string, string[]>();
    for (const key of set.roots) { const at = key.indexOf("\u0000"); const thread = key.slice(0, at); byThread.set(thread, [...(byThread.get(thread) ?? []), key.slice(at + 1)]); }
    for (const [thread, messages] of byThread) {
      for (const message of messages) if (messageSourceForgotten(thread, message)) return true;
      if (replayExclusions(thread, messages.map(id => ({ id })), null, { failClosed: true }).size) return true;
    }
    return false;
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
 * is unproven while it holds a receipt older than lineage and has no v6
 * session row, and it resets before its first v6 continuation, whatever the
 * counters say. The session v6 then starts gets its row (recordSessionRoots on
 * session.started), so it is not reset again (Astra r4 #5). */
export function preLineageSessionRevoked(rows:ReadonlyArray<Record<string,unknown>>,threadId:string,driverInstance:string,nativeSession:string):boolean {
  if(!rows.length||sessionLineageKnown(threadId,driverInstance,nativeSession))return false;
  const meta=database().prepare("SELECT since FROM memory_lineage_meta WHERE id=1").get();
  if(!meta)return false;
  const oldest=Math.min(...rows.map(row=>Number(row.created_at??0)));
  return oldest<Number(meta.since);
}
