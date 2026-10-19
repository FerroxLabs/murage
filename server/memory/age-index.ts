// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The search index in age order (1.0.3 lane 2, LANE2-MEMORY-DESIGN r2.3, r3.5, M6). Owner search walks the word table by its rowid
// (FTS5 reads a term's postings in rowid order natively, in both directions), so when every record's FTS row sits at
// `rowid = age_key` (schema.ts RECORD_KEYS_SCHEMA) the walk is a newest-first stream that costs the rows it returns. An index an
// earlier build wrote has automatic rowids in projection order. It is never rekeyed in place: a second word table, `lexical_age`
// (the same FTS5 definition) with `lexical_age_keys` (the exact columns of `lexical_keys`), is filled newest first by the helper in
// slices, each one transaction that also records the key it got to (`age_fill_below`), while `lexical` keeps answering. When the walk
// ends, one transaction cuts over by RENAME: `lexical` and `lexical_keys` are dropped, `lexical_age` becomes `lexical` and
// `lexical_age_keys` becomes `lexical_keys` (FTS5 renames its shadow tables with the virtual table), `lexical_rowids` is marked
// 'age' and `lexical_generation` moves. No consumer changes its SQL: a prepared statement on another connection re-prepares on
// SQLITE_SCHEMA, and a reader mid-page keeps its WAL snapshot. A fresh index (no word row yet) is marked 'age' at once.
//
// Space (M6): before each slice the helper checks the free space against the bytes still to copy (summed once at the fill's start,
// decremented per slice) plus 64 MB, and waits otherwise; a document over AGE_FILL_SLICE_BYTES is copied alone in its own slice.
//
// After the cutover, an older binary run on the same file (the "copied binary" case) inserts `lexical` rows with automatic rowids:
// the sweep compares `lexical_keys.fts_rowid` with the authority's `age_key` in 256-row slices and re-inserts each mismatch at its key.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const LEXICAL_ROWIDS = "lexical_rowids";
export const AGE_FILL_BELOW = "age_fill_below";
export const LEXICAL_GENERATION = "lexical_generation";
const AGE_SWEEP_AFTER = "age_sweep_after";
const AGE_FILL_REMAINING = "age_fill_remaining";
export const AGE_META_KEYS = [LEXICAL_ROWIDS, AGE_FILL_BELOW, LEXICAL_GENERATION, AGE_SWEEP_AFTER, AGE_FILL_REMAINING];
/** Keys one fill slice walks, at most, and the text it copies before it stops (a larger document is copied alone). */
export const AGE_FILL_SLICE_KEYS = 256;
export const AGE_FILL_SLICE_BYTES = 1024 * 1024;
/** Free space the fill keeps beyond what it still has to copy. */
export const AGE_FILL_RESERVE_BYTES = 64 * 1024 * 1024;
export const AGE_SWEEP_SLICE_ROWS = 256;

export const LEXICAL_AGE_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS lexical_age USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS lexical_age_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));`;

const meta = (db: DatabaseSync, key: string): string | null => { const row = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return row ? String(row.value) : null; };
const setMeta = (db: DatabaseSync, key: string, value: string) => db.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(key, value);
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));

/** Whether every FTS row of `lexical` sits at its record's age key (mode R of owner search). */
export function lexicalRowidsAged(db: DatabaseSync): boolean { return meta(db, LEXICAL_ROWIDS) === "age"; }
/** Moves at every cutover (and index reset): a page cursor carries it, and one from another generation is refused. */
export function lexicalGeneration(db: DatabaseSync): number { return Number(meta(db, LEXICAL_GENERATION) ?? 0); }
/** The fill's frontier: every record with age_key >= this is in `lexical_age`. Null before the fill wrote anything. */
export function ageFillBelow(db: DatabaseSync): number | null { const value = meta(db, AGE_FILL_BELOW); return value === null ? null : Number(value); }
/** Whether the second word table exists (mode F of owner search reads it). */
export function ageTablesPresent(db: DatabaseSync): boolean { return hasTable(db, "lexical_age"); }

/** An index with no word row yet needs no fill: its rowids are age keys from the first row. One short transaction when it applies. */
export function markFreshIndexAged(db: DatabaseSync): boolean {
  if (lexicalRowidsAged(db)) return true;
  if (db.prepare("SELECT 1 FROM lexical_keys LIMIT 1").get()) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM lexical_keys LIMIT 1").get()) { setMeta(db, LEXICAL_ROWIDS, "age"); if (meta(db, LEXICAL_GENERATION) === null) setMeta(db, LEXICAL_GENERATION, "1"); }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
  return lexicalRowidsAged(db);
}

/** Makes the second word table and its keys (schema pages only). */
export function ensureAgeTables(db: DatabaseSync): void {
  if (ageTablesPresent(db) && hasTable(db, "lexical_age_keys")) return;
  db.exec("BEGIN IMMEDIATE");
  try { db.exec(LEXICAL_AGE_SCHEMA); db.exec("COMMIT"); }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
}

export interface AgeFillOptions { maxMs?: number; maxKeys?: number; maxBytes?: number; reserveBytes?: number; freeBytes?: () => number | null }
export interface AgeFillStep { done: boolean; copied: number; walked: number; waiting?: "disk"; cutover?: boolean }
const busy = (error: unknown) => /database is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error));
/** Takes the write lock with no wait (the helper never sits in a synchronous busy wait); the connection's usual wait is put back either way. */
function beginNoWait(db: DatabaseSync): boolean {
  const usual = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
  db.exec("PRAGMA busy_timeout=0");
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (error) { if (busy(error)) return false; throw error; }
  finally { db.exec(`PRAGMA busy_timeout=${usual}`); }
}

/** Bytes of text still to copy: every entry's text, less what `lexical_age` already holds, summed once when the fill starts in this
 * process and kept in `index_meta` so the check is one read per slice afterwards. */
function remainingBytes(db: DatabaseSync): number {
  const kept = meta(db, AGE_FILL_REMAINING);
  if (kept !== null) return Number(kept);
  const total = Number(db.prepare("SELECT coalesce(sum(length(text)),0) AS n FROM entries").get()?.n ?? 0);
  const copied = Number(db.prepare("SELECT coalesce(sum(length(e.text)),0) AS n FROM lexical_age_keys k JOIN entries e ON e.id=k.id AND e.version=k.version").get()?.n ?? 0);
  const remaining = Math.max(0, total - copied);
  setMeta(db, AGE_FILL_REMAINING, String(remaining));
  return remaining;
}

/** One slice of the fill: the next keys below the frontier (newest first) from the authority's key table, each present in `entries`
 * and absent from `lexical_age_keys` copied at `rowid = age_key`, the frontier recorded, all in one transaction. When no key is left
 * the slice cuts over instead. The write lock is taken with no wait: `busy` means try again later. */
export function fillAgeIndexStep(db: DatabaseSync, authority: DatabaseSync, options: AgeFillOptions = {}): AgeFillStep & { busy?: true } {
  if (lexicalRowidsAged(db)) return { done: true, copied: 0, walked: 0 };
  const maxMs = options.maxMs ?? 10, maxKeys = Math.max(1, options.maxKeys ?? AGE_FILL_SLICE_KEYS), maxBytes = Math.max(1, options.maxBytes ?? AGE_FILL_SLICE_BYTES);
  try {
    ensureAgeTables(db);
    const below = ageFillBelow(db);
    const keys = (below === null
      ? authority.prepare("SELECT record_id AS id,record_version AS version,age_key AS k FROM memory_record_keys ORDER BY age_key DESC LIMIT ?").all(maxKeys)
      : authority.prepare("SELECT record_id AS id,record_version AS version,age_key AS k FROM memory_record_keys WHERE age_key<? ORDER BY age_key DESC LIMIT ?").all(below, maxKeys)) as Array<{ id: string; version: number; k: number }>;
    if (!keys.length) { const cut = cutoverAgeIndex(db); return cut === "busy" ? { done: false, copied: 0, walked: 0, busy: true } : { done: true, copied: 0, walked: 0, cutover: true }; }
    // M6: the space the rest of the fill needs, plus the reserve; below it the slice waits.
    const free = options.freeBytes?.();
    if (free !== null && free !== undefined) {
      const remaining = remainingBytes(db);
      if (free < remaining + (options.reserveBytes ?? AGE_FILL_RESERVE_BYTES)) return { done: false, copied: 0, walked: 0, waiting: "disk" };
    }
    const started = performance.now();
    if (!beginNoWait(db)) return { done: false, copied: 0, walked: 0, busy: true };
    let copied = 0, walked = 0, bytes = 0, last = below;
    try {
      const entry = db.prepare("SELECT text FROM entries WHERE id=? AND version=?"), present = db.prepare("SELECT 1 FROM lexical_age_keys WHERE id=? AND version=?");
      const insert = db.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,?,?)"), key = db.prepare("INSERT INTO lexical_age_keys VALUES(?,?,?)");
      for (const row of keys) {
        const text = entry.get(String(row.id), Number(row.version));
        if (text && !present.get(String(row.id), Number(row.version))) {
          const size = Buffer.byteLength(String(text.text));
          if (copied && bytes + size > maxBytes) break;
          insert.run(Number(row.k), String(row.id), Number(row.version), String(text.text));
          key.run(String(row.id), Number(row.version), Number(row.k));
          copied++; bytes += size;
        }
        last = Number(row.k); walked++;
        if (copied && performance.now() - started >= maxMs) break;
      }
      setMeta(db, AGE_FILL_BELOW, String(last));
      const remaining = meta(db, AGE_FILL_REMAINING);
      if (remaining !== null) setMeta(db, AGE_FILL_REMAINING, String(Math.max(0, Number(remaining) - bytes)));
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
    return { done: false, copied, walked };
  } catch (error) {
    if (busy(error)) return { done: false, copied: 0, walked: 0, busy: true };
    throw error;
  }
}

/** The cutover (r3.5): one transaction. "busy" when the write lock is held elsewhere. */
export function cutoverAgeIndex(db: DatabaseSync): "done" | "busy" {
  if (!beginNoWait(db)) return "busy";
  try {
    if (!lexicalRowidsAged(db)) {
      if (!ageTablesPresent(db)) db.exec(LEXICAL_AGE_SCHEMA);
      const generation = lexicalGeneration(db);
      db.exec("DROP TABLE lexical; DROP TABLE lexical_keys; ALTER TABLE lexical_age RENAME TO lexical; ALTER TABLE lexical_age_keys RENAME TO lexical_keys;");
      setMeta(db, LEXICAL_ROWIDS, "age");
      setMeta(db, LEXICAL_GENERATION, String(generation + 1));
      db.prepare("DELETE FROM index_meta WHERE key IN (?,?)").run(AGE_FILL_BELOW, AGE_FILL_REMAINING);
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
  try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* a reader holds it; the next checkpoint takes it */ }
  return "done";
}

/** Puts one record's FTS row at `rowid`, moving a row another record left there (an automatic rowid of an older binary) to an
 * automatic rowid of its own; the sweep brings that one to its key in turn. Inside the caller's transaction. */
export function placeLexicalRow(db: DatabaseSync, table: "lexical" | "lexical_age", id: string, version: number, text: string, rowid: number): void {
  const keys = table === "lexical" ? "lexical_keys" : "lexical_age_keys";
  const squatter = db.prepare(`SELECT id,version FROM ${keys} WHERE fts_rowid=? AND NOT (id=? AND version=?)`).get(rowid, id, version);
  if (squatter) {
    db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(rowid);
    db.prepare(`DELETE FROM ${keys} WHERE id=? AND version=?`).run(squatter.id, squatter.version);
  }
  db.prepare(`INSERT INTO ${table}(rowid,id,version,text) VALUES(?,?,?,?)`).run(rowid, id, version, text);
  db.prepare(`INSERT INTO ${keys} VALUES(?,?,?)`).run(id, version, rowid);
  if (squatter) {
    const kept = db.prepare("SELECT text FROM entries WHERE id=? AND version=?").get(squatter.id, squatter.version);
    if (kept) {
      const moved = db.prepare(`INSERT INTO ${table}(id,version,text) VALUES(?,?,?)`).run(squatter.id, squatter.version, String(kept.text));
      db.prepare(`INSERT INTO ${keys} VALUES(?,?,?)`).run(squatter.id, squatter.version, moved.lastInsertRowid);
    }
  }
}

/** One slice of the post-cutover sweep (the copied-binary case): the next rows of `lexical_keys` in key order, each whose rowid is not
 * its record's age key re-inserted at that key. Done when the walk ends; it starts over at the next helper start. */
export function sweepAgeRowidsStep(db: DatabaseSync, authority: DatabaseSync, options: { maxRows?: number } = {}): { done: boolean; examined: number; fixed: number; busy?: true } {
  if (!lexicalRowidsAged(db)) return { done: true, examined: 0, fixed: 0 };
  const maxRows = Math.max(1, options.maxRows ?? AGE_SWEEP_SLICE_ROWS);
  const after = meta(db, AGE_SWEEP_AFTER);
  const cursor: [string, number] = after ? JSON.parse(after) : ["", 0];
  const rows = db.prepare("SELECT id,version,fts_rowid AS r FROM lexical_keys WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?").all(cursor[0], cursor[1], maxRows) as Array<{ id: string; version: number; r: number }>;
  if (!rows.length) { db.prepare("DELETE FROM index_meta WHERE key=?").run(AGE_SWEEP_AFTER); return { done: true, examined: 0, fixed: 0 }; }
  const keyed = new Map<string, number>();
  for (const row of authority.prepare("SELECT k.record_id AS id,k.record_version AS version,k.age_key AS k FROM json_each(?) j JOIN memory_record_keys k ON k.record_id=json_extract(j.value,'$[0]') AND k.record_version=json_extract(j.value,'$[1]')").all(JSON.stringify(rows.map(row => [row.id, row.version]))) as Array<{ id: string; version: number; k: number }>)
    keyed.set(`${row.id}\u0000${row.version}`, Number(row.k));
  const wrong = rows.filter(row => { const k = keyed.get(`${row.id}\u0000${row.version}`); return k !== undefined && k !== Number(row.r); });
  let fixed = 0;
  if (!beginNoWait(db)) return { done: false, examined: 0, fixed: 0, busy: true };
  try {
    for (const row of wrong) {
      const text = db.prepare("SELECT text FROM entries WHERE id=? AND version=?").get(row.id, row.version);
      db.prepare("DELETE FROM lexical WHERE rowid=?").run(Number(row.r));
      db.prepare("DELETE FROM lexical_keys WHERE id=? AND version=?").run(row.id, row.version);
      if (text) { placeLexicalRow(db, "lexical", String(row.id), Number(row.version), String(text.text), keyed.get(`${row.id}\u0000${row.version}`)!); fixed++; }
    }
    const last = rows.at(-1)!;
    setMeta(db, AGE_SWEEP_AFTER, JSON.stringify([String(last.id), Number(last.version)]));
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
  return { done: rows.length < maxRows, examined: rows.length, fixed };
}

/** The index file as 1.0.2 wrote it: the second word table and the lane's markers leave (the "prepare for an older version" step,
 * run with the app stopped, next to the main database's). A `lexical` with age rowids stays: 1.0.2 reads it by rowid and by rank. */
export function downgradeMemoryIndexFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TABLE IF EXISTS lexical_age; DROP TABLE IF EXISTS lexical_age_keys;");
      if (hasTable(db, "index_meta")) db.prepare("DELETE FROM index_meta WHERE key IN (SELECT value FROM json_each(?))").run(JSON.stringify(AGE_META_KEYS));
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } throw error; }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* left to the next open */ }
    return true;
  } finally { db.close(); }
}
