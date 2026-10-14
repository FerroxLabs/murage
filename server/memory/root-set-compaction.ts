// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps output lineage (memory schema v7) small.
// At start-up, before the server takes traffic (database.ts), with progress
// on the upgrade screen:
//  1. converts the full root sets a v6 file holds into parent + added
//     members, one small transaction per set, so a kill loses at most the
//     set in hand and the next start carries on from the cursor;
//  2. hands the freed pages back with one VACUUM, only when the disk has
//     room for it; short of room it is skipped, said in plain words, and
//     tried again at the next start. The upgrade never fails over it.
// In the background (the memory worker's idle sweep), only short steps that
// never hold the write lock for long: collecting sets nothing points at, a
// checkpoint that cuts the write-ahead log back (never waiting on a lock),
// and incremental vacuum where the file allows it. No step changes what any
// set holds: a converted set keeps its members and its content address.
import { readTimeRetired } from "./read-time-retired.ts";
import { statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { settleWal } from "../wal-maintenance.ts";
import { integrityFlags } from "./integrity-flags.ts";
import { lineageRepairPending } from "./schema.ts";
import { reclaimVacuumWaiting, nextReclaimStep, reclaimApplies, reclaimCertified, reclaimShortOfDisk, rootSetReclaimStatus } from "./root-set-reclaim.ts";
import { ensureRootSetWorklist, ROOT_SET_WORKLIST_TABLE } from "./upgrade-app-tables.ts";
import { verifyDerivedRows } from "../branch-index.ts";


export type LineageStorageState = "converting" | "reclaim-available" | "waiting-for-disk" | "waiting" | "idle";
/** Why the hand-back of the root sets is not running yet: the write-time check of earlier memory has not got past its first two phases, or the
 * revoke marker is still walking what that check opened. */
export type ReclaimWaitReason = "checking" | "marker" | "vacuum-idle";
/** Connections whose last space hand-back found too little free disk. */
const diskShort = new WeakSet<object>();
export interface LineageStorageStatus {
  state: LineageStorageState;
  /** Root sets to look at in the conversion, and how many have been. */
  total: number; done: number;
  /** 0 to 100, for a progress bar; 100 when there is nothing to do. */
  percent: number;
  /** Bytes inside the file that are free and not yet handed back. */
  freeBytes: number;
  /** Bytes of the write-ahead log. */
  walBytes: number;
  /** The member index a v6 file carries is still in the file: handing the space back drops it, so the offer stands even with no free page yet. */
  legacyIndexPending: boolean;
  /** Plain words for the owner when space is waiting on the disk. */
  message?: string;
  /** state "waiting" only: what the hand-back is waiting for. */
  reason?: ReclaimWaitReason;
}

/** The v6 member index, kept by the upgrade (freeing it blocked the server for minutes) and dropped by the owner's hand-back. */
export const LEGACY_MEMBER_INDEX = "memory_root_set_members_root";
function legacyIndexPending(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(LEGACY_MEMBER_INDEX));
}
function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}
/** A revoke job still has marker work (the bulk revokes the check opens are walked by the marker before the file is rewritten: rowid cursors). */
function markerJobsWaiting(db: DatabaseSync): boolean {
  try { return Boolean(db.prepare("SELECT 1 AS x FROM memory_revoke_jobs WHERE state IN ('active','undoing') LIMIT 1").get()); } catch { return false; }
}
function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}
function fileBytes(path: string): number { try { return statSync(path).size; } catch { return 0; } }
function mainFile(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA database_list").all().find(entry => entry.name === "main");
  return String(row?.file ?? "");
}
function compactionRow(db: DatabaseSync) {
  return hasTable(db, "memory_root_set_compaction") ? db.prepare("SELECT total,done,finished_at,reclaimed_at FROM memory_root_set_compaction WHERE id=1").get() : undefined;
}
const unset = (value: unknown) => value === null || value === undefined;
const WAITING_MESSAGE = "Murage made your memory smaller, but needs more free disk space to hand the space back. Free up some space and restart Murage; nothing is lost in the meantime.";

export function lineageStorageStatus(db: DatabaseSync): LineageStorageStatus {
  const file = mainFile(db);
  // the 1.0.2 root-set hand-back (root-set-reclaim.ts) shows as the storage work it replaces, with its steps as the progress
  const reclaim = rootSetReclaimStatus();
  if (reclaim.running) {
    const total = Math.max(1, reclaim.total), done = Math.min(total, reclaim.done);
    return { state: "converting", total, done, percent: Math.floor(done * 100 / total), freeBytes: pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size"),
      walBytes: file ? fileBytes(`${file}-wal`) : 0, legacyIndexPending: legacyIndexPending(db) };
  }
  const freeBytes = pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size");
  const walBytes = file ? fileBytes(`${file}-wal`) : 0;
  // From v10 the real hand-back is the root-set reclaim (root-set-reclaim.ts): the v7 conversion row is never written, so reading it would
  // answer "idle" for ever and the button would have nothing to start.
  if (reclaimApplies(db)) {
    let step: ReturnType<typeof nextReclaimStep>["kind"] = "done";
    try { step = nextReclaimStep(db).kind; } catch { /* an unreadable file offers nothing */ }
    const base = { total: 0, done: 0, freeBytes, walBytes, legacyIndexPending: legacyIndexPending(db) };
    if (step === "done") return { state: "idle", percent: 100, ...base };
    if (!reclaimCertified(db)) return { state: "waiting", reason: "checking", percent: 0, ...base };
    if (markerJobsWaiting(db)) return { state: "waiting", reason: "marker", percent: 0, ...base };
    if (reclaimVacuumWaiting()) return { state: "waiting", reason: "vacuum-idle", percent: 90, ...base };
    if (reclaimShortOfDisk(db)) return { state: "waiting-for-disk", percent: 0, ...base, message: WAITING_MESSAGE };
    return { state: "reclaim-available", percent: 0, ...base };
  }
  const row = compactionRow(db);
  const total = Number(row?.total ?? 0), done = Math.min(total, Number(row?.done ?? 0));
  const converting = Boolean(row) && unset(row!.finished_at);
  const waiting = Boolean(row) && !converting && unset(row!.reclaimed_at);
  // The conversion is finished and the space it freed is still inside the file: handing it back rewrites the file, which is the
  // owner's choice (reclaimLineageSpace), never something a start-up does.
  const available = waiting && !diskShort.has(db);
  return { state: converting ? "converting" : available ? "reclaim-available" : waiting ? "waiting-for-disk" : "idle", total, done,
    percent: converting ? (total ? Math.floor(done * 100 / total) : 0) : 100, freeBytes, walBytes, legacyIndexPending: legacyIndexPending(db), ...(waiting && !available ? { message: WAITING_MESSAGE } : {}) };
}

export interface StepBudget { maxRows?: number; maxMs?: number; now?: () => number; chunkRows?: number; maxCutRows?: number }
export interface StepResult { remaining: boolean; examined: number; converted: number; rows: number }

/** Rows one chunk of a set's reading covers. The budget is asked between chunks, so a step overshoots it by at most one chunk. */
export const COMPACTION_CHUNK_ROWS = 2_000;
/** The most rows one set may give up in its single cutting transaction; a set with more inherited rows stays full (a valid v7 set, read as it always was).
 * The cut cannot be split (a set half cut is not a set), so this bounds the one write that holds the file: at 100,000 rows the cuts of a 48 GB file ran
 * near 50 ms each and wrote over 4 GB a minute (lanes/int102-gate/preview-live, 2026-10-12); 20,000 keeps each cut a few milliseconds. */
export const COMPACTION_MAX_CUT_ROWS = 20_000;
/** The most links a chain may have below a set that is cut onto it. A longer chain keeps its next set full: a cold read of a set walks at most this many
 * links one at a time (root-set-handles.ts HOPS), so no chain grows to the length of a thread. */
export const COMPACTION_MAX_CHAIN = 48;
/** The set a step has begun and not finished: where its reading has got to. The reading position of the count phase is kept in the cursor row
 * (so a restart resumes it); the temporary table of the later phases is rebuilt on resume, so those phases begin again from their first row. */
interface SetInHand {
  id: string; size: number; previous: { id: string; size: number };
  phase: "count" | "below" | "held";
  /** The last member key read in the current phase (null: the phase has not read yet). */
  key: [string, string] | null;
  counted: number;
  chain: string[] | null; chainAt: number;
  belowRows: number; belowDistinct: number;
  held: number;
}
const inHand = new WeakMap<object, SetInHand>();
const BELOW = "temp.memory_root_set_below";

type WorkKey = [string, number, string];
/** The two reads of the worklist: both seek in the table's own key order (no sort, whatever the table holds). */
export const WORKLIST_BATCH_SQL = {
  first: `SELECT thread_id,size,set_id FROM ${ROOT_SET_WORKLIST_TABLE} ORDER BY thread_id,size,set_id LIMIT 256`,
  after: `SELECT thread_id,size,set_id FROM ${ROOT_SET_WORKLIST_TABLE} WHERE (thread_id,size,set_id)>(?1,?2,?3) ORDER BY thread_id,size,set_id LIMIT 256`,
} as const;
/** What the cursor column holds (JSON): the phase, where the fill has got to, or the last worklist row finished and the set in hand. */
interface PersistedCursor {
  ph: "enumerate" | "convert";
  /** enumerate: which table is being read, the last rowid done in it, and the worklist rows added so far. */
  src?: "output" | "session"; rowid?: number; n?: number;
  /** convert: the last worklist row finished, and the set begun after it. */
  k?: WorkKey | null;
  hand?: { id: string; prev: { id: string; size: number }; phase: SetInHand["phase"]; key: [string, string] | null; counted: number } | null;
}
const FRESH: PersistedCursor = { ph: "enumerate", src: "output", rowid: 0, n: 0 };
function readCursor(text: unknown): PersistedCursor {
  const raw = String(text ?? "");
  if (!raw.startsWith("{")) return { ...FRESH }; // '' (not begun) or a cursor an earlier build of this lane wrote: the fill begins, sets already chained are skipped
  try { const value = JSON.parse(raw) as PersistedCursor; return value.ph === "convert" || value.ph === "enumerate" ? value : { ...FRESH }; } catch { return { ...FRESH }; }
}

/** One bounded step of the v6 -> v7 conversion, in two phases that both keep their place in the cursor row.
 *
 * ENUMERATE fills the worklist (upgrade_root_set_worklist) from the reply and session roots by rowid ranges of `chunkRows` rows, counting the
 * rows it adds as it goes (the total is never a count(*) over the sets). CONVERT then walks the worklist by keyset seek in its own key order
 * (thread, size, id): per thread the sets go smallest first, and a full set whose next smaller set is a proper subset of it keeps only what it
 * adds, with a parent row. Anything else stays full (still a valid v7 set). Resumable: a set already chained is skipped.
 *
 * A set is kept full BEFORE any of its members is read when the smaller set is larger than `maxCutRows`, is not smaller than the set, or sits on a chain
 * of COMPACTION_MAX_CHAIN links. Otherwise its rows, and the rows of the chain below its predecessor, are read in key order in chunks of `chunkRows`
 * with the budget asked between chunks; the chain's members are gathered into a temporary table of at most `maxCutRows` rows, the set's own rows
 * are looked up in it chunk by chunk, and only then is the set cut and linked in one short transaction. Nothing sorts a history: every read is a seek. */
export function compactRootSetsStep(db: DatabaseSync, budget: StepBudget = {}): StepResult {
  const { maxRows = 200_000, maxMs = 150, now = () => performance.now(), chunkRows = COMPACTION_CHUNK_ROWS, maxCutRows = COMPACTION_MAX_CUT_ROWS } = budget;
  const result: StepResult = { remaining: false, examined: 0, converted: 0, rows: 0 };
  if (!hasTable(db, "memory_root_set_compaction")) return result;
  // v10 (write-time lineage): root sets are frozen, never converted or written again (STORAGE-AUDIT 2); the reclaim drops them instead
  if (hasTable(db, "memory_lineage_cert")) return result;
  const state = db.prepare("SELECT total,done,cursor,finished_at FROM memory_root_set_compaction WHERE id=1").get();
  if (!state || (state.finished_at !== null && state.finished_at !== undefined)) return result;
  ensureRootSetWorklist(db);
  const started = now();
  const outOfTime = () => result.rows >= maxRows || now() - started >= maxMs;
  const cursor = readCursor(state.cursor);
  let done = Number(state.done ?? 0), total = Number(state.total ?? 0);
  const saveRow = (finished = false) => db.prepare("UPDATE memory_root_set_compaction SET total=?,done=?,cursor=?,finished_at=? WHERE id=1")
    .run(total, finished ? total : Math.min(done, total), JSON.stringify(cursor), finished ? Date.now() : null);

  // ── phase 1: fill the worklist ───────────────────────────────────────────
  if (cursor.ph === "enumerate") {
    let src: "output" | "session" = cursor.src ?? "output", rowid = cursor.rowid ?? 0, added = cursor.n ?? 0;
    for (;;) {
      const table = src === "output" ? "memory_output_roots" : "memory_session_roots";
      const edge = db.prepare(`SELECT MAX(rowid) AS hi,count(*) AS n FROM (SELECT rowid FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?)`).get(rowid, chunkRows) as { hi: number | null; n: number } | undefined;
      const n = Number(edge?.n ?? 0);
      if (n === 0) {
        if (src === "output") { src = "session"; rowid = 0; continue; }
        // every root has been looked at: the conversion begins (the total is now exact)
        total = added; cursor.ph = "convert"; cursor.k = null; cursor.hand = null; delete cursor.src; delete cursor.rowid; delete cursor.n;
        saveRow();
        break;
      }
      const hi = Number(edge!.hi);
      // The chunk's inserts, the count and the cursor commit as one unit: an interruption between them must not leave rows the cursor does not account for
      // (a retry would add none of them and the exact total would come out short).
      const before = { added, total, rowid, src: cursor.src, rows: cursor.rowid, n: cursor.n };
      db.exec("SAVEPOINT memory_root_set_enumerate");
      try {
        const inserted = db.prepare(`INSERT OR IGNORE INTO ${ROOT_SET_WORKLIST_TABLE}(thread_id,size,set_id) SELECT o.thread_id,r.size,o.set_id FROM ${table} o JOIN memory_root_sets r ON r.set_id=o.set_id
          WHERE o.rowid>? AND o.rowid<=? AND o.set_id<>''`).run(rowid, hi);
        added += Number(inserted.changes); rowid = hi; total = added;
        cursor.src = src; cursor.rowid = rowid; cursor.n = added;
        saveRow();
        db.exec("RELEASE memory_root_set_enumerate");
      } catch (error) {
        db.exec("ROLLBACK TO memory_root_set_enumerate; RELEASE memory_root_set_enumerate");
        added = before.added; total = before.total; rowid = before.rowid; cursor.src = before.src; cursor.rowid = before.rows; cursor.n = before.n;
        throw error;
      }
      result.rows += n;
      if (outOfTime()) { result.remaining = true; return result; }
    }
  }

  // ── phase 2: convert, by keyset seek over the worklist ───────────────────
  const chained = db.prepare("SELECT 1 FROM memory_root_set_parents WHERE set_id=?");
  const parentOf = db.prepare("SELECT parent_id FROM memory_root_set_parents WHERE set_id=?");
  const link = db.prepare("INSERT INTO memory_root_set_parents(set_id,parent_id) VALUES(?,?)");
  const firstRows = db.prepare("SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=?1 ORDER BY root_thread_id,root_message_id LIMIT ?2");
  const nextRows = db.prepare(`SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=?1 AND (root_thread_id,root_message_id)>(?2,?3)
    ORDER BY root_thread_id,root_message_id LIMIT ?4`);
  const rowsOf = (id: string, key: [string, string] | null, limit: number) =>
    (key ? nextRows.all(id, key[0], key[1], limit) : firstRows.all(id, limit)) as Array<{ t: string; m: string }>;
  const batchFirst = db.prepare(WORKLIST_BATCH_SQL.first);
  const batchAfter = db.prepare(WORKLIST_BATCH_SQL.after);
  const forget = db.prepare(`DELETE FROM ${ROOT_SET_WORKLIST_TABLE} WHERE (thread_id,size,set_id)<=(?1,?2,?3)`);
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS memory_root_set_below(t TEXT NOT NULL, m TEXT NOT NULL, PRIMARY KEY(t,m)) WITHOUT ROWID`);
  const addBelow = db.prepare(`INSERT OR IGNORE INTO ${BELOW}(t,m) VALUES(?,?)`);
  const isBelow = db.prepare(`SELECT 1 FROM ${BELOW} WHERE t=? AND m=?`);
  const clearBelow = () => db.exec(`DELETE FROM ${BELOW}`);

  /** The links under `id`, counted up to the limit (a loop or a long chain reads as the limit). */
  const chainDepth = (id: string): number => {
    let depth = 0;
    for (let at: string | null = id; at !== null && depth < COMPACTION_MAX_CHAIN; depth++) {
      const up = parentOf.get(at) as { parent_id: unknown } | undefined;
      at = up ? String(up.parent_id) : null;
    }
    return depth;
  };

  /** Works on one set until it is decided or the budget is gone. "more": out of time, the set is still in hand. */
  const convert = (set: { id: string; size: number }, previous: { id: string; size: number }): "converted" | "kept" | "more" => {
    let work = inHand.get(db);
    if (!work || work.id !== set.id || work.previous.id !== previous.id) {
      clearBelow();
      work = { id: set.id, size: set.size, previous, phase: "count", key: null, counted: 0, chain: null, chainAt: 0, belowRows: 0, belowDistinct: 0, held: 0 };
      // a restart: the count phase carries on from the key the cursor row kept; the phases that rest on the temporary table begin again
      const saved = cursor.hand;
      if (saved && saved.id === set.id && saved.prev.id === previous.id) {
        if (saved.phase === "count") { work.key = saved.key; work.counted = saved.counted; }
        else { work.phase = "below"; work.counted = set.size; } // counted before the restart: only the temporary table is rebuilt
      } else {
        // decided before a single member is read
        if (previous.size > maxCutRows || previous.size >= set.size || chainDepth(previous.id) >= COMPACTION_MAX_CHAIN) return "kept";
      }
      inHand.set(db, work);
    }
    const drop = (verdict: "kept") => { inHand.delete(db); clearBelow(); return verdict; };
    // 1. the set holds exactly its size in rows
    while (work.phase === "count") {
      const rows = rowsOf(set.id, work.key, chunkRows);
      work.counted += rows.length; result.rows += rows.length;
      if (rows.length) work.key = [rows[rows.length - 1]!.t, rows[rows.length - 1]!.m];
      if (work.counted > set.size) return drop("kept");
      if (rows.length < chunkRows) { if (work.counted !== set.size) return drop("kept"); work.phase = "below"; work.key = null; break; }
      if (outOfTime()) return "more";
    }
    // 2. the members of the chain below the predecessor (its own rows, then each parent's), into the temporary set (at most previous.size <= maxCutRows rows)
    if (work.phase === "below") {
      if (!work.chain) {
        // the chain of ids first: parent lookups only, at most COMPACTION_MAX_CHAIN of them
        const ids: string[] = [], seen = new Set<string>();
        for (let at: string | null = previous.id; at !== null;) {
          if (seen.has(at) || ids.length > COMPACTION_MAX_CHAIN) return drop("kept"); // a loop proves nothing, and neither does a chain this long
          seen.add(at); ids.push(at);
          const up = parentOf.get(at) as { parent_id: unknown } | undefined;
          at = up ? String(up.parent_id) : null;
        }
        work.chain = ids; work.chainAt = 0; work.key = null;
      }
      while (work.chainAt < work.chain.length) {
        const id = work.chain[work.chainAt]!;
        for (;;) {
          const rows = rowsOf(id, work.key, chunkRows);
          for (const row of rows) work.belowDistinct += Number(addBelow.run(row.t, row.m).changes);
          work.belowRows += rows.length;
          if (rows.length) work.key = [rows[rows.length - 1]!.t, rows[rows.length - 1]!.m];
          if (work.belowRows > previous.size * 2 + chunkRows || work.belowDistinct > previous.size) return drop("kept"); // far more rows than the predecessor can hold: not a chain this step can prove
          if (rows.length < chunkRows) break;
          if (outOfTime()) return "more";
        }
        work.chainAt++; work.key = null;
        if (work.chainAt < work.chain.length && outOfTime()) return "more";
      }
      if (work.belowDistinct !== previous.size) return drop("kept");
      work.phase = "held"; work.key = null;
    }
    // 3. every member of the chain below is also a row of this set
    while (work.phase === "held") {
      const rows = rowsOf(set.id, work.key, chunkRows);
      for (const row of rows) if (isBelow.get(row.t, row.m)) work.held++;
      if (rows.length) work.key = [rows[rows.length - 1]!.t, rows[rows.length - 1]!.m];
      if (rows.length < chunkRows) break;
      if (outOfTime()) return "more";
    }
    if (work.held !== previous.size) return drop("kept");
    // 4. the cut: the set's rows become just what it adds to its parent. One transaction, bounded by maxCutRows (previous.size).
    db.exec("SAVEPOINT memory_root_set_compaction");
    try {
      const cut = db.prepare(`DELETE FROM memory_root_set_members WHERE set_id=? AND (root_thread_id,root_message_id) IN (SELECT t,m FROM ${BELOW})`).run(set.id);
      link.run(set.id, previous.id);
      // the rows were counted before the cut (exactly the set's size) and every row below was found among them: what the cut removed is the predecessor
      if (Number(cut.changes) !== previous.size) throw new Error("MEMORY_ROOT_SET_COMPACTION_MISMATCH");
      db.exec("RELEASE memory_root_set_compaction");
    } catch (error) { db.exec("ROLLBACK TO memory_root_set_compaction; RELEASE memory_root_set_compaction"); inHand.delete(db); clearBelow(); throw error; }
    result.rows += previous.size;
    inHand.delete(db); clearBelow();
    return "converted";
  };

  /** Saves the place: the last worklist row finished and the set in hand, and forgets the worklist rows behind it in the same unit. */
  const checkpoint = (hand: SetInHand | null) => {
    cursor.hand = hand ? { id: hand.id, prev: hand.previous, phase: hand.phase, key: hand.key, counted: hand.counted } : null;
    db.exec("SAVEPOINT memory_root_set_cursor");
    try {
      if (cursor.k) forget.run(cursor.k[0], cursor.k[1], cursor.k[2]);
      saveRow();
      db.exec("RELEASE memory_root_set_cursor");
    } catch (error) { db.exec("ROLLBACK TO memory_root_set_cursor; RELEASE memory_root_set_cursor"); throw error; }
  };

  let previous: { id: string; size: number } | null = null, previousThread: string | null = null;
  if (cursor.k) {
    const size = db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?").get(cursor.k[2]);
    if (size) { previous = { id: cursor.k[2], size: Number(size.size) }; previousThread = cursor.k[0]; }
  }
  for (;;) {
    const batch = (cursor.k ? batchAfter.all(cursor.k[0], cursor.k[1], cursor.k[2]) : batchFirst.all()) as Array<{ thread_id: string; size: number; set_id: string }>;
    if (!batch.length) {
      inHand.delete(db); clearBelow();
      cursor.k = null; cursor.hand = null;
      db.exec(`DELETE FROM ${ROOT_SET_WORKLIST_TABLE}`);
      saveRow(true);
      db.exec(`DROP TABLE IF EXISTS ${ROOT_SET_WORKLIST_TABLE}`);
      return result;
    }
    for (const row of batch) {
      const thread = String(row.thread_id), id = String(row.set_id), size = Number(row.size);
      if (thread !== previousThread) { previous = null; previousThread = thread; }
      if (chained.get(id)) { previous = { id, size }; result.examined++; done++; }
      else if (previous && previous.size < size) {
        const verdict = convert({ id, size }, previous);
        if (verdict === "more") {
          // the set stays in hand; what was finished before it in this call is saved, nothing of the set itself is committed
          checkpoint(inHand.get(db) ?? null);
          result.remaining = true; return result;
        }
        result.examined++; done++;
        if (verdict === "converted") result.converted++;
        previous = { id, size };
      } else { result.examined++; done++; previous = { id, size }; }
      cursor.k = [thread, size, id]; cursor.hand = null;
      if (outOfTime()) { checkpoint(null); result.remaining = true; return result; }
    }
  }
}

const COLLECT_CURSOR_ID = "root-set-collect-cursor";
/** The roster policy binding (policy.ts POLICY_ID): it sits on the workspace scope. */
const ROSTER_POLICY_BINDING = "memory-roster-policy";
interface CollectCursor { after: string; drain: string | null }
/** The cursor of this connection, for a file with no scope row yet to carry the persisted one. */
const collectCursors = new WeakMap<object, CollectCursor>();
function readCollectCursor(db: DatabaseSync): CollectCursor {
  try {
    const value = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(COLLECT_CURSOR_ID)?.intent ?? "null"));
    if (value && typeof value.after === "string") return { after: value.after, drain: typeof value.drain === "string" ? value.drain : null };
  } catch { /* begins again from the first set */ }
  return { ...(collectCursors.get(db) ?? { after: "", drain: null }) };
}
function writeCollectCursor(db: DatabaseSync, cursor: CollectCursor): void {
  collectCursors.set(db, { ...cursor });
  // rides on the workspace scope, like the shape marker; with no scope yet there is nothing to collect either
  const scope = cursorScope(db);
  if (scope == null) return;
  // the row exists after the first write: a primary-key update of the intent, no other table read
  const updated = db.prepare("UPDATE memory_scope_bindings SET intent=?2 WHERE id=?1").run(COLLECT_CURSOR_ID, JSON.stringify(cursor));
  if (Number(updated.changes) > 0) return;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','root-set-collect',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent,scope_id=excluded.scope_id")
    .run(COLLECT_CURSOR_ID, scope, JSON.stringify(cursor));
}
/** The scope the cursor row rides on, resolved once per connection by primary-key lookups (the cursor's own binding, else the roster binding that sits on the
 * workspace scope) and kept. Only a file with neither falls back to a look at the scopes, once: conversation scopes grow with the retained conversations, so
 * that look is never repeated per collected set. */
const cursorScopes = new WeakMap<object, string>();
function cursorScope(db: DatabaseSync): string | null {
  const known = cursorScopes.get(db);
  if (known !== undefined) return known;
  const found = db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE id IN (?1, ?2) ORDER BY id=?1 DESC LIMIT 1").get(COLLECT_CURSOR_ID, ROSTER_POLICY_BINDING)?.scope_id
    ?? db.prepare("SELECT id FROM memory_scopes WHERE kind='workspace' LIMIT 1").get()?.id
    ?? null;
  if (found == null) return null;
  cursorScopes.set(db, String(found));
  return String(found);
}
/** Sets examined, and member rows deleted, by one slice of the background collection. A set is cut away in chunks of members (never one statement over a
 * large set); the set row goes first and the members after, which is safe because a set's id is its content: members left behind by an interruption
 * are the same members a recreated set would insert, and the next slice finishes draining them (the cursor row names the set being drained). */
export const COLLECT_EXAMINE_SETS = 500;
export const COLLECT_DELETE_ROWS = 4_000;
export interface CollectSlice { removed: number; examined: number; wrapped: boolean; draining: boolean }

/** Writes of the collect cursor so far, for tests that pin it to one per slice. */
let collectCursorWrites = 0;
export function collectCursorWriteCount(): number { return collectCursorWrites; }
/** One bounded slice: examines at most `examine` sets after the persisted cursor (a primary-key range, never the whole table), removes up to `limit` that nothing
 * points at, deletes at most `rows` member rows, and stops when `maxMs` has passed. The slice is one savepoint and writes its cursor once, at its end, in
 * the same unit as its deletes (a cursor written per set cost the owner's preview 632 MB a minute): an interruption loses the whole slice or none of it. */
export function collectRootSetsSlice(db: DatabaseSync, options: { limit?: number; examine?: number; rows?: number; maxMs?: number; now?: () => number } = {}): CollectSlice {
  const { limit = 50, examine = COLLECT_EXAMINE_SETS, rows = COLLECT_DELETE_ROWS, maxMs = 25, now = () => performance.now() } = options;
  const started = now();
  const out: CollectSlice = { removed: 0, examined: 0, wrapped: false, draining: false };
  if (!hasTable(db, "memory_root_set_parents")) { out.wrapped = true; return out; }
  // While the lineage repair is unfinished it holds sets it has built and not yet pointed any reply at (it commits between batches, then
  // carries on from its cached ids). Nothing may be collected until the repair has recorded its end. The test is the repair's own persisted
  // state (no marker, outputs present), so it covers a repair that a restart interrupted as well as one still running in this process.
  if (lineageRepairPending(db)) { out.wrapped = true; return out; }
  const cursor = readCollectCursor(db), before = JSON.stringify(cursor);
  let budget = rows;
  const drainChunk = db.prepare(`DELETE FROM memory_root_set_members WHERE set_id=?1 AND (root_thread_id,root_message_id) IN
    (SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=?1 ORDER BY root_thread_id,root_message_id LIMIT ?2)`);
  const setExists = db.prepare("SELECT 1 FROM memory_root_sets WHERE set_id=?");
  db.exec("SAVEPOINT memory_root_set_collect");
  try {
    let examineMore = true;
    if (cursor.drain !== null) {
      // finishing a set an earlier slice began: only while its row is still gone (a recreated set is somebody's again)
      if (setExists.get(cursor.drain)) cursor.drain = null;
      else {
        const gone = Number(drainChunk.run(cursor.drain, budget).changes);
        if (gone >= budget) { out.draining = true; examineMore = false; }
        else { cursor.drain = null; budget -= gone; }
      }
    }
    if (examineMore) {
      const batch = db.prepare("SELECT set_id FROM memory_root_sets WHERE set_id>? ORDER BY set_id LIMIT ?").all(cursor.after, examine).map(row => String(row.set_id));
      const unreferenced = db.prepare(`SELECT 1 FROM memory_root_sets r WHERE r.set_id=?1 AND NOT EXISTS (SELECT 1 FROM memory_output_roots o WHERE o.set_id=r.set_id)
        AND NOT EXISTS (SELECT 1 FROM memory_session_roots s WHERE s.set_id=r.set_id) AND NOT EXISTS (SELECT 1 FROM memory_root_set_parents p WHERE p.parent_id=r.set_id)`);
      const dropSet = db.prepare("DELETE FROM memory_root_sets WHERE set_id=?"), dropLink = db.prepare("DELETE FROM memory_root_set_parents WHERE set_id=?");
      let last = cursor.after;
      for (const id of batch) {
        if (out.removed >= limit || budget <= 0 || out.draining || now() - started >= maxMs) break;
        last = id; out.examined++;
        if (!unreferenced.get(id)) continue;
        dropSet.run(id); dropLink.run(id);
        const gone = Number(drainChunk.run(id, budget).changes);
        budget -= gone;
        if (budget <= 0) { cursor.drain = id; out.draining = true; }
        out.removed++;
      }
      if (out.examined === batch.length && batch.length < examine) { cursor.after = ""; out.wrapped = true; }
      else cursor.after = last;
    }
    if (JSON.stringify(cursor) !== before || out.wrapped) { writeCollectCursor(db, cursor); collectCursorWrites++; }
    db.exec("RELEASE memory_root_set_collect");
  } catch (error) { db.exec("ROLLBACK TO memory_root_set_collect; RELEASE memory_root_set_collect"); collectCursors.delete(db); throw error; }
  return out;
}

/** Removes up to `limit` root sets nothing points at: no reply, no session, no set chained to it. Returns how many went. One bounded slice of the
 * background collection (see collectRootSetsSlice). */
export function collectRootSets(db: DatabaseSync, limit = 50): number {
  return collectRootSetsSlice(db, { limit }).removed;
}

/** The write-ahead log is cut back to nothing once it passes this (and at idle). */
export const WAL_TRUNCATE_BYTES = 64 * 1048576;
/** The log a nudge itself leaves behind (one page-1 frame): an idle sweep does not write again to shrink that. */
export const WAL_QUIET_BYTES = 16 * 1024;
/** Free pages worth a VACUUM at start-up: past this, and past a fifth of the file. */
const RECLAIM_MIN_BYTES = 64 * 1048576;
const VACUUM_SPARE_BYTES = 256 * 1048576;
function diskFree(path: string): number | null {
  try { const stats = statfsSync(dirname(path)); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
}

export type StartupStorageEvent = { phase: "converting"; done: number; total: number } | { phase: "reclaiming"; dbBytes: number };
export interface StartupStorageOptions {
  onProgress?: (event: StartupStorageEvent) => void;
  freeDiskBytes?: (path: string) => number | null;
  reclaimMinBytes?: number;
  reclaimFraction?: number;
  sliceMs?: number;
  /** The most the conversion may take before the server listens (1.0.2 lineage-cold r3): what is left is finished after listen, a short
   * step at a time, in the idle sweep (maintainLineageStorage). A converted set and a full one are both valid, so readers never wait on it. */
  budgetMs?: number;
  /** The largest file the one VACUUM may rewrite before the server listens: a larger file keeps its free pages, which SQLite reuses
   * before it grows the file, so start-up never waits on a rewrite that follows the size of the history. */
  vacuumMaxBytes?: number;
  now?: () => number;
}
export interface StartupStorageResult { converted: boolean; vacuumed: boolean; skippedForDisk: boolean; unfinished?: boolean }
/** The conversion's share of start-up, and the largest file start-up rewrites (see StartupStorageOptions). */
export const STORAGE_STARTUP_BUDGET_MS = 2_000;
export const VACUUM_STARTUP_MAX_BYTES = 1024 * 1024 * 1024;

/** Finishes a pending conversion (resumable, one transaction per set, progress after every slice), as a loop with no end but the
 * conversion's: used where nothing else is waiting. The background job uses compactRootSetsStep in slices instead. When the space the
 * conversion freed is too small to be worth a rewrite of the file, it is recorded as handed back (nothing to offer the owner). */
export function finishLineageConversion(db: DatabaseSync, options: StartupStorageOptions = {}): boolean {
  const row = compactionRow(db);
  if (!row || !unset(row.finished_at)) return false;
  const report = (event: StartupStorageEvent) => { try { options.onProgress?.(event); } catch { /* a status note never stops start-up */ } };
  // Lineage rows hold ids, never words, and a later hand-back rewrites the file: the conversion need not zero every page it frees.
  const secure = pragmaNumber(db, "secure_delete");
  db.exec("PRAGMA secure_delete=FAST");
  try {
    for (;;) {
      const step = compactRootSetsStep(db, { maxMs: options.sliceMs ?? 250 });
      const now = compactionRow(db)!;
      report({ phase: "converting", done: Math.min(Number(now.total), Number(now.done)), total: Number(now.total) });
      if (!step.remaining) break;
    }
  } finally { db.exec(`PRAGMA secure_delete=${secure === 1 ? "ON" : secure === 2 ? "FAST" : "OFF"}`); }
  settleReclaim(db, options);
  return true;
}
/** After a conversion: records the space as handed back when there is none worth a rewrite; otherwise leaves it for the owner. */
export function settleReclaim(db: DatabaseSync, options: StartupStorageOptions = {}): void {
  const row = compactionRow(db);
  if (!row || unset(row.finished_at) || !unset(row.reclaimed_at)) return;
  // The retained v6 index is space still to hand back: nothing is settled while it is in the file, whatever the free pages say.
  if (legacyIndexPending(db)) return;
  if (!worthReclaiming(db, options)) db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now());
}
/** Whether the free pages inside the file are enough to be worth a rewrite of it. */
function worthReclaiming(db: DatabaseSync, options: StartupStorageOptions): boolean {
  const file = mainFile(db), total = file ? fileBytes(file) : 0;
  const free = pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size");
  return !(free === 0 || free < (options.reclaimMinBytes ?? RECLAIM_MIN_BYTES) || free < total * (options.reclaimFraction ?? 0.2));
}

/** A VACUUM may renumber rowids, which a waiting revocation job's cursors use: no rewrite while one is waiting (1.0.2 revoke-bounded r3).
 * (memory-revocation.ts REVOCATION_JOB_SUBJECT; read here directly so this start-up module imports nothing of the runner) */
function revocationJobWaiting(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation' LIMIT 1").get());
}

/** The owner's action "hand the space back": one VACUUM, only when the disk has room for the rewrite (about the file's size beside it).
 * Short of room it does nothing, the state becomes waiting-for-disk with a plain sentence, and a later call tries again. Never throws for want of disk. */
export function reclaimLineageSpace(db: DatabaseSync, options: StartupStorageOptions = {}): StartupStorageResult {
  const result: StartupStorageResult = { converted: false, vacuumed: false, skippedForDisk: false };
  const row = compactionRow(db);
  if (!row || unset(row.finished_at) || !unset(row.reclaimed_at)) return result;
  // A rewrite of the file renumbers rowids, and the rowid floors of the integrity pass name what was written before it: not while it is going on.
  if (integrityFlags(db).pending) return result;
  if (revocationJobWaiting(db)) return result;
  const report = (event: StartupStorageEvent) => { try { options.onProgress?.(event); } catch { /* a status note never stops the hand-back */ } };
  const file = mainFile(db), total = file ? fileBytes(file) : 0;
  // VACUUM writes the whole file again beside the old one: about its size free.
  const available = (options.freeDiskBytes ?? diskFree)(file);
  if (available !== null && available < total + VACUUM_SPARE_BYTES) {
    result.skippedForDisk = true; diskShort.add(db);
    console.warn(`[memory] ${WAITING_MESSAGE}`);
    return result;
  }
  report({ phase: "reclaiming", dbBytes: total });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // the v6 member index (kept by the upgrade because freeing it blocked the server for minutes): it goes here, in the owner's action
    db.exec(`DROP INDEX IF EXISTS ${LEGACY_MEMBER_INDEX}`);
    // the rewrite only when the pages now free are worth it; otherwise the hand-back is over with the index gone
    if (!worthReclaiming(db, options)) {
      db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now());
      diskShort.delete(db);
      return result;
    }
    // later frees come back in small steps (incremental vacuum in the idle sweep)
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("VACUUM");
    verifyDerivedRows(db); // a rewrite of the file that moved rowids sends the derived transcript tables back to be filled
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now());
    diskShort.delete(db);
    result.vacuumed = true;
  } catch (error) {
    // short of disk after all, or anything else: memory is whole either way, a later call tries again
    result.skippedForDisk = true; diskShort.add(db);
    console.warn(`[memory] the space hand-back was skipped (${error instanceof Error ? error.message : String(error)}); it can be tried again`);
  }
  return result;
}

const RECLAIM_WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=60000");
  const number = (name) => { const row = db.prepare("PRAGMA " + name).get(); return row ? Number(Object.values(row)[0] || 0) : 0; };
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("DROP INDEX IF EXISTS " + workerData.index);
  const total = (() => { try { return fs.statSync(workerData.file).size; } catch { return 0; } })();
  const free = number("freelist_count") * number("page_size");
  const worthwhile = !(free === 0 || free < workerData.minBytes || free < total * workerData.fraction);
  if (worthwhile) {
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  db.close();
  parentPort.postMessage({ ok: true, vacuumed: worthwhile });
} catch (error) {
  try { db && db.close(); } catch {}
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
}
`;
/** The owner's hand-back, off the serving thread: the index drop and the rewrite run on a connection of their own in a worker, with owner writes held
 * (asynchronously, so health and reads keep answering) for as long as they take. Same rules as reclaimLineageSpace; resolves with its result. */
export function reclaimLineageSpaceInWorker(db: DatabaseSync, options: StartupStorageOptions & { hold?: (on: boolean) => void } = {}): Promise<StartupStorageResult> {
  const result: StartupStorageResult = { converted: false, vacuumed: false, skippedForDisk: false };
  const row = compactionRow(db);
  if (!row || unset(row.finished_at) || !unset(row.reclaimed_at)) return Promise.resolve(result);
  if (integrityFlags(db).pending) return Promise.resolve(result); // (see reclaimLineageSpace)
  if (revocationJobWaiting(db)) return Promise.resolve(result);
  const file = mainFile(db), total = file ? fileBytes(file) : 0;
  const available = (options.freeDiskBytes ?? diskFree)(file);
  if (available !== null && available < total + VACUUM_SPARE_BYTES) {
    result.skippedForDisk = true; diskShort.add(db);
    console.warn(`[memory] ${WAITING_MESSAGE}`);
    return Promise.resolve(result);
  }
  try { options.onProgress?.({ phase: "reclaiming", dbBytes: total }); } catch { /* a status note never stops the hand-back */ }
  return new Promise<StartupStorageResult>(resolve => {
    let settled = false;
    const finish = (ok: boolean, vacuumed: boolean, message?: string) => {
      if (settled) return; settled = true;
      try { options.hold?.(false); } catch { /* released */ }
      if (ok) {
        try { db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now()); } catch { /* the next start settles it */ }
        diskShort.delete(db); result.vacuumed = vacuumed;
        if (vacuumed) { try { verifyDerivedRows(db); } catch { /* the next start checks again */ } } // a rewrite of the file that moved rowids sends the derived transcript tables back to be filled
      } else { result.skippedForDisk = true; diskShort.add(db); console.warn(`[memory] the space hand-back was skipped (${message ?? "unknown"}); it can be tried again`); }
      resolve(result);
    };
    try {
      options.hold?.(true);
      const worker = new Worker(RECLAIM_WORKER_SOURCE, { eval: true, workerData: { file, index: LEGACY_MEMBER_INDEX, minBytes: options.reclaimMinBytes ?? RECLAIM_MIN_BYTES, fraction: options.reclaimFraction ?? 0.2 } });
      worker.on("message", (message: { ok: boolean; vacuumed?: boolean; message?: string }) => finish(message.ok, Boolean(message.vacuumed), message.message));
      worker.on("error", (error: Error) => finish(false, false, error.message));
      worker.on("exit", () => finish(false, false, "the worker ended early"));
      worker.unref();
    } catch (error) { finish(false, false, error instanceof Error ? error.message : String(error)); }
  });
}

/** The old start-up behaviour in one call: converts, then hands the space back when the disk has room. Production no longer calls it
 * (the conversion runs in the background and the hand-back is the owner's action); kept for the callers and tests that want both at once. */
export function finishLineageStorageAtStartup(db: DatabaseSync, options: StartupStorageOptions = {}): StartupStorageResult {
  const result: StartupStorageResult = { converted: false, vacuumed: false, skippedForDisk: false };
  const row = compactionRow(db);
  if (!row) return result;
  if (unset(row.finished_at)) result.converted = finishLineageConversion(db, options);
  if (!unset(compactionRow(db)?.reclaimed_at)) return result;
  if (revocationJobWaiting(db)) return result;
  const file = mainFile(db), total = file ? fileBytes(file) : 0;
  const free = pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size");
  if (!legacyIndexPending(db) && (free === 0 || free < (options.reclaimMinBytes ?? RECLAIM_MIN_BYTES) || free < total * (options.reclaimFraction ?? 0.2))) { db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now()); return result; }
  const hand = reclaimLineageSpace(db, options);
  return { ...result, vacuumed: hand.vacuumed, skippedForDisk: hand.skippedForDisk };
}

export interface StorageMaintenanceOptions {
  database: () => DatabaseSync;
  /** No turn running and no recent owner action. */
  idle: () => boolean;
  /** Whether the I/O budget asks background work to wait. */
  defer?: () => boolean;
  pauseMs?: number;
  signal?: AbortSignal;
}
/** Slices of root-set collection one background pass may take. */
export const MAINTAIN_SLICES = 40;
const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** One background pass (the memory worker's idle sweep): only short writes,
 * with pauses between them, so turns and the UI keep the event loop and the
 * lock. Collects unused sets, cuts the log back, and where the file has
 * incremental vacuum, hands free pages back a few megabytes at a time. */
export async function maintainLineageStorage(options: StorageMaintenanceOptions): Promise<LineageStorageStatus> {
  const { pauseMs = 60, signal } = options;
  // an owner turn (or any turn) going on stops the pass between slices: the next idle pass carries on from the cursor
  const stop = () => Boolean(signal?.aborted) || Boolean(options.defer?.()) || !options.idle();
  // A lap over the sets is many bounded slices with a pause between them; a pass takes at most MAINTAIN_SLICES and the cursor carries on at the next.
  // (retired, S6: the sets are never written and are being handed back by root-set-reclaim.ts: nothing to collect)
  for (let slices = 0; !stop() && slices < MAINTAIN_SLICES && !readTimeRetired(options.database()); slices++) {
    const slice = collectRootSetsSlice(options.database());
    if (slice.wrapped && slice.removed === 0 && !slice.draining) break;
    await pause(pauseMs);
  }
  let db = options.database();
  if (!stop() && pragmaNumber(db, "auto_vacuum") === 2) {
    let rounds = 0;
    while (!stop() && pragmaNumber(db, "freelist_count") > 0 && rounds++ < 64) {
      db.exec("PRAGMA incremental_vacuum(512)");
      await pause(pauseMs);
      db = options.database();
    }
  }
  const status = lineageStorageStatus(db);
  if (!stop() && (status.walBytes > WAL_TRUNCATE_BYTES || (options.idle() && status.walBytes > WAL_QUIET_BYTES))) await settleWal({ nudge: true });
  return lineageStorageStatus(db);
}
