import { runtimeStepWalBytes, runtimeMergeWalBytes } from "./index-wal.ts";
import { secureDeleteFts } from './fts-delete.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The search index in age order (1.0.3 lane 2, LANE2-MEMORY-DESIGN r2.3, r3.5, M6), built by the MEMW staged bulk (1.0.18 Part A,
// spec 1.12, design r2.0 D0-D12). Owner search walks the word table by its rowid (FTS5 reads a term's postings in rowid order natively),
// so when every record's FTS row sits at `rowid = age_key` (schema.ts RECORD_KEYS_SCHEMA) the walk is a newest-first stream that costs
// the rows it returns. An index an earlier build wrote has automatic rowids in projection order. It is never rekeyed in place: a second
// word table, `lexical_age` (the same FTS5 definition) with `lexical_age_keys` (the exact columns of `lexical_keys`), is built in phases
// (D0 `age_phase`): validate0 (a b18 partial fill is checked first), fill (newest-first prefixes below the frontier `age_fill_below`,
// copied into `lexical_age` with a stage row `age_stage` and an entry map `age_emap`), validate (pre-existing key rows, then a walk of
// `entries` for missing copies), keys (`lexical_age_keys` from the stage, oldest first), stage_drop (the stage and map leave in bounded
// deletes), cut (ONE transaction of renames: `lexical` -> `lexical_retired`, the age tables -> the legacy names, `lexical_rowids`='age',
// the generation moves) and retiring (the retired table is emptied in bounded deletes with merge passes, then dropped). Every step is
// one checked write of the index writer (memw-steps.ts IndexWriter / index-wal.ts), sized by the D3 sizer and admitted first; nothing
// here checkpoints (the writer's check does). Anything in doubt fails closed (D7): `age_fill_blocked`, the fill stops, search keeps
// mode F, and only an index reset clears it.
import { metaPutter } from "./index-wal.ts";
import { existsSync } from "node:fs";
import { DatabaseSync } from "../sqlite-open.ts";
import { runtimeMergePages, MEMW_MERGE_PAGES, MEMW_ROW_BYTES, MEMW_SEGMENT_GATE, rowX, SegmentWatch, segmentGateOpen, structureSegments, utf8, type AdmitKind, type IndexWriter, type StepKind, type StepSizer } from "./memw-steps.ts";
import { runOpenRuleForDowngrade, type ChargeTransport } from "./index-wal.ts";

export const LEXICAL_ROWIDS = "lexical_rowids";
export const AGE_FILL_BELOW = "age_fill_below";
export const LEXICAL_GENERATION = "lexical_generation";
const AGE_SWEEP_AFTER = "age_sweep_after";
const AGE_FILL_REMAINING = "age_fill_remaining";
export const AGE_PHASE = "age_phase";
export const AGE_FILL_BLOCKED = "age_fill_blocked";
/** The staged bulk's durable cursors and counters (D0, D4, D8, D11). */
const C = {
  v0: "age_v0_cursor", va: "age_va_cursor", vb: "age_vb_cursor", vbPass: "age_vb_pass", unkeyed: "age_unkeyed", keys: "age_keys_cursor",
  sum: "age_sum_cursor", sumDone: "age_sum_done", text: "age_text_left", rows: "age_rows_left", idBytes: "age_id_left",
  rLeft: "retire_left", rBase: "retire_base", rSince: "retire_since", rDel: "retire_deleted", rMerge: "retire_merge",
} as const;
const STAGED_META_KEYS = [AGE_PHASE, AGE_FILL_BLOCKED, ...Object.values(C)];
export const AGE_META_KEYS = [LEXICAL_ROWIDS, AGE_FILL_BELOW, LEXICAL_GENERATION, AGE_SWEEP_AFTER, AGE_FILL_REMAINING, ...STAGED_META_KEYS];
/** The MEMW index_meta rows the downgrade removes (D12; overrun_k:<kind> by prefix). */
export const MEMW_META_KEYS = ["lexical_keys_complete", "lexical_keys_cursor", "entries_live", "entries_live_recount", "reset_done"];
/** Kept for the callers that pass a slice cap (tests); the D3 sizer decides the size, this only caps it further. */
export const AGE_FILL_SLICE_KEYS = 256;
export const AGE_FILL_SLICE_BYTES = 1024 * 1024;
/** Free space the fill keeps beyond its reservation (D11). */
export const AGE_FILL_RESERVE_BYTES = 64 * 1024 * 1024;
/** D11: the WAL term of the reservation (over-covers C = 28 MiB). */
export const AGE_RESERVE_WAL_BYTES = 62 * 1024 * 1024;
export const AGE_SWEEP_SLICE_ROWS = 256;
/** D6: rows one purge_pending step removes, at most. */
export const AGE_PURGE_STEP_ROWS = 2_048;
/** D4: full (b) passes before a still-unkeyed row is judged. */
export const AGE_VALIDATE_PASSES = 3;
/** D8 RETIRE step: rows of `lexical_retired_keys` one retirement step deletes (sizer a3dfa7be11d9df3d1, target worst <= 200 ms at 500k).
 * 800 from the owner sizer evidence (hz _reviews/memw-r3-evidence/r32/retire/rt-p48.jsonl, deletesteps/sizersummary lines 12260/12264). A zero, negative or non-integer value FAILS CLOSED (retireStepRows throws). */
export const MEMW_RETIRE_STEP_ROWS: number = 800; // largest per-step delete row count measured in r32/retire/rt-p48.jsonl (746 sizer delete steps: max 829 rows, worst 43.8 ms, max rise 1.261 MB, 0 breaches)
export function retireStepRows(): number {
  const n = ageTestHooks.retireStepRows ?? MEMW_RETIRE_STEP_ROWS;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("MEMW_RETIRE_STEP_ROWS_UNSET");
  return Math.min(n,runtimeMergePages());
}
/** D8 RETIRE step: pages per merge step of a retirement merge pass on `lexical_retired` (the smaller retire constant; the deletes
 * themselves are sized by the D3 sizer, kind delete). MEMW owner + MurageMain (11-07): p48, measured at 500k by the owner's sizer run
 * (r32/retire evidence): worst 228.1 ms (n=145) against the 200 ms goal (p32: 231.8 ms, no better), under the hard 250 ms line; no
 * value below 32. An unset or bad value FAILS CLOSED (retireMergePages throws), never a silent default. */
export const MEMW_RETIRE_MERGE_PAGES: number = 48;
export const MEMW_RETIRE_MERGE_PAGES_MIN = 32;
/** Test seam only: proves the fail-closed check. Never set by product code. */
export const ageTestHooks: { retireMergePages?: number; retireStepRows?: number; retiredSegments?: number } = {};
export function retireMergePages(): number {
  const n = ageTestHooks.retireMergePages ?? MEMW_RETIRE_MERGE_PAGES;
  if (!Number.isSafeInteger(n) || n < MEMW_RETIRE_MERGE_PAGES_MIN || n > MEMW_MERGE_PAGES) throw new Error("MEMW_RETIRE_MERGE_PAGES_UNSET");
  return n;
}

export const LEXICAL_AGE_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS lexical_age USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS lexical_age_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));`;
/** D1: phases fill/validate/keys only. nk = -age_key (newest-first copies append at the right edge); erow = entries.rowid. */
export const AGE_STAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS age_stage(nk INTEGER PRIMARY KEY,id TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS age_emap(erow INTEGER PRIMARY KEY,age_key INTEGER NOT NULL);`;
export const PURGE_PENDING_SCHEMA = "CREATE TABLE IF NOT EXISTS purge_pending(id TEXT PRIMARY KEY) WITHOUT ROWID";

const meta = (db: DatabaseSync, key: string): string | null => { const row = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return row ? String(row.value) : null; };
const setMeta = (db: DatabaseSync, key: string, value: string) => metaPutter(db)(key, value);
const delMeta = (db: DatabaseSync, ...keys: string[]) => db.prepare("DELETE FROM index_meta WHERE key IN (SELECT value FROM json_each(?))").run(JSON.stringify(keys));
const num = (db: DatabaseSync, key: string, fallback = 0) => { const v = meta(db, key); return v === null ? fallback : Number(v); };
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'").get(name));
const sameRecord = (a: Record<string, unknown> | undefined, id: string, version: number) => Boolean(a && String(a.id) === id && Number(a.version) === version);

/** Whether every FTS row of `lexical` sits at its record's age key (mode R of owner search). */
export function lexicalRowidsAged(db: DatabaseSync): boolean { return meta(db, LEXICAL_ROWIDS) === "age"; }
/** Moves at every cutover (and index reset): a page cursor carries it, and one from another generation is refused. */
export function lexicalGeneration(db: DatabaseSync): number { return Number(meta(db, LEXICAL_GENERATION) ?? 0); }
/** The fill's frontier: every record with age_key >= this is in `lexical_age`. Null before the fill wrote anything. */
export function ageFillBelow(db: DatabaseSync): number | null { const value = meta(db, AGE_FILL_BELOW); return value === null ? null : Number(value); }
/** Whether the second word table exists (mode F of owner search reads it). */
export function ageTablesPresent(db: DatabaseSync): boolean { return hasTable(db, "lexical_age"); }
/** D7: the reason the staged bulk stopped, or null. Only an index reset clears it. */
export function ageFillBlocked(db: DatabaseSync): string | null { return meta(db, AGE_FILL_BLOCKED); }

// D0 phase, kept in memory from the commit that changed it (this module is the only writer of it) --------------------------------
export type AgePhase = "validate0" | "fill" | "validate" | "keys" | "stage_drop" | "cut" | "retiring";
const PHASES: readonly AgePhase[] = ["validate0", "fill", "validate", "keys", "stage_drop", "cut", "retiring"];
const phaseCache = new WeakMap<DatabaseSync, AgePhase | null>();
export function agePhase(db: DatabaseSync): AgePhase | null {
  if (phaseCache.has(db)) return phaseCache.get(db)!;
  const v = meta(db, AGE_PHASE);
  const phase = v !== null && (PHASES as readonly string[]).includes(v) ? v as AgePhase : null;
  phaseCache.set(db, phase);
  return phase;
}
/** Forget the cached phase (a step rolled back, or another handle changed the file). */
export function forgetAgePhase(db: DatabaseSync): void { phaseCache.delete(db); }
/** Whether any MEMW staged-bulk object exists (D5 ON CONFLICT entries, D6 purge_pending). */
export function ageObjectsPresent(db: DatabaseSync): boolean { return agePhase(db) !== null || ageTablesPresent(db) || hasTable(db, "purge_pending"); }

/** An index with no word row yet needs no fill: its rowids are age keys from the first row. The mark inside the `open` txn (1.3 step 10). */
export function markFreshIndexAgedInTxn(db: DatabaseSync): boolean {
  if (lexicalRowidsAged(db)) return true;
  if (db.prepare("SELECT 1 FROM lexical_keys LIMIT 1").get()) return false;
  setMeta(db, LEXICAL_ROWIDS, "age"); if (meta(db, LEXICAL_GENERATION) === null) setMeta(db, LEXICAL_GENERATION, "1");
  return true;
}
/** Makes the second word table and its keys (schema pages only). Test fixtures and b18 states only; the staged bulk creates its objects in its own step. */
export function ensureAgeTables(db: DatabaseSync): void {
  if (ageTablesPresent(db) && hasTable(db, "lexical_age_keys")) { secureDeleteFts(db, "lexical_age"); return; }
  db.exec("BEGIN IMMEDIATE");
  try { db.exec(LEXICAL_AGE_SCHEMA); secureDeleteFts(db, "lexical_age"); db.exec("COMMIT"); }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
}

/** The segment gate exactly as index.ts applyBatch applies it: every word table a bulk step may write (`lexical`, and `lexical_age` once it exists). A fill
 * step and a sweep step refuse above it, so a floored, stopped or owed table never gains a level-0 segment from the staged bulk (HIGH, WP3 S6). */
export function ageGateOpen(db: DatabaseSync): boolean { return segmentGateOpen([ftsSegments(db, "lexical"), ...ageTablesPresent(db) ? [ftsSegments(db, "lexical_age")] : []]); }
/** The segment count of an FTS table from its structure record (index.ts segmentCount reads the same row). */
export function ftsSegments(db: DatabaseSync, table: string): number {
  if (!/^lexical(_age|_retired)?$/.test(table)) throw new Error("MEMORY_INDEX_TABLE");
  return structureSegments(db.prepare(`SELECT block FROM ${table}_data WHERE id=10`).get()?.block as Uint8Array | undefined) ?? 0;
}

// D7 -------------------------------------------------------------------------------------------------------------------------------
/** A D5 dual write or D4 repair whose destination holds another record. The writer's txn rolls back; the batch fails, receipts pending. */
export class AgeBlocked extends Error { readonly name = "AgeBlocked"; readonly reason: string; constructor(reason: string) { super(`MEMORY_INDEX_AGE_BLOCKED:${reason}`); this.reason = reason; } }
export const isAgeBlocked = (error: unknown): error is AgeBlocked => (error as { name?: string } | null)?.name === "AgeBlocked";
/** Blocks owed by a rolled-back writer txn, written by the next staged step (its own checked write). */
const owedBlocks = new WeakMap<DatabaseSync, string>();
/** index.ts applyBatch: a group rolled back on AgeBlocked. The block is written by the next ageStep; until then no group writes. */
export function noteAgeBlocked(db: DatabaseSync, error: AgeBlocked): void { if (!owedBlocks.has(db)) owedBlocks.set(db, error.reason); }
export function ageBlockOwed(db: DatabaseSync): boolean { return owedBlocks.has(db) || ageFillBlocked(db) !== null; }

// D5 dual writes, inside the writer's group txn -----------------------------------------------------------------------------------
/** The record at `lexical_age` rowid=key: by lexical_age_keys, else age_stage, else the FTS row itself (null: empty). */
function ageOccupant(db: DatabaseSync, key: number): { id: string; version: number } | null {
  const k = db.prepare("SELECT id,version FROM lexical_age_keys WHERE fts_rowid=?").get(key);
  if (k) return { id: String(k.id), version: Number(k.version) };
  if (hasTable(db, "age_stage")) { const s = db.prepare("SELECT id,version FROM age_stage WHERE nk=?").get(-key); if (s) return { id: String(s.id), version: Number(s.version) }; }
  const f = db.prepare("SELECT id,CAST(version AS INTEGER) AS version FROM lexical_age WHERE rowid=?").get(key);
  return f ? { id: String(f.id), version: Number(f.version) } : null;
}
const STAGING: ReadonlySet<AgePhase> = new Set(["validate0", "fill", "validate"]);
/** D5 delete: removes (id,version)'s age-side rows in every staged generation: `lexical_age` (looked up by lexical_age_keys, else
 * entries PK -> rowid -> age_emap) with its key, stage and map rows, and `lexical_retired` through `lexical_retired_keys` (D8). Call it
 * before the entries row is deleted. True when it removed an FTS row (the caller owes the merge). */
export function ageDeleteRecord(db: DatabaseSync, id: string, version: number): boolean {
  let removed = false;
  if (ageTablesPresent(db)) {
    let key: number | null = null;
    const k = db.prepare("SELECT fts_rowid FROM lexical_age_keys WHERE id=? AND version=?").get(id, version);
    if (k) key = Number(k.fts_rowid);
    const entry = db.prepare("SELECT rowid AS r FROM entries WHERE id=? AND version=?").get(id, version);
    const emap = entry && hasTable(db, "age_emap") ? db.prepare("SELECT age_key FROM age_emap WHERE erow=?").get(Number(entry.r)) : undefined;
    if (key === null && emap) key = Number(emap.age_key);
    if (key !== null) {
      const row = db.prepare("SELECT id,CAST(version AS INTEGER) AS version FROM lexical_age WHERE rowid=?").get(key);
      if (row && !sameRecord(row, id, version)) throw new AgeBlocked("delete_destination_other_record");
      if (row) { ageMoveToDebt(db, "lexical_age", ftsTextBytes(db, "lexical_age", key)); db.prepare("DELETE FROM lexical_age WHERE rowid=?").run(key); removed = true; }
      db.prepare("DELETE FROM lexical_age_keys WHERE id=? AND version=?").run(id, version);
      if (hasTable(db, "age_stage")) db.prepare("DELETE FROM age_stage WHERE nk=? AND id=? AND version=?").run(-key, id, version);
    }
    if (emap) db.prepare("DELETE FROM age_emap WHERE erow=?").run(Number(entry!.r));
  }
  if (agePhase(db) === "retiring" && hasTable(db, "lexical_retired_keys")) {
    const r = db.prepare("SELECT fts_rowid FROM lexical_retired_keys WHERE id=? AND version=?").get(id, version);
    if (r) {
      ageMoveToDebt(db, "lexical_retired", ftsTextBytes(db, "lexical_retired", Number(r.fts_rowid)));
      db.prepare("DELETE FROM lexical_retired WHERE rowid=?").run(Number(r.fts_rowid));
      db.prepare("DELETE FROM lexical_retired_keys WHERE id=? AND version=?").run(id, version);
      bumpRetired(db, 1); removed = true;
    }
  }
  return removed;
}
/** D5 insert: the new row at its age key in `lexical_age`, with a stage and map row (phases validate0/fill/validate) or its key row
 * (keys on). Destination check first: another record there throws AgeBlocked (never the b18 eviction). An unkeyed row (ageKey null) is
 * written to `lexical` only by the caller and found by D4 (b). */
export function ageInsertRecord(db: DatabaseSync, id: string, version: number, text: string, entryRowid: number, ageKey: number | null): void {
  if (ageKey === null || !ageTablesPresent(db) || agePhase(db) === "retiring") return;
  if (owedBlocks.has(db) || ageFillBlocked(db) !== null) throw new AgeBlocked(ageFillBlocked(db) ?? owedBlocks.get(db)!);
  const occupant = ageOccupant(db, ageKey);
  if (occupant) throw new AgeBlocked(sameRecord(occupant, id, version) ? "dual_write_copy_exists" : "dual_write_destination_other_record");
  db.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,?,?)").run(ageKey, id, version, text);
  ageAddText(db, "lexical_age", utf8(text));
  const phase = agePhase(db);
  if (phase !== null && STAGING.has(phase) && hasTable(db, "age_stage")) {
    db.prepare("INSERT INTO age_stage VALUES(?,?,?)").run(-ageKey, id, version);
    db.prepare("INSERT OR REPLACE INTO age_emap VALUES(?,?)").run(entryRowid, ageKey);
  } else db.prepare("INSERT INTO lexical_age_keys VALUES(?,?,?)").run(id, version, ageKey);
}
// 1.8 T_t counters (index_meta text_bytes:<t> / debt_bytes:<t>, WP2a), moved in the same txn as the FTS row change ------------------
/** Text bytes added to an FTS generation (a copy or dual write). */
/** A generation with no counter (an inherited b18 table) stays without one: the merge predictor then falls back to the larger
 * `lexical` figure (fail closed), never a partial count. */
export function ageAddText(db: DatabaseSync, table: string, bytes: number): void { if (bytes > 0 && meta(db, `text_bytes:${table}`) !== null) setMeta(db, `text_bytes:${table}`, String(num(db, `text_bytes:${table}`) + bytes)); }
/** Text bytes removed from an FTS generation: live text becomes merge debt until a merge pass clears it. */
export function ageMoveToDebt(db: DatabaseSync, table: string, bytes: number): void {
  if (bytes <= 0 || meta(db, `text_bytes:${table}`) === null) return;
  setMeta(db, `text_bytes:${table}`, String(Math.max(0, num(db, `text_bytes:${table}`) - bytes)));
  setMeta(db, `debt_bytes:${table}`, String(num(db, `debt_bytes:${table}`) + bytes));
}
const ftsTextBytes = (db: DatabaseSync, table: string, rowid: number) => Number(db.prepare(`SELECT length(CAST(text AS BLOB)) AS n FROM ${table} WHERE rowid=?`).get(rowid)?.n ?? 0);
function bumpRetired(db: DatabaseSync, n: number): void {
  setMeta(db, C.rLeft, String(Math.max(0, num(db, C.rLeft) - n)));
  setMeta(db, C.rSince, String(num(db, C.rSince) + n));
  setMeta(db, C.rDel, String(num(db, C.rDel) + n));
}

// D6 purge_pending ---------------------------------------------------------------------------------------------------------------
/** Whether search and browse must drop this id (one indexed probe per returned row; readers call it per row). */
export function purgePendingHas(db: DatabaseSync, id: string): boolean { return hasTable(db, "purge_pending") && Boolean(db.prepare("SELECT 1 FROM purge_pending WHERE id=?").get(id)); }
export function purgePendingOwed(db: DatabaseSync): boolean { return hasTable(db, "purge_pending") && Boolean(db.prepare("SELECT 1 FROM purge_pending LIMIT 1").get()); }
/** purgeRecords while MEMW objects exist: ONE txn lists the ids (unreadable from this commit) with the merge debt; bounded steps remove
 * them (agePurgeStep). Returns the ids listed. */
export function agePurgeBegin(writer: IndexWriter, db: DatabaseSync, ids: readonly string[]): number {
  if (!ids.length) return 0;
  return writer.write("delete", runtimeStepWalBytes(), () => {
    db.exec(PURGE_PENDING_SCHEMA);
    const add = db.prepare("INSERT OR IGNORE INTO purge_pending VALUES(?)");
    for (const id of ids) add.run(id);
    setMeta(db, "merge_owed", "1");
    return ids.length;
  });
}

// D11 reservation ----------------------------------------------------------------------------------------------------------------
/** Bytes the rest of the staged bulk may still write to the file, from the transactional counters, plus the WAL term and 64 MiB. */
export function ageReservation(db: DatabaseSync, fillRatio: number): number {
  const text = num(db, C.text), rows = num(db, C.rows), ids = num(db, C.idBytes);
  const phase = agePhase(db);
  const retire = phase === "retiring" || phase === "cut" || phase === "stage_drop" || phase === "keys" ? Number(db.prepare("PRAGMA page_count").get()?.page_count ?? 0) * Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096) : 0;
  return text * Math.max(4, fillRatio) + 2 * (2 * ids + 48 * rows) + 2 * (ids + 40 * rows) + 48 * rows + retire + AGE_RESERVE_WAL_BYTES + AGE_FILL_RESERVE_BYTES;
}

// The step --------------------------------------------------------------------------------------------------------------------------
export interface AgeCtx {
  db: DatabaseSync; writer: IndexWriter; sizer: StepSizer; authority: DatabaseSync;
  /** statfs of the index volume; null means unknown (wait and note). Omitted: no disk check (tests). */
  freeBytes?: () => number | null;
  /** index.ts R4 counter, in the same txn as the entries row change. */
  countEntry?: (delta: 1 | -1, rowid: number) => void;
  /** Called with the (id:version) keys a step removed (the vector cache). */
  removed?: (keys: string[]) => void;
  /** Whether the main database still holds (id,version) (D4 unkeyed rows); default: it has an age key for it. */
  holds?: (id: string, version: number) => boolean;
  /** An extra cap on rows per step (tests); the sizer decides the size. */
  maxKeys?: number;
}
/** `busy`: not admitted now (the writer is owed a check, stopped, or the line is full); try again later. `x`/`rows`: the step's sizer input. */
export interface AgeStepResult { done: boolean; copied: number; walked: number; phase: AgePhase | null; ran: AdmitKind | null; waiting?: "disk" | "gate" | "admit" | "blocked" | "scrub"; cutover?: boolean; blocked?: string; busy?: true; x?: number; rows?: number }
interface Pending { kind: StepKind; x: number; rows: number; ms: number; Lb: number }
const pendingRecord = new WeakMap<DatabaseSync, Pending>();
const STEP_KIND: Record<AgePhase, StepKind> = { validate0: "fill", fill: "fill", validate: "fill", keys: "keys", stage_drop: "stage_drop", cut: "stage_drop", retiring: "delete" };

/** One bounded staged-bulk step, one checked write (the caller awaits writer.check() after it, as for every write). Order: the previous
 * step's measured rise into the sizer, an owed D7 block, D6 purge steps, the start, the D11 sum, then the phase's step. Never on the main thread. */
export function ageStep(ctx: AgeCtx): AgeStepResult {
  const { db, writer } = ctx;
  const out = (r: Partial<AgeStepResult>): AgeStepResult => ({ done: false, copied: 0, walked: 0, phase: agePhase(db), ran: null, ...r.waiting === "admit" ? { busy: true as const } : {}, ...r });
  const pend = pendingRecord.get(db);
  if (pend && !writer.checkOwed()) { pendingRecord.delete(db); const rise = writer.L() - pend.Lb; if (rise >= 0) ctx.sizer.record(pend.kind, { x: pend.x, rows: pend.rows, rise, ms: pend.ms }); }
  if (writer.stopped || writer.checkOwed()) return out({ waiting: "admit" });
  const owed = owedBlocks.get(db);
  if (owed !== undefined && ageFillBlocked(db) === null) {
    if (!writer.admit("fill", runtimeStepWalBytes())) return out({ waiting: "admit" });
    writer.write("fill", runtimeStepWalBytes(), put => put(AGE_FILL_BLOCKED, owed));
    owedBlocks.delete(db);
    return out({ ran: "fill", waiting: "blocked", blocked: owed });
  }
  if (purgePendingOwed(db)) return purgeStep(ctx, out);
  let phase = agePhase(db);
  if (phase === null) {
    if (lexicalRowidsAged(db)) return out({ done: true });
    if (!ageGateOpen(db)) return out({ waiting: "gate" });
    return startStep(ctx, out);
  }
  const blocked = ageFillBlocked(db);
  if (blocked !== null) return out({ waiting: "blocked", blocked });
  if (phase !== "retiring" && phase !== "cut" && !ageGateOpen(db)) return out({ waiting: "gate" });
  if ((phase === "validate0" || phase === "fill") && meta(db, C.sumDone) === null) return sumStep(ctx, out);
  if (ctx.freeBytes) {
    const free = ctx.freeBytes();
    if (free === null || free < ageReservation(db, ctx.sizer.rho("fill"))) return out({ waiting: "disk" });
  }
  const kind = STEP_KIND[phase];
  if (phase === "retiring" && meta(db, C.rMerge) !== null) return retireMerge(ctx, out);
  if (!writer.admit(kind, runtimeStepWalBytes())) return out({ waiting: "admit" });
  const started = performance.now(), Lb = writer.L();
  let r: AgeStepResult;
  try {
    switch (phase) {
      case "validate0": r = validate0Step(ctx, out); break;
      case "fill": r = fillStep(ctx, out); break;
      case "validate": r = validateStep(ctx, out); break;
      case "keys": r = keysStep(ctx, out); break;
      case "stage_drop": r = stageDropStep(ctx, out); break;
      case "cut": r = cutStep(ctx, out); break;
      case "retiring": r = retireStep(ctx, out); break;
    }
  } catch (error) { forgetAgePhase(db); throw error; }
  if (r.x !== undefined && r.ran) pendingRecord.set(db, { kind, x: r.x, rows: r.rows ?? 0, ms: performance.now() - started, Lb });
  phase = agePhase(db);
  return { ...r, phase };
}

/** Commits a phase change inside the step's txn; the cache moves only after COMMIT (setPhaseAfter). */
function phaseTo(db: DatabaseSync, put: (k: string, v: string) => void, next: AgePhase | null): void {
  if (next === null) delMeta(db, AGE_PHASE); else put(AGE_PHASE, next);
}
function blockIn(put: (k: string, v: string) => void, reason: string) { put(AGE_FILL_BLOCKED, reason); }
const authorityKey = (authority: DatabaseSync) => authority.prepare("SELECT age_key AS k FROM memory_record_keys WHERE record_id=? AND record_version=?");

function startStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult {
  const { db, writer } = ctx;
  if (!writer.admit("fill", runtimeStepWalBytes())) return out({ waiting: "admit" });
  const inherited = ageTablesPresent(db) && Boolean(db.prepare("SELECT 1 FROM lexical_age LIMIT 1").get());
  const next: AgePhase = inherited ? "validate0" : "fill";
  writer.write("fill", runtimeStepWalBytes(), put => {
    const fresh = !ageTablesPresent(db);
    db.exec(LEXICAL_AGE_SCHEMA); db.exec(AGE_STAGE_SCHEMA);
    if (fresh) {
      db.exec("INSERT INTO lexical_age(lexical_age,rank) VALUES('automerge',0)"); db.exec("INSERT INTO lexical_age(lexical_age,rank) VALUES('crisismerge',1999)");
      put("text_bytes:lexical_age", "0"); put("debt_bytes:lexical_age", "0");
    }
    delMeta(db, AGE_FILL_REMAINING);
    if (inherited) put(C.v0, String(ageFillBelow(db) ?? Number.MIN_SAFE_INTEGER));
    put(C.sum, "0"); put(C.text, "0"); put(C.rows, "0"); put(C.idBytes, "0");
    phaseTo(db, put, next);
  });
  phaseCache.set(db, next);
  return out({ ran: "fill" });
}

/** D11: remaining UTF-8 bytes (text, ids) and rows summed in bounded steps with a cursor, before the first fill step. */
function sumStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult {
  const { db, writer } = ctx;
  if (!writer.admit("fill", runtimeStepWalBytes())) return out({ waiting: "admit" });
  const cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("fill"));
  writer.write("fill", runtimeStepWalBytes(), put => {
    const cursor = num(db, C.sum);
    const s = db.prepare("SELECT count(*) AS n,max(r) AS top,coalesce(sum(t),0) AS t,coalesce(sum(i),0) AS i FROM (SELECT rowid AS r,length(CAST(text AS BLOB)) AS t,length(CAST(id AS BLOB)) AS i FROM entries WHERE rowid>? ORDER BY rowid LIMIT ?)").get(cursor, cap)!;
    put(C.text, String(num(db, C.text) + Number(s.t))); put(C.rows, String(num(db, C.rows) + Number(s.n))); put(C.idBytes, String(num(db, C.idBytes) + Number(s.i)));
    if (Number(s.n) < cap) { put(C.sumDone, "1"); delMeta(db, C.sum); } else put(C.sum, String(Number(s.top)));
  });
  return out({ ran: "fill" });
}

/** D2 phase validate0: the inherited b18 rows above the inherited frontier, checked as D2 would have (key = authority key, the FTS row
 * there carries that record). A failure removes age_fill_below in the same txn (search falls back to the complete `lexical`), then D7. */
function validate0Step(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer, authority } = ctx;
  const cursor = num(db, C.v0, Number.MIN_SAFE_INTEGER), cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("keys"));
  const rows = db.prepare("SELECT id,version,fts_rowid AS r FROM lexical_age_keys WHERE fts_rowid>=? ORDER BY fts_rowid LIMIT ?").all(cursor, cap + 1) as Array<{ id: string; version: number; r: number }>;
  const step = ctx.sizer.take("keys", rows.slice(0, cap), row => rowX({ id: String(row.id) }, true));
  const ak = authorityKey(authority), fts = db.prepare("SELECT id,CAST(version AS INTEGER) AS version FROM lexical_age WHERE rowid=?");
  let failed: string | null = null;
  for (const row of step.rows) {
    const k = ak.get(String(row.id), Number(row.version));
    if (!k || Number(k.k) !== Number(row.r)) { failed = "validate0_key_mismatch"; break; }
    if (!sameRecord(fts.get(Number(row.r)), String(row.id), Number(row.version))) { failed = "validate0_row_mismatch"; break; }
  }
  const last = step.rows.length === rows.length;
  writer.write("fill", runtimeStepWalBytes(), put => {
    if (failed) { delMeta(db, AGE_FILL_BELOW); blockIn(put, failed); return; }
    if (last) { delMeta(db, C.v0); phaseTo(db, put, "fill"); }
    else put(C.v0, String(Number(step.rows.at(-1)!.r) + 1));
  });
  if (!failed && last) phaseCache.set(db, "fill");
  return out({ ran: "fill", walked: step.rows.length, blocked: failed ?? undefined, waiting: failed ? "blocked" : undefined, x: step.x, rows: step.rows.length });
}

/** Read only the sized prefix and its crossing row. Completing the source is the
 * durable end-of-pass signal; breaking for either cap leaves the cursor pending.
 * The iterator closes before the write starts, including on a deferred crossing row. */
function readSizedPrefix<R>(sizer: StepSizer, kind: StepKind, cap: number, source: Iterable<R>, xOf: (row: R) => number) {
  let last = false;
  function* bounded() {
    let count = 0;
    for (const row of source) {
      if (count++ >= cap) return;
      yield row;
    }
    last = true;
  }
  const step = sizer.take(kind, bounded(), xOf);
  return { ...step, last };
}

/** D2 fill step: the next newest-first prefix of authority keys below the frontier. Every key's occupant is identified first; another
 * record there blocks the whole prefix (D7, nothing copied). Copies go in ascending rowid order with the segment watch; the frontier,
 * remaining counters and the copies commit together, and the frontier moves only over a whole prefix. */
function fillStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer, authority } = ctx;
  const below = ageFillBelow(db), cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("fill"));
  const keys = (below === null
    ? authority.prepare("SELECT record_id AS id,record_version AS version,age_key AS k FROM memory_record_keys ORDER BY age_key DESC LIMIT ?").iterate(cap + 1)
    : authority.prepare("SELECT record_id AS id,record_version AS version,age_key AS k FROM memory_record_keys WHERE age_key<? ORDER BY age_key DESC LIMIT ?").iterate(below, cap + 1));
  const entry = db.prepare("SELECT rowid AS r,scope_id AS s,text FROM entries WHERE id=? AND version=?");
  type Row = { id: string; version: number; k: number; e?: { r: number; s: string; text: string } };
  function* rows(): Generator<Row> {
    for (const row of keys) {
      const e = entry.get(String(row.id), Number(row.version));
      yield { id: String(row.id), version: Number(row.version), k: Number(row.k), e: e ? { r: Number(e.r), s: String(e.s), text: String(e.text) } : undefined };
    }
  }
  const step = readSizedPrefix(ctx.sizer, "fill", cap, rows(), row => row.e ? rowX({ text: row.e.text, id: row.id, scope: row.e.s }) : rowX({ id: row.id }, true));
  const last = step.last;
  let blocked: string | null = null;
  const copy: Row[] = [];
  for (const row of step.rows) {
    const occupant = ageOccupant(db, row.k);
    if (!occupant) { if (row.e) copy.push(row); continue; }
    if (!sameRecord(occupant, row.id, row.version)) { blocked = "fill_squatter"; break; }
  }
  let copied = 0, whole = true, bytes = 0, idBytes = 0;
  writer.write("fill", runtimeStepWalBytes(), put => {
    if (blocked) { blockIn(put, blocked); return; }
    const insert = db.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,?,?)"), stage = db.prepare("INSERT INTO age_stage VALUES(?,?,?)"), emap = db.prepare("INSERT OR REPLACE INTO age_emap VALUES(?,?)");
    const watch = new SegmentWatch(() => ftsSegments(db, "lexical_age"));
    for (const row of [...copy].sort((a, b) => a.k - b.k)) {
      insert.run(row.k, row.id, row.version, row.e!.text); stage.run(-row.k, row.id, row.version); emap.run(row.e!.r, row.k);
      copied++; bytes += utf8(row.e!.text); idBytes += utf8(row.id);
      if (!watch.wrote()) { whole = copied === copy.length; break; }
    }
    ageAddText(db, "lexical_age", bytes);
    put(C.text, String(Math.max(0, num(db, C.text) - bytes))); put(C.rows, String(Math.max(0, num(db, C.rows) - copied))); put(C.idBytes, String(Math.max(0, num(db, C.idBytes) - idBytes)));
    if (!whole || !step.rows.length) return;
    put(AGE_FILL_BELOW, String(step.rows.at(-1)!.k));
    if (last) { put(C.vb, "0"); put(C.vbPass, "1"); put(C.unkeyed, "0"); put(C.va, JSON.stringify(["", -1])); phaseTo(db, put, "validate"); }
  });
  if (!blocked && whole && last) phaseCache.set(db, "validate");
  return out({ ran: "fill", copied, walked: step.rows.length, blocked: blocked ?? undefined, waiting: blocked ? "blocked" : undefined, x: step.x, rows: step.rows.length });
}

/** D4 validate: (a) every pre-existing lexical_age_keys row (b18 fills, keyed dual writes) sits at its authority key and the FTS row there
 * carries it, else it is re-placed at its key when that is empty, else D7; then (b) entries LEFT JOIN the copies: a missing copy is copied
 * (destination check), an unkeyed entry is counted; after AGE_VALIDATE_PASSES full (b) passes a still-unkeyed row is D7 when the main
 * database holds it, else removed as a dead row (D5 deletion path, merge debt). */
function validateStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer, authority } = ctx;
  const ak = authorityKey(authority), cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("fill"));
  const va = meta(db, C.va);
  if (va !== null) {
    const [cid, cv] = JSON.parse(va) as [string, number];
    const rows = db.prepare("SELECT id,version,fts_rowid AS r FROM lexical_age_keys WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?").all(cid, cv, cap + 1) as Array<{ id: string; version: number; r: number }>;
    const step = ctx.sizer.take("fill", rows.slice(0, cap), row => rowX({ id: String(row.id) }, true));
    const fts = db.prepare("SELECT id,CAST(version AS INTEGER) AS version FROM lexical_age WHERE rowid=?"), entry = db.prepare("SELECT text FROM entries WHERE id=? AND version=?");
    let blocked: string | null = null, repaired = 0;
    writer.write("fill", runtimeStepWalBytes(), put => {
      for (const row of step.rows) {
        const id = String(row.id), v = Number(row.version), r = Number(row.r), k = ak.get(id, v);
        const here = fts.get(r);
        if (k && Number(k.k) === r && sameRecord(here, id, v)) continue;
        const text = entry.get(id, v);
        if (!k || !text) {
          if (ctx.holds ? ctx.holds(id, v) : Boolean(k)) { blocked = "validate_a_unrepairable"; break; }
          if (sameRecord(here, id, v)) { ageMoveToDebt(db, "lexical_age", ftsTextBytes(db, "lexical_age", r)); db.prepare("DELETE FROM lexical_age WHERE rowid=?").run(r); }
          db.prepare("DELETE FROM lexical_age_keys WHERE id=? AND version=?").run(id, v); setMeta(db, "merge_owed", "1"); continue;
        }
        const key = Number(k.k);
        // the authority key must be empty to re-place there: a taken key is never freed by eviction
        if (key !== r && ageOccupant(db, key) !== null) { blocked = "validate_a_destination_taken"; break; }
        if (sameRecord(here, id, v)) { ageMoveToDebt(db, "lexical_age", ftsTextBytes(db, "lexical_age", r)); db.prepare("DELETE FROM lexical_age WHERE rowid=?").run(r); }
        else if (here) { blocked = "validate_a_row_mismatch"; break; }
        ageAddText(db, "lexical_age", utf8(String(text.text)));
        db.prepare("DELETE FROM lexical_age_keys WHERE id=? AND version=?").run(id, v);
        db.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,?,?)").run(key, id, v, String(text.text));
        db.prepare("INSERT INTO lexical_age_keys VALUES(?,?,?)").run(id, v, key);
        repaired++;
      }
      if (blocked) { blockIn(put, blocked); return; }
      if (step.rows.length === rows.length) delMeta(db, C.va); else { const l = step.rows.at(-1)!; put(C.va, JSON.stringify([String(l.id), Number(l.version)])); }
    });
    return out({ ran: "fill", walked: step.rows.length, copied: repaired, blocked: blocked ?? undefined, waiting: blocked ? "blocked" : undefined, x: step.x, rows: step.rows.length });
  }
  // (b)
  const cursor = num(db, C.vb), pass = num(db, C.vbPass, 1);
  const rows = db.prepare(`SELECT e.rowid AS r,e.id,e.version,e.scope_id AS s,e.text FROM entries e WHERE e.rowid>? ORDER BY e.rowid LIMIT ?`).iterate(cursor, cap + 1);
  const step = readSizedPrefix(ctx.sizer, "fill", cap, rows, row => rowX({ text: String(row.text), id: String(row.id), scope: String(row.s) }));
  const last = step.last;
  const keyed = db.prepare("SELECT 1 FROM lexical_age_keys WHERE id=? AND version=?"), mapped = db.prepare("SELECT 1 FROM age_emap WHERE erow=?");
  let blocked: string | null = null, copied = 0, unkeyed = 0, nextPhase: AgePhase | null = null;
  const gone: string[] = [];
  writer.write("fill", runtimeStepWalBytes(), put => {
    for (const row of step.rows) {
      const id = String(row.id), v = Number(row.version);
      if (keyed.get(id, v) || mapped.get(Number(row.r))) continue;
      const k = ak.get(id, v);
      if (k) {
        const occupant = ageOccupant(db, Number(k.k));
        if (occupant) { blocked = sameRecord(occupant, id, v) ? "validate_b_unmapped_copy" : "validate_b_destination_taken"; break; }
        db.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,?,?)").run(Number(k.k), id, v, String(row.text));
        db.prepare("INSERT INTO age_stage VALUES(?,?,?)").run(-Number(k.k), id, v);
        db.prepare("INSERT OR REPLACE INTO age_emap VALUES(?,?)").run(Number(row.r), Number(k.k));
        ageAddText(db, "lexical_age", utf8(String(row.text)));
        copied++; continue;
      }
      if (pass < AGE_VALIDATE_PASSES) { unkeyed++; continue; }
      if (ctx.holds?.(id, v)) { blocked = "validate_b_unkeyed_held"; break; }
      // a dead row: removed through the D5 deletion path with merge debt
      const lk = db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?").get(id, v);
      if (lk) { ageMoveToDebt(db, "lexical", ftsTextBytes(db, "lexical", Number(lk.fts_rowid))); db.prepare("DELETE FROM lexical WHERE rowid=?").run(Number(lk.fts_rowid)); }
      db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(id, v);
      db.prepare("DELETE FROM vectors WHERE id=? AND version=?").run(id, v);
      db.prepare("DELETE FROM entries WHERE id=? AND version=?").run(id, v); ctx.countEntry?.(-1, Number(row.r));
      setMeta(db, "merge_owed", "1"); gone.push(`${id}:${v}`);
    }
    if (blocked) { blockIn(put, blocked); return; }
    const total = num(db, C.unkeyed) + unkeyed;
    if (!last) { put(C.vb, String(Number(step.rows.at(-1)!.r))); put(C.unkeyed, String(total)); return; }
    if (total === 0 || pass >= AGE_VALIDATE_PASSES) { delMeta(db, C.vb, C.vbPass, C.unkeyed); put(C.keys, String(Number.MAX_SAFE_INTEGER)); nextPhase = "keys"; phaseTo(db, put, "keys"); }
    else { put(C.vb, "0"); put(C.vbPass, String(pass + 1)); put(C.unkeyed, "0"); }
  });
  if (nextPhase) phaseCache.set(db, nextPhase);
  if (gone.length) ctx.removed?.(gone);
  return out({ ran: "fill", walked: step.rows.length, copied, blocked: blocked ?? undefined, waiting: blocked ? "blocked" : undefined, x: step.x, rows: step.rows.length });
}

/** D4 keys: age_stage from the highest nk down (oldest first, so fts_rowid and the rowid table append) into lexical_age_keys, cap 50,000
 * rows; present with the same fts_rowid: skip; present with another: D7. The last step commits age_phase = stage_drop. */
function keysStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer } = ctx;
  const cursor = num(db, C.keys, Number.MAX_SAFE_INTEGER), cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("keys"));
  const rows = db.prepare("SELECT nk,id,version FROM age_stage WHERE nk<? ORDER BY nk DESC LIMIT ?").all(cursor, cap + 1) as Array<{ nk: number; id: string; version: number }>;
  const step = ctx.sizer.take("keys", rows.slice(0, cap), row => rowX({ id: String(row.id) }, true));
  const last = step.rows.length === rows.length;
  const byId = db.prepare("SELECT fts_rowid FROM lexical_age_keys WHERE id=? AND version=?"), byRow = db.prepare("SELECT id,version FROM lexical_age_keys WHERE fts_rowid=?"), add = db.prepare("INSERT INTO lexical_age_keys VALUES(?,?,?)");
  let blocked: string | null = null, written = 0;
  writer.write("keys", runtimeStepWalBytes(), put => {
    for (const row of step.rows) {
      const id = String(row.id), v = Number(row.version), key = -Number(row.nk);
      const have = byId.get(id, v);
      if (have) { if (Number(have.fts_rowid) !== key) { blocked = "keys_other_rowid"; break; } continue; }
      const at = byRow.get(key);
      if (at) { blocked = "keys_rowid_taken"; break; }
      add.run(id, v, key); written++;
    }
    if (blocked) { blockIn(put, blocked); return; }
    if (last) { delMeta(db, C.keys); phaseTo(db, put, "stage_drop"); } else put(C.keys, String(Number(step.rows.at(-1)!.nk)));
  });
  if (!blocked && last) phaseCache.set(db, "stage_drop");
  return out({ ran: "keys", walked: step.rows.length, copied: written, blocked: blocked ?? undefined, waiting: blocked ? "blocked" : undefined, x: step.x, rows: step.rows.length });
}

/** D8 stage_drop: bounded deletes of age_stage, then age_emap, in rowid order; then DROP of the empty tables and age_phase = cut. */
function stageDropStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer } = ctx;
  const cap = Math.min(ctx.maxKeys ?? Infinity, ctx.sizer.maxRows("stage_drop"));
  const table = db.prepare("SELECT 1 FROM age_stage LIMIT 1").get() ? "age_stage" : db.prepare("SELECT 1 FROM age_emap LIMIT 1").get() ? "age_emap" : null;
  const col = table === "age_stage" ? "nk" : "erow";
  const rows = table ? db.prepare(`SELECT ${col} AS r${table === "age_stage" ? ",id" : ""} FROM ${table} ORDER BY ${col} LIMIT ?`).all(cap) as Array<{ r: number; id?: string }> : [];
  const step = ctx.sizer.take("stage_drop", rows, row => rowX({ id: String(row.id ?? "") }, true));
  let dropped = false;
  writer.write("stage_drop", runtimeStepWalBytes(), put => {
    if (table && step.rows.length) { db.prepare(`DELETE FROM ${table} WHERE ${col} BETWEEN ? AND ?`).run(Number(step.rows[0]!.r), Number(step.rows.at(-1)!.r)); return; }
    db.exec("DROP TABLE age_stage; DROP TABLE age_emap;");
    phaseTo(db, put, "cut"); dropped = true;
  });
  if (dropped) phaseCache.set(db, "cut");
  return out({ ran: "stage_drop", walked: step.rows.length, x: step.x, rows: step.rows.length });
}

/** D8 cut: ONE txn of renames only; refused while a scrub merge is open. */
function cutStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer } = ctx;
  if (meta(db, "delete_scrub_owed") !== null) return out({ waiting: "scrub" });
  writer.write("stage_drop", runtimeStepWalBytes(), put => {
    const generation = lexicalGeneration(db), live = num(db, "entries_live");
    db.exec("ALTER TABLE lexical RENAME TO lexical_retired; ALTER TABLE lexical_keys RENAME TO lexical_retired_keys; ALTER TABLE lexical_age RENAME TO lexical; ALTER TABLE lexical_age_keys RENAME TO lexical_keys;");
    // ruling 2a: the retired table never merges on its own: pin it (FTS5 rename may carry the config, but nothing else pins it)
    db.exec("INSERT INTO lexical_retired(lexical_retired,rank) VALUES('automerge',0)"); db.exec("INSERT INTO lexical_retired(lexical_retired,rank) VALUES('crisismerge',1999)");
    put(LEXICAL_ROWIDS, "age"); put(LEXICAL_GENERATION, String(generation + 1));
    // T_t counters follow their tables; a generation without one keeps none (fail closed to the fallback)
    const t = { text: meta(db, "text_bytes:lexical"), debt: meta(db, "debt_bytes:lexical"), aText: meta(db, "text_bytes:lexical_age"), aDebt: meta(db, "debt_bytes:lexical_age") };
    delMeta(db, "text_bytes:lexical", "debt_bytes:lexical", "text_bytes:lexical_age", "debt_bytes:lexical_age");
    if (t.text !== null) put("text_bytes:lexical_retired", t.text);
    if (t.debt !== null) put("debt_bytes:lexical_retired", t.debt);
    if (t.aText !== null) put("text_bytes:lexical", t.aText);
    if (t.aDebt !== null) put("debt_bytes:lexical", t.aDebt);
    delMeta(db, AGE_FILL_BELOW, AGE_FILL_REMAINING, C.text, C.rows, C.idBytes, C.sumDone);
    put(C.rLeft, String(live)); put(C.rBase, String(live)); put(C.rSince, "0"); put(C.rDel, "0");
    phaseTo(db, put, "retiring");
  });
  phaseCache.set(db, "retiring");
  return out({ ran: "stage_drop", cutover: true, x: 0, rows: 0 });
}

/** D8 retirement delete: a bounded batch of lexical_retired_keys by fts_rowid, through the virtual table, then the key rows. When a tenth
 * of what was left at the last pass is deleted, a merge pass opens (and no delete runs until it completes). Empty: the final pass. */
function retireStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult & { x?: number; rows?: number } {
  const { db, writer } = ctx;
  retireMergePages(); // fail closed before any retirement write
  const n = retireStepRows();
  const listed = db.prepare("SELECT id,version,fts_rowid AS r FROM lexical_retired_keys ORDER BY fts_rowid LIMIT ?").all(n) as Array<{ id: string; version: number; r: number }>;
  // a step is min(MEMW_RETIRE_STEP_ROWS rows, the D3 X budget): 800 rows of 64 KB text never ride one step (owner 11-08)
  const textAt = db.prepare("SELECT length(CAST(text AS BLOB)) AS n FROM lexical_retired WHERE rowid=?");
  const sized = ctx.sizer.take("delete", listed, row => utf8(String(row.id)) + Number(textAt.get(Number(row.r))?.n ?? 0) + MEMW_ROW_BYTES);
  const rows = sized.rows;
  const since = num(db, C.rSince), base = num(db, C.rBase);
  const openPass = !rows.length || (since > 0 && since * 10 >= base) || (since > 0 && (ageTestHooks.retiredSegments ?? ftsSegments(db, "lexical_retired")) > MEMW_SEGMENT_GATE); // PROGRESS GUARD: a gate pass opens only after a deletion since the last pass
  writer.write("delete", runtimeStepWalBytes(), put => {
    if (openPass) { put(C.rMerge, JSON.stringify({ started: false, gen: num(db, C.rDel), final: !rows.length })); return; }
    const del = db.prepare("DELETE FROM lexical_retired WHERE rowid=?");
    for (const row of rows) { ageMoveToDebt(db, "lexical_retired", ftsTextBytes(db, "lexical_retired", Number(row.r))); del.run(Number(row.r)); }
    db.prepare("DELETE FROM lexical_retired_keys WHERE fts_rowid BETWEEN ? AND ?").run(Number(rows[0]!.r), Number(rows.at(-1)!.r));
    bumpRetired(db, rows.length);
  });
  return out({ ran: "delete", walked: openPass ? 0 : rows.length, x: openPass ? 0 : sized.x, rows: openPass ? 0 : rows.length });
}
/** One step of a D8 merge pass on lexical_retired: first negative (opens the merge over every segment), then positive until < 2 changes;
 * a deletion after the pass opened forces one more pass; the final pass ends in the DROP of the empty tables (one txn). */
function retireMerge(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult {
  const { db, writer } = ctx;
  if (!writer.admit("merge", runtimeMergeWalBytes())) return out({ waiting: "admit" });
  let finished = false;
  writer.write("merge", runtimeMergeWalBytes(), put => {
    const pass = JSON.parse(meta(db, C.rMerge)!) as { started: boolean; gen: number; final: boolean };
    const before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
    const pages = retireMergePages();
    db.exec(`INSERT INTO lexical_retired(lexical_retired,rank) VALUES('merge',${pass.started ? pages : -pages})`);
    const ended = Number(db.prepare("SELECT total_changes() AS n").get()!.n) - before < 2;
    if (!ended || !pass.started) { put(C.rMerge, JSON.stringify({ ...pass, started: true })); return; }
    if (num(db, C.rDel) !== pass.gen) { put(C.rMerge, JSON.stringify({ started: false, gen: num(db, C.rDel), final: pass.final })); return; }
    delMeta(db, C.rMerge); put(C.rSince, "0"); put(C.rBase, String(num(db, C.rLeft)));
    if (meta(db, "debt_bytes:lexical_retired") !== null) put("debt_bytes:lexical_retired", "0");
    if (pass.final && !db.prepare("SELECT 1 FROM lexical_retired_keys LIMIT 1").get() && !db.prepare("SELECT rowid FROM lexical_retired LIMIT 1").get()) {
      db.exec("DROP TABLE lexical_retired; DROP TABLE lexical_retired_keys;");
      delMeta(db, C.rLeft, C.rBase, C.rSince, C.rDel, "text_bytes:lexical_retired", "debt_bytes:lexical_retired");
      phaseTo(db, put, null); finished = true;
    }
  });
  if (finished) phaseCache.set(db, null);
  return out({ ran: "merge", done: finished });
}

/** D6 bounded step: at most AGE_PURGE_STEP_ROWS (id,version) rows of the listed ids, in (id,version) order, removed from every generation,
 * entries and vectors, with merge debt; an id leaves purge_pending in the step that removes its last row. Runs before any MEMW step. */
function purgeStep(ctx: AgeCtx, out: (r: Partial<AgeStepResult>) => AgeStepResult): AgeStepResult {
  const { db, writer } = ctx;
  if (!writer.admit("delete", runtimeStepWalBytes())) return out({ waiting: "admit" });
  const gone: string[] = [];
  writer.write("delete", runtimeStepWalBytes(), put => {
    const ids = db.prepare("SELECT id FROM purge_pending ORDER BY id LIMIT ?").all(AGE_PURGE_STEP_ROWS) as Array<{ id: string }>;
    const tables = ["entries", "lexical_keys", ...ageTablesPresent(db) ? ["lexical_age_keys"] : [], ...hasTable(db, "age_stage") ? ["age_stage"] : [], ...hasTable(db, "lexical_retired_keys") ? ["lexical_retired_keys"] : [], "vectors"];
    let budget = AGE_PURGE_STEP_ROWS;
    for (const { id } of ids) {
      const versions = new Set<number>();
      for (const t of tables) for (const r of db.prepare(`SELECT DISTINCT version AS v FROM ${t} WHERE id=? LIMIT ?`).all(String(id), budget + 1) as Array<{ v: number }>) versions.add(Number(r.v));
      const take = [...versions].sort((a, b) => a - b).slice(0, budget);
      for (const v of take) {
        ageDeleteRecord(db, String(id), v);
        const lk = db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?").get(String(id), v);
        if (lk) { ageMoveToDebt(db, "lexical", ftsTextBytes(db, "lexical", Number(lk.fts_rowid))); db.prepare("DELETE FROM lexical WHERE rowid=?").run(Number(lk.fts_rowid)); }
        db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(String(id), v);
        if (hasTable(db, "age_stage")) db.prepare("DELETE FROM age_stage WHERE id=? AND version=?").run(String(id), v);
        const e = db.prepare("DELETE FROM entries WHERE id=? AND version=? RETURNING rowid AS r").get(String(id), v);
        if (e) ctx.countEntry?.(-1, Number(e.r));
        db.prepare("DELETE FROM vectors WHERE id=? AND version=?").run(String(id), v);
        gone.push(`${id}:${v}`);
      }
      budget -= take.length;
      if (take.length === versions.size) db.prepare("DELETE FROM purge_pending WHERE id=?").run(String(id));
      if (budget <= 0) break;
    }
    if (gone.length) { put("merge_owed", "1"); put("delete_generation", String(num(db, "delete_generation") + 1)); }
    if (!db.prepare("SELECT 1 FROM purge_pending LIMIT 1").get()) db.exec("DROP TABLE purge_pending");
  });
  if (gone.length) ctx.removed?.(gone);
  return out({ ran: "delete", walked: gone.length });
}

/** D8 scrubDeleted: the generation the scrub merges after `table` (lexical, then lexical_age before cutover or lexical_retired after). */
export function nextScrubTable(db: DatabaseSync, table: string): "lexical_age" | "lexical_retired" | null {
  if (table === "lexical" && ageTablesPresent(db)) return "lexical_age";
  if ((table === "lexical" || table === "lexical_age") && hasTable(db, "lexical_retired")) return "lexical_retired";
  return null;
}

// Post-cutover sweep (copied-binary case)------------------------------------------------------------------------------------------

/** Puts one record's FTS row at `rowid` in `lexical` (after cutover only: never on lexical_age, D5), moving a row another record left
 * there (an automatic rowid of an older binary) to an automatic rowid of its own; the sweep brings that one to its key in turn. */
export function placeLexicalRow(db: DatabaseSync, table: "lexical", id: string, version: number, text: string, rowid: number): void {
  if (table !== "lexical") throw new Error("MEMORY_INDEX_AGE_EVICTION");
  const squatter = db.prepare("SELECT id,version FROM lexical_keys WHERE fts_rowid=? AND NOT (id=? AND version=?)").get(rowid, id, version);
  if (squatter) {
    db.prepare("DELETE FROM lexical WHERE rowid=?").run(rowid);
    db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(squatter.id, squatter.version);
  }
  db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,?,?)").run(rowid, id, version, text);
  db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)").run(id, version, rowid);
  if (squatter) {
    const kept = db.prepare("SELECT text FROM entries WHERE id=? AND version=?").get(squatter.id, squatter.version);
    if (kept) {
      const moved = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,?,?)").run(squatter.id, squatter.version, String(kept.text));
      db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)").run(squatter.id, squatter.version, moved.lastInsertRowid);
    }
  }
}

/** One slice of the post-cutover sweep, one checked `fill` write: the next rows of `lexical_keys` in key order, each whose rowid is not
 * its record's age key re-inserted at that key. Done when the walk ends; it starts over at the next helper start. */
export function sweepAgeRowidsStep(db: DatabaseSync, writer: IndexWriter, authority: DatabaseSync, options: { maxRows?: number } = {}): { done: boolean; examined: number; fixed: number; busy?: true; waiting?: "gate" } {
  if (!lexicalRowidsAged(db)) return { done: true, examined: 0, fixed: 0 };
  if (writer.stopped || writer.checkOwed()) return { done: false, examined: 0, fixed: 0, busy: true };
  if (!ageGateOpen(db)) return { done: false, examined: 0, fixed: 0, busy: true, waiting: "gate" };
  if (!writer.admit("fill", runtimeStepWalBytes())) return { done: false, examined: 0, fixed: 0, busy: true };
  const maxRows = Math.max(1, options.maxRows ?? AGE_SWEEP_SLICE_ROWS);
  const after = meta(db, AGE_SWEEP_AFTER);
  const cursor: [string, number] = after ? JSON.parse(after) : ["", 0];
  const rows = db.prepare("SELECT id,version,fts_rowid AS r FROM lexical_keys WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?").all(cursor[0], cursor[1], maxRows) as Array<{ id: string; version: number; r: number }>;
  if (!rows.length) { if (after !== null) writer.write("fill", runtimeStepWalBytes(), () => delMeta(db, AGE_SWEEP_AFTER)); return { done: true, examined: 0, fixed: 0 }; }
  const keyed = new Map<string, number>();
  for (const row of authority.prepare("SELECT k.record_id AS id,k.record_version AS version,k.age_key AS k FROM json_each(?) j JOIN memory_record_keys k ON k.record_id=json_extract(j.value,'$[0]') AND k.record_version=json_extract(j.value,'$[1]')").all(JSON.stringify(rows.map(row => [row.id, row.version]))) as Array<{ id: string; version: number; k: number }>)
    keyed.set(`${row.id}\u0000${row.version}`, Number(row.k));
  const wrong = rows.filter(row => { const k = keyed.get(`${row.id}\u0000${row.version}`); return k !== undefined && k !== Number(row.r); });
  let fixed = 0;
  writer.write("fill", runtimeStepWalBytes(), put => {
    for (const row of wrong) {
      const text = db.prepare("SELECT text FROM entries WHERE id=? AND version=?").get(row.id, row.version);
      db.prepare("DELETE FROM lexical WHERE rowid=?").run(Number(row.r));
      db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(row.id, row.version);
      if (text) { placeLexicalRow(db, "lexical", String(row.id), Number(row.version), String(text.text), keyed.get(`${row.id}\u0000${row.version}`)!); fixed++; }
    }
    const last = rows.at(-1)!;
    put(AGE_SWEEP_AFTER, JSON.stringify([String(last.id), Number(last.version)]));
  });
  return { done: rows.length < maxRows, examined: rows.length, fixed };
}

// D12 downgrade ----------------------------------------------------------------------------------------------------------------------

/** One bounded txn of the downgrade at FULL + secure_delete (app stopped; in-process writable). */
function downTxn<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (Number(db.prepare("PRAGMA synchronous").get()?.synchronous) !== 2 || Number(db.prepare("PRAGMA secure_delete").get()?.secure_delete) !== 1) throw new Error("MEMW_TXN_PRAGMAS");
    const out = body(); db.exec("COMMIT"); return out;
  } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } } throw error; }
}
/** A whole D8 merge pass on `table`, each step its own txn: negative first, then positive to fewer than 2 changes. */
function downMergePass(db: DatabaseSync, table: string, maxSteps: number): boolean {
  for (let n = 0; n < maxSteps; n++) {
    const ended = downTxn(db, () => {
      const before = Number(db.prepare("SELECT total_changes() AS c").get()!.c);
      db.exec(`INSERT INTO ${table}(${table},rank) VALUES('merge',${n ? runtimeMergePages() : -runtimeMergePages()})`);
      return n > 0 && Number(db.prepare("SELECT total_changes() AS c").get()!.c) - before < 2;
    });
    if (ended) return true;
  }
  return false;
}
/** Deletes `lexical_age`/`lexical_retired` rows through the virtual table in bounded steps from a mapping walk, a merge pass after each tenth. */
function downWalk(db: DatabaseSync, fts: string, select: string, del: (row: Record<string, unknown>) => void, step: number, maxSteps: number): boolean {
  let since = 0, left = Math.max(1, Number(db.prepare(`SELECT count(*) AS c FROM (${select.replace(/LIMIT \?$/, "")})`).get()?.c ?? 0));
  for (let n = 0; n < maxSteps; n++) {
    const rows = db.prepare(select).all(step) as Array<Record<string, unknown>>;
    if (!rows.length) return true;
    downTxn(db, () => { for (const row of rows) del(row); });
    since += rows.length; left = Math.max(1, left - rows.length);
    if (since * 10 >= left) { if (!downMergePass(db, fts, maxSteps)) return false; since = 0; }
  }
  return false;
}
export interface DowngradeOptions { charge?: ChargeTransport; stepRows?: number; maxSteps?: number }
/** D12: the index file as 1.0.17 reads it, every step bounded, app stopped. First the open rule (S18): stopped -> the stop stays and
 * nothing is written; pass -> wal_check/verified_through and the sidecars go, then its TRUNCATE. Before cutover the age rows are removed
 * by their mappings (age_stage lowest nk up, then lexical_age_keys), `lexical_age` must then be empty (never a populated DROP), a final
 * pass and the DROP; after cutover retirement finishes; purge_pending finishes; every generation is merged and TRUNCATEd; a saved
 * scrub merge naming a dropped table restarts on `lexical`; automerge=4/crisismerge=16 on `lexical`; only then the meta keys leave.
 * True = ready. Any failure keeps the debt and says not ready (false). */
export async function downgradeMemoryIndexFile(path: string, opts: DowngradeOptions = {}): Promise<boolean> {
  if (!existsSync(path)) return false;
  const verdict = await runOpenRuleForDowngrade(path, { charge: opts.charge });
  if (verdict.state !== "writable") return false;
  const step = Math.max(1, opts.stepRows ?? 2_048), maxSteps = Math.max(1, opts.maxSteps ?? 1_000_000);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;");
    if (!hasTable(db, "index_meta")) return true;
    if (hasTable(db, "lexical_age")) {
      const delAge = (key: number) => db.prepare("DELETE FROM lexical_age WHERE rowid=?").run(key);
      if (hasTable(db, "age_stage") && !downWalk(db, "lexical_age", "SELECT nk FROM age_stage ORDER BY nk LIMIT ?", row => {
        delAge(-Number(row.nk)); db.prepare("DELETE FROM age_stage WHERE nk=?").run(Number(row.nk));
        if (hasTable(db, "lexical_age_keys")) db.prepare("DELETE FROM lexical_age_keys WHERE fts_rowid=?").run(-Number(row.nk));
      }, step, maxSteps)) return false;
      if (hasTable(db, "lexical_age_keys") && !downWalk(db, "lexical_age", "SELECT id,version,fts_rowid FROM lexical_age_keys ORDER BY fts_rowid LIMIT ?", row => {
        delAge(Number(row.fts_rowid)); db.prepare("DELETE FROM lexical_age_keys WHERE id=? AND version=?").run(String(row.id), Number(row.version));
      }, step, maxSteps)) return false;
      if (hasTable(db, "age_emap")) for (let n = 0; db.prepare("SELECT 1 FROM age_emap LIMIT 1").get(); n++) {
        if (n >= maxSteps) return false;
        downTxn(db, () => db.prepare("DELETE FROM age_emap WHERE erow IN (SELECT erow FROM age_emap ORDER BY erow LIMIT ?)").run(step));
      }
      if (db.prepare("SELECT rowid FROM lexical_age LIMIT 1").get()) return false; // a row with neither mapping: a D7 defect, never dropped
      if (!downMergePass(db, "lexical_age", maxSteps)) return false;
      downTxn(db, () => db.exec("DROP TABLE IF EXISTS lexical_age; DROP TABLE IF EXISTS lexical_age_keys; DROP TABLE IF EXISTS age_stage; DROP TABLE IF EXISTS age_emap;"));
    }
    if (hasTable(db, "lexical_retired")) {
      if (!downWalk(db, "lexical_retired", "SELECT id,version,fts_rowid FROM lexical_retired_keys ORDER BY fts_rowid LIMIT ?", row => {
        db.prepare("DELETE FROM lexical_retired WHERE rowid=?").run(Number(row.fts_rowid)); db.prepare("DELETE FROM lexical_retired_keys WHERE id=? AND version=?").run(String(row.id), Number(row.version));
      }, step, maxSteps)) return false;
      if (db.prepare("SELECT rowid FROM lexical_retired LIMIT 1").get()) return false;
      if (!downMergePass(db, "lexical_retired", maxSteps)) return false;
      downTxn(db, () => db.exec("DROP TABLE IF EXISTS lexical_retired; DROP TABLE IF EXISTS lexical_retired_keys;"));
    }
    if (hasTable(db, "purge_pending")) {
      for (let n = 0; db.prepare("SELECT 1 FROM purge_pending LIMIT 1").get(); n++) {
        if (n >= maxSteps) return false;
        downTxn(db, () => {
          const ids = db.prepare("SELECT id FROM purge_pending ORDER BY id LIMIT ?").all(Math.max(1, Math.floor(step / 64))) as Array<{ id: string }>;
          for (const { id } of ids) {
            for (const k of db.prepare("SELECT fts_rowid FROM lexical_keys WHERE id=?").all(String(id))) db.prepare("DELETE FROM lexical WHERE rowid=?").run(Number(k.fts_rowid));
            for (const t of ["lexical_keys", "entries", "vectors", "purge_pending"]) db.prepare(`DELETE FROM ${t} WHERE id=?`).run(String(id));
          }
        });
      }
      downTxn(db, () => db.exec("DROP TABLE IF EXISTS purge_pending"));
    }
    if (hasTable(db, "lexical") && !downMergePass(db, "lexical", maxSteps)) return false;
    const truncated = Number(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy ?? 1) === 0;
    if (!truncated) return false;
    downTxn(db, () => {
      const saved = meta(db, "delete_scrub_merge");
      if (saved) { const merge = JSON.parse(saved) as { table?: string }; if (merge.table !== "lexical") setMeta(db, "delete_scrub_merge", JSON.stringify({ ...merge, table: "lexical", started: false })); }
      if (hasTable(db, "lexical")) { db.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',4)"); db.exec("INSERT INTO lexical(lexical,rank) VALUES('crisismerge',16)"); }
      delMeta(db, ...AGE_META_KEYS, ...MEMW_META_KEYS, "text_bytes:lexical_age", "debt_bytes:lexical_age", "text_bytes:lexical_retired", "debt_bytes:lexical_retired");
      db.prepare("DELETE FROM index_meta WHERE key LIKE 'overrun\\_k:%' ESCAPE '\\'").run();
    });
    return Number(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy ?? 1) === 0;
  } finally { db.close(); }
}
