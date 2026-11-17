// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2a, index side of 1.8 on the real WAL core: the gate hold R1/R2/R4, the tier (O2/O3, only at L = 32 B, sealed after),
// the floor (O4, merge-floor at once, logged once), SLOW_MERGE, T_t counters (text_bytes/debt_bytes, stepped seed), and the 512 bound.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, MEMW_SEGMENT_GATE, MEMW_OPEN_RESERVE, type IndexedMemory } from "./index.ts";
import { walTestHooks } from "./index-wal.ts";
import { indexBatchSchema } from "./worker-protocol.ts";

const MiB = 1024 * 1024;
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-wp2a-g-")); dirs.push(d); return d; };
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; walTestHooks.chargeAckMs = 500; });
afterEach(() => { vi.restoreAllMocks(); for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const meta = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { const r = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return r ? String(r.value) : undefined; } finally { db.close(); } };
const rec = (i: number, extra: Partial<IndexedMemory> = {}): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 5}`, text: `words of record ${i} alpha`, deleted: false, ...extra });
const charge = () => Promise.resolve(true);
/** A 1.0.17-shaped file whose lexical table holds `segments` level-0 segments (one txn each, automerge off), keys whole-built. */
function segmented(path: string, segments: number, rowsPer = 1) {
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
    CREATE TABLE vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
    CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));
    INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999);`);
  let n = 1000;
  for (let s = 0; s < segments; s++) {
    db.exec("BEGIN");
    for (let r = 0; r < rowsPer; r++, n++) {
      const text = `seg${s} word${n % 13} common`;
      db.prepare("INSERT INTO entries VALUES(?,1,'scope:0',?)").run(`memory:${n}`, text);
      db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)").run(n, `memory:${n}`, text);
      db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)").run(`memory:${n}`, n);
    }
    db.exec("COMMIT");
  }
  expect(Number(db.prepare("SELECT count(*) AS n FROM lexical_data WHERE id>10").get()!.n)).toBeGreaterThan(0);
  db.close();
}
type Inside = { predictor: { pred(t: string, x: number): number; k(t: string): number }; now: () => number; writer: { L(): number }; mergeStep(t: string, k?: string, r?: number): boolean };
const inside = (index: MemoryIndex) => index as unknown as Inside;
/** Counts merge/tier steps the index runs. */
function countMerges(index: MemoryIndex, maximum = Infinity) {
  const i = inside(index), real = i.mergeStep.bind(index), seen: string[] = [];
  i.mergeStep = (t: string, k = "merge", r?: number) => {
    seen.push(k);
    // Assert the finite work bound at the write boundary. A mutant removing
    // the hold deadline must fail this named assertion, not spin until killed.
    if(Number.isFinite(maximum))expect(seen.length, "gate hold issued too many merge steps").toBeLessThanOrEqual(maximum);
    return real(t, k, r);
  };
  return seen;
}

describe("gate hold (1.8 R1, R2, R4) on the real core", () => {
  it("R1: a batch held at the gate runs positive maintenance merges (pred <= 12 MiB) until every table is <= 48, then commits", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    expect(index.segmentCount("lexical")).toBeGreaterThan(MEMW_SEGMENT_GATE);
    const merges = countMerges(index);
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "done" });
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.every(k => k === "merge")).toBe(true);
    expect(index.segmentCount("lexical")).toBeLessThanOrEqual(MEMW_SEGMENT_GATE + 1);
    index.close();
  });
  it("R2: the hold ends once elapsed + 750 ms passes 5 s: the batch is answered segment-gate (mutant: no release)", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    let t = 0; inside(index).now = () => (t += 2000);
    index.segmentCount = () => 60; // merges that never clear the gate: only the 5 s line ends the hold
    const merges = countMerges(index, 2);
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "failed", reason: "segment-gate", committed: 0 });
    expect(merges.length).toBeLessThanOrEqual(2);
    index.close();
  });
  it("R2: a clear that needs the tier answers segment-gate at once, without merging inside the hold (mutant: tier inside hold)", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    inside(index).predictor.pred = () => 20 * MiB;
    const merges = countMerges(index), started = performance.now();
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "failed", reason: "segment-gate", committed: 0 });
    expect(merges).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
    index.close();
  });
  it("T2(10) R4/O4 floor: pred over C - 32 - F_del answers merge-floor at once, MERGE_FLOOR once per table per start, debt kept (mutant: hold)", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    inside(index).predictor.k = () => 1e9;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = index.segmentCount("lexical"), started = performance.now();
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "failed", reason: "merge-floor", committed: 0 });
    expect(await index.applyBatch([rec(2)])).toEqual({ status: "failed", reason: "merge-floor", committed: 0 });
    expect(performance.now() - started).toBeLessThan(250);
    expect(await index.maintenanceStep()).toEqual({ ran: null, gateClear: false });
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("MEMORY_INDEX_MERGE_FLOOR"))).toHaveLength(1);
    expect(index.segmentCount("lexical")).toBe(before);
    index.close();
  });
});

describe("tier (1.8 O2/O3, T2(11)) on the real core", () => {
  it("pred 20 MB: asks a drain while L > 32 B (mutant: tier at L <= 16 MB), runs at L = 32 B, seals after (mutant: no post-step TRUNCATE), clears the gate", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    inside(index).predictor.pred = () => 20 * MiB;
    // any checked write: L > 32 B (an open-kind write, as an R start's open txn)
    const writer = inside(index).writer as unknown as { admit(k: string, b: number): boolean; write(k: string, b: number, f: (m: (k: string, v: string) => void) => void): unknown };
    expect(writer.admit("open", MEMW_OPEN_RESERVE)).toBe(true);
    writer.write("open", MEMW_OPEN_RESERVE, meta => meta("reset_done", "3"));
    await index.maintenanceStep(); // settles that write's check
    expect(inside(index).writer.L()).toBeGreaterThan(32);
    expect(await index.maintenanceStep()).toEqual({ ran: null, drain: true, gateClear: false });
    expect((await index.sealAndTruncate()).truncated).toBe(true); // the worker's drain: sealAndTruncate until truncated
    const merges = countMerges(index);
    const step = await index.maintenanceStep();
    expect(step.ran).toBe("tier");
    expect(merges).toEqual(["tier"]);
    expect(inside(index).writer.L()).toBe(32); // sealed and truncated before anything else writes
    for (let n = 0; n < 200 && !(await index.maintenanceStep()).gateClear; n++) { /* tier steps until the gate clears */ }
    expect(merges.every(k => k === "tier")).toBe(true);
    expect(index.segmentCount("lexical")).toBeLessThanOrEqual(MEMW_SEGMENT_GATE);
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "done" });
    index.close();
  });
  it("a tier step over 250 ms logs MEMORY_INDEX_SLOW_MERGE (rate-limited) and the next tier step waits one tick", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    inside(index).predictor.pred = () => 20 * MiB;
    let t = 0; inside(index).now = () => (t += 300);
    index.segmentCount = () => 60; // the gate stays closed: every step is a tier step
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await index.maintenanceStep()).ran).toBe("tier");
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("MEMORY_INDEX_SLOW_MERGE"))).toHaveLength(1);
    expect(await index.maintenanceStep()).toEqual({ ran: null, gateClear: false }); // waits one tick
    expect((await index.maintenanceStep()).ran).toBe("tier");
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("MEMORY_INDEX_SLOW_MERGE"))).toHaveLength(1); // rate-limited
    index.close();
  });
});

describe("T_t counters (1.8: text_bytes:<t> + debt_bytes:<t>, never a scan)", () => {
  it("seeded by stepped open txns from a 20k file; moved by groups, forgets and purges in the same txn; a finished merge clears the debt", async () => {
    const path = join(dir(), "i.db"); segmented(path, 1, 20_000);
    const db = new DatabaseSync(path, { readOnly: true });
    const seeded = Number(db.prepare("SELECT sum(length(CAST(text AS BLOB))) AS n FROM entries").get()!.n); db.close();
    const index = await MemoryIndex.create(path, { charge });
    expect(Number(meta(path, "text_bytes:lexical"))).toBe(seeded);
    expect(meta(path, "debt_bytes:lexical")).toBe("0");
    expect(meta(path, "text_bytes_cursor")).toBeUndefined();
    const a = rec(1, { text: "héllo wörld" }), bytes = Buffer.byteLength(a.text, "utf8");
    await index.applyBatch([a]);
    expect(Number(meta(path, "text_bytes:lexical"))).toBe(seeded + bytes);
    await index.applyBatch([rec(1, { deleted: true })]);
    expect(Number(meta(path, "text_bytes:lexical"))).toBe(seeded);
    expect(Number(meta(path, "debt_bytes:lexical"))).toBe(bytes);
    await index.purgeRecords(["memory:1000"]);
    const gone = Buffer.byteLength("seg0 word12 common", "utf8");
    expect(Number(meta(path, "debt_bytes:lexical"))).toBe(bytes + gone);
    expect(index.mergeText("lexical")).toBe(seeded - gone + bytes + gone);
    index.close();
  });
  it("no counters at all routes to the floor (fail closed)", async () => {
    const path = join(dir(), "i.db"); segmented(path, 60);
    const index = await MemoryIndex.create(path, { charge });
    (index as unknown as { meta(k: string): string | undefined }).meta = () => undefined;
    expect(index.mergePlan("lexical").route).toBe("floor");
    index.close();
  });
});

describe("1.11 BOUNDED INPUT: indexBatchSchema id and scopeId .max(512)", () => {
  it("512 passes, 513 is refused (T2(3) index side)", () => {
    const row = (id: string, scopeId: string) => [{ id, version: 1, scopeId, text: "t", deleted: false }];
    expect(indexBatchSchema.safeParse(row("x".repeat(512), "s".repeat(512))).success).toBe(true);
    expect(indexBatchSchema.safeParse(row("x".repeat(513), "s")).success).toBe(false);
    expect(indexBatchSchema.safeParse(row("x", "s".repeat(513))).success).toBe(false);
  });
});
