import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { openTestIndex, closeSealed, put } from "./testing/open-index.ts";
import { FTS_SEGMENT_LIMIT } from "./segment-limit.ts";
import { MEMW_SEGMENT_GATE, MEMW_W_MERGE_BYTES, MEMW_W_STEP_BYTES } from "./memw-steps.ts";

const dirs: string[] = [];
const opened: MemoryIndex[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  try { for (const index of opened.splice(0)) { try { await closeSealed(index); } catch (error) { index.close(); throw error; } } }
  finally { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }
});
const pathFor = () => { const dir = mkdtempSync(join(tmpdir(), "wp2a-replacement-")); dirs.push(dir); return join(dir, "index.db"); };
const open = async (path: string) => { const index = await openTestIndex(path); opened.push(index); return index; };
const row = (id: string): IndexedMemory => ({ id, version: 1, scopeId: "s", text: "harbour lantern", deleted: false });
const dbOf = (index: MemoryIndex) => (index as unknown as { db: DatabaseSync }).db;
const walSize = (path: string) => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };

/** Legacy fixtures are built before the checked writer opens, in private temporary files.
 * Each singleton transaction contributes one segment; crisis merging is disabled only during fixture construction. */
function legacy(path: string, entries: number, singletonSegments: number, postingsOnly = false) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));
      CREATE TABLE vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
      CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
      INSERT INTO lexical(lexical,rank) VALUES('automerge',0);
      INSERT INTO lexical(lexical,rank) VALUES('crisismerge',10000);`);
    const e = db.prepare("INSERT INTO entries VALUES(?,1,'s','harbour lantern')");
    const l = db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,'harbour lantern')");
    const k = db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)");
    const insert = (i: number) => { const id = `m${i}`; e.run(id); if (!postingsOnly) { l.run(i, id); k.run(id, i); } };
    const bulk = entries - singletonSegments;
    if (bulk) { db.exec("BEGIN"); for (let i = 1; i <= bulk; i++) insert(i); db.exec("COMMIT"); }
    for (let i = bulk + 1; i <= entries; i++) insert(i);
  } finally { db.close(); }
}
async function clearGate(index: MemoryIndex) {
  let clear = false;
  for (let n = 0; n < 4096 && !clear; n++) {
    const step = await index.maintenanceStep();
    if (step.drain) expect((await index.sealAndTruncate()).truncated).toBe(true);
    clear = step.gateClear === true;
  }
  expect(clear).toBe(true);
  expect(index.segmentCount()).toBeLessThanOrEqual(MEMW_SEGMENT_GATE);
}
/** Expire the batch's merge hold without a wall-clock wait; maintenance has its own explicit steps. */
function expireHold(index: MemoryIndex) {
  let clock = 0;
  (index as unknown as { now: () => number }).now = () => (clock += 5000);
}

// Fixture note: FTS5 crisis-merges at 1,999 segments whatever crisismerge is set to (measured), so a 2,000-segment file cannot be built
// by inserts, and a file at >= 1,900 is stopped by index.ts segmentLimitTable (r3.2.6 stop in place; memw-reset (a) covers that stop).
// This test uses a buildable file just over the gate (48) and under the stop line.
const GATE_FIXTURE_SEGMENTS = 200;
it("a 200-segment fixture (over the gate, under the stop line) refuses a batch then maintenance clears the gate and search finds the retry", async () => {
  const path = pathFor(); legacy(path, GATE_FIXTURE_SEGMENTS, GATE_FIXTURE_SEGMENTS);
  const index = await open(path);
  expect(index.segmentCount()).toBe(GATE_FIXTURE_SEGMENTS); expect(index.segmentCount()).toBeGreaterThan(MEMW_SEGMENT_GATE); expect(index.segmentCount()).toBeLessThan(FTS_SEGMENT_LIMIT - 100);
  expireHold(index);
  await expect(index.applyBatch([row("retry")])).resolves.toEqual({ status: "failed", reason: "segment-gate", committed: 0 });
  expect(index.search("harbour", [{ id: "retry", version: 1 }], null, "fixture").hits).toEqual([]);
  await clearGate(index);
  await expect(index.applyBatch([row("retry")])).resolves.toEqual({ status: "done" });
  expect(index.search("harbour", [{ id: "retry", version: 1 }], null, "fixture").hits.map(hit => hit.id)).toEqual(["retry"]);
}, 240_000);

it("maintenance leaves a small index alone", async () => {
  const index = await open(pathFor()); await put(index, [row("small")]);
  const segments = index.segmentCount();
  expect(await index.maintenanceStep()).toMatchObject({ ran: null });
  expect(index.segmentCount()).toBe(segments);
});
it("maintenance merges 1100 singleton batches below the segment gate", async () => {
  const path = pathFor(); legacy(path, 1100, 1100);
  const index = await open(path); expect(index.segmentCount()).toBe(1100);
  expect(await index.maintenanceStep()).toMatchObject({ ran: "merge" });
  await clearGate(index);
  expect(index.segmentCount()).toBeLessThan(MEMW_SEGMENT_GATE);
}, 240_000);
it("authority excludes a refused deletion before during and after gate recovery", async () => {
  const path = pathFor(); legacy(path, 1100, 1100);
  const index = await open(path); expireHold(index);
  const allowed = [{ id: "m2", version: 1 }]; // authority has already deleted m1
  const hits = () => index.search("harbour", allowed, null, "fixture").hits.map(hit => hit.id);
  expect(index.search("harbour", [{ id: "m1", version: 1 }], null, "fixture").hits.map(hit => hit.id)).toEqual(["m1"]);
  expect(hits()).toEqual(["m2"]);
  await expect(index.applyBatch([{ ...row("m1"), deleted: true }])).resolves.toEqual({ status: "failed", reason: "segment-gate", committed: 0 });
  expect(hits()).toEqual(["m2"]);
  let clear = false;
  for (let n = 0; n < 4096 && !clear; n++) {
    const step = await index.maintenanceStep();
    if (step.drain) await index.sealAndTruncate();
    expect(hits()).toEqual(["m2"]); clear = step.gateClear === true;
  }
  expect(clear).toBe(true);
  await expect(index.applyBatch([{ ...row("m1"), deleted: true }])).resolves.toEqual({ status: "done" });
  expect(hits()).toEqual(["m2"]);
  expect(index.search("harbour", [{ id: "m1", version: 1 }], null, "fixture").hits).toEqual([]);
}, 240_000);
it("maintenance merge writes stay within the page reserve and fixed WAL cap at 20k and 200k", async () => {
  const growth: number[] = [];
  for (const n of [20_000, 200_000]) {
    const path = pathFor(); legacy(path, n, 64);
    const index = await open(path);
    expect(index.segmentCount()).toBeGreaterThan(MEMW_SEGMENT_GATE);
    expect((await index.sealAndTruncate()).truncated).toBe(true);
    const before = walSize(path), plan = index.mergePlan("lexical");
    expect(await index.maintenanceStep()).toMatchObject({ ran: "merge" });
    const rise = walSize(path) - before;
    expect(rise).toBeGreaterThan(0); expect(rise).toBeLessThanOrEqual(MEMW_W_MERGE_BYTES);
    expect(rise, "common-term merge exceeded its page reserve").toBeLessThanOrEqual(plan.pred);
    growth.push(rise);
  }
  expect(growth).toHaveLength(2); // OVERSIZE G1: actual bytes may differ; both histories obey the same fixed cap.
}, 240_000);

for (const size of [500_000, 1_000_000]) {
  it(`T9 ${size} postings fill steps stay bounded and sealing leaves only the WAL header`, async () => {
    const path = pathFor(); legacy(path, size, 0, true);
    const index = await open(path), db = dbOf(index);
    expect(index.postingsOwed()).toBe(true);
    let steps = 0, filled = 0;
    while (index.postingsOwed() && steps < size * 2) {
      expect((await index.sealAndTruncate()).truncated).toBe(true);
      const before = walSize(path);
      const step = await index.fillPostings({ maxRows: 256, maxMs: Number.POSITIVE_INFINITY });
      expect(step.busy).toBeUndefined();
      expect(step.filled).toBeGreaterThanOrEqual(0); expect(step.filled).toBeLessThanOrEqual(256);
      expect(walSize(path) - before).toBeLessThanOrEqual(MEMW_W_STEP_BYTES);
      filled += step.filled; steps++;
    }
    expect(index.postingsOwed()).toBe(false); expect(steps).toBeGreaterThan(1); expect(filled).toBe(size * 2);
    expect(db.prepare("SELECT count(*) AS n FROM posting_todo").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM postings").get()!.n).toBe(size * 2);
    expect((await index.sealAndTruncate()).truncated).toBe(true);
    // TRUNCATE may physically remove the header too; the logical WAL is header-only in either case.
    expect(walSize(path)).toBeLessThanOrEqual(32);
  }, 3_600_000);
}
