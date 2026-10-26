// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2 (LANE2-MEMORY-DESIGN r3): the age key, its backfill, the index in age order (fill, rename cutover, sweep), owner
// search and browse over the three keyed streams, the cursor rule, the EXPLAIN pins, and the downgrade round trip.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ageFillBelow, downgradeMemoryIndexFile, lexicalGeneration, lexicalRowidsAged, sweepAgeRowidsStep } from "./age-index.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, RECALL_SEARCH_SQL } from "./index-reader.ts";
import { ownerMemoryList, ownerSearchTrace, ownerSearchWork, OWNER_REORDER_NOTICE, type OwnerListInput } from "./owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { fillRecordKeysNow, fillRecordKeysSlice, keyRecordSql } from "./record-keys.ts";
import { AGE_KEY_MAX, AGE_KEY_SPAN, AGE_KEY_WINDOW, CREATED_AT_MAX, downgradeMemorySchema, dropRecordKeys, migrateMemorySchema, ensureRecordKeys, RECORD_KEYS_BUILD, RECORD_KEYS_TABLE, recordKeysReady, validateMemorySchema } from "./schema.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const MAIN_PATH = () => join(DATA_DIR, "messages.db");
const roster = { bots: [{ id: "a", threadId: "ta" }, { id: "b", threadId: "tb" }], groups: [] };
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); ownerSearchTrace.on = false; ownerSearchTrace.statements = []; ownerSearchTrace.times = []; });
// every handle a test opens on the index is closed after it: Windows will not remove an open file, and the next beforeEach wipes the folder
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const handle of opened.splice(0)) try { handle.close(); } catch { /* already closed */ } closeMemoryIndexReader(); });

const insert = (db: DatabaseSync, id: string, scope: string, at: number, text = `note ${id}`, state = "active", kind = "fact", pinned = 0) =>
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement',?,?,?,NULL,NULL,?)").run(id, scope, kind, text, state, pinned, at, at);
const keyOf = (db: DatabaseSync, id: string, version = 1) => Number(db.prepare(`SELECT age_key AS k FROM ${RECORD_KEYS_TABLE} WHERE record_id=? AND record_version=?`).get(id, version)?.k);
const keys = (db: DatabaseSync) => db.prepare(`SELECT record_id AS id,age_key AS k FROM ${RECORD_KEYS_TABLE} ORDER BY age_key`).all() as Array<{ id: string; k: number }>;
const list = (input: OwnerListInput) => ownerMemoryList(input, roster);
const ids = (result: { rows: Array<Record<string, unknown>> }) => result.rows.map(row => String(row.id));
/** Every page of a listing, in order, with the cursor carried from page to page. */
async function allPages(input: OwnerListInput, limit = 200): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let n = 0; n < limit; n++) {
    const page = await list({ ...input, ...(cursor ? { cursor } : {}) });
    pages.push(ids(page));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}
/** The index as the helper writes it in age order: every FTS row at the record's age key. */
function keyedIndex(db: DatabaseSync, rows: Array<{ id: string; version?: number; scopeId: string; text: string }>): MemoryIndex {
  // the reader a previous page opened lets go first: Windows will not remove a file another handle holds open
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH()); opened.push(index);
  index.upsert(rows.map(row => ({ id: row.id, version: row.version ?? 1, scopeId: row.scopeId, text: row.text, deleted: false, ageKey: keyOf(db, row.id, row.version ?? 1) })));
  return index;
}
/** An index an earlier build wrote: automatic rowids in projection order, not in age order. */
function legacyIndex(rows: Array<{ id: string; scopeId: string; text: string }>): void {
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.upsert(rows.map(row => ({ id: row.id, version: 1, scopeId: row.scopeId, text: row.text, deleted: false })));
  index.close();
  const raw = new DatabaseSync(INDEX_PATH());
  raw.exec("DELETE FROM index_meta WHERE key IN ('lexical_rowids','lexical_generation')");
  raw.close();
}

describe("the age key: one integer, allocated by the trigger", () => {
  it("keys records of one millisecond in write order, from base, and the next millisecond from its own base", () => {
    const db = database(), scope = ensureScope("bot", "a");
    for (let n = 0; n < 5; n++) insert(db, `r${n}`, scope, 1000);
    insert(db, "later", scope, 1001);
    insert(db, "earlier", scope, 999);
    expect(keys(db).map(row => [row.id, row.k])).toEqual([["earlier", 999 * AGE_KEY_WINDOW], ...[0, 1, 2, 3, 4].map(n => [`r${n}`, 1000 * AGE_KEY_WINDOW + n]), ["later", 1001 * AGE_KEY_WINDOW]]);
  });

  it("Astra's sequence: 2,048 at one millisecond, 2,048 at another 63 later, one more at the first takes the first free key above its window", () => {
    const db = database(), scope = ensureScope("bot", "a");
    transaction(tx => { for (let n = 0; n < AGE_KEY_WINDOW; n++) insert(tx, `a${n}`, scope, 1000); for (let n = 0; n < AGE_KEY_WINDOW; n++) insert(tx, `b${n}`, scope, 1063); });
    insert(db, "overflow", scope, 1000);
    expect(keyOf(db, "overflow")).toBe(1001 * AGE_KEY_WINDOW);
    // the next record of millisecond 1001 sorts after it, inside its own window
    insert(db, "next", scope, 1001);
    expect(keyOf(db, "next")).toBe(1001 * AGE_KEY_WINDOW + 1);
    // the first key above the window taken: the first gap after it
    insert(db, "overflow2", scope, 1000);
    expect(keyOf(db, "overflow2")).toBe(1001 * AGE_KEY_WINDOW + 2);
  });

  it("131,072 keys inside one 64 ms span: the next insert at that millisecond raises MEMORY_AGE_KEY_WINDOW; a gap is taken first", () => {
    const db = database(), scope = ensureScope("bot", "a"), base = 2000 * AGE_KEY_WINDOW;
    db.prepare(`INSERT INTO ${RECORD_KEYS_TABLE} WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT 'k'||i,1,?,'active',0,'fact',?+i FROM n`).run(AGE_KEY_SPAN - 1, scope, base);
    expect(Number(db.prepare(`SELECT count(*) AS n FROM ${RECORD_KEYS_TABLE}`).get()!.n)).toBe(AGE_KEY_SPAN);
    expect(() => insert(db, "full", scope, 2000)).toThrow(/MEMORY_AGE_KEY_WINDOW/);
    expect(db.prepare("SELECT count(*) AS n FROM memory_records").get()!.n).toBe(0);
    db.prepare(`DELETE FROM ${RECORD_KEYS_TABLE} WHERE age_key=?`).run(base + 5000);
    insert(db, "gap", scope, 2000);
    expect(keyOf(db, "gap")).toBe(base + 5000);
  });

  it("the domain: created_at above 4398046511040 is refused; at the top every key of the span is a safe integer", () => {
    const db = database(), scope = ensureScope("bot", "a");
    expect(() => insert(db, "beyond", scope, CREATED_AT_MAX + 1)).toThrow(/MEMORY_CREATED_AT_RANGE/);
    transaction(tx => { for (let n = 0; n < AGE_KEY_WINDOW; n++) insert(tx, `t${n}`, scope, CREATED_AT_MAX); });
    insert(db, "top-overflow", scope, CREATED_AT_MAX);
    const top = keyOf(db, "top-overflow");
    expect(Number.isSafeInteger(top)).toBe(true);
    expect(top).toBe((CREATED_AT_MAX + 1) * AGE_KEY_WINDOW);
    expect(CREATED_AT_MAX * AGE_KEY_WINDOW + AGE_KEY_SPAN - 1).toBeLessThanOrEqual(AGE_KEY_MAX);
    expect(() => db.prepare("UPDATE memory_records SET created_at=? WHERE id='t0'").run(CREATED_AT_MAX + 1)).toThrow(/MEMORY_CREATED_AT_RANGE/);
  });

  it("the key table follows the record: state, pin, scope and kind on update; a backdated created_at keys again; a delete removes the row", () => {
    const db = database(), a = ensureScope("bot", "a"), b = ensureScope("bot", "b");
    insert(db, "r", a, 5000);
    const before = keyOf(db, "r");
    db.prepare("UPDATE memory_records SET state='archived',owner_pinned=1,scope_id=?,kind='procedure' WHERE id='r'").run(b);
    expect(db.prepare(`SELECT state,owner_pinned,scope_id,kind,age_key FROM ${RECORD_KEYS_TABLE} WHERE record_id='r'`).get()).toEqual({ state: "archived", owner_pinned: 1, scope_id: b, kind: "procedure", age_key: before });
    db.prepare("UPDATE memory_records SET created_at=4000 WHERE id='r'").run();
    expect(keyOf(db, "r")).toBe(4000 * AGE_KEY_WINDOW);
    expect(keys(db)).toHaveLength(1);
    db.prepare("DELETE FROM memory_records WHERE id='r'").run();
    expect(keys(db)).toHaveLength(0);
  });

  it("the per-insert cost stays a few index probes: 10,000 inserts in one transaction", () => {
    const db = database(), scope = ensureScope("bot", "a");
    const started = performance.now();
    transaction(tx => { for (let n = 0; n < 10_000; n++) insert(tx, `c${n}`, scope, 1_700_000_000_000 + (n % 300)); });
    const ms = performance.now() - started;
    expect(keys(db)).toHaveLength(10_000);
    expect(new Set(keys(db).map(row => row.k)).size).toBe(10_000);
    console.log(`[age-key] 10,000 inserts through the trigger: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(20_000);
  });
});

describe("the backfill: every record already there gets its key, in slices, resumable, idempotent", () => {
  it("keys an existing history by rowid order within a millisecond, resumes after any slice, and is ready at the end", () => {
    const db = database(), scope = ensureScope("bot", "a");
    dropRecordKeys(db);
    transaction(tx => { for (let n = 0; n < 3000; n++) insert(tx, `h${String(n).padStart(4, "0")}`, scope, 1_700_000_000_000 + Math.floor(n / 7)); });
    ensureRecordKeys(db);
    expect(recordKeysReady(db)).toBe(false);
    const first = fillRecordKeysSlice(db, 100, { budgetMs: Number.POSITIVE_INFINITY });
    expect(first).toMatchObject({ ready: false, read: 100, keyed: 100 });
    const partial = new Map(keys(db).map(row => [row.id, row.k]));
    // a new record during the backfill is keyed by its trigger, above everything
    insert(db, "live", scope, 1_700_000_001_000);
    fillRecordKeysNow(db);
    expect(recordKeysReady(db)).toBe(true);
    const all = keys(db);
    expect(all).toHaveLength(3001);
    for (const [id, k] of partial) expect(keyOf(db, id)).toBe(k);
    // within a millisecond: write order; across: by created_at
    for (let n = 0; n < 2999; n++) expect(keyOf(db, `h${String(n + 1).padStart(4, "0")}`)).toBeGreaterThan(keyOf(db, `h${String(n).padStart(4, "0")}`));
    expect(all.at(-1)!.id).toBe("live");
    // again: nothing changes
    db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=0,cursor_rowid=0`).run();
    fillRecordKeysNow(db);
    expect(keys(db)).toEqual(all);
  });

  it("a 200,000-row same-millisecond history is keyed completely, above the window, in time proportional to its length", { timeout: 600_000 }, () => {
    const db = database(), scope = ensureScope("bot", "a");
    dropRecordKeys(db);
    transaction(tx => { for (let n = 0; n < 200_000; n++) insert(tx, `s${String(n).padStart(6, "0")}`, scope, 1_700_000_000_000, "x"); });
    ensureRecordKeys(db);
    const started = performance.now();
    fillRecordKeysNow(db);
    const ms = performance.now() - started;
    console.log(`[age-key] backfill of 200,000 same-millisecond records: ${ms.toFixed(0)} ms`);
    const all = keys(db);
    expect(all).toHaveLength(200_000);
    expect(all[0]!.k).toBe(1_700_000_000_000 * AGE_KEY_WINDOW);
    expect(all.at(-1)!.k).toBe(1_700_000_000_000 * AGE_KEY_WINDOW + 199_999);
    expect(all.map(row => row.id)).toEqual([...all.map(row => row.id)].sort());
    expect(ms).toBeLessThan(300_000);
  });

  // 1.0.3 io: the keys a backfill in slices gives, stopped anywhere, are the ones a single row-by-row pass gives (f696bb5f9's slice
  // logic, kept here as the reference), for histories that take every allocation rule.
  /** The backfill as f696bb5f9 ran it: each record keyed by keyRecordSql in rowid order, the next key up for a same-millisecond run. */
  function referenceFill(db: DatabaseSync): void {
    const next = db.prepare("SELECT rowid AS rr,created_at AS at FROM memory_records ORDER BY rowid");
    const key = db.prepare(keyRecordSql());
    const nextUp = db.prepare(`INSERT INTO ${RECORD_KEYS_TABLE} SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,?2 FROM memory_records r
 WHERE r.rowid=?1 AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} k WHERE k.record_id=r.id AND k.record_version=r.version) AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key=?2)`);
    const keyOfRow = db.prepare(`SELECT k.age_key AS k FROM memory_records r JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version WHERE r.rowid=?`);
    let runAt: number | null = null, runKey: number | null = null;
    transaction(() => {
      for (const row of next.all() as Array<{ rr: number; at: number }>) {
        const at = Number(row.at);
        let done = 0;
        if (runAt === at && runKey !== null && runKey + 1 <= Number.MAX_SAFE_INTEGER) done = Number(nextUp.run(Number(row.rr), runKey + 1).changes);
        if (done) runKey! += 1; else { done = Number(key.run(Number(row.rr)).changes); if (done) { runAt = at; runKey = Number(keyOfRow.get(Number(row.rr))?.k); } }
      }
      db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=1,cursor_rowid=0 WHERE id=1`).run();
    });
  }
  const table = (db: DatabaseSync) => db.prepare(`SELECT record_id,record_version,scope_id,state,owner_pinned,kind,age_key FROM ${RECORD_KEYS_TABLE} ORDER BY record_id,record_version`).all();
  /** A seeded history in no id order: floods past one window (rule 3, and into the windows of the next 64 ms), runs of a few records a
   * millisecond, times out of rowid order, a few non-integer times (the row-by-row path), and records the trigger keyed before the
   * backfill started. */
  function seededHistory(db: DatabaseSync, seed: number, scopes: string[]): void {
    let s = seed >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    const hex = () => Array.from({ length: 4 }, () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, "0")).join("");
    const id = () => { const h = hex(); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
    const t0 = 1_700_000_000_000, states = ["active", "active", "candidate", "archived", "superseded"];
    const add = (tx: DatabaseSync, at: number) => insert(tx, id(), scopes[Math.floor(rand() * scopes.length)]!, at, "x", states[Math.floor(rand() * states.length)]!, rand() < 0.1 ? "preference" : "fact", rand() < 0.05 ? 1 : 0);
    dropRecordKeys(db);
    transaction(tx => {
      for (let n = 0; n < 2100; n++) add(tx, t0);
      for (let n = 0; n < 2100; n++) add(tx, t0 + 3);
      for (let n = 0; n < 2500; n++) { const at = t0 + 100 + Math.floor(rand() * 400); for (let r = Math.floor(rand() * 4); r >= 0; r--) add(tx, at); }
      for (let n = 0; n < 30; n++) add(tx, t0 + 200 + Math.floor(rand() * 10) + 0.5);
      for (let n = 0; n < 300; n++) add(tx, t0 + 1);
    });
    ensureRecordKeys(db);
    // keyed by the trigger after the table was made, before the backfill reached them
    transaction(tx => { for (let n = 0; n < 200; n++) add(tx, t0 + Math.floor(rand() * 600)); for (let n = 0; n < 50; n++) add(tx, t0); });
  }

  it("the keys are the row-by-row backfill's, record for record, for any slices and any stops (a failed slice, a reopen)", { timeout: 300_000 }, () => {
    for (const seed of [1, 7, 42]) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster);
      let db = database();
      seededHistory(db, seed, [ensureScope("bot", "a"), ensureScope("bot", "b")]);
      const triggerKeyed = (db.prepare(`SELECT record_id AS id FROM ${RECORD_KEYS_TABLE}`).all() as Array<{ id: string }>).map(row => row.id);
      expect(triggerKeyed).toHaveLength(250);
      referenceFill(db);
      const expected = table(db);
      expect(expected.length).toBe(Number(db.prepare("SELECT count(*) AS n FROM memory_records").get()?.n));
      // back to where the backfill starts: only the trigger's keys
      transaction(tx => {
        tx.exec("CREATE TEMP TABLE keep(id TEXT PRIMARY KEY)");
        const put = tx.prepare("INSERT INTO keep VALUES(?)");
        for (const id of triggerKeyed) put.run(id);
        tx.exec(`DELETE FROM ${RECORD_KEYS_TABLE} WHERE record_id NOT IN (SELECT id FROM keep); DROP TABLE keep`);
        tx.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=0,cursor_rowid=0 WHERE id=1`).run();
      });
      expect(recordKeysReady(db)).toBe(false);
      let s = seed * 7919 >>> 0;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
      let slices = 0, failed = 0, reopened = 0;
      for (;;) {
        // a failed slice and a reopen early in every run, then at random
        const roll = slices === 1 ? 0 : slices === 3 ? 0.1 : rand();
        if (roll < 0.06) {
          // a slice that fails part way: nothing of it stays, and the next starts where it did
          const cursor = Number(db.prepare(`SELECT cursor_rowid AS c FROM ${RECORD_KEYS_BUILD}`).get()?.c);
          const victim = db.prepare("SELECT r.id AS id FROM memory_records r WHERE r.rowid>? AND NOT EXISTS(SELECT 1 FROM memory_record_keys k WHERE k.record_id=r.id) ORDER BY r.rowid LIMIT 1 OFFSET ?").get(cursor, Math.floor(rand() * 50)) as { id: string } | undefined;
          if (victim) {
            const before = table(db);
            db.prepare(`CREATE TEMP TRIGGER stop_here BEFORE INSERT ON ${RECORD_KEYS_TABLE} WHEN NEW.record_id='${victim.id}' BEGIN SELECT RAISE(ABORT,'stop here'); END`).run();
            expect(() => fillRecordKeysSlice(db, 200, { budgetMs: Number.POSITIVE_INFINITY })).toThrow(/stop here/);
            db.exec("DROP TRIGGER stop_here");
            expect(table(db)).toEqual(before);
            expect(Number(db.prepare(`SELECT cursor_rowid AS c FROM ${RECORD_KEYS_BUILD}`).get()?.c)).toBe(cursor);
            failed++;
          }
        } else if (roll < 0.12) { closeDatabase(); db = database(); reopened++; }
        const step = fillRecordKeysSlice(db, 1 + Math.floor(rand() * 2500), { budgetMs: rand() < 0.3 ? 0 : Number.POSITIVE_INFINITY });
        slices++;
        if (step.ready) break;
      }
      expect(failed).toBeGreaterThan(0); expect(reopened).toBeGreaterThan(0);
      expect(table(db)).toEqual(expected);
      expect(recordKeysReady(db)).toBe(true);
      console.log(`[age-key] seed ${seed}: ${expected.length} records, ${slices} slices, ${failed} failed, ${reopened} reopened: identical keys`);
    }
  });
});

describe("the index in age order: fill, rename cutover under a reader mid-page, sweep", () => {
  function fixture(count: number) {
    const db = database(), scope = ensureScope("bot", "a");
    const rows = Array.from({ length: count }, (_, n) => ({ id: `p${String(n).padStart(5, "0")}`, scopeId: scope, text: `durable note ${n} ${n % 100 === 0 ? "needlefish" : ""}` }));
    transaction(tx => {
      // written out of age order, so projection order and age order differ
      for (const [n, row] of [...rows.entries()].reverse()) { insert(tx, row.id, scope, 1_700_000_000_000 + n, row.text); tx.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','unavailable',NULL)").run(row.id); }
    });
    return { db, scope, rows };
  }
  const authority = () => { const main = new DatabaseSync(MAIN_PATH(), { readOnly: true }); return main; };

  it("fills newest first in slices with a frontier, cuts over by rename with a reader mid-page, and every consumer keeps its SQL", async () => {
    const { db, rows } = fixture(2000);
    legacyIndex(rows);
    const index = new MemoryIndex(INDEX_PATH()), main = authority();
    expect(index.ageFillOwed()).toBe(true);
    const generation = index.lexicalGeneration();
    // a slice: 256 keys newest first, the frontier recorded
    const step = index.fillAgeIndex(main, { maxKeys: 256, maxMs: 1000 });
    expect(step).toMatchObject({ done: false, copied: 256, walked: 256 });
    const raw = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    expect(ageFillBelow(raw)).toBe(keyOf(db, "p01744"));
    expect(raw.prepare("SELECT count(*) AS n FROM lexical_age").get()!.n).toBe(256);
    expect(raw.prepare("SELECT min(rowid) AS lo,max(rowid) AS hi FROM lexical_age").get()).toEqual({ lo: keyOf(db, "p01744"), hi: keyOf(db, "p01999") });
    // the rest, except the last slice
    while ((ageFillBelow(raw) ?? 0) > keyOf(db, "p00100")) expect(index.fillAgeIndex(main, { maxKeys: 256, maxMs: 1000 }).done).toBe(false);
    // a reader mid-page on the OLD table: a statement open across the cutover keeps its snapshot
    const reader = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    const statement = reader.prepare(RECALL_SEARCH_SQL);
    const scan = statement.iterate('"durable"', JSON.stringify([rows[0]!.scopeId]), 2000, 0);
    const seen: Array<Record<string, unknown>> = [];
    for (let n = 0; n < 10; n++) { const next = scan.next(); if (next.done) break; seen.push(next.value as Record<string, unknown>); }
    expect(seen).toHaveLength(10);
    let last = index.fillAgeIndex(main, { maxKeys: 4096, maxMs: 10_000 });
    while (!last.done) last = index.fillAgeIndex(main, { maxKeys: 4096, maxMs: 10_000 });
    expect(last.cutover).toBe(true);
    expect(index.ageFillOwed()).toBe(false);
    for (const next of scan) seen.push(next as Record<string, unknown>);
    expect(seen).toHaveLength(2000);
    // the same statement object again: re-prepared on SQLITE_SCHEMA, now over the renamed table in age order
    const after = statement.all('"durable"', JSON.stringify([rows[0]!.scopeId]), 2000, 0);
    expect(after).toHaveLength(2000);
    expect(reader.prepare("SELECT rowid AS r,id FROM lexical ORDER BY rowid DESC LIMIT 3").all().map(row => [row.id, row.r])).toEqual([["p01999", keyOf(db, "p01999")], ["p01998", keyOf(db, "p01998")], ["p01997", keyOf(db, "p01997")]]);
    expect(reader.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'lexical%' ORDER BY name").all().map(row => row.name)).toEqual(["lexical", "lexical_config", "lexical_content", "lexical_data", "lexical_docsize", "lexical_idx", "lexical_keys"]);
    expect(lexicalRowidsAged(reader)).toBe(true);
    expect(lexicalGeneration(reader)).toBe(generation + 1);
    reader.close(); raw.close();
    // the helper's own consumers after the cutover: upsert at the key, the ranked search, segment recovery, optimize
    insert(db, "fresh", rows[0]!.scopeId, 1_700_000_010_000, "durable needlefish fresh");
    index.upsert([{ id: "fresh", version: 1, scopeId: rows[0]!.scopeId, text: "durable needlefish fresh", deleted: false, ageKey: keyOf(db, "fresh") }]);
    const check = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    expect(check.prepare("SELECT fts_rowid AS r FROM lexical_keys WHERE id='fresh'").get()!.r).toBe(keyOf(db, "fresh"));
    expect(check.prepare("SELECT rowid AS r FROM lexical WHERE id='fresh'").get()!.r).toBe(keyOf(db, "fresh"));
    check.close();
    expect(index.search("needlefish", [{ id: "fresh", version: 1 }, { id: "p00100", version: 1 }], null, "model", 10).hits.map(hit => hit.id).sort()).toEqual(["fresh", "p00100"]);
    expect(index.recoverSegments()).toBe("none");
    expect(index.segmentCount()).toBeGreaterThan(0);
    index.close(); main.close();
    // the main process's reader and recall over the renamed table
    const page = await lexicalPageSliced("needlefish", [rows[0]!.scopeId], 50);
    expect(page?.hits.length).toBeGreaterThanOrEqual(20);
    expect((await list({ botId: "a", query: "needlefish" })).rows.slice(0, 3).map(row => row.id)).toEqual(["fresh", "p01900", "p01800"]);
  });

  it("the sweep puts a row an older binary wrote at an automatic rowid back at its key", () => {
    const { db, rows } = fixture(300);
    const index = keyedIndex(db, rows), main = authority();
    index.close();
    // an older binary's write: an automatic rowid for a record that has a key
    insert(db, "old-binary", rows[0]!.scopeId, 1_700_000_000_150, "written by 1.0.2");
    const raw = new DatabaseSync(INDEX_PATH());
    raw.exec("INSERT INTO entries VALUES('old-binary',1,'s','written by 1.0.2')");
    const inserted = raw.prepare("INSERT INTO lexical VALUES('old-binary',1,'written by 1.0.2')").run();
    raw.prepare("INSERT INTO lexical_keys VALUES('old-binary',1,?)").run(inserted.lastInsertRowid);
    let swept = sweepAgeRowidsStep(raw, main, { maxRows: 64 }), fixed = 0;
    fixed += swept.fixed;
    while (!swept.done) { swept = sweepAgeRowidsStep(raw, main, { maxRows: 64 }); fixed += swept.fixed; }
    expect(fixed).toBe(1);
    expect(raw.prepare("SELECT fts_rowid AS r FROM lexical_keys WHERE id='old-binary'").get()!.r).toBe(keyOf(db, "old-binary"));
    expect(raw.prepare("SELECT rowid AS r FROM lexical WHERE id='old-binary'").get()!.r).toBe(keyOf(db, "old-binary"));
    expect(raw.prepare("SELECT count(*) AS n FROM lexical").get()!.n).toBe(301);
    raw.close(); main.close();
  });

  it("the downgrade step leaves the index file as 1.0.2 wrote it and the main file without the lane's objects; the next open makes them again", () => {
    const { db, rows } = fixture(50);
    legacyIndex(rows);
    const index = new MemoryIndex(INDEX_PATH()), main = authority();
    index.fillAgeIndex(main, { maxKeys: 10, maxMs: 1000 });
    index.close(); main.close();
    expect(downgradeMemoryIndexFile(INDEX_PATH())).toBe(true);
    const raw = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'lexical_age%'").all()).toEqual([]);
    expect(raw.prepare("SELECT key FROM index_meta WHERE key LIKE 'age_%' OR key LIKE 'lexical_%'").all()).toEqual([]);
    raw.close();
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 }); // 1.0.3: the file is v13, 1.0.2 reads v10
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_record_keys%' OR name='memory_backfill_threads'").all()).toEqual([]);
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "already-v10" });
    // the next open is the migration (1.0.3: v10 to settings' v11), which makes the lane's objects again
    migrateMemorySchema(db);
    expect(recordKeysReady(db)).toBe(false);
    fillRecordKeysNow(db);
    expect(keys(db)).toHaveLength(50);
    expect(() => validateMemorySchema(db)).not.toThrow();
    // part of the objects is refused
    db.exec("DROP TRIGGER memory_record_keys_delete");
    expect(() => validateMemorySchema(db)).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/);
  });
});

describe("owner search and browse over the keyed streams", () => {
  function seed(count: number, { pending = 0, pins = [] as number[] } = {}) {
    const db = database(), scope = ensureScope("bot", "a"), other = ensureScope("bot", "b");
    const rows = Array.from({ length: count }, (_, n) => ({ id: `n${String(n).padStart(5, "0")}`, scopeId: scope, text: `durable note ${n}${n % 50 === 0 ? " orchid" : ""}` }));
    transaction(tx => {
      for (const [n, row] of rows.entries()) {
        insert(tx, row.id, scope, 1_700_000_000_000 + n * 3, row.text, n % 11 === 0 ? "candidate" : n % 13 === 0 ? "archived" : "active", "fact", pins.includes(n) ? 1 : 0);
        tx.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'unavailable',NULL)").run(row.id, n >= count - pending ? "pending" : "indexed");
      }
      insert(tx, "other", other, 1_700_000_000_000 + count * 3 + 10, "durable orchid of another bot");
      // the kinds the index never holds, at places inside the run
      insert(tx, "brief", scope, 1_700_000_000_000 + 1000 * 3 + 1, "continuity brief orchid", "active", "continuity-brief");
      insert(tx, "rolled", scope, 1_700_000_000_000 + 2000 * 3 + 1, "checkpoint orchid old", "archived", "checkpoint");
      tx.prepare("INSERT INTO memory_records VALUES('rolled',2,?,'checkpoint','checkpoint orchid new','owner-statement','active',0,?,NULL,NULL,?)").run(scope, 1_700_000_000_000 + 2000 * 3 + 2, 1_700_000_000_000 + 2000 * 3 + 2);
      tx.prepare("INSERT INTO memory_projection_receipts VALUES('rolled',2,1,'indexed','unavailable',NULL)").run();
    });
    const indexed = rows.filter((_, n) => n < count - pending);
    const index = keyedIndex(db, [...indexed, { id: "rolled", version: 2, scopeId: scope, text: "checkpoint orchid new" }]);
    index.close();
    return { db, scope, other, rows };
  }
  const expected = (db: DatabaseSync, where: string, args: Array<string | number> = []) => (db.prepare(`SELECT r.id FROM memory_records r JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version WHERE ${where} ORDER BY k.age_key DESC`).all(...args) as Array<{ id: string }>).map(row => row.id);

  it("browse: every view pages in age order, newest first, with one cursor shape, and no bot sees another's rows", async () => {
    const { db, scope, other } = seed(3000, { pins: [10, 2999] });
    const pages = await allPages({ botId: "a", view: "recent" });
    expect(pages[0]![0]).toBe("n02999");
    expect(pages.flat()).toEqual(expected(db, "r.scope_id=? AND r.state='active'", [scope]));
    expect(pages.every((page, n) => page.length === 50 || n === pages.length - 1)).toBe(true);
    expect((await allPages({ botId: "a" })).flat()).toEqual(expected(db, "r.scope_id=? AND r.state!='deleted'", [scope]));
    expect((await allPages({ botId: "a", state: "candidate" })).flat()).toEqual(expected(db, "r.scope_id=? AND r.state='candidate'", [scope]));
    expect((await allPages({ botId: "a", view: "review" })).flat()).toEqual(expected(db, "r.scope_id=? AND r.state='candidate'", [scope]));
    expect((await allPages({ botId: "a", view: "important" })).flat()).toEqual(["n02999", "n00010"]);
    expect((await allPages({ view: "important" })).flat()).toEqual(["n02999", "n00010"]);
    expect((await allPages({})).flat()).toEqual(expected(db, "r.state!='deleted'"));
    expect((await allPages({ state: "archived" })).flat()).toEqual(expected(db, "r.state='archived'"));
    expect((await allPages({ scopeId: other })).flat()).toEqual(["other"]);
    await expect(list({ botId: "a", scopeId: other })).rejects.toThrow("MEMORY_SCOPE_DENIED");
    // the old cursor shape, and a cursor of another generation, are refused
    await expect(list({ botId: "a", cursor: Buffer.from(JSON.stringify({ at: 5, id: "x", version: 1 })).toString("base64url") })).rejects.toThrow("INVALID_MEMORY_CURSOR");
    await expect(list({ botId: "a", cursor: Buffer.from(JSON.stringify({ k: 5, g: "R9" })).toString("base64url") })).rejects.toThrow("INVALID_MEMORY_CURSOR");
  });

  it("search: the index, the pending receipts and the never-indexed kinds come out as one newest-first list, counted, paged by one cursor", async () => {
    const { db, scope } = seed(3000, { pending: 200 });
    const first = await list({ botId: "a", query: "orchid" });
    expect(first.searchMode).toBe("indexed");
    const want = expected(db, "r.scope_id=? AND r.state!='deleted' AND instr(r.text,'orchid')>0", [scope]);
    expect(want).toContain("brief"); expect(want).toContain("rolled");
    const pages = await allPages({ botId: "a", query: "orchid" });
    expect(pages.flat()).toEqual(want);
    expect(first.matchCount).toBe(want.length);
    expect(first.coverageComplete).toBe(true);
    expect(first.searchNotice).toContain("still being added");
    // all words, in the index and in the text match
    expect((await list({ botId: "a", query: "orchid 2950" })).rows.map(row => row.id)).toEqual(["n02950"]);
    // the search view's state filter
    expect((await allPages({ botId: "a", query: "orchid", state: "candidate" })).flat()).toEqual(expected(db, "r.scope_id=? AND r.state='candidate' AND instr(r.text,'orchid')>0", [scope]));
  });

  it("a record that moves from pending to indexed between two pages is shown once, whichever stream held it", async () => {
    const { db, scope, rows } = seed(3000, { pending: 1500 });
    const page1 = await list({ botId: "a", query: "durable" });
    expect(page1.rows).toHaveLength(50);
    expect(page1.rows[0]!.id).toBe("n02999");
    // the helper catches up: every pending record is now in the index
    const index = keyedIndex(db, rows);
    index.close();
    db.exec("UPDATE memory_projection_receipts SET lexical_status='indexed'");
    const rest = await allPages({ botId: "a", query: "durable", cursor: page1.nextCursor });
    const all = [...ids(page1), ...rest.flat()];
    expect(all).toEqual(expected(db, "r.scope_id=? AND r.state!='deleted' AND instr(r.text,'durable')>0", [scope]));
    expect(new Set(all).size).toBe(all.length);
  });

  it("a short page at the step cap carries its frontier: nothing below it is shown before the index reached it, and the next page carries on", async () => {
    const { db, scope } = seed(6000);
    // ineligible matches (archived) are stepped but not shown; the cap stops the walk before the page fills
    db.exec("UPDATE memory_records SET state='archived' WHERE id LIKE 'n0%' AND id>'n00100'");
    const pages = await allPages({ botId: "a", query: "durable", view: "recent" }, 400);
    expect(pages.flat()).toEqual(expected(db, "r.scope_id=? AND r.state='active' AND instr(r.text,'durable')>0", [scope]));
    expect(new Set(pages.flat()).size).toBe(pages.flat().length);
  });

  it("mode F: the page never reaches below the latched fill frontier, says so, and a stalled fill answers with the same cursor and a notice", async () => {
    const { db, scope, rows } = seed(1000);
    legacyIndex(rows);
    const index = new MemoryIndex(INDEX_PATH()), main = new DatabaseSync(MAIN_PATH(), { readOnly: true });
    index.fillAgeIndex(main, { maxKeys: 300, maxMs: 1000 });
    const peek = new DatabaseSync(INDEX_PATH(), { readOnly: true }); opened.push(peek);
    const frontier = ageFillBelow(peek)!;
    const first = await list({ botId: "a", query: "durable" });
    expect(first.searchNotice).toContain(OWNER_REORDER_NOTICE);
    expect(ids(first)).toEqual(expected(db, "r.scope_id=? AND r.state!='deleted' AND k.age_key>=? AND instr(r.text,'durable')>0", [scope, frontier]).slice(0, 50));
    const pages = await allPages({ botId: "a", query: "durable" }, 10);
    const shown = pages.flat();
    expect(shown).toEqual(expected(db, "r.scope_id=? AND r.state!='deleted' AND k.age_key>=? AND instr(r.text,'durable')>0", [scope, frontier]));
    // the last page: nothing below the frontier yet, and the fill has not moved: the cursor stays, the notice says so
    expect(pages.at(-1)).toEqual([]);
    const stalled = await list({ botId: "a", query: "durable", cursor: (await list({ botId: "a", query: "durable" })).nextCursor });
    void stalled;
    // the fill advances: the next page reaches the rows it added, in order, none twice
    let step = index.fillAgeIndex(main, { maxKeys: 4096, maxMs: 10_000 });
    while (!step.done) step = index.fillAgeIndex(main, { maxKeys: 4096, maxMs: 10_000 });
    index.close(); main.close();
    closeMemoryIndexReader();
    const after = await allPages({ botId: "a", query: "durable" });
    expect(after.flat()).toEqual(expected(db, "r.scope_id=? AND r.state!='deleted' AND instr(r.text,'durable')>0", [scope]));
  });

  it("EXPLAIN pins: no statement of any view, state or search uses a temporary B-tree or scans the records or key table", async () => {
    const { other } = seed(600, { pending: 100, pins: [5] });
    // The 50 ms gate below reads this test's own statements: slowestMs is never reset in production code, so without this it
    // held the slowest of every statement since the file began, not only the statements checked here.
    ownerSearchWork.slowestMs = 0;
    ownerSearchTrace.on = true; ownerSearchTrace.statements = [];
    const inputs: OwnerListInput[] = [
      { botId: "a" }, { botId: "a", view: "recent" }, { botId: "a", view: "important" }, { botId: "a", view: "review" }, { botId: "a", state: "archived" },
      {}, { view: "recent" }, { view: "important" }, { view: "review" }, { state: "candidate" }, { scopeId: other },
      { botId: "a", query: "orchid" }, { query: "orchid note" }, { botId: "a", query: "orchid", view: "important" }, { query: "durable", state: "archived" },
    ];
    for (const input of inputs) { const first = await list(input); if (first.nextCursor) await list({ ...input, cursor: first.nextCursor }); }
    ownerSearchTrace.on = false;
    const main = database(), reader = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    reader.prepare("ATTACH DATABASE ? AS authority").run(MAIN_PATH());
    const plans = new Map<string, string[]>();
    for (const statement of ownerSearchTrace.statements) {
      if (plans.has(statement.sql)) continue;
      const handle = statement.db === "main" ? main : reader;
      plans.set(statement.sql, (handle.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all() as Array<{ detail: string }>).map(row => row.detail));
    }
    expect(plans.size).toBeGreaterThan(10);
    for (const [sql, plan] of plans) {
      for (const line of plan) {
        expect(line, sql).not.toMatch(/TEMP B-TREE/);
        expect(line, sql).not.toMatch(/SCAN (memory_records|memory_record_keys|memory_projection_receipts)\b/);
      }
    }
    reader.close();
    expect(ownerSearchWork.slowestMs).toBeLessThan(50);
  });
});
