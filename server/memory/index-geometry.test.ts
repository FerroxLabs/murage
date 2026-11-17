// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW-OVERSIZE r4.1 Part A: E4 (geometry enforced at open), E5 (fresh geometry, loop guard), E6 (the closed index_meta key set and the
// put helper). index-wal.ts only. Throwaway temp dirs; the charge transport is injected.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { IndexDamagedError } from "./index-quarantine.ts";
import { AGE_META_KEYS, MEMW_META_KEYS } from "./age-index.ts";
import { ALL_WAL_KINDS, IndexWalWriter, META_ENVELOPE_FRAMES, META_KEY_LIMIT, META_KEYS, META_VALUE_MAX_BYTES, MEMW_W_STEP_BYTES, openIndexWal, WalStop, walTestHooks, type ChargeTransport, type OpenedIndexWal } from "./index-wal.ts";
import { walIndexReader } from "../io-written.ts";

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const roots: string[] = [];
const opened: OpenedIndexWal[] = [];
const grant: ChargeTransport = async () => true;
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Exited(code); }; });
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  for (const o of opened.splice(0)) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function fresh(): string { const root = mkdtempSync(join(tmpdir(), "memw-geom-")); roots.push(root); return join(root, "memory-index.db"); }
function metaDdl(keys: readonly string[]): string {
  return `CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;` + keys.map(k => `INSERT INTO index_meta VALUES('${k}','0');`).join("");
}
/** A WAL-mode file with the given geometry, closed (its header says WAL; the -wal file is gone). */
function rawFile(path: string, pragmas: string, keys: readonly string[]): void {
  const db = new DatabaseSync(path);
  db.exec(`${pragmas}; PRAGMA journal_mode=WAL; ${metaDdl(keys)}`);
  db.close();
}
function geometryOf(path: string): { pageSize: number; autoVacuum: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { pageSize: Number(db.prepare("PRAGMA page_size").get()?.page_size), autoVacuum: Number(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum) }; }
  finally { db.close(); }
}
const corrupt = (path: string): string[] => readdirSync(dirname(path)).filter(n => /^memory-index\.db\.corrupt-\d+$/.test(n));
/** n member keys that carry no meaning to the open rule (not file_id, wal_check, wal_over_stop or verified_through, whose values the rule parses). */
const known = (n: number): string[] => [...META_KEYS].filter(k => !["file_id", "wal_check", "wal_over_stop", "verified_through"].includes(k)).slice(0, n);
function openSync(path: string): OpenedIndexWal { const o = openIndexWal(path, { charge: grant }); opened.push(o); return o; }
async function open(path: string): Promise<OpenedIndexWal> {
  const o = openSync(path);
  if (o.verdict.state !== "stopped") o.verdict = await o.wal.openCheck();
  return o;
}
const frames = (path: string) => walIndexReader(path)()?.mxFrame ?? -1;
/** The open rule took the damaged-file branch: the old set is aside, the file in use is new, 4,096 / NONE, and it is flagged rebuilt (the reset R path). */
function expectRebuilt(path: string, o: OpenedIndexWal): void {
  expect(o.rebuilt).toBe(true);
  expect(corrupt(path).length).toBe(1);
  expect(Number(o.writable.prepare("PRAGMA page_size").get()?.page_size)).toBe(4096);
  expect(Number(o.writable.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum)).toBe(0);
}

it("E4-control: 4,096 / NONE / 40 known keys opens as is, 0 quarantines", () => {
  const path = fresh();
  rawFile(path, "PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE", known(40));
  expect(geometryOf(path)).toEqual({ pageSize: 4096, autoVacuum: 0 });
  const o = openSync(path);
  expect(o.rebuilt).toBe(false);
  expect(corrupt(path).length).toBe(0);
  expect(Number(o.writable.prepare("SELECT count(*) AS n FROM index_meta").get()?.n)).toBe(40);
});

it("E4a: page_size 1,024 is quarantined and rebuilt", () => {
  const path = fresh();
  rawFile(path, "PRAGMA page_size=1024", known(5));
  expect(geometryOf(path).pageSize).toBe(1024);
  expectRebuilt(path, openSync(path));
});

it("E4b: auto_vacuum INCREMENTAL is quarantined and rebuilt", () => {
  const path = fresh();
  rawFile(path, "PRAGMA auto_vacuum=INCREMENTAL", known(5));
  expect(geometryOf(path)).toEqual({ pageSize: 4096, autoVacuum: 2 });
  expectRebuilt(path, openSync(path));
});

it("E4c: 65 index_meta rows (every key a member of META_KEYS) is quarantined and rebuilt", () => {
  // META_KEYS has at most 64 members, so 65 member keys exist only while the test widens the set: the row-count clause is then the only one that can refuse the file.
  const set = META_KEYS as Set<string>, base = known(META_KEYS.size), extra = Array.from({ length: 65 - base.length }, (_, i) => `test_extra_${i}`);
  for (const k of extra) set.add(k);
  try {
    const path = fresh();
    rawFile(path, "PRAGMA page_size=4096", [...base, ...extra]);
    const probe = new DatabaseSync(path, { readOnly: true });
    try { expect(Number(probe.prepare("SELECT count(*) AS n FROM index_meta").get()?.n)).toBe(65); } finally { probe.close(); }
    expectRebuilt(path, openSync(path));
  } finally { for (const k of extra) set.delete(k); }
  expect(META_KEYS.size).toBeLessThanOrEqual(META_KEY_LIMIT);
});

it("E4d: a key outside META_KEYS is quarantined and rebuilt", () => {
  const path = fresh();
  rawFile(path, "PRAGMA page_size=4096", [...known(39), "bogus_key"]);
  expectRebuilt(path, openSync(path));
});

it("E5-control: a plain rebuild (one quarantine) opens the fresh file and carries on", () => {
  const path = fresh();
  rawFile(path, "PRAGMA page_size=1024", [...known(3), "bogus_key"]);   // two independent faults: no single clause mutant changes this fixture
  const o = openSync(path);
  expectRebuilt(path, o);
});

it("E5: a fresh file reads 4,096 / 0; a rebuilt file that still fails geometry exits 1 with exactly 1 quarantine", () => {
  const clean = fresh();
  const o = openSync(clean);
  expect(o.rebuilt).toBe(false);
  expect(geometryOf(clean)).toEqual({ pageSize: 4096, autoVacuum: 0 });

  const path = fresh();
  rawFile(path, "PRAGMA page_size=1024", [...known(3), "bogus_key"]);   // two independent faults: no single clause mutant changes this fixture
  let calls = 0;
  walTestHooks.geometry = (_db, rebuilt) => {
    if (++calls > 4) throw new Error("runaway: the loop guard is missing");
    if (rebuilt) throw new IndexDamagedError("geometry:forced");
  };
  let thrown: unknown;
  try { openIndexWal(path, { charge: grant }); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Exited);
  expect((thrown as Exited).code).toBe(1);
  expect(corrupt(path).length).toBe(1);
  expect(calls).toBe(2);
});

it("E6: put of an unknown key or a 901 B value throws, rolls back, rises 0; META_KEYS holds at most 64 keys, every shipped key and value fits", async () => {
  const path = fresh();
  const o = await open(path);
  const wal = o.wal as IndexWalWriter;
  // control: a known key, and a value of exactly 900 B
  wal.write("fill", MEMW_W_STEP_BYTES, put => { put("entries_live", "1"); put("text_bytes_seed", "x".repeat(META_VALUE_MAX_BYTES)); });
  await wal.check();
  const base = frames(path);
  expect(base).toBeGreaterThan(0);
  // unknown key
  expect(() => wal.write("fill", MEMW_W_STEP_BYTES, put => put("bogus_key", "1"))).toThrow(/MEMW_META_KEY/);
  await wal.check();
  expect(frames(path)).toBe(base);
  expect(o.writable.prepare("SELECT 1 FROM index_meta WHERE key='bogus_key'").get()).toBeUndefined();
  // 901 B value
  expect(() => wal.write("fill", MEMW_W_STEP_BYTES, put => put("entries_live", "x".repeat(META_VALUE_MAX_BYTES + 1)))).toThrow(/MEMW_META_VALUE/);
  await wal.check();
  expect(frames(path)).toBe(base);
  expect(o.writable.prepare("SELECT value FROM index_meta WHERE key='entries_live'").get()?.value).toBe("1");

  // the set: at most 64 keys, every kind has its overrun_k key, every key the other modules ship is a member
  expect(META_KEYS.size).toBeLessThanOrEqual(META_KEY_LIMIT);
  for (const kind of ALL_WAL_KINDS) expect(META_KEYS.has(`overrun_k:${kind}`)).toBe(true);
  for (const key of [...AGE_META_KEYS, ...MEMW_META_KEYS]) expect(META_KEYS.has(key), key).toBe(true);
  expect(META_ENVELOPE_FRAMES).toBe(324);
  // an independent inventory of every key index.ts, postings.ts, age-index.ts and the 1.0.17 builds write (not derived from META_KEYS)
  const inventory = ["file_id", "wal_check", "verified_through", "wal_over_stop", "reset_done", "merge_owed", "delete_scrub_owed", "delete_scrub_target",
    "delete_scrub_merge", "delete_scrub_merges", "delete_scrub_completed", "delete_generation", "lexical_keys_cursor", "lexical_keys_complete", "entries_live",
    "entries_live_recount", "postings_below", "postings_triggers", "text_bytes_cursor", "text_bytes_seed", "age_fill_below", "lexical_rowids", "lexical_generation",
    ...["lexical", "lexical_age", "lexical_retired"].flatMap(t => [`text_bytes:${t}`, `debt_bytes:${t}`])];
  for (const key of inventory) expect(META_KEYS.has(key), key).toBe(true);
  // the size limit counts bytes: 500 two-byte characters are 1,000 B
  expect(() => wal.write("fill", MEMW_W_STEP_BYTES, put => put("entries_live", "\u00e9".repeat(500)))).toThrow(/MEMW_META_VALUE/);
  await wal.check();

  // no shipped value exceeds 900 B: the largest each writer can produce, with every field at its widest
  const source = readFileSync(new URL("./index-wal.ts", import.meta.url), "utf8");
  const reasons = [...source.matchAll(/"([a-z]+(?:_[a-z]+)+)"/g)].map(m => m[1]!);   // a superset of the stop reasons
  const reason = reasons.reduce((a, b) => (b.length > a.length ? b : a), "");
  const widest = {
    wal_check: JSON.stringify({ seq: Number.MAX_SAFE_INTEGER, Lb: Number.MAX_SAFE_INTEGER, idb: "f".repeat(64), reserve: Number.MAX_SAFE_INTEGER, kind: "stage_drop" }),
    wal_over_stop: JSON.stringify({ reason, time: Date.now(), kind: "stage_drop", seq: Number.MAX_SAFE_INTEGER, fileId: "18446744073709551615" }),
    delete_scrub_merge: JSON.stringify({ generation: Number.MAX_SAFE_INTEGER, table: "lexical_retired", started: false }),
    file_id: "18446744073709551615",
  };
  for (const [key, value] of Object.entries(widest)) expect(Buffer.byteLength(value, "utf8"), key).toBeLessThanOrEqual(META_VALUE_MAX_BYTES);
  // and what a real stop writes goes through the helper and stays under it
  try { wal.stop(reason, "stage_drop", 1); } catch (error) { if (!(error instanceof WalStop)) throw error; }
  const biggest = Number(o.writable.prepare("SELECT max(length(CAST(value AS BLOB))) AS n FROM index_meta WHERE key != 'text_bytes_seed'").get()?.n);
  expect(biggest).toBeLessThanOrEqual(META_VALUE_MAX_BYTES);
  expect(o.writable.prepare("SELECT 1 FROM index_meta WHERE key='wal_over_stop'").get()).toBeDefined();
  console.log(`E6: sqlite_version=${String(o.writable.prepare("SELECT sqlite_version() AS v").get()?.v)} widest wal_check=${widest.wal_check.length} B wal_over_stop=${widest.wal_over_stop.length} B delete_scrub_merge=${widest.delete_scrub_merge.length} B keys=${META_KEYS.size}`);
});
